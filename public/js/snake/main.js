/**
 * 贪吃蛇渲染与交互：还原绝区零「蛇对蛇」画风 ——
 * 明亮天蓝竞技场 + 橙色果冻方块蛇 + 像素纸屑粒子 + 街头潮流 UI。
 * 操控：虚拟模拟摇杆（浮动着点）+ 键盘方向键/WASD。
 * 画布由 JS 按视口自适应，保证手机上一屏放下无需滚动。
 * 游戏逻辑全部在 js/snake/core.js。
 */
(function () {
  'use strict';

  const Core = window.SnakeCore;
  const { GRID } = Core;

  // ---------- 尺寸 ----------
  const CELL = 28;
  const SIZE = GRID * CELL; // 672 逻辑像素

  // ---------- 配色（绝区零风：明亮蓝场 + 橙果冻蛇） ----------
  const COL = {
    arena0: '#53b2ff',  // 场地中心亮蓝
    arena1: '#2470e0',  // 中场蓝
    arena2: '#0e3a92',  // 边缘深蓝
    grid: 'rgba(255,255,255,.10)',
    snakeHead: '#ffd97a',
    snake: ['#ffcf6e', '#ffb154', '#ff913d', '#f5722a', '#e0552b', '#c93f2e'],
    food: '#4ff3d8',
    bonus: '#ffd94f',
    hud: '#ffd94f',
    confetti: ['#ffd94f', '#4ff3d8', '#ff4fd8', '#8fb8ff', '#ff9a3d', '#a6ff6e'],
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('snake-board');
  const ctx = canvas.getContext('2d');
  const overlays = { start: $('overlay-start'), over: $('overlay-over') };
  const joyZone = $('joystick-zone');
  const joyBase = $('joystick-base');
  const joyKnob = $('joystick-knob');
  const joyArrow = $('joystick-arrow');

  // ---------- 状态 ----------
  let state = Core.createGame();
  let playing = false;
  let best = 0;
  let muted = false;
  let acc = 0;
  try { best = Number(localStorage.getItem('snake-best')) || 0; } catch { /* 忽略 */ }

  // ---------- 特效状态 ----------
  let particles = [];   // 方块纸屑 {x,y,vx,vy,rot,vr,life,maxLife,color,size}
  let floaters = [];    // {text,x,y,t,color}
  let shake = 0;
  let deathFlash = 0;

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
    eat: () => { tone(660, 0.06, 0, 'square', 0.06); tone(990, 0.08, 0.05, 'square', 0.05); },
    bonus: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.1, i * 0.05, 'triangle', 0.08)),
    turn: () => tone(240, 0.02, 0, 'square', 0.02),
    death: () => [400, 300, 200, 120].forEach((f, i) => tone(f, 0.18, i * 0.1, 'sawtooth', 0.08)),
    start: () => [330, 440, 660].forEach((f, i) => tone(f, 0.09, i * 0.06, 'triangle', 0.08)),
  };

  // ---------- 画布尺寸自适应（一屏放下） ----------
  function isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const header = document.querySelector('.snake-header');
    const hint = document.querySelector('.snake-hint');
    const used =
      (header ? header.offsetHeight : 0) +
      (isTouch() ? joyZone.offsetHeight + 14 : 0) +
      (hint && getComputedStyle(hint).display !== 'none' ? hint.offsetHeight : 0) +
      56; // body 上下 padding + 边距余量
    const availH = window.innerHeight - used;
    const size = Math.max(220, Math.min(520, window.innerWidth - 24, availH));
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
  }

  window.addEventListener('resize', fitCanvas);
  window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 200));

  function cellCenter(c) {
    return { x: c.x * CELL + CELL / 2, y: c.y * CELL + CELL / 2 };
  }

  // ---------- 竞技场背景 ----------
  function drawBackground(t) {
    // 中心亮蓝的径向竞技场
    const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.08, SIZE / 2, SIZE / 2, SIZE * 0.75);
    g.addColorStop(0, COL.arena0);
    g.addColorStop(0.55, COL.arena1);
    g.addColorStop(1, COL.arena2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 慢速旋转的光带（速度感）
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(t / 6000);
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.fillRect(-SIZE * 0.06, -SIZE, SIZE * 0.12, SIZE * 2);
    }
    ctx.restore();

    // 浅色网格
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(SIZE, i * CELL); ctx.stroke();
    }
  }

  // ---------- 果冻方块（伪 3D 圆角立方体） ----------
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawJelly(px, py, size, color, opts = {}) {
    const pad = size * 0.06;
    const x = px + pad, y = py + pad, s = size - pad * 2;
    const r = s * 0.32;
    ctx.save();
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    if (opts.glow) { ctx.shadowColor = color; ctx.shadowBlur = size * 0.4; }

    // 主体渐变（上亮下暗）
    roundRect(ctx, x, y, s, s, r);
    const g = ctx.createLinearGradient(x, y, x, y + s);
    g.addColorStop(0, opts.light || '#ffffff55');
    g.addColorStop(0.18, color);
    g.addColorStop(1, opts.dark || 'rgba(0,0,0,.25)');
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 顶部果冻高光
    roundRect(ctx, x + s * 0.16, y + s * 0.10, s * 0.68, s * 0.38, r * 0.6);
    const gloss = ctx.createLinearGradient(x, y, x, y + s * 0.48);
    gloss.addColorStop(0, 'rgba(255,255,255,.5)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.fill();

    ctx.restore();
  }

  // ---------- 食物（像素魔豆） ----------
  function drawFood(t) {
    if (state.food) {
      const { x, y } = cellCenter(state.food);
      const bob = Math.sin(t / 260) * 2.5;
      const s = CELL * 0.52;
      ctx.save();
      ctx.shadowColor = COL.food;
      ctx.shadowBlur = 16;
      // 白边像素方块
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - s / 2 - 2, y - s / 2 - 2 + bob, s + 4, s + 4);
      ctx.fillStyle = COL.food;
      ctx.fillRect(x - s / 2, y - s / 2 + bob, s, s);
      // 高光点
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(x - s / 4, y - s / 4 + bob, s / 3, s / 3);
      ctx.restore();
    }

    if (state.bonus) {
      const { x, y } = cellCenter(state.bonus);
      const blink = state.bonus.ttl < 12 ? (Math.sin(t / 80) > 0 ? 1 : 0.3) : 1;
      const bob = Math.sin(t / 200) * 3;
      const s = CELL * 0.6;
      ctx.save();
      ctx.globalAlpha = blink;
      ctx.shadowColor = COL.bonus;
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - s / 2 - 2, y - s / 2 - 2 + bob, s + 4, s + 4);
      ctx.fillStyle = COL.bonus;
      ctx.fillRect(x - s / 2, y - s / 2 + bob, s, s);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillRect(x - s / 4, y - s / 4 + bob, s / 3, s / 3);
      // 剩余时间环
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y + bob, s * 0.85, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (state.bonus.ttl / Core.BONUS_TTL));
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- 果冻蛇 ----------
  function drawSnake(t) {
    const n = state.snake.length;
    const pts = state.snake.map(cellCenter);

    // 连接底线（让相邻节连起来）
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COL.snake[Math.min(3, COL.snake.length - 1)];
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = CELL * 0.6;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();

    // 逐节果冻方块（头→尾颜色渐变、微缩）
    for (let i = n - 1; i >= 1; i--) {
      const p = pts[i];
      const shrink = 1 - 0.3 * (i / Math.max(8, n));
      const size = CELL * 0.94 * shrink;
      const ci = Math.min(Math.floor(i / Math.max(1, n / COL.snake.length)), COL.snake.length - 1);
      drawJelly(p.x - size / 2, p.y - size / 2, size, COL.snake[ci], { glow: i < 4 });
    }

    // 头部（更大更亮）
    const head = pts[0];
    const hs = CELL * 1.06;
    drawJelly(head.x - hs / 2, head.y - hs / 2, hs, COL.snakeHead, { glow: true, dark: '#e8a13c' });

    // 卡通大眼睛（白色椭圆 + 黑瞳孔，按朝向排布）
    const d = state.dir;
    const along = CELL * 0.16;   // 朝前偏移
    const apart = CELL * 0.20;   // 两眼间距
    const ex = d.y !== 0 ? apart : 0;
    const ey = d.x !== 0 ? apart : 0;
    for (const s of [-1, 1]) {
      const cx = head.x + d.x * along + ex * s;
      const cy = head.y + d.y * along + ey * s;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(cx, cy, CELL * 0.13, CELL * 0.17, d.y !== 0 ? 0 : Math.PI / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c2233';
      ctx.beginPath();
      ctx.arc(cx + d.x * CELL * 0.05, cy + d.y * CELL * 0.05, CELL * 0.06, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 偶尔吐信子
    if (Math.sin(t / 600) > 0.92) {
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      const tx = head.x + d.x * CELL * 0.62, ty = head.y + d.y * CELL * 0.62;
      const px = d.y !== 0 ? 3.5 : 0, py = d.x !== 0 ? 3.5 : 0;
      ctx.beginPath();
      ctx.moveTo(head.x + d.x * CELL * 0.45, head.y + d.y * CELL * 0.45);
      ctx.lineTo(tx, ty);
      ctx.moveTo(tx, ty); ctx.lineTo(tx + d.x * 5 - px, ty + d.y * 5 - py);
      ctx.moveTo(tx, ty); ctx.lineTo(tx + d.x * 5 + px, ty + d.y * 5 + py);
      ctx.stroke();
    }
  }

  // ---------- 特效 ----------
  function spawnEatFx(cell, score) {
    const { x, y } = cellCenter(cell);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3.5;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        life: 0, maxLife: 32 + Math.random() * 16,
        color: COL.confetti[(Math.random() * COL.confetti.length) | 0],
        size: 3 + Math.random() * 4,
      });
    }
    floaters.push({ text: `+${score}`, x, y: y - 10, t: 0, color: score >= 30 ? COL.bonus : '#ffffff' });
  }

  function drawFx() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life++;
      p.x += p.vx; p.y += p.vy;
      p.vy += 0.15;
      p.rot += p.vr;
      const a = 1 - p.life / p.maxLife;
      if (a <= 0) { particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }

    ctx.textAlign = 'center';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.t++;
      const a = 1 - f.t / 50;
      if (a <= 0) { floaters.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = 'bold 22px "SF Mono", Consolas, monospace';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20,30,70,.9)';
      ctx.strokeText(f.text, f.x, f.y - f.t * 0.9);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - f.t * 0.9);
      ctx.restore();
    }
  }

  // ---------- HUD（橙黄像素风大字） ----------
  function hudText(text, x, y, align) {
    ctx.font = 'bold 19px "SF Mono", Consolas, monospace';
    ctx.textAlign = align;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(20,30,70,.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = COL.hud;
    ctx.fillText(text, x, y);
  }

  function drawHud() {
    hudText(`SCORE ${state.score}`, 14, 28, 'left');
    hudText(`BEST ${Math.max(best, state.score)}`, SIZE - 14, 28, 'right');
    const spd = Math.floor(state.eaten / 5) + 1;
    ctx.save();
    ctx.globalAlpha = 0.85;
    hudText(`×${spd}`, SIZE / 2, 28, 'center');
    ctx.restore();
  }

  // ---------- 渲染 ----------
  function render(t) {
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
      shake--;
    }
    drawBackground(t);
    drawFood(t);
    drawSnake(t);
    drawFx();
    drawHud();
    if (deathFlash > 0) {
      ctx.fillStyle = `rgba(255,60,60,${deathFlash / 20 * 0.3})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      deathFlash--;
    }
    // 深色相框
    ctx.strokeStyle = '#0a1c4a';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, SIZE, SIZE);
    ctx.restore();
  }

  // ---------- 流程 ----------
  let deathTimer = null;

  function newGame() {
    state = Core.createGame();
    acc = 0;
    particles = [];
    floaters = [];
    shake = 0;
    deathFlash = 0;
    wasAlive = true;              // 重置死亡检测，否则第二局起不再弹结束画面
    clearTimeout(deathTimer);     // 清掉上一局的延迟弹窗，防止盖到新局
  }

  function startGame() {
    ensureAudio();
    newGame();
    playing = true;
    overlays.start.classList.add('hidden');
    overlays.over.classList.add('hidden');
    sfx.start();
  }

  function onDeath() {
    playing = false;
    shake = 12;
    deathFlash = 20;
    sfx.death();
    if (state.score > best) {
      best = state.score;
      try { localStorage.setItem('snake-best', String(best)); } catch { /* 忽略 */ }
    }
    deathTimer = setTimeout(() => {
      $('over-text').textContent = `得分 ${state.score} · 吃掉 ${state.eaten} 颗豆`;
      overlays.over.classList.remove('hidden');
    }, 500);
  }

  // ---------- 主循环 ----------
  let lastTime = 0;
  let wasAlive = true;
  function loop(now) {
    const dt = Math.min(60, now - lastTime);
    lastTime = now;
    if (playing && state.alive) {
      acc += dt;
      const interval = Core.intervalFor(state);
      while (acc >= interval && state.alive) {
        acc -= interval;
        const prevScore = state.score;
        const prevLen = state.snake.length;
        Core.step(state);
        if (state.snake.length > prevLen) {
          const gained = state.score - prevScore;
          spawnEatFx(state.snake[0], gained);
          if (gained >= 30) sfx.bonus(); else sfx.eat();
        }
      }
    }
    // 死亡检测放在外层，任何路径的死亡都不会漏掉
    if (playing && !state.alive && wasAlive) { wasAlive = false; onDeath(); }
    render(now);
    requestAnimationFrame(loop);
  }

  // ---------- 键盘 ----------
  document.addEventListener('keydown', (e) => {
    const map = {
      ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
      ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
      ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
      ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
    };
    if (map[e.key]) {
      e.preventDefault();
      if (Core.setDir(state, ...map[e.key])) sfx.turn();
    } else if (e.key === 'Enter' && !playing) {
      startGame();
    }
  });

  // ---------- 虚拟模拟摇杆（浮动着点） ----------
  const JOY_RADIUS = 46;
  const DEAD_ZONE = 12;
  let joy = null;

  function showJoystick(x, y) {
    const zr = joyZone.getBoundingClientRect();
    joyBase.style.left = (x - zr.left) + 'px';
    joyBase.style.top = (y - zr.top) + 'px';
    joyBase.classList.add('active');
    joyKnob.style.transform = 'translate(-50%,-50%)';
    joyArrow.style.opacity = '0';
  }

  function moveJoystick(dx, dy) {
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(len, JOY_RADIUS);
    const nx = len ? dx / len : 0, ny = len ? dy / len : 0;
    joyKnob.style.transform = `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;

    if (len > DEAD_ZONE && playing && state.alive) {
      if (Math.abs(dx) > Math.abs(dy)) {
        if (Core.setDir(state, dx > 0 ? 1 : -1, 0)) sfx.turn();
        joyArrow.style.transform = `translate(-50%,-50%) rotate(${dx > 0 ? 90 : -90}deg)`;
      } else {
        if (Core.setDir(state, 0, dy > 0 ? 1 : -1)) sfx.turn();
        joyArrow.style.transform = `translate(-50%,-50%) rotate(${dy > 0 ? 180 : 0}deg)`;
      }
      joyArrow.style.opacity = '0.9';
    } else {
      joyArrow.style.opacity = '0';
    }
  }

  joyZone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    joy = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { joyZone.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    showJoystick(e.clientX, e.clientY);
  });

  joyZone.addEventListener('pointermove', (e) => {
    if (!joy || e.pointerId !== joy.id) return;
    moveJoystick(e.clientX - joy.x, e.clientY - joy.y);
  });

  function endJoystick(e) {
    if (!joy || (e.pointerId !== undefined && e.pointerId !== joy.id)) return;
    joy = null;
    joyBase.classList.remove('active');
  }
  joyZone.addEventListener('pointerup', endJoystick);
  joyZone.addEventListener('pointercancel', endJoystick);

  if (isTouch()) {
    joyZone.classList.add('touch-enabled');
  } else {
    joyZone.classList.add('kbd-hint');
  }

  // 其他按钮
  $('btn-start').addEventListener('click', startGame);
  $('btn-again').addEventListener('click', startGame);
  $('btn-mute').addEventListener('click', () => {
    muted = !muted;
    $('btn-mute').textContent = muted ? '🔇' : '🔊';
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) acc = 0;
  });

  fitCanvas();
  requestAnimationFrame((t) => { lastTime = t; loop(t); });
})();
