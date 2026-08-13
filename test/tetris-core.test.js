/** 俄罗斯方块核心逻辑单元测试（无框架，直接断言） */
'use strict';

const assert = require('assert');
const T = require('../public/js/tetris/core.js');

const { COLS, ROWS, HIDDEN, TOTAL } = T;

function freshState() {
  // 固定随机序列，结果可复现
  return T.createGame(() => 0.42);
}

function emptyBoard() {
  return Array.from({ length: TOTAL }, () => new Array(COLS).fill(0));
}

function fillRows(state, rows, exceptCols = []) {
  for (const r of rows) {
    for (let x = 0; x < COLS; x++) {
      if (!exceptCols.includes(x)) state.board[r][x] = 9; // 9 仅为占位色
    }
  }
}

// ---- 7-bag 发牌：前 7 个为 7 种方块各一 ----
{
  const s = freshState();
  const first7 = [s.current.type, ...s.queue.slice(0, 6)].sort();
  assert.deepStrictEqual(first7, ['I', 'J', 'L', 'O', 'S', 'T', 'Z'], '7-bag 每轮应含 7 种各一个');
}

// ---- 移动边界 ----
{
  const s = freshState();
  s.current = { type: 'I', rot: 0, x: 0, y: 5 };
  assert.strictEqual(T.move(s, -1), false, '贴左墙不能再左移');
  assert.strictEqual(T.move(s, 1), true);
  s.current.x = 6;
  assert.strictEqual(T.move(s, 1), false, 'I 横放 x=6 已贴右墙');
}

// ---- 旋转 + 墙踢 ----
{
  const s = freshState();
  s.current = { type: 'I', rot: 0, x: 0, y: 5 };
  assert.strictEqual(T.rotate(s, 1), true, '贴墙应能通过墙踢旋转');
  assert.strictEqual(s.current.rot, 1);
  // O 旋转不改变
  s.current = { type: 'O', rot: 0, x: 4, y: 5 };
  assert.strictEqual(T.rotate(s, 1), true);
  assert.strictEqual(s.current.rot, 0);
}

// ---- 单行消除 ----
{
  const s = freshState();
  s.board = emptyBoard();
  fillRows(s, [TOTAL - 1], [0, 1, 2, 3]); // 底行缺左 4 格
  s.current = { type: 'I', rot: 0, x: 0, y: 0 };
  T.hardDrop(s); // I 横落补齐底行
  assert.strictEqual(s.lines, 1, '应消 1 行');
  assert.strictEqual(s.score, 100 + 2 * 0 + 2 * (TOTAL - 2), '分数 = 100×1 + 硬降分');
  assert.ok(s.board[TOTAL - 1].every(c => c === 0), '消行后底行为空');
  assert.strictEqual(s.board.length, TOTAL, '棋盘行数不变');
}

// ---- 四行消除（Tetris） ----
{
  const s = freshState();
  s.board = emptyBoard();
  fillRows(s, [TOTAL - 4, TOTAL - 3, TOTAL - 2, TOTAL - 1], [3]); // 底 4 行缺第 3 列
  s.current = { type: 'I', rot: 1, x: 1, y: 0 }; // 竖 I 占第 3 列
  const drop = T.hardDrop(s);
  assert.strictEqual(s.lines, 4, '应消 4 行');
  assert.strictEqual(s.lastClear.count, 4);
  assert.strictEqual(s.lastClear.points, 800, 'Tetris = 800×1');
  assert.ok(drop > 0);
}

// ---- Combo 加成 ----
{
  const s = freshState();
  s.board = emptyBoard();
  // 第一次消行
  fillRows(s, [TOTAL - 1], [0, 1, 2, 3]);
  s.current = { type: 'I', rot: 0, x: 0, y: 0 };
  T.hardDrop(s);
  assert.strictEqual(s.combo, 0, '首次消行 combo=0');
  // 第二次消行
  fillRows(s, [TOTAL - 1], [0, 1, 2, 3]);
  s.current = { type: 'I', rot: 0, x: 0, y: 0 };
  T.hardDrop(s);
  assert.strictEqual(s.combo, 1, '连续消行 combo=1');
  assert.strictEqual(s.lastClear.points, 100 + 50 * 1 * 1, '第二次消行含 combo 加成');
}

// ---- 升级与加速 ----
{
  const s = freshState();
  s.board = emptyBoard();
  s.lines = 9;
  fillRows(s, [TOTAL - 1], [0, 1, 2, 3]);
  s.current = { type: 'I', rot: 0, x: 0, y: 0 };
  T.hardDrop(s);
  assert.strictEqual(s.level, 2, '满 10 行升 2 级');
  assert.strictEqual(s.lastClear.levelUp, true);
  assert.ok(T.speedForLevel(2) < T.speedForLevel(1), '升级后应更快');
}

// ---- Hold 暂存 ----
{
  const s = freshState();
  const first = s.current.type;
  assert.strictEqual(T.holdPiece(s), true);
  assert.strictEqual(s.hold, first, '暂存的应是第一个方块');
  assert.strictEqual(T.holdPiece(s), false, '一回合只能暂存一次');
}

// ---- 幽灵落点 ----
{
  const s = freshState();
  s.board = emptyBoard();
  s.current = { type: 'O', rot: 0, x: 4, y: 0 };
  assert.strictEqual(T.ghostY(s), TOTAL - 2, 'O 直落到 y=TOTAL-2');
}

// ---- 重力 tick 与落地锁定 ----
{
  const s = freshState();
  s.board = emptyBoard();
  s.current = { type: 'O', rot: 0, x: 4, y: 0 };
  T.tick(s, T.speedForLevel(1));
  assert.strictEqual(s.current.y, 1, '一个间隔落一格');
  s.current.y = TOTAL - 3;
  T.tick(s, T.speedForLevel(1)); // 落到底
  const type = s.current.type;
  T.tick(s, T.speedForLevel(1)); // 再一格 → 锁定
  assert.ok(s.board[TOTAL - 1][4] !== 0 || s.board[TOTAL - 1][5] !== 0, '落地后应锁定写入棋盘');
}

// ---- 顶部堆满判负 ----
{
  const s = freshState();
  s.board = emptyBoard();
  for (const r of [0, 1]) for (let x = 3; x <= 6; x++) s.board[r][x] = 9; // 堵死出生区
  s.current = { type: 'O', rot: 0, x: 4, y: 0 };
  s.current.y = TOTAL - 2;
  T.hardDrop(s); // 锁定后新块出生即碰撞
  assert.strictEqual(s.gameOver, true, '出生区堵死应判负');
}

console.log('✔ 俄罗斯方块核心逻辑测试全部通过');
