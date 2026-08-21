/**
 * 迷你世界界面层（main.js）冒烟测试：
 * 用最小 DOM / THREE 桩件在 Node 里真实执行 main.js，
 * 验证启动流程、元素 id 引用、昼夜推进、刷怪/怪物 AI、掉落拾取等主循环代码路径不抛错。
 * 不验证渲染效果，只验证「跑得起来」。
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

let simNow = 0;
performance.now = () => simNow;

// main.js 的自动保存定时器会让进程不退出，桩掉
global.setInterval = () => 0;

let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; };

// ---------- THREE 桩 ----------

function vec3() { return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }; }

class MockColor {
  constructor(h) { this.h = h || 0; }
  copy(c) { this.h = c.h; return this; }
  lerp() { return this; }
  getHex() { return this.h; }
}
class MockMesh {
  constructor(geo, mat) { this.geometry = geo; this.material = mat; this.position = vec3(); this.rotation = { y: 0 }; this.visible = true; }
}
class MockGroup {
  constructor() { this.children = []; this.position = vec3(); this.rotation = { y: 0 }; }
  add(c) { this.children.push(c); }
  traverse(cb) { this.children.forEach(cb); }
}

global.THREE = {
  NearestFilter: 1,
  WebGLRenderer: class { setPixelRatio() {} setSize() {} render() {} },
  Scene: class { constructor() { this.children = []; } add(o) { this.children.push(o); } remove(o) {} },
  Color: MockColor,
  Fog: class { constructor(c) { this.color = new MockColor(c); } },
  PerspectiveCamera: class {
    constructor() { this.position = vec3(); this.rotation = { order: '', y: 0, x: 0 }; this.aspect = 1; }
    updateProjectionMatrix() {}
  },
  HemisphereLight: class { constructor() { this.intensity = 0; } },
  DirectionalLight: class { constructor() { this.position = vec3(); this.target = { position: vec3() }; this.intensity = 0; } },
  PointLight: class { constructor() { this.position = vec3(); this.intensity = 0; } },
  CanvasTexture: class { constructor() { this.magFilter = 0; this.minFilter = 0; this.generateMipmaps = true; } },
  MeshLambertMaterial: class { constructor(o) { Object.assign(this, o); this.emissive = { setHex() {} }; } },
  LineBasicMaterial: class { constructor(o) { Object.assign(this, o); } },
  BufferGeometry: class { setAttribute() {} setIndex() {} dispose() {} },
  Float32BufferAttribute: class { constructor(arr) { this.array = arr; } },
  BoxGeometry: class {},
  EdgesGeometry: class {},
  Mesh: MockMesh,
  LineSegments: MockMesh,
  Group: MockGroup,
};

// ---------- 执行 main.js ----------

// main.js 是 IIFE，直接 require 执行
require('../public/js/minecraft/main.js');

const overlay = elements.get('mc-overlay');
const inv = elements.get('mc-inv');
const hearts = elements.get('mc-hearts');
const hotbar = elements.get('mc-hotbar');

assert.ok(overlay && !overlay.classList.contains('hidden'), '启动后应显示开始覆盖层');
assert.strictEqual(hotbar.children.length, 8, '快捷栏应有 8 格');
assert.ok(hearts.innerHTML.includes('full'), '初始应为满血红心');

// 点击「进入世界」开始游戏
elements.get('mc-btn-play').fire('click');
assert.ok(overlay.classList.contains('hidden'), '点击后覆盖层应隐藏');

// 驱动 20000 帧（约 20000 ticks：跨过整个白天进入夜晚再回白天）
function runFrames(n) {
  for (let i = 0; i < n; i++) {
    assert.ok(rafCb, '主循环应持续注册 rAF');
    const cb = rafCb;
    rafCb = null;
    simNow += 50; // 每帧 50ms（dt 上限）
    cb(simNow);
  }
}
runFrames(20000); // 夜晚会刷僵尸、白天僵尸自燃、猪游荡 —— 全链路不应抛错

// 站着不动可能被僵尸咬死：死了就点重生（顺带覆盖死亡/重生路径）
const deathEl = elements.get('mc-death');
if (!deathEl.classList.contains('hidden')) {
  elements.get('mc-btn-respawn').fire('click');
  assert.ok(deathEl.classList.contains('hidden'), '重生后死亡页应关闭');
}

// 打开/关闭背包
const keydown = (code) => (docListeners.keydown || []).forEach((f) => f({ code, preventDefault() {} }));
keydown('KeyE');
assert.ok(!inv.classList.contains('hidden'), '按 E 应打开背包');
assert.ok(inv.querySelectorAll === undefined, '桩不需要 querySelectorAll'); // 占位，说明桩够用即可
const grid = elements.get('mc-inv-grid');
assert.strictEqual(grid.children.length, 32, '背包面板应有 32 格');
const recipes = elements.get('mc-recipes');
assert.ok(recipes.children.length >= 7, '应列出全部合成配方');
keydown('KeyE');
assert.ok(inv.classList.contains('hidden'), '再按 E 应关闭背包');

// 再跑 5000 帧确认关包后一切照常
runFrames(5000);

console.log('✔ 迷你世界界面层冒烟测试通过（启动/主循环/刷怪/背包）');
