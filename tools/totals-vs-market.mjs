// The projected total, the exchange's total, and the runs that were actually
// scored — all three side by side, for the games where all three exist.
//
//   node tools/totals-vs-market.mjs .backtest-cache/acc_g_all.ndjson \
//     --features .backtest-cache/features_2026.json \
//     --kcache C:/Users/qrob1/mlbwork/kalshi-cache [--decision-min 120]
//
// WHY THIS EXISTS, GIVEN THAT THE POINT IS ACCURACY AND NOT PRICE
//
// `tools/accuracy-report.mjs --totals` answers "is the projection right?"
// without a price anywhere, and that is the question that matters. It cannot
// answer the OTHER question a one-sided board raises: when the model and the
// market disagree by more than a run, which of them is wrong? That question
// needs the market — not as a target, but as a way of SELECTING the games, so
// that the disagreements can be scored against the box score.
//
// Nothing here is fitted. The market is never an input to the model and never
// will be from this file: it picks the sample, and the runs decide.
//
// It reads the settled public Kalshi candlesticks another study already
// cached (`--kcache`) and makes no request of its own. The implied total is
// read off the KXMLBTOTAL ladder at the decision time — the mid of every rung,
// summed, which is E[T] = sum_k P(T > k).

import fs from 'node:fs';
import path from 'node:path';
import { argv } from './backtest-common.mjs';
import { parseEventTicker, startMsOf, quoteAt } from './kalshi-common.mjs';

const ACC = process.argv.slice(2).filter((a) => a.endsWith('.ndjson'));
if (!ACC.length) throw new Error('give at least one accuracy-extract .ndjson');
const KCACHE = argv('kcache', path.resolve('.kalshi-cache'));
const DECISION_MIN = Number(argv('decision-min', 120));
const featureFiles = process.argv
  .map((a, i) => (a === '--features' ? process.argv[i + 1] : null))
  .filter(Boolean);
if (!featureFiles.length) throw new Error('--features is required: the acc records carry a gamePk, not team codes');

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const acc = [];
for (const f of ACC) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.trim()) acc.push(JSON.parse(line));
  }
}
const meta = new Map();
for (const f of featureFiles) {
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8')).rows) meta.set(r.gamePk, r);
}
// Kalshi names a game by date, away+home abbreviation and doubleheader number,
// which is what `parseEventTicker` returns; the acc records carry a gamePk.
const byKey = new Map();
for (const r of acc) {
  if (r.t !== 'g' || r.tot?.[0] == null) continue;
  const m = meta.get(r.g);
  if (m) byKey.set(`${m.date}|${m.away.abbr}${m.home.abbr}|${m.gameNumber || 1}`, r);
}

/** E[T] from a rung -> P(over rung) map, with a geometric tail. */
function impliedTotal(ladder) {
  const rungs = [...ladder.keys()].sort((a, b) => a - b);
  const last = rungs.at(-1);
  const prev = rungs.at(-2);
  const decay = Math.min(0.95, Math.max(0.3, ladder.get(last) / ladder.get(prev)));
  let total = 0;
  for (let k = 0; k <= 40; k++) {
    const rung = k + 0.5;
    if (ladder.has(rung)) total += ladder.get(rung);
    else if (rung < rungs[0]) total += 1;
    else total += ladder.get(last) * decay ** (rung - last);
  }
  return total;
}

const dir = path.join(KCACHE, 'candles-game');
if (!fs.existsSync(dir)) throw new Error(`no candles-game under ${KCACHE}`);
const rows = [];
for (const file of fs.readdirSync(dir)) {
  const event = file.replace(/\.json$/, '');
  const parsed = parseEventTicker(`KXMLBTOTAL-${event}`);
  if (!parsed) continue;
  const rec = byKey.get(`${parsed.date}|${parsed.teams}|${parsed.gameNumber || 1}`);
  if (!rec) continue;
  const candles = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const decision = startMsOf(parsed) - DECISION_MIN * 60e3;
  const ladder = new Map();
  for (const [ticker, series] of Object.entries(candles)) {
    if (!ticker.startsWith('KXMLBTOTAL')) continue;
    // `...-9` is "Over 8.5 runs": Kalshi names the rung by its threshold.
    const threshold = Number(ticker.split('-').pop());
    if (!Number.isFinite(threshold)) continue;
    const q = quoteAt(series, decision);
    if (q?.mid != null) ladder.set(threshold - 0.5, q.mid / 100);
  }
  if (ladder.size < 6) continue;
  rows.push({ date: parsed.date, event, proj: rec.tot[0], act: rec.tot[1], mkt: impliedTotal(ladder) });
}
rows.sort((a, b) => (a.date < b.date ? -1 : 1));
if (!rows.length) throw new Error('no game matched a cached Kalshi total ladder');
console.log(`${rows.length} games with a Kalshi total ladder at T-${DECISION_MIN}, ${rows[0].date}..${rows.at(-1).date}`);

const ci = (list, f) => {
  const v = list.map(f);
  const m = mean(v);
  const s = 1.96 * Math.sqrt(mean(v.map((x) => (x - m) ** 2)) / list.length);
  return `${m >= 0 ? '+' : ''}${m.toFixed(2)} [${(m - s).toFixed(2)}, ${(m + s).toFixed(2)}]`;
};
const band = (list, name) => {
  if (list.length < 20) { console.log(`  ${name.padEnd(36)} n=${list.length} (too few)`); return; }
  console.log(
    `  ${name.padEnd(36)} n=${String(list.length).padStart(4)}`
    + `  model ${mean(list.map((r) => r.proj)).toFixed(2)}  market ${mean(list.map((r) => r.mkt)).toFixed(2)}`
    + `  ACTUAL ${mean(list.map((r) => r.act)).toFixed(2)}`
    + `   model bias ${ci(list, (r) => r.act - r.proj)}   market bias ${ci(list, (r) => r.act - r.mkt)}`,
  );
};

console.log('\nWHOSE DISAGREEMENT IS WRONG (bias = actual - that number)');
band(rows, 'every game');
band(rows.filter((r) => r.proj - r.mkt >= 1), 'model a run or more ABOVE market');
band(rows.filter((r) => Math.abs(r.proj - r.mkt) < 1), 'the two within a run');
band(rows.filter((r) => r.proj - r.mkt <= -1), 'model a run or more BELOW market');

const above = rows.filter((r) => r.proj - r.mkt >= 1).length;
const below = rows.filter((r) => r.proj - r.mkt <= -1).length;
console.log(
  `\n  of the ${above + below} disagreements of a run or more, ${above} are the model HIGH (an over)`
  + ` and ${below} the model LOW — ${(100 * above / (above + below)).toFixed(0)}% overs`,
);

console.log('\nHOW LOW EACH ONE IS WILLING TO GO');
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const pctile = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];
for (const [name, key] of [['model', 'proj'], ['market', 'mkt']]) {
  const xs = rows.map((r) => r[key]);
  console.log(
    `  ${name.padEnd(7)} sd ${sd(xs).toFixed(3)}   min ${pctile(xs, 0).toFixed(2)}`
    + `  1% ${pctile(xs, 0.01).toFixed(2)}  5% ${pctile(xs, 0.05).toFixed(2)}`
    + `  50% ${pctile(xs, 0.5).toFixed(2)}  95% ${pctile(xs, 0.95).toFixed(2)}`,
  );
}
band(rows.filter((r) => r.mkt < 7.75), 'games the MARKET prices under 7.75');
band(rows.filter((r) => r.proj < 7.75), 'games the MODEL prices under 7.75');

// Encompassing: put both numbers in one regression of the runs actually
// scored. A coefficient near zero on one of them means it carries nothing the
// other does not already have.
console.log('\nDOES EITHER CARRY INFORMATION THE OTHER DOES NOT?');
const mp = mean(rows.map((r) => r.proj));
const mm = mean(rows.map((r) => r.mkt));
const cov = (a, b) => mean(a.map((x, i) => x * b[i]));
const x1 = rows.map((r) => r.proj - mp);
const x2 = rows.map((r) => r.mkt - mm);
const y = rows.map((r) => r.act - mean(rows.map((q) => q.act)));
const s11 = cov(x1, x1);
const s22 = cov(x2, x2);
const s12 = cov(x1, x2);
const det = s11 * s22 - s12 * s12;
const b1 = (s22 * cov(x1, y) - s12 * cov(x2, y)) / det;
const b2 = (s11 * cov(x2, y) - s12 * cov(x1, y)) / det;
// Bootstrap the pair over games.
const draws = { b1: [], b2: [] };
for (let b = 0; b < 2000; b++) {
  const s = Array.from({ length: rows.length }, () => rows[(Math.random() * rows.length) | 0]);
  const p = s.map((r) => r.proj - mp);
  const q = s.map((r) => r.mkt - mm);
  const yy = s.map((r) => r.act);
  const my = mean(yy);
  const t = yy.map((v) => v - my);
  const d = cov(p, p) * cov(q, q) - cov(p, q) ** 2;
  if (!d) continue;
  draws.b1.push((cov(q, q) * cov(p, t) - cov(p, q) * cov(q, t)) / d);
  draws.b2.push((cov(p, p) * cov(q, t) - cov(p, q) * cov(p, t)) / d);
}
const pct = (arr, f) => [...arr].sort((a, b) => a - b)[Math.floor(f * (arr.length - 1))];
for (const [name, b, list] of [['model', b1, draws.b1], ['market', b2, draws.b2]]) {
  const lo = pct(list, 0.025);
  const hi = pct(list, 0.975);
  console.log(`  ${name.padEnd(7)} ${b >= 0 ? '+' : ''}${b.toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]${lo > 0 || hi < 0 ? '  *' : ''}`);
}
// The part of the market the model cannot see, and whether it predicts.
const a = cov(x1, x2) / s11;
const u = x2.map((v, i) => v - a * x1[i]);
const su = Math.sqrt(mean(u.map((v) => v * v)));
const resid = rows.map((r) => r.act - r.proj);
const mu = mean(u);
const mr = mean(resid);
const slope = mean(u.map((v, i) => (v - mu) * (resid[i] - mr))) / mean(u.map((v) => (v - mu) ** 2));
const slopeDraws = [];
for (let b = 0; b < 2000; b++) {
  const idx = Array.from({ length: rows.length }, () => (Math.random() * rows.length) | 0);
  const uu = idx.map((i) => u[i]);
  const rr = idx.map((i) => resid[i]);
  const m1 = mean(uu);
  const m2 = mean(rr);
  const v = mean(uu.map((x) => (x - m1) ** 2));
  if (v) slopeDraws.push(mean(uu.map((x, i) => (x - m1) * (rr[i] - m2))) / v);
}
console.log(
  `  the market's own signal, orthogonal to the model: sd ${su.toFixed(3)} runs;`
  + ` (actual - model) on it, slope ${slope.toFixed(3)}`
  + ` [${pct(slopeDraws, 0.025).toFixed(3)}, ${pct(slopeDraws, 0.975).toFixed(3)}]`,
);
