/**
 * 贪吃蛇核心逻辑（纯逻辑，无 DOM/渲染依赖）。
 * UMD 风格导出，同时被浏览器页面与 Node 测试引用。
 *
 * 棋盘：GRID × GRID 方格；撞墙或撞到自己即死。
 * 魔豆 +10 分并变长；每吃 5 颗魔豆出现一颗限时金豆 +30 分。
 * 每吃 5 颗提速一档。
 */
(function (global) {
  'use strict';

  const GRID = 24;
  const BASE_INTERVAL = 150;   // 初始步进间隔 ms
  const MIN_INTERVAL = 70;
  const SPEEDUP_PER = 5;       // 每吃 5 颗提速
  const BONUS_EVERY = 5;       // 每吃 5 颗出金豆
  const BONUS_TTL = 40;        // 金豆存活步数
  const FOOD_SCORE = 10;
  const BONUS_SCORE = 30;

  function createGame(rng) {
    const cx = GRID >> 1, cy = GRID >> 1;
    const state = {
      grid: GRID,
      snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }], // 头在前
      dir: { x: 1, y: 0 },
      pending: null,     // 下一步生效的转向（防止一步内 180° 掉头）
      food: null,
      bonus: null,       // {x, y, ttl}
      score: 0,
      eaten: 0,
      alive: true,
      rng: rng || Math.random,
    };
    spawnFood(state);
    return state;
  }

  function cellEq(a, b) { return a.x === b.x && a.y === b.y; }

  function freeCells(state) {
    const taken = new Set(state.snake.map(c => c.y * GRID + c.x));
    if (state.food) taken.add(state.food.y * GRID + state.food.x);
    if (state.bonus) taken.add(state.bonus.y * GRID + state.bonus.x);
    const out = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (!taken.has(y * GRID + x)) out.push({ x, y });
      }
    }
    return out;
  }

  function spawnFood(state) {
    const cells = freeCells(state);
    state.food = cells.length ? cells[Math.floor(state.rng() * cells.length)] : null;
  }

  function spawnBonus(state) {
    const cells = freeCells(state);
    state.bonus = cells.length
      ? { ...cells[Math.floor(state.rng() * cells.length)], ttl: BONUS_TTL }
      : null;
  }

  /** 转向：禁止相对当前移动方向 180° 掉头 */
  function setDir(state, dx, dy) {
    const cur = state.pending || state.dir;
    if (cur.x === -dx && cur.y === -dy) return false; // 直接掉头，拒绝
    if (cur.x === dx && cur.y === dy) return false;   // 同向，无效
    state.pending = { x: dx, y: dy };
    return true;
  }

  /** 推进一步：移动、吃豆、碰撞判定 */
  function step(state) {
    if (!state.alive) return;
    if (state.pending) {
      state.dir = state.pending;
      state.pending = null;
    }
    const head = { x: state.snake[0].x + state.dir.x, y: state.snake[0].y + state.dir.y };

    // 撞墙
    if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID) {
      state.alive = false;
      return;
    }

    const eatingFood = state.food && cellEq(head, state.food);
    const eatingBonus = state.bonus && cellEq(head, state.bonus);
    const growing = eatingFood || eatingBonus;

    // 撞自己（不吃时尾巴会让出一格）
    const body = growing ? state.snake : state.snake.slice(0, -1);
    if (body.some(c => cellEq(c, head))) {
      state.alive = false;
      return;
    }

    state.snake.unshift(head);
    if (growing) {
      state.score += eatingFood ? FOOD_SCORE : BONUS_SCORE;
      state.eaten++;
      if (eatingFood) {
        spawnFood(state);
        if (state.eaten % BONUS_EVERY === 0 && !state.bonus) spawnBonus(state);
      } else {
        state.bonus = null;
      }
    } else {
      state.snake.pop();
    }

    // 金豆倒计时
    if (state.bonus && --state.bonus.ttl <= 0) state.bonus = null;
  }

  /** 当前步进间隔（随吃豆数提速） */
  function intervalFor(state) {
    return Math.max(MIN_INTERVAL, BASE_INTERVAL - Math.floor(state.eaten / SPEEDUP_PER) * 10);
  }

  const api = {
    GRID, FOOD_SCORE, BONUS_SCORE, BONUS_TTL,
    createGame, setDir, step, intervalFor, freeCells,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SnakeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
