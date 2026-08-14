/**
 * 贪吃蛇渲染与交互：绝区零「蛇对蛇」霓虹街机风。
 * 深青蓝夜空 + 霓虹网格 + 发光蛇身 + CRT 扫描线；
 * 操控：虚拟模拟摇杆（浮动着点）+ 键盘方向键/WASD。
 * 游戏逻辑全部在 js/snake/core.js。
 */
(function () {
  'use strict';

  const Core = window.SnakeCore;
  const { GRID } = Core;

  // ---------- 尺寸 ----------
  const CELL = 28;
  const SIZE = GRID * CELL; // 672 逻辑像素

  // ---------- 配色（霓虹） ----------
  const NEON = {
    bg0: '#0a0e24', bg1: '#05070f',
    grid: 'rgba(64, 140, 255, 0.10)',
    snakeHead: '#b8fbff',
    snakeA: '#37f3ff',   // 头部亮青
    snakeB: '#2b6fe0',   // 中段蓝
    snakeC: '#9b5de5',   // 尾部紫
    food: '#ff4fd8',     // 魔豆品红
    bonus: '#ffd94f',    // 金豆
    text: '#8ff6ff',
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
  let particles = [];   // {x,y,vx,vy,life,maxLife,color,size}
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

  // ---------- 画布初始化 ----------
  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function cellCenter(c) {
    return { x: c.x * CELL + CELL / 2, y: c.y * CELL + CELL / 2 };
  }

  // ---------- 背景 ----------
  const dust = Array.from({ length: 30 }, (_, i) => ({
    x: (i * 173.3) % SIZE, y: (i * 97.7) % SIZE,
    r: 0.6 + (i % 3) * 0.5, speed: 6 + (i % 5) * 4,
  }));

  function drawBackground(t) {
    const g = ctx.createLinearGradient(0, 0, 0, SIZE);
    g.addColorStop(0, NEON.bg0);
    g.addColorStop(1, NEON.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 漂浮尘埃
    ctx.fillStyle = 'rgba(120,200,255,.16)';
    for (const d of dust) {
      const y = (d.y + t * d.speed / 1000) % SIZE;
      ctx.beginPath();
      ctx.arc(d.x, y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 霓虹网格
    ctx.strokeStyle = NEON.grid;
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(SIZE, i * CELL); ctx.stroke();
    }

    // 四角暗角
    const v = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.35, SIZE / 2, SIZE / 2, SIZE * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  function drawScanlines() {
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < SIZE; y += 4) ctx.fillRect(0, y, SIZE, 1.5);
  }

  // ---------- 食物 ----------
  function drawFood(t) {
    if (state.food) {
      const { x, y } = cellCenter(state.food);
      const pulse = 1 + Math.sin(t / 200) * 0.12;
      const r = CELL * 0.30 * pulse;
      ctx.save();
      ctx.shadowColor = NEON.food;
      ctx.shadowBlur = 18;
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, NEON.food);
      g.addColorStop(1, '#7a1060');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // 脉动光环
      ctx.globalAlpha = 0.5 + Math.sin(t / 200) * 0.3;
      ctx.strokeStyle = NEON.food;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 5 + Math.sin(t / 200) * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (state.bonus) {
      const { x, y } = cellCenter(state.bonus);
      const blink = state.bonus.ttl < 12 ? (Math.sin(t / 80) > 0 ? 1 : 0.25) : 1;
      const r = CELL * 0.34;
      ctx.save();
      ctx.globalAlpha = blink;
      ctx.shadowColor = NEON.bonus;
      ctx.shadowBlur = 22;
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      g.addColorStop(0, '#fffbe0');
      g.addColorStop(0.4, NEON.bonus);
      g.addColorStop(1, '#8a6a10');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // 剩余时间环
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,240,180,.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (state.bonus.ttl / Core.BONUS_TTL));
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- 蛇 ----------
  function bodyColor(i, n) {
    // 头青 → 中蓝 → 尾紫
    const t = n <= 1 ? 0 : i / (n - 1);
    const lerp = (a, b) => Math.round(a + (b - a) * t);
    const c1 = [55, 243, 255], c2 = [43, 111, 224], c3 = [155, 93, 229];
    const m = t < 0.5
      ? [lerp(c1[0], c2[0], t * 2), lerp(c1[1], c2[1], t * 2), lerp(c1[2], c2[2], t * 2)]
      : [lerp(c2[0], c3[0], (t - 0.5) * 2), lerp(c2[1], c3[1], (t - 0.5) * 2), lerp(c2[2], c3[2], (t - 0.5) * 2)];
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  }

  function drawSnake(t) {
    const n = state.snake.length;
    const pts = state.snake.map(cellCenter);

    // 发光身体路径
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = NEON.snakeA;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = 'rgba(55,243,255,.35)';
    ctx.lineWidth = CELL * 0.72;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();

    // 逐节身体（渐变色，向尾部微缩）
    for (let i = n - 1; i >= 1; i--) {
      const p = pts[i];
      const r = CELL * 0.34 * (1 - 0.25 * (i / n));
      ctx.fillStyle = bodyColor(i, n);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 头部
    const head = pts[0];
    const d = state.dir;
    ctx.save();
    ctx.shadowColor = NEON.snakeHead;
    ctx.shadowBlur = 20;
    const hg = ctx.createRadialGradient(head.x - 4, head.y - 4, 2, head.x, head.y, CELL * 0.46);
    hg.addColorStop(0, '#ffffff');
    hg.addColorStop(0.5, NEON.snakeHead);
    hg.addColorStop(1, NEON.snakeA);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(head.x, head.y, CELL * 0.44, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 眼睛（按朝向偏移）
    const ex = d.y !== 0 ? CELL * 0.17 : 0;   // 垂直移动时眼睛横向排布
    const ey = d.x !== 0 ? CELL * 0.17 : 0;
    const fx = d.x * CELL * 0.10, fy = d.y * CELL * 0.10;
    ctx.fillStyle = '#0a1030';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(head.x + fx + ex * s, head.y + fy + ey * s, CELL * 0.075, 0, Math.PI * 2);
      ctx.fill();
    }

    // 偶尔吐信子
    if (Math.sin(t / 600) > 0.92) {
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 2;
      const tx = head.x + d.x * CELL * 0.5, ty = head.y + d.y * CELL * 0.5;
      const px = d.y !== 0 ? 3 : 0, py = d.x !== 0 ? 3 : 0;
      ctx.beginPath();
      ctx.moveTo(head.x + d.x * CELL * 0.36, head.y + d.y * CELL * 0.36);
      ctx.lineTo(tx, ty);
      ctx.moveTo(tx, ty); ctx.lineTo(tx + d.x * 5 - px, ty + d.y * 5 - py);
      ctx.moveTo(tx, ty); ctx.lineTo(tx + d.x * 5 + px, ty + d.y * 5 + py);
      ctx.stroke();
    }
  }

  // ---------- 特效 ----------
  function spawnEatFx(cell, color, score) {
    const { x, y } = cellCenter(cell);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3.5;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, maxLife: 30 + Math.random() * 15,
        color, size: 2 + Math.random() * 3,
      });
    }
    floaters.push({ text: `+${score}`, x, y: y - 8, t: 0, color });
  }

  function drawFx() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life++;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.96; p.vy *= 0.96;
      const a = 1 - p.life / p.maxLife;
      if (a <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.t++;
      const a = 1 - f.t / 50;
      if (a <= 0) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = a;
      ctx.font = 'bold 20px "SF Mono", Consolas, monospace';
      ctx.fillStyle = f.color;
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 10;
      ctx.fillText(f.text, f.x, f.y - f.t * 0.9);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  // ---------- HUD ----------
  function drawHud() {
    ctx.save();
    ctx.font = 'bold 18px "SF Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = NEON.text;
    ctx.shadowColor = NEON.snakeA;
    ctx.shadowBlur = 8;
    ctx.fillText(`SCORE ${state.score}`, 14, 26);
    ctx.textAlign = 'right';
    ctx.fillText(`BEST ${Math.max(best, state.score)}`, SIZE - 14, 26);
    // 速度档
    const spd = Math.floor(state.eaten / 5) + 1;
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.7;
    ctx.fillText(`SPEED ×${spd}`, SIZE / 2, 26);
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
    drawScanlines();
    if (deathFlash > 0) {
      ctx.fillStyle = `rgba(255,40,70,${deathFlash / 20 * 0.35})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      deathFlash--;
    }
    // 霓虹边框
    ctx.strokeStyle = 'rgba(55,243,255,.55)';
    ctx.lineWidth = 2;
    ctx.shadowColor = NEON.snakeA;
    ctx.shadowBlur = 12;
    ctx.strokeRect(1, 1, SIZE - 2, SIZE - 2);
    ctx.restore();
  }

  // ---------- 流程 ----------
  function newGame() {
    state = Core.createGame();
    acc = 0;
    particles = [];
    floaters = [];
    shake = 0;
    deathFlash = 0;
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
    setTimeout(() => {
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
        const ateFood = state.food;
        const ateBonus = state.bonus;
        Core.step(state);
        if (state.snake.length > prevLen) {
          // 吃到了：在刚吃的位置爆粒子（新头位置即原食物位置）
          const gained = state.score - prevScore;
          if (gained === Core.FOOD_SCORE) { spawnEatFx(state.snake[0], NEON.food, gained); sfx.eat(); }
          else { spawnEatFx(state.snake[0], NEON.bonus, gained); sfx.bonus(); }
        }
        void ateFood; void ateBonus;
      }
      if (!state.alive && wasAlive) { wasAlive = false; onDeath(); }
    }
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
  const JOY_RADIUS = 46;   // 摇杆头最大偏移
  const DEAD_ZONE = 12;    // 死区
  let joy = null;

  function isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

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
      // 主轴吸附：模拟手柄十字方向
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

  // 页面切后台自动暂停展示（ snake 无暂停态，直接结束当前回合提示 )
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playing && state.alive) {
      // 不断线重开，仅提示；蛇局无暂停，避免后台死亡：直接冻结 acc
      acc = 0;
    }
  });

  setupCanvas();
  requestAnimationFrame((t) => { lastTime = t; loop(t); });
})();
