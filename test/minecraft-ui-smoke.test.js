/**
 * 迷你世界界面层（main.js）冒烟测试：
 * 用最小 DOM / THREE 桩件在 Node 里真实执行 main.js，
 * 验证启动、元素 id、昼夜、刷怪/怪物 AI、掉落拾取、粒子等主循环路径，
 * 并断言奔跑视野、饥饿消耗、v3 保存与 v1/v2 旧档兼容。
 * 不验证真实渲染效果；旧档场景由本脚本通过 MC_TEST_LEGACY 子进程执行。
 *
 * 运行：node test/minecraft-ui-smoke.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---------- DOM 桩 ----------

// 从 minecraft.html 解析合法 id，getElementById 遇到未知 id 直接报错（抓拼写错误）
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'minecraft.html'), 'utf8');
const KNOWN_IDS = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
assert.ok(KNOWN_IDS.has('mc-canvas'), 'minecraft.html 应包含 mc-canvas');

const INITIALLY_HIDDEN = new Set(['mc-toast', 'mc-inv', 'mc-death']);

function makeClassList(initial) {
  const s = new Set(initial);
  return {
    add(c) { s.add(c); },
    remove(c) { s.delete(c); },
    toggle(c, force) { const v = force === undefined ? !s.has(c) : force; if (v) s.add(c); else s.delete(c); },
    contains(c) { return s.has(c); },
  };
}

function makeEl(id) {
  const el = {
    id: id || '',
    children: [],
    style: {},
    listeners: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    classList: makeClassList(INITIALLY_HIDDEN.has(id) ? ['hidden'] : []),
    appendChild(c) { this.children.push(c); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type, ev) { (this.listeners[type] || []).forEach((f) => f(ev || { preventDefault() {}, target: el })); },
    blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    textContent: '',
    title: '',
    checked: false,
    innerHTML: '',
  };
  return el;
}

function makeCtx2d() {
  return {
    fillStyle: '', strokeStyle: '',
    fillRect() {}, clearRect() {}, strokeRect() {},
  };
}

function makeCanvas() {
  const el = makeEl('canvas');
  el.width = 0; el.height = 0;
  el.getContext = () => makeCtx2d();
  el.requestPointerLock = () => {};
  return el;
}

const elements = new Map();
const docListeners = {};

global.document = {
  getElementById(id) {
    if (!KNOWN_IDS.has(id)) throw new Error('main.js 引用了 HTML 中不存在的元素 id: #' + id);
    if (!elements.has(id)) elements.set(id, id === 'mc-canvas' ? makeCanvas() : makeEl(id));
    return elements.get(id);
  },
  createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl(''); },
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  exitPointerLock() {},
  pointerLockElement: null,
  body: makeEl('body'),
};

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

Object.defineProperty(global, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
global.window = global;
global.devicePixelRatio = 1;
global.innerWidth = 1280;
global.innerHeight = 720;
// main.js 的键盘事件挂在 window 上：与 document 共用一个监听器注册表
global.window.addEventListener = (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); };
global.window.MinecraftCore = require('../public/js/minecraft/core.js');
const MC = global.window.MinecraftCore;
const legacyVersion = Number(process.env.MC_TEST_LEGACY || 0);
if (legacyVersion) {
  const legacyWorld = MC.createWorld(20240821);
  const spawn = MC.findSpawn(legacyWorld);
  const save = {
    v: legacyVersion,
    seed: legacyWorld.seed,
    data: MC.encodeWorld(legacyWorld),
    player: { x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0.5, pitch: -0.2, hp: 14 },
    selected: 0,
  };
  if (legacyVersion === 2) {
    const inv = MC.createInventory();
    inv[0] = { id: MC.LOG, n: 7 };
    inv[2] = { id: MC.MEAT, n: 3 };
    Object.assign(save, { time: 9000, peaceful: true, inv, selected: 2 });
  }
  store.set('minecraft-save-v1', JSON.stringify(save));
}

let simNow = 0;
performance.now = () => simNow;

// main.js 的自动保存定时器会让进程不退出，桩掉
global.setInterval = () => 0;

let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; };

// ---------- THREE 桩 ----------

function vec3(initial = 0) {
  return { x: initial, y: initial, z: initial, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
}

class MockColor {
  constructor(h) { this.h = h || 0; }
  copy(c) { this.h = c.h; return this; }
  lerp() { return this; }
  getHex() { return this.h; }
}
class MockObject3D {
  constructor() {
    this.children = [];
    this.position = vec3();
    this.scale = vec3(1);
    this.rotation = { order: '', x: 0, y: 0, z: 0 };
    this.visible = true;
    this.userData = {};
    this.renderOrder = 0;
  }
  add(c) { this.children.push(c); }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  traverse(cb) { cb(this); for (const c of this.children) c.traverse(cb); }
  lookAt() {}
}
class MockMesh extends MockObject3D {
  constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; }
}
class MockGroup extends MockObject3D {}
class MockScene extends MockGroup {
  constructor() { super(); global.__minecraftScene = this; }
}
class MockCamera extends MockObject3D {
  constructor(fov) { super(); this.fov = fov; this.aspect = 1; }
  updateProjectionMatrix() {}
}

global.THREE = {
  NearestFilter: 1,
  LinearFilter: 7,
  RepeatWrapping: 2,
  sRGBEncoding: 3,
  ACESFilmicToneMapping: 4,
  BackSide: 5,
  DoubleSide: 6,
  WebGLRenderer: class { setPixelRatio() {} setSize() {} render() {} },
  Scene: MockScene,
  Color: MockColor,
  Fog: class { constructor(c) { this.color = new MockColor(c); } },
  PerspectiveCamera: MockCamera,
  HemisphereLight: class { constructor() { this.intensity = 0; } },
  DirectionalLight: class { constructor() { this.position = vec3(); this.target = { position: vec3() }; this.intensity = 0; } },
  PointLight: class { constructor() { this.position = vec3(); this.intensity = 0; } },
  CanvasTexture: class {
    constructor() {
      this.magFilter = 0;
      this.minFilter = 0;
      this.generateMipmaps = true;
      this.offset = vec3();
    }
  },
  MeshLambertMaterial: class { constructor(o) { Object.assign(this, o); this.emissive = { setHex() {} }; } },
  MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); } },
  ShaderMaterial: class { constructor(o) { Object.assign(this, o); } },
  PointsMaterial: class { constructor(o) { Object.assign(this, o); } },
  LineBasicMaterial: class { constructor(o) { Object.assign(this, o); } },
  BufferGeometry: class { setAttribute() {} setIndex() {} dispose() {} },
  Float32BufferAttribute: class { constructor(arr) { this.array = arr; } },
  BoxGeometry: class {},
  SphereGeometry: class {},
  PlaneGeometry: class {},
  EdgesGeometry: class {},
  Mesh: MockMesh,
  Points: MockMesh,
  LineSegments: MockMesh,
  Group: MockGroup,
};

// ---------- 执行 main.js ----------

// 音频模块（无 AudioContext 环境下应全部静默降级）
require('../public/js/minecraft/audio.js');
assert.ok(global.McAudio, 'audio.js 应挂载 McAudio');
global.McAudio.ensure(); // 无 AudioContext → 静默返回
global.McAudio.startBgm();
global.McAudio.setMuted(true);
global.McAudio.setMuted(false);
global.McAudio.sfx.break(); // 未初始化 AudioContext 时也不应抛错

// main.js 是 IIFE，直接 require 执行
require('../public/js/minecraft/main.js');

const overlay = elements.get('mc-overlay');
const inv = elements.get('mc-inv');
const hearts = elements.get('mc-hearts');
const hunger = elements.get('mc-hunger');
const hotbar = elements.get('mc-hotbar');
const questEl = elements.get('mc-quest');

assert.ok(overlay && !overlay.classList.contains('hidden'), '启动后应显示开始覆盖层');
assert.strictEqual(hotbar.children.length, 8, '快捷栏应有 8 格');
assert.ok(hearts.innerHTML.includes('full'), '红心应渲染');
assert.ok(hunger.attributes['aria-label'].includes('20/20'), '旧档与新档都应以满饥饿开始');
assert.ok(questEl.innerHTML.includes(legacyVersion ? '自由建造' : '收集木头'), '目标应符合存档来源');

// 点击「进入世界」开始游戏
elements.get('mc-btn-play').fire('click');
assert.ok(overlay.classList.contains('hidden'), '点击后覆盖层应隐藏');

const keydown = (code) => (docListeners.keydown || []).forEach((f) => f({ code, preventDefault() {} }));
const keyup = (code) => (docListeners.keyup || []).forEach((f) => f({ code, preventDefault() {} }));
function runFrames(n) {
  for (let i = 0; i < n; i++) {
    assert.ok(rafCb, '主循环应持续注册 rAF');
    const cb = rafCb;
    rafCb = null;
    simNow += 50; // 每帧 50ms（dt 上限）
    cb(simNow);
  }
}
function saveNow() {
  elements.get('mc-btn-save').fire('click');
  return JSON.parse(store.get('minecraft-save-v1'));
}

const initialSave = saveNow();
assert.strictEqual(initialSave.v, 3, '保存应升级为 v3');
assert.strictEqual(initialSave.hunger, 20);
assert.strictEqual(initialSave.quest.done, !!legacyVersion, '旧档不强制重玩新手目标');
if (legacyVersion) {
  assert.strictEqual(initialSave.player.hp, 14, '旧档血量应保留');
  assert.strictEqual(initialSave.player.yaw, 0.5, '旧档视角应保留');
  if (legacyVersion === 2) {
    assert.strictEqual(initialSave.time, 9000, 'v2 时间应保留');
    assert.strictEqual(initialSave.peaceful, true, 'v2 和平模式应保留');
    assert.deepStrictEqual(initialSave.inv[0], { id: MC.LOG, n: 7 }, 'v2 木头应保留');
    assert.deepStrictEqual(initialSave.inv[2], { id: MC.MEAT, n: 3 }, 'v2 食物应保留');
    assert.strictEqual(initialSave.selected, 2);
  }
}

if (!legacyVersion) {
  const camera = global.__minecraftScene.children.find((o) => o instanceof MockCamera);
  assert.ok(camera, '场景应包含主相机');
  keydown('KeyW');
  keydown('ShiftLeft');
  runFrames(1);
  assert.ok(camera.fov > 76, 'Shift 应触发奔跑视野');
  runFrames(1999); // 合计 100 秒，覆盖不同地形下的饥饿消耗
  keyup('ShiftLeft');
  keyup('KeyW');
  const sprintSave = saveNow();
  assert.strictEqual(sprintSave.time, 3000, '主循环时间应真实推进');
  assert.ok(sprintSave.hunger < 20, '移动生存循环应消耗饥饿');
}

runFrames(20000); // 长时间昼夜循环：刷怪、怪物 AI、自燃、粒子与掉落拾取不抛错

// 站着不动可能被僵尸咬死或饿死：死了就点重生（顺带覆盖死亡/重生路径）
const deathEl = document.getElementById('mc-death');
if (!deathEl.classList.contains('hidden')) {
  elements.get('mc-btn-respawn').fire('click');
  assert.ok(deathEl.classList.contains('hidden'), '重生后死亡页应关闭');
}

// 打开/关闭背包
keydown('KeyE');
assert.ok(!inv.classList.contains('hidden'), '按 E 应打开背包');
const grid = elements.get('mc-inv-grid');
assert.strictEqual(grid.children.length, 32, '背包面板应有 32 格');
const recipes = elements.get('mc-recipes');
assert.strictEqual(recipes.children.length, MC.RECIPES.length, '应列出全部合成配方');
keydown('KeyE');
assert.ok(inv.classList.contains('hidden'), '再按 E 应关闭背包');

runFrames(5000);
assert.strictEqual(saveNow().v, 3, '长时间运行后仍应保存为 v3');

if (!legacyVersion) {
  const { spawnSync } = require('child_process');
  for (const version of [1, 2]) {
    const result = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, MC_TEST_LEGACY: String(version) },
      stdio: 'inherit',
    });
    assert.strictEqual(result.status, 0, `v${version} 旧存档兼容检查失败`);
  }
}

console.log(`✔ 迷你世界界面层冒烟测试通过（启动/生存/主循环/背包${legacyVersion ? `/v${legacyVersion} 旧档` : ''}）`);
