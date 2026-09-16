// Grid-search the batter model's calibration settings (BATTER_TUNING) on a fit
// window, and report the same settings on a later holdout window.
//
//   node tools/tune-batters.mjs --from 2026-08-10 --to 2026-09-15 --split 2026-09-01 --cache DIR
//
// Objective: mean log loss of the model's full distribution at the actual
// outcome, summed over the markets a setting touches (a proper scoring rule, so
// it rewards both the right level and the right spread). Stages run in order
// and each starts from the previous stage's winners. Nothing is changed in the
// model; copy winners into BATTER_TUNING by hand, and only those that also
// improve the holdout.
import { buildRows, evaluate, MARKETS } from './backtest-batters.mjs';
import { projectBatter, BATTER_TUNING } from '../src/model/batter.js';

const i = process.argv.indexOf('--split');
const SPLIT = i > 0 ? process.argv[i + 1] : '2026-09-01';
const rows = buildRows();
const fit = rows.filter((s) => s.date < SPLIT);
const hold = rows.filter((s) => s.date >= SPLIT);
console.log(`fit ${fit.length} batter-games < ${SPLIT}, holdout ${hold.length}`);

const project = (tuning) => (input) => projectBatter({ ...input, tuning });
const scoreSet = (set, markets, tuning) => {
  const projs = set.map((r) => projectBatter({ ...r.input, tuning }));
  return evaluate(set, project(tuning), markets, projs);
};
const total = (rep) => Object.values(rep).reduce((a, r) => a + r.logLoss, 0);

const fmt = (tag, r) =>
  `${tag.padEnd(14)} bias ${r.biasPct >= 0 ? '+' : ''}${r.biasPct.toFixed(1)}%  disp ${r.dispersion.toFixed(3)}  logloss ${r.logLoss.toFixed(4)}  brier ${r.brier.toFixed(4)}  | ${r.lines.join('  ')}`;

function search(name, markets, grid, base) {
  const keys = Object.keys(grid);
  const combos = keys.reduce((acc, k) => acc.flatMap((c) => grid[k].map((v) => ({ ...c, [k]: v }))), [{}]);
  let best = { tuning: base, score: total(scoreSet(fit, markets, base)) };
  for (const c of combos) {
    const t = { ...base, ...c };
    const s = total(scoreSet(fit, markets, t));
    if (s < best.score - 1e-9) best = { tuning: t, score: s };
  }
  const chosen = Object.fromEntries(keys.map((k) => [k, best.tuning[k] ?? BATTER_TUNING[k]]));
  console.log(`\n## ${name}  best on fit: ${JSON.stringify(chosen)}`);
  const fb = scoreSet(fit, markets, base), ft = scoreSet(fit, markets, best.tuning);
  const hb = scoreSet(hold, markets, base), ht = scoreSet(hold, markets, best.tuning);
  for (const m of markets) {
    console.log(`  ${m}`);
    console.log('   ' + fmt('fit  before', fb[m]));
    console.log('   ' + fmt('fit  tuned', ft[m]));
    console.log('   ' + fmt('hold before', hb[m]));
    console.log('   ' + fmt('hold tuned', ht[m]));
  }
  console.log(`  sum logloss fit ${total(fb).toFixed(4)} -> ${total(ft).toFixed(4)}   hold ${total(hb).toFixed(4)} -> ${total(ht).toFixed(4)}`);
  return best.tuning;
}

const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, k) => +(a + k * step).toFixed(4));

const only = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1].split(',') : null;
const run = (tag) => !only || only.includes(tag);

let t = process.argv.includes('--base') ? JSON.parse(process.argv[process.argv.indexOf('--base') + 1]) : {};
if (run('pa')) {
  // Fitted to the observed PA counts themselves, which is exactly the quantity
  // these two settings describe; the count markets then inherit it.
  t = search('PA distribution (on actual PA)', ['pa'], {
    teamPaSd: [4, 4.5, 5, 5.5, 6],
    paLossRate: range(0, 0.25, 0.025),
  }, t);
}
if (run('rate')) t = search('hit-rate spread', ['hits', 'tb', 'singles', 'hr'], { rateSpread: range(0, 0.6, 0.05) }, t);
if (run('k')) t = search('strikeouts', ['k'], { kRateSpread: range(0, 0.4, 0.1) }, t);
if (run('contact')) t = search('contact level', ['hits', 'tb', 'singles'], { contactShare: range(0.96, 1.02, 0.01) }, t);
if (run('hrshrink')) t = search('HR shrinkage', ['hr', 'tb'], { hrPriorStrength: [60, 100, 150, 200, 300, 400, 600] }, t);
if (run('power')) t = search('power level', ['hr', 'tb'], { hrLevel: range(0.89, 1.01, 0.02) }, t);
if (run('runs')) t = search('runs', ['runs'], { runLevel: range(0.9, 1.0, 0.01) }, t);
if (run('rbi')) t = search('rbi level', ['rbi'], { rbiLevel: range(0.93, 1.03, 0.01) }, t);
if (run('rbik')) t = search('rbi dispersion', ['rbi'], { rbiK: [0.6, 0.7, 0.85, 1.0, 1.2] }, t);
if (run('hrr')) t = search('hrr', ['hrr'], { hrrVarianceInflation: range(1.4, 2.0, 0.1), hrrStructuralZero: range(0.04, 0.16, 0.02) }, t);
if (run('sbk')) t = search('sb dispersion', ['sb'], { sbK: [1, 1.5, 2, 3, 5] }, t);
if (run('sb')) t = search('sb level', ['sb'], { sbScale: range(0.86, 1.0, 0.02) }, t);

// --apply '{json}' scores a hand-picked tuning on the holdout instead.
if (process.argv.includes('--apply')) t = JSON.parse(process.argv[process.argv.indexOf('--apply') + 1]);

console.log('\nfinal fit-window tuning', JSON.stringify(t));
const all = Object.keys(MARKETS);
const hb = scoreSet(hold, all, {}), ht = scoreSet(hold, all, t);
console.log('\nHOLDOUT, defaults -> fit-window tuning');
for (const m of all) {
  console.log(`  ${m}`);
  console.log('   ' + fmt('before', hb[m]));
  console.log('   ' + fmt('after', ht[m]));
}
console.log('\ncurrent defaults', JSON.stringify(BATTER_TUNING));
