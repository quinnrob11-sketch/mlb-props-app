// Grid-search the pitcher model's calibration settings (PITCHER_TUNING) on a
// fit window, and report the same settings on a later holdout window.
//
//   node tools/tune-pitchers.mjs --from 2026-08-10 --to 2026-09-15 --split 2026-09-01 --cache DIR
//
// Objective: mean log loss of the model's full distribution at the actual
// outcome (a proper scoring rule, so it rewards both the right level and the
// right spread). Nothing is changed in the model; copy winners into
// PITCHER_TUNING by hand, with the numbers this prints.
import { buildStarts, evaluate } from './backtest-pitchers.mjs';
import { projectPitcher, PITCHER_TUNING } from '../src/model/pitcher.js';

const i = process.argv.indexOf('--split');
const SPLIT = i > 0 ? process.argv[i + 1] : '2026-09-01';
const starts = buildStarts();
const fit = starts.filter((s) => s.date < SPLIT);
const hold = starts.filter((s) => s.date >= SPLIT);
console.log(`fit ${fit.length} starts < ${SPLIT}, holdout ${hold.length}`);

const withTuning = (tuning) => (input) => projectPitcher({ ...input, tuning });
const score = (set, market, tuning) => evaluate(set, withTuning(tuning), [market])[market];

function search(market, grid) {
  const keys = Object.keys(grid);
  const combos = keys.reduce((acc, k) => acc.flatMap((c) => grid[k].map((v) => ({ ...c, [k]: v }))), [{}]);
  const base = score(fit, market, {});
  let best = { tuning: {}, r: base };
  for (const t of combos) {
    const r = score(fit, market, t);
    if (r.logLoss < best.r.logLoss) best = { tuning: t, r };
  }
  const baseHold = score(hold, market, {});
  const bestHold = score(hold, market, best.tuning);
  const line = (tag, r) =>
    `${tag.padEnd(16)} bias ${r.biasPct >= 0 ? '+' : ''}${r.biasPct.toFixed(1)}%  dispersion ${r.dispersion.toFixed(2)}  logloss ${r.logLoss.toFixed(4)}  brier ${r.brier.toFixed(4)}  | ${r.lines.join('  ')}`;
  console.log(`\n## ${market}  best on fit: ${JSON.stringify(best.tuning)}`);
  console.log(line('fit  current', base));
  console.log(line('fit  tuned', best.r));
  console.log(line('hold current', baseHold));
  console.log(line('hold tuned', bestHold));
  return best.tuning;
}

const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, k) => +(a + k * step).toFixed(4));
search('k', { kLevel: range(0.92, 1.0, 0.01), bfSpread: [3, 5, 7, 9] });
search('hits', { hLevel: range(0.94, 1.0, 0.01) });
search('outs', { outsLevel: range(0.95, 1.0, 0.01), budgetSpread: [6, 10, 14], hookBaseHazard: [0.005, 0.015, 0.03] });
console.log('\ncurrent defaults', JSON.stringify(PITCHER_TUNING));
