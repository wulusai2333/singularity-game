/*!
 * 奇点 SINGULARITY — 表现层：程序化美术 + WebAudio 合成音 + 输入/主循环
 * 无任何外部素材（无图片、无音频、无字体文件）
 */
(function () {
  'use strict';
  var S = window.SINGULARITY;
  if (!S) { console.error('game.js 未加载'); return; }
  var CFG = S.CFG, ETYPES = S.ETYPES, W = S.W, H = S.H, TAU = S.TAU;
  var clamp = S.clamp, lerp = S.lerp, rand = S.rand;

  /* ============================== 音频合成 ============================== */
  function makeAudio() {
    var ac = null, master = null, busDelay = null, muted = false, vol = 0.45, ready = false;
    var noiseBuf = null, musicTimer = null, musicOn = false, intensity = 1, step = 0, nextNote = 0;
    var last = {};

    function ensure() {
      if (ac) return ac;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain(); master.gain.value = muted ? 0 : vol;
      var comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 6;
      master.connect(comp); comp.connect(ac.destination);
      // 一个便宜的空间感：反馈延迟
      busDelay = ac.createGain(); busDelay.gain.value = 0.22;
      var dl = ac.createDelay(0.5); dl.delayTime.value = 0.19;
      var fb = ac.createGain(); fb.gain.value = 0.32;
      var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
      busDelay.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(master);
      // 噪声源
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 1.2, ac.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return ac;
    }

    function throttle(key, gap) {
      if (!ac) return false;
      if (last[key] !== undefined && ac.currentTime - last[key] < gap) return false;
      last[key] = ac.currentTime; return true;
    }
    function tone(o) {
      if (!ready || !ensure() || muted) return;
      var t0 = ac.currentTime + (o.delay || 0);
      var osc = ac.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(24, o.f1), t0 + o.dur);
      var gn = ac.createGain();
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t0 + (o.at || 0.01));
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      if (o.filter) {
        var bq = ac.createBiquadFilter();
        bq.type = o.filter; bq.frequency.value = o.fc || 1400; bq.Q.value = o.q || 1;
        osc.connect(bq); bq.connect(gn);
      } else osc.connect(gn);
      gn.connect(o.wet ? busDelay : master);
      osc.start(t0); osc.stop(t0 + o.dur + 0.05);
    }
    function noise(o) {
      if (!ready || !ensure() || muted) return;
      var t0 = ac.currentTime + (o.delay || 0);
      var src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      var bq = ac.createBiquadFilter();
      bq.type = o.ftype || 'lowpass';
      bq.frequency.setValueAtTime(o.fc || 1200, t0);
      if (o.fc2) bq.frequency.exponentialRampToValueAtTime(Math.max(60, o.fc2), t0 + o.dur);
      bq.Q.value = o.q || 1;
      var gn = ac.createGain();
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t0 + (o.at || 0.008));
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      src.connect(bq); bq.connect(gn); gn.connect(o.wet ? busDelay : master);
      src.start(t0); src.stop(t0 + o.dur + 0.05);
    }

    /* --- 背景音乐：A 小调五声音阶 + 心跳式低频，强度随波次上升 --- */
    var SCALE = [0, 3, 5, 7, 10, 12, 15];
    function hz(semi) { return 110 * Math.pow(2, semi / 12); }
    function playStep(i, when) {
      var d = when - ac.currentTime;
      var beat = 0.5 / (1 + (intensity - 1) * 0.16);
      if (i % 2 === 0) {
        var root = [0, 0, -5, -3, 0, 3, -5, -7][(i / 2) % 8];
        tone({ f0: hz(root - 12), f1: hz(root - 12) * 0.98, dur: beat * 1.5, type: 'sine', vol: 0.5, delay: d, wet: true });
      }
      noise({ dur: 0.045, vol: 0.05 + intensity * 0.012, fc: 6500, ftype: 'highpass', delay: d });
      if (i % 2 === 1) {
        var n = SCALE[(Math.random() * SCALE.length) | 0] + 12;
        tone({ f0: hz(n), dur: beat * 0.8, type: 'triangle', vol: 0.05, delay: d, wet: true, filter: 'lowpass', fc: 2600 });
      }
      if (i % 16 === 0) {
        tone({ f0: hz(-12), dur: 2.4, type: 'sawtooth', vol: 0.035, delay: d, filter: 'lowpass', fc: 400 + intensity * 120 });
        tone({ f0: hz(3), dur: 2.4, type: 'sine', vol: 0.03, delay: d });
      }
    }
    function musicStart() {
      if (!ensure()) return;
      if (musicOn) return;
      musicOn = true; step = 0; nextNote = ac.currentTime + 0.08;
      musicTimer = setInterval(function () {
        if (!ac || !musicOn) return;
        var beat = 0.5 / (1 + (intensity - 1) * 0.16);
        var ahead = ac.currentTime + 0.3;
        var guard = 0;
        while (nextNote < ahead && guard++ < 8) { playStep(step, nextNote); step++; nextNote += beat; }
      }, 90);
    }

    return {
      resume: function () {
        var a = ensure();
        if (!a) return;
        ready = true;
        if (a.state === 'suspended') a.resume();
      },
      sfx: {
        place: function () {
          if (!throttle('place', 0.05)) return;
          tone({ f0: 620, f1: 96, dur: 0.24, type: 'triangle', vol: 0.20 });
          noise({ dur: 0.14, vol: 0.07, fc: 900, fc2: 200 });
        },
        absorb: function (m) {
          if (!throttle('absorb', 0.022)) return;
          tone({ f0: 430 + m * 55, f1: 1080 + m * 70, dur: 0.075, type: 'square', vol: 0.045 });
        },
        nova: function (m) {
          tone({ f0: 190 + m * 12, f1: 30, dur: 0.55, type: 'sine', vol: 0.34, wet: true });
          noise({ dur: 0.7, vol: 0.24, fc: 2800, fc2: 140 });
          tone({ f0: 1000, f1: 110, dur: 0.3, type: 'sawtooth', vol: 0.06, filter: 'lowpass', fc: 1800 });
        },
        chain: function (d) {
          if (!throttle('chain' + Math.min(d, 6), 0.02)) return;
          tone({ f0: 620 + d * 130, f1: 1500 + d * 130, dur: 0.06, type: 'triangle', vol: 0.05, delay: Math.min(d, 6) * 0.035, wet: true });
        },
        hit: function () {
          tone({ f0: 220, f1: 46, dur: 0.35, type: 'sawtooth', vol: 0.26 });
          noise({ dur: 0.3, vol: 0.18, fc: 1400, fc2: 200 });
        },
        dash: function () { noise({ dur: 0.2, vol: 0.12, fc: 2400, fc2: 380, q: 3 }); },
        death: function () {
          [0, -3, -7, -12].forEach(function (n, i) {
            tone({ f0: hz(n), f1: hz(n - 5), dur: 0.6, type: 'triangle', vol: 0.2, delay: i * 0.13, wet: true });
          });
          noise({ dur: 1.1, vol: 0.2, fc: 2000, fc2: 120 });
        },
        wave: function () {
          tone({ f0: hz(0), dur: 0.5, type: 'triangle', vol: 0.13 });
          tone({ f0: hz(7), dur: 0.5, type: 'sine', vol: 0.10, delay: 0.04 });
        },
        spawn: function () { if (throttle('spawn', 0.05)) tone({ f0: 170, f1: 300, dur: 0.09, type: 'sine', vol: 0.035 }); },
        ui: function () { tone({ f0: 720, f1: 1180, dur: 0.07, type: 'triangle', vol: 0.09 }); },
        setMute: function (m) { muted = m; if (master) master.gain.value = m ? 0 : vol; }
      },
      music: {
        start: function () { ensure(); musicStart(); },
        stop: function () { musicOn = false; if (musicTimer) clearInterval(musicTimer); musicTimer = null; },
        setIntensity: function (v) { intensity = clamp(v, 0.6, 2.6); }
      }
    };
  }

  /* ============================== 图形缓存 ============================== */
  var sprites = {}, bgCanvas = null;

  function rgba(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function glowSprite(col) {
    if (sprites[col]) return sprites[col];
    var size = 128, c = document.createElement('canvas');
    c.width = c.height = size;
    var x = c.getContext('2d');
    var gd = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gd.addColorStop(0, rgba(col, 1));
    gd.addColorStop(0.18, rgba(col, 0.55));
    gd.addColorStop(0.45, rgba(col, 0.16));
    gd.addColorStop(1, rgba(col, 0));
    x.fillStyle = gd;
    x.fillRect(0, 0, size, size);
    sprites[col] = c;
    return c;
  }
  function drawGlow(ctx, x, y, r, col, a) {
    if (a <= 0.004 || r <= 0.4) return;
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(glowSprite(col), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function buildBg() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#04060c'; x.fillRect(0, 0, W, H);
    var gd = x.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.66);
    gd.addColorStop(0, '#0a1526');
    gd.addColorStop(0.55, '#060b16');
    gd.addColorStop(1, '#03050a');
    x.fillStyle = gd; x.fillRect(0, 0, W, H);
    // 网格
    x.strokeStyle = 'rgba(70,150,200,0.085)'; x.lineWidth = 1;
    for (var gx = 0; gx <= W; gx += 64) { x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, H); x.stroke(); }
    for (var gy = 0; gy <= H; gy += 64) { x.beginPath(); x.moveTo(0, gy); x.lineTo(W, gy); x.stroke(); }
    // 星点
    for (var i = 0; i < 260; i++) {
      var px = Math.random() * W, py = Math.random() * H, a = rand(0.05, 0.5);
      x.fillStyle = 'rgba(180,225,255,' + a.toFixed(3) + ')';
      x.fillRect(px, py, rand(1, 2.1), rand(1, 2.1));
    }
    // 边缘暗角
    var vg = x.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, W * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    x.fillStyle = vg; x.fillRect(0, 0, W, H);
    // 场地边框
    x.strokeStyle = 'rgba(90,190,255,0.30)'; x.lineWidth = 2;
    x.strokeRect(1, 1, W - 2, H - 2);
    x.strokeStyle = 'rgba(90,190,255,0.12)'; x.lineWidth = 6;
    x.strokeRect(6, 6, W - 12, H - 12);
    bgCanvas = c;
  }

  /* ============================== 绘制工具 ============================== */
  function mono(size, weight) { return (weight || 600) + ' ' + size + 'px Consolas, Menlo, "DejaVu Sans Mono", monospace'; }
  function han(size, weight) { return (weight || 500) + ' ' + size + 'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'; }
  function text(ctx, str, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.font = o.mono ? mono(o.size || 18, o.weight) : han(o.size || 18, o.weight);
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'alphabetic';
    ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
    if (o.glow) { ctx.shadowColor = rgba(o.glow, 0.9); ctx.shadowBlur = o.blur || 14; }
    ctx.fillStyle = o.col || '#cfe9ff';
    ctx.fillText(str, x, y);
    ctx.restore();
  }
  function shape(ctx, x, y, r, kind, rot) {
    ctx.beginPath();
    var i, a;
    if (kind === 'dot') {
      ctx.arc(x, y, r, 0, TAU);
      return;
    }
    var sides = kind === 'tri' ? 3 : kind === 'square' ? 4 : kind === 'diamond' ? 4 : 6;
    var off = kind === 'diamond' ? 0 : -Math.PI / 2;
    for (i = 0; i < sides; i++) {
      a = rot + off + (i / sides) * TAU;
      if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
  }
  function drawEnemy(ctx, g, e) {
    var t = ETYPES[e.type];
    var pulse = 1 + Math.sin(g.t * 6 + e.seed) * 0.05;
    var r = e.r * pulse;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, e.x, e.y, r * 3.4, t.col, 0.34 + (e.flash > 0 ? e.flash : 0));
    ctx.globalCompositeOperation = 'source-over';
    // 冲击前的白色描边（被拉扯时会拉长，用旋转的椭圆近似）
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(Math.atan2(e.vy, e.vx));
    var stretch = 1 + Math.min(1.1, Math.hypot(e.vx, e.vy) / 420);
    ctx.scale(stretch, 1 / Math.sqrt(stretch));
    ctx.rotate(-Math.atan2(e.vy, e.vx));
    ctx.fillStyle = 'rgba(6,10,18,0.92)';
    shape(ctx, 0, 0, r, t.shape, e.rot);
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = t.col;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(t.col, 0.5);
    shape(ctx, 0, 0, r * 0.5, t.shape, -e.rot * 1.7);
    ctx.stroke();
    ctx.restore();
  }
  function drawWell(ctx, g, w) {
    var R = S.pullR(w), core = S.coreR(w);
    var frac = clamp(w.life / CFG.well.life, 0, 1);
    var col = w.mass >= 6 ? '#e8d8ff' : w.mass >= 3 ? '#b79bff' : '#6fd6ff';
    var danger = frac < 0.28;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, w.x, w.y, R * 1.08, col, 0.16 + Math.min(0.14, w.mass * 0.012) + w.flash * 0.30);
    drawGlow(ctx, w.x, w.y, Math.min(62, core * 1.9), '#ffffff', 0.20 + w.flash * 0.35);
    // 引力场参考圈
    ctx.globalAlpha = 0.20 + Math.sin(g.t * 2 + w.seed) * 0.05;
    ctx.strokeStyle = col; ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 10]);
    ctx.beginPath(); ctx.arc(w.x, w.y, R, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // 旋转的弧线
    ctx.lineCap = 'round';
    for (var i = 0; i < 3; i++) {
      var rr = core + (R - core) * (0.32 + i * 0.3);
      var sp = 1.1 + i * 0.5;
      ctx.beginPath();
      ctx.lineWidth = 3.2 - i * 0.6;
      ctx.strokeStyle = rgba(i === 1 ? '#d9a3ff' : col, 0.75 - i * 0.13);
      ctx.arc(w.x, w.y, rr, w.rot * sp, w.rot * sp + 1.5 + i * 0.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = rgba(col, 0.35);
      ctx.arc(w.x, w.y, rr, w.rot * sp + Math.PI, w.rot * sp + Math.PI + 0.9);
      ctx.stroke();
    }
    // 寿命环（快没了会变红）
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = danger ? '#ff6a7e' : rgba(col, 0.85);
    ctx.arc(w.x, w.y, R * 0.78, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
    ctx.stroke();
    // 核心质量
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,255,255,' + (0.75 + w.flash * 0.25) + ')';
    ctx.arc(w.x, w.y, core * 0.5 + w.mass * 0.2, 0, TAU);
    ctx.fill();
    if (w.mass > 0) {
      text(ctx, w.mass + '', w.x, w.y + 6, { mono: true, size: 18, col: '#0a0f18', align: 'center', weight: 800 });
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, w.x, w.y, core * 2.4, '#ffffff', 0.25);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function drawPlayer(ctx, g) {
    var p = g.player;
    var blink = p.invuln > 0 && (Math.floor(g.t * 22) % 2 === 0);
    // 拖尾
    ctx.globalCompositeOperation = 'lighter';
    for (var i = p.trail.length - 1; i >= 1; i--) {
      var t = 1 - i / p.trail.length;
      drawGlow(ctx, p.trail[i].x, p.trail[i].y, 16 * t, '#4fd6ff', 0.16 * t);
    }
    ctx.globalCompositeOperation = 'source-over';
    if (g.state === 'MENU') return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = blink ? 0.35 : 1;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, 0, 0, 46, '#63e2ff', 0.45);
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(p.facing);
    ctx.beginPath();
    ctx.moveTo(16, 0); ctx.lineTo(-10, 10); ctx.lineTo(-5, 0); ctx.lineTo(-10, -10);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8,16,26,0.95)';
    ctx.fill();
    ctx.lineWidth = 2.6; ctx.strokeStyle = '#8df0ff'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, 0);
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.restore();
    // 冲刺冷却环
    if (g.dashCd > 0) {
      ctx.beginPath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = rgba('#63e2ff', 0.5);
      ctx.arc(p.x, p.y, p.r + 9, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - g.dashCd / CFG.player.dashCd));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawParticles(ctx, g) {
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < g.parts.length; i++) {
      var p = g.parts[i];
      var lt = clamp(p.life / p.max, 0, 1);
      if (p.kind === 'ring' && p.soft) {
        // 小死亡环：只留柔和的彩色扩散，别变成一片肥皂泡
        ctx.globalAlpha = lt * 0.40;
        ctx.lineWidth = Math.max(0.6, p.w * 1.7 * lt);
        ctx.strokeStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
        ctx.globalAlpha = lt * 0.55;
        ctx.lineWidth = Math.max(0.5, p.w * 0.5);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
      } else if (p.kind === 'ring') {
        // 冲击环：细而热的锋面 + 柔和光晕，而不是一根粗白管子
        ctx.strokeStyle = p.col;
        ctx.globalAlpha = lt * 0.10;
        ctx.lineWidth = Math.max(1, p.w * 3.4 * lt);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
        ctx.globalAlpha = lt * 0.26;
        ctx.lineWidth = Math.max(0.8, p.w * 1.6 * lt);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
        ctx.globalAlpha = lt * 0.92;
        ctx.lineWidth = Math.max(0.7, p.w * 0.55 * lt);
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
      } else if (p.kind === 'blast') {
        drawGlow(ctx, p.x, p.y, p.r, p.col, lt * 0.34);
        drawGlow(ctx, p.x, p.y, p.r * 0.34, '#ffffff', lt * 0.42);
      } else if (p.kind === 'streak') {
        var cs = Math.cos(p.ang), sn = Math.sin(p.ang);
        var r0s = p.r * 2.4, r1s = p.r * 2.4 + p.len * (0.35 + (1 - lt) * 0.8);
        ctx.globalAlpha = lt * 0.55;
        ctx.lineWidth = 2.2 * lt + 0.4;
        ctx.strokeStyle = p.col;
        ctx.beginPath();
        ctx.moveTo(p.x + cs * r0s, p.y + sn * r0s);
        ctx.lineTo(p.x + cs * r1s, p.y + sn * r1s);
        ctx.stroke();
        drawGlow(ctx, p.x + cs * r1s, p.y + sn * r1s, 8, p.col, lt * 0.35);
      } else if (p.kind === 'dust') {
        ctx.globalAlpha = lt * 0.5;
        ctx.fillStyle = p.col;
        ctx.fillRect(p.x, p.y, p.r, p.r);
      } else {
        ctx.globalAlpha = lt;
        drawGlow(ctx, p.x, p.y, p.r * 5.5, p.col, lt * 0.85);
        if (p.r > 1.8) {
          ctx.beginPath();
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = lt * 0.75;
          ctx.arc(p.x, p.y, p.r * 0.55, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  function drawTexts(ctx, g) {
    for (var i = 0; i < g.texts.length; i++) {
      var t = g.texts[i], lt = t.life / t.max;
      text(ctx, t.text, t.x, t.y, {
        mono: true, size: t.size, col: t.col, align: 'center',
        alpha: Math.min(1, lt * 1.6), glow: t.col, blur: 12
      });
    }
  }

  /* ================================ HUD ================================ */
  function pip(ctx, x, y, r, filled, col, pulse) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    if (filled) {
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, 0, 0, r * 3, col, 0.5 + (pulse || 0) * 0.5);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = col;
      ctx.fillRect(-r, -r, r * 2, r * 2);
    } else {
      ctx.strokeStyle = rgba(col, 0.35);
      ctx.lineWidth = 2;
      ctx.strokeRect(-r, -r, r * 2, r * 2);
    }
    ctx.restore();
  }
  function drawHUD(ctx, g) {
    var pad = 26;
    // 分数
    text(ctx, '分数', pad, pad + 16, { size: 13, col: 'rgba(140,190,225,0.75)', weight: 500 });
    text(ctx, (g.score | 0).toString(), pad, pad + 52, { mono: true, size: 40, col: '#eaf6ff', glow: '#3fa8d8', blur: 16, weight: 700 });
    text(ctx, '最高 ' + (S.clamp(g.best, 0, 9999999) | 0), pad, pad + 74, { mono: true, size: 14, col: 'rgba(150,200,235,0.7)' });

    // 生命
    var hx = pad, hy = H - pad - 6;
    text(ctx, '生命', hx, hy - 26, { size: 13, col: 'rgba(140,190,225,0.75)' });
    for (var i = 0; i < CFG.player.hp; i++) {
      var on = i < g.hp;
      ctx.save();
      ctx.translate(hx + i * 26, hy);
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(11, 0); ctx.lineTo(0, 9); ctx.lineTo(-11, 0);
      ctx.closePath();
      if (on) {
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, 0, 0, 24, i === g.hp - 1 && g.hp === 1 ? '#ff5f7e' : '#63e2ff', 0.5);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = g.hp === 1 ? '#ff8fa3' : '#9ff0ff';
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(120,160,190,0.3)'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }

    // 能量
    var ex = pad + 120;
    text(ctx, '能量', ex, hy - 26, { size: 13, col: 'rgba(140,190,225,0.75)' });
    for (var k = 0; k < CFG.well.max; k++) {
      pip(ctx, ex + 12 + k * 30, hy - 8, 8, k < g.energy, k < g.energy ? '#63e2ff' : '#3a6d8c', k === g.energy - 1 ? g.energyPulse : 0);
    }
    if (g.energy < CFG.well.max) {
      var w2 = 4 * 30 - 6;
      ctx.beginPath();
      ctx.rect(ex + 6, hy + 6, w2, 3);
      ctx.fillStyle = 'rgba(120,190,230,0.18)'; ctx.fill();
      ctx.beginPath();
      ctx.rect(ex + 6, hy + 6, w2 * (g.regenT / CFG.well.regen), 3);
      ctx.fillStyle = 'rgba(120,200,245,0.75)'; ctx.fill();
    }

    // 波次
    text(ctx, 'WAVE ' + g.wave, W - pad, pad + 30, { mono: true, size: 26, col: '#dcefff', align: 'right', weight: 700, glow: '#2b6f9c', blur: 12 });
    var wf = clamp(g.waveT / CFG.waveDur(g.wave), 0, 1);
    ctx.beginPath();
    ctx.rect(W - pad - 190, pad + 42, 190, 5);
    ctx.fillStyle = 'rgba(120,190,230,0.16)'; ctx.fill();
    ctx.beginPath();
    ctx.rect(W - pad - 190, pad + 42, 190 * wf, 5);
    ctx.fillStyle = 'rgba(120,210,255,0.8)'; ctx.fill();
    text(ctx, '存活 ' + g.stats.time.toFixed(1) + 's  ·  击杀 ' + g.stats.kills + '  ·  坍缩 ' + g.stats.novas,
      W - pad, pad + 70, { mono: true, size: 13, col: 'rgba(150,200,235,0.7)', align: 'right' });

    // 连击
    if (g.combo > 1.01) {
      var cf = clamp(g.comboT / CFG.combo.window, 0, 1);
      var cs = lerp(46, 34, cf);
      text(ctx, 'x' + g.combo.toFixed(1), W / 2, H - 52, {
        mono: true, size: cs, col: g.combo >= 4 ? '#ffd479' : '#eaf6ff', align: 'center',
        glow: g.combo >= 4 ? '#ff9d3c' : '#3fa8d8', blur: 18, weight: 800
      });
      ctx.beginPath();
      ctx.rect(W / 2 - 60, H - 42, 120 * cf, 4);
      ctx.fillStyle = rgba('#63e2ff', 0.75); ctx.fill();
    }

    // 波次横幅
    if (g.bannerT > 0) {
      var bt = clamp(g.bannerT / 2.0, 0, 1);
      var a = bt > 0.75 ? (1 - bt) / 0.25 : Math.min(1, bt / 0.35);
      text(ctx, g.banner, W / 2, H * 0.30, {
        mono: true, size: lerp(30, 64, clamp(1 - bt, 0, 1)), col: '#ffffff', align: 'center',
        alpha: clamp(a, 0, 1) * 0.9, glow: '#63e2ff', blur: 22, weight: 800
      });
    }

    // 瞄准与放置预览
    if (g.state === 'PLAY') {
      var can = g.energy > 0 && g.placeCd <= 0 && g.startLock <= 0;
      var mx = g.input.mx, my = g.input.my;
      var col = can ? '#8df0ff' : '#ff6a7e';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, mx, my, CFG.well.r0 * 0.55, col, can ? 0.16 : 0.08);
      ctx.restore();
      ctx.globalAlpha = can ? 0.5 : 0.22;
      ctx.strokeStyle = col; ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 9]);
      ctx.beginPath(); ctx.arc(mx, my, CFG.well.r0, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = can ? 0.85 : 0.3;
      ctx.beginPath(); ctx.arc(mx, my, CFG.well.coreBase, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx - 14, my); ctx.lineTo(mx - 4, my);
      ctx.moveTo(mx + 4, my); ctx.lineTo(mx + 14, my);
      ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my - 4);
      ctx.moveTo(mx, my + 4); ctx.lineTo(mx, my + 14);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 低血/受击红晕
    var dmg = Math.max(g.damageFlash, g.hp === 1 && g.state === 'PLAY' ? 0.22 + Math.sin(g.t * 5) * 0.08 : 0);
    if (dmg > 0.01) {
      var vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, W * 0.6);
      vg.addColorStop(0, 'rgba(255,40,80,0)');
      vg.addColorStop(1, 'rgba(255,40,80,' + (dmg * 0.55).toFixed(3) + ')');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }
  }

  /* ============================== 菜单界面 ============================== */
  function panel(ctx, x, y, w, h, alpha) {
    ctx.fillStyle = 'rgba(5,10,20,' + (alpha || 0.72) + ')';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(110,200,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  function drawMenu(ctx, g) {
    ctx.fillStyle = 'rgba(3,6,12,0.55)';
    ctx.fillRect(0, 0, W, H);
    var t = g.t;
    var cx = W / 2;
    text(ctx, '奇 点', cx, 190 + Math.sin(t * 1.3) * 4, {
      size: 96, col: '#ffffff', align: 'center', glow: '#3fa8d8', blur: 30, weight: 800
    });
    text(ctx, 'S I N G U L A R I T Y', cx, 232, { mono: true, size: 18, col: 'rgba(150,215,255,0.85)', align: 'center', weight: 400 });
    text(ctx, '引力即弹药：把敌人吸进井里 → 质量变成能量 → 空格让一切坍缩', cx, 286,
      { size: 17, col: 'rgba(200,225,245,0.9)', align: 'center' });
    text(ctx, '你的子弹不是买来的，是从敌人身上吸出来的', cx, 312,
      { size: 14, col: 'rgba(130,180,215,0.75)', align: 'center' });

    var bw = 560, bh = 176, bx = cx - bw / 2, by = 348;
    panel(ctx, bx, by, bw, bh, 0.6);
    var lines = [
      ['WASD / 方向键', '移动'],
      ['鼠标左键', '在光标处放置引力井（消耗 1 能量）'],
      ['空格 / 右键', '坍缩：引爆所有井，质量越大爆炸越大'],
      ['Shift', '冲刺（短无敌，用来穿出包围）'],
      ['P / Esc / R / M', '暂停 · 重开 · 静音'],
      ['规则', '吸收敌人 = +1 能量；井 5 秒后自然消散（威力减半）']
    ];
    for (var i = 0; i < lines.length; i++) {
      var y = by + 32 + i * 22;
      text(ctx, lines[i][0], bx + 26, y, { mono: true, size: 14, col: i === 5 ? 'rgba(255,190,110,0.95)' : '#bfe6ff', weight: 600 });
      text(ctx, lines[i][1], bx + 226, y, { size: 14, col: 'rgba(160,200,230,0.9)' });
    }
    var blink = 0.55 + Math.sin(t * 4) * 0.45;
    text(ctx, '点击 或 按任意键 开始', cx, 578, {
      size: 24, col: '#8df0ff', align: 'center', alpha: blink, glow: '#3fa8d8', blur: 18, weight: 700
    });
    text(ctx, '最高分 ' + (g.best | 0), cx, 616, { mono: true, size: 16, col: 'rgba(190,225,250,0.85)', align: 'center' });
    text(ctx, '预算 ¥100 · 限时 2 小时 · 零外部素材（图形与音效全部程序化生成）',
      cx, H - 24, { size: 12, col: 'rgba(110,150,180,0.65)', align: 'center' });
  }
  function drawPause(ctx, g) {
    ctx.fillStyle = 'rgba(3,6,12,0.72)';
    ctx.fillRect(0, 0, W, H);
    text(ctx, '暂停', W / 2, H / 2 - 40, { size: 64, col: '#eaf6ff', align: 'center', glow: '#3fa8d8', blur: 24, weight: 800 });
    text(ctx, '按 P 或 Esc 继续  ·  R 重新开始  ·  M 静音', W / 2, H / 2 + 20,
      { size: 18, col: 'rgba(180,215,240,0.9)', align: 'center' });
    text(ctx, '分数 ' + (g.score | 0) + '  ·  波次 ' + g.wave + '  ·  击杀 ' + g.stats.kills, W / 2, H / 2 + 56,
      { mono: true, size: 15, col: 'rgba(140,190,225,0.8)', align: 'center' });
  }
  function drawDead(ctx, g) {
    var a = clamp(g.deadT / 0.8, 0, 1);
    ctx.fillStyle = 'rgba(3,6,12,' + (0.72 * a).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
    var cx = W / 2;
    text(ctx, '奇 点 消 散', cx, 168, { size: 52, col: '#ff8fa3', align: 'center', glow: '#ff2f5e', blur: 26, weight: 800, alpha: a });
    var bw = 520, bh = 208, bx = cx - bw / 2, by = 214;
    panel(ctx, bx, by, bw, bh, 0.72 * a);
    var rows = [
      ['本局分数', (g.score | 0).toString()],
      ['最高分', (g.best | 0).toString() + (g.score >= g.best && g.score > 0 ? '   ★ 新纪录' : '')],
      ['抵达波次', 'WAVE ' + g.wave],
      ['击杀 / 吸收', g.stats.kills + ' / ' + g.stats.absorbed],
      ['最大连锁', 'x' + g.stats.maxCombo.toFixed(1) + '   （最长连锁链 ' + g.stats.bestChain + '）'],
      ['存活时间', g.stats.time.toFixed(1) + ' 秒'],
      ['坍缩次数', g.stats.novas + ' 次']
    ];
    for (var i = 0; i < rows.length; i++) {
      var y = by + 34 + i * 24;
      text(ctx, rows[i][0], bx + 34, y, { size: 14, col: 'rgba(150,195,230,0.85)' });
      text(ctx, rows[i][1], bx + bw - 34, y, { mono: true, size: 16, col: '#eaf6ff', align: 'right', weight: 700 });
    }
    var blink = 0.55 + Math.sin(g.t * 4) * 0.45;
    text(ctx, '按 R 或 点击 重新开始', cx, 486, { size: 24, col: '#8df0ff', align: 'center', alpha: blink * a, glow: '#3fa8d8', blur: 18, weight: 700 });
    text(ctx, '提示：井攒到 5~8 个质量再坍缩，连锁最爽；分裂体别用吸的，直接炸',
      cx, 534, { size: 14, col: 'rgba(190,215,235,0.85)', align: 'center', alpha: a });
  }

  /* ============================== 主渲染 ============================== */
  function render(g, ctx, view) {
    if (!bgCanvas) buildBg();
    var dpr = view.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#02040a';
    ctx.fillRect(0, 0, view.cssW, view.cssH);
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);

    // 拖尾：用背景以低透明度覆盖，等于免费的运动模糊
    var sx = (Math.random() - 0.5) * g.shake, sy = (Math.random() - 0.5) * g.shake;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.globalAlpha = 0.34;
    ctx.drawImage(bgCanvas, 0, 0);
    ctx.globalAlpha = 1;

    // 待生成警告
    for (var i = 0; i < g.pending.length; i++) {
      var s = g.pending[i];
      var pr = 1 - s.t / s.max;
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, s.x, s.y, 40 + pr * 30, ETYPES[s.type].col, 0.25 + pr * 0.4);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = rgba(ETYPES[s.type].col, 0.3 + pr * 0.6);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, lerp(30, 6, pr), 0, TAU); ctx.stroke();
    }

    for (var w = 0; w < g.wells.length; w++) drawWell(ctx, g, g.wells[w]);
    for (var e = 0; e < g.enemies.length; e++) drawEnemy(ctx, g, g.enemies[e]);
    drawParticles(ctx, g);
    drawPlayer(ctx, g);
    drawTexts(ctx, g);

    // 出手闪光
    if (g.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(190,225,255,' + (g.flash * 0.42).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    // HUD（不跟着抖）
    if (g.state !== 'MENU') drawHUD(ctx, g);
    if (g.state === 'MENU') drawMenu(ctx, g);
    else if (g.state === 'PAUSE') drawPause(ctx, g);
    else if (g.state === 'DEAD') drawDead(ctx, g);
    ctx.restore();
  }

  /* ============================== 启动/输入 ============================== */
  /* 把画布按窗口尺寸铺满，并把 1280x720 的逻辑场地居中裁进视口。
     抽出来是为了让宣传片导演页也能复用同一套坐标换算。 */
  function fitCanvas(canvas, view) {
    view = view || { cssW: 1280, cssH: 720, dpr: 1, scale: 1, ox: 0, oy: 0 };
    view.baseScale = view.baseScale || 1;
    view.baseOx = view.baseOx || 0;
    view.baseOy = view.baseOy || 0;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = window.innerWidth, cssH = window.innerHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    view.cssW = cssW; view.cssH = cssH; view.dpr = dpr;
    view.scale = Math.min(cssW / W, cssH / H);
    view.ox = (cssW - W * view.scale) / 2;
    view.oy = (cssH - H * view.scale) / 2;
    // 记录"无缩放"的基准，导演页的推镜在它上面叠加
    view.baseScale = view.scale; view.baseOx = view.ox; view.baseOy = view.oy;
    return view;
  }

  function boot(canvas) {
    var ctx = canvas.getContext('2d', { alpha: false });
    var audio = makeAudio();
    var best = 0;
    try { best = parseInt(localStorage.getItem('singularity.best') || '0', 10) || 0; } catch (err) { best = 0; }
    var g = S.createGame({ audio: audio, best: best });
    var view = fitCanvas(canvas);
    var params = new URLSearchParams(location.search);

    function resize() { fitCanvas(canvas, view); }
    window.addEventListener('resize', resize);

    function toWorld(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      return {
        x: (clientX - r.left - view.ox) / view.scale,
        y: (clientY - r.top - view.oy) / view.scale
      };
    }
    function saveBest() {
      if (g.score > best) { best = g.score; g.best = best; try { localStorage.setItem('singularity.best', String(best)); } catch (err) { } }
    }
    function beginIfMenu() {
      audio.resume();
      if (g.state === 'MENU' || g.state === 'DEAD') {
        S.startRun(g);
        audio.sfx.ui();
        return true;
      }
      return false;
    }

    // ---- 键盘 ----
    var keyState = {};
    window.addEventListener('keydown', function (ev) {
      var c = ev.code;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].indexOf(c) >= 0) ev.preventDefault();
      if (ev.repeat) return;
      audio.resume();
      if (c === 'Space' || c === 'Enter') { if (beginIfMenu()) return; keyState.collapse = 1; }
      else if (c === 'ShiftLeft' || c === 'ShiftRight') keyState.dash = 1;
      else if (c === 'KeyP' || c === 'Escape') {
        if (g.state === 'PLAY') { g.state = 'PAUSE'; audio.music.stop(); }
        else if (g.state === 'PAUSE') { g.state = 'PLAY'; audio.music.start(); }
      } else if (c === 'KeyM') {
        g.muted = !g.muted; audio.sfx.setMute(g.muted);
        if (g.muted) audio.music.stop(); else { audio.music.start(); audio.music.setIntensity(1 + g.wave * 0.1); }
      } else if (c === 'KeyR') {
        saveBest(); S.startRun(g); audio.sfx.ui();
      } else if (g.state === 'MENU' || g.state === 'DEAD') {
        beginIfMenu();
      }
      keyState[c] = 1;
    });
    window.addEventListener('keyup', function (ev) {
      keyState[ev.code] = 0;
      if (ev.code === 'Space') keyState.collapse = 0;
      if (ev.code === 'ShiftLeft' || ev.code === 'ShiftRight') keyState.dash = 0;
    });

    // ---- 鼠标 ----
    canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    canvas.addEventListener('mousemove', function (ev) {
      var p = toWorld(ev.clientX, ev.clientY);
      g.input.mx = S.clamp(p.x, 20, W - 20);
      g.input.my = S.clamp(p.y, 20, H - 20);
    });
    canvas.addEventListener('mousedown', function (ev) {
      audio.resume();
      var p = toWorld(ev.clientX, ev.clientY);
      g.input.mx = S.clamp(p.x, 20, W - 20);
      g.input.my = S.clamp(p.y, 20, H - 20);
      if (g.state === 'MENU' || g.state === 'DEAD') { beginIfMenu(); return; }
      if (ev.button === 0) keyState.fire = 1;
      if (ev.button === 2) keyState.collapse = 1;
    });
    window.addEventListener('mouseup', function (ev) {
      if (ev.button === 0) keyState.fire = 0;
      if (ev.button === 2) keyState.collapse = 0;
    });
    window.addEventListener('blur', function () {
      keyState.fire = 0; keyState.collapse = 0; keyState.dash = 0;
      if (g.state === 'PLAY') { g.state = 'PAUSE'; audio.music.stop(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && g.state === 'PLAY') { g.state = 'PAUSE'; audio.music.stop(); }
    });

    function syncInput() {
      g.input.left = (keyState.KeyA || keyState.ArrowLeft) ? 1 : 0;
      g.input.right = (keyState.KeyD || keyState.ArrowRight) ? 1 : 0;
      g.input.up = (keyState.KeyW || keyState.ArrowUp) ? 1 : 0;
      g.input.down = (keyState.KeyS || keyState.ArrowDown) ? 1 : 0;
      g.input.fire = keyState.fire ? 1 : 0;
      if (keyState.collapse) { g.input.collapse = 1; keyState.collapse = 0; }
      if (keyState.dash) { g.input.dash = 1; keyState.dash = 0; }
    }

    // ---- 截图/调试模式：?shot=1&t=25&wave=6&nova=1 ----
    if (params.has('shot')) {
      S.startRun(g);
      if (params.has('wave')) { g.wave = parseInt(params.get('wave'), 10) || 1; }
      var secs = parseFloat(params.get('t') || '24');
      var withBot = params.get('bot') !== '0';
      var auto = params.has('nova');
      var total = Math.max(0, Math.round(secs * 60) - (auto ? 18 : 0));
      for (var i = 0; i < total; i++) {
        if (withBot) S.botThink(g);
        S.advance(g, 1 / 60);
        if (g.state === 'DEAD') { S.startRun(g); if (params.has('wave')) g.wave = parseInt(params.get('wave'), 10) || 1; }
      }
      if (auto) {
        // 造一个"正在坍缩"的高光瞬间，用来截图验收美术
        var pts = [[W * 0.32, H * 0.42], [W * 0.62, H * 0.36], [W * 0.5, H * 0.66]];
        for (var k = 0; k < pts.length; k++) {
          var wl = { id: 999 + k, x: pts[k][0], y: pts[k][1], mass: 7, life: 2, rot: k, spin: 1, flash: 1, seed: k, wasted: false };
          g.wells.push(wl);
        }
        S.collapseAll(g);
        g.hitstop = 0; g.slowT = 0; g.timeScale = 1;
        for (var j = 0; j < 15; j++) S.advance(g, 1 / 60);
      }
      g.state = 'SHOT';
      g.frozen = true;
    }

    var last = performance.now();
    function frame(ts) {
      var rdt = (ts - last) / 1000; last = ts;
      syncInput();
      if (!g.frozen) S.advance(g, rdt);
      render(g, ctx, view);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // 调试出口
    window.__GAME__ = g;
    window.__S__ = S;
    window.__syncInput = syncInput;
    window.__renderOnce = function () { render(g, ctx, view); };   // 无合成环境下也能拿到画面
  }

  window.SINGULARITY.boot = boot;
  window.SINGULARITY.render = render;          // 供宣传片/工具逐帧调用
  window.SINGULARITY.fitCanvas = fitCanvas;
  window.SINGULARITY.makeAudio = makeAudio;
})();
