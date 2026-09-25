/* 効果音とBGM。音源ファイルは持たず、Web Audio でその場で合成する。
   スマホのブラウザは画面に触れるまで音を出せないので、最初のタップで鳴らせる状態にする。 */
(function (global) {
  'use strict';
  var KEY = 'geister.sound';
  var BGM_LEVEL = 0.32;
  // 音符は音声スレッドが時刻どおりに鳴らすので、先まで予約しておけば
  // CPU の思考や描画で画面側が固まっても BGM は途切れない。
  var LOOKAHEAD = 1.0;

  var prefs = loadPrefs();
  var ctx = null, comp = null, seBus = null, bgmBus = null, noiseBuf = null;
  var bgmWanted = false, running = false, timer = null;
  var nextTime = 0, step = 0;
  var tension = 0, tensionTarget = 0;

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (p) return { se: p.se !== false, bgm: p.bgm !== false };
    } catch (e) { /* 保存できない端末もある */ }
    return { se: true, bgm: true };
  }
  function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* 無視 */ } }

  function ensure() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    seBus = ctx.createGain(); seBus.gain.value = 0.6; seBus.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function unlock() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume().then(refreshBgm, function () {});
    else refreshBgm();
  }
  ['pointerdown', 'touchend', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, unlock, true);
  });
  // 裏に回ったら止める。戻ったら再開（BGM の続きは tick が拾う）。
  document.addEventListener('visibilitychange', function () {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume().catch(function () {});
  });

  /* ---------- 音の部品 ---------- */

  function tone(o) {
    var t = o.t, dur = o.dur, a = o.attack || 0.004;
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide || dur));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol, t + a);
    if (o.hold) g.gain.setValueAtTime(o.vol, t + a + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var out = g;
    if (o.lp) {
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = o.q || 0.7;
      g.connect(f); out = f;
    }
    osc.connect(g); out.connect(o.bus);
    if (o.vib) {
      var lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = o.vib; lg.gain.value = o.vibDepth || 5;
      lfo.connect(lg); lg.connect(osc.frequency);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    }
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  function noise(o) {
    var src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = o.hp ? 'highpass' : 'lowpass';
    f.frequency.value = o.hp || o.lp;
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.exponentialRampToValueAtTime(o.vol, o.t + (o.attack || 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
    src.connect(f); f.connect(g); g.connect(o.bus);
    src.start(o.t, Math.random() * 0.5);
    src.stop(o.t + o.dur + 0.02);
  }

  /* ---------- 効果音 ---------- */

  var C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;
  var SE = {
    select: function (t) {
      tone({ t: t, f: 880, f2: 1320, dur: 0.06, type: 'triangle', vol: 0.12, bus: seBus });
    },
    move: function (t) {
      tone({ t: t, f: 520, f2: 200, glide: 0.08, dur: 0.1, vol: 0.45, bus: seBus });
      noise({ t: t, dur: 0.035, vol: 0.12, hp: 2500, bus: seBus });
    },
    capture: function (t) {
      tone({ t: t, f: 659.25, dur: 0.1, type: 'square', vol: 0.14, lp: 3000, bus: seBus });
      tone({ t: t + 0.08, f: 987.77, dur: 0.18, type: 'square', vol: 0.14, lp: 3000, bus: seBus });
      noise({ t: t + 0.08, dur: 0.2, vol: 0.06, hp: 6000, bus: seBus });
    },
    lost: function (t) {
      tone({ t: t, f: 311, f2: 140, dur: 0.42, type: 'sawtooth', vol: 0.18, lp: 1100, vib: 10, vibDepth: 12, bus: seBus });
    },
    escape: function (t) {
      tone({ t: t, f: 260, f2: 1500, glide: 0.45, dur: 0.5, vol: 0.25, bus: seBus });
      tone({ t: t + 0.05, f: 520, f2: 3000, glide: 0.45, dur: 0.5, type: 'triangle', vol: 0.08, bus: seBus });
      noise({ t: t, dur: 0.5, vol: 0.05, hp: 3000, attack: 0.3, bus: seBus });
    },
    start: function (t) {
      tone({ t: t, f: 110, f2: 45, glide: 0.8, dur: 0.9, vol: 0.55, bus: seBus });
      tone({ t: t, f: 220, f2: 90, dur: 0.6, type: 'triangle', vol: 0.15, bus: seBus });
      noise({ t: t, dur: 0.6, vol: 0.12, lp: 500, bus: seBus });
    },
    win: function (t) {
      [C5, E5, G5, C6].forEach(function (f, i) {
        tone({ t: t + i * 0.11, f: f, dur: 0.2, type: 'square', vol: 0.12, lp: 3200, bus: seBus });
        tone({ t: t + i * 0.11, f: f / 2, dur: 0.2, type: 'triangle', vol: 0.12, bus: seBus });
        tone({ t: t + 0.5, f: f, dur: 1.4, attack: 0.02, hold: 0.4, type: 'square', vol: 0.06, lp: 2400, vib: 5, vibDepth: 3, bus: seBus });
      });
      noise({ t: t + 0.5, dur: 1.0, vol: 0.05, hp: 7000, bus: seBus });
    },
    lose: function (t) {
      [392, 369.99, 349.23, 329.63].forEach(function (f, i) {
        var last = i === 3;
        tone({ t: t + i * 0.42, f: f, dur: last ? 1.3 : 0.38, attack: 0.03, hold: last ? 0.6 : 0.2,
               type: 'sawtooth', vol: 0.16, lp: 900, vib: last ? 6 : 0, vibDepth: 7, bus: seBus });
      });
    }
  };

  function play(name, delay) {
    if (!prefs.se || !SE[name] || !ensure() || ctx.state !== 'running') return;
    SE[name](ctx.currentTime + 0.01 + (delay || 0));
  }

  /* ---------- BGM ---------- */

  // Am - F - Dm - E の4小節を16分音符で刻む。E は長三和音にして解決しない不安を残す。
  var BARS = [
    { bass: 110.00, chord: [220.00, 261.63, 329.63, 440.00] },
    { bass: 87.31, chord: [174.61, 220.00, 261.63, 349.23] },
    { bass: 73.42, chord: [146.83, 174.61, 220.00, 293.66] },
    { bass: 82.41, chord: [164.81, 207.65, 246.94, 329.63] }
  ];
  var ARP = [0, 1, 2, 3, 2, 1, 2, 3];

  function stepDur() { return 60 / (88 + 52 * tension) / 4; }

  function scheduleStep(n, t) {
    var bar = BARS[Math.floor(n / 16) % 4], s = n % 16, sd = stepDur();
    if (s === 0) tension += (tensionTarget - tension) * 0.5;

    if (s % 2 === 0) {
      tone({ t: t, f: bar.bass * (s % 8 === 6 ? 2 : 1), dur: sd * 1.6, type: 'sawtooth',
             vol: s % 4 === 0 ? 0.22 : 0.14, lp: 380 + 500 * tension, q: 4, bus: bgmBus });
    }
    // 心音。緊迫すると1小節に2回打つ。
    if (s === 0 || s === 3 || (tension > 0.5 && (s === 8 || s === 11))) {
      tone({ t: t, f: 75, f2: 38, glide: 0.18, dur: 0.22, vol: s % 8 === 0 ? 0.6 : 0.38, bus: bgmBus });
    }
    // 時計の針
    if (s % 4 === 2) noise({ t: t, dur: 0.025, vol: 0.05, hp: 7000, bus: bgmBus });
    else if (tension > 0.7 && s % 2 === 1) noise({ t: t, dur: 0.02, vol: 0.025, hp: 8000, bus: bgmBus });

    if (s === 0) {
      bar.chord.slice(0, 3).forEach(function (f) {
        tone({ t: t, f: f, dur: sd * 16, attack: sd * 4, type: 'sawtooth', vol: 0.025, lp: 900, vib: 5, vibDepth: 2, bus: bgmBus });
      });
    }
    if (tension > 0.35) {
      tone({ t: t, f: bar.chord[ARP[s % 8]] * 2, dur: sd * 0.9, type: 'square',
             vol: 0.03 + 0.03 * tension, lp: 2200, bus: bgmBus });
    }
  }

  function tick() {
    if (!ctx || ctx.state !== 'running' || !running) return;
    var now = ctx.currentTime;
    // 画面側が長く固まって予約が尽きたときは、拍を数え進めて曲の流れを保ったまま追いつく
    while (nextTime < now) { nextTime += stepDur(); step = (step + 1) % 64; }
    while (nextTime < now + LOOKAHEAD) {
      scheduleStep(step, nextTime);
      nextTime += stepDur();
      step = (step + 1) % 64;
    }
  }

  function refreshBgm() {
    var on = bgmWanted && prefs.bgm && !!ctx && ctx.state === 'running';
    var now = ctx ? ctx.currentTime : 0;
    if (on && !running) {
      // 止めるたびに出力先を作り直す。先まで予約した古い音符を、再開時に鳴らさないため。
      bgmBus = ctx.createGain();
      bgmBus.gain.setValueAtTime(0, now);
      bgmBus.gain.linearRampToValueAtTime(BGM_LEVEL, now + 0.6);
      bgmBus.connect(comp);
      running = true;
      step = 0;
      nextTime = now + 0.08;
      timer = setInterval(tick, 100);
      tick();
    } else if (!on && running) {
      running = false;
      clearInterval(timer);
      timer = null;
      var old = bgmBus;
      old.gain.cancelScheduledValues(now);
      old.gain.setValueAtTime(old.gain.value, now);
      old.gain.linearRampToValueAtTime(0, now + 0.4);
      setTimeout(function () { old.disconnect(); }, (LOOKAHEAD + 1) * 1000);
    }
  }

  function bgm(want) {
    bgmWanted = !!want;
    if (ctx) refreshBgm();
  }

  function setTension(x) {
    tensionTarget = Math.max(0, Math.min(1, x));
    if (!running) tension = tensionTarget;
  }

  function toggle(kind) {
    prefs[kind] = !prefs[kind];
    savePrefs();
    if (kind === 'bgm') refreshBgm();
    else if (prefs.se) play('select');
  }

  global.GeisterSound = {
    play: play,
    bgm: bgm,
    setTension: setTension,
    toggle: toggle,
    prefs: function () { return { se: prefs.se, bgm: prefs.bgm }; }
  };
})(window);
