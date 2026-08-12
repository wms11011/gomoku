/**
 * 联机对战集成测试：
 * 启动真实服务器，用两个 WebSocket 客户端模拟完整对局流程。
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3457;
const URL = `ws://127.0.0.1:${PORT}`;

function makeClient(name) {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex(w => w.type === msg.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** 等待某类型消息（含已收到的缓存） */
    waitFor(type, timeout = 4000) {
      const i = queue.findIndex(m => m.t === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve: (m) => { clearTimeout(timer); resolve(m); } };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1); // 超时后移除，避免吞掉后续消息
          reject(new Error(`${name}: 等待 ${type} 超时`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    /** 断言在 wait ms 内不会收到某类型消息 */
    async expectSilent(type, wait = 300) {
      try {
        await this.waitFor(type, wait);
        throw new Error(`${name}: 不应收到 ${type}`);
      } catch (e) {
        if (/超时$/.test(e.message)) return;
        throw e;
      }
    },
  };
}

async function main() {
  // 启动服务器子进程
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (d.toString().includes('已启动')) resolve(); });
    server.on('exit', () => reject(new Error('服务器提前退出')));
    setTimeout(() => reject(new Error('服务器启动超时')), 5000);
  });

  try {
    // ---- 建房 / 加入 ----
    const A = makeClient('A');
    await new Promise(r => A.ws.on('open', r));
    A.send({ t: 'create' });
    const created = await A.waitFor('created');
    assert.ok(/^[A-Z2-9]{4}$/.test(created.room), `房间号格式错误: ${created.room}`);
    console.log(`  房间创建成功: ${created.room}`);

    // 加入不存在的房间应报错
    const tmp = makeClient('TMP');
    await new Promise(r => tmp.ws.on('open', r));
    tmp.send({ t: 'join', room: 'ZZZZ' });
    const err = await tmp.waitFor('error');
    assert.ok(err.msg.includes('不存在'), '加入不存在房间应报错');
    tmp.ws.close();

    const B = makeClient('B');
    await new Promise(r => B.ws.on('open', r));
    B.send({ t: 'join', room: created.room });
    const [startA, startB] = await Promise.all([A.waitFor('start'), B.waitFor('start')]);
    assert.strictEqual(startA.color, 1, '创建者应执黑');
    assert.strictEqual(startB.color, 2, '加入者应执白');

    // ---- 越权走子：白棋抢先走应被服务器忽略 ----
    B.send({ t: 'move', x: 0, y: 0 });
    await A.expectSilent('move');
    await B.expectSilent('move');

    // ---- 正常对局：黑棋横向五连胜 ----
    const seq = [
      [A, 7, 7], [B, 0, 0],
      [A, 8, 7], [B, 0, 1],
      [A, 9, 7], [B, 0, 2],
      [A, 10, 7], [B, 0, 3],
      [A, 11, 7],
    ];
    for (const [client, x, y] of seq) {
      client.send({ t: 'move', x, y });
      const [ma, mb] = await Promise.all([A.waitFor('move'), B.waitFor('move')]);
      assert.ok(ma.x === x && ma.y === y, '走子应广播给双方');
      assert.deepStrictEqual(ma, mb, '双方收到的走子广播应一致');
    }
    const [winA, winB] = await Promise.all([A.waitFor('win'), B.waitFor('win')]);
    assert.strictEqual(winA.winner, 1, '黑棋应获胜');
    assert.strictEqual(winA.line.length, 5, '胜利连线应为 5 子');
    assert.deepStrictEqual(winA, winB);
    console.log('  完整对局与胜负广播正常');

    // ---- 终局后走子应被拒绝 ----
    B.send({ t: 'move', x: 5, y: 5 });
    await A.expectSilent('move');

    // ---- 重开协商 ----
    A.send({ t: 'restart' });
    await B.waitFor('restartOffer');
    B.send({ t: 'restart' });
    await Promise.all([A.waitFor('restarted'), B.waitFor('restarted')]);
    console.log('  重开协商正常');

    // ---- 重开后黑棋可正常走子 ----
    A.send({ t: 'move', x: 7, y: 7 });
    await Promise.all([A.waitFor('move'), B.waitFor('move')]);

    // ---- 拒绝重开 ----
    A.send({ t: 'restart' });
    await B.waitFor('restartOffer');
    B.send({ t: 'restartDecline' });
    await A.waitFor('restartDeclined');

    // ---- 断线通知 ----
    B.ws.close();
    await A.waitFor('peerLeft');
    console.log('  断线通知正常');

    A.ws.close();
    console.log('✔ 联机对战集成测试全部通过');
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error('✘ 联机测试失败:', e.message);
  process.exit(1);
});
