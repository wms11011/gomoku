/**
 * 迷你世界音效与背景音乐（WebAudio 程序化生成，零音频资源文件）。
 * IIFE 挂 window.McAudio，被 main.js 调用；无 AudioContext 环境（如 Node 测试桩）下全部静默。
 *
 * 音效风格模仿 Minecraft 的特征（非原版音频，原版音频有版权不可直接使用）：
 *  - 挖掘/破坏/脚步按材质区分：stone 硬脆、wood 木感闷笃、grass/dirt 松软、
 *    sand 更散的沙沙、leaves 高频窸窣
 *  - 拾取是快速上扬的“啵”；受击是低沉下坠的闷响；僵尸低吼、猪哼
 * 背景音乐：生成式钢琴氛围（稀疏五声音阶 + 长衰减），白天明亮、夜晚低沉缓慢。
 */
(function (global) {
  'use strict';

  let ctx = null, master = null, bgmGain = null;
  let muted = false;
  try { muted = localStorage.getItem('mc-muted') === '1'; } catch (e) { /* 忽略 */ }

  function ensure() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      bgmGain = ctx.createGain();
      bgmGain.gain.value = 0.55;
      bgmGain.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, dur, delay, type, vol, dest) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol || 0.06, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(dest || master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 音高扫频（用于拾取“啵”、受击闷响等） */
  function sweep(freq0, freq1, dur, delay, type, vol) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq0, t0);
    osc.frequency.exponentialRampToValueAtTime(freq1, t0 + dur);
    gain.gain.setValueAtTime(vol || 0.06, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  let noiseBuf = null;
  function getNoiseBuf() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  /** 噪声短促音：filterFreq 控制“材质软硬”，vol/dur 控制力度 */
  function noise(dur, delay, vol, filterFreq, type) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + (delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuf();
    const f = ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    f.frequency.value = filterFreq || 800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol || 0.08, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // ---------- 材质化音效（模仿 MC 按方块材质出声） ----------

  // 每种材质：挖掘(进行中)、破坏(碎裂)、脚步 的噪声参数 + 底色音
  const MAT_SFX = {
    stone: {
      dig: (v) => { noise(0.06, 0, 0.05 * v, 1400); tone(320, 0.04, 0, 'square', 0.018 * v); },
      brk: (v) => { noise(0.16, 0, 0.1 * v, 1600); noise(0.08, 0.02, 0.07 * v, 2400, 'highpass'); tone(240, 0.08, 0, 'square', 0.03 * v); },
      step: () => { noise(0.04, 0, 0.025, 1200); },
    },
    wood: {
      dig: (v) => { noise(0.07, 0, 0.045 * v, 700); tone(180, 0.05, 0, 'triangle', 0.03 * v); },
      brk: (v) => { noise(0.14, 0, 0.09 * v, 800); tone(150, 0.1, 0, 'triangle', 0.05 * v); },
      step: () => { noise(0.04, 0, 0.02, 600); tone(160, 0.03, 0, 'triangle', 0.012); },
    },
    grass: {
      dig: (v) => { noise(0.07, 0, 0.05 * v, 500); },
      brk: (v) => { noise(0.15, 0, 0.09 * v, 550); tone(120, 0.08, 0, 'triangle', 0.03 * v); },
      step: () => { noise(0.045, 0, 0.02, 450); },
    },
    sand: {
      dig: (v) => { noise(0.09, 0, 0.05 * v, 380); },
      brk: (v) => { noise(0.18, 0, 0.09 * v, 400); },
      step: () => { noise(0.05, 0, 0.018, 350); },
    },
    leaves: {
      dig: (v) => { noise(0.05, 0, 0.04 * v, 3000, 'highpass'); },
      brk: (v) => { noise(0.12, 0, 0.07 * v, 2800, 'highpass'); },
      step: () => { noise(0.04, 0, 0.015, 2500, 'highpass'); },
    },
  };

  function matSfx(kind, mat, volScale) {
    (MAT_SFX[mat] || MAT_SFX.grass)[kind](volScale || 1);
  }

  const sfx = {
    // 挖掘进行中（mat 为材质），破坏（碎裂声更大）
    dig: (mat) => matSfx('dig', mat),
    break: (mat) => matSfx('brk', mat),
    step: (mat) => matSfx('step', mat),
    place: () => { matSfx('dig', 'stone'); tone(190, 0.07, 0, 'triangle', 0.05); },
    // 拾取：MC 标志性的快速上扬“啵”
    pickup: () => sweep(420, 980, 0.09, 0, 'sine', 0.09),
    // 受击：MC 的“闷哼”——低频快速下坠
    hurt: () => { sweep(220, 90, 0.16, 0, 'sine', 0.12); noise(0.08, 0, 0.05, 400); },
    hit: () => { noise(0.07, 0, 0.09, 1000); sweep(200, 120, 0.08, 0, 'triangle', 0.06); },
    mobDie: () => { sweep(300, 80, 0.3, 0, 'sawtooth', 0.05); noise(0.15, 0, 0.05, 500); },
    // 僵尸低吼：低频锯齿波带颤音
    zombie: () => {
      if (!ctx || muted) return;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 82 + Math.random() * 20;
      lfo.frequency.value = 7;
      lfoGain.gain.value = 8;
      lfo.connect(lfoGain).connect(osc.frequency);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
      osc.connect(g).connect(master);
      osc.start(t0); osc.stop(t0 + 0.75);
      lfo.start(t0); lfo.stop(t0 + 0.75);
    },
    // 猪哼：两声短促的鼻音
    pig: () => { sweep(320, 180, 0.09, 0, 'square', 0.035); sweep(300, 170, 0.09, 0.13, 'square', 0.03); },
    eat: () => { noise(0.07, 0, 0.06, 600); noise(0.07, 0.13, 0.06, 550); noise(0.09, 0.26, 0.05, 500); },
    craft: () => [523, 659, 784].forEach((f, i) => tone(f, 0.1, i * 0.06, 'triangle', 0.07)),
    death: () => [400, 300, 220, 140].forEach((f, i) => tone(f, 0.25, i * 0.15, 'sawtooth', 0.08)),
    respawn: () => [330, 440, 660].forEach((f, i) => tone(f, 0.12, i * 0.08, 'triangle', 0.07)),
  };

  // ---------- 生成式背景音乐 ----------
  // 风格仿 C418 的 MC 氛围乐：I–V–vi–IV 安静和弦垫循环 + 稀疏钢琴旋律长音。
  // 和弦走向与调式本身无版权，旋律为程序随机生成，不复制任何原版曲目。

  const CHORDS = [ // [低音根音, 五度]
    [130.8, 196.0],  // C
    [98.0, 196.0],   // G
    [110.0, 220.0],  // Am
    [87.3, 174.6],   // F
  ];
  const SCALE = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3, 659.3]; // C 大调 C4~E5
  let bgmTimer = null, bar = 0, nextT = 0, night = false, degree = 2;

  /** 钢琴质感：基音 + 轻泛音，2.6 秒长衰减 */
  function pluck(freq, t, vol) {
    tone(freq, 2.6, t - ctx.currentTime, 'sine', vol, bgmGain);
    tone(freq * 2, 1.4, t - ctx.currentTime, 'sine', vol * 0.25, bgmGain);
  }

  function scheduleBar(t) {
    const barLen = night ? 4.8 : 3.6;
    const chord = CHORDS[bar % 4];
    // 和弦垫：根音 + 五度铺满整小节（MC 式的长音底）
    tone(chord[0], barLen, t - ctx.currentTime, 'sine', night ? 0.02 : 0.026, bgmGain);
    tone(chord[1], barLen, t - ctx.currentTime, 'sine', night ? 0.013 : 0.017, bgmGain);
    // 旋律：每小节 0~3 个音落在拍点上，随机游走 + 偶尔低八度；夜晚整体低八度
    const melVol = night ? 0.032 : 0.044;
    const slots = (Math.random() * 4) | 0;
    for (let k = 0; k < slots; k++) {
      const off = ((Math.random() * 4) | 0) * (barLen / 4);
      degree += [-2, -1, -1, 0, 1, 1, 2][(Math.random() * 7) | 0];
      degree = Math.max(0, Math.min(SCALE.length - 1, degree));
      let f = SCALE[degree];
      if (Math.random() < 0.15) f /= 2;
      if (night) f /= 2;
      pluck(f, t + off, melVol);
    }
  }

  function schedule() {
    if (!ctx) return;
    while (nextT < ctx.currentTime + 0.8) {
      scheduleBar(nextT);
      nextT += night ? 4.8 : 3.6;
      bar++;
    }
  }

  function startBgm() {
    ensure();
    if (!ctx || bgmTimer || muted) return;
    nextT = ctx.currentTime + 0.1;
    bar = 0;
    bgmTimer = setInterval(schedule, 250);
  }

  function stopBgm() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  }

  function setNight(b) { night = !!b; }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem('mc-muted', muted ? '1' : '0'); } catch (e) { /* 忽略 */ }
    if (muted) stopBgm(); else startBgm();
  }

  function isMuted() { return muted; }

  global.McAudio = { ensure, sfx, startBgm, stopBgm, setNight, setMuted, isMuted };
})(typeof window !== 'undefined' ? window : globalThis);
