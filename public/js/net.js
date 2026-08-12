/**
 * WebSocket 客户端封装：连接、消息分发、客户端标识（cid）注入。
 * cid 存于 localStorage，断线重连后凭它恢复座位。
 */
(function (global) {
  'use strict';

  let ws = null;
  const handlers = {};

  // 每个浏览器一个稳定 cid
  let cid = null;
  try {
    cid = localStorage.getItem('gomoku-cid');
    if (!cid) {
      cid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      localStorage.setItem('gomoku-cid', cid);
    }
  } catch {
    cid = String(Math.random()).slice(2) + Date.now();
  }

  function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('无法连接到服务器'));
      ws.onclose = () => {
        ws = null;
        if (handlers.__close) handlers.__close();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (handlers[msg.t]) handlers[msg.t](msg);
      };
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...obj, cid }));
    }
  }

  function on(type, cb) { handlers[type] = cb; }

  function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }

  global.GomokuNet = { connect, send, on, isConnected, cid };
})(window);
