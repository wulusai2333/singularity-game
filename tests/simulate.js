/*!
 * 无头测试：不需要浏览器，直接在 Node 里跑固定步长对局
 *   node dev/simulate.js
 * 覆盖：语法/数值稳定(无 NaN)、能量经济、吸收、坍缩连锁、分裂体、波次推进、
 *       死亡判定、粒子上限、长时间运行性能、机器人可玩性曲线
 */
'use strict';
var S = require('../game.js');

var FIXED = S.CFG.fixedDt;
var fails = [], checks = 0;

function ok(cond, msg, extra) {
  checks++;
  if (!cond) fails.push(msg + (extra !== undefined ? '  [' + extra + ']' : ''));
}
function finite(v) { return typeof v === 'number' && isFinite(v); }

function newGame() { return S.createGame({ audio: S.nullAudio }); }
function run(g, seconds, bot) {
  var steps = Math.round(seconds / FIXED);
  for (var i = 0; i < steps; i++) {
    if (bot) S.botThink(g);
    S.advance(g, FIXED);
    assertHealthy(g, i);
  }
  return g;
}
function assertHealthy(g, i) {
  var p = g.player;
  ok(finite(p.x) && finite(p.y) && finite(p.vx) && finite(p.vy), '玩家坐标出现 NaN', 'step ' + i);
  ok(p.x >= -1 && p.x <= S.W + 1 && p.y >= -1 && p.y <= S.H + 1, '玩家跑出场地', p.x.toFixed(1) + ',' + p.y.toFixed(1));
  for (var k = 0; k < g.enemies.length; k++) {
    var e = g.enemies[k];
    if (!finite(e.x) || !finite(e.y) || !finite(e.vx) || !finite(e.vy)) { fails.push('敌人坐标 NaN @step ' + i); checks++; return; }
  }
  ok(g.energy >= 0 && g.energy <= S.CFG.well.max, '能量越界', g.energy);
  ok(g.hp >= 0, '生命为负', g.hp);
  ok(g.parts.length <= S.CFG.maxParticles, '粒子超上限', g.parts.length);
}

console.log('=== 奇点 SINGULARITY 无头测试 v' + S.VERSION + ' ===\n');

/* --- 1. 空转：不操作应该会死，且死亡流程完整 --- */
(function () {
  var g = newGame();
  S.startRun(g);
  run(g, 6, false);
  ok(g.state === 'PLAY' || g.state === 'DEAD', '空转 6 秒后状态异常', g.state);
  var guard = 0;
  while (g.state === 'PLAY' && guard++ < 60 * 120) S.advance(g, FIXED);
  ok(g.state === 'DEAD', '挂机应该会被打死（AI 不还手）', 'state=' + g.state + ' hp=' + g.hp);
  ok(g.stats.time > 3, '挂机能撑一会儿但不会太久', g.stats.time.toFixed(1) + 's');
  ok(g.best >= 0 && finite(g.best), '最高分异常', g.best);
  console.log('[1] 挂机压力测试：存活 ' + g.stats.time.toFixed(1) + 's，被 ' + g.stats.kills + ' 次击杀前死亡');
})();

/* --- 2. 能量经济：吸收 -> 回能 -> 能继续放井 --- */
(function () {
  var g = newGame();
  S.startRun(g);
  g.startLock = 0;
  S.botThink(g);
  var placed = S.placeWell(g);
  ok(placed === true, '应该能放下第一口井');
  ok(g.energy === S.CFG.well.start - 1, '放井应该扣 1 能量', g.energy);
  var before = g.energy, absorbed0 = g.stats.absorbed;
  run(g, 12, true);
  ok(g.stats.absorbed > absorbed0, '12 秒内应该有敌人被吸收', g.stats.absorbed);
  ok(g.energy >= 0 && g.energy <= S.CFG.well.max, '能量应在 [0,max]');
  console.log('[2] 能量经济：12 秒吸收 ' + (g.stats.absorbed - absorbed0) + ' 个，放井 ' + g.stats.wells + ' 次，坍缩 ' + g.stats.novas + ' 次');
})();

/* --- 3. 坍缩连锁：摆一条长蛇，验证连锁能沿链条一路炸过去 --- */
(function () {
  var g = newGame();
  S.startRun(g);
  g.startLock = 0; g.enemies.length = 0;
  function put(type, x, y) {
    g.nextId++;
    var t = S.ETYPES[type];
    g.enemies.push({
      id: g.nextId, type: type, x: x, y: y, vx: 0, vy: 0, r: t.r, rot: 0, vr: 0,
      chainR: t.chainR || S.CFG.well.chainR, immune: 999, t: 0, seed: 0, dead: false, flash: 0
    });
  }
  for (var k = 0; k < 20; k++) put('drifter', 100 + k * 45, 360);   // 一条 45px 间距的长蛇
  put('jugger', 1010, 360);                                          // 末端一个重装（连锁半径更大）
  g.wells.push({ id: 1, x: 250, y: 360, mass: 8, life: 5, rot: 0, spin: 1, flash: 0, seed: 0 });
  var scoreBefore = g.score, killsBefore = g.stats.kills;
  for (var s = 0; s < 3; s++) S.step(g, FIXED);                      // 先跑几帧，确保空间网格已建立
  var kills = S.collapseAll(g);
  ok(kills >= 15, '一次大坍缩应该沿链条清掉大部分敌人', kills);
  ok(g.stats.kills > killsBefore, '击杀统计没增加');
  ok(g.score > scoreBefore, '分数没增加');
  ok(g.combo > 1, '连锁应该抬高连击倍率', g.combo);
  ok(g.stats.chains > 0, '应该产生连锁击杀（深度>0）', g.stats.chains);
  console.log('[3] 坍缩连锁：一次爆炸沿链条清掉 ' + kills + ' 个（含 1 个重装），连击 x' + g.combo.toFixed(1) + '，得分 +' + (g.score - scoreBefore));
})();

/* --- 4. 分裂体：被吸进去会分裂，且不会瞬间自吸 --- */
(function () {
  var g = newGame();
  S.startRun(g);
  g.startLock = 0; g.enemies.length = 0;
  var w = { id: 1, x: 640, y: 360, mass: 0, life: 5, rot: 0, spin: 1, flash: 0, seed: 0 };
  g.wells.push(w);
  g.nextId++;
  g.enemies.push({
    id: g.nextId, type: 'splitter', x: 645, y: 362, vx: 0, vy: 0, r: 16, rot: 0, vr: 0,
    chainR: S.CFG.well.chainR, immune: 0, t: 0, seed: 0, dead: false, flash: 0
  });
  S.step(g, FIXED);
  ok(w.mass === 1, '分裂体应该被吸收并贡献 1 质量', w.mass);
  ok(g.energy >= 1, '吸收应该回能');
  var spawns = g.enemies.filter(function (e) { return e.type === 'spawn'; }).length;
  ok(spawns === 2, '分裂体应该裂出 2 个小怪', spawns);
  var immuneOk = g.enemies.every(function (e) { return e.type !== 'spawn' || e.immune > 0; });
  ok(immuneOk, '新生小怪应该有短暂免疫，避免被同一口井瞬间再吸');
  console.log('[4] 分裂体：吸收后裂出 ' + spawns + ' 个小怪（带 ' + (g.enemies[0] ? g.enemies[0].immune.toFixed(2) : '?') + 's 免疫）');
})();

/* --- 5. 井的自然消散：寿命到点应自动坍缩（威力减半） --- */
(function () {
  var g = newGame();
  S.startRun(g);
  g.startLock = 0; g.enemies.length = 0;
  g.wells.push({ id: 1, x: 300, y: 300, mass: 0, life: 0.05, rot: 0, spin: 1, flash: 0, seed: 0 });
  var novas0 = g.stats.novas;
  S.step(g, FIXED); S.step(g, FIXED); S.step(g, FIXED); S.step(g, FIXED);
  ok(g.wells.length === 0, '寿命结束后井应消失', g.wells.length);
  ok(g.stats.novas === novas0 + 1, '寿命结束应触发一次坍缩', g.stats.novas - novas0);
  console.log('[5] 井寿命机制正常（过期自动坍缩，不会白放）');
})();

/* --- 6. 机器人长时间对局（可玩性曲线 + 性能） --- */
(function () {
  var g = newGame();
  S.startRun(g);
  var t0 = process.hrtime.bigint();
  var frames = 0, deaths = 0, runs = [];
  var bestWave = 0, bestScore = 0;
  run(g, 120, true);
  var t1 = process.hrtime.bigint();
  var ms = Number(t1 - t0) / 1e6;
  ok(g.enemies.length <= S.CFG.maxAlive(g.wave) + 8, '同屏敌人超过上限', g.enemies.length + '/' + S.CFG.maxAlive(g.wave));
  ok(g.state === 'PLAY' || g.state === 'DEAD', '状态异常', g.state);
  bestWave = g.wave; bestScore = g.score;
  var perFrame = ms / (120 / FIXED);
  ok(perFrame < 4, '单帧逻辑耗时过高（>4ms）', perFrame.toFixed(3) + 'ms');
  console.log('[6] 机器人 120 秒对局：波次 ' + g.wave + '，分数 ' + (g.score | 0) + '，击杀 ' + g.stats.kills +
    '，吸收 ' + g.stats.absorbed + '，最大连锁 x' + g.stats.maxCombo.toFixed(1) + '，状态 ' + g.state);
  console.log('    逻辑性能：' + Math.round(120 / FIXED) + ' 帧共 ' + ms.toFixed(1) + 'ms（平均 ' + perFrame.toFixed(3) + ' ms/帧）');
})();

/* --- 7. 机器人能否长期生存？统计 3 局，检查难度不至于劝退或过软 --- */
(function () {
  var res = [];
  for (var i = 0; i < 3; i++) {
    var g = newGame();
    S.startRun(g);
    var guard = 0;
    while (g.state === 'PLAY' && guard++ < 60 * 240) { S.botThink(g); S.advance(g, FIXED); }
    res.push({ t: g.stats.time, wave: g.wave, score: g.score | 0, kills: g.stats.kills, nova: g.stats.novas });
  }
  res.forEach(function (r, i) {
    console.log('    机器人第 ' + (i + 1) + ' 局：存活 ' + r.t.toFixed(1) + 's，WAVE ' + r.wave + '，分数 ' + r.score + '，击杀 ' + r.kills + '，坍缩 ' + r.nova + ' 次');
  });
  var avg = res.reduce(function (a, b) { return a + b.t; }, 0) / res.length;
  ok(avg > 25, '机器人平均存活过短，说明难度过高', avg.toFixed(1) + 's');
  console.log('[7] 机器人平均存活 ' + avg.toFixed(1) + ' 秒（人类上限应显著更高，说明有技巧空间）');
})();

/* --- 汇总 --- */
console.log('\n=== 结果：' + (checks - fails.length) + '/' + checks + ' 项通过 ===');
if (fails.length) {
  fails.slice(0, 40).forEach(function (f) { console.log('  ✗ ' + f); });
  console.log('\n失败 ' + fails.length + ' 项');
  process.exit(1);
} else {
  console.log('全部通过 ✔');
}

/* 让固定步长函数在外部也能用到（避免未使用告警） */
void FIXED;
