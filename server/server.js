/**
 * 五子棋服务器（Node 版，本机/Render 部署用）：
 *  - 静态托管 public/ 前端页面
 *  - WebSocket 房间对战：内存存储 + 快照同步协议
 *
 * 协议（JSON，t 为消息类型；客户端每条消息都带 cid 标识自己）：
 *  客户端 → 服务器: {t:'create'} {t:'join',room} {t:'move',x,y}
 *                  {t:'restart'} {t:'restartDecline'} {t:'leave'} {t:'ping'}
 *  服务器 → 客户端: {t:'state', ...房间快照，见 room-ops.js snapshot()} {t:'error',msg}
 *
 * 房间规则逻辑全部在 room-ops.js 中，与 Deno 版服务器共用。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const ops = require('./room-ops');

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

// ---------- 房间管理（内存） ----------
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { room, clients: Set<{ws, cid}> }

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

/** 向房间内所有客户端推送个性化快照 */
function broadcastState(entry) {
  for (const c of entry.clients) send(c.ws, ops.snapshot(entry.room, c.cid));
}

function getEntryByWs(ws) {
  return ws._code ? rooms.get(ws._code) : null;
}

/** 把连接登记进房间并推送当前状态 */
function attach(ws, code, cid) {
  let entry = rooms.get(code);
  entry.clients.add({ ws, cid });
  ws._code = code;
  ws._cid = cid;
  send(ws, ops.snapshot(entry.room, cid));
}

function detach(ws) {
  const entry = getEntryByWs(ws);
  if (!entry) return;
  for (const c of entry.clients) {
    if (c.ws === ws) entry.clients.delete(c);
  }
  const out = ops.applyLeave(entry.room, ws._cid);
  ws._code = null;
  ws._cid = null;
  if (out.delete) rooms.delete(entry.room.code);
  else broadcastState(entry); // 通知留下的人：对手走了
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const cid = String(msg.cid || '');
  if (!cid && msg.t !== 'ping') return;

  switch (msg.t) {
    case 'ping':
      break;

    case 'create': {
      detach(ws); // 先退出旧房间
      const code = genCode();
      rooms.set(code, { room: ops.createRoomObj(code, cid), clients: new Set() });
      attach(ws, code, cid);
      break;
    }

    case 'join': {
      const code = String(msg.room || '').toUpperCase().trim();
      const entry = rooms.get(code);
      if (!entry) { send(ws, { t: 'error', msg: '房间不存在，请检查房间号' }); return; }
      const out = ops.applyJoin(entry.room, cid);
      if (out.err) { send(ws, { t: 'error', msg: out.err }); return; }
      detach(ws);
      attach(ws, code, cid);
      if (!out.resumed) broadcastState(entry); // 新对手加入，通知双方
      break;
    }

    case 'move': {
      const entry = getEntryByWs(ws);
      if (!entry) return;
      const out = ops.applyMove(entry.room, cid, msg.x, msg.y);
      if (out.err) { send(ws, { t: 'error', msg: out.err }); return; }
      broadcastState(entry);
      break;
    }

    case 'restart':
    case 'restartDecline': {
      const entry = getEntryByWs(ws);
      if (!entry) return;
      const fn = msg.t === 'restart' ? ops.applyRestart : ops.applyDecline;
      const out = fn(entry.room, cid);
      if (out.err) { send(ws, { t: 'error', msg: out.err }); return; }
      broadcastState(entry);
      break;
    }

    case 'leave':
      detach(ws);
      break;
  }
}

wss.on('connection', (ws) => {
  ws._code = null;
  ws._cid = null;
  ws.on('message', (raw) => {
    try { handleMessage(ws, raw); }
    catch (err) { console.error('处理消息出错:', err); }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => detach(ws));
});

server.listen(PORT, () => {
  console.log(`五子棋服务器已启动: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`局域网访问地址: http://${net.address}:${PORT}`);
      }
    }
  }
});
