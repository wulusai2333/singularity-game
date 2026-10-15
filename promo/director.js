/*!
 * 宣传片导演页：不录屏，而是"按剧本驱动游戏本体"逐帧渲染。
 *
 * 关键点：游戏是固定步长(1/60)的确定性模拟。这里再把 Math.random 换成固定种子，
 * 于是同一局可以精确重放两遍——
 *   第一遍：不渲染，只记录所有音效事件（时间戳 + 参数）→ 交给 audio.py 复刻真实音轨
 *   第二遍：逐帧渲染 → 交给 ffmpeg 编码
 * 这样音画严格同步，且每一帧都是干净的原始渲染，没有录屏掉帧问题。
 */
(function () {
  'use strict';

  var S = window.SINGULARITY;
  var W = S.W, H = S.H, TAU = S.TAU;
  var clamp = S.clamp, lerp = S.lerp, rand = S.rand;

  var FPS = 60, DT = 1 / FPS, DURATION = 58;
  var FRAMES = Math.round(DURATION * FPS);

  /* ---------------- 1. 确定性随机（两次运行必须逐帧一致） ---------------- */
  var _seed = 20261015 >>> 0;
  Math.random = function () {
    _seed ^= _seed << 13; _seed >>>= 0;
    _seed ^= _seed >>> 17;
    _seed ^= _seed << 5; _seed >>>= 0;
    return _seed / 4294967296;
  };

  /* ---------------- 2. 音效日志（复刻真实音轨用） ---------------- */
  var T = 0, SFX = [];
  function noop() { }
  function lg(name) { return function (a) { SFX.push([+T.toFixed(4), name, typeof a === 'number' ? +a.toFixed(2) : 0]); }; }
  var audioLog = {
    sfx: {
      place: lg('place'), absorb: lg('absorb'), nova: lg('nova'), chain: lg('chain'),
      hit: lg('hit'), dash: lg('dash'), death: lg('death'), wave: lg('wave'),
      spawn: lg('spawn'), ui: lg('ui'), setMute: noop
    },
    music: { start: noop, stop: noop, setIntensity: noop }
  };

  /* ---------------- 3. 初始化 ---------------- */
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d', { alpha: false });
  var view = S.fitCanvas(canvas);
  window.addEventListener('resize', function () { S.fitCanvas(canvas, view); });
  var g = S.createGame({ audio: audioLog });
  S.startRun(g);
  g.state = 'PLAY';
  g.best = 0;

  /* ---------------- 4. 镜头（推镜靠改写 view 的缩放与偏移） ---------------- */
  var cam = { z: 1, fx: W / 2, fy: H / 2, z0: 1, fx0: W / 2, fy0: H / 2, z1: 1, fx1: W / 2, fy1: H / 2, t0: 0, dur: 0 };
  function pushIn(z, fx, fy, dur, ease) {
    cam.z0 = cam.z; cam.fx0 = cam.fx; cam.fy0 = cam.fy;
    cam.z1 = z; cam.fx1 = fx; cam.fy1 = fy;
    cam.t0 = T; cam.dur = Math.max(0.001, dur); cam.ease = ease || 'out';
  }
  function updateCam() {
    var p = clamp((T - cam.t0) / cam.dur, 0, 1);
    var e = cam.ease === 'in' ? p * p : 1 - Math.pow(1 - p, 3);
    cam.z = lerp(cam.z0, cam.z1, e);
    cam.fx = lerp(cam.fx0, cam.fx1, e);
    cam.fy = lerp(cam.fy0, cam.fy1, e);
    view.scale = view.baseScale * cam.z;
    view.ox = view.baseOx + cam.fx * view.baseScale * (1 - cam.z);
    view.oy = view.baseOy + cam.fy * view.baseScale * (1 - cam.z);
  }

  /* ---------------- 5. 覆盖层状态 ---------------- */
  var st = { fade: 1, fadeT: 1, dim: 0, dimT: 0, flash: 0, title: 0, titleT: 0, end: 0, endT: 0, hp: 3, watermark: 0, wmT: 0, red: 0, redT: 0, titleFade: 1 };
  var callouts = [], cards = [];
  function callout(o) { callouts.push(o); return o; }
  function card(o) { cards.push(o); return o; }

  /* ---------------- 6. 场景小工具 ---------------- */
  var nextId = 1;
  function mkEnemy(type, x, y, vx, vy) {
    var t = S.ETYPES[type];
    var e = {
      id: nextId++, type: type, x: clamp(x, 30, W - 30), y: clamp(y, 30, H - 30), vx: vx || 0, vy: vy || 0, r: t.r,
      rot: rand(0, TAU), vr: rand(-2.4, 2.4), chainR: t.chainR || S.CFG.well.chainR,
      immune: 0, t: 0, seed: rand(0, 10), dead: false, flash: 0
    };
    g.enemies.push(e);
    return e;
  }
  function swarm(type, n, cx, cy, r, jitter) {
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TAU, rr = r * (1 + rand(-(jitter || 0.12), jitter || 0.12));
      mkEnemy(type, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  }
  function blob(type, n, cx, cy, r) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, TAU), rr = r * Math.sqrt(Math.random());
      mkEnemy(type, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  }
  function putWell(x, y, mass, life) {
    g.wells.push({
      id: nextId++, x: x, y: y, mass: mass || 0, life: life === undefined ? 99 : life,
      rot: rand(0, TAU), spin: rand(0.9, 1.4), flash: 0, seed: rand(0, 10)
    });
  }
  function lastWell() { return g.wells.length ? g.wells[g.wells.length - 1] : null; }
  function holdSpawn(sec) { g.spawnT = sec; }
  /* 走真实放置流程（有特效和音效），下一帧再把质量设成剧本值 */
  function wellAt(t, x, y, mass) {
    at(t, function () { g.energy = 4; pendingFire(x, y, 4); });
    at(t + 0.08, function () { var w = lastWell(); if (w) { w.mass = mass || 0; w.life = 99; } });
  }
  /* 六边形网格铺敌人：间距必须小于连锁半径(54px)+敌人半径，爆炸才会一圈圈往外传 */
  function field(types, cx, cy, radius, spacing) {
    var rows = Math.ceil(radius / (spacing * 0.87)), n = 0;
    for (var j = -rows; j <= rows; j++) {
      for (var i = -rows; i <= rows; i++) {
        var x = cx + i * spacing + (j & 1 ? spacing * 0.5 : 0);
        var y = cy + j * spacing * 0.87;
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        if (x < 46 || x > W - 46 || y < 46 || y > H - 46) continue;
        mkEnemy(types[n % types.length], x + rand(-5, 5), y + rand(-5, 5));
        n++;
      }
    }
    return n;
  }
  function boom() { S.collapseAll(g); }
  function clearAll() {
    g.enemies.length = 0; g.pending.length = 0; g.parts.length = 0;
    g.texts.length = 0; g.wells.length = 0;
  }
  function playerTo(x, y) { g.player.x = x; g.player.y = y; g.player.vx = 0; g.player.vy = 0; }
  function pendingFire(x, y, n) { pend.fire = { x: x, y: y, n: n || 1 }; }

  /* ---------------- 7. 剧本输入 ---------------- */
  var pend = { fire: null, collapse: false, dash: false };

  /* ---------------- 8. 时间轴 ---------------- */
  var events = [];
  /* 注意：事件回调里还会再注册事件（wellAt 就是这么干的），所以这里必须用"完成标记"
     全表扫描，不能用单指针顺序表——否则运行时新增的事件会被追加到队尾，永远轮不到。 */
  function at(t, fn) { events.push({ t: t, fn: fn, done: false }); }
  function runEvents(t) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.done && e.t <= t) { e.done = true; e.fn(); }
    }
  }

  /* 编排原则：
     1) 每一口井都走真实的放置流程（有特效和音效），不允许凭空出现
     2) 需要展示连锁的镜头，敌人按 56px 六边形网格铺开（小于连锁半径 54+12），
        第一次爆炸只清内圈，冲击波沿网格一圈圈往外传
     3) 玩家站得离爆点远一些，网格整体平移、间距基本不变，连锁才排得出来 */

  // --- 开场 0.0 - 7.2：你没有枪 ---
  at(0.00, function () {
    clearAll(); holdSpawn(999); playerTo(W * 0.5, H * 0.78);
    st.fade = 1; st.fadeT = 1;
  });
  at(0.35, function () {
    st.fadeT = 0;
    callout({ t0: 0.45, t1: 2.40, main: '你 没 有 枪', sub: 'YOU  HAVE  NO  GUN', x: W / 2, y: 236, align: 'center', size: 68, col: '#ffffff', glow: '#ff5f7e' });
  });
  at(1.95, function () { field(['drifter'], W * 0.5, H * 0.34, 290, 56); });
  at(2.10, function () { wellAt(2.10, W * 0.5, H * 0.34, 0); });
  at(2.60, function () { callout({ t0: 2.75, t1: 4.85, main: '它会把附近的敌人吸进来', x: W / 2, y: 628, align: 'center', size: 26, col: '#bfe6ff' }); });
  at(3.20, function () { field(['drifter'], W * 0.5, H * 0.34, 250, 56); });
  at(4.00, function () { field(['drifter'], W * 0.5, H * 0.34, 220, 56); var w = lastWell(); if (w) w.mass = 6; });
  at(4.30, function () { var w = lastWell(); if (w) w.mass = 13; });
  at(4.95, function () { boom(); pushIn(1.14, W * 0.5, H * 0.34, 0.28); st.flash = 0.85; });
  at(5.75, function () { callout({ t0: 5.90, t1: 7.20, main: '而你只按了一下空格', x: W / 2, y: 566, align: 'center', size: 24, col: 'rgba(210,235,250,0.95)' }); });
  at(6.40, function () { clearAll(); pushIn(1, W / 2, H / 2, 0.9); });

  // --- 标题卡 7.2 - 10.6 ---
  at(7.20, function () {
    clearAll();
    field(['drifter'], W * 0.5, H * 0.5, 430, 62);
    wellAt(7.30, W * 0.26, H * 0.32, 4);
    wellAt(7.80, W * 0.74, H * 0.66, 6);
    playerTo(W * 0.5, H * 0.52);
    st.dimT = 0.62; st.titleT = 1; st.watermarkT = 1;
    pushIn(1.06, W / 2, H / 2, 3.4, 'in');
  });
  at(10.10, function () { st.titleT = 0; st.dimT = 0.10; });

  // --- 教学 1：左键放井 10.7 - 15.0 ---
  at(10.70, function () {
    clearAll(); holdSpawn(999);
    playerTo(W * 0.24, H * 0.66);
    for (var i = 0; i < 16; i++) mkEnemy('drifter', W * 1.03 + i * 24, H * 0.30 + Math.sin(i * 0.7) * 60, -80, 8);
    callout({ t0: 11.0, t1: 15.3, main: '左键：扔下一个引力井', sub: '它就是你的枪', x: 130, y: 150, align: 'left', size: 38, col: '#ffffff', accent: '#63e2ff' });
  });
  at(12.30, function () { wellAt(12.30, W * 0.58, H * 0.44, 0); });
  at(13.60, function () { var w = lastWell(); if (w) w.mass = 7; });

  // --- 教学 2：吸收 = 弹药 15.0 - 18.6 ---
  at(15.00, function () {
    callout({ t0: 15.3, t1: 19.0, main: '吸收 1 个敌人 = +1 弹药', sub: '子弹不是买来的，是抢来的', x: 130, y: 150, align: 'left', size: 38, col: '#ffffff', accent: '#7cff9b', hudBox: true });
  });
  at(15.20, function () { var w = lastWell(); if (w) w.mass = 4; field(['drifter', 'drifter', 'splitter'], W * 0.60, H * 0.42, 205, 58); });

  // --- 教学 3：空格坍缩 + 连锁 18.6 - 25.6 ---
  at(18.60, function () {
    clearAll(); holdSpawn(999);
    playerTo(W * 0.24, H * 0.82);
    field(['drifter', 'drifter', 'rusher', 'splitter'], W * 0.60, H * 0.34, 320, 56);
    callout({ t0: 18.9, t1: 22.2, main: '空格：坍缩', sub: '把攒下的质量一次放出去', x: 130, y: 150, align: 'left', size: 44, col: '#ffffff', accent: '#ffd479' });
  });
  wellAt(20.40, W * 0.60, H * 0.34, 1);        // 故意用很小的井：靠连锁吃满全场
  at(20.90, function () { boom(); pushIn(1.16, W * 0.60, H * 0.34, 0.26); st.flash = 0.70; });
  at(21.90, function () { callout({ t0: 22.1, t1: 25.8, main: '小井也能一路连锁', sub: '3 个质量 = 半径 143px，靠连锁吃掉整片', x: 130, y: 150, align: 'left', size: 38, col: '#ffffff', accent: '#c9a3ff' }); });
  at(23.30, function () {
    clearAll();
    playerTo(W * 0.5, H * 0.88);
    field(['drifter', 'drifter', 'rusher', 'splitter', 'drifter'], W * 0.5, H * 0.28, 300, 56);
    wellAt(23.80, W * 0.40, H * 0.30, 3);
    wellAt(24.25, W * 0.60, H * 0.30, 3);
  });
  at(24.55, function () { boom(); pushIn(1.10, W * 0.5, H * 0.30, 0.30); st.flash = 0.60; });
  at(25.60, function () { pushIn(1, W / 2, H / 2, 1.2); });

  // --- 敌人档案 25.8 - 34.6 ---
  at(25.80, function () {
    clearAll(); holdSpawn(999); st.flash = 0.45;
    playerTo(W * 0.30, H * 0.52);
    for (var i = 0; i < 9; i++) mkEnemy('rusher', W * 1.04 + i * 28, H * 0.26 + i * 26, -180, 0);
    callout({ t0: 26.1, t1: 28.6, main: '突 击 者', sub: '快得吸不住 —— 只能炸', x: 120, y: 300, align: 'left', size: 52, col: '#ff5f7e', accent: '#ff5f7e', band: true });
  });
  at(27.40, function () { pend.dash = true; });
  at(28.60, function () {
    clearAll(); st.flash = 0.45;
    playerTo(W * 0.28, H * 0.66);
    blob('splitter', 6, W * 0.60, H * 0.42, 120);
    wellAt(28.80, W * 0.60, H * 0.42, 1);
    callout({ t0: 28.9, t1: 31.6, main: '分 裂 体', sub: '吸进去会裂成两个小的', x: 120, y: 300, align: 'left', size: 52, col: '#7cff9b', accent: '#7cff9b', band: true });
  });
  at(31.60, function () {
    clearAll(); st.flash = 0.45;
    playerTo(W * 0.26, H * 0.72);
    mkEnemy('jugger', W * 0.62, H * 0.32); mkEnemy('jugger', W * 0.76, H * 0.52);
    field(['drifter'], W * 0.68, H * 0.42, 190, 58);
    wellAt(33.00, W * 0.64, H * 0.38, 5);
    wellAt(33.42, W * 0.72, H * 0.46, 5);
    callout({ t0: 31.9, t1: 34.8, main: '重 装', sub: '引力拉不动 —— 得用攒大的井炸', x: 120, y: 300, align: 'left', size: 52, col: '#ffb14e', accent: '#ffb14e', band: true });
  });
  at(33.80, function () { boom(); pushIn(1.12, W * 0.68, H * 0.42, 0.30); st.flash = 0.75; });
  at(34.60, function () { pushIn(1, W / 2, H / 2, 1.0); });

  // --- 压力段 34.6 - 42.2：放开刷怪，进入混战 ---
  at(34.60, function () {
    clearAll();
    g.wave = 9; g.spawnT = 0.5;
    playerTo(W * 0.5, H * 0.76);
    field(['drifter', 'drifter', 'rusher'], W * 0.5, H * 0.28, 330, 58);
    st.redT = 1;
    callout({ t0: 34.9, t1: 38.6, main: '每 25 秒一波，越往后越密', sub: '第 5 波起出现重装集群', x: 130, y: 150, align: 'left', size: 38, col: '#ffffff', accent: '#ff8fa3' });
  });
  at(36.40, function () { g.banner = 'WAVE 9'; g.bannerT = 2.0; });
  at(37.50, function () { wellAt(37.50, W * 0.40, H * 0.34, 5); wellAt(37.92, W * 0.60, H * 0.38, 5); });
  at(38.30, function () { boom(); pushIn(1.12, W * 0.5, H * 0.36, 0.32); st.flash = 0.70; });
  at(39.10, function () {
    field(['drifter', 'rusher', 'splitter'], W * 0.5, H * 0.32, 300, 58);
    mkEnemy('jugger', W * 0.26, H * 0.24);
    wellAt(39.40, W * 0.52, H * 0.40, 4);
  });
  at(40.40, function () { wellAt(40.40, W * 0.34, H * 0.26, 6); wellAt(40.82, W * 0.66, H * 0.50, 6); });
  at(41.10, function () { boom(); pushIn(1.10, W * 0.5, H * 0.40, 0.30); st.flash = 0.60; st.redT = 0; });

  // --- 高潮 42.2 - 47.8：一次连锁清屏 ---
  at(42.20, function () {
    clearAll(); holdSpawn(999); st.redT = 0;
    playerTo(W * 0.5, H * 0.90);
    field(['drifter', 'drifter', 'drifter', 'rusher', 'splitter'], W * 0.5, H * 0.30, 320, 56);
    wellAt(42.45, W * 0.38, H * 0.26, 4);
    wellAt(42.88, W * 0.60, H * 0.30, 4);
    wellAt(43.05, W * 0.50, H * 0.34, 3);
    callout({ t0: 42.9, t1: 45.6, main: '一张图算不清的连锁', x: W / 2, y: 612, align: 'center', size: 30, col: '#ffffff', accent: '#ffd479' });
  });
  at(43.35, function () { boom(); pushIn(1.20, W * 0.5, H * 0.30, 0.26); st.flash = 0.95; });
  at(45.00, function () { pushIn(1, W / 2, H / 2, 1.4); });

  // --- 高潮余波：再铺一波，炸一次，然后阵亡 ---
  at(44.50, function () {
    g.spawnT = 0.35;                                  // 放开刷怪，别让画面空掉
    field(['drifter', 'rusher', 'splitter'], W * 0.5, H * 0.34, 265, 58);
    mkEnemy('jugger', W * 0.30, H * 0.30);
    wellAt(45.25, W * 0.46, H * 0.40, 5);
  });
  at(45.80, function () { boom(); st.flash = 0.55; g.shake = 20; });

  // --- 收尾 46.4 - 53.6：阵亡与结算 ---
  at(46.40, function () {
    st.hp = 1; g.player.invuln = 0;     // 放开血量限制，让这一下真的把主角打死
    for (var i = 0; i < 7; i++) mkEnemy('drifter', g.player.x + rand(-14, 14), g.player.y + rand(-14, 14));
  });
  at(48.60, function () { callout({ t0: 48.9, t1: 53.2, main: '你能活到第几波？', sub: '每局 1~3 分钟，最高分存在本地', x: W / 2, y: 76, align: 'center', size: 40, col: '#ffffff', glow: '#63e2ff' }); });
  at(52.90, function () { st.fadeT = 1; st.watermarkT = 0; });
  at(53.60, function () { st.endT = 1; st.fade = 1; st.fadeT = 1; });

  events.sort(function (a, b) { return a.t - b.t; });

  /* ============================== 文本绘制 ============================== */
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function font(size, weight, mono) {
    return (weight || 700) + ' ' + size + 'px ' + (mono ? 'Consolas, Menlo, monospace' : '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif');
  }
  function label(str, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.font = font(o.size || 30, o.weight || 700, o.mono);
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'middle';
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = (o.spacing || 0) + 'px';
    ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
    if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = o.blur || 26; }
    if (o.stroke) { ctx.lineWidth = o.strokeW || 6; ctx.strokeStyle = o.stroke; ctx.strokeText(str, x, y); }
    ctx.fillStyle = o.col || '#ffffff';
    ctx.fillText(str, x, y);
    ctx.restore();
  }
  function win(t, a, b, fin, fout) {
    fin = fin || 0.35; fout = fout || 0.35;
    if (t < a || t > b) return 0;
    return Math.min(1, (t - a) / fin, (b - t) / fout);
  }

  /* 高亮 HUD 弹药区（逻辑坐标里画） */
  function drawHudHighlight(alpha, t) {
    if (alpha <= 0.01) return;
    var x = 140, y = H - 26 - 44, w = 132, h = 52;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(124,255,155,0.85)';
    ctx.lineWidth = 2.5;
    var pad = 3 + Math.sin(t * 5) * 2;
    ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.globalAlpha = alpha * 0.5;
    ctx.strokeRect(x - pad - 6, y - pad - 6, w + pad * 2 + 12, h + pad * 2 + 12);
    ctx.restore();
    label('弹药在这里长出来', x + w + 34, y + h / 2, { size: 20, col: '#c8ffd8', alpha: alpha, baseline: 'middle' });
    ctx.save();
    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = '#7cff9b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w + 24, y + h / 2); ctx.lineTo(x + w + 8, y + h / 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawOverlay(t) {
    // 底部字幕式 callout
    for (var i = 0; i < callouts.length; i++) {
      var c = callouts[i], a = win(t, c.t0, c.t1) * st.titleFade;
      if (a <= 0.01) continue;
      if (c.band) {
        var gg = ctx.createLinearGradient(0, c.y - 50, 0, c.y + 50);
        gg.addColorStop(0, 'rgba(3,6,12,0)');
        gg.addColorStop(0.5, 'rgba(3,6,12,' + (0.72 * a).toFixed(3) + ')');
        gg.addColorStop(1, 'rgba(3,6,12,0)');
        ctx.fillStyle = gg;
        ctx.fillRect(0, c.y - 50, W, 100);
      }
      var dx = (1 - a) * (c.align === 'center' ? 0 : -26);
      if (c.accent) {
        ctx.save();
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = c.accent;
        ctx.fillRect(c.x + dx - 22, c.y - (c.size || 38) * 0.62, 5, (c.size || 38) * 1.25);
        ctx.restore();
      }
      label(c.main, c.x + dx, c.y, { size: c.size || 38, col: c.col || '#fff', align: c.align, glow: c.glow || 'rgba(60,160,220,0.9)', alpha: a, blur: 22 });
      if (c.sub) label(c.sub, c.x + dx + (c.accent ? 2 : 0), c.y + (c.size || 38) * 0.72, { size: (c.size || 38) * 0.46, col: 'rgba(190,220,240,0.92)', align: c.align, alpha: a, weight: 500 });
      if (c.hudBox) drawHudHighlight(win(t, c.t0 + 0.5, c.t1 - 0.4), t);
    }
  }

  function drawTitleCard() {
    var a = st.title;
    if (a <= 0.01) return;
    ctx.save();
    var n = 1 - a;
    label('奇  点', W / 2, H * 0.40 - n * 20, { size: 118, col: '#ffffff', align: 'center', glow: '#3fa8d8', blur: 44, alpha: a, glow2: 1 });
    ctx.restore();
    label('S I N G U L A R I T Y', W / 2, H * 0.40 + 74, { size: 22, col: 'rgba(150,215,255,0.92)', align: 'center', alpha: a, spacing: 6, weight: 500 });
    ctx.save();
    ctx.globalAlpha = a * 0.8;
    ctx.fillStyle = 'rgba(120,200,255,0.7)';
    ctx.fillRect(W / 2 - 150, H * 0.40 + 112, 300, 1.5);
    ctx.restore();
    label('引 力 即 弹 药', W / 2, H * 0.40 + 158, { size: 30, col: '#dfefff', align: 'center', alpha: a, spacing: 8, weight: 600 });
    label('吸收 · 攒质量 · 坍缩', W / 2, H * 0.40 + 206, { size: 21, col: 'rgba(160,200,230,0.9)', align: 'center', alpha: a, spacing: 4, weight: 500 });
    label('零素材 · 零依赖 · 双击即玩', W / 2, H * 0.40 + 258, { size: 18, col: 'rgba(255,214,150,0.95)', align: 'center', alpha: a, spacing: 2, weight: 500 });
  }

  function drawEndCard() {
    var a = st.end;
    if (a <= 0.01) return;
    ctx.save();
    ctx.fillStyle = 'rgba(2,4,10,' + (0.97 * Math.min(1, a * 1.4)).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    var e = easeInOut(clamp(a * 1.6, 0, 1));
    label('奇 点  SINGULARITY', W / 2, H * 0.20 - (1 - e) * 16, { size: 72, col: '#ffffff', align: 'center', glow: '#3fa8d8', blur: 40, alpha: e, spacing: 4 });
    label('引 力 即 弹 药', W / 2, H * 0.20 + 62, { size: 24, col: 'rgba(180,220,245,0.92)', align: 'center', alpha: e, spacing: 10, weight: 500 });

    ctx.save(); ctx.globalAlpha = e * 0.7; ctx.fillStyle = 'rgba(120,200,255,0.5)';
    ctx.fillRect(W / 2 - 300, H * 0.20 + 104, 600, 1.2); ctx.restore();

    label('在线试玩', W / 2 - 250, 420, { size: 20, col: 'rgba(140,190,225,0.9)', alpha: e, align: 'right', weight: 500 });
    label('wulusai2333.github.io/singularity-game', W / 2 - 220, 420, { size: 26, col: '#8df0ff', alpha: e, mono: true, glow: '#1d6f9c', blur: 18 });
    label('开源仓库', W / 2 - 250, 466, { size: 20, col: 'rgba(140,190,225,0.9)', alpha: e, align: 'right', weight: 500 });
    label('github.com/wulusai2333/singularity-game', W / 2 - 220, 466, { size: 26, col: '#8df0ff', alpha: e, mono: true, glow: '#1d6f9c', blur: 18 });

    label('零素材 · 零依赖 · MIT  ｜  预算 ¥100  ·  限时 2 小时', W / 2, 552, { size: 21, col: 'rgba(255,214,150,0.95)', align: 'center', alpha: e, weight: 500 });
    label('双击 index.html 即玩', W / 2, 600, { size: 26, col: '#ffffff', align: 'center', alpha: e, glow: '#63e2ff', blur: 20 });
  }

  function drawWatermark() {
    if (st.watermark <= 0.01) return;
    label('奇点 SINGULARITY', W - 26, H - 26, { size: 15, col: 'rgba(150,200,235,0.55)', align: 'right', baseline: 'alphabetic', alpha: st.watermark, weight: 500, spacing: 1 });
  }

  /* ============================== 主循环 ============================== */
  var frame = 0;
  function stepOnly() {
    var t = frame / FPS;
    T = t;
    runEvents(t);
    // 剧本控制血量/无敌，保证走位戏不被意外打断
    g.hp = st.hp;
    g.startLock = 0;
    S.botThink(g);                                   // 移动交给 AI，看起来像真人在打
    g.input.fire = 0; g.input.collapse = 0; g.input.dash = 0;
    if (pend.fire) {
      g.energy = Math.max(g.energy, 1);
      g.input.mx = pend.fire.x; g.input.my = pend.fire.y; g.input.fire = 1;
      if (--pend.fire.n <= 0) pend.fire = null;
    }
    if (pend.collapse) { g.input.collapse = 1; pend.collapse = false; }
    if (pend.dash) { g.input.dash = 1; pend.dash = false; }
    S.advance(g, DT);
    frame++;
  }
  function draw() {
    var t = frame / FPS;
    st.fade += (st.fadeT - st.fade) * 0.09;
    st.dim += (st.dimT - st.dim) * 0.07;
    st.title += (st.titleT - st.title) * 0.055;
    st.end += (st.endT - st.end) * 0.05;
    st.red += (st.redT - st.red) * 0.06;
    st.watermark += ((st.watermarkT === undefined ? 0 : st.watermarkT) - st.watermark) * 0.05;
    st.flash *= 0.80;
    st.titleFade = 1 - st.title * 0.55;

    updateCam();
    S.render(g, ctx, view);

    // 覆盖层：逻辑坐标系
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);

    if (coverMode) {
      drawCover();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }

    drawOverlay(t);
    drawTitleCard();
    drawWatermark();

    // 全屏效果
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (st.red > 0.01) {
      var pulse = st.red * (0.5 + 0.5 * Math.sin(t * 4.2));
      var rg = ctx.createRadialGradient(view.cssW / 2, view.cssH / 2, view.cssH * 0.34, view.cssW / 2, view.cssH / 2, view.cssW * 0.62);
      rg.addColorStop(0, 'rgba(255,40,80,0)');
      rg.addColorStop(1, 'rgba(255,40,80,' + (pulse * 0.42).toFixed(3) + ')');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, view.cssW, view.cssH);
    }
    if (st.dim > 0.005) {
      ctx.fillStyle = 'rgba(2,4,10,' + st.dim.toFixed(3) + ')';
      ctx.fillRect(0, 0, view.cssW, view.cssH);
    }
    if (st.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(210,235,255,' + (st.flash * 0.5).toFixed(3) + ')';
      ctx.fillRect(0, 0, view.cssW, view.cssH);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    // 注意顺序：先压黑，再画片尾卡。反过来会把片尾卡整块盖掉。
    if (st.fade > 0.004) {
      ctx.fillStyle = 'rgba(0,0,0,' + st.fade.toFixed(3) + ')';
      ctx.fillRect(0, 0, view.cssW, view.cssH);
    }
    // 片尾卡用的是 1280x720 逻辑坐标，所以必须切回逻辑坐标系再画
    if (st.end > 0.01) {
      ctx.save();
      ctx.translate(view.ox, view.oy);
      ctx.scale(view.scale, view.scale);
      drawEndCard();
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* 封面：跑到指定时刻再叠封面字样 */
  var coverMode = false;
  function drawCover() {
    // 封面可能是在"压镜"状态下截的（高潮镜头 scale 1.2），
    // 所以这里显式建立一个固定的 1280x720 -> 实际像素 变换，全程不受当前镜头影响。
    var k = view.cssH / 720;
    ctx.save();
    ctx.setTransform(view.dpr * k, 0, 0, view.dpr * k, 0, 0);

    // 上下压暗：中间留给标题，底部压出一条能读字的暗带
    var cg = ctx.createLinearGradient(0, 0, 0, H);
    cg.addColorStop(0, 'rgba(2,4,10,0.52)');
    cg.addColorStop(0.45, 'rgba(2,4,10,0.30)');
    cg.addColorStop(1, 'rgba(2,4,10,0.74)');
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, W, H);

    label('奇 点', W / 2, 296, { size: 148, col: '#ffffff', align: 'center', glow: '#3fa8d8', blur: 60, spacing: 10 });
    label('S I N G U L A R I T Y', W / 2, 386, { size: 28, col: 'rgba(170,225,255,0.95)', align: 'center', spacing: 8, weight: 500 });
    label('引 力 即 弹 药', W / 2, 456, { size: 40, col: '#ffffff', align: 'center', spacing: 12, glow: '#63e2ff', blur: 24 });
    label('零素材 · 零依赖 · 双击 index.html 即玩', W / 2, 516, { size: 24, col: 'rgba(255,214,150,0.97)', align: 'center', weight: 500 });

    ctx.fillStyle = 'rgba(2,6,14,0.62)';
    ctx.fillRect(0, 580, W, 76);
    label('wulusai2333.github.io/singularity-game', W / 2, 618, { size: 30, col: '#9df4ff', align: 'center', mono: true, glow: '#1d6f9c', blur: 18 });

    ctx.restore();
  }

  window.__PROMO = {
    fps: FPS, total: FRAMES, duration: DURATION,
    step: function () { stepOnly(); draw(); },
    stepOnly: stepOnly,
    draw: draw,
    sfx: function () { return SFX; },
    info: function () {
      return {
        frame: frame, t: +(frame / FPS).toFixed(2), total: FRAMES, state: g.state,
        kills: g.stats.kills, score: g.score | 0, enemies: g.enemies.length,
        wells: g.wells.length, combo: +g.combo.toFixed(1), novas: g.stats.novas, depth: g.stats.chains,
        view: { scale: +view.scale.toFixed(4), ox: +view.ox.toFixed(2), oy: +view.oy.toFixed(2),
                dpr: view.dpr, cssW: view.cssW, cssH: view.cssH, baseScale: +view.baseScale.toFixed(4),
                canvas: canvas.width + 'x' + canvas.height, winDpr: window.devicePixelRatio }
      };
    },
    /* 封面：快进到指定帧，切成干净构图再叠封面字样 */
    cover: function (targetFrame) {
      while (frame < targetFrame) stepOnly();
      coverMode = true;
      draw();
    }
  };
})();
