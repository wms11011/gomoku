/**
 * 五子棋服务器：
 *  - 静态托管 public/ 前端页面
 *  - WebSocket 房间对战：创建/加入房间、走子校验、胜负判定、重开协商
 *
 * 协议（JSON，t 为消息类型）：
 *  客户端 → 服务器: {t:'create'} {t:'join',room} {t:'move',x,y} {t:'restart'} {t:'restartDecline'} {t:'leave'}
 *  服务器 → 客户端: {t:'created',room} {t:'start',room,color} {t:'move',x,y,color}
 *                  {t:'win',winner,line} {t:'draw'} {t:'restartOffer'} {t:'restartDeclined'}
 *                  {t:'restarted'} {t:'peerLeft'} {t:'error',msg}
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const Core = require('../public/js/game.js');

const { SIZE, EMPTY, BLACK, WHITE } = Core;

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- 静态文件服务 ----------
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- 房间管理 ----------
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { code, players:[ws], board, turn, active, restartFrom }

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 0/O/1/I/L

function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const p of room.players) send(p, obj);
}

function getRoom(ws) {
  return ws._room ? rooms.get(ws._room) : null;
}

/** 解散房间：通知对手并清理双方状态 */
function leaveRoom(ws) {
  const room = getRoom(ws);
  if (!room) return;
  const peer = room.players.find(p => p !== ws);
  ws._room = null;
  ws._color = null;
  rooms.delete(room.code);
  if (peer) {
    peer._room = null;
    peer._color = null;
    send(peer, { t: 'peerLeft' });
  }
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.t) {
    case 'create': {
      leaveRoom(ws);
      const code = genCode();
      rooms.set(code, {
        code,
        players: [ws],
        board: Core.createBoard(),
        turn: BLACK,
        active: false,
        restartFrom: null,
      });
      ws._room = code;
      ws._color = BLACK; // 创建者执黑先手
      send(ws, { t: 'created', room: code });
      break;
    }

    case 'join': {
      leaveRoom(ws);
      const code = String(msg.room || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', msg: '房间不存在，请检查房间号' }); return; }
      if (room.players.length >= 2) { send(ws, { t: 'error', msg: '房间已满' }); return; }
      room.players.push(ws);
      room.active = true;
      room.board = Core.createBoard();
      room.turn = BLACK;
      ws._room = code;
      ws._color = WHITE; // 加入者执白后手
      send(room.players[0], { t: 'start', room: code, color: BLACK });
      send(ws, { t: 'start', room: code, color: WHITE });
      break;
    }

    case 'move': {
      const room = getRoom(ws);
      if (!room || !room.active) return;
      const x = msg.x | 0, y = msg.y | 0;
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
      if (ws._color !== room.turn) return;          // 不是该玩家回合
      if (room.board[y][x] !== EMPTY) return;       // 已有棋子
      room.board[y][x] = room.turn;
      broadcast(room, { t: 'move', x, y, color: room.turn });
      const line = Core.checkWin(room.board, x, y);
      if (line) {
        room.active = false;
        broadcast(room, { t: 'win', winner: room.turn, line });
      } else if (Core.isFull(room.board)) {
        room.active = false;
        broadcast(room, { t: 'draw' });
      } else {
        room.turn = Core.opponent(room.turn);
      }
      break;
    }

    case 'restart': {
      const room = getRoom(ws);
      if (!room) return;
      if (room.restartFrom === ws) return; // 已请求过，等待对方
      if (room.restartFrom) {
        // 对方已请求，本次消息视为同意 → 重开
        room.restartFrom = null;
        room.board = Core.createBoard();
        room.turn = BLACK;
        room.active = room.players.length === 2;
        broadcast(room, { t: 'restarted' });
      } else {
        room.restartFrom = ws;
        const peer = room.players.find(p => p !== ws);
        if (peer) send(peer, { t: 'restartOffer' });
      }
      break;
    }

    case 'restartDecline': {
      const room = getRoom(ws);
      if (room && room.restartFrom) {
        send(room.restartFrom, { t: 'restartDeclined' });
        room.restartFrom = null;
      }
      break;
    }

    case 'leave':
      leaveRoom(ws);
      break;
  }
}

wss.on('connection', (ws) => {
  ws._room = null;
  ws._color = null;
  ws.on('message', (raw) => {
    try { handleMessage(ws, raw); }
    catch (err) { console.error('处理消息出错:', err); }
  });
  ws.on('close', () => leaveRoom(ws));
});

server.listen(PORT, () => {
  console.log(`五子棋服务器已启动: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`局域网访问地址: http://${net.address}:${PORT} （同一 Wi-Fi 下的设备可联机对战）`);
      }
    }
  }
});
