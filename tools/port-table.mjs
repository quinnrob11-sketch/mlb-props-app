// Print the reproduction table for docs/GAME-PORT.md from the runs written by
// tools/backtest-kalshi-games.mjs.
//
//   node tools/port-table.mjs .backtest-cache/port-study.json ...
//
// One row per run, one column per market: the paired Brier difference against
// the FROZEN v36 model on identical markets, and against the price.

import fs from 'node:fs';

const MARKETS = ['all', 'KXMLBGAME', 'KXMLBSPREAD', 'KXMLBTOTAL', 'KXMLBRFI'];
const files = process.argv.slice(2);
const pt = (d) => (d == null ? '—' : `${d.point >= 0 ? '+' : ''}${d.point.toFixed(4)} [${d.ci95[0] >= 0 ? '+' : ''}${d.ci95[0].toFixed(4)}, ${d.ci95[1] >= 0 ? '+' : ''}${d.ci95[1].toFixed(4)}]`);

for (const which of ['brierDiffModelMinusV1', 'brierDiffModelMinusMarket']) {
  console.log(`\n=== ${which} ===`);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(f, 'utf8')).report;
    const name = f.replace(/.*port-|\.json$/g, '');
    console.log(`\n${name}  (n ${r.forecast.all.n})`);
    for (const m of MARKETS) {
      const o = r.forecast[m];
      if (!o) continue;
      console.log(`  ${m.padEnd(12)} n ${String(o.n).padStart(5)}  ${pt(o[which])}`);
    }
  }
}

console.log('\n=== league aggregate on the holdout (model vs actual) ===');
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8')).report;
  const v = r.replayValidation;
  const row = (o) => (o ? `${(100 * o.pred).toFixed(2)}/${(100 * o.actual).toFixed(2)}` : '—');
  console.log(`  ${f.replace(/.*port-|\.json$/g, '').padEnd(14)} homeWin ${row(v.homeWin)}  nrfi ${row(v.nrfi)}  over8.5 ${row(v.totals?.['over 8.5'])}  home-1.5 ${row(v.spreads?.['home -1.5'])}`);
}
