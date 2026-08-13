/**
 * 俄罗斯方块渲染与交互：Canvas 伪 3D 方块、粒子/震屏/飘分特效、
 * WebAudio 合成音效、键盘 + 触屏双操控。
 * 游戏逻辑全部在 js/tetris/core.js。
 */
(function () {
  'use strict';

  const Core = window.TetrisCore;
  const { COLS, ROWS, HIDDEN } = Core;

  // ---------- 尺寸 ----------
  const CELL = 32;
  const BOARD_W = COLS * CELL;   // 320
  const BOARD_H = ROWS * CELL;   // 640

  // ---------- 调色板（亮/中/暗三档表现立体） ----------
  const PALETTE = {
    1: { light: '#7ef3ff', base: '#28c8e8', dark: '#0f7a9c', glow: 'rgba(80,220,255,.8)' },  // I 青
    2: { light: '#ffe98a', base: '#f5c531', dark: '#a87c12', glow: 'rgba(255,215,90,.8)' },  // O 黄
    3: { light: '#d0a8ff', base: '#9b5de5', dark: '#5c2e99', glow: 'rgba(180,120,255,.8)' }, // T 紫
    4: { light: '#8dfba5', base: '#3ed598', dark: '#17875a', glow: 'rgba(90,255,160,.8)' },  // S 绿
    5: { light: '#ff9d9d', base: '#f0506e', dark: '#9c1f3a', glow: 'rgba(255,90,110,.8)' },  // Z 红
    6: { light: '#8fb8ff', base: '#3f7de0', dark: '#1e4694', glow: 'rgba(110,150,255,.8)' }, // J 蓝
    7: { light: '#ffc98a', base: '#f58b31', dark: '#a85510', glow: 'rgba(255,160,80,.8)' },  // L 橙
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('tetris-board');
  const ctx = canvas.getContext('2d');
  const overlays = { start: $('overlay-start'), pause: $('overlay-pause'), over: $('overlay-over') };
  const statEls = {
    score: $('stat-score'), lines: $('stat-lines'),
    level: $('stat-level'), best: $('stat-best'),
  };

  // ---------- 状态 ----------
  let state = Core.createGame();
  let playing = false;   // 已开始（点过开始按钮）
  let paused = false;
  let best = 0;
  let muted = false;
  try { best = Number(localStorage.getItem('tetris-best')) || 0; } catch { /* 忽略 */ }

  // ---------- 特效状态 ----------
  let particles = [];      // {x,y,vx,vy,life,maxLife,color,size}
  let flashRows = [];      // {row, t}
  let floaters = [];       // {text, x, y, t}
  let shake = 0;           // 震屏剩余帧
  let trail = null;        // {cells, t} 硬降残影
  let lastComboShown = -1;

  // ---------- 音效 ----------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function tone(freq, dur, delay = 0, type = 'square', vol = 0.06) {
    if (!audioCtx || muted) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const sfx = {
    move: () => tone(210, 0.03, 0, 'square', 0.03),
    rotate: () => tone(330, 0.05, 0, 'square', 0.05),
    soft: () => tone(160, 0.02, 0, 'square', 0.02),
    hard: () => { tone(80, 0.07, 0, 'triangle', 0.16); tone(55, 0.09, 0.01, 'sine', 0.14); },
    lock: () => tone(120, 0.05, 0, 'triangle', 0.09),
    clear: () => [523, 659, 784].forEach((f, i) => tone(f, 0.08, i * 0.05, 'triangle', 0.08)),
    tetris: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, i * 0.06, 'sawtooth', 0.07)),
    levelup: () => [440, 587, 880].forEach((f, i) => tone(f, 0.12, i * 0.08, 'sine', 0.09)),
    hold: () => tone(260, 0.06, 0, 'sine', 0.06),
    over: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.22, i * 0.14, 'triangle', 0.08)),
  };

  // ---------- 画布初始化 ----------
  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = BOARD_W * dpr;
    canvas.height = BOARD_H * dpr;
    canvas.style.width = BOARD_W + 'px';
    canvas.style.height = BOARD_H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- 伪 3D 方块 ----------
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawBlock(c, px, py, size, colorId, opts = {}) {
    const pal = PALETTE[colorId];
    if (!pal) return;
    const pad = size * 0.07;
    const x = px + pad, y = py + pad, s = size - pad * 2;
    const r = s * 0.22;
    c.save();
    if (opts.alpha !== undefined) c.globalAlpha = opts.alpha;

    if (opts.ghost) {
      // 幽灵投影：描边 + 极淡填充
      roundRect(c, x, y, s, s, r);
      c.fillStyle = pal.base;
      c.globalAlpha = 0.10;
      c.fill();
      c.globalAlpha = opts.alpha !== undefined ? opts.alpha : 0.45;
      c.strokeStyle = pal.base;
      c.lineWidth = Math.max(1, size * 0.05);
      c.stroke();
      c.restore();
      return;
    }

    if (opts.glow) {
      c.shadowColor = pal.glow;
      c.shadowBlur = size * 0.55;
    }

    // 主体：左上亮 → 右下暗的斜面渐变
    roundRect(c, x, y, s, s, r);
    const g = c.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, pal.light);
    g.addColorStop(0.45, pal.base);
    g.addColorStop(1, pal.dark);
    c.fillStyle = g;
    c.fill();
    c.shadowBlur = 0;

    // 顶部高光棱线
    c.strokeStyle = 'rgba(255,255,255,.65)';
    c.lineWidth = Math.max(1, size * 0.055);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x + s * 0.18, y + s * 0.09);
    c.lineTo(x + s * 0.82, y + s * 0.09);
    c.stroke();

    // 底部暗边
    c.strokeStyle = 'rgba(0,0,0,.40)';
    c.beginPath();
    c.moveTo(x + s * 0.18, y + s * 0.93);
    c.lineTo(x + s * 0.82, y + s * 0.93);
    c.stroke();

    // 内嵌高光面（立体感核心）
    roundRect(c, x + s * 0.16, y + s * 0.14, s * 0.68, s * 0.44, r * 0.55);
    const gloss = c.createLinearGradient(x, y + s * 0.1, x, y + s * 0.58);
    gloss.addColorStop(0, 'rgba(255,255,255,.34)');
    gloss.addColorStop(1, 'rgba(255,255,255,.02)');
    c.fillStyle = gloss;
    c.fill();

    c.restore();
  }

  // ---------- 背景 ----------
  const stars = Array.from({ length: 40 }, (_, i) => ({
    x: (i * 137.5) % BOARD_W,
    y: (i * 89.3) % BOARD_H,
    r: 0.5 + (i % 3) * 0.4,
    speed: 4 + (i % 5) * 3,
  }));

  function drawBackground(t) {
    const g = ctx.createLinearGradient(0, 0, 0, BOARD_H);
    g.addColorStop(0, '#151826');
    g.addColorStop(1, '#0c0e16');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);

    // 漂移星点
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    for (const s of stars) {
      const y = (s.y + t * s.speed / 1000) % BOARD_H;
      ctx.beginPath();
      ctx.arc(s.x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < COLS; i++) {
      ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, BOARD_H); ctx.stroke();
    }
    for (let i = 1; i < ROWS; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(BOARD_W, i * CELL); ctx.stroke();
    }
  }

  // ---------- 特效 ----------
  function spawnClearEffects(clear) {
    if (!clear || !clear.count) {
      if (state.lastClear && state.lastClear.count === 0) { /* 无消行 */ }
      return;
    }
    for (const row of clear.rows) {
      const vy0 = -3.5;
      for (let i = 0; i < 26; i++) {
        const colorKeys = Object.keys(PALETTE);
        const pal = PALETTE[colorKeys[(Math.random() * colorKeys.length) | 0]];
        particles.push({
          x: Math.random() * BOARD_W,
          y: (row - HIDDEN) * CELL + CELL / 2,
          vx: (Math.random() - 0.5) * 5,
          vy: vy0 + Math.random() * 3,
          life: 0,
          maxLife: 45 + Math.random() * 20,
          color: pal.base,
          size: 2 + Math.random() * 4,
        });
      }
      flashRows.push({ row: row - HIDDEN, t: 12 });
    }
    if (clear.count === 4) {
      shake = 10;
      sfx.tetris();
    } else {
      sfx.clear();
    }
    // 飘分
    const label = clear.count === 4 ? `TETRIS +${clear.points}` : `+${clear.points}`;
    floaters.push({ text: label, x: BOARD_W / 2, y: BOARD_H * 0.4, t: 0 });
    if (clear.combo > 0 && clear.combo !== lastComboShown) {
      floaters.push({ text: `${clear.combo + 1} 连击!`, x: BOARD_W / 2, y: BOARD_H * 0.4 + 40, t: 0 });
    }
    if (clear.levelUp) {
      floaters.push({ text: `等级提升 → ${state.level}`, x: BOARD_W / 2, y: BOARD_H * 0.55, t: 0 });
      sfx.levelup();
    }
  }

  function spawnTrail(cells) {
    trail = { cells, t: 10 };
  }

  // ---------- 渲染 ----------
  function pieceCells(piece, atY) {
    const m = Core.matrixOf(piece);
    const y = atY === undefined ? piece.y : atY;
    return Core.cellsOf(m, piece.x, y);
  }

  function render(t) {
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
      shake--;
    }

    drawBackground(t);

    // 已锁定方块（去饱和）
    for (let y = HIDDEN; y < Core.TOTAL; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = state.board[y][x];
        if (v) drawBlock(ctx, x * CELL, (y - HIDDEN) * CELL, CELL, v, { alpha: 0.88 });
      }
    }

    if (playing && !state.gameOver) {
      // 幽灵投影
      const gy = Core.ghostY(state);
      for (const [x, y, id] of pieceCells(state.current, gy)) {
        if (y >= HIDDEN) drawBlock(ctx, x * CELL, (y - HIDDEN) * CELL, CELL, id, { ghost: true });
      }
      // 硬降残影
      if (trail) {
        for (const [x, y, id] of trail.cells) {
          if (y >= HIDDEN) drawBlock(ctx, x * CELL, (y - HIDDEN) * CELL, CELL, id, { alpha: trail.t / 40, glow: true });
        }
        trail.t--;
        if (trail.t <= 0) trail = null;
      }
      // 当前方块（带辉光）
      for (const [x, y, id] of pieceCells(state.current)) {
        if (y >= HIDDEN) drawBlock(ctx, x * CELL, (y - HIDDEN) * CELL, CELL, id, { glow: true });
      }
    }

    // 消行闪白
    for (let i = flashRows.length - 1; i >= 0; i--) {
      const f = flashRows[i];
      ctx.fillStyle = `rgba(255,255,255,${f.t / 12 * 0.75})`;
      ctx.fillRect(0, f.row * CELL, BOARD_W, CELL);
      f.t--;
      if (f.t <= 0) flashRows.splice(i, 1);
    }

    // 粒子
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18;
      const a = 1 - p.life / p.maxLife;
      if (a <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // 飘分文字
    ctx.textAlign = 'center';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.t++;
      const a = 1 - f.t / 70;
      if (a <= 0) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = a;
      ctx.font = `bold ${f.text.startsWith('TETRIS') ? 30 : 24}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = '#ffd97a';
      ctx.shadowColor = 'rgba(255,180,60,.9)';
      ctx.shadowBlur = 14;
      ctx.fillText(f.text, f.x, f.y - f.t * 0.8);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;

    // 边框
    ctx.strokeStyle = 'rgba(216,179,106,.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, BOARD_W - 2, BOARD_H - 2);

    ctx.restore();
  }

  // ---------- 预览（Next / Hold） ----------
  function drawPreview(canvasEl, type) {
    const c = canvasEl.getContext('2d');
    const size = canvasEl.width;
    c.clearRect(0, 0, size, size);
    if (!type) return;
    const m = Core.matrixOf({ type, rot: 0 });
    let minX = 9, maxX = -1, minY = 9, maxY = -1;
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m[y].length; x++) {
        if (m[y][x]) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const cell = Math.min(size / (w + 1.2), size / (h + 1.2));
    const ox = (size - w * cell) / 2, oy = (size - h * cell) / 2;
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m[y].length; x++) {
        if (m[y][x]) drawBlock(c, ox + (x - minX) * cell, oy + (y - minY) * cell, cell, m[y][x]);
      }
    }
  }

  function refreshHud() {
    for (let i = 0; i < 3; i++) drawPreview($('next-' + i), state.queue[i]);
    drawPreview($('hold'), state.hold);
    statEls.score.textContent = state.score;
    statEls.lines.textContent = state.lines;
    statEls.level.textContent = state.level;
    statEls.best.textContent = Math.max(best, state.score);
  }

  // ---------- 流程控制 ----------
  function newGame() {
    state = Core.createGame();
    particles = [];
    flashRows = [];
    floaters = [];
    trail = null;
    shake = 0;
    paused = false;
    overlays.pause.classList.add('hidden');
    overlays.over.classList.add('hidden');
    refreshHud();
  }

  function startGame() {
    ensureAudio();
    newGame();
    playing = true;
    overlays.start.classList.add('hidden');
  }

  function togglePause() {
    if (!playing || state.gameOver) return;
    paused = !paused;
    overlays.pause.classList.toggle('hidden', !paused);
  }

  function onGameOver() {
    if (state.score > best) {
      best = state.score;
      try { localStorage.setItem('tetris-best', String(best)); } catch { /* 忽略 */ }
    }
    $('over-text').textContent = `得分 ${state.score} · 消行 ${state.lines}`;
    overlays.over.classList.remove('hidden');
    sfx.over();
  }

  let prevGameOver = false;
  let prevClearCount = 0;

  function afterAction() {
    // 读取最近一次消行信息做特效
    const c = state.lastClear;
    if (c && c.count !== prevClearCount || (c && c.count > 0 && c.rows.length)) {
      if (c.count > 0) spawnClearEffects(c);
    }
    prevClearCount = c ? c.count : 0;
    lastComboShown = c ? c.combo : -1;
    if (state.gameOver && !prevGameOver) onGameOver();
    prevGameOver = state.gameOver;
    refreshHud();
  }

  // ---------- 输入 ----------
  function act(name) {
    if (!playing || paused || state.gameOver) return;
    switch (name) {
      case 'left': if (Core.move(state, -1)) sfx.move(); break;
      case 'right': if (Core.move(state, 1)) sfx.move(); break;
      case 'rotate': if (Core.rotate(state, 1)) sfx.rotate(); break;
      case 'down': if (Core.softDrop(state) === 'moved') sfx.soft(); break;
      case 'drop': {
        const before = state.current;
        const startY = before.y;
        const cells = Core.cellsOf(Core.matrixOf(before), before.x, startY);
        const d = Core.hardDrop(state);
        if (d > 2) spawnTrail(cells);
        shake = Math.max(shake, 4);
        sfx.hard();
        break;
      }
      case 'hold': if (Core.holdPiece(state)) sfx.hold(); break;
    }
    afterAction();
  }

  document.addEventListener('keydown', (e) => {
    if (e.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(e.key)) return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); act('left'); break;
      case 'ArrowRight': e.preventDefault(); act('right'); break;
      case 'ArrowDown': e.preventDefault(); act('down'); break;
      case 'ArrowUp': case 'x': case 'X': e.preventDefault(); act('rotate'); break;
      case 'z': case 'Z': e.preventDefault(); act('rotate'); break;
      case ' ': e.preventDefault(); act('drop'); break;
      case 'c': case 'C': act('hold'); break;
      case 'p': case 'P': togglePause(); break;
      case 'Enter':
        if (!playing) startGame();
        else if (state.gameOver) startGame();
        break;
    }
  });

  // 触屏按钮（含长按重复）
  const touch = $('touch-controls');
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    touch.classList.remove('hidden');
  }
  let repeatTimer = null;
  function bindTouch(btn) {
    const name = btn.dataset.act;
    const repeatable = ['left', 'right', 'down'].includes(name);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ensureAudio();
      act(name);
      if (repeatable) {
        clearInterval(repeatTimer);
        repeatTimer = setInterval(() => act(name), 90);
      }
    });
    const stop = () => clearInterval(repeatTimer);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  }
  touch.querySelectorAll('button').forEach(bindTouch);

  // 面板按钮
  $('btn-start').addEventListener('click', startGame);
  $('btn-again').addEventListener('click', startGame);
  $('btn-resume').addEventListener('click', togglePause);
  $('btn-restart').addEventListener('click', () => { ensureAudio(); startGame(); });
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-mute').addEventListener('click', () => {
    muted = !muted;
    $('btn-mute').textContent = muted ? '🔇 静音' : '🔊 音效';
  });

  // ---------- 主循环 ----------
  let lastTime = 0;
  function loop(now) {
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    if (playing && !paused && !state.gameOver) {
      Core.tick(state, dt);
      // 重力导致的锁定也要触发特效
      if (state.lastClear && state.lastClear.rows.length && state.lastClear !== afterAction._seen) {
        afterAction._seen = state.lastClear;
        spawnClearEffects(state.lastClear);
      }
      if (state.gameOver && !prevGameOver) {
        prevGameOver = true;
        onGameOver();
      }
      refreshHud();
    }
    render(now);
    requestAnimationFrame(loop);
  }

  setupCanvas();
  refreshHud();
  requestAnimationFrame((t) => { lastTime = t; loop(t); });
})();
