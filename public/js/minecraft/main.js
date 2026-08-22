/**
 * 迷你世界渲染与交互层（依赖 three.js 与 minecraft/core.js）。
 * 只做渲染、输入、玩家/怪物物理；地形 / 网格化 / 拾取 / 挖掘规则 / 合成全部在 core.js。
 *
 * 玩法（单机生存向）：
 *  昼夜循环，夜晚刷僵尸（白天自燃），猪白天游荡掉肉回血；
 *  挖掘有硬度与工具系统（镐挖石头才掉圆石），掉落物自动拾取进背包；
 *  E 打开背包与合成（点击配方即合成），火把提供夜间点光源；
 *  摔落/被咬扣血，死亡回出生点。和平模式开关在菜单里。
 *
 * 操控：
 *  电脑 —— 点击画面锁定鼠标转视角，WASD 移动，空格跳，左键挖/攻击，右键放/吃肉，E 背包，Esc 菜单。
 *  手机 —— 左下摇杆移动，右侧空白处滑动转视角，右下按钮 挖/放/跳，🎒 背包，点快捷栏选物品。
 */
(function () {
  'use strict';

  const MC = window.MinecraftCore;
  const canvas = document.getElementById('mc-canvas');
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) document.body.classList.add('mc-touch');

  // ---------- 游戏状态与存档 ----------

  const SAVE_KEY = 'minecraft-save-v1'; // 键名沿用 v1，内部 v 字段区分版本
  let world = null;
  let inventory = MC.createInventory();
  let selected = 0;          // 快捷栏当前格（背包前 8 格）
  let timeTicks = 1000;      // 世界时间（0=日出）
  let peaceful = false;      // 和平模式：不刷僵尸
  let dirty = false;         // 有未保存的改动
  let dead = false;

  const player = {
    pos: { x: 0, y: 0, z: 0 }, // 脚底中心
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    onGround: false,
    inWater: false,
    hp: 20,                  // 半心制，20 = 10 颗心
    fallPeak: 0,             // 滞空期间的最高点，落地算摔落伤害
    attackCd: 0,
  };
  const HALF = 0.3, HEIGHT = 1.8, EYE = 1.62;

  function spawnAtStart() {
    const s = MC.findSpawn(world);
    player.pos.x = s.x; player.pos.y = s.y; player.pos.z = s.z;
    player.vel.x = player.vel.y = player.vel.z = 0;
    player.yaw = 0; player.pitch = 0;
    player.fallPeak = s.y;
  }

  function newWorld() {
    world = MC.createWorld((Math.random() * 0x7fffffff) | 0);
    inventory = MC.createInventory();
    selected = 0;
    timeTicks = 1000;
    player.hp = 20;
    dead = false;
    clearMobs();
    clearDrops();
    spawnAtStart();
    dirty = true;
  }

  function loadWorld() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const save = JSON.parse(raw);
      if (!save || (save.v !== 1 && save.v !== 2)) return false;
      world = MC.decodeWorld(save.seed, save.data);
      if (save.player) {
        player.pos.x = save.player.x; player.pos.y = save.player.y; player.pos.z = save.player.z;
        player.yaw = save.player.yaw || 0; player.pitch = save.player.pitch || 0;
        if (typeof save.player.hp === 'number') player.hp = save.player.hp;
      }
      if (save.v === 2) {
        timeTicks = save.time | 0;
        peaceful = !!save.peaceful;
        if (Array.isArray(save.inv)) {
          inventory = MC.createInventory();
          for (let i = 0; i < MC.INV_SIZE; i++) {
            const s = save.inv[i];
            if (s && s.id > 0 && s.n > 0) inventory[i] = { id: s.id, n: Math.min(MC.STACK_MAX, s.n) };
          }
        }
      }
      selected = Math.min(MC.HOTBAR_SIZE - 1, Math.max(0, save.selected | 0));
      return true;
    } catch (e) {
      return false; // 存档损坏就重新生成
    }
  }

  function saveWorld(quiet) {
    if (!world || dead) return; // 死亡状态不落盘，避免存进 0 血
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 2,
        seed: world.seed,
        data: MC.encodeWorld(world),
        player: { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch, hp: player.hp },
        time: Math.floor(timeTicks),
        peaceful,
        inv: inventory,
        selected,
      }));
      dirty = false;
      if (!quiet) toast('世界已保存');
    } catch (e) {
      if (!quiet) toast('保存失败：存储空间不足');
    }
  }

  // ---------- 程序化贴图（图集 + 物品图标共用一套画法） ----------

  const TILE_PX = 16, ATLAS_PX = 64;
  let paintSeed = 20240821;
  function prand() { paintSeed = (paintSeed * 1103515245 + 12345) & 0x7fffffff; return paintSeed / 0x7fffffff; }

  /** 在 ctx 的 (ox,oy) 处画一块 16×16 瓦片 */
  function paintTile(g, tile, ox, oy) {
    const T = MC.TILE;
    function base(color) { g.fillStyle = color; g.fillRect(ox, oy, TILE_PX, TILE_PX); }
    function speckle(colors, n, size) {
      for (let i = 0; i < n; i++) {
        g.fillStyle = colors[(prand() * colors.length) | 0];
        const s = size || 1;
        g.fillRect(ox + ((prand() * TILE_PX) | 0), oy + ((prand() * TILE_PX) | 0), s, s);
      }
    }
    switch (tile) {
      case T.GRASS_TOP:
        base('#6aae3f'); speckle(['#5d9c33', '#79bd4a', '#548c2c', '#83c455'], 90); break;
      case T.GRASS_SIDE: {
        base('#8a5f3c'); speckle(['#7a5233', '#9b6c45'], 60);
        g.fillStyle = '#6aae3f'; g.fillRect(ox, oy, TILE_PX, 3);
        g.fillStyle = '#5d9c33';
        for (let x = 0; x < TILE_PX; x++) { if (prand() < 0.4) g.fillRect(ox + x, oy + 3, 1, 1 + ((prand() * 2) | 0)); }
        break;
      }
      case T.DIRT: base('#8a5f3c'); speckle(['#7a5233', '#9b6c45', '#6d4a2e'], 70); break;
      case T.STONE: base('#8d8d8d'); speckle(['#7a7a7a', '#9c9c9c', '#6f6f6f'], 80); break;
      case T.SAND: base('#e3d9a3'); speckle(['#d6cb92', '#efe6b8', '#cabd85'], 70); break;
      case T.WATER: {
        base('#3a6fd8');
        g.fillStyle = '#4a7fe0';
        for (let i = 0; i < 4; i++) { const y = (prand() * TILE_PX) | 0; g.fillRect(ox, oy + y, TILE_PX, 1); }
        speckle(['#568be6', '#2f5fc0'], 24); break;
      }
      case T.LOG_SIDE: {
        base('#6b4f2a');
        g.fillStyle = '#5a3f21';
        for (let x = 0; x < TILE_PX; x++) { if (x % 4 === 0 || prand() < 0.08) g.fillRect(ox + x, oy, 1, TILE_PX); }
        speckle(['#7a5a32'], 24); break;
      }
      case T.LOG_TOP: {
        base('#a08050');
        g.strokeStyle = '#7d6136';
        for (let r = 1; r < 8; r += 2) g.strokeRect(ox + 8 - r, oy + 8 - r, r * 2, r * 2);
        break;
      }
      case T.LEAVES: base('#3f7a24'); speckle(['#33641c', '#4f9130', '#2a5216'], 110); break;
      case T.BEDROCK: base('#3a3a3a'); speckle(['#1f1f1f', '#565656', '#2c2c2c'], 90, 2); break;
      case T.COBBLE: {
        base('#7d7d7d');
        for (let i = 0; i < 7; i++) {
          const w = 4 + ((prand() * 4) | 0), h = 3 + ((prand() * 3) | 0);
          const x = (prand() * (TILE_PX - w)) | 0, y = (prand() * (TILE_PX - h)) | 0;
          g.fillStyle = '#555555'; g.fillRect(ox + x - 1, oy + y - 1, w + 2, h + 2);
          g.fillStyle = '#9a9a9a'; g.fillRect(ox + x, oy + y, w, h);
        }
        break;
      }
      case T.PLANKS: {
        base('#b08a4f');
        g.fillStyle = '#8a6a3a';
        for (let y = 3; y < TILE_PX; y += 4) g.fillRect(ox, oy + y, TILE_PX, 1);
        for (let y = 0; y < TILE_PX; y += 4) g.fillRect(ox + ((y * 7) % TILE_PX), oy + y, 1, 3);
        speckle(['#bd955a'], 20); break;
      }
      case T.COAL_ORE: {
        base('#8d8d8d'); speckle(['#7a7a7a', '#9c9c9c'], 60);
        g.fillStyle = '#1c1c1c';
        for (let i = 0; i < 5; i++) g.fillRect(ox + 2 + ((prand() * 10) | 0), oy + 2 + ((prand() * 10) | 0), 3, 3);
        break;
      }
      case T.TORCH: {
        base('#6b4f2a');
        g.fillStyle = '#5a3f21';
        for (let x = 0; x < TILE_PX; x += 4) g.fillRect(ox + x, oy, 1, TILE_PX);
        g.fillStyle = '#ffb020'; g.fillRect(ox + 5, oy + 2, 6, 6);
        g.fillStyle = '#ffe080'; g.fillRect(ox + 6, oy + 3, 4, 3);
        break;
      }
      default: base('#ff00ff');
    }
  }

  /** 画 16×16 物品图标（非方块物品） */
  function paintItemIcon(g, id, ox, oy) {
    g.clearRect(ox, oy, TILE_PX, TILE_PX);
    switch (id) {
      case MC.STICK:
        g.fillStyle = '#8a5f3c';
        for (let i = 0; i < 8; i++) g.fillRect(ox + 4 + i, oy + 12 - i, 2, 2);
        break;
      case MC.COAL:
        g.fillStyle = '#1c1c1c';
        g.fillRect(ox + 3, oy + 6, 6, 6); g.fillRect(ox + 8, oy + 4, 5, 5); g.fillRect(ox + 6, oy + 9, 6, 5);
        g.fillStyle = '#3d3d3d'; g.fillRect(ox + 4, oy + 7, 2, 2); g.fillRect(ox + 9, oy + 5, 2, 2);
        break;
      case MC.WOOD_PICK: case MC.STONE_PICK: {
        const head = id === MC.WOOD_PICK ? '#b08a4f' : '#9a9a9a';
        g.fillStyle = '#8a5f3c';
        for (let i = 0; i < 8; i++) g.fillRect(ox + 3 + i, oy + 13 - i, 2, 2); // 柄
        g.fillStyle = head;
        g.fillRect(ox + 6, oy + 1, 9, 3); g.fillRect(ox + 13, oy + 3, 2, 3); g.fillRect(ox + 6, oy + 3, 2, 2); // 镐头
        break;
      }
      case MC.WOOD_SWORD: case MC.STONE_SWORD: {
        const blade = id === MC.WOOD_SWORD ? '#c9a05e' : '#c8c8c8';
        g.fillStyle = blade;
        g.fillRect(ox + 7, oy + 1, 3, 9); g.fillRect(ox + 8, oy, 1, 1); // 剑身
        g.fillStyle = '#5a3f21';
        g.fillRect(ox + 4, oy + 10, 9, 2); // 护手
        g.fillRect(ox + 7, oy + 12, 3, 4); // 柄
        break;
      }
      case MC.MEAT:
        g.fillStyle = '#d4695e';
        g.fillRect(ox + 3, oy + 5, 9, 7); g.fillRect(ox + 5, oy + 3, 6, 3);
        g.fillStyle = '#b34a40'; g.fillRect(ox + 3, oy + 10, 9, 2);
        g.fillStyle = '#f3e6d4'; g.fillRect(ox + 12, oy + 4, 3, 3); g.fillRect(ox + 13, oy + 7, 2, 2);
        break;
      default:
        g.fillStyle = '#ff00ff'; g.fillRect(ox, oy, TILE_PX, TILE_PX);
    }
  }

  /** 任意 id（方块或物品）画到 16×16 画布 */
  function paintIcon(g, id) {
    g.clearRect(0, 0, TILE_PX, TILE_PX);
    if (MC.isItem(id)) paintItemIcon(g, id, 0, 0);
    else paintTile(g, MC.BLOCKS[id].tiles.side, 0, 0);
  }

  function makeAtlasTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = ATLAS_PX;
    const g = c.getContext('2d');
    for (let t = 0; t < 16; t++) paintTile(g, t, (t % 4) * TILE_PX, Math.floor(t / 4) * TILE_PX);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  // ---------- Three.js 场景 ----------

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const SKY_DAY = new THREE.Color(0x87ceeb);
  const SKY_NIGHT = new THREE.Color(0x0b1026);
  const SKY_DUSK = new THREE.Color(0xd98a4a);
  scene.background = new THREE.Color(SKY_DAY);
  scene.fog = new THREE.Fog(SKY_DAY.getHex(), 40, 110);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 300);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  scene.add(sun);
  scene.add(sun.target);

  const atlasTex = makeAtlasTexture();
  const solidMat = new THREE.MeshLambertMaterial({ map: atlasTex });
  const waterMat = new THREE.MeshLambertMaterial({
    map: atlasTex, transparent: true, opacity: 0.72, depthWrite: false,
  });

  // 选中方块的高亮线框
  const hlBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.7 })
  );
  hlBox.visible = false;
  scene.add(hlBox);

  // 火把点光源池：就近分配给玩家周围的火把
  const torchLights = [];
  for (let i = 0; i < 6; i++) {
    const l = new THREE.PointLight(0xffb050, 0, 13, 2);
    scene.add(l);
    torchLights.push(l);
  }

  /** 昼夜推进：太阳绕转、天色与光照渐变 */
  function updateSky() {
    const s = MC.skyState(timeTicks);
    const d = s.dayFactor;
    const color = new THREE.Color().copy(SKY_NIGHT).lerp(SKY_DAY, d);
    // 日出日落染一点橙色
    const dusk = Math.max(0, 1 - Math.abs(s.sunHeight) * 4) * 0.6;
    color.lerp(SKY_DUSK, dusk * Math.min(1, d + 0.3));
    scene.background = color;
    scene.fog.color = color;
    hemi.intensity = 0.25 + d * 0.7;
    sun.intensity = 0.06 + d * 0.6;
    sun.position.set(
      player.pos.x + Math.cos(s.angle) * 80,
      Math.sin(s.angle) * 80,
      player.pos.z + 30
    );
    sun.target.position.set(player.pos.x, 0, player.pos.z);
  }

  // ---------- 区块网格 ----------

  const chunkMeshes = []; // [cz][cx] -> { solid, water }

  function toMesh(data, mat) {
    if (!data.indices.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
    g.setIndex(data.indices);
    const mesh = new THREE.Mesh(g, mat);
    scene.add(mesh);
    return mesh;
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
  }

  function buildChunk(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= MC.CHUNKS_X || cz >= MC.CHUNKS_Z) return;
    const old = chunkMeshes[cz] && chunkMeshes[cz][cx];
    if (old) { disposeMesh(old.solid); disposeMesh(old.water); }
    const data = MC.buildChunkGeometry(world, cx, cz);
    if (!chunkMeshes[cz]) chunkMeshes[cz] = [];
    chunkMeshes[cz][cx] = { solid: toMesh(data.solid, solidMat), water: toMesh(data.water, waterMat) };
  }

  function buildAllChunks() {
    for (let cz = 0; cz < MC.CHUNKS_Z; cz++) for (let cx = 0; cx < MC.CHUNKS_X; cx++) buildChunk(cx, cz);
  }

  /** 方块改动后重建所在区块（贴边的方块同时重建相邻区块） */
  function rebuildAround(x, z) {
    const cx = Math.floor(x / MC.CHUNK), cz = Math.floor(z / MC.CHUNK);
    buildChunk(cx, cz);
    const lx = x - cx * MC.CHUNK, lz = z - cz * MC.CHUNK;
    if (lx === 0) buildChunk(cx - 1, cz);
    if (lx === MC.CHUNK - 1) buildChunk(cx + 1, cz);
    if (lz === 0) buildChunk(cx, cz - 1);
    if (lz === MC.CHUNK - 1) buildChunk(cx, cz + 1);
  }

  // ---------- 体素碰撞（玩家与怪物共用） ----------

  const EPS = 1e-4;

  function collidesBox(px, py, pz, half, height) {
    const x0 = Math.floor(px - half + EPS), x1 = Math.floor(px + half - EPS);
    const y0 = Math.floor(py + EPS), y1 = Math.floor(py + height - EPS);
    const z0 = Math.floor(pz - half + EPS), z1 = Math.floor(pz + half - EPS);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (MC.isOpaque(MC.getBlock(world, x, y, z))) return true;
        }
      }
    }
    return false;
  }

  /** 分轴移动并裁剪；返回是否撞上了 */
  function moveAxisBox(ent, half, height, ax, d) {
    if (!d) return false;
    ent.pos[ax] += d;
    if (!collidesBox(ent.pos.x, ent.pos.y, ent.pos.z, half, height)) return false;
    if (ax === 'y') {
      if (d < 0) { ent.pos.y = Math.floor(ent.pos.y) + 1; ent.onGround = true; }
      else ent.pos.y = Math.floor(ent.pos.y + height) - height - EPS;
      ent.vel.y = 0;
    } else {
      if (d > 0) ent.pos[ax] = Math.floor(ent.pos[ax] + half) - half - EPS;
      else ent.pos[ax] = Math.floor(ent.pos[ax] - half) + 1 + half + EPS;
      ent.vel[ax] = 0;
    }
    return true;
  }

  /** 通用刚体步进：水平速度 + 重力 + 分轴移动 + 世界边界 */
  function stepBody(ent, half, height, dt, opts) {
    const inWater = MC.getBlock(world, Math.floor(ent.pos.x), Math.floor(ent.pos.y + 0.4), Math.floor(ent.pos.z)) === MC.WATER;
    if (inWater) {
      ent.vel.y = Math.max(ent.vel.y - 8 * dt, -3);
      if (opts && opts.swim) ent.vel.y = 3.2;
    } else {
      ent.vel.y -= 26 * dt;
    }
    ent.onGround = false;
    const hitX = moveAxisBox(ent, half, height, 'x', ent.vel.x * dt);
    const hitZ = moveAxisBox(ent, half, height, 'z', ent.vel.z * dt);
    moveAxisBox(ent, half, height, 'y', ent.vel.y * dt);
    ent.pos.x = Math.max(half + EPS, Math.min(MC.SIZE_X - half - EPS, ent.pos.x));
    ent.pos.z = Math.max(half + EPS, Math.min(MC.SIZE_Z - half - EPS, ent.pos.z));
    return { inWater, hitWall: hitX || hitZ };
  }

  // ---------- 玩家 ----------

  const keys = Object.create(null);
  let jumpHeld = false;
  const joyVec = { x: 0, y: 0 }; // 摇杆：x 右为正，y 前为正

  function stepPlayer(dt) {
    let ix = 0, iy = 0;
    if (keys.KeyW || keys.ArrowUp) iy += 1;
    if (keys.KeyS || keys.ArrowDown) iy -= 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    ix += joyVec.x; iy += joyVec.y;
    const len = Math.hypot(ix, iy);
    if (len > 1) { ix /= len; iy /= len; }

    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    const speed = player.inWater ? 2.8 : 4.5;
    player.vel.x = (ix * cos - iy * sin) * speed;
    player.vel.z = (-iy * cos - ix * sin) * speed;

    const wasOnGround = player.onGround;
    if (!player.onGround) player.fallPeak = Math.max(player.fallPeak, player.pos.y);

    const r = stepBody(player, HALF, HEIGHT, dt, { swim: jumpHeld });
    player.inWater = r.inWater;

    if (!wasOnGround && player.onGround) {
      const fall = player.fallPeak - player.pos.y;
      if (fall > 3.5 && !player.inWater) hurtPlayer(Math.floor(fall - 3), '摔落');
      player.fallPeak = player.pos.y;
    }
    if (player.onGround) player.fallPeak = player.pos.y;

    if (jumpHeld && player.onGround && !player.inWater) player.vel.y = 8.8;

    if (player.pos.y < -8) spawnAtStart(); // 兜底：掉出世界回出生点

    player.attackCd = Math.max(0, player.attackCd - dt);
  }

  // ---------- 生命 ----------

  const hurtEl = document.getElementById('mc-hurt');
  const heartsEl = document.getElementById('mc-hearts');

  function renderHearts() {
    let s = '';
    for (let i = 0; i < 10; i++) {
      const v = player.hp - i * 2;
      s += '<span class="' + (v >= 2 ? 'full' : v === 1 ? 'half' : 'empty') + '">♥</span>';
    }
    heartsEl.innerHTML = s;
  }

  function hurtPlayer(dmg, why) {
    if (dead || dmg <= 0) return;
    player.hp -= dmg;
    hurtEl.style.opacity = '0.55';
    setTimeout(() => { hurtEl.style.opacity = '0'; }, 180);
    renderHearts();
    dirty = true;
    if (player.hp <= 0) die(why);
  }

  function die(why) {
    dead = true;
    player.hp = 0;
    document.getElementById('mc-death-cause').textContent = why === '摔落'
      ? '你从高处摔了下来'
      : '你被僵尸咬死了';
    document.getElementById('mc-death').classList.remove('hidden');
    if (document.exitPointerLock) document.exitPointerLock();
  }

  function respawn() {
    dead = false;
    player.hp = 20;
    spawnAtStart();
    renderHearts();
    document.getElementById('mc-death').classList.add('hidden');
    dirty = true;
    if (!isTouch) lockPointer();
  }

  // ---------- 掉落物 ----------

  const drops = [];
  const dropMatCache = new Map();

  function dropMaterial(id) {
    if (!dropMatCache.has(id)) {
      const c = document.createElement('canvas');
      c.width = c.height = TILE_PX;
      paintIcon(c.getContext('2d'), id);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      dropMatCache.set(id, new THREE.MeshLambertMaterial({ map: tex }));
    }
    return dropMatCache.get(id);
  }

  const dropGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);

  function spawnDrop(id, x, y, z) {
    if (drops.length > 50) return;
    const mesh = new THREE.Mesh(dropGeo, dropMaterial(id));
    scene.add(mesh);
    drops.push({
      id, mesh, age: 0,
      pos: { x: x + 0.5, y: y + 0.6, z: z + 0.5 },
      vel: { x: (Math.random() - 0.5) * 2, y: 3.5, z: (Math.random() - 0.5) * 2 },
      onGround: false,
    });
  }

  function clearDrops() {
    for (const d of drops) scene.remove(d.mesh);
    drops.length = 0;
  }

  function stepDrops(dt) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      // 磁吸：靠近玩家就飞过去
      const dx = player.pos.x - d.pos.x, dy = player.pos.y + 0.8 - d.pos.y, dz = player.pos.z - d.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1.0) {
        const left = MC.addItem(inventory, d.id, 1);
        dirty = true;
        renderHotbar();
        if (invOpen) renderInv();
        if (left === 0) { scene.remove(d.mesh); drops.splice(i, 1); continue; }
      } else if (dist < 2.2) {
        d.vel.x = dx / dist * 6; d.vel.y = dy / dist * 6; d.vel.z = dz / dist * 6;
      } else {
        d.vel.x *= 0.9; d.vel.z *= 0.9;
        d.vel.y -= 18 * dt;
      }
      // 简化碰撞：只检查目标位置是否是实体方块
      const nx = d.pos.x + d.vel.x * dt, ny = d.pos.y + d.vel.y * dt, nz = d.pos.z + d.vel.z * dt;
      if (!MC.isOpaque(MC.getBlock(world, Math.floor(nx), Math.floor(ny), Math.floor(nz)))) {
        d.pos.x = nx; d.pos.y = ny; d.pos.z = nz;
      } else {
        if (d.vel.y < 0) { // 落在方块顶上
          d.pos.y = Math.floor(d.pos.y) + 1 + 0.15;
          d.vel.y = 0;
        }
        d.vel.x = d.vel.z = 0;
      }
      if (d.pos.y < 0 || d.age > 90) { scene.remove(d.mesh); drops.splice(i, 1); continue; }
      d.mesh.position.set(d.pos.x, d.pos.y + Math.sin(d.age * 3) * 0.05, d.pos.z);
      d.mesh.rotation.y = d.age * 2;
    }
  }

  // ---------- 怪物（僵尸）与动物（猪） ----------

  const mobs = [];
  const MOB_CFG = {
    zombie: { hp: 10, speed: 2.3, dmg: 3, reach: 1.5, halfW: 0.32, height: 1.85 },
    pig: { hp: 6, speed: 1.7, dmg: 0, reach: 0, halfW: 0.35, height: 0.9 },
  };

  function lam(c) { return new THREE.MeshLambertMaterial({ color: c }); }

  function makeZombieMesh() {
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    add(new THREE.BoxGeometry(0.5, 0.5, 0.5), lam(0x4a9a4a), 0, 1.6, 0);            // 头
    add(new THREE.BoxGeometry(0.5, 0.7, 0.28), lam(0x2a8f8f), 0, 1.0, 0);          // 身体
    add(new THREE.BoxGeometry(0.2, 0.65, 0.2), lam(0x2a3a8f), -0.13, 0.33, 0);     // 左腿
    add(new THREE.BoxGeometry(0.2, 0.65, 0.2), lam(0x2a3a8f), 0.13, 0.33, 0);      // 右腿
    add(new THREE.BoxGeometry(0.16, 0.16, 0.55), lam(0x4a9a4a), -0.33, 1.15, 0.25); // 左臂前伸
    add(new THREE.BoxGeometry(0.16, 0.16, 0.55), lam(0x4a9a4a), 0.33, 1.15, 0.25);  // 右臂前伸
    // 眼睛
    add(new THREE.BoxGeometry(0.08, 0.08, 0.02), lam(0x101010), -0.1, 1.65, 0.26);
    add(new THREE.BoxGeometry(0.08, 0.08, 0.02), lam(0x101010), 0.1, 1.65, 0.26);
    return g;
  }

  function makePigMesh() {
    const g = new THREE.Group();
    const pink = lam(0xe8a0a8);
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    add(new THREE.BoxGeometry(0.55, 0.5, 0.9), pink, 0, 0.62, 0);                  // 身体
    add(new THREE.BoxGeometry(0.45, 0.45, 0.4), pink, 0, 0.85, 0.6);               // 头
    add(new THREE.BoxGeometry(0.2, 0.15, 0.08), lam(0xc9838c), 0, 0.78, 0.82);     // 鼻子
    for (const [x, z] of [[-0.18, 0.3], [0.18, 0.3], [-0.18, -0.3], [0.18, -0.3]]) {
      add(new THREE.BoxGeometry(0.15, 0.38, 0.15), lam(0xd88f98), x, 0.19, z);     // 腿
    }
    return g;
  }

  function spawnMob(kind, pos) {
    const cfg = MOB_CFG[kind];
    const mesh = kind === 'zombie' ? makeZombieMesh() : makePigMesh();
    scene.add(mesh);
    const mats = [];
    mesh.traverse((o) => { if (o.material) mats.push(o.material); });
    mobs.push({
      kind, cfg, mesh, mats,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      hp: cfg.hp, onGround: false, yaw: 0,
      attackCd: 0, thinkT: 0, wander: null, flashT: 0,
    });
  }

  function clearMobs() {
    for (const m of mobs) scene.remove(m.mesh);
    mobs.length = 0;
  }

  function killMob(m, idx, noDrops) {
    scene.remove(m.mesh);
    mobs.splice(idx, 1);
    if (noDrops) return;
    if (m.kind === 'pig') {
      const n = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) spawnDrop(MC.MEAT, m.pos.x - 0.5, m.pos.y, m.pos.z - 0.5);
    } else if (m.kind === 'zombie' && Math.random() < 0.3) {
      spawnDrop(MC.COAL, m.pos.x - 0.5, m.pos.y, m.pos.z - 0.5); // 战利品：煤炭
    }
  }

  function stepMobs(dt, sky) {
    for (let i = mobs.length - 1; i >= 0; i--) {
      const m = mobs[i];
      const dx = player.pos.x - m.pos.x, dz = player.pos.z - m.pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist > 48) { scene.remove(m.mesh); mobs.splice(i, 1); continue; } // 太远直接消失

      if (m.kind === 'zombie') {
        // 白天自燃
        if (sky.dayFactor > 0.5 && MC.getBlock(world, Math.floor(m.pos.x), Math.floor(m.pos.y + m.cfg.height + 0.5), Math.floor(m.pos.z)) === MC.AIR) {
          m.hp -= 2 * dt;
          if (m.hp <= 0) { killMob(m, i); continue; }
        }
        // 追击玩家
        if (!dead && dist > 0.01) {
          m.yaw = Math.atan2(dx, dz);
          if (dist > m.cfg.reach) {
            m.vel.x = dx / dist * m.cfg.speed;
            m.vel.z = dz / dist * m.cfg.speed;
          } else {
            m.vel.x = m.vel.z = 0;
            m.attackCd -= dt;
            if (m.attackCd <= 0) {
              hurtPlayer(m.cfg.dmg, '僵尸');
              m.attackCd = 1;
            }
          }
        } else { m.vel.x = m.vel.z = 0; }
      } else {
        // 猪：随机游荡
        m.thinkT -= dt;
        if (m.thinkT <= 0) {
          m.thinkT = 2 + Math.random() * 3;
          if (Math.random() < 0.4) m.wander = null;
          else {
            const a = Math.random() * Math.PI * 2;
            m.wander = { x: Math.sin(a), z: Math.cos(a) };
          }
        }
        if (m.wander) {
          m.yaw = Math.atan2(m.wander.x, m.wander.z);
          m.vel.x = m.wander.x * m.cfg.speed * 0.7;
          m.vel.z = m.wander.z * m.cfg.speed * 0.7;
        } else { m.vel.x = m.vel.z = 0; }
      }

      const r = stepBody(m, m.cfg.halfW, m.cfg.height, dt, { swim: true });
      if (r.hitWall && m.onGround) m.vel.y = 8.5; // 被方块挡住就跳一下

      // 受击闪红恢复
      if (m.flashT > 0) {
        m.flashT -= dt;
        if (m.flashT <= 0) for (const mt of m.mats) mt.emissive.setHex(0x000000);
      }

      m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
      m.mesh.rotation.y = m.yaw;
    }
  }

  let zombieTimer = 3, pigTimer = 8;

  function stepSpawning(dt, sky) {
    zombieTimer -= dt; pigTimer -= dt;
    const zombies = mobs.filter((m) => m.kind === 'zombie').length;
    const pigs = mobs.filter((m) => m.kind === 'pig').length;
    if (zombieTimer <= 0) {
      zombieTimer = 2.5;
      if (!peaceful && sky.night && zombies < 6 && !dead) {
        const p = MC.findMobSpawn(world, player.pos.x, player.pos.z, Math.random);
        if (p) spawnMob('zombie', p);
      }
    }
    if (pigTimer <= 0) {
      pigTimer = 10;
      if (!sky.night && pigs < 3) {
        const p = MC.findMobSpawn(world, player.pos.x, player.pos.z, Math.random);
        if (p) spawnMob('pig', p);
      }
    }
  }

  // ---------- 挖掘 / 放置 / 攻击 / 进食 ----------

  function eyePos() { return { x: player.pos.x, y: player.pos.y + EYE, z: player.pos.z }; }

  function lookDir() {
    const cp = Math.cos(player.pitch);
    return { x: -Math.sin(player.yaw) * cp, y: Math.sin(player.pitch), z: -Math.cos(player.yaw) * cp };
  }

  function castFromCamera() {
    const e = eyePos();
    const d = lookDir();
    return MC.raycast(world, e.x, e.y, e.z, d.x, d.y, d.z, 6);
  }

  /** 当前手持工具 id（非工具视为徒手 0） */
  function currentToolId() {
    const s = inventory[selected];
    return s && MC.isItem(s.id) ? s.id : 0;
  }

  /** 准星附近 3.4 格内、视角夹角内的最近怪物 */
  function mobAtCrosshair(blockDist) {
    const e = eyePos();
    const d = lookDir();
    let best = null, bestDist = Infinity;
    for (let i = 0; i < mobs.length; i++) {
      const m = mobs[i];
      const mx = m.pos.x - e.x, my = m.pos.y + m.cfg.height / 2 - e.y, mz = m.pos.z - e.z;
      const dist = Math.hypot(mx, my, mz);
      if (dist > 3.4 || dist < 0.01) continue;
      const dot = (mx * d.x + my * d.y + mz * d.z) / dist;
      if (dot < 0.9) continue;
      if (blockDist !== undefined && dist > blockDist + 0.6) continue; // 隔着方块不打
      if (dist < bestDist) { best = m; bestDist = dist; }
    }
    return best;
  }

  function attackMob(m) {
    if (player.attackCd > 0) return;
    player.attackCd = 0.35;
    m.hp -= MC.attackDamage(currentToolId());
    // 击退
    const d = lookDir();
    m.vel.x += d.x * 6; m.vel.z += d.z * 6; m.vel.y = 3.5;
    // 闪红
    m.flashT = 0.15;
    for (const mt of m.mats) mt.emissive.setHex(0xff3333);
    if (m.hp <= 0) {
      const idx = mobs.indexOf(m);
      if (idx >= 0) killMob(m, idx);
    }
  }

  let digTarget = null; // {x,y,z,progress}
  const ringEl = document.getElementById('mc-ring');

  function setRing(p) {
    if (p === null) { ringEl.style.display = 'none'; return; }
    ringEl.style.display = 'block';
    ringEl.style.background = 'conic-gradient(rgba(255,255,255,0.9) ' + Math.floor(p * 360) + 'deg, rgba(255,255,255,0.15) 0deg)';
  }

  /** 主键行为：优先打怪，其次挖方块（带硬度进度） */
  function stepDigging(dt) {
    if (!digHeld) { digTarget = null; setRing(null); return; }
    const hit = castFromCamera();
    const mob = mobAtCrosshair(hit ? hit.dist : undefined);
    if (mob) { digTarget = null; setRing(null); attackMob(mob); return; }
    if (!hit) { digTarget = null; setRing(null); return; }
    if (!digTarget || digTarget.x !== hit.x || digTarget.y !== hit.y || digTarget.z !== hit.z) {
      digTarget = { x: hit.x, y: hit.y, z: hit.z, progress: 0 };
    }
    const dur = MC.digSeconds(hit.id, currentToolId());
    if (!isFinite(dur)) { setRing(null); return; } // 基岩
    digTarget.progress += dt / dur;
    setRing(Math.min(1, digTarget.progress));
    if (digTarget.progress >= 1) {
      const dropId = MC.dropFor(hit.id, currentToolId());
      if (MC.setBlock(world, hit.x, hit.y, hit.z, MC.AIR)) {
        rebuildAround(hit.x, hit.z);
        if (dropId) spawnDrop(dropId, hit.x, hit.y, hit.z);
        dirty = true;
      }
      digTarget = null;
      setRing(null);
    }
  }

  /** 副键行为：吃肉 > 放方块 */
  function doPlace() {
    const slot = inventory[selected];
    if (!slot) return;
    if (slot.id === MC.MEAT) { // 吃肉回血
      if (player.hp >= 20) { toast('生命值已满'); return; }
      player.hp = Math.min(20, player.hp + MC.ITEMS[MC.MEAT].heal);
      if (--slot.n <= 0) inventory[selected] = null;
      renderHearts(); renderHotbar();
      if (invOpen) renderInv();
      dirty = true;
      return;
    }
    if (MC.isItem(slot.id)) { toast('手里拿的是工具，不能放置'); return; }
    const hit = castFromCamera();
    if (!hit) return;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    const cur = MC.getBlock(world, x, y, z);
    if (cur !== MC.AIR && cur !== MC.WATER) return;
    // 不能放在玩家身体里
    const p = player.pos;
    if (x + 1 > p.x - HALF && x < p.x + HALF && y + 1 > p.y && y < p.y + HEIGHT && z + 1 > p.z - HALF && z < p.z + HALF) return;
    if (!MC.setBlock(world, x, y, z, slot.id)) return;
    if (--slot.n <= 0) inventory[selected] = null;
    rebuildAround(x, z);
    renderHotbar();
    if (invOpen) renderInv();
    dirty = true;
  }

  // ---------- 火把点光源管理 ----------

  let torchTimer = 0;

  function stepTorchLights(dt) {
    torchTimer -= dt;
    if (torchTimer > 0) return;
    torchTimer = 0.6;
    const px = Math.floor(player.pos.x), py = Math.floor(player.pos.y), pz = Math.floor(player.pos.z);
    const R = 12;
    const found = [];
    for (let x = Math.max(0, px - R); x <= Math.min(MC.SIZE_X - 1, px + R); x++) {
      for (let y = Math.max(0, py - R); y <= Math.min(MC.SIZE_Y - 1, py + R); y++) {
        for (let z = Math.max(0, pz - R); z <= Math.min(MC.SIZE_Z - 1, pz + R); z++) {
          if (world.data[(y * MC.SIZE_Z + z) * MC.SIZE_X + x] === MC.TORCH) {
            found.push({ x, y, z, d: (x - px) * (x - px) + (y - py) * (y - py) + (z - pz) * (z - pz) });
          }
        }
      }
    }
    found.sort((a, b) => a.d - b.d);
    for (let i = 0; i < torchLights.length; i++) {
      if (i < found.length) {
        torchLights[i].position.set(found[i].x + 0.5, found[i].y + 0.7, found[i].z + 0.5);
        torchLights[i].intensity = 1.4;
      } else {
        torchLights[i].intensity = 0;
      }
    }
  }

  // ---------- 快捷栏与背包 UI ----------

  const hotbarEl = document.getElementById('mc-hotbar');

  function renderHotbar() {
    hotbarEl.innerHTML = '';
    for (let i = 0; i < MC.HOTBAR_SIZE; i++) {
      const slot = inventory[i];
      const el = document.createElement('div');
      el.className = 'mc-hb-slot' + (i === selected ? ' sel' : '');
      if (slot) {
        const c = document.createElement('canvas');
        c.width = c.height = TILE_PX;
        paintIcon(c.getContext('2d'), slot.id);
        el.appendChild(c);
        if (slot.n > 1) {
          const n = document.createElement('span');
          n.className = 'mc-hb-count';
          n.textContent = slot.n;
          el.appendChild(n);
        }
        const name = document.createElement('span');
        name.className = 'mc-hb-name';
        name.textContent = (i + 1) + ' ' + MC.nameOf(slot.id);
        el.appendChild(name);
      }
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); selectSlot(i); });
      hotbarEl.appendChild(el);
    }
  }

  function selectSlot(i) {
    selected = (i + MC.HOTBAR_SIZE) % MC.HOTBAR_SIZE;
    renderHotbar();
  }

  // 背包面板
  const invEl = document.getElementById('mc-inv');
  const invGridEl = document.getElementById('mc-inv-grid');
  const invRecipesEl = document.getElementById('mc-recipes');
  let invOpen = false;

  function moveToRange(from, r0, r1) {
    if (!inventory[from]) return;
    // 先尝试合并同类堆
    for (let j = r0; j <= r1; j++) {
      const s = inventory[j];
      if (s && s.id === inventory[from].id && s.n < MC.STACK_MAX) { MC.swapSlots(inventory, from, j); return; }
    }
    for (let j = r0; j <= r1; j++) {
      if (!inventory[j]) { MC.swapSlots(inventory, from, j); return; }
    }
    MC.swapSlots(inventory, from, from < MC.HOTBAR_SIZE ? r0 : 0); // 满了就和第一格换
  }

  function renderInv() {
    invGridEl.innerHTML = '';
    for (let i = 0; i < MC.INV_SIZE; i++) {
      const slot = inventory[i];
      const el = document.createElement('div');
      el.className = 'mc-inv-slot' + (i < MC.HOTBAR_SIZE ? ' hot' : '');
      if (slot) {
        const c = document.createElement('canvas');
        c.width = c.height = TILE_PX;
        paintIcon(c.getContext('2d'), slot.id);
        el.appendChild(c);
        if (slot.n > 1) {
          const n = document.createElement('span');
          n.className = 'mc-hb-count';
          n.textContent = slot.n;
          el.appendChild(n);
        }
        el.title = MC.nameOf(slot.id);
      }
      el.addEventListener('click', () => {
        if (i < MC.HOTBAR_SIZE) moveToRange(i, MC.HOTBAR_SIZE, MC.INV_SIZE - 1);
        else moveToRange(i, 0, MC.HOTBAR_SIZE - 1);
        renderInv(); renderHotbar(); dirty = true;
      });
      invGridEl.appendChild(el);
    }
    invRecipesEl.innerHTML = '';
    for (const r of MC.RECIPES) {
      const ok = MC.canCraft(inventory, r);
      const btn = document.createElement('button');
      btn.className = 'mc-recipe' + (ok ? '' : ' off');
      const needs = Object.keys(r.needs).map((id) => MC.nameOf(Number(id)) + '×' + r.needs[id]).join(' + ');
      btn.innerHTML = '<b>' + MC.nameOf(r.out.id) + '×' + r.out.n + '</b><span>' + needs + '</span>';
      btn.addEventListener('click', () => {
        const res = MC.craft(inventory, r);
        if (res === 'full') toast('背包满了');
        else if (res === true) dirty = true;
        renderInv(); renderHotbar();
      });
      invRecipesEl.appendChild(btn);
    }
  }

  function openInv() {
    invOpen = true;
    renderInv();
    invEl.classList.remove('hidden');
    if (document.exitPointerLock) document.exitPointerLock();
  }

  function closeInv() {
    invOpen = false;
    invEl.classList.add('hidden');
    if (!isTouch) lockPointer();
  }

  function toggleInv() { if (invOpen) closeInv(); else openInv(); }

  document.getElementById('mc-inv-close').addEventListener('click', closeInv);

  // ---------- Toast ----------

  const toastEl = document.getElementById('mc-toast');
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1800);
  }

  // ---------- 覆盖层菜单 ----------

  const overlay = document.getElementById('mc-overlay');
  const overlayHint = document.getElementById('mc-overlay-hint');
  const btnPlay = document.getElementById('mc-btn-play');
  const btnSave = document.getElementById('mc-btn-save');
  const btnNew = document.getElementById('mc-btn-new');
  const chkPeaceful = document.getElementById('mc-peaceful');
  let started = false;

  const HINT_PC = 'WASD 移动 · 空格跳 · 左键挖/攻击 · 右键放置/吃肉<br>E 背包与合成 · 滚轮/数字键选物品 · Esc 菜单<br>先撸树做工具和火把，晚上有僵尸出没！';
  const HINT_TOUCH = '建议横屏游玩 · 左下摇杆移动 · 右侧滑动转视角 · 右下 挖/放/跳<br>🎒 打开背包与合成 · 点快捷栏选物品<br>先撸树做工具和火把，晚上有僵尸出没！';

  /** 手机端尽量全屏并锁定横屏（需用户手势触发；不支持的浏览器由竖屏提示层兜底） */
  function tryLandscape() {
    try {
      const p = document.documentElement.requestFullscreen
        ? document.documentElement.requestFullscreen() : null;
      const lock = () => {
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      };
      if (p && p.then) p.then(lock, lock); else lock();
    } catch (e) { /* 不支持就算了 */ }
  }

  function showOverlay(withMenu) {
    overlay.classList.remove('hidden');
    overlayHint.innerHTML = isTouch ? HINT_TOUCH : HINT_PC;
    btnPlay.textContent = started ? '继续游戏' : '进入世界';
    btnSave.classList.toggle('hidden', !withMenu);
    btnNew.classList.toggle('hidden', !withMenu);
    chkPeaceful.checked = peaceful;
    btnNew.classList.remove('warn');
    btnNew.textContent = '生成新世界';
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  btnPlay.addEventListener('click', () => {
    hideOverlay();
    btnPlay.blur();
    if (isTouch) tryLandscape(); else lockPointer();
  });
  btnSave.addEventListener('click', () => { saveWorld(false); btnSave.blur(); });
  chkPeaceful.addEventListener('change', () => {
    peaceful = chkPeaceful.checked;
    if (peaceful) { // 切到和平：清掉现有僵尸（不掉战利品）
      for (let i = mobs.length - 1; i >= 0; i--) if (mobs[i].kind === 'zombie') killMob(mobs[i], i, true);
    }
    dirty = true;
  });
  btnNew.addEventListener('click', () => {
    // 二次确认：第一次点击只改变按钮文案
    if (!btnNew.classList.contains('warn')) {
      btnNew.classList.add('warn');
      btnNew.textContent = '确认生成？当前世界将被覆盖';
      return;
    }
    newWorld();
    buildAllChunks();
    renderHotbar();
    renderHearts();
    saveWorld(true);
    toast('新世界已生成');
    hideOverlay();
    if (!isTouch) lockPointer();
  });

  document.getElementById('mc-btn-menu').addEventListener('click', () => showOverlay(true));
  document.getElementById('mc-btn-respawn').addEventListener('click', respawn);

  // ---------- 电脑端：指针锁定 + 键鼠 ----------

  let pointerLocked = false;
  let digHeld = false, placeHeld = false;
  let nextPlaceRepeat = 0;

  function lockPointer() {
    if (canvas.requestPointerLock) canvas.requestPointerLock();
  }

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    document.body.classList.toggle('mc-locked', pointerLocked);
    // Esc 解锁 → 打开菜单（背包打开时不抢）
    if (!pointerLocked && started && !isTouch && !invOpen && !dead) showOverlay(true);
  });

  // 锁定失败（例如 Esc 后的浏览器冷却期）：不卡死，提示用户点击画面重试
  document.addEventListener('pointerlockerror', () => {
    if (started && !isTouch) toast('点击画面锁定视角');
  });

  canvas.addEventListener('click', () => {
    if (started && !isTouch && !pointerLocked && !invOpen && !dead
      && overlay.classList.contains('hidden')) lockPointer();
  });

  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    player.yaw -= e.movementX * 0.0026;
    player.pitch -= e.movementY * 0.0026;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch));
  });

  document.addEventListener('mousedown', (e) => {
    if (!pointerLocked) return;
    if (e.button === 0) digHeld = true;               // 挖掘/攻击在 stepDigging 里持续处理
    if (e.button === 2) { placeHeld = true; doPlace(); nextPlaceRepeat = performance.now() + 300; }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) digHeld = false;
    if (e.button === 2) placeHeld = false;
  });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); });

  window.addEventListener('keydown', (e) => {
    if (!started || dead) return;
    if (e.code === 'KeyE') {
      if (overlay.classList.contains('hidden')) { toggleInv(); e.preventDefault(); }
      return;
    }
    if (e.code === 'Escape' && invOpen) { closeInv(); return; }
    if (invOpen) return;
    keys[e.code] = true;
    if (e.code === 'Space') { jumpHeld = true; e.preventDefault(); }
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5)) - 1;
      if (n >= 0 && n < MC.HOTBAR_SIZE) selectSlot(n);
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'Space') jumpHeld = false;
  });

  window.addEventListener('wheel', (e) => {
    if (!pointerLocked) return;
    selectSlot(selected + (e.deltaY > 0 ? 1 : -1));
  }, { passive: true });

  // 右键按住连续放置
  function handleRepeat(now) {
    if (placeHeld && now >= nextPlaceRepeat) { doPlace(); nextPlaceRepeat = now + 300; }
  }

  // ---------- 手机端：摇杆 + 滑动视角 + 动作按钮 ----------

  const joyZone = document.getElementById('mc-joy-zone');
  const joyBase = document.getElementById('mc-joy-base');
  const joyKnob = document.getElementById('mc-joy-knob');
  let joyTouchId = null, lookTouchId = null, lookLast = null;

  function bindHoldButton(id, onDown, onUp) {
    const el = document.getElementById(id);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(); }, { passive: false });
    el.addEventListener('touchend', (e) => { e.preventDefault(); onUp(); }, { passive: false });
    el.addEventListener('touchcancel', onUp);
  }

  if (isTouch) {
    document.addEventListener('touchstart', (e) => {
      if (!started || !overlay.classList.contains('hidden') || invOpen || dead) return;
      for (const t of e.changedTouches) {
        if (joyZone.contains(t.target)) {
          if (joyTouchId === null) joyTouchId = t.identifier;
        } else if (t.target === canvas && lookTouchId === null) {
          lookTouchId = t.identifier;
          lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      // 面板打开（背包/菜单/死亡页）时不拦截，让浏览器原生滚动
      if (invOpen || dead || !overlay.classList.contains('hidden')) return;
      let handled = false;
      for (const t of e.changedTouches) {
        if (t.identifier === joyTouchId) {
          handled = true;
          const r = joyBase.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
          const l = Math.hypot(dx, dy);
          if (l > 1) { dx /= l; dy /= l; }
          joyVec.x = dx; joyVec.y = -dy;
          joyKnob.style.transform = 'translate(calc(-50% + ' + dx * 30 + 'px), calc(-50% + ' + dy * 30 + 'px))';
        } else if (t.identifier === lookTouchId && lookLast) {
          handled = true;
          player.yaw -= (t.clientX - lookLast.x) * 0.006;
          player.pitch -= (t.clientY - lookLast.y) * 0.006;
          player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch));
          lookLast = { x: t.clientX, y: t.clientY };
        }
      }
      if (handled && e.cancelable) e.preventDefault();
    }, { passive: false });

    function touchEnd(e) {
      for (const t of e.changedTouches) {
        if (t.identifier === joyTouchId) {
          joyTouchId = null;
          joyVec.x = joyVec.y = 0;
          joyKnob.style.transform = 'translate(-50%, -50%)';
        }
        if (t.identifier === lookTouchId) { lookTouchId = null; lookLast = null; }
      }
    }
    document.addEventListener('touchend', touchEnd);
    document.addEventListener('touchcancel', touchEnd);

    bindHoldButton('mc-btn-jump', () => { jumpHeld = true; }, () => { jumpHeld = false; });
    bindHoldButton('mc-btn-dig', () => { digHeld = true; }, () => { digHeld = false; });
    bindHoldButton('mc-btn-place', () => { placeHeld = true; doPlace(); nextPlaceRepeat = performance.now() + 300; }, () => { placeHeld = false; });
    document.getElementById('mc-btn-inv').addEventListener('click', toggleInv);
  }

  // ---------- 自动保存 ----------

  function paused() {
    // 手机竖屏时暂停（提示层已盖住画面）
    if (isTouch && window.innerHeight > window.innerWidth) return true;
    return !started || dead || invOpen || !overlay.classList.contains('hidden');
  }

  window.addEventListener('pagehide', () => { if (started) saveWorld(true); });
  window.addEventListener('beforeunload', () => { if (started) saveWorld(true); });
  setInterval(() => { if (started && dirty && !paused()) saveWorld(true); }, 20000);

  // ---------- 尺寸 ----------

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- 主循环 ----------

  const waterEl = document.getElementById('mc-water');
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const sky = MC.skyState(timeTicks);
    if (!paused()) {
      timeTicks = (timeTicks + dt * 20) % MC.DAY_TICKS; // 一整天 20 分钟
      stepPlayer(dt);
      stepDigging(dt);
      handleRepeat(now);
      stepMobs(dt, sky);
      stepSpawning(dt, sky);
      stepDrops(dt);
      stepTorchLights(dt);
    }
    updateSky();

    camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;

    // 准星高亮
    const hit = castFromCamera();
    if (hit && !paused()) {
      hlBox.visible = true;
      hlBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      hlBox.visible = false;
    }

    // 水下滤镜
    const eyeBlock = MC.getBlock(world, Math.floor(player.pos.x), Math.floor(player.pos.y + EYE), Math.floor(player.pos.z));
    waterEl.style.opacity = eyeBlock === MC.WATER ? '1' : '0';

    renderer.render(scene, camera);
  }

  // ---------- 启动 ----------

  const restored = loadWorld();
  if (!restored) newWorld();
  buildAllChunks();
  renderHotbar();
  renderHearts();
  chkPeaceful.checked = peaceful;
  showOverlay(false);
  started = true;
  requestAnimationFrame(loop);
})();
