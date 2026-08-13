/**
 * 俄罗斯方块核心逻辑（纯逻辑，无 DOM/渲染依赖）。
 * UMD 风格导出，同时被浏览器页面与 Node 测试引用。
 *
 * 棋盘：10 列 × 22 行（顶部 2 行为隐藏缓冲区，可见 20 行）。
 * 单元格值：0 空，1-7 方块颜色（I O T S Z J L）。
 */
(function (global) {
  'use strict';

  const COLS = 10;
  const ROWS = 20;
  const HIDDEN = 2;
  const TOTAL = ROWS + HIDDEN;
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[2, 2], [2, 2]],
    T: [[0, 3, 0], [3, 3, 3], [0, 0, 0]],
    S: [[0, 4, 4], [4, 4, 0], [0, 0, 0]],
    Z: [[5, 5, 0], [0, 5, 5], [0, 0, 0]],
    J: [[6, 0, 0], [6, 6, 6], [0, 0, 0]],
    L: [[0, 0, 7], [7, 7, 7], [0, 0, 0]],
  };

  // 消行基础分（× 等级）
  const CLEAR_POINTS = [0, 100, 300, 500, 800];
  // 旋转墙踢候选偏移
  const KICKS = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1]];

  function rotateCW(m) {
    const n = m.length;
    const out = m.map(r => r.slice());
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) out[x][n - 1 - y] = m[y][x];
    }
    return out;
  }

  // 预计算各方块 4 个旋转态
  const ROTS = {};
  for (const t of TYPES) {
    ROTS[t] = [SHAPES[t].map(r => r.slice())];
    for (let i = 1; i < 4; i++) ROTS[t].push(rotateCW(ROTS[t][i - 1]));
  }

  function matrixOf(piece) {
    return ROTS[piece.type][piece.rot];
  }

  /** 返回矩阵在 (px, py) 处的占据格 [[x, y, colorId], ...] */
  function cellsOf(matrix, px, py) {
    const out = [];
    for (let y = 0; y < matrix.length; y++) {
      for (let x = 0; x < matrix[y].length; x++) {
        if (matrix[y][x]) out.push([px + x, py + y, matrix[y][x]]);
      }
    }
    return out;
  }

  function collides(board, matrix, px, py) {
    for (const [x, y] of cellsOf(matrix, px, py)) {
      if (x < 0 || x >= COLS || y >= TOTAL) return true;
      if (y >= 0 && board[y][x]) return true;
    }
    return false;
  }

  function createBoard() {
    return Array.from({ length: TOTAL }, () => new Array(COLS).fill(0));
  }

  /** 7-bag 发牌：每轮 7 种各一个，打乱顺序 */
  function refillQueue(state) {
    while (state.queue.length < 5) {
      const bag = TYPES.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(state.rng() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      state.queue.push(...bag);
    }
  }

  function spawn(state) {
    refillQueue(state);
    const piece = { type: state.queue.shift(), rot: 0, x: 3, y: 0 };
    state.current = piece;
    if (collides(state.board, matrixOf(piece), piece.x, piece.y)) {
      state.gameOver = true; // 出生点被堵死 → 输
    }
  }

  function createGame(rng) {
    const state = {
      board: createBoard(),
      current: null,
      queue: [],
      hold: null,
      canHold: true,
      score: 0,
      lines: 0,
      level: 1,
      combo: -1,
      gameOver: false,
      lastClear: null,   // 最近一次消行信息（渲染层读取做特效）
      gravAcc: 0,
      rng: rng || Math.random,
    };
    refillQueue(state);
    spawn(state);
    return state;
  }

  function move(state, dx) {
    if (state.gameOver) return false;
    const p = state.current;
    if (collides(state.board, matrixOf(p), p.x + dx, p.y)) return false;
    p.x += dx;
    return true;
  }

  function rotate(state, dir = 1) {
    if (state.gameOver) return false;
    const p = state.current;
    if (p.type === 'O') return true; // 方块无需旋转
    const newRot = (p.rot + (dir > 0 ? 1 : 3)) % 4;
    for (const [kx, ky] of KICKS) {
      if (!collides(state.board, ROTS[p.type][newRot], p.x + kx, p.y + ky)) {
        p.rot = newRot;
        p.x += kx;
        p.y += ky;
        return true;
      }
    }
    return false;
  }

  /** 幽灵落点：当前方块直落到底时的 y */
  function ghostY(state) {
    const p = state.current;
    let y = p.y;
    while (!collides(state.board, matrixOf(p), p.x, y + 1)) y++;
    return y;
  }

  /** 软降一格；到底则锁定。返回 'moved' | 'locked' */
  function softDrop(state) {
    if (state.gameOver) return 'locked';
    const p = state.current;
    if (!collides(state.board, matrixOf(p), p.x, p.y + 1)) {
      p.y++;
      state.score += 1;
      state.gravAcc = 0;
      return 'moved';
    }
    lock(state);
    return 'locked';
  }

  /** 硬降到底并锁定。返回下落格数 */
  function hardDrop(state) {
    if (state.gameOver) return 0;
    const p = state.current;
    let d = 0;
    while (!collides(state.board, matrixOf(p), p.x, p.y + 1)) { p.y++; d++; }
    state.score += 2 * d;
    lock(state);
    return d;
  }

  /** 暂存/交换，每个回合（锁块前）只能用一次 */
  function holdPiece(state) {
    if (state.gameOver || !state.canHold) return false;
    const cur = state.current.type;
    if (state.hold) {
      const next = state.hold;
      state.hold = cur;
      state.current = { type: next, rot: 0, x: 3, y: 0 };
      if (collides(state.board, matrixOf(state.current), 3, 0)) state.gameOver = true;
    } else {
      state.hold = cur;
      spawn(state);
    }
    state.canHold = false;
    state.gravAcc = 0;
    return true;
  }

  /** 锁定当前方块：写入棋盘 → 消行 → 计分升级 → 出下一块 */
  function lock(state) {
    const p = state.current;
    let topOut = false;
    for (const [x, y, id] of cellsOf(matrixOf(p), p.x, p.y)) {
      if (y < HIDDEN) topOut = true;
      if (y >= 0) state.board[y][x] = id;
    }

    // 消行
    const fullRows = [];
    for (let r = 0; r < TOTAL; r++) {
      if (state.board[r].every(c => c)) fullRows.push(r);
    }
    let points = 0;
    let levelUp = false;
    if (fullRows.length) {
      const remaining = state.board.filter(row => !row.every(c => c));
      while (remaining.length < TOTAL) remaining.unshift(new Array(COLS).fill(0));
      state.board = remaining;

      state.combo++;
      points = CLEAR_POINTS[fullRows.length] * state.level;
      if (state.combo > 0) points += 50 * state.combo * state.level; // 连击加成
      state.score += points;
      state.lines += fullRows.length;
      const newLevel = 1 + Math.floor(state.lines / 10);
      levelUp = newLevel > state.level;
      state.level = newLevel;
    } else {
      state.combo = -1;
    }
    state.lastClear = { rows: fullRows, count: fullRows.length, points, combo: state.combo, levelUp };

    if (topOut) {
      state.gameOver = true;
      return;
    }
    state.canHold = true;
    state.gravAcc = 0;
    spawn(state);
  }

  /** 重力推进：按当前等级速度下落，落不动即锁定 */
  function tick(state, ms) {
    if (state.gameOver) return false;
    state.gravAcc += ms;
    const interval = speedForLevel(state.level);
    let fell = false;
    while (state.gravAcc >= interval && !state.gameOver) {
      state.gravAcc -= interval;
      const p = state.current;
      if (!collides(state.board, matrixOf(p), p.x, p.y + 1)) {
        p.y++;
        fell = true;
      } else {
        lock(state);
      }
    }
    return fell;
  }

  function speedForLevel(level) {
    return Math.max(60, 800 - (level - 1) * 75);
  }

  const api = {
    COLS, ROWS, HIDDEN, TOTAL, TYPES,
    matrixOf, cellsOf, collides, createGame,
    move, rotate, softDrop, hardDrop, holdPiece, tick, ghostY, speedForLevel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TetrisCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
