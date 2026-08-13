/**
 * 手机号门禁集成测试：
 *   node test/auth.test.js                  # Node 后端
 *   SERVER_KIND=deno node test/auth.test.js # Deno 后端
 *
 * 覆盖：未验证拦截页面与 WebSocket、错误手机号 403、正确手机号发 Cookie、
 *       凭 Cookie 访问页面与建立 WebSocket。
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const KIND = process.env.SERVER_KIND || 'node';
const PORT = KIND === 'deno' ? 3463 : 3462;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

const PHONE_OK = '13900000001';
const PHONE_BAD = '13900000099';

async function main() {
  const cmd = KIND === 'deno'
    ? [path.join(ROOT, 'tools', 'deno.exe'), ['run', '--unstable-kv', '--allow-net', '--allow-read', '--allow-env', path.join(ROOT, 'deno', 'main.js')]]
    : [process.execPath, [path.join(ROOT, 'server', 'server.js')]];
  const server = spawn(cmd[0], cmd[1], {
    env: {
      ...process.env,
      PORT: String(PORT),
      KV_PATH: ':memory:',
      GOMOKU_PHONES: `${PHONE_OK},13900000002`,
      GOMOKU_SECRET: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (d.toString().includes('已启动')) resolve(); });
    server.on('exit', (code) => reject(new Error(`服务器提前退出 code=${code}`)));
    setTimeout(() => reject(new Error('服务器启动超时')), KIND === 'deno' ? 90000 : 10000);
  });

  try {
    // 1. 未验证：首页返回门禁页
    let r = await fetch(`${BASE}/`);
    let body = await r.text();
    assert.ok(body.includes('身份验证') && !body.includes('<canvas'), '未验证应返回门禁页');

    // 2. 未验证：静态资源同样被拦截
    r = await fetch(`${BASE}/js/main.js`);
    body = await r.text();
    assert.ok(body.includes('身份验证'), '未验证时静态资源也应被拦截');

    // 3. 错误手机号 → 403
    r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: PHONE_BAD }),
    });
    assert.strictEqual(r.status, 403, '错误手机号应返回 403');

    // 4. 正确手机号 → 200 + 签名 Cookie
    r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: PHONE_OK }),
    });
    assert.strictEqual(r.status, 200, '正确手机号应返回 200');
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(/^gomoku_auth=[0-9a-f]{64}$/.test(cookie), `应下发签名 Cookie，实际: ${cookie}`);

    // 5. 凭 Cookie 访问 → 游戏大厅与五子棋页面
    r = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
    body = await r.text();
    assert.ok(body.includes('游戏大厅'), '验证通过应返回游戏大厅');
    r = await fetch(`${BASE}/gomoku.html`, { headers: { Cookie: cookie } });
    body = await r.text();
    assert.ok(body.includes('<canvas'), '验证通过应返回五子棋页面');

    // 6. 篡改的 Cookie → 仍被拦截
    const badCookie = cookie.slice(0, -2) + (cookie.endsWith('aa') ? 'bb' : 'aa');
    r = await fetch(`${BASE}/`, { headers: { Cookie: badCookie } });
    body = await r.text();
    assert.ok(body.includes('身份验证'), '篡改的 Cookie 不应通过');

    // 7. WebSocket 无 Cookie → 拒绝
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.on('open', () => { ws.close(); resolve(new Error('不应放行')); });
      ws.on('error', () => resolve());
      ws.on('unexpected-response', (req, res) => { assert.strictEqual(res.statusCode, 401); resolve(); });
    });

    // 8. WebSocket 带 Cookie → 正常建房
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Cookie: cookie } });
      const timer = setTimeout(() => reject(new Error('WS 建房超时')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'create', cid: 'auth-test' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'state' && m.you === 1) { clearTimeout(timer); ws.close(); resolve(); }
      });
      ws.on('error', reject);
    });

    console.log(`✔ 门禁测试全部通过（${KIND} 后端）`);
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(`✘ 门禁测试失败（${KIND} 后端）:`, e.message);
  process.exit(1);
});
