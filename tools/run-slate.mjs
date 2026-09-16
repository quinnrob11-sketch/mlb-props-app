// Load a real slate in Node through this branch's own API handlers and print
// the game-line board: model vs market for every moneyline, run line and total.
//
//   node tools/run-slate.mjs [YYYY-MM-DD] [--json out.json] [--live]
//
// --live routes /api/* through the production deployment (its odds key, its
// CDN cache) instead of this branch's handlers.
//
// Also reports how far the model sits from the market, the number that decides
// whether a disagreement is believable (IMPLAUSIBLE_TEAM_EDGE).
import fs from 'node:fs';
import { installFetch } from './local-api.mjs';

installFetch(process.argv.includes('--live') ? 'https://mlb-props-app.vercel.app' : undefined);
const { loadSlate } = await import('../src/data/loadSlate.js');

const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const jsonAt = process.argv.indexOf('--json');

const t0 = Date.now();
const slate = await loadSlate({ date, onStatus: () => {}, projectLineups: true });
console.log(`${date}: ${slate.games.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`prop odds: ${slate.oddsError || 'ok'} | book game lines: ${slate.gameLinesError || 'ok'} | kalshi: ${slate.kalshiGameError || 'ok'}`);

const pct = (p) => (p == null ? '  -  ' : `${(100 * p).toFixed(1)}%`.padStart(6));
const gaps = { game_ml: [], game_spread: [], game_total: [] };
for (const g of slate.games) {
  const m = g.game;
  const sp = g.pitchers.map((p) => p.name.split(' ').pop()).join(' v ');
  console.log(`\n${g.away.abbr} @ ${g.home.abbr}  (${sp})  proj ${m.projAway.toFixed(2)}-${m.projHome.toFixed(2)}  total ${m.projTotal.toFixed(2)}  ${m.flags.join(' ')}`);
  for (const r of g.teamLines) {
    const e = r.edge;
    if (e?.edge != null) gaps[r.market].push(e.edge);
    console.log(`  ${r.label.padEnd(9)} ${String(r.line).padStart(5)}  model ${pct(r.modelOver)}  market ${pct(e?.fairOver)}  gap ${e?.edge == null ? '  -  ' : ((e.edge >= 0 ? '+' : '') + (100 * e.edge).toFixed(1)).padStart(5)}  [${r.books.join(',')}]  ${e?.verdict || ''} ${e?.side || ''} ${e?.ev != null ? e.ev.toFixed(1) + '%' : ''} ${(e?.why || []).join('; ')}`);
  }
}

console.log('\nModel minus market (vig-free), probability points:');
for (const [k, list] of Object.entries(gaps)) {
  if (!list.length) continue;
  const abs = list.map(Math.abs).sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)];
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  console.log(`  ${k.padEnd(12)} n=${list.length}  median |gap| ${(100 * med).toFixed(1)}  max ${(100 * abs.at(-1)).toFixed(1)}  signed mean ${(100 * mean).toFixed(1)}`);
}
if (jsonAt > 0) {
  fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(slate.games.map((g) => ({
    gamePk: g.gamePk, away: g.away.abbr, home: g.home.abbr, game: { ...g.game, total: undefined, spread: undefined }, teamLines: g.teamLines,
  })), null, 1));
}
