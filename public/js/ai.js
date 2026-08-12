/**
 * 五子棋 AI：
 *  - 棋型打分（连五 / 活四 / 冲四 / 活三 …）用于走法排序与贪心策略
 *  - 困难难度使用带 alpha-beta 剪枝的 minimax 搜索
 * 同时被前端页面与 Node 测试脚本引用。
 */
(function (global) {
  'use strict';

  const Core = global.GomokuCore || (typeof require !== 'undefined' ? require('./game.js') : null);
  const { SIZE, EMPTY, BLACK, WHITE, DIRS, inBoard, checkWin } = Core;

  const WIN = 1e7;
  const NEIGHBORHOOD = 2; // 候选点范围：已有棋子周围 2 格

  /** 棋型分值：count 为连子数，open 为两端开放数 */
  function shapeScore(count, open) {
    if (count >= 5) return 1000000;
    if (open === 0) return 0;
    if (count === 4) return open === 2 ? 100000 : 10000;
    if (count === 3) return open === 2 ? 10000 : 1000;
    if (count === 2) return open === 2 ? 1000 : 100;
    return open === 2 ? 100 : 10;
  }

  /** 假设 color 在 (x, y) 落子，计算四个方向的棋型总分 */
  function pointScore(board, x, y, color) {
    let total = 0;
    for (const [dx, dy] of DIRS) {
      let count = 1, open = 0;
      for (let s = 1; ; s++) {
        const nx = x + dx * s, ny = y + dy * s;
        if (!inBoard(nx, ny)) break;
        if (board[ny][nx] === color) count++;
        else { if (board[ny][nx] === EMPTY) open++; break; }
      }
      for (let s = 1; ; s++) {
        const nx = x - dx * s, ny = y - dy * s;
        if (!inBoard(nx, ny)) break;
        if (board[ny][nx] === color) count++;
        else { if (board[ny][nx] === EMPTY) open++; break; }
      }
      total += shapeScore(count, open);
    }
    return total;
  }

  /** 生成候选走法：所有已有棋子 2 格范围内的空点；空棋盘返回天元 */
  function candidates(board) {
    const seen = new Set();
    const out = [];
    let hasStone = false;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[y][x] === EMPTY) continue;
        hasStone = true;
        for (let dy = -NEIGHBORHOOD; dy <= NEIGHBORHOOD; dy++) {
          for (let dx = -NEIGHBORHOOD; dx <= NEIGHBORHOOD; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inBoard(nx, ny) || board[ny][nx] !== EMPTY) continue;
            const key = ny * SIZE + nx;
            if (!seen.has(key)) { seen.add(key); out.push([nx, ny]); }
          }
        }
      }
    }
    return hasStone ? out : [[7, 7]];
  }

  /** 走法排序：进攻分 + 防守分，取前 limit 个 */
  function orderedMoves(board, color, limit) {
    const opp = color === BLACK ? WHITE : BLACK;
    return candidates(board)
      .map(([x, y]) => ({ x, y, s: pointScore(board, x, y, color) + pointScore(board, x, y, opp) * 0.9 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(m => [m.x, m.y]);
  }

  // 整局评估：扫描所有五格窗口，按单方连子数计分
  const WINDOW_SCORE = [0, 2, 25, 220, 4000, 1000000];

  function windowScore(board, x, y, dx, dy, aiColor) {
    let ai = 0, opp = 0;
    for (let i = 0; i < 5; i++) {
      const v = board[y + dy * i][x + dx * i];
      if (v === aiColor) ai++;
      else if (v !== EMPTY) opp++;
    }
    if (ai && opp) return 0;
    if (ai) return WINDOW_SCORE[ai];
    if (opp) return -WINDOW_SCORE[opp] * 1.1; // 略偏重防守
    return 0;
  }

  function evaluate(board, aiColor) {
    let total = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (x + 4 < SIZE) total += windowScore(board, x, y, 1, 0, aiColor);
        if (y + 4 < SIZE) total += windowScore(board, x, y, 0, 1, aiColor);
        if (x + 4 < SIZE && y + 4 < SIZE) total += windowScore(board, x, y, 1, 1, aiColor);
        if (x - 4 >= 0 && y + 4 < SIZE) total += windowScore(board, x, y, -1, 1, aiColor);
      }
    }
    return total;
  }

  /** minimax + alpha-beta，从 aiColor 视角评估 */
  function search(board, depth, alpha, beta, colorToMove, aiColor) {
    if (depth === 0) return evaluate(board, aiColor);
    const moves = orderedMoves(board, colorToMove, 8);
    if (!moves.length) return evaluate(board, aiColor);
    const maxing = colorToMove === aiColor;
    let best = maxing ? -Infinity : Infinity;
    for (const [x, y] of moves) {
      board[y][x] = colorToMove;
      let val;
      if (checkWin(board, x, y)) {
        val = maxing ? WIN - (8 - depth) : -(WIN - (8 - depth)); // 越快赢/越晚输越好
      } else {
        val = search(board, depth - 1, alpha, beta, colorToMove === BLACK ? WHITE : BLACK, aiColor);
      }
      board[y][x] = EMPTY;
      if (maxing) { if (val > best) best = val; if (best > alpha) alpha = best; }
      else { if (val < best) best = val; if (best < beta) beta = best; }
      if (beta <= alpha) break;
    }
    return best;
  }

  function findImmediateWin(board, color, moves) {
    for (const [x, y] of moves) {
      board[y][x] = color;
      const win = checkWin(board, x, y);
      board[y][x] = EMPTY;
      if (win) return [x, y];
    }
    return null;
  }

  /**
   * 计算最佳走法。difficulty: 'easy' | 'medium' | 'hard'
   * 返回 [x, y]
   */
  function findBestMove(board, color, difficulty) {
    const moves = candidates(board);
    if (!moves.length) return [7, 7];
    const opp = color === BLACK ? WHITE : BLACK;

    // 能赢就赢，该堵就堵
    const win = findImmediateWin(board, color, moves);
    if (win) return win;
    const block = findImmediateWin(board, opp, moves);
    if (block) return block;

    if (difficulty === 'easy') {
      // 贪心 + 随机扰动，从前三名里随机挑，棋力较弱
      const scored = moves
        .map(([x, y]) => ({ x, y, s: pointScore(board, x, y, color) + pointScore(board, x, y, opp) * 0.85 + Math.random() * 500 }))
        .sort((a, b) => b.s - a.s);
      const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
      return [pick.x, pick.y];
    }

    const depth = difficulty === 'hard' ? 3 : 1; // 根节点之后搜索的层数
    const top = orderedMoves(board, color, 10);
    let bestVal = -Infinity;
    let best = top[0];
    for (const [x, y] of top) {
      board[y][x] = color;
      const val = checkWin(board, x, y)
        ? WIN
        : search(board, depth, -Infinity, Infinity, opp, color);
      board[y][x] = EMPTY;
      if (val > bestVal) { bestVal = val; best = [x, y]; }
    }
    return best;
  }

  const api = { findBestMove, pointScore, candidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.GomokuAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
