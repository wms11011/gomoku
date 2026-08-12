/** 线上验证：两个客户端连真实部署的 Deno Deploy 服务，跑完整对局 */
'use strict';
const assert = require('assert');
const WebSocket = require('ws');
const URL = 'wss://gomoku.wms11011.deno.net';

function mk(name, cid) {
  const ws = new WebSocket(URL);
  const queue = []; const waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
  });
  return {
    ws,
    send: o => ws.send(JSON.stringify({ ...o, cid })),
    waitMsg(pred, timeout = 15000, label = '') {
      const i = queue.findIndex(pred);
      if (i >= 0) { const [m] = queue.splice(i, 1); queue.splice(0, i); return Promise.resolve(m); }
      return new Promise((res, rej) => {
        const w = { pred, resolve: m => { clearTimeout(t); res(m); } };
        const t = setTimeout(() => {
          const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1);
          const e = new Error(`${name}: 超时 [${label}]`); e.isTimeout = true; rej(e);
        }, timeout);
        waiters.push(w);
      });
    },
    waitState(pred, label) { return this.waitMsg(m => m.t === 'state' && pred(m), 15000, label); },
  };
}

(async () => {
  const t0 = Date.now();
  const A = mk('A', 'live-alice-' + Date.now());
  await new Promise(r => A.ws.on('open', r));
  A.send({ t: 'create' });
  const created = await A.waitState(m => m.you === 1 && m.players.black && !m.players.white, 'A 建房');
  console.log(`  线上建房成功: ${created.code} (${Date.now() - t0}ms)`);

  const B = mk('B', 'live-bob-' + Date.now());
  await new Promise(r => B.ws.on('open', r));
  B.send({ t: 'join', room: created.code });
  await B.waitState(m => m.you === 2 && m.players.white, 'B 加入');
  await A.waitState(m => m.players.white, 'A 看到对手');
  console.log('  双端进房同步正常');

  const seq = [[A,7,7],[B,0,0],[A,8,7],[B,0,1],[A,9,7],[B,0,2],[A,10,7],[B,0,3],[A,11,7]];
  let wa, wb;
  for (let i = 0; i < seq.length; i++) {
    const [c, x, y] = seq[i];
    c.send({ t: 'move', x, y });
    const n = i + 1;
    [wa, wb] = await Promise.all([
      A.waitState(m => m.moves.length === n, `A 第${n}手`),
      B.waitState(m => m.moves.length === n, `B 第${n}手`),
    ]);
  }
  assert.strictEqual(wa.winner, 1);
  assert.strictEqual(wa.winLine.length, 5);
  console.log('  完整对局 + 五连胜负判定正常');

  A.send({ t: 'restart' });
  await B.waitState(m => m.restartOffer, 'B 收到重开请求');
  B.send({ t: 'restart' });
  await A.waitState(m => m.moves.length === 0 && m.winner === 0, 'A 收到重开');
  console.log('  重开协商正常');

  A.ws.close(); B.ws.close();
  console.log(`✔ 线上联机验证全部通过（总耗时 ${Date.now() - t0}ms）`);
  process.exit(0);
})().catch(e => { console.error('✘ 线上验证失败:', e.message); process.exit(1); });
