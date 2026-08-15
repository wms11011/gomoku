/**
 * 联机对战集成测试（快照同步协议）：
 * 启动真实服务器，用两个 WebSocket 客户端模拟完整对局流程。
 *
 * 用法：
 *   node test/net.test.js                # 测试 Node 后端（server/server.js）
 *   SERVER_KIND=deno node test/net.test.js   # 测试 Deno 后端（deno/main.js）
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const KIND = process.env.SERVER_KIND || 'node';
const PORT = KIND === 'deno' ? 3458 : 3457;
const URL = `ws://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

function makeClient(name, cid) {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex(w => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    send: (obj) => ws.send(JSON.stringify({ ...obj, cid })),
    /** 等待满足条件的消息；丢弃它之前的过期消息（快照协议下旧快照无意义） */
    waitMsg(pred, timeout = 5000, label = "") {
      const i = queue.findIndex(pred);
      if (i >= 0) {
        const [msg] = queue.splice(i, 1);
        queue.splice(0, i);
        return Promise.resolve(msg);
      }
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve: (m) => { clearTimeout(timer); resolve(m); } };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          const err = new Error(`${name}: 等待消息超时 [${label}]`);
          err.isTimeout = true;
          reject(err);
        }, timeout);
        waiters.push(waiter);
      });
    },
    waitState(pred, timeout, label = '') {
      return this.waitMsg(m => m.t === 'state' && pred(m), timeout, label);
    },
    waitError(part, timeout, label = '') {
      return this.waitMsg(m => m.t === 'error' && m.msg.includes(part), timeout, label);
    },
    /** 断言在 wait ms 内不会收到满足条件的消息 */
    async expectSilent(pred, wait = 400) {
      try {
        const m = await this.waitMsg(pred, wait);
        throw new Error(`${name}: 不应收到消息 ${JSON.stringify(m)}`);
      } catch (e) {
        if (e.isTimeout) return;
        throw e;
      }
    },
  };
}

async function main() {
  // 启动服务器子进程
  const cmd = KIND === 'deno'
    ? [path.join(ROOT, 'tools', 'deno.exe'), ['run', '--unstable-kv', '--allow-net', '--allow-read', '--allow-env', path.join(ROOT, 'deno', 'main.js')]]
    : [process.execPath, [path.join(ROOT, 'server', 'server.js')]];
  const server = spawn(cmd[0], cmd[1], {
    env: { ...process.env, PORT: String(PORT), KV_PATH: ':memory:' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (d.toString().includes('已启动')) resolve(); });
    server.on('exit', (code) => reject(new Error(`服务器提前退出 code=${code}`)));
    setTimeout(() => reject(new Error('服务器启动超时')), KIND === 'deno' ? 90000 : 10000);
  });

  try {
    // ---- 建房 ----
    const A = makeClient('A', 'cid-alice');
    await new Promise(r => A.ws.on('open', r));
    A.send({ t: 'create' });
    const created = await A.waitState(m => m.you === 1 && m.players.black && !m.players.white);
    assert.ok(/^[A-Z2-9]{4}$/.test(created.code), `房间号格式错误: ${created.code}`);
    const code = created.code;
    console.log(`  [${KIND}] 房间创建成功: ${code}`);

    // ---- 加入不存在的房间 ----
    const B = makeClient('B', 'cid-bob');
    await new Promise(r => B.ws.on('open', r));
    B.send({ t: 'join', room: 'ZZZZ' });
    await B.waitError('不存在', 5000, 'B 加入不存在房间');

    // ---- 正常加入，双方收到双方在场的快照 ----
    B.send({ t: 'join', room: code });
    await B.waitState(m => m.you === 2 && m.players.black && m.players.white, 5000, 'B 加入房间');
    await A.waitState(m => m.players.black && m.players.white, 5000, 'A 看到对手加入');

    // ---- 白棋抢先走：B 收到错误，A 收不到任何新状态 ----
    B.send({ t: 'move', x: 0, y: 0 });
    await B.waitError('还没轮到你', 5000, 'B 抢先走报错');
    await A.expectSilent(m => m.t === 'state' && m.moves.length > 0);

    // ---- 正常对局：黑棋横向五连胜 ----
    const seq = [
      [A, 7, 7], [B, 0, 0],
      [A, 8, 7], [B, 0, 1],
      [A, 9, 7], [B, 0, 2],
      [A, 10, 7], [B, 0, 3],
      [A, 11, 7],
    ];
    let wa, wb;
    for (let i = 0; i < seq.length; i++) {
      const [client, x, y] = seq[i];
      client.send({ t: 'move', x, y });
      const n = i + 1;
      [wa, wb] = await Promise.all([
        A.waitState(m => m.moves.length === n, 5000, `A 第${n}手`),
        B.waitState(m => m.moves.length === n, 5000, `B 第${n}手`),
      ]);
      assert.deepStrictEqual(wa.moves, wb.moves, '双方收到的走子序列应一致');
    }
    // 最后一手的快照即终局快照（快照协议：胜负与走子在同一状态中）
    assert.strictEqual(wa.winner, 1, '黑棋应获胜');
    assert.strictEqual(wa.winLine.length, 5, '胜利连线应为 5 子');
    // 快照含个性化字段（you/restartFromYou/restartOffer/flash），比较共享部分
    const shared = ({ you, restartFromYou, restartOffer, flash, ...rest }) => rest;
    assert.deepStrictEqual(shared(wa), shared(wb));
    console.log(`  [${KIND}] 完整对局与胜负同步正常`);

    // ---- 终局后走子被拒绝 ----
    B.send({ t: 'move', x: 5, y: 5 });
    await B.waitError('已结束', 5000, '终局后走子报错');

    // ---- 重开协商 ----
    A.send({ t: 'restart' });
    await A.waitState(m => m.restartFromYou === true, 5000, 'A 重开请求中');
    await B.waitState(m => m.restartOffer === true, 5000, 'B 收到重开请求');
    B.send({ t: 'restart' });
    await Promise.all([
      A.waitState(m => m.moves.length === 0 && m.winner === 0 && !m.restartFromYou, 5000, 'A 收到重开'),
      B.waitState(m => m.moves.length === 0 && m.winner === 0, 5000, 'B 收到重开'),
    ]);
    console.log(`  [${KIND}] 重开协商正常`);

    // ---- 拒绝重开 ----
    A.send({ t: 'restart' });
    await B.waitState(m => m.restartOffer === true, 5000, 'B 收到重开请求2');
    B.send({ t: 'restartDecline' });
    await A.waitState(m => m.flash && m.flash.msg.includes('拒绝'), 5000, 'A 收到拒绝通知');

    // ---- 掉线：座位保留（宽限期），A 看到对手离线而非离开 ----
    B.ws.close();
    await A.waitState(m => m.players.white && m.online.white === false, 5000, 'A 看到对手离线');
    console.log(`  [${KIND}] 掉线离线标记正常`);

    // ---- 断线重连恢复座位 ----
    const B2 = makeClient('B2', 'cid-bob');
    await new Promise(r => B2.ws.on('open', r));
    B2.send({ t: 'join', room: code });
    await B2.waitState(m => m.you === 2 && m.players.black && m.players.white, 5000, 'B2 恢复座位');
    await A.waitState(m => m.online.white === true, 5000, 'A 看到 B2 回来');
    console.log(`  [${KIND}] 断线重连恢复座位正常`);

    // ---- 黑方（房主）掉线重连同样能恢复（修复前会报"房间已满"） ----
    A.ws.close();
    await B2.waitState(m => m.online.black === false, 5000, 'B2 看到房主离线');
    const A2 = makeClient('A2', 'cid-alice');
    await new Promise(r => A2.ws.on('open', r));
    A2.send({ t: 'join', room: code });
    await A2.waitState(m => m.you === 1 && m.players.black && m.players.white, 5000, 'A2 恢复黑座位');
    console.log(`  [${KIND}] 房主掉线重连恢复正常`);

    // ---- 双方都在线时第三方加入报房间已满 ----
    const C = makeClient('C', 'cid-carol');
    await new Promise(r => C.ws.on('open', r));
    C.send({ t: 'join', room: code });
    await C.waitError('房间已满', 5000, 'C 加入满员房间');
    C.ws.close();

    // ---- 主动离开立即让出座位，新人可补位 ----
    A2.send({ t: 'leave' });
    await B2.waitState(m => !m.players.black, 5000, 'B2 看到黑位空出');
    const D = makeClient('D', 'cid-dave');
    await new Promise(r => D.ws.on('open', r));
    D.send({ t: 'join', room: code });
    await D.waitState(m => m.you === 1, 5000, 'D 补位黑棋');
    console.log(`  [${KIND}] 主动离开与补位正常`);

    A2.ws.close();
    B2.ws.close();
    D.ws.close();
    console.log(`✔ 联机对战集成测试全部通过（${KIND} 后端）`);
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(`✘ 联机测试失败（${KIND} 后端）:`, e.message);
  process.exit(1);
});
