/**
 * 五子棋服务器（Deno Deploy 版）：
 *  - 静态托管 public/ 前端页面
 *  - WebSocket 房间对战：Deno KV 存储房间状态（跨实例一致）+ 快照同步协议
 *
 * 协议与 Node 版完全一致（见 server/server.js 注释），房间规则在 room-ops.js 中共用。
 *
 * 多实例模型：Deno Deploy 会把请求分发到不同实例，两个玩家可能连在不同实例上。
 * 房间状态存于 Deno KV（唯一事实来源），每个实例用 kv.watch 监听自己连接所在的
 * 房间，状态变化时推送给本地连接；写操作全部走 KV 原子比较并提交，避免并发冲突。
 */
import { serveDir } from "jsr:@std/http@1/file-server";
import { fromFileUrl } from "jsr:@std/path@1";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ops = require("../server/room-ops.js");

// 以本文件位置为基准定位前端目录，与工作目录无关
const PUBLIC_DIR = fromFileUrl(new URL("../public/", import.meta.url));

const kv = await Deno.openKv(Deno.env.get("KV_PATH") || undefined);

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_TTL = 2 * 3600 * 1000; // 房间超过 2 小时允许被覆盖复用

// ---------- 本实例内的连接与监听 ----------
const localRooms = new Map(); // code -> Set<{socket, cid}>
const watchers = new Map();   // code -> true（watch 循环标记）

function roomKey(code) {
  return ["rooms", code];
}

function send(socket, obj) {
  if (socket.readyState === 1) socket.send(JSON.stringify(obj));
}

/** 向本实例内该房间的所有连接推送个性化快照 */
function pushLocal(code, room) {
  const conns = localRooms.get(code);
  if (!conns) return;
  for (const c of conns) send(c.socket, ops.snapshot(room, c.cid));
}

/** 房间有本地连接时启动 KV watch（房间变化 → 推送本地连接） */
function ensureWatcher(code) {
  if (watchers.has(code)) return;
  watchers.set(code, true);
  (async () => {
    try {
      const stream = kv.watch([roomKey(code)]);
      for await (const [entry] of stream) {
        if (!localRooms.has(code)) break; // 本地已无该房间的连接
        if (entry.value) pushLocal(code, entry.value);
      }
    } catch {
      // watch 中断（实例缩容等），由后续操作重建
    } finally {
      watchers.delete(code);
    }
  })();
}

function attach(code, cid, socket) {
  let conns = localRooms.get(code);
  if (!conns) {
    conns = new Set();
    localRooms.set(code, conns);
  }
  conns.add({ socket, cid });
  ensureWatcher(code);
}

function detachLocal(socket) {
  for (const [code, conns] of localRooms) {
    for (const c of conns) {
      if (c.socket === socket) {
        conns.delete(c);
        if (!conns.size) localRooms.delete(code);
        return { code, cid: c.cid };
      }
    }
  }
  return null;
}

// ---------- KV 原子操作 ----------
/** 读-改-写（原子比较并提交，冲突自动重试）；fn 返回 {err} 失败 / {} 成功 / {delete:true} 删除 */
async function updateRoom(code, cid, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await kv.get(roomKey(code));
    if (!res.value) return { err: "房间不存在，请检查房间号" };
    const room = structuredClone(res.value);
    const out = fn(room, cid);
    if (out.err) return out;
    const atomic = kv.atomic().check(res);
    if (out.delete) atomic.delete(roomKey(code));
    else atomic.set(roomKey(code), room);
    const commit = await atomic.commit();
    if (commit.ok) return { room, deleted: !!out.delete };
  }
  return { err: "操作冲突，请重试" };
}

async function createRoom(cid) {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const res = await kv.get(roomKey(code));
    if (res.value && Date.now() - res.value.createdAt < ROOM_TTL) continue; // 活跃房间，换个码
    const room = ops.createRoomObj(code, cid);
    const commit = await kv.atomic().check(res).set(roomKey(code), room).commit();
    if (commit.ok) return room;
  }
}

// ---------- WebSocket ----------
async function handleMessage(socket, msg) {
  const cid = String(msg.cid || "");
  if (!cid && msg.t !== "ping") return;

  switch (msg.t) {
    case "ping":
      return;

    case "create": {
      await leaveCurrentRoom(socket);
      const room = await createRoom(cid);
      attach(room.code, cid, socket);
      send(socket, ops.snapshot(room, cid));
      return;
    }

    case "join": {
      const code = String(msg.room || "").toUpperCase().trim();
      const out = await updateRoom(code, cid, (room, id) => ops.applyJoin(room, id));
      if (out.err) { send(socket, { t: "error", msg: out.err }); return; }
      await leaveCurrentRoom(socket);
      attach(code, cid, socket);
      send(socket, ops.snapshot(out.room, cid)); // watch 异步推送前，先即时反馈
      return;
    }

    case "move":
    case "restart":
    case "restartDecline": {
      const code = findCodeBySocket(socket);
      if (!code) return;
      const fn = msg.t === "move"
        ? (room, id) => ops.applyMove(room, id, msg.x, msg.y)
        : msg.t === "restart"
          ? (room, id) => ops.applyRestart(room, id)
          : (room, id) => ops.applyDecline(room, id);
      const out = await updateRoom(code, cid, fn);
      if (out.err) send(socket, { t: "error", msg: out.err });
      // 成功时由 kv.watch 广播给所有实例上的连接
      return;
    }

    case "leave":
      await leaveCurrentRoom(socket);
      return;
  }
}

function findCodeBySocket(socket) {
  for (const [code, conns] of localRooms) {
    for (const c of conns) if (c.socket === socket) return code;
  }
  return null;
}

async function leaveCurrentRoom(socket) {
  const conn = detachLocal(socket);
  if (!conn) return;
  await updateRoom(conn.code, conn.cid, (room, id) => ops.applyLeave(room, id));
}

function handleSocket(socket) {
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(socket, msg).catch((err) => console.error("处理消息出错:", err));
  };
  socket.onclose = () => { leaveCurrentRoom(socket).catch(() => {}); };
  socket.onerror = () => { leaveCurrentRoom(socket).catch(() => {}); };
}

// ---------- HTTP 入口 ----------
const port = Number(Deno.env.get("PORT")) || 3000;

Deno.serve({ port }, (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  }
  return serveDir(req, { fsRoot: PUBLIC_DIR });
});

console.log(`五子棋服务器（Deno）已启动: http://localhost:${port}`);
