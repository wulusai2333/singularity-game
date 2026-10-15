/*!
 * 奇点 SINGULARITY — 纯逻辑层（零 DOM 依赖，可在 Node 里无头对局测试）
 *
 * 核心循环：引力井把敌人吸进来 -> 井的质量变成你的能量 -> 空格让所有井「坍缩」
 *           -> 攒下的质量变成一次连锁核爆。弹药不是买来的，是从敌人身上吸出来的。
 *
 * 约束：预算 ¥100 / 限时 2 小时 / 无需求文档 / 无考素材 / 全部程序化生成
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.SINGULARITY = Object.assign(root.SINGULARITY || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var TAU = Math.PI * 2;
  var W = 1280, H = 720;                 // 逻辑分辨率（也是竞技场大小）

  /* ------------------------------- 工具 ------------------------------- */
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randi(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function pickOne(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

  /* ------------------------------ 调参表 ------------------------------ */
  var CFG = {
    W: W, H: H,
    fixedDt: 1 / 60,
    player: {
      r: 12, accel: 2500, drag: 6.6, maxSpeed: 420,
      hp: 3, invuln: 1.7,
      dashSpeed: 980, dashTime: 0.15, dashCd: 1.05, dashInvuln: 0.24
    },
    well: {
      life: 5.0,          // 井的寿命（秒）
      r0: 92,             // 初始引力半径
      pull: 1950,         // 引力加速度基数
      coreBase: 16,       // 吞噬核心半径
      placeCd: 0.32,      // 放置冷却
      start: 2, max: 4,   // 初始/最大能量
      regen: 7.0,         // 被动回能（保险丝，防止彻底无力）
      novaR: 62,          // 坍缩基础半径
      novaPerMass: 27,    // 每点质量增加的坍缩半径
      novaMax: 268,       // 坍缩半径上限
      emptyPower: 0.5,    // 空井自爆威力
      growth: 0.045,      // 质量 -> 引力半径成长
      chainR: 54          // 敌人被炸死后的连锁半径
    },
    combo: { window: 1.35, cap: 6, step: 0.5 },
    slowmo: { kills: 7, scale: 0.28, time: 0.34 },
    maxParticles: 1100,
    enemyDrag: 1.6,
    waveDur: function (w) { return clamp(26 - w * 0.6, 13, 26); },
    maxAlive: function (w) { return Math.min(150, 14 + w * 6); },
    spawnInterval: function (w) { return clamp(1.00 - 0.045 * (w - 1), w >= 10 ? 0.34 : 0.42, 1.00); },
    packInterval: function (w) { return clamp(3.3 - 0.11 * (w - 1), 1.5, 3.3); },
    packSize: function (w) { return Math.min(9, 2 + Math.floor(w * 0.55)); },
    speedMul: function (w) { return Math.min(2.1, 1 + 0.045 * (w - 1)); }
  };

  /* ------------------------------- 敌人 ------------------------------- */
  // mass = 对引力的敏感度（越大越容易被吸），pull = 引力响应系数，accel = 追玩家的加速度
  var ETYPES = {
    drifter:  { r: 12, speed: 74,  accel: 130, pull: 1.15, score: 10, col: '#5fd8ff', shape: 'tri' },
    rusher:   { r: 10, speed: 190, accel: 300, pull: 0.45, score: 15, col: '#ff5f7e', shape: 'diamond' },
    splitter: { r: 16, speed: 54,  accel: 95,  pull: 0.75, score: 20, col: '#7cff9b', shape: 'square', splits: 2 },
    spawn:    { r: 8,  speed: 155, accel: 240, pull: 1.50, score: 5,  col: '#c8ff6b', shape: 'dot' },
    jugger:   { r: 24, speed: 38,  accel: 70,  pull: 0.20, score: 80, col: '#ffb14e', shape: 'hex', chainR: 118 }
  };

  /* --------------------------- 无音频占位实现 --------------------------- */
  function noop() {}
  var nullAudio = {
    sfx: {
      place: noop, absorb: noop, nova: noop, chain: noop, hit: noop,
      dash: noop, death: noop, wave: noop, spawn: noop, ui: noop, setMute: noop
    },
    music: { start: noop, stop: noop, setIntensity: noop }
  };

  /* ----------------------------- 状态工厂 ----------------------------- */
  function createGame(opts) {
    opts = opts || {};
    var g = {
      version: VERSION,
      state: 'MENU',              // MENU | PLAY | PAUSE | DEAD | SHOT
      t: 0, acc: 0, dt: CFG.fixedDt,
      hitstop: 0, slowT: 0, timeScale: 1,
      score: 0, best: opts.best || 0,
      wave: 1, waveT: 0, spawnT: 0.8, packT: 1.6, banner: '', bannerT: 0,
      hp: CFG.player.hp, energy: CFG.well.start, regenT: 0, energyPulse: 0,
      placeCd: 0, dashCd: 0, startLock: 0.3,
      combo: 1, chainKills: 0, comboT: 0,
      shake: 0, flash: 0, damageFlash: 0,
      player: {
        x: W / 2, y: H / 2, vx: 0, vy: 0, r: CFG.player.r,
        invuln: 0, dashT: 0, facing: -Math.PI / 2, trail: []
      },
      enemies: [], wells: [], parts: [], texts: [], pending: [],
      input: { up: 0, down: 0, left: 0, right: 0, fire: 0, collapse: 0, dash: 0, mx: W / 2, my: H / 2 },
      stats: { kills: 0, absorbed: 0, novas: 0, chains: 0, maxCombo: 1, time: 0, wells: 0, bestChain: 0 },
      grid: null, nextId: 1,
      menuT: 0, menuWellT: 1, menuSpawnT: 1, deadT: 0,
      audio: opts.audio || nullAudio,
      frozen: false, demo: !!opts.demo
    };
    seedAmbient(g);
    // 主菜单立刻就有动静：两口井 + 一小波正在飞进来的敌人
    g.wells.push(makeWell(g, W * 0.34, H * 0.44));
    g.wells.push(makeWell(g, W * 0.68, H * 0.62));
    g.wells[0].mass = 2;
    for (var q = 0; q < 6; q++) queueSpawn(g, q % 3 === 2 ? 'rusher' : 'drifter', 0.12 + q * 0.22);
    g.menuWellT = 2.0; g.menuSpawnT = 1.6;
    return g;
  }

  /* 主菜单背景也是活的：开局先丢几个漩涡粒子 */
  function seedAmbient(g) {
    for (var i = 0; i < 90; i++) {
      var a = rand(0, TAU), r = rand(60, 620);
      part(g, {
        kind: 'dust', x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r,
        vx: -Math.sin(a) * rand(6, 26), vy: Math.cos(a) * rand(6, 26),
        life: rand(2, 7), r: rand(0.8, 2.2), col: pickOne(['#2b6f9c', '#1d4f78', '#3d8fbf'])
      });
    }
  }

  function resetRun(g) {
    g.state = 'PLAY';
    g.t = 0; g.acc = 0; g.hitstop = 0; g.slowT = 0; g.timeScale = 1;
    g.score = 0; g.wave = 1; g.waveT = 0; g.spawnT = 0.8; g.packT = 1.6;
    g.hp = CFG.player.hp; g.energy = CFG.well.start; g.regenT = 0; g.energyPulse = 0;
    g.placeCd = 0; g.dashCd = 0; g.startLock = 0.3;
    g.combo = 1; g.chainKills = 0; g.comboT = 0;
    g.shake = 0; g.flash = 0; g.damageFlash = 0;
    g.enemies.length = 0; g.wells.length = 0; g.parts.length = 0; g.texts.length = 0; g.pending.length = 0;
    var p = g.player;
    p.x = W / 2; p.y = H / 2; p.vx = 0; p.vy = 0; p.invuln = 1.0; p.dashT = 0; p.facing = -Math.PI / 2; p.trail.length = 0;
    g.stats = { kills: 0, absorbed: 0, novas: 0, chains: 0, maxCombo: 1, time: 0, wells: 0, bestChain: 0 };
    g.deadT = 0;
    g.banner = 'WAVE 1'; g.bannerT = 2.2;
    seedAmbient(g);
  }

  function startRun(g) {
    resetRun(g);
    g.audio.music.start();
    g.audio.music.setIntensity(1);
    g.audio.sfx.wave();
  }

  /* ------------------------------- 粒子 ------------------------------- */
  function part(g, o) {
    if (g.parts.length >= CFG.maxParticles) g.parts.shift();
    o.max = o.life;
    o.rot = o.rot || 0; o.vr = o.vr || 0;
    g.parts.push(o);
    return o;
  }
  function spark(g, x, y, col, opt) {
    opt = opt || {};
    var a = opt.a !== undefined ? opt.a : rand(0, TAU);
    var sp = opt.speed !== undefined ? opt.speed : rand(40, 240);
    return part(g, {
      kind: 'spark', x: x, y: y,
      vx: Math.cos(a) * sp + (opt.vx || 0), vy: Math.sin(a) * sp + (opt.vy || 0),
      life: opt.life || rand(0.25, 0.7), r: opt.r || rand(1.2, 3.0),
      col: col, drag: opt.drag === undefined ? 2.6 : opt.drag
    });
  }
  function burst(g, x, y, col, n, opt) {
    opt = opt || {};
    for (var i = 0; i < n; i++) spark(g, x, y, col, opt);
  }
  function ringPart(g, x, y, col, r0, r1, life, w, soft) {
    part(g, { kind: 'ring', x: x, y: y, r0: r0, r1: r1, life: life, r: r0, col: col, w: w || 3, soft: !!soft, drag: 0 });
  }
  function popText(g, x, y, text, col, size) {
    g.textSeq = (g.textSeq || 0) + 1;
    g.texts.push({
      x: x + rand(-16, 16), y: y + ((g.textSeq % 3) - 1) * 13 + rand(-5, 5),
      text: text, col: col, size: size || 20, life: 0.9, max: 0.9, vy: -46
    });
    if (g.texts.length > 60) g.texts.shift();
  }

  /* ------------------------------- 敌人 ------------------------------- */
  function spawnEnemy(g, type, x, y) {
    var t = ETYPES[type];
    var e = {
      id: g.nextId++, type: type, x: x, y: y, vx: 0, vy: 0, r: t.r,
      rot: rand(0, TAU), vr: rand(-2.6, 2.6) * (Math.random() < 0.5 ? -1 : 1),
      chainR: t.chainR || CFG.well.chainR, immune: 0, t: 0, seed: rand(0, 10), dead: false, flash: 0
    };
    g.enemies.push(e);
    return e;
  }

  function queueSpawn(g, type, delay) {
    var side = randi(0, 3), x, y, m = 16;
    if (side === 0) { x = rand(m, W - m); y = m; }
    else if (side === 1) { x = W - m; y = rand(m, H - m); }
    else if (side === 2) { x = rand(m, W - m); y = H - m; }
    else { x = m; y = rand(m, H - m); }
    g.pending.push({ x: x, y: y, type: type, t: delay === undefined ? 0.6 : delay, max: delay === undefined ? 0.6 : delay });
    g.audio.sfx.spawn();
  }

  /* 一小股敌人从同一个方向压过来——比一颗一颗挤出来更有压迫感，也更值得用井去接 */
  function queuePack(g, n, delay) {
    var side = randi(0, 3), bx, by, i;
    var m = 22;
    if (side === 0) { bx = rand(W * 0.2, W * 0.8); by = m; }
    else if (side === 1) { bx = W - m; by = rand(H * 0.2, H * 0.8); }
    else if (side === 2) { bx = rand(W * 0.2, W * 0.8); by = H - m; }
    else { bx = m; by = rand(H * 0.2, H * 0.8); }
    for (i = 0; i < n; i++) {
      var x = clamp(bx + rand(-90, 90), m, side === 1 ? W - m : side === 3 ? m : W - m);
      var y = clamp(by + rand(-90, 90), m, H - m);
      if (side === 0) y = m; else if (side === 2) y = H - m;
      else if (side === 1) x = W - m; else x = m;
      queueSpawn(g, pickType(g.wave), (delay || 0.5) + i * 0.07);
    }
  }

  function pickType(w) {
    var pool = [['drifter', 100]];
    if (w >= 2) pool.push(['rusher', 18 + w * 4]);
    if (w >= 3) pool.push(['splitter', 9 + w * 3]);
    if (w >= 5) pool.push(['jugger', 3 + w * 1.1]);
    var total = 0, i;
    for (i = 0; i < pool.length; i++) total += pool[i][1];
    var roll = Math.random() * total;
    for (i = 0; i < pool.length; i++) { roll -= pool[i][1]; if (roll <= 0) return pool[i][0]; }
    return 'drifter';
  }

  /* -------------------------- 空间网格（性能） -------------------------- */
  var CELL = 80;
  function buildGrid(g) {
    var cols = Math.ceil(W / CELL) + 3, rows = Math.ceil(H / CELL) + 3, i;
    if (!g.grid || g.grid.cols !== cols) {
      g.grid = { cols: cols, rows: rows, cells: [] };
      for (i = 0; i < cols * rows; i++) g.grid.cells.push([]);
    }
    var cells = g.grid.cells;
    for (i = 0; i < cells.length; i++) cells[i].length = 0;
    for (i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      var cx = clamp(Math.floor(e.x / CELL) + 1, 0, cols - 1);
      var cy = clamp(Math.floor(e.y / CELL) + 1, 0, rows - 1);
      cells[cy * cols + cx].push(e);
    }
  }
  function queryRadius(g, x, y, r) {
    var out = [], gr = g.grid;
    if (!gr) {
      for (var k = 0; k < g.enemies.length; k++) {
        var en = g.enemies[k];
        if (!en.dead && dist(x, y, en.x, en.y) <= r + en.r) out.push(en);
      }
      return out;
    }
    var x0 = clamp(Math.floor((x - r) / CELL) + 1, 0, gr.cols - 1);
    var x1 = clamp(Math.floor((x + r) / CELL) + 1, 0, gr.cols - 1);
    var y0 = clamp(Math.floor((y - r) / CELL) + 1, 0, gr.rows - 1);
    var y1 = clamp(Math.floor((y + r) / CELL) + 1, 0, gr.rows - 1);
    for (var cy = y0; cy <= y1; cy++) {
      for (var cx = x0; cx <= x1; cx++) {
        var cell = gr.cells[cy * gr.cols + cx];
        for (var i = 0; i < cell.length; i++) {
          var e = cell[i];
          if (!e.dead && dist(x, y, e.x, e.y) <= r + e.r) out.push(e);
        }
      }
    }
    return out;
  }

  /* -------------------------------- 井 -------------------------------- */
  function makeWell(g, x, y) {
    return {
      id: g.nextId++, x: clamp(x, 34, W - 34), y: clamp(y, 34, H - 34),
      mass: 0, life: CFG.well.life, rot: rand(0, TAU),
      spin: rand(0.7, 1.5) * (Math.random() < 0.5 ? -1 : 1),
      flash: 0, seed: rand(0, 10), wasted: false
    };
  }
  function pullR(w) { return CFG.well.r0 * (1 + CFG.well.growth * w.mass); }
  function coreR(w) { return CFG.well.coreBase + w.mass * 1.6; }

  function placeWell(g) {
    if (g.state !== 'PLAY' || g.startLock > 0 || g.placeCd > 0 || g.energy <= 0) return false;
    g.energy -= 1; g.placeCd = CFG.well.placeCd;
    var w = makeWell(g, g.input.mx, g.input.my);
    g.wells.push(w); g.stats.wells++;
    g.audio.sfx.place();
    ringPart(g, w.x, w.y, '#6ee7ff', 8, 62, 0.42, 2);
    burst(g, w.x, w.y, '#8ff0ff', 10, { speed: 120, life: 0.5, r: 1.8 });
    return true;
  }

  /* 质量 -> 分数 / 连击 */
  function bumpCombo(g) {
    g.chainKills++;
    g.comboT = CFG.combo.window;
    g.combo = Math.min(CFG.combo.cap, 1 + (g.chainKills - 1) * CFG.combo.step);
    if (g.chainKills > g.stats.bestChain) g.stats.bestChain = g.chainKills;
    if (g.combo > g.stats.maxCombo) g.stats.maxCombo = g.combo;
  }
  function addScore(g, base) {
    var gain = Math.round(base * g.combo);
    if (g.state === 'PLAY') g.score += gain;
    return gain;
  }

  function killEnemy(g, e, depth) {
    if (e.dead) return;
    e.dead = true;
    bumpCombo(g);
    var t = ETYPES[e.type];
    var gain = addScore(g, t.score);
    if (g.state === 'PLAY') {
      g.stats.kills++;
      if (depth > 0) g.stats.chains++;
    }
    burst(g, e.x, e.y, t.col, 8, { speed: rand(90, 300), life: rand(0.2, 0.5), r: 2.2 });
    if (depth === 0) ringPart(g, e.x, e.y, t.col, 4, e.r * 2.2, 0.22, 1.6, true);
    popText(g, e.x, e.y - 6, '+' + gain, t.col, depth > 0 ? 18 : 16);
    if (depth > 0) g.audio.sfx.chain(Math.min(depth, 8));
  }

  function absorbEnemy(g, w, e) {
    if (e.dead) return;
    e.dead = true;
    var t = ETYPES[e.type];
    w.mass++; w.flash = 1;
    bumpCombo(g);
    var gain = addScore(g, t.score);
    if (g.state === 'PLAY') { g.stats.kills++; g.stats.absorbed++; }
    g.energy = Math.min(CFG.well.max, g.energy + 1);
    g.energyPulse = 1;
    g.audio.sfx.absorb(w.mass);
    // 螺旋吸入的粒子
    for (var i = 0; i < 10; i++) {
      var a = rand(0, TAU), r = rand(18, 46);
      part(g, {
        kind: 'spark', x: w.x + Math.cos(a) * r, y: w.y + Math.sin(a) * r,
        vx: -Math.cos(a) * r * 2.2, vy: -Math.sin(a) * r * 2.2,
        life: rand(0.18, 0.4), r: rand(1.2, 2.6), col: t.col, drag: 0.4
      });
    }
    popText(g, e.x, e.y - 6, '+' + gain, t.col, 16);
    // 分裂体：被吸进去反而会炸出两个小的
    if (t.splits) {
      for (var k = 0; k < t.splits; k++) {
        var ang = rand(0, TAU);
        var s = spawnEnemy(g, 'spawn', w.x + Math.cos(ang) * (coreR(w) + 10), w.y + Math.sin(ang) * (coreR(w) + 10));
        s.vx = Math.cos(ang) * 260; s.vy = Math.sin(ang) * 260;
        s.immune = 0.6;
        burst(g, s.x, s.y, t.col, 6, { speed: 180, life: 0.3 });
      }
    }
  }

  /* 连锁爆炸：BFS，深度上限 9，避免无限递归 */
  function cascade(g, x, y, radius, firstDepth) {
    var queue = [{ x: x, y: y, r: radius, depth: firstDepth || 0 }];
    var hit = {}, count = 0, guard = 0;
    while (queue.length && guard++ < 400) {
      var it = queue.shift();
      var cands = queryRadius(g, it.x, it.y, it.r);
      for (var i = 0; i < cands.length; i++) {
        var e = cands[i];
        if (e.dead || hit[e.id]) continue;
        hit[e.id] = 1;
        killEnemy(g, e, it.depth);
        count++;
        if (it.depth < 9) queue.push({ x: e.x, y: e.y, r: e.chainR, depth: it.depth + 1 });
      }
    }
    return count;
  }

  /* 坍缩：把井里的质量一次性放出去 */
  function detonate(g, w, powerMul) {
    powerMul = powerMul === undefined ? 1 : powerMul;
    var power = (w.mass > 0 ? 1 : CFG.well.emptyPower) * powerMul;
    var radius = (CFG.well.novaR + CFG.well.novaPerMass * w.mass) * power;
    var col = w.mass >= 6 ? '#ffffff' : (w.mass >= 3 ? '#c9a3ff' : '#7fd0ff');
    g.stats.novas++;
    g.audio.sfx.nova(w.mass);
    g.shake = Math.min(28, g.shake + 4 + w.mass * 1.2);
    g.flash = Math.min(1, g.flash + 0.20 + w.mass * 0.05);
    // 冲击波三件套：亮盘 + 冲击环 + 放射条纹
    part(g, {
      kind: 'blast', x: w.x, y: w.y, r0: radius * 0.16, r1: radius * 0.95,
      life: 0.34, r: radius * 0.16, col: col, drag: 0
    });
    var ringW = Math.min(6, 3 + w.mass * 0.45);
    ringPart(g, w.x, w.y, col, 6, radius * 1.10, 0.44, ringW, false);
    ringPart(g, w.x, w.y, '#ffffff', 3, radius * 0.58, 0.18, Math.min(3, 1.4 + w.mass * 0.2), false);
    var streaks = 14 + w.mass * 2;
    for (var s = 0; s < streaks; s++) {
      var sa = rand(0, TAU);
      part(g, {
        kind: 'streak', x: w.x, y: w.y, ang: sa,
        len: rand(radius * 0.18, radius * 0.52), life: rand(0.14, 0.26),
        r: 2.6, col: col, drag: 0
      });
    }
    burst(g, w.x, w.y, col, 14 + w.mass * 4, { speed: rand(180, 620), life: rand(0.25, 0.75), r: rand(1.6, 3.4) });
    var killed = cascade(g, w.x, w.y, radius, 0);
    return killed;
  }

  function collapseAll(g) {
    if (g.state !== 'PLAY' || g.startLock > 0 || g.wells.length === 0) return 0;
    var total = 0, singleMass = 0;
    if (g.wells.length === 1) singleMass = g.wells[0].mass;
    for (var i = 0; i < g.wells.length; i++) total += detonate(g, g.wells[i], 1);
    g.wells.length = 0;
    if (total >= CFG.slowmo.kills) { g.slowT = CFG.slowmo.time; g.timeScale = CFG.slowmo.scale; }
    g.hitstop = total > 0 ? 0.055 : 0.02;
    // 文字只留一条主信息，避免叠成一坨
    if (singleMass > 0) popText(g, W / 2, H * 0.36, '坍缩 x' + singleMass, '#ffffff', 26);
    else if (total >= 3) popText(g, W / 2, H * 0.36, '连 锁 ' + total, '#ffffff', 30);
    return total;
  }

  /* ------------------------------- 玩家 ------------------------------- */
  function updatePlayer(g, dt) {
    var p = g.player, inp = g.input, pc = CFG.player;
    var ax = 0, ay = 0;
    if (inp.left) ax -= 1;
    if (inp.right) ax += 1;
    if (inp.up) ay -= 1;
    if (inp.down) ay += 1;
    var m = Math.hypot(ax, ay);
    if (m > 0) {
      ax /= m; ay /= m;
      p.vx += ax * pc.accel * dt;
      p.vy += ay * pc.accel * dt;
    }
    // 冲刺
    if (g.dashCd <= 0 && inp.dash) {
      var dir = m > 0 ? Math.atan2(ay, ax) : p.facing;
      p.vx = Math.cos(dir) * pc.dashSpeed;
      p.vy = Math.sin(dir) * pc.dashSpeed;
      g.dashCd = pc.dashCd; p.dashT = pc.dashTime;
      p.invuln = Math.max(p.invuln, pc.dashInvuln);
      g.audio.sfx.dash();
      burst(g, p.x, p.y, '#9be8ff', 12, { speed: 260, life: 0.3, r: 1.8, a: dir + Math.PI });
    }
    inp.dash = 0;

    var drag = Math.exp(-pc.drag * dt);
    p.vx *= drag; p.vy *= drag;
    var sp = Math.hypot(p.vx, p.vy);
    if (sp > pc.maxSpeed * 2.2) { var s = pc.maxSpeed * 2.2 / sp; p.vx *= s; p.vy *= s; }
    p.x += p.vx * dt; p.y += p.vy * dt;

    // 场地边界
    if (p.x < p.r) { p.x = p.r; p.vx *= -0.3; }
    if (p.x > W - p.r) { p.x = W - p.r; p.vx *= -0.3; }
    if (p.y < p.r) { p.y = p.r; p.vy *= -0.3; }
    if (p.y > H - p.r) { p.y = H - p.r; p.vy *= -0.3; }

    // 朝向鼠标
    p.facing = Math.atan2(inp.my - p.y, inp.mx - p.x);
    if (p.dashT > 0) p.dashT -= dt;
    if (p.invuln > 0) p.invuln -= dt;
    if (g.dashCd > 0) g.dashCd -= dt;
    if (p.dashT > 0) burst(g, p.x, p.y, '#7ff0ff', 1, { speed: 40, life: 0.3, r: 2.4 });

    // 拖尾
    p.trail.unshift({ x: p.x, y: p.y });
    if (p.trail.length > 14) p.trail.pop();

    // 被动回能（保险丝）
    g.regenT += dt;
    if (g.regenT >= CFG.well.regen) {
      g.regenT = 0;
      if (g.energy < CFG.well.max) { g.energy++; g.energyPulse = 0.7; }
    }
  }

  /* -------------------------------- 井更新 ------------------------------- */
  function updateWells(g, dt) {
    for (var i = g.wells.length - 1; i >= 0; i--) {
      var w = g.wells[i];
      w.life -= dt;
      w.rot += w.spin * dt;
      w.flash = Math.max(0, w.flash - dt * 3.2);
      var r = pullR(w);
      // 吸入流线（视觉：让场看起来在转）
      if (Math.random() < 0.55) {
        var a = rand(0, TAU), rr = r * rand(0.55, 1.0);
        part(g, {
          kind: 'spark', x: w.x + Math.cos(a) * rr, y: w.y + Math.sin(a) * rr,
          vx: -Math.cos(a) * rr * 1.6, vy: -Math.sin(a) * rr * 1.6,
          life: rand(0.25, 0.5), r: rand(0.8, 1.8), col: '#3fa8d8', drag: 0.2
        });
      }
      if (w.life <= 0) {
        // 自然消散：威力打对折，但不会完全白放
        detonate(g, w, 0.55);
        g.wells.splice(i, 1);
      }
    }
  }

  /* ------------------------------- 敌人更新 ------------------------------ */
  function updateEnemies(g, dt) {
    var p = g.player, mul = CFG.speedMul(g.wave), pc = CFG.player;
    for (var i = g.enemies.length - 1; i >= 0; i--) {
      var e = g.enemies[i];
      if (e.dead) { g.enemies.splice(i, 1); continue; }
      var t = ETYPES[e.type];
      e.t += dt;
      if (e.immune > 0) e.immune -= dt;
      if (e.flash > 0) e.flash -= dt * 3;

      var accx = 0, accy = 0;
      // 追玩家
      var dpx = p.x - e.x, dpy = p.y - e.y, dp = Math.hypot(dpx, dpy) || 1;
      accx += (dpx / dp) * t.accel * mul;
      accy += (dpy / dp) * t.accel * mul;

      // 被井吸引
      for (var k = 0; k < g.wells.length; k++) {
        var w = g.wells[k];
        var dx = w.x - e.x, dy = w.y - e.y, d = Math.hypot(dx, dy) || 1;
        var R = pullR(w);
        if (d < R) {
          var f = (1 - d / R);
          f = 0.32 + 0.68 * f * f;
          var strength = CFG.well.pull * f * t.pull * (1 + 0.035 * w.mass);
          accx += (dx / d) * strength;
          accy += (dy / d) * strength;
        }
      }

      e.vx += accx * dt; e.vy += accy * dt;
      var drag = Math.exp(-CFG.enemyDrag * dt);
      e.vx *= drag; e.vy *= drag;
      var cap = t.speed * mul * 2.0, sp = Math.hypot(e.vx, e.vy);
      if (sp > cap) { e.vx *= cap / sp; e.vy *= cap / sp; }
      e.x += e.vx * dt; e.y += e.vy * dt;
      e.rot += e.vr * dt * (0.5 + Math.min(2, sp / 90));

      // 边界反弹
      if (e.x < e.r) { e.x = e.r; e.vx = Math.abs(e.vx) * 0.55; }
      if (e.x > W - e.r) { e.x = W - e.r; e.vx = -Math.abs(e.vx) * 0.55; }
      if (e.y < e.r) { e.y = e.r; e.vy = Math.abs(e.vy) * 0.55; }
      if (e.y > H - e.r) { e.y = H - e.r; e.vy = -Math.abs(e.vy) * 0.55; }

      // 被井吞噬
      var eaten = false;
      for (var j = 0; j < g.wells.length; j++) {
        var ww = g.wells[j];
        if (e.immune > 0) continue;
        if (dist(e.x, e.y, ww.x, ww.y) < coreR(ww) + e.r * 0.6) { absorbEnemy(g, ww, e); eaten = true; break; }
      }
      if (eaten) { g.enemies.splice(i, 1); continue; }

      // 撞玩家
      if (g.state === 'PLAY' && p.invuln <= 0 && dist(e.x, e.y, p.x, p.y) < p.r + e.r * 0.8) {
        e.dead = true;
        g.enemies.splice(i, 1);
        g.hp--; g.damageFlash = 1; g.shake = Math.min(40, g.shake + 16);
        p.invuln = pc.invuln;
        g.audio.sfx.hit();
        burst(g, p.x, p.y, '#ff5f7e', 26, { speed: rand(140, 460), life: rand(0.3, 0.8), r: 2.6 });
        ringPart(g, p.x, p.y, '#ff5f7e', 6, 150, 0.4, 4);
        if (g.hp <= 0) die(g);
      }
    }

    // 简单分离力（避免叠成一坨，比"穿模"好看很多）
    separate(g, dt);
  }

  function separate(g, dt) {
    var gr = g.grid;
    if (!gr) return;
    for (var i = 0; i < g.enemies.length; i++) {
      var a = g.enemies[i];
      if (a.dead) continue;
      var cx = clamp(Math.floor(a.x / CELL) + 1, 0, gr.cols - 1);
      var cy = clamp(Math.floor(a.y / CELL) + 1, 0, gr.rows - 1);
      for (var oy = -1; oy <= 1; oy++) {
        var y = cy + oy; if (y < 0 || y >= gr.rows) continue;
        for (var ox = -1; ox <= 1; ox++) {
          var x = cx + ox; if (x < 0 || x >= gr.cols) continue;
          var cell = gr.cells[y * gr.cols + x];
          for (var c = 0; c < cell.length; c++) {
            var b = cell[c];
            if (b === a || b.dead || b.id < a.id) continue;
            var dx = b.x - a.x, dy = b.y - a.y;
            var d2 = dx * dx + dy * dy, rr = (a.r + b.r) * 0.92;
            if (d2 > 1e-6 && d2 < rr * rr) {
              var d = Math.sqrt(d2), push = (rr - d) * 6.0 * dt / d;
              var px = dx * push, py = dy * push;
              a.vx -= px; a.vy -= py; b.vx += px; b.vy += py;
            }
          }
        }
      }
    }
  }

  function die(g) {
    g.state = 'DEAD'; g.deadT = 0; g.hitstop = 0.12;
    g.slowT = 1.2; g.timeScale = 0.25;
    g.shake = 46; g.flash = 0.7;
    g.audio.sfx.death();
    g.audio.music.setIntensity(0);
    burst(g, g.player.x, g.player.y, '#9be8ff', 70, { speed: rand(120, 620), life: rand(0.4, 1.3), r: 3.2, drag: 1.4 });
    ringPart(g, g.player.x, g.player.y, '#ffffff', 8, 320, 0.7, 5);
    ringPart(g, g.player.x, g.player.y, '#ff5f7e', 6, 200, 0.5, 3);
    if (g.score > g.best) g.best = g.score;
  }

  /* ------------------------------ 生成器 ------------------------------ */
  function updateSpawner(g, dt) {
    g.waveT += dt;
    if (g.waveT >= CFG.waveDur(g.wave)) {
      g.wave++; g.waveT = 0;
      g.banner = 'WAVE ' + g.wave; g.bannerT = 2.0;
      g.audio.sfx.wave();
      g.audio.music.setIntensity(Math.min(1 + g.wave * 0.12, 2.4));
      queuePack(g, CFG.packSize(g.wave) + 1, 0.5);          // 换波就压上来一股
      if (g.wave % 5 === 0) {
        for (var k = 0; k < 3; k++) queueSpawn(g, 'jugger', 0.7 + k * 0.35);
      }
    }
    g.packT -= dt;
    if (g.packT <= 0) {
      g.packT = CFG.packInterval(g.wave) * rand(0.85, 1.15);
      if (g.enemies.length + g.pending.length < CFG.maxAlive(g.wave)) queuePack(g, CFG.packSize(g.wave), 0.45);
    }
    g.spawnT -= dt;
    var alive = g.enemies.length + g.pending.length;
    if (g.spawnT <= 0 && alive < CFG.maxAlive(g.wave)) {
      g.spawnT = CFG.spawnInterval(g.wave) * rand(0.7, 1.3);
      var n = 1;
      if (Math.random() < Math.min(0.55, g.wave * 0.035)) n++;
      if (g.wave > 12 && Math.random() < Math.min(0.6, (g.wave - 12) * 0.05)) n++;
      for (var i = 0; i < n; i++) queueSpawn(g, pickType(g.wave), rand(0.45, 0.85));    }
  }

  function updatePending(g, dt) {
    for (var i = g.pending.length - 1; i >= 0; i--) {
      var s = g.pending[i];
      s.t -= dt;
      if (s.t <= 0) {
        spawnEnemy(g, s.type, s.x, s.y);
        ringPart(g, s.x, s.y, ETYPES[s.type].col, 4, 40, 0.3, 2);
        g.pending.splice(i, 1);
      }
    }
  }

  /* ------------------------------ 粒子/文字 ----------------------------- */
  function updateParticles(g, dt) {
    for (var i = g.parts.length - 1; i >= 0; i--) {
      var p = g.parts[i];
      p.life -= dt;
      if (p.life <= 0) { g.parts.splice(i, 1); continue; }
      if (p.kind === 'dust') {
        p.x += p.vx * dt; p.y += p.vy * dt;
        var a = Math.atan2(p.y - H / 2, p.x - W / 2);
        p.vx += -Math.sin(a) * 3 * dt; p.vy += Math.cos(a) * 3 * dt;
        if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) { p.life = 0; }
        continue;
      }
      if (p.kind === 'ring' || p.kind === 'blast') {
        var t = 1 - p.life / p.max;
        p.r = lerp(p.r0, p.r1, 1 - Math.pow(1 - t, 2.2));
        continue;
      }
      if (p.kind === 'streak') continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      var dr = Math.exp(-(p.drag || 0) * dt);
      p.vx *= dr; p.vy *= dr;
      p.rot += p.vr * dt;
    }
    for (var j = g.texts.length - 1; j >= 0; j--) {
      var tx = g.texts[j];
      tx.life -= dt;
      if (tx.life <= 0) { g.texts.splice(j, 1); continue; }
      tx.y += tx.vy * dt;
      tx.vy *= Math.exp(-2.4 * dt);
    }
  }

  /* -------------------------------- 主步进 ------------------------------- */
  function step(g, dt) {
    if (g.state === 'SHOT') return;
    g.t += dt;

    // 计时器衰减
    if (g.placeCd > 0) g.placeCd -= dt;
    if (g.startLock > 0) g.startLock -= dt;
    if (g.bannerT > 0) g.bannerT -= dt;
    if (g.flash > 0) g.flash = Math.max(0, g.flash - dt * 2.6);
    if (g.damageFlash > 0) g.damageFlash = Math.max(0, g.damageFlash - dt * 2.2);
    if (g.energyPulse > 0) g.energyPulse = Math.max(0, g.energyPulse - dt * 2.6);
    g.shake *= Math.exp(-6.5 * dt);
    if (g.comboT > 0) {
      g.comboT -= dt;
      if (g.comboT <= 0) { g.chainKills = 0; g.combo = 1; }
    }

    if (g.state === 'MENU') { menuUpdate(g, dt); return; }
    if (g.state === 'DEAD') {
      g.deadT += dt;
      updateParticles(g, dt);
      updateEnemies(g, dt);
      updateWells(g, dt);
      return;
    }
    if (g.state !== 'PLAY') return;

    g.stats.time += dt;
    if (g.score > g.best) g.best = g.score;
    updatePlayer(g, dt);
    if (g.input.fire) placeWell(g);
    if (g.input.collapse) { g.input.collapse = 0; collapseAll(g); }
    buildGrid(g);
    updateWells(g, dt);
    updateEnemies(g, dt);
    updatePending(g, dt);
    updateSpawner(g, dt);
    updateParticles(g, dt);
  }

  /* 主菜单：让背景自己打一局（复用同一套物理，纯氛围） */
  function menuUpdate(g, dt) {
    g.player.x = W / 2; g.player.y = H / 2;
    g.menuWellT -= dt;
    if (g.menuWellT <= 0 && g.wells.length < 2) {
      g.menuWellT = 1.5;
      g.wells.push(makeWell(g, rand(W * 0.22, W * 0.78), rand(H * 0.24, H * 0.76)));
      g.audio.sfx.place();
    }
    for (var i = g.wells.length - 1; i >= 0; i--) {
      if (g.wells[i].mass >= 4) { detonate(g, g.wells[i], 1); g.wells.splice(i, 1); }
    }
    g.menuSpawnT -= dt;
    if (g.menuSpawnT <= 0 && g.enemies.length < 26) {
      g.menuSpawnT = 0.45;
      queueSpawn(g, pickOne(['drifter', 'drifter', 'rusher', 'splitter']), 0.3);
    }
    buildGrid(g);
    updateWells(g, dt);
    updateEnemies(g, dt);
    updatePending(g, dt);
    updateParticles(g, dt);
  }

  /* --------------------------- 时间推进（含子弹时间） -------------------------- */
  function advance(g, realDt) {
    if (g.frozen) return;
    realDt = Math.min(realDt, 0.05);
    if (g.state === 'MENU' || g.state === 'DEAD') { g.timeScale = 1; g.hitstop = 0; }
    if (g.hitstop > 0) { g.hitstop -= realDt; return; }   // 命中定格
    if (g.slowT > 0) {
      g.slowT -= realDt;
      g.timeScale = lerp(g.timeScale, CFG.slowmo.scale, 0.35);
    } else if (g.state !== 'DEAD') {
      g.timeScale = lerp(g.timeScale, 1, 0.1);
    }
    if (g.state === 'PAUSE') return;
    g.acc += realDt * g.timeScale;
    var n = 0;
    while (g.acc >= CFG.fixedDt && n < 6) { step(g, CFG.fixedDt); g.acc -= CFG.fixedDt; n++; }
    if (g.acc > CFG.fixedDt * 6) g.acc = 0;
  }

  /* ------------------------------- 演示 AI ------------------------------ */
  /* 无头测试与主菜单截图模式共用：一个"会玩"的机器人 */
  function botThink(g) {
    var p = g.player, inp = g.input;
    inp.up = inp.down = inp.left = inp.right = 0;
    inp.collapse = 0; inp.dash = 0; inp.fire = 0;
    if (g.state !== 'PLAY' || g.startLock > 0) return;

    var nearest = null, nd = 1e9, cx = 0, cy = 0, n = 0;
    for (var i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      if (e.dead) continue;
      var d = dist(e.x, e.y, p.x, p.y);
      if (d < nd) { nd = d; nearest = e; }
      cx += e.x; cy += e.y; n++;
    }
    var ax, ay;
    if (n >= 4) { ax = cx / n; ay = cy / n; }
    else if (nearest) { ax = nearest.x; ay = nearest.y; }
    else { ax = W / 2; ay = H / 2; }
    inp.mx = clamp(ax, 30, W - 30); inp.my = clamp(ay, 30, H - 30);

    var maxMass = 0;
    for (var k = 0; k < g.wells.length; k++) maxMass = Math.max(maxMass, g.wells[k].mass);

    if (g.energy > 0 && g.placeCd <= 0 && n >= 2 && maxMass < 8) inp.fire = 1;
    if (g.wells.length > 0 && (maxMass >= 4 || g.energy >= CFG.well.max)) inp.collapse = 1;

    var mx = (W / 2 - p.x) * 0.002, my = (H / 2 - p.y) * 0.002;
    if (nearest && nd < 220) {
      mx += (p.x - nearest.x) / Math.max(nd, 1) * 1.4;
      my += (p.y - nearest.y) / Math.max(nd, 1) * 1.4;
    }
    if (mx > 0.12) inp.right = 1; else if (mx < -0.12) inp.left = 1;
    if (my > 0.12) inp.down = 1; else if (my < -0.12) inp.up = 1;
    if (nearest && nd < 58 && g.dashCd <= 0) inp.dash = 1;
  }

  return {
    VERSION: VERSION, CFG: CFG, ETYPES: ETYPES, TAU: TAU, W: W, H: H,
    rand: rand, randi: randi, clamp: clamp, lerp: lerp, dist: dist, pickOne: pickOne,
    createGame: createGame, resetRun: resetRun, startRun: startRun,
    step: step, advance: advance, botThink: botThink,
    placeWell: placeWell, collapseAll: collapseAll, detonate: detonate,
    pullR: pullR, coreR: coreR, nullAudio: nullAudio
  };
});
