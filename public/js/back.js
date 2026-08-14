/**
 * 全站统一「返回游戏大厅」悬浮按钮（含二次确认弹窗）。
 * 在游戏页面引入本脚本即可自动注入，无需其他改动。
 */
(function () {
  'use strict';

  // 悬浮返回按钮（左上角，胶囊形带文字）
  const btn = document.createElement('button');
  btn.className = 'back-home-btn';
  btn.title = '返回游戏大厅';
  btn.setAttribute('aria-label', '返回游戏大厅');
  btn.innerHTML = '<span class="back-home-arrow">←</span> 返回大厅';

  // 二次确认弹窗
  const modal = document.createElement('div');
  modal.className = 'back-modal hidden';
  modal.innerHTML = `
    <div class="back-modal-card">
      <p class="back-modal-title">确定返回游戏大厅吗？</p>
      <p class="back-modal-sub">当前对局进度将丢失</p>
      <div class="back-modal-btns">
        <button class="btn primary" data-act="go">返回大厅</button>
        <button class="btn" data-act="stay">继续游戏</button>
      </div>
    </div>`;

  document.body.appendChild(btn);
  document.body.appendChild(modal);

  btn.addEventListener('click', () => modal.classList.remove('hidden'));

  modal.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'go') { location.href = '/'; return; }
    if (act === 'stay' || e.target === modal) modal.classList.add('hidden');
  });

  // Esc 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal.classList.add('hidden');
  });
})();
