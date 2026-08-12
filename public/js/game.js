/**
 * 五子棋核心规则：棋盘、落子、胜负判定。
 * 同时被前端页面与 Node 服务器引用（UMD 风格导出）。
 */
(function (global) {
  'use strict';

  const SIZE = 15;               // 15×15 标准棋盘
  const EMPTY = 0;
  const BLACK = 1;               // 黑棋先手
  const WHITE = 2;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]; // 横、竖、正斜、反斜

  function createBoard() {
    return Array.from({ length: SIZE }, () => new Array(SIZE).fill(EMPTY));
  }

  function inBoard(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  /**
   * 判断 (x, y) 处刚落下的子是否形成五连。
   * 是则返回五连（或长连）的坐标数组，否则返回 null。
   */
  function checkWin(board, x, y) {
    const color = board[y] && board[y][x];
    if (!color) return null;
    for (const [dx, dy] of DIRS) {
      const line = [[x, y]];
      for (let s = 1; ; s++) {
        const nx = x + dx * s, ny = y + dy * s;
        if (inBoard(nx, ny) && board[ny][nx] === color) line.push([nx, ny]);
        else break;
      }
      for (let s = 1; ; s++) {
        const nx = x - dx * s, ny = y - dy * s;
        if (inBoard(nx, ny) && board[ny][nx] === color) line.unshift([nx, ny]);
        else break;
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  function isFull(board) {
    return board.every(row => row.every(cell => cell !== EMPTY));
  }

  function opponent(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  const api = { SIZE, EMPTY, BLACK, WHITE, DIRS, createBoard, inBoard, checkWin, isFull, opponent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.GomokuCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
