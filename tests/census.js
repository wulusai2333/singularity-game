/*!
 * 对局强度统计：每 10 秒的场上敌人数/击杀数/能量，用来判断"空不空、腻不腻"
 *   node dev/census.js [秒数]
 */
'use strict';
var S = require('../game.js');
var FIXED = S.CFG.fixedDt;
var secs = parseFloat(process.argv[2] || '180');

var g = S.createGame({ audio: S.nullAudio });
S.startRun(g);

var bucket = 10, acc = { alive: 0, n: 0, kills: 0, novas: 0, wells: 0, absorbed: 0 };
var lastKills = 0, lastNova = 0, lastAbs = 0;
console.log('时间   场上敌人(均)  峰值  本段击杀  吸收  坍缩  波次  能量  分数');
for (var i = 0; i < secs / FIXED; i++) {
  S.botThink(g);
  S.advance(g, FIXED);
  acc.alive += g.enemies.length + g.pending.length; acc.n++;
  acc.peak = Math.max(acc.peak || 0, g.enemies.length + g.pending.length);
  if (g.state === 'DEAD') { console.log('  死亡：' + g.stats.time.toFixed(1) + 's，WAVE ' + g.wave + '，分数 ' + (g.score | 0)); S.startRun(g); acc.peak = 0; }
  if (g.stats.time >= bucket || i === Math.floor(secs / FIXED) - 1) {
    console.log(
      pad(g.stats.time.toFixed(0) + 's', 6) +
      pad((acc.alive / Math.max(1, acc.n)).toFixed(1), 13) +
      pad(String(acc.peak), 6) +
      pad(String(g.stats.kills - lastKills), 10) +
      pad(String(g.stats.absorbed - lastAbs), 6) +
      pad(String(g.stats.novas - lastNova), 6) +
      pad(String(g.wave), 6) +
      pad(String(g.energy), 6) +
      pad(String(g.score | 0), 8)
    );
    lastKills = g.stats.kills; lastNova = g.stats.novas; lastAbs = g.stats.absorbed;
    acc = { alive: 0, n: 0, peak: 0 }; bucket += 10;
  }
}
function pad(s, n) { while (s.length < n) s = ' ' + s; return s + ' '; }
