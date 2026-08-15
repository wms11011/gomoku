/**
 * 联机对战的房间领域逻辑（纯函数/原地修改，不做任何 IO）。
 * 同时被 Node 服务器（内存存储）与 Deno 服务器（KV 存储）引用，
 * 保证两种后端行为完全一致。
 *
 * 房间对象结构：
 * {
 *   code, createdAt,
 *   black: cid|null, white: cid|null,   // 座位（按客户端 cid 入座）
 *   moves: [[x,y],...],                 // 走子序列，黑先交替
 *   winner: 0|1|2, winLine: null|[[x,y]...], draw: bool,
 *   restartFrom: null|cid,              // 已发起重开请求的人
 *   flash: null|{to, msg, seq},         // 一次性通知（如“对方拒绝了重开”）
 * }
 */
'use strict';

const Core = require('../public/js/game.js');
const { SIZE, EMPTY, BLACK, WHITE } = Core;

/** 掉线宽限期：座位为掉线玩家保留这么久，超时才会被清扫让出 */
const OFFLINE_GRACE = 60 * 1000;

function createRoomObj(code, cid) {
  return {
    code, createdAt: Date.now(),
    black: cid, white: null,           // 座位（按客户端 cid 入座）
    blackOnline: true, whiteOnline: false,
    blackOfflineAt: 0, whiteOfflineAt: 0,
    moves: [],
    winner: 0, winLine: null, draw: false,
    restartFrom: null, flash: null,
  };
}

function buildBoard(moves) {
  const board = Core.createBoard();
  moves.forEach(([x, y], i) => { board[y][x] = i % 2 === 0 ? BLACK : WHITE; });
  return board;
}

/** 返回 cid 的座位颜色：1 黑 / 2 白 / 0 不在房间 */
function seatOf(room, cid) {
  if (room.black === cid) return BLACK;
  if (room.white === cid) return WHITE;
  return 0;
}

/** 加入（或重连恢复）房间：按 cid 回座；空位则可坐任意一侧 */
function applyJoin(room, cid) {
  if (room.black === cid) { room.blackOnline = true; room.blackOfflineAt = 0; return { resumed: true }; }
  if (room.white === cid) { room.whiteOnline = true; room.whiteOfflineAt = 0; return { resumed: true }; }
  if (!room.black) { room.black = cid; room.blackOnline = true; return {}; }
  if (!room.white) { room.white = cid; room.whiteOnline = true; return {}; }
  return { err: '房间已满' };
}

/** 掉线（连接断开）：不撤座位，只标记离线并保留宽限期，等待重连恢复 */
function applyDisconnect(room, cid) {
  const now = Date.now();
  if (room.black === cid) { room.blackOnline = false; room.blackOfflineAt = now; }
  if (room.white === cid) { room.whiteOnline = false; room.whiteOfflineAt = now; }
  return {};
}

/** 主动离开（切模式/关闭页面时客户端明示）：立即让出座位 */
function applyLeave(room, cid) {
  if (room.black === cid) { room.black = null; room.blackOnline = false; room.blackOfflineAt = 0; }
  if (room.white === cid) { room.white = null; room.whiteOnline = false; room.whiteOfflineAt = 0; }
  if (room.restartFrom === cid) room.restartFrom = null;
  if (!room.black && !room.white) return { delete: true };
  return {};
}

/** 清扫离线超时的座位（每次房间操作时惰性执行）。返回是否有座位被清掉 */
function sweepOffline(room, now = Date.now()) {
  let changed = false;
  if (room.black && !room.blackOnline && now - room.blackOfflineAt > OFFLINE_GRACE) {
    room.black = null; room.blackOfflineAt = 0; changed = true;
  }
  if (room.white && !room.whiteOnline && now - room.whiteOfflineAt > OFFLINE_GRACE) {
    room.white = null; room.whiteOfflineAt = 0; changed = true;
  }
  return changed;
}

function applyMove(room, cid, x, y) {
  const seat = seatOf(room, cid);
  if (!seat) return { err: '你不在这个房间' };
  if (!room.black || !room.white) return { err: '等待对手加入' };
  if (room.winner || room.draw) return { err: '对局已结束' };
  const turnColor = room.moves.length % 2 === 0 ? BLACK : WHITE;
  if (seat !== turnColor) return { err: '还没轮到你落子' };
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Core.inBoard(x, y)) return { err: '非法落子' };
  const board = buildBoard(room.moves);
  if (board[y][x] !== EMPTY) return { err: '这里已有棋子' };
  room.moves.push([x, y]);
  board[y][x] = seat;
  const line = Core.checkWin(board, x, y);
  if (line) { room.winner = seat; room.winLine = line; }
  else if (room.moves.length === SIZE * SIZE) room.draw = true;
  // 新走子使之前的重开请求/通知失效
  room.restartFrom = null;
  room.flash = null;
  return {};
}

/** 重开协商：第一次发起 → 记录；对方再发 → 视为同意并重置 */
function applyRestart(room, cid) {
  if (!seatOf(room, cid)) return { err: '你不在这个房间' };
  if (room.restartFrom === cid) return {}; // 等待对方中，忽略重复请求
  if (room.restartFrom) {
    room.moves = [];
    room.winner = 0;
    room.winLine = null;
    room.draw = false;
    room.restartFrom = null;
    room.flash = null;
  } else {
    room.restartFrom = cid;
    room.flash = null;
  }
  return {};
}

function applyDecline(room, cid) {
  if (!seatOf(room, cid)) return { err: '你不在这个房间' };
  if (room.restartFrom && room.restartFrom !== cid) {
    room.flash = { to: room.restartFrom, msg: '对方拒绝了重开请求', seq: Date.now() };
    room.restartFrom = null;
  }
  return {};
}

/** 针对某个客户端的个性化状态快照 */
function snapshot(room, cid) {
  return {
    t: 'state',
    code: room.code,
    you: seatOf(room, cid) || null,
    players: { black: !!room.black, white: !!room.white },
    online: {
      black: !!room.black && room.blackOnline,
      white: !!room.white && room.whiteOnline,
    },
    moves: room.moves,
    winner: room.winner,
    winLine: room.winLine,
    draw: room.draw,
    restartFromYou: !!room.restartFrom && room.restartFrom === cid,
    restartOffer: !!room.restartFrom && room.restartFrom !== cid,
    flash: room.flash && room.flash.to === cid ? room.flash : null,
  };
}

module.exports = {
  OFFLINE_GRACE,
  createRoomObj, applyJoin, applyDisconnect, applyLeave, sweepOffline,
  applyMove, applyRestart, applyDecline,
  snapshot, seatOf, buildBoard,
};
