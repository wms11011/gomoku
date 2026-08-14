/** 贪吃蛇核心逻辑单元测试（无框架，直接断言） */
'use strict';

const assert = require('assert');
const S = require('../public/js/snake/core.js');

const { GRID } = S;

// ---- 初始状态 ----
{
  const s = S.createGame(() => 0.5);
  assert.strictEqual(s.snake.length, 3, '初始长度 3');
  assert.deepStrictEqual(s.dir, { x: 1, y: 0 }, '初始向右');
  assert.ok(s.alive && s.food, '初始存活且有食物');
  assert.ok(!s.snake.some(c => c.x === s.food.x && c.y === s.food.y), '食物不在蛇身上');
}

// ---- 正常移动 ----
{
  const s = S.createGame(() => 0.5);
  const [hx, hy] = [s.snake[0].x, s.snake[0].y];
  S.step(s);
  assert.deepStrictEqual(s.snake[0], { x: hx + 1, y: hy }, '前进一步');
  assert.strictEqual(s.snake.length, 3, '没吃到东西长度不变');
}

// ---- 禁止 180° 掉头 ----
{
  const s = S.createGame(() => 0.5);
  assert.strictEqual(S.setDir(s, -1, 0), false, '向右时不能直接左转');
  assert.strictEqual(S.setDir(s, 0, 1), true, '可以向下转');
  S.step(s);
  assert.deepStrictEqual(s.dir, { x: 0, y: 1 });
  assert.strictEqual(S.setDir(s, 0, -1), false, '向下时不能直接向上');
}

// ---- 吃豆成长与计分 ----
{
  const s = S.createGame(() => 0.5);
  // 把食物放到蛇头正前方
  s.food = { x: s.snake[0].x + 1, y: s.snake[0].y };
  S.step(s);
  assert.strictEqual(s.snake.length, 4, '吃到食物长度 +1');
  assert.strictEqual(s.score, 10, '魔豆 +10 分');
  assert.strictEqual(s.eaten, 1);
  assert.ok(s.food, '吃完会刷新新食物');
  assert.ok(!s.snake.some(c => c.x === s.food.x && c.y === s.food.y), '新食物不在蛇身上');
}

// ---- 金豆：每 5 颗出现，+30 分 ----
{
  const s = S.createGame(() => 0.5);
  s.eaten = 4;
  s.food = { x: s.snake[0].x + 1, y: s.snake[0].y };
  S.step(s);
  assert.ok(s.bonus, '第 5 颗后出现金豆');
  // 直接吃金豆
  s.bonus = { x: s.snake[0].x + 1, y: s.snake[0].y, ttl: 40 };
  const before = s.score;
  S.step(s);
  assert.strictEqual(s.score - before, 30, '金豆 +30 分');
  assert.strictEqual(s.bonus, null, '金豆被吃后消失');
}

// ---- 金豆超时消失 ----
{
  const s = S.createGame(() => 0.5);
  s.bonus = { x: 0, y: 0, ttl: 1 };
  S.step(s);
  assert.strictEqual(s.bonus, null, '金豆超时消失');
}

// ---- 撞墙 ----
{
  const s = S.createGame(() => 0.5);
  s.snake = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }];
  S.setDir(s, -1, 0);
  // pending 会被初始 dir 拒绝？初始 dir 向右，setDir(-1,0) 被拒——手动设置
  s.dir = { x: -1, y: 0 };
  s.pending = null;
  S.step(s);
  assert.strictEqual(s.alive, false, '撞墙死亡');
}

// ---- 撞自己 ----
{
  const s = S.createGame(() => 0.5);
  // U 形：头 (5,5)，向下撞到身体 (5,6)
  s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];
  s.dir = { x: 0, y: 1 };
  s.pending = null;
  S.step(s);
  assert.strictEqual(s.alive, false, '撞到身体死亡');
}

// ---- 追尾合法（尾巴会让位） ----
{
  const s = S.createGame(() => 0.5);
  // 头 (5,5)，向右走到尾巴 (6,5) 当前位置——尾巴同一步让出，合法
  s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];
  s.dir = { x: 1, y: 0 };
  s.pending = null;
  s.food = { x: GRID - 1, y: GRID - 1 };
  S.step(s);
  assert.strictEqual(s.alive, true, '追尾巴位置合法');
}

// ---- 提速 ----
{
  const s = S.createGame(() => 0.5);
  const i0 = S.intervalFor(s);
  s.eaten = 10;
  assert.ok(S.intervalFor(s) < i0, '吃 10 颗后应提速');
  s.eaten = 1000;
  assert.strictEqual(S.intervalFor(s), 70, '速度有下限 70ms');
}

// ---- 棋盘几乎占满时食物不落蛇身 ----
{
  const s = S.createGame(() => 0.0);
  s.snake = [];
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID - 1; x++) s.snake.push({ x, y });
  const cells = S.freeCells(s);
  assert.strictEqual(cells.length, GRID, '只剩一列空格');
  assert.ok(cells.every(c => c.x === GRID - 1));
}

console.log('✔ 贪吃蛇核心逻辑测试全部通过');
