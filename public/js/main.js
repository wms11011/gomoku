/**
 * 五子棋前端主逻辑：棋盘渲染、交互、人机 / 联机 / 本地三种模式。
 */
(function () {
  'use strict';

  const Core = window.GomokuCore;
  const AI = window.GomokuAI;
  const Net = window.GomokuNet;
  const { SIZE, EMPTY, BLACK, WHITE } = Core;

  // ---------- 常量 ----------
  const CSS_SIZE = 640;                 // 画布逻辑尺寸（CSS 会等比缩放）
  const PAD = 40;                       // 棋盘边距
  const CELL = (CSS_SIZE - PAD * 2) / (SIZE - 1);
  const STONE_R = CELL * 0.44;
  const STAR_POINTS = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];

  // ---------- 对局状态 ----------
  let mode = 'ai';                      // 'ai' | 'net' | 'local'
  let difficulty = 'medium';
  let myColor = BLACK;                  // 人机 / 联机模式下本方颜色
  let board = Core.createBoard();
  let turn = BLACK;
  let gameOver = false;
  let winLine = null;
  let history = [];                     // {x, y, color}
  let hover = null;                     // [x, y]
  let anim = null;                      // {x, y, start} 落子动画
  let aiThinking = false;
  let gameId = 0;                       // 用于取消过期的 AI 思考

  // ---------- 联机状态 ----------
  let netRoom = null;
  let netActive = false;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const els = {
    modeSeg: $('mode-seg'), diffSeg: $('diff-seg'), colorSeg: $('color-seg'),
    aiOptions: $('ai-options'), netOptions: $('net-options'),
    btnCreate: $('btn-create'), btnJoin: $('btn-join'), roomInput: $('room-input'),
    roomInfo: $('room-info'), roomCode: $('room-code'), roomStatus: $('room-status'),
    turnDot: $('turn-dot'), statusText: $('status-text'),
    moveCount: $('move-count'), roleText: $('role-text'),
    btnRestart: $('btn-restart'), btnUndo: $('btn-undo'),
    restartOffer: $('restart-offer'), btnAccept: $('btn-accept'), btnDecline: $('btn-decline'),
    toast: $('toast'),
  };

  // ---------- 音效（WebAudio 合成，无需音频文件） ----------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function tone(freq, duration, delay = 0, type = 'triangle', volume = 0.18) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playPlace(color) { tone(color === BLACK ? 190 : 300, 0.09, 0, 'triangle', 0.22); }
  function playWin() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, i * 0.1, 'sine', 0.16)); }

  // ---------- Toast ----------
  let toastTimer = null;
  function showToast(msg, ms = 2400) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden', 'fade-out');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.add('fade-out');
      setTimeout(() => els.toast.classList.add('hidden'), 400);
    }, ms);
  }

  // ==================== 棋盘渲染 ====================
  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CSS_SIZE * dpr;
    canvas.height = CSS_SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawWood() {
    const g = ctx.createLinearGradient(0, 0, CSS_SIZE, CSS_SIZE);
    g.addColorStop(0, '#eec887');
    g.addColorStop(0.5, '#e3b36c');
    g.addColorStop(1, '#d29e55');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CSS_SIZE, CSS_SIZE);
    // 木纹（确定性伪随机，避免每帧抖动）
    ctx.strokeStyle = 'rgba(120, 72, 25, 0.07)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 9; i++) {
      const y0 = 30 + i * 68;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let x = 0; x <= CSS_SIZE; x += 32) {
        ctx.lineTo(x, y0 + Math.sin((x + i * 97) * 0.02) * 7 + Math.cos((x + i * 53) * 0.013) * 5);
      }
      ctx.stroke();
    }
  }

  function drawGrid() {
    ctx.strokeStyle = 'rgba(74, 48, 20, 0.85)';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      const p = PAD + i * CELL;
      ctx.beginPath(); ctx.moveTo(PAD, p); ctx.lineTo(CSS_SIZE - PAD, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, PAD); ctx.lineTo(p, CSS_SIZE - PAD); ctx.stroke();
    }
    // 外框加粗
    ctx.lineWidth = 2.5;
    ctx.strokeRect(PAD, PAD, CSS_SIZE - PAD * 2, CSS_SIZE - PAD * 2);
    // 星位
    ctx.fillStyle = 'rgba(74, 48, 20, 0.9)';
    for (const [x, y] of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(PAD + x * CELL, PAD + y * CELL, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawStone(x, y, color, scale = 1, alpha = 1, shadow = true) {
    const cx = PAD + x * CELL, cy = PAD + y * CELL, r = STONE_R * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = r * 0.4;
      ctx.shadowOffsetY = r * 0.14;
    }
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.38, r * 0.1, cx, cy, r);
    if (color === BLACK) {
      g.addColorStop(0, '#6e6e78'); g.addColorStop(0.45, '#2b2b33'); g.addColorStop(1, '#060609');
    } else {
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#f1efe8'); g.addColorStop(1, '#c5c2b8');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawWinLine() {
    if (!winLine || winLine.length < 5) return;
    const first = winLine[0], last = winLine[winLine.length - 1];
    const x1 = PAD + first[0] * CELL, y1 = PAD + first[1] * CELL;
    const x2 = PAD + last[0] * CELL, y2 = PAD + last[1] * CELL;
    // 沿方向延伸半格
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ex = (dx / len) * CELL * 0.6, ey = (dy / len) * CELL * 0.6;
    ctx.save();
    ctx.strokeStyle = 'rgba(233, 84, 84, 0.95)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(233, 84, 84, 0.8)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(x1 - ex, y1 - ey);
    ctx.lineTo(x2 + ex, y2 + ey);
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    drawWood();
    drawGrid();

    // 棋子
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const v = board[y][x];
        if (v === EMPTY) continue;
        let scale = 1;
        if (anim && anim.x === x && anim.y === y) {
          const t = Math.min(1, (performance.now() - anim.start) / 150);
          scale = 1 - 0.35 * (1 - t) * (1 - t); // 从小弹入
        }
        drawStone(x, y, v, scale);
      }
    }

    // 最后一手标记
    if (history.length) {
      const last = history[history.length - 1];
      const cx = PAD + last.x * CELL, cy = PAD + last.y * CELL;
      ctx.save();
      ctx.fillStyle = '#e95454';
      ctx.shadowColor = 'rgba(233, 84, 84, 0.9)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 悬停预览
    if (hover && canPlace(hover[0], hover[1])) {
      drawStone(hover[0], hover[1], turn, 1, 0.45, false);
    }

    drawWinLine();

    if (anim && performance.now() - anim.start < 160) {
      requestAnimationFrame(render);
    } else {
      anim = null;
    }
  }

  // ==================== 对局逻辑 ====================
  function canPlace(x, y) {
    if (gameOver || board[y][x] !== EMPTY) return false;
    if (mode === 'ai') return !aiThinking && turn === myColor;
    if (mode === 'net') return netActive && turn === myColor;
    return true; // local
  }

  function applyMove(x, y, color) {
    board[y][x] = color;
    history.push({ x, y, color });
    anim = { x, y, start: performance.now() };
    playPlace(color);
    const line = Core.checkWin(board, x, y);
    if (line) {
      gameOver = true;
      winLine = line;
      playWin();
    } else if (Core.isFull(board)) {
      gameOver = true;
      winLine = null;
    } else {
      turn = Core.opponent(color);
    }
    updateStatus();
    render();
  }

  function endText() {
    if (!gameOver) return '';
    if (!winLine) return '平局！';
    const winner = board[winLine[0][1]][winLine[0][0]];
    const name = winner === BLACK ? '黑棋' : '白棋';
    if (mode === 'local') return `${name}获胜！`;
    return winner === myColor ? '你赢了！🎉' : '你输了，再来一局？';
  }

  function updateStatus() {
    els.moveCount.textContent = `第 ${history.length} 手`;

    if (gameOver) {
      els.statusText.textContent = endText();
      const winner = winLine ? board[winLine[0][1]][winLine[0][0]] : null;
      els.turnDot.className = 'stone-dot ' + (winner === WHITE ? 'white' : 'black');
    } else {
      els.turnDot.className = 'stone-dot ' + (turn === BLACK ? 'black' : 'white');
      if (mode === 'ai') {
        els.statusText.textContent = aiThinking ? 'AI 思考中…' : (turn === myColor ? '轮到你落子' : 'AI 思考中…');
      } else if (mode === 'net') {
        if (!netActive) els.statusText.textContent = '等待对手加入…';
        else els.statusText.textContent = turn === myColor ? '轮到你落子' : '等待对手落子…';
      } else {
        els.statusText.textContent = turn === BLACK ? '轮到黑棋' : '轮到白棋';
      }
    }

    // 角色描述
    const diffName = { easy: '简单', medium: '普通', hard: '困难' }[difficulty];
    if (mode === 'ai') els.roleText.textContent = `人机 · ${diffName} · 你执${myColor === BLACK ? '黑' : '白'}`;
    else if (mode === 'net') els.roleText.textContent = netRoom ? `房间 ${netRoom} · 你执${myColor === BLACK ? '黑' : '白'}` : '联机对战';
    else els.roleText.textContent = '本地双人对弈';

    // 悔棋仅在人机 / 本地模式可用
    const undoable = (mode === 'local' && history.length >= 1) ||
      (mode === 'ai' && !aiThinking && history.length >= 1);
    els.btnUndo.classList.toggle('hidden', mode === 'net');
    els.btnUndo.disabled = !undoable;
  }

  function newGame() {
    gameId++;
    board = Core.createBoard();
    turn = BLACK;
    gameOver = false;
    winLine = null;
    history = [];
    hover = null;
    anim = null;
    aiThinking = false;
    updateStatus();
    render();
    // 人机模式下执白则 AI 先走
    if (mode === 'ai' && myColor === WHITE) scheduleAiMove();
  }

  function undo() {
    if (mode === 'net') return;
    if (mode === 'ai' && aiThinking) return;
    if (!history.length) return;
    gameId++;
    gameOver = false;
    winLine = null;
    // 人机模式撤销一手玩家 + 一手 AI；本地模式撤销一手
    const steps = mode === 'ai' ? Math.min(2, history.length) : 1;
    for (let i = 0; i < steps; i++) {
      const m = history.pop();
      board[m.y][m.x] = EMPTY;
    }
    // 人机模式保证轮到玩家
    turn = mode === 'ai' ? myColor : (history.length ? Core.opponent(history[history.length - 1].color) : BLACK);
    updateStatus();
    render();
  }

  // ==================== 人机 ====================
  function scheduleAiMove() {
    aiThinking = true;
    updateStatus();
    const id = gameId;
    setTimeout(() => {
      if (id !== gameId || gameOver) { aiThinking = false; return; }
      const [x, y] = AI.findBestMove(board, turn, difficulty);
      aiThinking = false;
      applyMove(x, y, turn);
    }, 300 + Math.random() * 250);
  }

  // ==================== 联机 ====================
  function resetNetUi() {
    netRoom = null;
    netActive = false;
    els.roomInfo.classList.add('hidden');
    els.restartOffer.classList.add('hidden');
    els.btnCreate.disabled = false;
    els.btnJoin.disabled = false;
  }

  function setupNetHandlers() {
    Net.on('created', (msg) => {
      netRoom = msg.room;
      els.roomCode.textContent = msg.room;
      els.roomStatus.textContent = '等待对手加入…';
      els.roomInfo.classList.remove('hidden');
      updateStatus();
    });

    Net.on('start', (msg) => {
      netRoom = msg.room;
      myColor = msg.color;
      netActive = true;
      els.roomCode.textContent = msg.room;
      els.roomStatus.textContent = '对局进行中';
      els.roomInfo.classList.remove('hidden');
      newGame();
      showToast(`对手已加入，你执${myColor === BLACK ? '黑先手' : '白后手'}`);
    });

    Net.on('move', (msg) => {
      applyMove(msg.x, msg.y, msg.color);
    });

    Net.on('win', () => { /* applyMove 已本地判定，无需重复处理 */ });
    Net.on('draw', () => { /* 同上 */ });

    Net.on('restartOffer', () => {
      els.restartOffer.classList.remove('hidden');
    });

    Net.on('restartDeclined', () => {
      els.btnRestart.disabled = false;
      showToast('对方拒绝了重开请求');
    });

    Net.on('restarted', () => {
      els.restartOffer.classList.add('hidden');
      els.btnRestart.disabled = false;
      newGame();
      showToast('新的一局开始，黑棋先行');
    });

    Net.on('peerLeft', () => {
      showToast('对手已离开房间');
      resetNetUi();
      updateStatus();
    });

    Net.on('error', (msg) => {
      els.btnCreate.disabled = false;
      els.btnJoin.disabled = false;
      showToast(msg.msg || '出错了');
    });

    Net.on('__close', () => {
      if (mode === 'net') {
        showToast('与服务器的连接已断开');
        resetNetUi();
        updateStatus();
      }
    });
  }

  async function createRoom() {
    els.btnCreate.disabled = true;
    try {
      await Net.connect();
      Net.send({ t: 'create' });
    } catch {
      els.btnCreate.disabled = false;
      showToast('无法连接到服务器');
    }
  }

  async function joinRoom() {
    const code = els.roomInput.value.trim().toUpperCase();
    if (code.length !== 4) { showToast('请输入 4 位房间号'); return; }
    els.btnJoin.disabled = true;
    try {
      await Net.connect();
      Net.send({ t: 'join', room: code });
    } catch {
      els.btnJoin.disabled = false;
      showToast('无法连接到服务器');
    }
  }

  // ==================== 输入事件 ====================
  function eventToCell(ev) {
    const rect = canvas.getBoundingClientRect();
    const scale = CSS_SIZE / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const py = (ev.clientY - rect.top) * scale;
    const x = Math.round((px - PAD) / CELL);
    const y = Math.round((py - PAD) / CELL);
    if (!Core.inBoard(x, y)) return null;
    // 距离交叉点太远则不响应，避免误触
    const cx = PAD + x * CELL, cy = PAD + y * CELL;
    if (Math.hypot(px - cx, py - cy) > CELL * 0.48) return null;
    return [x, y];
  }

  canvas.addEventListener('mousemove', (ev) => {
    const cell = eventToCell(ev);
    const changed = JSON.stringify(cell) !== JSON.stringify(hover);
    hover = cell;
    if (changed) render();
  });

  canvas.addEventListener('mouseleave', () => {
    if (hover) { hover = null; render(); }
  });

  canvas.addEventListener('click', (ev) => {
    ensureAudio();
    const cell = eventToCell(ev);
    if (!cell) return;
    const [x, y] = cell;
    if (!canPlace(x, y)) return;
    if (mode === 'net') {
      Net.send({ t: 'move', x, y }); // 等服务器回执后再落子，保证双方同步
    } else {
      applyMove(x, y, turn);
      if (!gameOver && mode === 'ai' && turn !== myColor) scheduleAiMove();
    }
  });

  // ==================== 面板事件 ====================
  function segInit(seg, attr, cb) {
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn || !btn.dataset[attr]) return;
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b === btn);
      cb(btn.dataset[attr]);
    });
  }

  segInit(els.modeSeg, 'mode', (m) => {
    if (mode === 'net' && m !== 'net') Net.send({ t: 'leave' });
    mode = m;
    els.aiOptions.classList.toggle('hidden', m !== 'ai');
    els.netOptions.classList.toggle('hidden', m !== 'net');
    if (m !== 'net') resetNetUi();
    newGame();
  });

  segInit(els.diffSeg, 'diff', (d) => { difficulty = d; newGame(); });

  segInit(els.colorSeg, 'color', (c) => { myColor = Number(c); newGame(); });

  els.btnCreate.addEventListener('click', () => { ensureAudio(); createRoom(); });
  els.btnJoin.addEventListener('click', () => { ensureAudio(); joinRoom(); });
  els.roomInput.addEventListener('input', () => {
    els.roomInput.value = els.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  els.roomInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') joinRoom(); });

  els.roomCode.addEventListener('click', () => {
    if (!netRoom) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(netRoom).then(() => showToast('房间号已复制'));
    }
  });

  els.btnRestart.addEventListener('click', () => {
    if (mode === 'net') {
      if (!netRoom) { showToast('请先创建或加入房间'); return; }
      els.btnRestart.disabled = true;
      Net.send({ t: 'restart' });
      showToast('已发送重开请求，等待对方同意');
    } else {
      newGame();
    }
  });

  els.btnUndo.addEventListener('click', undo);
  els.btnAccept.addEventListener('click', () => {
    els.restartOffer.classList.add('hidden');
    Net.send({ t: 'restart' }); // 双方均同意 → 服务器广播 restarted
  });
  els.btnDecline.addEventListener('click', () => {
    els.restartOffer.classList.add('hidden');
    Net.send({ t: 'restartDecline' });
  });

  // ==================== 启动 ====================
  setupCanvas();
  setupNetHandlers();
  newGame();
})();
