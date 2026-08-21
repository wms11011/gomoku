/**
 * 迷你世界（类 Minecraft 体素沙盒）核心逻辑（纯逻辑，无 DOM/渲染依赖）。
 * UMD 风格导出，同时被浏览器页面与 Node 测试引用。
 *
 * 世界：SIZE_X × SIZE_Y × SIZE_Z 的方块阵列，按 16×16 列划分区块。
 * 地形由种子化值噪声生成（山丘 / 湖泊 / 沙滩 / 树 / 煤矿石），同一种子结果完全一致。
 * buildChunkGeometry 负责「只生成暴露面」的网格数据，渲染层只管上传 GPU。
 * raycast 为体素 DDA 拾取（挖方块 / 放方块共用）。
 * 另含生存玩法规则：背包、合成配方、挖掘硬度/工具/掉落、攻击伤害、昼夜状态、刷怪选址。
 * 存档：RLE + base64 字符串，localStorage 友好。
 */
(function (global) {
  'use strict';

  const SIZE_X = 96, SIZE_Y = 64, SIZE_Z = 96;
  const CHUNK = 16;
  const CHUNKS_X = SIZE_X / CHUNK, CHUNKS_Z = SIZE_Z / CHUNK;
  const WATER_LEVEL = 11;

  // 方块 id
  const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, SAND = 4,
    WATER = 5, LOG = 6, LEAVES = 7, BEDROCK = 8, COBBLE = 9, PLANKS = 10,
    COAL_ORE = 11, TORCH = 12;

  // 物品 id（非方块，从 100 起，与方块 id 区分）
  const STICK = 100, COAL = 101, WOOD_PICK = 102, STONE_PICK = 103,
    WOOD_SWORD = 104, STONE_SWORD = 105, MEAT = 106;

  // 贴图图集瓦片 id（4×4 图集，渲染层按同一约定生成贴图）
  const TILE = {
    GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5,
    LOG_SIDE: 6, LOG_TOP: 7, LEAVES: 8, BEDROCK: 9, COBBLE: 10, PLANKS: 11,
    COAL_ORE: 12, TORCH: 13,
  };

  /** 方块表：name 用于快捷栏；tiles={top,side,bottom}；opaque=false 的面不遮挡相邻方块 */
  const BLOCKS = [];
  BLOCKS[AIR] = { name: '空气', tiles: null, opaque: false };
  BLOCKS[GRASS] = { name: '草方块', tiles: { top: TILE.GRASS_TOP, side: TILE.GRASS_SIDE, bottom: TILE.DIRT }, opaque: true };
  BLOCKS[DIRT] = { name: '泥土', tiles: { top: TILE.DIRT, side: TILE.DIRT, bottom: TILE.DIRT }, opaque: true };
  BLOCKS[STONE] = { name: '石头', tiles: { top: TILE.STONE, side: TILE.STONE, bottom: TILE.STONE }, opaque: true };
  BLOCKS[SAND] = { name: '沙子', tiles: { top: TILE.SAND, side: TILE.SAND, bottom: TILE.SAND }, opaque: true };
  BLOCKS[WATER] = { name: '水', tiles: { top: TILE.WATER, side: TILE.WATER, bottom: TILE.WATER }, opaque: false };
  BLOCKS[LOG] = { name: '木头', tiles: { top: TILE.LOG_TOP, side: TILE.LOG_SIDE, bottom: TILE.LOG_TOP }, opaque: true };
  BLOCKS[LEAVES] = { name: '树叶', tiles: { top: TILE.LEAVES, side: TILE.LEAVES, bottom: TILE.LEAVES }, opaque: true };
  BLOCKS[BEDROCK] = { name: '基岩', tiles: { top: TILE.BEDROCK, side: TILE.BEDROCK, bottom: TILE.BEDROCK }, opaque: true };
  BLOCKS[COBBLE] = { name: '圆石', tiles: { top: TILE.COBBLE, side: TILE.COBBLE, bottom: TILE.COBBLE }, opaque: true };
  BLOCKS[PLANKS] = { name: '木板', tiles: { top: TILE.PLANKS, side: TILE.PLANKS, bottom: TILE.PLANKS }, opaque: true };
  BLOCKS[COAL_ORE] = { name: '煤矿石', tiles: { top: TILE.COAL_ORE, side: TILE.COAL_ORE, bottom: TILE.COAL_ORE }, opaque: true };
  BLOCKS[TORCH] = { name: '火把', tiles: { top: TILE.TORCH, side: TILE.TORCH, bottom: TILE.TORCH }, opaque: true };

  /** 物品表：tool=工具类型，power=镐子等级，atk=攻击伤害，heal=食用回血（半心） */
  const ITEMS = {};
  ITEMS[STICK] = { name: '木棍' };
  ITEMS[COAL] = { name: '煤炭' };
  ITEMS[WOOD_PICK] = { name: '木镐', tool: 'pick', power: 1, atk: 2 };
  ITEMS[STONE_PICK] = { name: '石镐', tool: 'pick', power: 2, atk: 3 };
  ITEMS[WOOD_SWORD] = { name: '木剑', tool: 'sword', atk: 4 };
  ITEMS[STONE_SWORD] = { name: '石剑', tool: 'sword', atk: 5 };
  ITEMS[MEAT] = { name: '肉', heal: 4 };

  function isItem(id) { return id >= 100; }
  function nameOf(id) { return isItem(id) ? ITEMS[id].name : BLOCKS[id].name; }

  function isOpaque(id) { return id !== AIR && !isItem(id) && BLOCKS[id].opaque; }

  // ---------- 挖掘硬度 / 工具 / 掉落 ----------

  /** 徒手挖掘耗时（秒）；基岩不可破坏 */
  const HARDNESS = {};
  HARDNESS[GRASS] = 0.6; HARDNESS[DIRT] = 0.6; HARDNESS[SAND] = 0.6;
  HARDNESS[LEAVES] = 0.2; HARDNESS[LOG] = 1.4; HARDNESS[PLANKS] = 1.2;
  HARDNESS[STONE] = 3; HARDNESS[COBBLE] = 3; HARDNESS[COAL_ORE] = 3.5;
  HARDNESS[TORCH] = 0.1; HARDNESS[BEDROCK] = Infinity;

  function isStoneType(id) { return id === STONE || id === COBBLE || id === COAL_ORE; }

  /** 用指定工具（物品 id 或 0=徒手）挖某方块需要几秒 */
  function digSeconds(id, toolId) {
    const h = HARDNESS[id];
    if (h === undefined) return 1;
    if (!isFinite(h)) return Infinity;
    const tool = ITEMS[toolId];
    if (tool && tool.tool === 'pick' && isStoneType(id)) return h / (tool.power === 2 ? 6 : 3);
    return h;
  }

  /** 破坏方块的掉落物 id（0 = 无掉落）。石头类必须用镐才掉 */
  function dropFor(id, toolId) {
    const hasPick = !!(ITEMS[toolId] && ITEMS[toolId].tool === 'pick');
    if (id === GRASS) return DIRT;
    if (id === STONE) return hasPick ? COBBLE : 0;
    if (id === COAL_ORE) return hasPick ? COAL : 0;
    if (id === LEAVES) return 0;
    return id;
  }

  /** 近战攻击伤害（半心） */
  function attackDamage(toolId) {
    const tool = ITEMS[toolId];
    if (tool && tool.atk) return tool.atk;
    return 2;
  }

  // ---------- 背包与合成 ----------

  const INV_SIZE = 32;      // 0..7 为快捷栏，8..31 为背包
  const HOTBAR_SIZE = 8;
  const STACK_MAX = 99;

  function createInventory() { return new Array(INV_SIZE).fill(null); }

  /** 放入物品：优先叠加已有堆（快捷栏优先），再放空格。返回放不下的剩余数量 */
  function addItem(inv, id, n) {
    if (n === undefined) n = 1;
    for (let pass = 0; pass < 2 && n > 0; pass++) {
      for (let i = 0; i < inv.length && n > 0; i++) {
        const s = inv[i];
        if (pass === 0) {
          if (s && s.id === id && s.n < STACK_MAX) {
            const take = Math.min(STACK_MAX - s.n, n);
            s.n += take; n -= take;
          }
        } else if (!s) {
          const take = Math.min(STACK_MAX, n);
          inv[i] = { id, n: take }; n -= take;
        }
      }
    }
    return n;
  }

  /** 从背包扣除某种物品（合成用），不足则不动并返回 false */
  function removeItems(inv, id, n) {
    if (countItem(inv, id) < n) return false;
    for (let i = 0; i < inv.length && n > 0; i++) {
      const s = inv[i];
      if (s && s.id === id) {
        const take = Math.min(s.n, n);
        s.n -= take; n -= take;
        if (s.n <= 0) inv[i] = null;
      }
    }
    return true;
  }

  function countItem(inv, id) {
    let n = 0;
    for (const s of inv) if (s && s.id === id) n += s.n;
    return n;
  }

  /** 交换两格；同类物品则合并堆叠 */
  function swapSlots(inv, a, b) {
    const sa = inv[a], sb = inv[b];
    if (sa && sb && sa.id === sb.id) {
      const take = Math.min(STACK_MAX - sb.n, sa.n);
      sb.n += take; sa.n -= take;
      if (sa.n <= 0) inv[a] = null;
      return;
    }
    inv[a] = sb; inv[b] = sa;
  }

  /**
   * 配方表（无序配方：材料够就能合成）：
   * needs 为 {物品id: 数量}
   */
  const RECIPES = [
    { out: { id: PLANKS, n: 4 }, needs: { [LOG]: 1 } },
    { out: { id: STICK, n: 4 }, needs: { [PLANKS]: 2 } },
    { out: { id: WOOD_PICK, n: 1 }, needs: { [PLANKS]: 3, [STICK]: 2 } },
    { out: { id: STONE_PICK, n: 1 }, needs: { [COBBLE]: 3, [STICK]: 2 } },
    { out: { id: WOOD_SWORD, n: 1 }, needs: { [PLANKS]: 2, [STICK]: 1 } },
    { out: { id: STONE_SWORD, n: 1 }, needs: { [COBBLE]: 2, [STICK]: 1 } },
    { out: { id: TORCH, n: 4 }, needs: { [STICK]: 1, [COAL]: 1 } },
  ];

  function canCraft(inv, recipe) {
    return Object.keys(recipe.needs).every((id) => countItem(inv, Number(id)) >= recipe.needs[id]);
  }

  /** 合成：扣材料、放产物；材料不足或背包放不下返回 false */
  function craft(inv, recipe) {
    if (!canCraft(inv, recipe)) return false;
    for (const id of Object.keys(recipe.needs)) removeItems(inv, Number(id), recipe.needs[id]);
    const left = addItem(inv, recipe.out.id, recipe.out.n);
    if (left > 0) return 'full'; // 材料已扣但产物放不下（极端情况），调用方提示
    return true;
  }

  // ---------- 昼夜 ----------

  const DAY_TICKS = 24000; // 一整天 ticks；t=0 日出，6000 正午，12000 日落，18000 午夜

  /** 昼夜状态：dayFactor 0=深夜 1=正午；night=true 适合刷怪 */
  function skyState(t) {
    const ang = ((t % DAY_TICKS) + DAY_TICKS) % DAY_TICKS / DAY_TICKS * Math.PI * 2;
    const sunH = Math.sin(ang);
    const day = Math.max(0, Math.min(1, (sunH + 0.12) / 0.24));
    return { angle: ang, sunHeight: sunH, dayFactor: day, night: day < 0.3 };
  }

  // ---------- 确定性随机与地形噪声 ----------

  /** 坐标哈希 → [0,1)，纯函数无状态 */
  function hash2(seed, x, z) {
    let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  function valueNoise(seed, x, z) {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const a = hash2(seed, xi, zi), b = hash2(seed, xi + 1, zi);
    const c = hash2(seed, xi, zi + 1), d = hash2(seed, xi + 1, zi + 1);
    const u = smooth(xf), v = smooth(zf);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  function fbm(seed, x, z, octaves) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += valueNoise(seed + i * 1013, x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  /** 某列的地表高度（不含水面） */
  function heightAt(seed, x, z) {
    const n = fbm(seed, x / 46, z / 46, 4);
    return Math.max(3, Math.min(SIZE_Y - 20, Math.floor(4 + n * n * 34)));
  }

  // ---------- 世界数据 ----------

  function index(x, y, z) { return (y * SIZE_Z + z) * SIZE_X + x; }
  function inBounds(x, y, z) { return x >= 0 && x < SIZE_X && y >= 0 && y < SIZE_Y && z >= 0 && z < SIZE_Z; }

  function createWorld(seed) {
    const world = { seed: seed | 0, data: new Uint8Array(SIZE_X * SIZE_Y * SIZE_Z) };
    generate(world);
    return world;
  }

  /** 读方块；越界约定：地下是基岩（挡住底面），世界外其余方向是空气 */
  function getBlock(world, x, y, z) {
    if (y < 0) return BEDROCK;
    if (y >= SIZE_Y || x < 0 || x >= SIZE_X || z < 0 || z >= SIZE_Z) return AIR;
    return world.data[index(x, y, z)];
  }

  /** 写方块（基岩层不可破坏），返回是否成功 */
  function setBlock(world, x, y, z, id) {
    if (!inBounds(x, y, z)) return false;
    if (y === 0 && id === AIR) return false;
    world.data[index(x, y, z)] = id;
    return true;
  }

  function generate(world) {
    const seed = world.seed;
    const topId = new Uint8Array(SIZE_X * SIZE_Z); // 每列地表方块，供种树判断
    for (let x = 0; x < SIZE_X; x++) {
      for (let z = 0; z < SIZE_Z; z++) {
        const h = heightAt(seed, x, z);
        const beach = h <= WATER_LEVEL + 1;
        const top = beach ? SAND : GRASS;
        const sub = beach ? SAND : DIRT;
        topId[z * SIZE_X + x] = top;
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = BEDROCK;
          else if (y < h - 3) id = STONE;
          else if (y < h) id = sub;
          else id = top;
          // 石头层里埋煤矿石
          if (id === STONE && hash2(seed ^ (0xca11 + y), x, z) < 0.03) id = COAL_ORE;
          world.data[index(x, y, z)] = id;
        }
        // 湖面注水
        for (let y = h + 1; y <= WATER_LEVEL; y++) {
          world.data[index(x, y, z)] = WATER;
        }
      }
    }
    // 种树：离边界 2 格以上，只长在草方块上
    for (let x = 2; x < SIZE_X - 2; x++) {
      for (let z = 2; z < SIZE_Z - 2; z++) {
        if (topId[z * SIZE_X + x] !== GRASS) continue;
        const r = hash2(seed ^ 0x51ab, x, z);
        if (r >= 0.02) continue;
        const h = heightAt(seed, x, z);
        plantTree(world, x, h, z, hash2(seed ^ 0x7e55, x, z));
      }
    }
  }

  function plantTree(world, x, groundY, z, variant) {
    const trunk = 4 + Math.floor(variant * 2); // 树干高 4~5
    if (groundY + trunk + 2 >= SIZE_Y) return;
    // 树冠：两层 5×5 去角 + 一层 3×3 + 顶十字
    for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
      let r;
      if (dy <= trunk - 1) r = 2;
      else if (dy === trunk) r = 1;
      else r = 0;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dy === trunk + 1 && dx !== 0 && dz !== 0) continue; // 顶层只留十字
          if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // 去角
          const bx = x + dx, by = groundY + dy, bz = z + dz;
          if (getBlock(world, bx, by, bz) === AIR) setBlock(world, bx, by, bz, LEAVES);
        }
      }
    }
    for (let dy = 1; dy <= trunk; dy++) setBlock(world, x, groundY + dy, z, LOG);
  }

  /** 出生点：从中心向外螺旋找第一根「地表非水」的柱子 */
  function findSpawn(world) {
    const cx = SIZE_X >> 1, cz = SIZE_Z >> 1;
    for (let r = 0; r < Math.max(SIZE_X, SIZE_Z); r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // 只走当前圈
          const x = cx + dx, z = cz + dz;
          if (x < 0 || x >= SIZE_X || z < 0 || z >= SIZE_Z) continue;
          for (let y = SIZE_Y - 1; y >= 0; y--) {
            const id = getBlock(world, x, y, z);
            if (id === AIR || id === WATER) continue;
            return { x: x + 0.5, y: y + 1, z: z + 0.5 };
          }
        }
      }
    }
    return { x: cx + 0.5, y: SIZE_Y - 1, z: cz + 0.5 };
  }

  /**
   * 怪物/动物生成选址：以 (cx,cz) 为圆心，半径 14~32 格内随机取一列，
   * 要求脚踩实体方块、头顶两格空气、不在水里。rng 为 [0,1) 随机源。
   */
  function findMobSpawn(world, cx, cz, rng) {
    const ang = rng() * Math.PI * 2;
    const dist = 14 + rng() * 18;
    const x = Math.floor(cx + Math.cos(ang) * dist);
    const z = Math.floor(cz + Math.sin(ang) * dist);
    if (x < 2 || x >= SIZE_X - 2 || z < 2 || z >= SIZE_Z - 2) return null;
    for (let y = SIZE_Y - 1; y > 1; y--) {
      const id = getBlock(world, x, y, z);
      if (id === AIR || id === WATER) continue;
      if (!isOpaque(id)) return null;
      if (getBlock(world, x, y + 1, z) !== AIR || getBlock(world, x, y + 2, z) !== AIR) return null;
      return { x: x + 0.5, y: y + 1, z: z + 0.5 };
    }
    return null;
  }

  // ---------- 区块网格化（只生成暴露面） ----------

  // 6 个面：外法线 + 逆时针 4 角点（从外面看）
  const FACES = [
    { dir: [1, 0, 0], corners: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] },
    { dir: [-1, 0, 0], corners: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
    { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { dir: [0, 0, 1], corners: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]] },
    { dir: [0, 0, -1], corners: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
  ];
  const FACE_UV = [[0, 1], [0, 0], [1, 0], [1, 1]];
  const ATLAS_COLS = 4, ATLAS_ROWS = 4;
  const UV_EPS = 0.02; // 图集内缩，防相邻瓦片渗色

  function tileFor(block, ny) {
    if (ny > 0) return block.tiles.top;
    if (ny < 0) return block.tiles.bottom;
    return block.tiles.side;
  }

  /** 面是否要画：邻接空气画；实体邻接水画（水面那边不画，避免重叠闪面） */
  function faceVisible(self, neighbor) {
    if (neighbor === AIR) return true;
    if (self !== WATER && neighbor === WATER) return true;
    return false;
  }

  /**
   * 生成一个区块的网格数据。
   * 返回 { solid: {...}, water: {...} }，各有 positions/normals/uvs/indices 数组。
   */
  function buildChunkGeometry(world, cx, cz) {
    const out = { solid: newGeom(), water: newGeom() };
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let x = x0; x < x0 + CHUNK; x++) {
      for (let z = z0; z < z0 + CHUNK; z++) {
        for (let y = 0; y < SIZE_Y; y++) {
          const id = world.data[index(x, y, z)];
          if (id === AIR) continue;
          const geom = id === WATER ? out.water : out.solid;
          const block = BLOCKS[id];
          for (const face of FACES) {
            const nx = face.dir[0], ny = face.dir[1], nz = face.dir[2];
            if (!faceVisible(id, getBlock(world, x + nx, y + ny, z + nz))) continue;
            const tile = tileFor(block, ny);
            const tu = tile % ATLAS_COLS, tv = Math.floor(tile / ATLAS_COLS);
            const base = geom.positions.length / 3;
            for (let i = 0; i < 4; i++) {
              const c = face.corners[i];
              geom.positions.push(x + c[0], y + c[1], z + c[2]);
              geom.normals.push(nx, ny, nz);
              const u0 = tu / ATLAS_COLS, u1 = (tu + 1) / ATLAS_COLS;
              const v1 = 1 - tv / ATLAS_ROWS, v0 = v1 - 1 / ATLAS_ROWS;
              const uu = FACE_UV[i][0] ? u1 - UV_EPS : u0 + UV_EPS;
              const vv = FACE_UV[i][1] ? v1 - UV_EPS : v0 + UV_EPS;
              geom.uvs.push(uu, vv);
            }
            geom.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }
    return out;
  }

  function newGeom() { return { positions: [], normals: [], uvs: [], indices: [] }; }

  // ---------- 体素 DDA 拾取 ----------

  /**
   * 从 (ox,oy,oz) 沿单位向量 (dx,dy,dz) 步进，返回第一个非空非水方块：
   * { x, y, z, nx, ny, nz, id }（n 为被打面的外法线），未命中返回 null。
   */
  function raycast(world, ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x)) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y)) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z)) * tDeltaZ : Infinity;
    let nx = 0, ny = 0, nz = 0, t = 0;
    for (let i = 0; i < 512; i++) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) return null;
      const id = getBlock(world, x, y, z);
      if (id !== AIR && id !== WATER) return { x, y, z, nx, ny, nz, id, dist: t };
    }
    return null;
  }

  // ---------- 存档序列化（RLE + base64） ----------

  function encodeWorld(world) {
    const d = world.data;
    const runs = [];
    let cur = d[0], cnt = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] === cur && cnt < 65535) cnt++;
      else { runs.push(cur, cnt); cur = d[i]; cnt = 1; }
    }
    runs.push(cur, cnt);
    const bytes = new Uint8Array(runs.length / 2 * 3);
    for (let i = 0, j = 0; i < runs.length; i += 2, j += 3) {
      bytes[j] = runs[i];
      bytes[j + 1] = runs[i + 1] & 0xff;
      bytes[j + 2] = runs[i + 1] >> 8;
    }
    return b64encode(bytes);
  }

  function decodeWorld(seed, str) {
    const bytes = b64decode(str);
    if (bytes.length % 3 !== 0) throw new Error('存档数据损坏');
    const data = new Uint8Array(SIZE_X * SIZE_Y * SIZE_Z);
    let p = 0;
    for (let i = 0; i < bytes.length; i += 3) {
      const val = bytes[i], cnt = bytes[i + 1] | (bytes[i + 2] << 8);
      data.fill(val, p, p + cnt);
      p += cnt;
    }
    if (p !== data.length) throw new Error('存档长度不符');
    return { seed: seed | 0, data };
  }

  function b64encode(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64decode(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    const s = atob(str);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  const api = {
    SIZE_X, SIZE_Y, SIZE_Z, CHUNK, CHUNKS_X, CHUNKS_Z, WATER_LEVEL,
    AIR, GRASS, DIRT, STONE, SAND, WATER, LOG, LEAVES, BEDROCK, COBBLE, PLANKS, COAL_ORE, TORCH,
    STICK, COAL, WOOD_PICK, STONE_PICK, WOOD_SWORD, STONE_SWORD, MEAT,
    TILE, BLOCKS, ITEMS, FACES,
    isItem, nameOf, isOpaque, hash2, heightAt,
    HARDNESS, digSeconds, dropFor, attackDamage,
    INV_SIZE, HOTBAR_SIZE, STACK_MAX, createInventory, addItem, removeItems, countItem, swapSlots,
    RECIPES, canCraft, craft,
    DAY_TICKS, skyState,
    createWorld, getBlock, setBlock, findSpawn, findMobSpawn,
    buildChunkGeometry, raycast,
    encodeWorld, decodeWorld,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MinecraftCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
