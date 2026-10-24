/**
 * 迷你世界渲染与交互层（依赖 three.js 与 minecraft/core.js）。
 * 只做渲染、输入、玩家/怪物物理；地形 / 网格化 / 拾取 / 挖掘规则 / 合成 / 生存规则与目标在 core.js。
 *
 * 玩法（单机生存向）：
 *  昼夜循环，夜晚刷僵尸（白天自燃），猪白天游荡掉肉回血与饥饿；
 *  挖掘有硬度与工具系统（镐挖石头才掉圆石），掉落物自动拾取进背包；
 *  E 打开背包与合成（点击配方即合成），火把提供夜间点光源；
 *  奔跑消耗饥饿，高饥饿缓慢回血，饥饿耗尽扣血；阶段目标引导采集到照明；
 *  摔落/被咬/挨饿扣血，死亡回出生点。和平模式无僵尸且不消耗饥饿。
 *
 * 操控：
 *  电脑 —— 点击画面锁定鼠标转视角，WASD 移动，Shift 奔跑，空格跳，左键挖/攻击，右键放/吃肉，E 背包，Esc 菜单。
 *  手机 —— 左下摇杆移动（推满奔跑），右侧空白处滑动转视角，右下按钮 挖/放/跳，🎒 背包，点快捷栏选物品。
 */
(function () {
  'use strict';

  const MC = window.MinecraftCore;
  const AU = window.McAudio || null; // 音效模块（audio.js），加载失败时静默
  function playS(name, arg) { if (AU) AU.sfx[name](arg); }

  /** 方块 → 音效材质组（模仿 MC 按材质出声） */
  function matOf(id) {
    switch (id) {
      case MC.STONE: case MC.COBBLE: case MC.COAL_ORE: case MC.BEDROCK: return 'stone';
      case MC.LOG: case MC.PLANKS: return 'wood';
      case MC.SAND: return 'sand';
      case MC.LEAVES: return 'leaves';
      default: return 'grass';
    }
  }
  const canvas = document.getElementById('mc-canvas');
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) document.body.classList.add('mc-touch');

  // ---------- 游戏状态与存档 ----------

  const SAVE_KEY = 'minecraft-save-v1'; // 键名沿用 v1，内部 v 字段区分版本
  let world = null;
  let inventory = MC.createInventory();
  let selected = 0;          // 快捷栏当前格（背包前 8 格）
  let timeTicks = 1000;      // 世界时间（0=日出）
  let peaceful = false;      // 和平模式：不刷僵尸、不消耗饥饿
  let dirty = false;         // 有未保存的改动
  let dead = false;
  let vitals = MC.createVitals();
  let quest = MC.createQuest();
  let sprinting = false;

  const player = {
    pos: { x: 0, y: 0, z: 0 }, // 脚底中心
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    onGround: false,
    inWater: false,
    hp: 20,                  // 半心制，20 = 10 颗心
    fallPeak: 0,             // 滞空期间的最高点，落地算摔落伤害
    attackCd: 0,
    hurtCd: 0,
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
    vitals = MC.createVitals();
    quest = MC.createQuest();
    player.hp = 20;
    player.hurtCd = 0;
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
      if (!save || ![1, 2, 3].includes(save.v)) return false;
      world = MC.decodeWorld(save.seed, save.data);
      if (save.player) {
        player.pos.x = save.player.x; player.pos.y = save.player.y; player.pos.z = save.player.z;
        player.yaw = save.player.yaw || 0; player.pitch = save.player.pitch || 0;
        if (typeof save.player.hp === 'number') player.hp = save.player.hp;
      }
      if (save.v >= 2) {
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
      vitals = MC.createVitals();
      if (save.v >= 3 && Number.isFinite(save.hunger)) {
        vitals.hunger = Math.max(0, Math.min(MC.HUNGER_MAX, save.hunger));
      }
      if (save.v >= 3 && save.quest) {
        const step = Math.max(0, Math.min(MC.QUESTS.length, save.quest.step | 0));
        quest = { step, count: 0, done: step === MC.QUESTS.length };
        if (!quest.done) {
          quest.count = Math.max(0, Math.min(MC.QUESTS[step].target - 1, save.quest.count | 0));
        }
      } else {
        quest = { step: MC.QUESTS.length, count: 0, done: true };
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
        v: 3,
        seed: world.seed,
        data: MC.encodeWorld(world),
        player: { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch, hp: player.hp },
        time: Math.floor(timeTicks),
        peaceful,
        inv: inventory,
        selected,
        hunger: vitals.hunger,
        quest,
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
        base('#649b43'); speckle(['#5d903d', '#6ba348', '#6fa94b', '#58873b'], 64); break;
      case T.GRASS_SIDE: {
        base('#866043'); speckle(['#79553c', '#91694a'], 46);
        g.fillStyle = '#649b43'; g.fillRect(ox, oy, TILE_PX, 3);
        g.fillStyle = '#587f38';
        for (let x = 0; x < TILE_PX; x++) { if (prand() < 0.4) g.fillRect(ox + x, oy + 3, 1, 1 + ((prand() * 2) | 0)); }
        break;
      }
      case T.DIRT: base('#866043'); speckle(['#79553c', '#91694a', '#714d36'], 52); break;
      case T.STONE: base('#85898a'); speckle(['#787c7d', '#909495', '#727677'], 64); break;
      case T.SAND: base('#d9cd9d'); speckle(['#cabe8e', '#e4d9ac', '#c4b582'], 48); break;
      case T.WATER: {
        base('#3579b8');
        g.fillStyle = '#4b91c4';
        for (let i = 0; i < 4; i++) { const y = (prand() * TILE_PX) | 0; g.fillRect(ox, oy + y, TILE_PX, 1); }
        speckle(['#65a6cf', '#2e6ca9'], 16); break;
      }
      case T.LOG_SIDE: {
        base('#674b2c');
        g.fillStyle = '#523b24';
        for (let x = 0; x < TILE_PX; x++) { if (x % 4 === 0 || prand() < 0.08) g.fillRect(ox + x, oy, 1, TILE_PX); }
        speckle(['#795b35'], 24); break;
      }
      case T.LOG_TOP: {
        base('#9c7b4d');
        g.strokeStyle = '#745b36';
        for (let r = 1; r < 8; r += 2) g.strokeRect(ox + 8 - r, oy + 8 - r, r * 2, r * 2);
        break;
      }
      case T.LEAVES: base('#3f7436'); speckle(['#37682f', '#4a8040', '#32602c', '#568b46'], 72); break;
      case T.BEDROCK: base('#3a3d40'); speckle(['#24272a', '#51565a', '#303438'], 72, 2); break;
      case T.COBBLE: {
        base('#777d7e');
        for (let i = 0; i < 7; i++) {
          const w = 4 + ((prand() * 4) | 0), h = 3 + ((prand() * 3) | 0);
          const x = (prand() * (TILE_PX - w)) | 0, y = (prand() * (TILE_PX - h)) | 0;
          g.fillStyle = '#565c5d'; g.fillRect(ox + x - 1, oy + y - 1, w + 2, h + 2);
          g.fillStyle = '#929899'; g.fillRect(ox + x, oy + y, w, h);
        }
        break;
      }
      case T.PLANKS: {
        base('#a7824d');
        g.fillStyle = '#806239';
        for (let y = 3; y < TILE_PX; y += 4) g.fillRect(ox, oy + y, TILE_PX, 1);
        for (let y = 0; y < TILE_PX; y += 4) g.fillRect(ox + ((y * 7) % TILE_PX), oy + y, 1, 3);
        speckle(['#b38f58'], 16); break;
      }
      case T.COAL_ORE: {
        base('#85898a'); speckle(['#787c7d', '#909495'], 56);
        g.fillStyle = '#25282a';
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

  function prepareTexture(tex) {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function makeAtlasTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = ATLAS_PX;
    const g = c.getContext('2d');
    for (let t = 0; t < 16; t++) paintTile(g, t, (t % 4) * TILE_PX, Math.floor(t / 4) * TILE_PX);
    return prepareTexture(new THREE.CanvasTexture(c));
  }

  function makeWaterTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    paintTile(c.getContext('2d'), MC.TILE.WATER, 0, 0);
    const tex = prepareTexture(new THREE.CanvasTexture(c));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // ---------- Three.js 场景 ----------

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 300);
  scene.add(camera);
  scene.fog = new THREE.Fog(0xb7d8df, 36, 108);

  const hemi = new THREE.HemisphereLight(0xe5efff, 0x596047, 0.65);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3dc, 0.5);
  scene.add(sun);
  scene.add(sun.target);

  const atlasTex = makeAtlasTexture();
  const waterTex = makeWaterTexture();
  const solidMat = new THREE.MeshLambertMaterial({ map: atlasTex });
  const waterMat = new THREE.MeshLambertMaterial({
    map: waterTex, transparent: true, opacity: 0.68, depthWrite: false,
  });

  const SKY_DAY_TOP = new THREE.Color(0x4f91cf);
  const SKY_DAY_HORIZON = new THREE.Color(0xbdd9df);
  const SKY_NIGHT_TOP = new THREE.Color(0x050a1b);
  const SKY_NIGHT_HORIZON = new THREE.Color(0x172641);
  const SKY_DUSK = new THREE.Color(0xdf8c5c);
  const SKY_DAY_BOTTOM = new THREE.Color(0x7c8c76);
  const SKY_NIGHT_BOTTOM = new THREE.Color(0x111821);
  const skyTop = new THREE.Color();
  const skyHorizon = new THREE.Color();
  const skyBottom = new THREE.Color();

  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 1;
  skyCanvas.height = 64;
  const skyCtx = skyCanvas.getContext('2d');
  const skyTex = prepareTexture(new THREE.CanvasTexture(skyCanvas));
  skyTex.magFilter = THREE.LinearFilter;
  skyTex.minFilter = THREE.LinearFilter;
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(180, 24, 16),
    new THREE.MeshBasicMaterial({
      map: skyTex, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    })
  );
  skyDome.renderOrder = -10;
  scene.add(skyDome);
  const skyStripColor = new THREE.Color();

  function updateSkyTexture() {
    for (let y = 0; y < 64; y++) {
      const t = y / 63;
      if (t < 0.5) {
        skyStripColor.copy(skyHorizon).lerp(skyTop, Math.pow(1 - t * 2, 0.7));
      } else {
        skyStripColor.copy(skyHorizon).lerp(skyBottom, Math.min(1, (t - 0.5) * 6));
      }
      skyCtx.fillStyle = '#' + skyStripColor.getHex().toString(16).padStart(6, '0');
      skyCtx.fillRect(0, y, 1, 1);
    }
    skyTex.needsUpdate = true;
  }

  function makeOrbTexture(moon) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = moon ? '#d7e3ed' : '#ffe6a0';
    g.fillRect(4, 8, 24, 16);
    g.fillRect(8, 4, 16, 24);
    g.fillStyle = moon ? '#edf4f7' : '#fff4c8';
    g.fillRect(8, 8, 16, 16);
    if (moon) {
      g.fillStyle = '#aebfcb';
      g.fillRect(10, 10, 5, 5);
      g.fillRect(19, 17, 4, 6);
      g.fillRect(9, 21, 3, 3);
    }
    return prepareTexture(new THREE.CanvasTexture(c));
  }

  const sunOrb = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshBasicMaterial({ map: makeOrbTexture(false), transparent: true, fog: false, depthWrite: false })
  );
  const moonOrb = new THREE.Mesh(
    new THREE.PlaneGeometry(15, 15),
    new THREE.MeshBasicMaterial({ map: makeOrbTexture(true), transparent: true, fog: false, depthWrite: false })
  );
  scene.add(sunOrb);
  scene.add(moonOrb);

  const starPositions = [];
  for (let i = 0; i < 140; i++) {
    const y = 0.12 + prand() * 0.88;
    const a = prand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    starPositions.push(Math.cos(a) * r * 155, y * 155, Math.sin(a) * r * 155);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xdde8ff, size: 1.6, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  const clouds = [];
  const cloudGeo = new THREE.BoxGeometry(1, 1, 1);
  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xf4f7f5, transparent: true, opacity: 0.55, depthWrite: false,
  });
  for (let i = 0; i < 7; i++) {
    const group = new THREE.Group();
    for (let j = 0; j < 3; j++) {
      const part = new THREE.Mesh(cloudGeo, cloudMat);
      part.scale.set(7 + ((i + j) % 3) * 3, 0.65, 3 + (j % 2) * 2);
      part.position.set(j * 5 - 5, j === 1 ? 0.5 : 0, (j - 1) * 1.5);
      group.add(part);
    }
    group.userData.baseX = (i % 4) * 31 - 46;
    group.userData.baseZ = Math.floor(i / 4) * 85 - 65 + (i % 2) * 9;
    group.position.y = 45 + (i % 3) * 2;
    scene.add(group);
    clouds.push(group);
  }

  // 选中方块的高亮线框
  const hlBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0x17202a, transparent: true, opacity: 0.75 })
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

  /** 昼夜推进：天空、日月、云层、水面与光照共用同一时间 */
  function updateSky() {
    const s = MC.skyState(timeTicks);
    const d = s.dayFactor;
    const dusk = Math.max(0, 1 - Math.abs(s.sunHeight) * 4) * 0.65;
    skyTop.copy(SKY_NIGHT_TOP).lerp(SKY_DAY_TOP, d);
    skyHorizon.copy(SKY_NIGHT_HORIZON).lerp(SKY_DAY_HORIZON, d);
    skyHorizon.lerp(SKY_DUSK, dusk * Math.min(1, d + 0.35));
    skyBottom.copy(SKY_NIGHT_BOTTOM).lerp(SKY_DAY_BOTTOM, d);
    updateSkyTexture();
    scene.background = skyHorizon;
    scene.fog.color.copy(skyHorizon);
    hemi.intensity = 0.2 + d * 0.45;
    sun.intensity = 0.025 + d * 0.5;

    const dx = Math.cos(s.angle) * 0.55, dy = Math.sin(s.angle) * 0.55, dz = -0.65;
    const invLen = 1 / Math.hypot(dx, dy, dz);
    const sx = dx * invLen, sy = dy * invLen, sz = dz * invLen;
    const ex = player.pos.x, ey = player.pos.y + EYE, ez = player.pos.z;
    skyDome.position.set(ex, ey, ez);
    stars.position.set(ex, ey, ez);
    stars.rotation.y = timeTicks * 0.00001;
    starMat.opacity = Math.max(0, (0.55 - d) / 0.55) * 0.85;
    stars.visible = starMat.opacity > 0.02;

    sunOrb.position.set(ex + sx * 130, ey + sy * 130, ez + sz * 130);
    moonOrb.position.set(ex - sx * 130, ey - sy * 130, ez - sz * 130);
    sunOrb.lookAt(ex, ey, ez);
    moonOrb.lookAt(ex, ey, ez);
    sunOrb.visible = sy > -0.12;
    moonOrb.visible = sy < 0.12;
    sun.position.set(ex + sx * 90, ey + sy * 90, ez + sz * 90);
    sun.target.position.set(ex, player.pos.y, ez);

    for (const cloud of clouds) {
      const drift = cloud.userData.baseX + timeTicks * 0.008;
      cloud.position.x = ex + ((drift + 60) % 120 + 120) % 120 - 60;
      cloud.position.z = ez + cloud.userData.baseZ;
    }
    cloudMat.opacity = 0.2 + d * 0.35;
    waterTex.offset.set((timeTicks * 0.00035) % 1, (timeTicks * 0.0002) % 1);
    waterMat.opacity = 0.66 + Math.sin(timeTicks * 0.025) * 0.03;
  }

  // ---------- 区块网格 ----------

  const chunkMeshes = []; // [cz][cx] -> { solid, water }

  function toMesh(data, mat, isWater) {
    if (!data.indices.length) return null;
    const g = new THREE.BufferGeometry();
    const uvs = isWater ? data.uvs.slice() : data.uvs;
    if (isWater) {
      const tu = MC.TILE.WATER % 4, tv = Math.floor(MC.TILE.WATER / 4);
      for (let i = 0; i < uvs.length; i += 2) {
        uvs[i] = uvs[i] * 4 - tu;
        uvs[i + 1] = uvs[i + 1] * 4 + tv - 3;
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
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
    chunkMeshes[cz][cx] = { solid: toMesh(data.solid, solidMat), water: toMesh(data.water, waterMat, true) };
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
  let stepSfxT = 0; // 脚步声音节流
  let walkPhase = 0;
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

    sprinting = len > 0.1 && !player.inWater && vitals.hunger > 0
      && (keys.ShiftLeft || keys.ShiftRight || (isTouch && len > 0.92));
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    const speed = player.inWater ? 2.8 : sprinting ? 6.5 : 4.5;
    player.vel.x = (ix * cos - iy * sin) * speed;
    player.vel.z = (-iy * cos - ix * sin) * speed;

    const wasOnGround = player.onGround;
    if (!player.onGround) player.fallPeak = Math.max(player.fallPeak, player.pos.y);

    const r = stepBody(player, HALF, HEIGHT, dt, { swim: jumpHeld });
    player.inWater = r.inWater;

    if (!wasOnGround && player.onGround) {
      const fall = player.fallPeak - player.pos.y;
      if (fall > 3.5 && !player.inWater) hurtPlayer(Math.floor(fall - 3), '摔落', true);
      player.fallPeak = player.pos.y;
    }
    if (player.onGround) player.fallPeak = player.pos.y;

    if (jumpHeld && player.onGround && !player.inWater) player.vel.y = 8.8;

    // 脚步声：着地行走时按脚下材质发声
    if (player.onGround && !player.inWater && Math.hypot(player.vel.x, player.vel.z) > 1) {
      walkPhase += dt * (sprinting ? 12 : 8);
      stepSfxT -= dt;
      if (stepSfxT <= 0) {
        const under = MC.getBlock(world, Math.floor(player.pos.x), Math.floor(player.pos.y - 0.5), Math.floor(player.pos.z));
        if (MC.isOpaque(under)) playS('step', matOf(under));
        stepSfxT = sprinting ? 0.24 : 0.33;
      }
    } else {
      stepSfxT = 0;
    }

    if (player.pos.y < -8) spawnAtStart(); // 兜底：掉出世界回出生点

    player.attackCd = Math.max(0, player.attackCd - dt);
    player.hurtCd = Math.max(0, player.hurtCd - dt);
  }

  // ---------- 生命、饥饿与目标 ----------

  const hurtEl = document.getElementById('mc-hurt');
  const heartsEl = document.getElementById('mc-hearts');
  const hungerEl = document.getElementById('mc-hunger');
  const questEl = document.getElementById('mc-quest');
  const clockEl = document.getElementById('mc-clock');

  function renderHearts() {
    let s = '';
    for (let i = 0; i < 10; i++) {
      const v = player.hp - i * 2;
      s += '<span class="' + (v >= 2 ? 'full' : v === 1 ? 'half' : 'empty') + '">♥</span>';
    }
    heartsEl.innerHTML = s;
  }

  function renderHunger() {
    let s = '';
    for (let i = 0; i < 10; i++) {
      const v = vitals.hunger - i * 2;
      s += '<span class="' + (v >= 2 ? 'full' : v === 1 ? 'half' : 'empty') + '">◆</span>';
    }
    hungerEl.innerHTML = s;
    hungerEl.setAttribute('aria-label', '饥饿值 ' + Math.ceil(vitals.hunger) + '/' + MC.HUNGER_MAX);
  }

  function renderQuest() {
    if (quest.done) {
      questEl.innerHTML = '<span>生存准备完成</span><b>自由建造</b>';
    } else {
      const q = MC.QUESTS[quest.step];
      questEl.innerHTML = '<span>当前目标 ' + (quest.step + 1) + '/' + MC.QUESTS.length + '</span>'
        + '<b>' + q.text + '</b><small>' + quest.count + ' / ' + q.target + '</small>';
    }
    questEl.classList.toggle('done', quest.done);
  }

  function recordQuest(event, id, n = 1) {
    const previous = quest.step;
    const result = MC.advanceQuest(quest, event, id, n);
    if (!result.changed) return;
    renderQuest();
    dirty = true;
    if (result.completed) {
      toast(result.done ? '生存准备完成，开始自由建造吧' : '目标完成：' + MC.QUESTS[previous].text);
      playS('craft');
    }
  }

  let lastClockLabel = '';
  function renderClock(sky) {
    const label = sky.night ? '夜晚 · 小心僵尸'
      : sky.dayFactor < 0.75 ? (sky.angle < Math.PI ? '清晨' : '傍晚') : '白天';
    if (label !== lastClockLabel) {
      clockEl.textContent = label;
      clockEl.classList.toggle('night', sky.night);
      lastClockLabel = label;
    }
  }

  function stepVitals(dt) {
    const oldHunger = vitals.hunger;
    const change = MC.tickVitals(vitals, dt, sprinting, peaceful);
    if (vitals.hunger !== oldHunger) {
      renderHunger();
      dirty = true;
    }
    if (change.heal && player.hp < 20) {
      player.hp = Math.min(20, player.hp + change.heal);
      renderHearts();
      dirty = true;
    }
    if (change.damage) hurtPlayer(change.damage, '饥饿', true);
  }

  function hurtPlayer(dmg, why, force) {
    if (dead || dmg <= 0 || (!force && player.hurtCd > 0)) return;
    player.hurtCd = 0.45;
    player.hp -= dmg;
    playS('hurt');
    hurtEl.style.opacity = '0.55';
    setTimeout(() => { hurtEl.style.opacity = '0'; }, 180);
    renderHearts();
    dirty = true;
    if (player.hp <= 0) die(why);
  }

  function die(why) {
    dead = true;
    player.hp = 0;
    const messages = {
      '摔落': '你从高处摔了下来',
      '僵尸': '你被僵尸咬死了',
      '饥饿': '你饿死了，记得及时进食',
    };
    document.getElementById('mc-death-cause').textContent = messages[why] || '你倒在了世界里';
    document.getElementById('mc-death').classList.remove('hidden');
    playS('death');
    if (document.exitPointerLock) document.exitPointerLock();
  }

  function respawn() {
    dead = false;
    player.hp = 20;
    player.hurtCd = 0;
    vitals = MC.createVitals();
    sprinting = false;
    spawnAtStart();
    renderHearts();
    renderHunger();
    document.getElementById('mc-death').classList.add('hidden');
    playS('respawn');
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
      const tex = prepareTexture(new THREE.CanvasTexture(c));
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

  // ---------- 固定池粒子与命中反馈 ----------

  const particleGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
  const particleMats = new Map();
  const particles = [];
  const PARTICLE_COUNT = isTouch ? 48 : 80;
  let particleCursor = 0;

  function particleMaterial(color) {
    if (!particleMats.has(color)) {
      particleMats.set(color, new THREE.MeshBasicMaterial({ color }));
    }
    return particleMats.get(color);
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const mesh = new THREE.Mesh(particleGeo, particleMaterial(0xffffff));
    mesh.visible = false;
    scene.add(mesh);
    particles.push({ mesh, vel: { x: 0, y: 0, z: 0 }, life: 0, maxLife: 1, gravity: 9 });
  }

  function spawnBurst(x, y, z, color, count = 8, power = 2.2, gravity = 9) {
    for (let i = 0; i < count; i++) {
      const p = particles[particleCursor];
      particleCursor = (particleCursor + 1) % particles.length;
      p.life = p.maxLife = 0.35 + Math.random() * 0.35;
      p.gravity = gravity;
      p.mesh.material = particleMaterial(color);
      p.mesh.position.set(x + (Math.random() - 0.5) * 0.35, y + Math.random() * 0.25, z + (Math.random() - 0.5) * 0.35);
      p.mesh.scale.set(0.7 + Math.random() * 0.7, 0.7 + Math.random() * 0.7, 0.7 + Math.random() * 0.7);
      p.vel.x = (Math.random() - 0.5) * power;
      p.vel.y = 0.5 + Math.random() * power;
      p.vel.z = (Math.random() - 0.5) * power;
      p.mesh.visible = true;
    }
  }

  const BLOCK_COLORS = {
    [MC.GRASS]: 0x649b43, [MC.DIRT]: 0x866043, [MC.STONE]: 0x85898a,
    [MC.SAND]: 0xd9cd9d, [MC.LOG]: 0x674b2c, [MC.LEAVES]: 0x3f7436,
    [MC.COBBLE]: 0x777d7e, [MC.PLANKS]: 0xa7824d, [MC.COAL_ORE]: 0x35393b,
    [MC.TORCH]: 0xffb020,
  };

  function spawnBlockBurst(x, y, z, id, count = 10) {
    spawnBurst(x + 0.5, y + 0.5, z + 0.5, BLOCK_COLORS[id] || 0xcccccc, count);
  }

  const crosshairEl = document.getElementById('mc-crosshair');
  let hitMarkerT = 0;
  function flashHitmarker() {
    hitMarkerT = 0.13;
    crosshairEl.classList.add('hit');
  }

  function stepParticles(dt) {
    if (hitMarkerT > 0) {
      hitMarkerT -= dt;
      if (hitMarkerT <= 0) crosshairEl.classList.remove('hit');
    }
    for (const p of particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.x += p.vel.x * dt;
      p.mesh.position.y += p.vel.y * dt;
      p.mesh.position.z += p.vel.z * dt;
      p.mesh.rotation.x += dt * 5;
      p.mesh.rotation.y += dt * 7;
      const scale = Math.max(0.05, p.life / p.maxLife);
      p.mesh.scale.set(scale, scale, scale);
    }
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
        if (left === 0) {
          playS('pickup');
          dirty = true;
          renderHotbar();
          if (invOpen) renderInv();
          recordQuest('collect', d.id);
          scene.remove(d.mesh);
          drops.splice(i, 1);
          continue;
        }
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
    add(new THREE.BoxGeometry(0.5, 0.5, 0.5), lam(0x4a9a4a), 0, 1.6, 0);
    add(new THREE.BoxGeometry(0.5, 0.7, 0.28), lam(0x2a8f8f), 0, 1.0, 0);
    const leftLeg = add(new THREE.BoxGeometry(0.2, 0.65, 0.2), lam(0x2a3a8f), -0.13, 0.33, 0);
    const rightLeg = add(new THREE.BoxGeometry(0.2, 0.65, 0.2), lam(0x2a3a8f), 0.13, 0.33, 0);
    const leftArm = add(new THREE.BoxGeometry(0.16, 0.16, 0.55), lam(0x4a9a4a), -0.33, 1.15, 0.25);
    const rightArm = add(new THREE.BoxGeometry(0.16, 0.16, 0.55), lam(0x4a9a4a), 0.33, 1.15, 0.25);
    add(new THREE.BoxGeometry(0.08, 0.08, 0.02), lam(0x101010), -0.1, 1.65, 0.26);
    add(new THREE.BoxGeometry(0.08, 0.08, 0.02), lam(0x101010), 0.1, 1.65, 0.26);
    g.userData.parts = { leftLeg, rightLeg, leftArm, rightArm };
    return g;
  }

  function makePigMesh() {
    const g = new THREE.Group();
    const pink = lam(0xe8a0a8);
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    add(new THREE.BoxGeometry(0.55, 0.5, 0.9), pink, 0, 0.62, 0);
    add(new THREE.BoxGeometry(0.45, 0.45, 0.4), pink, 0, 0.85, 0.6);
    add(new THREE.BoxGeometry(0.2, 0.15, 0.08), lam(0xc9838c), 0, 0.78, 0.82);
    const legs = [];
    for (const [x, z] of [[-0.18, 0.3], [0.18, 0.3], [-0.18, -0.3], [0.18, -0.3]]) {
      legs.push(add(new THREE.BoxGeometry(0.15, 0.38, 0.15), lam(0xd88f98), x, 0.19, z));
    }
    g.userData.parts = { legs };
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
      walkT: Math.random() * 6, burnFxT: 0, burning: false, emissive: 0,
      windup: 0, panicT: 0,
      sfxT: 2 + Math.random() * 5, // 环境叫声计时
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
    spawnBurst(m.pos.x, m.pos.y + m.cfg.height * 0.5, m.pos.z, m.kind === 'pig' ? 0xe8a0a8 : 0x4a9a4a, 12, 2.8, 8);
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
        m.burning = sky.dayFactor > 0.5
          && MC.getBlock(world, Math.floor(m.pos.x), Math.floor(m.pos.y + m.cfg.height + 0.5), Math.floor(m.pos.z)) === MC.AIR;
        if (m.burning) {
          m.hp -= 2 * dt;
          if (m.hp <= 0) { killMob(m, i); continue; }
          m.burnFxT -= dt;
          if (m.burnFxT <= 0) {
            spawnBurst(m.pos.x, m.pos.y + m.cfg.height * 0.7, m.pos.z, Math.random() < 0.5 ? 0xff8a20 : 0xffc04a, 1, 1.1, -1.5);
            m.burnFxT = 0.16;
          }
        }

        if (!dead && dist > 0.01) {
          m.yaw = Math.atan2(dx, dz);
          m.attackCd -= dt;
          if (m.windup > 0) {
            m.vel.x = m.vel.z = 0;
            m.windup -= dt;
            if (m.windup <= 0) {
              if (dist <= m.cfg.reach + 0.4) hurtPlayer(m.cfg.dmg, '僵尸');
              m.attackCd = 1;
            }
          } else if (dist > m.cfg.reach) {
            m.vel.x = dx / dist * m.cfg.speed;
            m.vel.z = dz / dist * m.cfg.speed;
          } else {
            m.vel.x = m.vel.z = 0;
            if (m.attackCd <= 0) {
              m.windup = 0.32;
              playS('zombie');
            }
          }
        } else { m.vel.x = m.vel.z = 0; }
      } else if (m.panicT > 0 && dist > 0.01) {
        m.panicT -= dt;
        m.yaw = Math.atan2(-dx, -dz);
        m.vel.x = -dx / dist * m.cfg.speed * 1.35;
        m.vel.z = -dz / dist * m.cfg.speed * 1.35;
      } else {
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

      m.sfxT -= dt;
      if (m.sfxT <= 0) {
        m.sfxT = 4 + Math.random() * 6;
        const range = m.kind === 'zombie' ? 14 : 9;
        if (dist < range) playS(m.kind === 'zombie' ? 'zombie' : 'pig');
      }

      const moveSpeed = Math.hypot(m.vel.x, m.vel.z);
      m.walkT += dt * (2 + moveSpeed * 3);
      const swing = Math.sin(m.walkT) * Math.min(0.65, moveSpeed * 0.28);
      const parts = m.mesh.userData.parts;
      if (m.kind === 'zombie') {
        parts.leftLeg.rotation.x = swing;
        parts.rightLeg.rotation.x = -swing;
        const armAngle = m.windup > 0 ? -1.15 : 0.15;
        parts.leftArm.rotation.x = armAngle + swing * 0.2;
        parts.rightArm.rotation.x = armAngle - swing * 0.2;
      } else {
        for (let leg = 0; leg < parts.legs.length; leg++) {
          parts.legs[leg].rotation.x = leg % 2 ? swing : -swing;
        }
      }

      m.flashT = Math.max(0, m.flashT - dt);
      const glow = m.flashT > 0 ? 0xff3333 : m.burning ? 0x663300 : 0x000000;
      if (glow !== m.emissive) {
        for (const mt of m.mats) mt.emissive.setHex(glow);
        m.emissive = glow;
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

  // ---------- 第一人称手部与物品 ----------

  const handRoot = new THREE.Group();
  const handArmGeo = new THREE.BoxGeometry(0.15, 0.38, 0.15);
  const handBlockGeo = new THREE.BoxGeometry(0.27, 0.27, 0.27);
  const handToolGeo = new THREE.PlaneGeometry(0.38, 0.38);
  const handArmMat = new THREE.MeshLambertMaterial({ color: 0xa66f4c, depthTest: false, depthWrite: false });
  const handItemMats = new Map();
  let handItemId = null;
  let handSwing = 0;
  let actionPhase = 0;
  camera.add(handRoot);
  handRoot.scale.set(0.82, 0.82, 0.82);

  function handItemMaterial(id) {
    if (!handItemMats.has(id)) {
      const c = document.createElement('canvas');
      c.width = c.height = TILE_PX;
      paintIcon(c.getContext('2d'), id);
      handItemMats.set(id, new THREE.MeshBasicMaterial({
        map: prepareTexture(new THREE.CanvasTexture(c)), transparent: true,
        side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      }));
    }
    return handItemMats.get(id);
  }

  function syncHandItem() {
    const slot = inventory[selected];
    const id = slot ? slot.id : 0;
    if (id === handItemId) return;
    handItemId = id;
    while (handRoot.children.length) handRoot.remove(handRoot.children[0]);
    const arm = new THREE.Mesh(handArmGeo, handArmMat);
    arm.position.set(0.07, -0.1, 0.02);
    arm.rotation.z = -0.3;
    arm.renderOrder = 999;
    handRoot.add(arm);
    if (slot) {
      const item = new THREE.Mesh(MC.isItem(id) ? handToolGeo : handBlockGeo, handItemMaterial(id));
      item.position.set(-0.03, 0.06, -0.02);
      item.rotation.z = -0.22;
      item.renderOrder = 1000;
      handRoot.add(item);
    }
  }

  function updateHand(dt) {
    syncHandItem();
    const active = !paused() && !dead;
    handRoot.visible = active;
    handSwing = Math.max(0, handSwing - dt * 4);
    if (digHeld && active) actionPhase += dt * 10;
    const swing = digHeld && active ? (Math.sin(actionPhase) + 1) * 0.5 : handSwing;
    const moving = active && player.onGround && Math.hypot(player.vel.x, player.vel.z) > 0.2;
    const bob = moving ? Math.sin(walkPhase) * 0.025 : 0;
    handRoot.position.set(0.44 + bob * 0.5, -0.32 + Math.abs(bob) * 0.5 - swing * 0.08, -0.82 - swing * 0.12);
    handRoot.rotation.x = -swing * 0.75;
    handRoot.rotation.y = -0.15;
    handRoot.rotation.z = -0.12 - swing * 0.25;

    const targetFov = active && sprinting ? 82 : 75;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 8);
      camera.updateProjectionMatrix();
    }
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
    handSwing = 1;
    playS('hit');
    const d = lookDir();
    m.vel.x += d.x * 6; m.vel.z += d.z * 6; m.vel.y = 3.5;
    m.flashT = 0.15;
    if (m.kind === 'pig') m.panicT = 3;
    for (const mt of m.mats) mt.emissive.setHex(0xff3333);
    spawnBurst(m.pos.x, m.pos.y + m.cfg.height * 0.65, m.pos.z, 0xd96459, 6, 1.8, 4);
    flashHitmarker();
    if (m.hp <= 0) {
      playS('mobDie');
      const idx = mobs.indexOf(m);
      if (idx >= 0) killMob(m, idx);
    }
  }

  let digTarget = null; // {x,y,z,progress}
  const ringEl = document.getElementById('mc-ring');
  const crackTextures = [];
  for (let stage = 0; stage < 5; stage++) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(18, 22, 25, 0.82)';
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (let arm = 0; arm < 4 + stage; arm++) {
      let x = 8, y = 8;
      const dir = dirs[arm];
      for (let n = 0; n < 2 + stage; n++) {
        x = Math.max(0, Math.min(15, x + dir[0]));
        y = Math.max(0, Math.min(15, y + dir[1]));
        g.fillRect(x, y, 1, 1);
        if (n % 2 === 1) g.fillRect(Math.max(0, x - dir[1]), Math.max(0, y - dir[0]), 1, 1);
      }
    }
    crackTextures.push(prepareTexture(new THREE.CanvasTexture(c)));
  }
  const crackMat = new THREE.MeshBasicMaterial({
    map: crackTextures[0], transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2,
  });
  const crackBox = new THREE.Mesh(new THREE.BoxGeometry(1.006, 1.006, 1.006), crackMat);
  crackBox.visible = false;
  crackBox.renderOrder = 3;
  scene.add(crackBox);

  function updateCracks() {
    if (!digHeld || !digTarget || paused()) { crackBox.visible = false; return; }
    const stage = Math.min(4, Math.floor(digTarget.progress * 5));
    crackMat.map = crackTextures[stage];
    crackBox.position.set(digTarget.x + 0.5, digTarget.y + 0.5, digTarget.z + 0.5);
    crackBox.visible = true;
  }

  function setRing(p) {
    if (p === null) { ringEl.style.display = 'none'; return; }
    ringEl.style.display = 'block';
    ringEl.style.background = 'conic-gradient(rgba(255,255,255,0.9) ' + Math.floor(p * 360) + 'deg, rgba(255,255,255,0.15) 0deg)';
  }

  /** 主键行为：优先打怪，其次挖方块（带硬度进度） */
  let digSfxT = 0; // 挖掘摩擦音节流
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
    if (!isFinite(dur)) { digTarget = null; setRing(null); return; } // 基岩
    digTarget.progress += dt / dur;
    digSfxT -= dt;
    if (digSfxT <= 0) { playS('dig', matOf(hit.id)); digSfxT = 0.25; }
    setRing(Math.min(1, digTarget.progress));
    if (digTarget.progress >= 1) {
      const dropId = MC.dropFor(hit.id, currentToolId());
      if (MC.setBlock(world, hit.x, hit.y, hit.z, MC.AIR)) {
        rebuildAround(hit.x, hit.z);
        if (dropId) spawnDrop(dropId, hit.x, hit.y, hit.z);
        spawnBlockBurst(hit.x, hit.y, hit.z, hit.id);
        playS('break', matOf(hit.id));
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
    if (slot.id === MC.MEAT) {
      if (player.hp >= 20 && vitals.hunger >= MC.HUNGER_MAX) { toast('生命与饥饿值已满'); return; }
      player.hp = Math.min(20, player.hp + MC.ITEMS[MC.MEAT].heal);
      vitals.hunger = Math.min(MC.HUNGER_MAX, vitals.hunger + MC.ITEMS[MC.MEAT].food);
      if (--slot.n <= 0) inventory[selected] = null;
      handSwing = 1;
      playS('eat');
      renderHearts(); renderHunger(); renderHotbar();
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
    recordQuest('place', slot.id);
    handSwing = 1;
    spawnBlockBurst(x, y, z, slot.id, 4);
    if (--slot.n <= 0) inventory[selected] = null;
    rebuildAround(x, z);
    playS('place');
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
        else if (res === true) {
          playS('craft');
          recordQuest('craft', r.out.id);
          dirty = true;
        }
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

  const HINT_PC = 'WASD 移动 · Shift 奔跑 · 空格跳 · 左键挖/攻击 · 右键放置/进食<br>E 背包与合成 · 滚轮/数字键选物品 · Esc 菜单<br>跟随左上角目标准备营地；吃肉恢复生命与饥饿！';
  const HINT_TOUCH = '建议横屏游玩 · 左下摇杆移动（推满奔跑） · 右侧滑动转视角 · 右下 挖/放/跳<br>🎒 打开背包与合成 · 点快捷栏选物品<br>跟随左上角目标准备营地；吃肉恢复生命与饥饿！';

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
    if (AU) { AU.ensure(); AU.startBgm(); } // 音频需用户手势启动
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
    renderHunger();
    renderQuest();
    saveWorld(true);
    toast('新世界已生成');
    hideOverlay();
    if (!isTouch) lockPointer();
  });

  document.getElementById('mc-btn-menu').addEventListener('click', () => showOverlay(true));
  document.getElementById('mc-btn-respawn').addEventListener('click', respawn);

  // 音效开关
  const btnMute = document.getElementById('mc-btn-mute');
  function syncMuteBtn() { btnMute.textContent = AU && AU.isMuted() ? '🔇' : '🔊'; }
  btnMute.addEventListener('click', () => {
    if (!AU) return;
    AU.setMuted(!AU.isMuted());
    syncMuteBtn();
  });

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
  let joyPointerId = null, lookPointerId = null, lookLast = null;

  function capturePointer(el, pointerId) {
    if (!el.setPointerCapture) return;
    try { el.setPointerCapture(pointerId); } catch { /* 指针已结束时忽略 */ }
  }

  function bindHoldButton(id, onDown, onUp) {
    const el = document.getElementById(id);
    let activePointer = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || activePointer !== null) return;
      e.preventDefault();
      activePointer = e.pointerId;
      capturePointer(el, e.pointerId);
      onDown();
    }, { passive: false });
    const release = (e) => {
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      if (e.cancelable) e.preventDefault();
      onUp();
    };
    el.addEventListener('pointerup', release, { passive: false });
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
  }

  if (isTouch) {
    function moveJoystick(e) {
      const r = joyBase.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2), dy = (e.clientY - cy) / (r.height / 2);
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      joyVec.x = dx; joyVec.y = -dy;
      joyKnob.style.transform = 'translate(calc(-50% + ' + dx * 30 + 'px), calc(-50% + ' + dy * 30 + 'px))';
    }

    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !started || !overlay.classList.contains('hidden') || invOpen || dead) return;
      if (joyZone.contains(e.target) && joyPointerId === null) {
        joyPointerId = e.pointerId;
        capturePointer(joyZone, e.pointerId);
        moveJoystick(e);
        e.preventDefault();
      } else if (e.target === canvas && lookPointerId === null) {
        lookPointerId = e.pointerId;
        capturePointer(canvas, e.pointerId);
        lookLast = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    }, { passive: false });

    document.addEventListener('pointermove', (e) => {
      // 面板打开（背包/菜单/死亡页）时不拦截，让浏览器原生滚动
      if (invOpen || dead || !overlay.classList.contains('hidden')) return;
      if (e.pointerId === joyPointerId) {
        moveJoystick(e);
        if (e.cancelable) e.preventDefault();
      } else if (e.pointerId === lookPointerId && lookLast) {
        player.yaw -= (e.clientX - lookLast.x) * 0.006;
        player.pitch -= (e.clientY - lookLast.y) * 0.006;
        player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch));
        lookLast = { x: e.clientX, y: e.clientY };
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    function releaseTouchPointer(e) {
      if (e.pointerId === joyPointerId) {
        joyPointerId = null;
        joyVec.x = joyVec.y = 0;
        joyKnob.style.transform = 'translate(-50%, -50%)';
      }
      if (e.pointerId === lookPointerId) { lookPointerId = null; lookLast = null; }
    }
    document.addEventListener('pointerup', releaseTouchPointer);
    document.addEventListener('pointercancel', releaseTouchPointer);
    document.addEventListener('lostpointercapture', releaseTouchPointer);

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
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const sky = MC.skyState(timeTicks);
    if (AU) AU.setNight(sky.night); // 夜晚 BGM 变低沉缓慢
    if (!paused()) {
      timeTicks = (timeTicks + dt * 20) % MC.DAY_TICKS; // 一整天 20 分钟
      stepPlayer(dt);
      stepVitals(dt);
      stepDigging(dt);
      handleRepeat(now);
      stepMobs(dt, sky);
      stepSpawning(dt, sky);
      stepDrops(dt);
      stepTorchLights(dt);
      stepParticles(dt);
    }
    updateSky();
    renderClock(sky);
    updateHand(dt);
    updateCracks();
    const active = !paused();
    const moving = active && player.onGround && Math.hypot(player.vel.x, player.vel.z) > 0.2;
    const cameraBob = moving ? Math.sin(walkPhase) * (sprinting ? 0.024 : 0.018) : 0;

    camera.position.set(player.pos.x, player.pos.y + EYE + cameraBob, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;

    // 准星高亮
    const hit = castFromCamera();
    if (hit && active) {
      hlBox.visible = true;
      hlBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      hlBox.visible = false;
    }
    const targetMob = active ? mobAtCrosshair(hit ? hit.dist : undefined) : null;
    crosshairEl.classList.toggle('hostile', !!targetMob);

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
  renderHunger();
  renderQuest();
  chkPeaceful.checked = peaceful;
  syncMuteBtn();
  showOverlay(false);
  started = true;
  requestAnimationFrame(loop);
})();
