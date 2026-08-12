/** 核心规则与 AI 的单元测试（无框架，直接断言） */
'use strict';

const assert = require('assert');
const Core = require('../public/js/game.js');
const AI = require('../public/js/ai.js');

const { SIZE, BLACK, WHITE } = Core;

function placeRow(board, y, x0, n, color) {
  for (let i = 0; i < n; i++) board[y][x0 + i] = color;
}

// ---- 胜负判定 ----
{
  const b = Core.createBoard();
  placeRow(b, 7, 3, 5, BLACK); // 横向五连
  assert.ok(Core.checkWin(b, 7, 7), '应检测出横向五连');
}
{
  const b = Core.createBoard();
  for (let i = 0; i < 5; i++) b[2 + i][2 + i] = WHITE; // 斜向五连
  const line = Core.checkWin(b, 6, 6);
  assert.ok(line && line.length === 5, '应检测出斜向五连');
}
{
  const b = Core.createBoard();
  placeRow(b, 7, 3, 4, BLACK); // 只有四连
  assert.strictEqual(Core.checkWin(b, 6, 7), null, '四连不应判胜');
}
{
  const b = Core.createBoard();
  b[5][5] = BLACK; b[5][6] = WHITE; // 不同色不相连
  assert.strictEqual(Core.checkWin(b, 5, 5), null);
}

// ---- AI：能赢就赢 ----
for (const diff of ['easy', 'medium', 'hard']) {
  const b = Core.createBoard();
  placeRow(b, 7, 3, 4, BLACK);      // AI(黑) 已有四连
  b[3][3] = WHITE; b[4][4] = WHITE; // 一些干扰
  const [x, y] = AI.findBestMove(b, BLACK, diff);
  assert.strictEqual(y, 7, `${diff}: AI 应落在第 7 行完成五连`);
  assert.ok(x === 2 || x === 7, `${diff}: AI 应补在两端完成五连，实际 (${x},${y})`);
}

// ---- AI：该堵就堵 ----
for (const diff of ['easy', 'medium', 'hard']) {
  const b = Core.createBoard();
  placeRow(b, 5, 4, 4, WHITE);      // 对手(白) 活四，必须堵
  b[9][9] = BLACK; b[10][10] = BLACK;
  const [x, y] = AI.findBestMove(b, BLACK, diff);
  assert.strictEqual(y, 5, `${diff}: AI 应在第 5 行堵截`);
  assert.ok(x === 3 || x === 8, `${diff}: AI 应堵在两端，实际 (${x},${y})`);
}

// ---- AI：困难模式在复杂局面下返回合法走法且耗时可接受 ----
{
  const b = Core.createBoard();
  // 构造一个中盘局面
  const stones = [
    [7, 7, BLACK], [7, 8, WHITE], [8, 7, BLACK], [8, 8, WHITE],
    [6, 6, BLACK], [9, 9, WHITE], [6, 8, BLACK], [9, 7, WHITE],
    [5, 7, BLACK], [10, 6, WHITE],
  ];
  for (const [x, y, c] of stones) b[y][x] = c;
  const t0 = Date.now();
  const [x, y] = AI.findBestMove(b, BLACK, 'hard');
  const elapsed = Date.now() - t0;
  assert.ok(Core.inBoard(x, y) && b[y][x] === 0, `困难模式应返回合法空点，实际 (${x},${y})`);
  assert.ok(elapsed < 5000, `困难模式耗时应小于 5 秒，实际 ${elapsed}ms`);
  console.log(`  困难模式单步耗时 ${elapsed}ms，落子 (${x},${y})`);
}

// ---- AI：空棋盘走天元 ----
{
  const b = Core.createBoard();
  const [x, y] = AI.findBestMove(b, BLACK, 'hard');
  assert.ok(x === 7 && y === 7, '空棋盘应落天元');
}

console.log('✔ 核心规则与 AI 测试全部通过');
