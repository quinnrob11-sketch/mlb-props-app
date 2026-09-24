// Fit and measure the batter model's SHRINKAGE, split by how much of a book
// the hitter has.
//
//   # 1. freeze the replay's rows once per season (this is the slow part)
//   node --max-old-space-size=12288 tools/batter-thin-fit.mjs --dump \
//     --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .work/rows_2025.ndjson
//
//   # 2. sweep tunings over those rows, as many as you like, in seconds
//   node --max-old-space-size=12288 tools/batter-thin-fit.mjs \
//     --rows .work/rows_2025.ndjson --rows .work/rows_2026.ndjson \
//     --fit-to 2026-08-10 --val 2026-08-10..2026-09-02 \
//     --grid '[{"label":"ship"},{"label":"thin","priorThinShade":0.25}]'
//
// THIS IS NOT A NEW REPLAY. `--dump` imports `buildRows` from
// `tools/backtest-batters.mjs` and writes exactly what that replay built — the
// same as-of season lines, the same `projectPitcher` starter rates, the same
// league object — so a sweep re-projects identical inputs instead of
// re-deriving them. Every as-of rule and every caveat lives in that file.
//
// The windows are the pre-registered ones: FIT is everything before
// `--fit-to`, VALIDATE is `--val`, and anything after is left alone.

import fs from 'node:fs';
import path from 'node:path';
import { projectBatter } from '../src/model/batter.js';
import { pmfOf, MARKETS } from './backtest-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const argAll = (name) => process.argv.reduce((a, v, i) => (v === `--${name}` ? a.concat([process.argv[i + 1]]) : a), []);
const has = (name) => process.argv.includes(`--${name}`);

// ── dump ────────────────────────────────────────────────────────────────────
// The league object is one object per DATE, so it is written once under a key
// and referenced, rather than repeated on all ~250 rows of that day.
if (has('dump')) {
  const OUT = arg('out', null);
  if (!OUT) throw new Error('--dump needs --out');
  const { buildRows } = await import('./backtest-batters.mjs');
  const rows = buildRows();
  const lgs = new Map();
  const lines = [];
  for (const r of rows) {
    if (!lgs.has(r.date)) lgs.set(r.date, r.input.lg);
    const { lg, ...input } = r.input;
    lines.push(JSON.stringify({
      d: r.date, id: r.id, g: r.gamePk, park: r.park, input, actual: r.actual,
    }));
  }
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ lg: Object.fromEntries(lgs) })}\n${lines.join('\n')}\n`);
  process.stderr.write(`wrote ${lines.length} rows to ${OUT}\n`);
  process.exit(0);
}

// ── load ────────────────────────────────────────────────────────────────────
const files = argAll('rows');
if (!files.length) throw new Error('give --rows FILE (repeatable), or --dump');
const rows = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8').split('\n');
  const lg = JSON.parse(text[0]).lg;
  for (const line of text.slice(1)) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    r.input.lg = lg[r.d];
    rows.push(r);
  }
}
process.stderr.write(`${rows.length} rows from ${files.length} files\n`);

const FIT_TO = arg('fit-to', '2026-08-10');
const [VAL_FROM, VAL_TO] = arg('val', '2026-08-10..2026-09-02').split('..');
const HOLD = arg('hold', null);
const WINDOWS = [
  ['FIT', (r) => r.d < FIT_TO],
  ['VALIDATE', (r) => r.d >= VAL_FROM && r.d < VAL_TO],
];
if (HOLD) {
  const [hf, ht] = HOLD.split('..');
  WINDOWS.push(['HOLDOUT', (r) => r.d >= hf && r.d <= ht]);
}

/**
 * How much of a book the hitter had before first pitch, in plate appearances,
 * counting the prior season at the model's own `seasonPriorWeight`. This is
 * the quantity the shrinkage divides by, and the one the thin-hitter defect is
 * indexed on.
 */
export const bookOf = (input, w25 = 0.6) =>
  (input.season26?.plateAppearances || 0) + w25 * (input.season25?.plateAppearances || 0);

const pa26Of = (r) => r.input.season26?.plateAppearances || 0;

// Default: the two groups docs/BATTER-CALIBRATION-FIX.md reported. `--bands`
// switches to the three plate-appearance bands docs/ACCURACY.md slices on
// (`sample` in tools/accuracy-report.mjs), which is what a two-sided
// playing-time tilt has to be judged on — a fix that only moves error from one
// band to another is visible as exactly that.
const GROUPS = process.argv.includes('--bands')
  ? {
    'thin (<50 PA)': (r) => pa26Of(r) < 50,
    'building (50-199)': (r) => pa26Of(r) >= 50 && pa26Of(r) < 200,
    'established (200+)': (r) => pa26Of(r) >= 200,
  }
  : {
    'thin (<50 PA)': (r) => pa26Of(r) < 50,
    'regular (50+ PA)': (r) => pa26Of(r) >= 50,
  };

// ── scoring ─────────────────────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/**
 * THE EVIDENCE FOR A PLAYING-TIME-AWARE PRIOR. Per book-size bucket, the rate
 * a hitter in that bucket ACTUALLY produced per plate appearance, against the
 * flat prior the model shrinks him toward and against what the model projected
 * him at. Run it on the fit window alone; the buckets are book size before
 * first pitch, so nothing here needs the outcome to be known in advance.
 *
 *   node tools/batter-thin-fit.mjs --rows .work/rows_2025.ndjson --book-table
 */
const FLAT_PRIOR = { hits: 0.222, singles: 0.14, hr: 0.03, runs: 0.12, rbi: 0.115 };
function bookTable(subset) {
  const EDGES = [0, 10, 25, 50, 100, 200, 350, 550, 800, 1200, Infinity];
  const buckets = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], pa: 0, n: 0, act: {}, proj: {} }));
  let skipped = 0;
  for (const r of subset) {
    const book = bookOf(r.input);
    const b = buckets.find((x) => book >= x.lo && book < x.hi);
    const p = projectBatter(r.input);
    // Opening day: the as-of league object divides by zero games played, so
    // the projection is not a number. `tools/accuracy-report.mjs` counts these
    // the same way (18 of 81,306 over the two seasons) rather than hiding them.
    if (!Number.isFinite(p.projH)) { skipped++; continue; }
    b.n++; b.pa += r.actual.pa;
    for (const m of Object.keys(FLAT_PRIOR)) {
      b.act[m] = (b.act[m] || 0) + r.actual[m];
      b.proj[m] = (b.proj[m] || 0) + p[MARKETS[m].proj];
    }
    b.projPa = (b.projPa || 0) + p.pa;
  }
  console.log('\n=== rate per plate appearance by book size (book = PA this season + 0.6 x PA last season) ===');
  console.log(`  ${'book'.padEnd(12)} ${'n'.padStart(7)} ${'PA/g'.padStart(6)}  ` + Object.keys(FLAT_PRIOR).map((m) => `${m} act/proj/prior`.padStart(24)).join(''));
  for (const b of buckets) {
    if (!b.n) continue;
    const cells = Object.keys(FLAT_PRIOR).map((m) => {
      const a = b.act[m] / b.pa;
      const pr = b.proj[m] / b.projPa;
      return `${a.toFixed(4)}/${pr.toFixed(4)}/${FLAT_PRIOR[m].toFixed(3)}`.padStart(24);
    }).join('');
    console.log(`  ${`${b.lo}-${b.hi === Infinity ? '' : b.hi}`.padEnd(12)} ${String(b.n).padStart(7)} ${(b.pa / b.n).toFixed(2).padStart(6)}  ${cells}`);
  }
}

/**
 * THE PLAYING-TIME CURVE, AND WHICH AXIS CARRIES IT.
 *
 * Two candidate axes, both known before first pitch: how many plate
 * appearances the hitter has this season, and how many he has PER GAME he has
 * played. For each bucket this prints
 *
 *   PAratio    total actual plate appearances / total projected — is the model
 *              putting him at the plate the right number of times;
 *   per market the RATE ratio, actual per actual-PA over projected per
 *              projected-PA — what is left once the plate appearances are
 *              taken out.
 *
 * Splitting it this way is the whole point: a playing-time error that is
 * entirely in PAratio is a different defect, with a different fix, from one
 * that survives in the rates.
 *
 *   node tools/batter-thin-fit.mjs --rows .work/rows_2025.ndjson --duty-table
 */
function dutyTable(subset, projs) {
  const SHOW = ['hits', 'tb', 'runs', 'rbi', 'hrr', 'singles', 'k'];
  const AXES = [
    ['PA this season', (r) => pa26Of(r), [0, 25, 50, 100, 150, 200, 250, 300, 375, 450, 525, Infinity]],
    ['PA per game played', (r) => {
      const g = r.input.season26?.gamesPlayed || 0;
      return g >= 5 ? pa26Of(r) / g : NaN;
    }, [0, 2, 2.6, 3, 3.3, 3.6, 3.85, 4.05, 4.25, 4.45, Infinity]],
  ];
  for (const [name, axis, edges] of AXES) {
    const buckets = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, aPa: 0, pPa: 0, m: {} }));
    for (let i = 0; i < subset.length; i++) {
      const v = axis(subset[i]);
      const p = projs[i];
      if (!Number.isFinite(v) || !Number.isFinite(p.projH)) continue;
      const b = buckets.find((x) => v >= x.lo && v < x.hi);
      if (!b) continue;
      b.n++; b.aPa += subset[i].actual.pa; b.pPa += p.pa;
      for (const m of SHOW) {
        const s = (b.m[m] ||= { proj: 0, act: 0 });
        s.proj += p[MARKETS[m].proj]; s.act += subset[i].actual[m];
      }
    }
    console.log(`\n=== playing-time curve, axis = ${name} ===`);
    console.log('    (PAratio > 1 means the model puts him at the plate too FEW times; rate ratios are net of that)');
    console.log(`  ${'band'.padEnd(11)} ${'n'.padStart(6)} ${'PAratio'.padStart(8)}  ` + SHOW.map((m) => m.padStart(9)).join(''));
    for (const b of buckets) {
      if (!b.n) continue;
      const cells = SHOW.map((m) => (((b.m[m].act / b.aPa) / (b.m[m].proj / b.pPa))).toFixed(3).padStart(9)).join('');
      console.log(`  ${`${b.lo}-${b.hi === Infinity ? '' : b.hi}`.padEnd(11)} ${String(b.n).padStart(6)} ${(b.aPa / b.pPa).toFixed(4).padStart(8)}  ${cells}`);
    }
  }
}

/**
 * FIT THE DUTY TILT, BY REGRESSION RATHER THAN BY GRID.
 *
 * The thing being fitted is one straight line, so gridding it is both slower
 * and worse than solving it. With `z` the hitter's games-shrunk plate
 * appearances per game (clamped), the term says
 *
 *     projected PA  ->  projected PA x (1 + s (z - pivot))
 *
 * where z is `w x clamp(PA/G, lo, hi)` and w is the games weight, so the whole
 * term expands to
 *
 *     projected PA + s (projected PA x w x clamp) - s pivot (projected PA x w)
 *
 * Regressing the RESIDUAL (actual - projected PA) on those last two columns
 * with no intercept therefore returns s directly as the first coefficient and
 * -s x pivot as the second, so pivot is the ratio of the two. There is nothing
 * left to choose: the level and the tilt come out of one solve, which is the
 * point — fitted separately they trade against each other, and a grid over the
 * two is degenerate for exactly that reason (a pooled plate-appearance gap of
 * zero is reachable at every slope by moving the pivot).
 *
 * `lo`, `hi` and `priorGames` are NOT solved here; they say where the line
 * stops being a line and how fast it fades in, so each candidate triple is
 * fitted separately and judged on the residual: the biggest remaining
 * |actual/projected - 1| over the duty buckets, and the n-weighted mean of it.
 * Folds are by hitter, as everywhere else in this file.
 */
function dutyFit(subset, candidates, k = 5) {
  const BUCKETS = [0, 2, 2.6, 3, 3.3, 3.6, 3.85, 4.05, 4.25, 4.45, Infinity];
  const foldOf = new Map();
  let next = 0;
  const fold = subset.map((r) => {
    const key = `${r.d.slice(0, 4)}:${r.id}`;
    if (!foldOf.has(key)) foldOf.set(key, next++ % k);
    return foldOf.get(key);
  });
  console.log('\n=== solving the duty tilt on the plate appearances (no outcome market is looked at here) ===');
  console.log(`  ${'lo   hi   priorGames'.padEnd(22)} ${'slope'.padStart(8)} ${'pivot'.padStart(7)}  ${'worst bucket'.padStart(13)} ${'mean |err|'.padStart(11)}   ${'slope by fold'.padStart(13)}`);
  for (const c of candidates) {
    const base = subset.map((r) => projectBatter({ ...r.input, tuning: { duty: { pa: 0 } } }));
    const z = subset.map((r) => {
      const g = r.input.season26?.gamesPlayed || 0;
      if (!g) return null;   // the term is inert here, so the row carries no information about it
      const w = g / (g + c.priorGames);
      return { w, wc: w * Math.min(c.hi, Math.max(c.lo, pa26Of(r) / g)) };
    });
    const solve = (idx) => {
      let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
      for (const i of idx) {
        const p = base[i].pa;
        if (!Number.isFinite(p) || !z[i]) continue;
        const x1 = p * z[i].wc, x2 = p * z[i].w, y = subset[i].actual.pa - p;
        s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; y1 += x1 * y; y2 += x2 * y;
      }
      const det = s11 * s22 - s12 * s12;
      if (!det) return null;
      const s = (s22 * y1 - s12 * y2) / det;
      const b = (s11 * y2 - s12 * y1) / det;
      return { s, pivot: -b / s };
    };
    const all = subset.map((_, i) => i);
    const full = solve(all);
    if (!full) continue;
    const perFold = [];
    for (let f = 0; f < k; f++) {
      const fit = solve(all.filter((i) => fold[i] !== f));
      if (fit) perFold.push(fit.s);
    }
    // Residual: apply the solved term and re-measure the buckets.
    const tune = { duty: { pa: full.s, pivot: full.pivot, lo: c.lo, hi: c.hi, priorGames: c.priorGames } };
    const buckets = BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: BUCKETS[i + 1], n: 0, a: 0, p: 0 }));
    for (let i = 0; i < subset.length; i++) {
      const g = subset[i].input.season26?.gamesPlayed || 0;
      if (g < 5) continue;
      const v = pa26Of(subset[i]) / g;
      const b = buckets.find((x) => v >= x.lo && v < x.hi);
      const p = projectBatter({ ...subset[i].input, tuning: tune });
      if (!b || !Number.isFinite(p.pa)) continue;
      b.n++; b.a += subset[i].actual.pa; b.p += p.pa;
    }
    const errs = buckets.filter((b) => b.n).map((b) => ({ n: b.n, e: Math.abs(b.a / b.p - 1) }));
    const worst = Math.max(...errs.map((x) => x.e));
    const wmean = errs.reduce((s, x) => s + x.n * x.e, 0) / errs.reduce((s, x) => s + x.n, 0);
    console.log(
      `  ${`${c.lo}  ${c.hi}  ${c.priorGames}`.padEnd(22)} ${full.s.toFixed(4).padStart(8)} ${full.pivot.toFixed(3).padStart(7)}`
      + `  ${(100 * worst).toFixed(2).padStart(12)}% ${(100 * wmean).toFixed(3).padStart(10)}%   ${perFold.map((x) => x.toFixed(3)).join(' ')}`,
    );
  }
}

/**
 * IS THE LINEUP-SLOT TERM POINTING THE WRONG WAY?
 *
 * docs/BATTER-CALIBRATION-FIX.md section 3 regressed the outcome on three
 * axes — the hitter, "lineup slot / side", and park + starter — and the middle
 * one came out at -0.27 on hits. That middle axis is NOT the slot term. It is
 * everything that moves within a hitter once park and the starter are neutral,
 * which is the slot, the side, AND his season line updating underneath him
 * game by game (and now the thin ramp and the duty tilt riding on it). Those
 * are three different things and they have to be separated before the sign
 * means anything.
 *
 * This re-projects each row three times to cut them apart exactly:
 *
 *   base    the row as it is;
 *   refSlot the same row moved to slot 5 at home — the slot/side axis is
 *           base minus this, and it is the only thing the model's lineup-slot
 *           arithmetic controls;
 *   drift   refSlot minus the hitter's own mean refSlot — what his own line
 *           did over the season, which no slot term is responsible for.
 *
 * Then one least-squares fit of the outcome on [hitter mean, slot/side,
 * drift, park+starter]. A coefficient of 1 means that axis is scaled right, 0
 * that it is worth nothing, below 0 that it is worth less than nothing.
 *
 * AND A SYNTHETIC NULL, because a negative coefficient on the drift axis is
 * exactly what a bad measurement would also produce. Controlling for a
 * hitter's own season-average projection is close to controlling for his
 * realised season mean, and conditioning on a total forces the stretches
 * either side of it to offset — which would manufacture a negative drift
 * coefficient out of a model that is perfectly right. So the same regression
 * is run a second time with every outcome REPLACED by a draw from the model's
 * own distribution for that row. The model is then correct by construction and
 * every coefficient must come back at 1; whatever it actually returns is the
 * measurement's own bias, and the real numbers can only be read against it.
 */
function slotStudy(subset, projs, tuning = {}) {
  // The two re-projections must carry the SAME tuning as `projs`, or the
  // "park + starter" column is the difference between two different models
  // rather than the difference the park and the starter make.
  const NOCTX = { ...tuning, parkStrength: 0, pitcherInfluence: 0 };
  const plain = subset.map((r) => projectBatter({ ...r.input, tuning: NOCTX }));
  const refSlot = subset.map((r) => projectBatter({ ...r.input, slot: 5, isAway: false, tuning: NOCTX }));
  const byHitter = new Map();
  for (let i = 0; i < subset.length; i++) {
    const key = `${subset[i].d.slice(0, 4)}:${subset[i].id}`;
    if (!byHitter.has(key)) byHitter.set(key, []);
    byHitter.get(key).push(i);
  }
  console.log('\n=== the lineup-slot axis, separated from the season drift it was mixed with ===');
  console.log('    (coefficient 1 = that axis is scaled right; sd = how much of the projection\'s spread it carries)');
  console.log('    NULL = the same regression with the outcomes redrawn from the model, where 1 is the right answer');
  console.log('  market        hitter         slot/side      season drift    park+starter');
  // A reproducible uniform stream, so the null is identical on every run.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const draw = (dist, max) => {
    const u = rnd();
    for (let k = 0; k <= max; k++) if (dist(k + 0.5) <= u) return k;
    return max;
  };
  const out = {};
  for (const [m, spec] of Object.entries(MARKETS)) {
    if (m === 'pa') continue;
    const X = [[], [], [], []]; const Y = []; const YN = [];
    for (const idx of byHitter.values()) {
      const use = idx.filter((i) => Number.isFinite(projs[i][spec.proj]) && Number.isFinite(refSlot[i][spec.proj]));
      if (use.length < 20) continue;
      const mh = mean(use.map((i) => refSlot[i][spec.proj]));
      for (const i of use) {
        X[0].push(mh);                                             // who he is
        X[1].push(plain[i][spec.proj] - refSlot[i][spec.proj]);    // slot + side, exactly
        X[2].push(refSlot[i][spec.proj] - mh);                     // his line drifting
        X[3].push(projs[i][spec.proj] - plain[i][spec.proj]);      // park + starter
        Y.push(subset[i].actual[m]);
        YN.push(draw(projs[i].dist[m], spec.max));
      }
    }
    if (Y.length < 1000) continue;
    const sd = X.map((x) => Math.sqrt(mean(x.map((v) => (v - mean(x)) ** 2))));
    // Stolen bases are per GAME, so the slot and context columns are all zero
    // for them and the normal equations are singular. Say so instead of
    // printing NaN.
    if (sd.some((v) => !(v > 0))) { console.log(`  ${m.padEnd(9)} (no spread on one axis — not identified)`); continue; }
    const beta = lstsq(X, Y);
    const bnull = lstsq(X, YN);
    out[m] = { beta, sd, bnull };
    console.log(
      `  ${m.padEnd(9)} ` + [0, 1, 2, 3].map((a) => `${beta[a].toFixed(2).padStart(7)} (sd ${sd[a].toFixed(3)})`).join(' '),
    );
    console.log(
      `  ${'  null'.padEnd(9)} ` + [0, 1, 2, 3].map((a) => `${bnull[a].toFixed(2).padStart(7)}           `).join(' '),
    );
  }
  return out;
}

/** Least squares of Y on the columns of X (each an array), with an intercept. */
function lstsq(X, Y) {
  const k = X.length;
  const mu = X.map((x) => mean(x));
  const my = mean(Y);
  const M = [];
  for (let a = 0; a < k; a++) {
    const row = [];
    for (let c = 0; c < k; c++) row.push(mean(X[a].map((x, i) => (x - mu[a]) * (X[c][i] - mu[c]))));
    row.push(mean(X[a].map((x, i) => (x - mu[a]) * (Y[i] - my))));
    M.push(row);
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (!M[c][c]) continue;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[k] / row[i]);
}

/**
 * Per market: the calibration gap pooled over the ladder (predicted minus
 * observed, percentage points — the number docs/ACCURACY.md reports), log loss
 * of the whole pmf, Brier over the ladder, and the point projection's bias,
 * MAE, MAE of the slate average, correlation and regression slope.
 *
 * The slate-average MAE is computed WITHIN the group being scored, so "better
 * than average" means better than knowing the group's mean, not better than
 * knowing nothing.
 */
function scoreRows(subset, projs) {
  const out = {};
  for (const [m, spec] of Object.entries(MARKETS)) {
    let n = 0, ll = 0, brier = 0, nb = 0, gapP = 0, gapO = 0;
    const P = [], A = [];
    for (let i = 0; i < subset.length; i++) {
      const proj = projs[i];
      const mu = proj[spec.proj];
      const a = subset[i].actual[m];
      if (!Number.isFinite(mu) || !Number.isFinite(a)) continue;
      // `pa` is not a market; it is the plate-appearance distribution every
      // count market sits on, and it is scored here because the thin-hitter
      // correction moves it directly.
      const dist = m === 'pa'
        ? (line) => proj.paDist.reduce((acc, [k, p]) => acc + (k > line ? p : 0), 0)
        : proj.dist[m];
      const pmf = pmfOf(dist, spec.max);
      pmf[spec.max] = Math.max(0, dist(spec.max - 0.5));
      n++; P.push(mu); A.push(a);
      ll += -Math.log(Math.max(1e-9, pmf[Math.min(a, spec.max)]));
      for (const line of spec.lines) {
        const p = dist(line);
        const y = a > line ? 1 : 0;
        brier += (p - y) ** 2; nb++; gapP += p; gapO += y;
      }
    }
    if (!n) continue;
    const mp = mean(P), ma = mean(A);
    const sdp = Math.sqrt(mean(P.map((x) => (x - mp) ** 2)));
    const sda = Math.sqrt(mean(A.map((x) => (x - ma) ** 2)));
    const cov = mean(P.map((x, i) => (x - mp) * (A[i] - ma)));
    out[m] = {
      n,
      gap: (gapP - gapO) / nb,
      logLoss: ll / n,
      brier: brier / nb,
      meanProj: mp,
      meanActual: ma,
      mae: mean(P.map((x, i) => Math.abs(x - A[i]))),
      naiveMae: mean(A.map((x) => Math.abs(x - ma))),
      corr: sdp && sda ? cov / (sdp * sda) : 0,
      slope: sdp ? cov / (sdp * sdp) : 0,
      sdProj: sdp,
      sdActual: sda,
    };
  }
  return out;
}

/**
 * DOES THE POINT PROJECTION RANK HITTERS AT ALL?
 *
 * docs/ACCURACY.md reports the per-game correlation between the projection and
 * the box score (0.10-0.15 for every batter market) and the MAE against the
 * slate average (0-4% better). Both are dominated by the noise in ONE game,
 * which no model can forecast, so neither says how much of the ranking the
 * model is getting. This separates the two:
 *
 *   BETWEEN HITTERS. Collapse each hitter-season to his mean projection and
 *   his mean actual over the games he started (minimum `minG`). The
 *   correlation of those two means is the model's ranking power with most of
 *   the single-game noise averaged out. What is left of the noise is removed
 *   explicitly: the variance of a hitter's game-to-game outcome, divided by
 *   his number of games, is subtracted from the observed variance of the
 *   means, giving the variance of TRUE hitter ability. The square root of the
 *   ratio of true variance to observed variance is the highest correlation any
 *   projection could reach against these means — the ceiling — and the model's
 *   correlation over that ceiling is the fraction of the available ranking it
 *   actually has.
 *
 *   WITHIN A HITTER. The rest of the projection's spread is context: the park,
 *   the opposing starter, the lineup slot, the side. Regressing the outcome on
 *   the hitter's own mean projection and on the deviation from it, separately,
 *   says whether that context is worth anything. A coefficient near 1 means
 *   that axis is correctly scaled, near 0 that it is noise, above 1 that it is
 *   under-spread.
 */
function rankStudy(subset, projs, minG = 20) {
  const byHitter = new Map();
  for (let i = 0; i < subset.length; i++) {
    const r = subset[i];
    const key = `${r.d.slice(0, 4)}:${r.id}`;
    if (!byHitter.has(key)) byHitter.set(key, []);
    byHitter.get(key).push(i);
  }
  console.log(`
=== ranking power, ${byHitter.size} hitter-seasons (>= ${minG} starts counted) ===`);
  console.log('  market    hitters  corr(proj,actual) across hitters   ceiling   share   slope   sd(proj) sd(true)  |  within-hitter beta   per-game corr');
  for (const [m, spec] of Object.entries(MARKETS)) {
    if (m === 'pa') continue;
    const P = [], A = [], G = [], NOISE = [];
    const wP = [], wD = [], wA = [];
    for (const idx of byHitter.values()) {
      const use = idx.filter((i) => Number.isFinite(projs[i][spec.proj]) && Number.isFinite(subset[i].actual[m]));
      if (use.length < minG) continue;
      const mp = mean(use.map((i) => projs[i][spec.proj]));
      const ma = mean(use.map((i) => subset[i].actual[m]));
      // Within-hitter outcome variance, which is what makes his mean noisy.
      const v = mean(use.map((i) => (subset[i].actual[m] - ma) ** 2)) * (use.length / (use.length - 1));
      P.push(mp); A.push(ma); G.push(use.length); NOISE.push(v / use.length);
      for (const i of use) { wP.push(mp); wD.push(projs[i][spec.proj] - mp); wA.push(subset[i].actual[m]); }
    }
    if (P.length < 30) continue;
    const mP = mean(P), mA = mean(A);
    const vP = mean(P.map((x) => (x - mP) ** 2));
    const vA = mean(A.map((x) => (x - mA) ** 2));
    const cov = mean(P.map((x, i) => (x - mP) * (A[i] - mA)));
    const corr = Math.sqrt(vP * vA) ? cov / Math.sqrt(vP * vA) : 0;
    // Observed spread of the means minus the sampling noise in them.
    const vTrue = Math.max(1e-12, vA - mean(NOISE));
    const ceiling = Math.sqrt(vTrue / vA);
    // Two-variable regression of the outcome on the hitter axis and the
    // context axis. They are orthogonal by construction (the deviation sums to
    // zero within each hitter), so the two slopes are simple ratios.
    const mwP = mean(wP), mwA = mean(wA);
    const bH = mean(wP.map((x, i) => (x - mwP) * (wA[i] - mwA))) / mean(wP.map((x) => (x - mwP) ** 2));
    const vD = mean(wD.map((x) => x * x));
    const bC = vD ? mean(wD.map((x, i) => x * (wA[i] - mwA))) / vD : 0;
    const sdD = Math.sqrt(vD);
    const sdWA = Math.sqrt(mean(wA.map((x) => (x - mwA) ** 2)));
    const pg = mean(wP.map((x, i) => (x + wD[i] - mwP) * (wA[i] - mwA)))
      / (Math.sqrt(mean(wP.map((x, i) => (x + wD[i] - mwP) ** 2))) * sdWA);
    console.log(
      `  ${m.padEnd(8)} ${String(P.length).padStart(7)}  ${corr.toFixed(3).padStart(17)}`
      + `  ${ceiling.toFixed(3).padStart(8)}  ${(corr / ceiling).toFixed(2).padStart(5)}`
      + `  ${(cov / vP).toFixed(2).padStart(6)}  ${Math.sqrt(vP).toFixed(3).padStart(8)} ${Math.sqrt(vTrue).toFixed(3).padStart(8)}`
      + `  |  hitter ${bH.toFixed(2).padStart(5)} context ${bC.toFixed(2).padStart(6)} (sd ${sdD.toFixed(3)})`
      + `  ${pg.toFixed(3).padStart(6)}`,
    );
  }
}

/**
 * WHERE THE PROJECTION'S SPREAD COMES FROM, AND WHICH PART OF IT IS REAL.
 *
 * The projection for one batter-game is made of three things that can be
 * separated exactly, by re-projecting the same row with the context terms
 * switched off:
 *
 *   hitter   his own mean projection over the season, with park and the
 *            opposing starter neutral — who he is;
 *   slot     the rest of the context-free projection, i.e. the lineup slot
 *            and the side, which move his plate appearances;
 *   context  what the park and the opposing starter add on top.
 *
 * Regressing the outcome on all three at once gives each a coefficient. One
 * means that axis is scaled correctly; below one means the model spreads it
 * too far; above one means too narrowly. The three are not orthogonal, so this
 * is a real three-variable least squares, solved by Gaussian elimination on
 * the 3x3 normal equations.
 */
function contextStudy(subset, projs) {
  const NOCTX = { parkStrength: 0, pitcherInfluence: 0 };
  const plain = subset.map((r) => projectBatter({ ...r.input, tuning: { ...(r.tuning || {}), ...NOCTX } }));
  const byHitter = new Map();
  for (let i = 0; i < subset.length; i++) {
    const key = `${subset[i].d.slice(0, 4)}:${subset[i].id}`;
    if (!byHitter.has(key)) byHitter.set(key, []);
    byHitter.get(key).push(i);
  }
  console.log(`\n=== where the spread comes from (coefficient 1 = that axis is scaled right) ===`);
  console.log('  market     hitter axis        slot axis          park+starter axis');
  for (const [m, spec] of Object.entries(MARKETS)) {
    if (m === 'pa') continue;
    const X = [[], [], []], Y = [];
    for (const idx of byHitter.values()) {
      const use = idx.filter((i) => Number.isFinite(projs[i][spec.proj]) && Number.isFinite(plain[i][spec.proj]));
      if (use.length < 20) continue;
      const mh = mean(use.map((i) => plain[i][spec.proj]));
      for (const i of use) {
        X[0].push(mh);
        X[1].push(plain[i][spec.proj] - mh);
        X[2].push(projs[i][spec.proj] - plain[i][spec.proj]);
        Y.push(subset[i].actual[m]);
      }
    }
    if (Y.length < 1000) continue;
    const mu = X.map((x) => mean(x));
    const my = mean(Y);
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      for (let c = 0; c < 3; c++) A[a][c] = mean(X[a].map((x, i) => (x - mu[a]) * (X[c][i] - mu[c])));
      b[a] = mean(X[a].map((x, i) => (x - mu[a]) * (Y[i] - my)));
    }
    // Gaussian elimination with partial pivoting on a 3x3.
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (!M[c][c]) continue;
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
      }
    }
    const beta = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
    const sd = [0, 1, 2].map((a) => Math.sqrt(A[a][a]));
    console.log(
      `  ${m.padEnd(8)} ` + [0, 1, 2].map((a) => `${beta[a].toFixed(2).padStart(6)} (sd ${sd[a].toFixed(3)})`).join('   '),
    );
  }
}

/**
 * ORACLE CEILING. Replaces the projection with the hitter's OWN full-season
 * rate for that season times the model's own plate-appearance mean. That uses
 * the rest of the season, so it is lookahead and can never ship — it exists
 * only to say how much ranking power is available at all, which is the
 * question "could any projection rank these hitters?".
 */
function oracleProjections(subset, projs) {
  const tot = new Map();
  for (const r of subset) {
    const k = `${r.d.slice(0, 4)}:${r.id}`;
    const t = tot.get(k) || { pa: 0, hits: 0, tb: 0, hr: 0, rbi: 0, runs: 0, hrr: 0, k: 0, singles: 0, sb: 0, g: 0 };
    t.pa += r.actual.pa; t.g += 1;
    for (const m of ['hits', 'tb', 'hr', 'rbi', 'runs', 'hrr', 'k', 'singles', 'sb']) t[m] += r.actual[m];
    tot.set(k, t);
  }
  return subset.map((r, i) => {
    const t = tot.get(`${r.d.slice(0, 4)}:${r.id}`);
    const pa = projs[i].pa;
    const o = {};
    for (const [m, spec] of Object.entries(MARKETS)) {
      if (m === 'pa') continue;
      // Stolen bases are per GAME in the model, so the oracle is per game too.
      o[spec.proj] = m === 'sb' ? t.sb / t.g : (t.pa ? (t[m] / t.pa) * pa : projs[i][spec.proj]);
    }
    o.dist = projs[i].dist;   // only the point projection is being scored
    return o;
  });
}

/**
 * K-FOLD CROSS-VALIDATION WITHIN THE FIT WINDOW, GROUPED BY HITTER.
 *
 * The September holdout is spent (docs/BATTER-CALIBRATION-FIX.md looked at
 * it), so a number that is honest about out-of-sample behaviour has to come
 * from somewhere else. This is the second of the two ways to get one: split
 * the fit window K ways, pick the best setting on K-1 folds and score it on
 * the one left out, K times, and report the average of the K held-out scores.
 *
 * THE FOLDS ARE BY HITTER, not by row or by date. The same hitter appears in
 * 150 rows of a season; splitting rows at random would put his April in the
 * training fold and his May in the test fold, and the thing being fitted is a
 * property OF THE HITTER, so that would leak. Every row of a hitter-season
 * lands in the same fold.
 *
 * What it reports per grid entry is the mean held-out score. The setting with
 * the best cross-validated score is the one to take; the in-sample score of
 * that same setting is printed beside it, and the gap between them is the
 * optimism this exists to measure.
 */
function crossValidate(subset, grid, k, objective) {
  const foldOf = new Map();
  let next = 0;
  const fold = subset.map((r) => {
    const key = `${r.d.slice(0, 4)}:${r.id}`;
    if (!foldOf.has(key)) foldOf.set(key, next++ % k);
    return foldOf.get(key);
  });
  console.log(`\n=== ${k}-fold cross-validation inside the fit window, folds grouped by hitter (${foldOf.size} hitter-seasons) ===`);
  console.log(`  objective: ${objective}`);
  console.log(`  ${'setting'.padEnd(26)} ${'held out'.padStart(11)} ${'in sample'.padStart(11)} ${'optimism'.padStart(9)}   per-fold held out`);
  const rank = [];
  for (const cfg of grid) {
    const { label = JSON.stringify(cfg), ...tuning } = cfg;
    const projs = subset.map((r) => projectBatter(Object.keys(tuning).length ? { ...r.input, tuning } : r.input));
    const score = (idx) => {
      const s = scoreRows(idx.map((i) => subset[i]), idx.map((i) => projs[i]));
      if (objective === 'paGap') return Math.abs(s.pa ? s.pa.gap : 0);
      if (objective === 'logLoss') return Object.entries(s).reduce((a, [m, r]) => a + (m === 'pa' ? 0 : r.logLoss), 0);
      // Default: the size of the calibration gap the defect is measured in,
      // summed over the markets it lives in, so one cannot be bought with
      // another.
      return ['hits', 'tb', 'runs', 'rbi', 'hrr', 'singles', 'k']
        .reduce((a, m) => a + (s[m] ? Math.abs(s[m].gap) : 0), 0);
    };
    const all = subset.map((_, i) => i);
    const per = [];
    for (let f = 0; f < k; f++) per.push(score(all.filter((i) => fold[i] === f)));
    const held = mean(per);
    const ins = score(all);
    rank.push([held, label]);
    console.log(
      `  ${label.padEnd(26)} ${held.toFixed(5).padStart(11)} ${ins.toFixed(5).padStart(11)} `
      + `${(held - ins).toFixed(5).padStart(9)}   ${per.map((x) => x.toFixed(4)).join(' ')}`,
    );
  }
  rank.sort((a, b) => a[0] - b[0]);
  console.log(`  BEST held out: ${rank[0][1]} (${rank[0][0].toFixed(5)})`);
}

// ── run ─────────────────────────────────────────────────────────────────────
const GRID = JSON.parse(arg('grid', '[{"label":"shipped"}]'));
const MARKETS_SHOWN = (arg('markets', 'hits,tb,singles,runs,hrr,rbi,hr,k') || '').split(',');
const ORACLE = has('oracle');
const results = {};

for (const [wname, inWindow] of WINDOWS) {
  const subset = rows.filter(inWindow);
  if (!subset.length) continue;
  console.log(`\n########## ${wname} (${subset.length} batter-games) ##########`);
  if (has('book-table')) { bookTable(subset); continue; }
  if (has('duty-fit')) {
    if (wname === 'FIT') dutyFit(subset, JSON.parse(arg('duty-fit', 'null')) || [
      { lo: 2, hi: 3.9, priorGames: 10 },
    ]);
    continue;
  }
  if (has('cv')) {
    if (wname === 'FIT') crossValidate(subset, GRID, Number(arg('cv', '5')), arg('objective', 'gap'));
    continue;
  }
  for (const cfg of GRID) {
    const { label = JSON.stringify(cfg), ...tuning } = cfg;
    const projs = subset.map((r) => projectBatter(Object.keys(tuning).length ? { ...r.input, tuning } : r.input));
    const sets = [['all', subset.map((_, i) => i)]];
    for (const [gname, fn] of Object.entries(GROUPS)) {
      sets.push([gname, subset.map((_, i) => i).filter((i) => fn(subset[i]))]);
    }
    for (const [gname, idx] of sets) {
      const gs = idx.map((i) => subset[i]);
      const gp = idx.map((i) => projs[i]);
      const s = scoreRows(gs, gp);
      results[`${wname}|${label}|${gname}`] = s;
      // The objective docs/BATTER-EDGE-SEARCH.md fitted on: log loss summed
      // over the nine markets, so one market cannot be bought with another.
      const total = Object.entries(s).reduce((a, [m, r]) => a + (m === 'pa' ? 0 : r.logLoss), 0);
      console.log(`  ${label.padEnd(18)} ${gname.padEnd(17)} ${'TOTAL'.padEnd(8)} n=${String(gs.length).padStart(6)}  log loss over the nine markets ${total.toFixed(5)}`);
      for (const m of MARKETS_SHOWN) {
        const r = s[m];
        if (!r) continue;
        console.log(
          `  ${label.padEnd(18)} ${gname.padEnd(17)} ${m.padEnd(8)} n=${String(r.n).padStart(6)}`
          + `  gap ${(100 * r.gap >= 0 ? '+' : '')}${(100 * r.gap).toFixed(2)}pts`
          + `  ll ${r.logLoss.toFixed(5)}  brier ${r.brier.toFixed(5)}`
          + `  proj ${r.meanProj.toFixed(3)} act ${r.meanActual.toFixed(3)}`
          + `  MAE ${r.mae.toFixed(4)} vs ${r.naiveMae.toFixed(4)}`
          + `  corr ${r.corr.toFixed(3)}  slope ${r.slope.toFixed(2)}  sd ${r.sdProj.toFixed(3)}`,
        );
      }
      if (has('duty-table') && gname === 'all') dutyTable(gs, gp);
      if (has('slot-study') && gname === 'all') slotStudy(gs, gp, tuning);
      if (has('rank-study') && gname === 'all') {
        rankStudy(gs, gp);
        contextStudy(gs, gp);
        const og = oracleProjections(gs, gp);
        console.log('  -- the same table for the ORACLE: each hitter’s own full-season rate, lookahead, cannot ship --');
        rankStudy(gs, og);
      }
      if (ORACLE && gname === 'all') {
        const os = scoreRows(gs, oracleProjections(gs, gp));
        for (const m of MARKETS_SHOWN) {
          const r = os[m];
          if (!r) continue;
          console.log(
            `  ${'ORACLE (lookahead)'.padEnd(18)} ${gname.padEnd(17)} ${m.padEnd(8)} n=${String(r.n).padStart(6)}`
            + `  ${' '.repeat(36)}  proj ${r.meanProj.toFixed(3)} act ${r.meanActual.toFixed(3)}`
            + `  MAE ${r.mae.toFixed(4)} vs ${r.naiveMae.toFixed(4)}`
            + `  corr ${r.corr.toFixed(3)}  slope ${r.slope.toFixed(2)}  sd ${r.sdProj.toFixed(3)}`,
          );
        }
      }
    }
  }
}

const JSON_OUT = arg('json', null);
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
  process.stderr.write(`wrote ${JSON_OUT}\n`);
}
