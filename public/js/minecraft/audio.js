/**
 * 迷你世界音效与背景音乐（WebAudio 程序化生成，零音频资源文件）。
 * IIFE 挂 window.McAudio，被 main.js 调用；无 AudioContext 环境（如 Node 测试桩）下全部静默。
 *
 * 音效：挖掘/破坏/放置/拾取/受击/攻击/击杀/吃肉/合成/死亡/重生。
 * 背景音乐：生成式环境音乐 —— 五声音阶随机游走拨弦 + 每 8 拍低音铺垫；
 * 白天明亮轻快，夜晚低沉缓慢（setNight 切换）。
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

  let noiseBuf = null;
  function getNoiseBuf() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  /** 噪声短促音（挖掘、打击的“沙沙/砰”质感） */
  function noise(dur, delay, vol, filterFreq) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + (delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuf();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterFreq || 800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol || 0.08, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const sfx = {
    dig: () => noise(0.07, 0, 0.05, 500),                       // 挖掘中的摩擦声
    break: () => { noise(0.14, 0, 0.1, 900); tone(160, 0.1, 0, 'triangle', 0.06); },
    place: () => { tone(220, 0.06, 0, 'square', 0.07); noise(0.05, 0, 0.04, 700); },
    pickup: () => { tone(880, 0.05, 0, 'triangle', 0.06); tone(1320, 0.07, 0.05, 'triangle', 0.05); },
    hurt: () => { tone(300, 0.15, 0, 'sawtooth', 0.09); tone(180, 0.18, 0.08, 'sawtooth', 0.08); },
    hit: () => { noise(0.08, 0, 0.09, 1200); tone(200, 0.08, 0, 'square', 0.05); },
    mobDie: () => [400, 300, 200].forEach((f, i) => tone(f, 0.12, i * 0.07, 'sawtooth', 0.05)),
    eat: () => { noise(0.08, 0, 0.06, 600); noise(0.08, 0.12, 0.06, 600); noise(0.1, 0.24, 0.05, 500); },
    craft: () => [523, 659, 784].forEach((f, i) => tone(f, 0.1, i * 0.06, 'triangle', 0.07)),
    death: () => [400, 300, 220, 140].forEach((f, i) => tone(f, 0.25, i * 0.15, 'sawtooth', 0.08)),
    respawn: () => [330, 440, 660].forEach((f, i) => tone(f, 0.12, i * 0.08, 'triangle', 0.07)),
  };

  // ---------- 生成式背景音乐 ----------

  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16]; // 五声音阶（跨两个八度）
  let bgmTimer = null, beat = 0, nextT = 0, night = false, degree = 3;

  function scheduleBeat(b, t) {
    const base = night ? 174.6 : 220;
    // 拨弦：偶数拍必响，奇数拍六成概率
    if (b % 2 === 0 || Math.random() < 0.55) {
      degree += [-2, -1, -1, 0, 1, 1, 2][(Math.random() * 7) | 0];
      degree = Math.max(0, Math.min(PENTA.length - 1, degree));
      const f = base * Math.pow(2, PENTA[degree] / 12);
      tone(f, night ? 1.8 : 1.1, t - ctx.currentTime, 'sine', night ? 0.028 : 0.038, bgmGain);
    }
    // 每 8 拍一层低音铺垫
    if (b % 8 === 0) {
      const low = night ? 87.3 : 110;
      tone(low, 5, t - ctx.currentTime, 'sine', 0.022, bgmGain);
      tone(low * 1.5, 5, t - ctx.currentTime, 'sine', 0.014, bgmGain);
    }
  }

  function schedule() {
    if (!ctx) return;
    while (nextT < ctx.currentTime + 0.6) {
      scheduleBeat(beat, nextT);
      nextT += night ? 1.9 : 1.4; // 夜晚更慢
      beat++;
    }
  }

  function startBgm() {
    ensure();
    if (!ctx || bgmTimer || muted) return;
    nextT = ctx.currentTime + 0.1;
    beat = 0;
    bgmTimer = setInterval(schedule, 200);
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
