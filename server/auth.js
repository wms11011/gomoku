/**
 * 访问门禁：手机号白名单验证（Node 与 Deno 服务器共用）。
 *
 * 通过环境变量配置（不写入代码，避免泄露到公开仓库）：
 *   GOMOKU_PHONES  —— 允许的手机号，逗号分隔，如 "13900000001,13900000002"
 *   GOMOKU_SECRET  —— 签名密钥（任意长随机串）；未设置时每次启动随机生成，
 *                     重启后所有访客需重新验证
 *
 * 未设置 GOMOKU_PHONES 时门禁关闭，所有人可访问（方便本地开发）。
 *
 * 验证方式：POST /api/login 提交手机号，命中白名单则下发签名 Cookie
 * （HMAC-SHA256(phone, SECRET)），之后页面与 WebSocket 均凭 Cookie 放行。
 */
'use strict';

const crypto = require('node:crypto');

let phones = [];
let secret = '';

/** env: { GOMOKU_PHONES, GOMOKU_SECRET } */
function init(env) {
  phones = String(env.GOMOKU_PHONES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  secret = String(env.GOMOKU_SECRET || '');
  if (phones.length && !secret) {
    secret = crypto.randomBytes(16).toString('hex');
    console.warn('[门禁] 已启用但未设置 GOMOKU_SECRET，使用随机密钥，重启后访客需重新验证');
  }
  if (phones.length) console.log(`[门禁] 已启用，白名单 ${phones.length} 个手机号`);
}

function enabled() {
  return phones.length > 0;
}

function checkPhone(phone) {
  return phones.includes(String(phone || '').trim());
}

function tokenFor(phone) {
  return crypto.createHmac('sha256', secret).update(phone).digest('hex');
}

/** 校验请求 Cookie 头是否带有合法签名 */
function authed(cookieHeader) {
  if (!enabled()) return true;
  const m = /(?:^|;\s*)gomoku_auth=([0-9a-f]{64})/.exec(cookieHeader || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'hex');
  for (const p of phones) {
    const expect = Buffer.from(tokenFor(p), 'hex');
    if (given.length === expect.length && crypto.timingSafeEqual(given, expect)) return true;
  }
  return false;
}

/** 生成 Set-Cookie 值；https 下加 Secure（本地 http 不加，否则浏览器拒存） */
function makeCookie(phone, isHttps) {
  const parts = [
    `gomoku_auth=${tokenFor(phone)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000',
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { init, enabled, checkPhone, authed, makeCookie };
