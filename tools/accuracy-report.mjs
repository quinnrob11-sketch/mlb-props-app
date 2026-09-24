// Score the shipped projections against what actually happened.
//
//   node tools/accuracy-report.mjs .backtest-cache/acc_*.ndjson \
//     [--holdout 2026-09-02] [--json out.json] [--slices] [--bins]
//
// Reads the records `tools/accuracy-extract.mjs` writes and reports, per
// market:
//
//   CALIBRATION  every quoted probability bucketed, against the frequency the
//                thing actually happened, with a Wilson interval on the
//                observed side and a cluster bootstrap (over games) on the
//                pooled gap. A projection that says 60% should happen 60% of
//                the time.
//   SHARPNESS    the spread of the projections themselves. A model that says
//                50% to everything is perfectly calibrated and useless.
//   ERROR        mean absolute error and bias of the POINT projection against
//                the actual count, plus the correlation that says whether it
//                ranks players at all, and the MAE of the naive alternative
//                (always projecting the market's own mean) for scale.
//
// Nothing here reads a price. The comparison is against the box score.

import fs from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const HOLDOUT_FROM = arg('holdout', '2026-09-02');
const HOLDOUT_TO = arg('holdout-to', '2026-09-22');
const JSON_OUT = arg('json', null);

const files = process.argv.slice(2).filter((a) => a.endsWith('.ndjson'));
if (!files.length) throw new Error('give at least one .ndjson file');

const rows = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
}
process.stderr.write(`${rows.length} records from ${files.length} files\n`);

// ── statistics ──────────────────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Wilson score interval for a binomial proportion. */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

/**
 * Cluster bootstrap over games. Several contracts on one game are not
 * independent, so the resample takes whole games. `stat` receives the list of
 * items in the resample.
 */
function clusterBoot(items, keyOf, stat, B = 600) {
  const byKey = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  const clusters = [...byKey.values()];
  const out = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[(Math.random() * clusters.length) | 0];
      for (const it of c) sample.push(it);
    }
    const v = stat(sample);
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : [NaN, NaN];
}

/**
 * Calibration of a list of {p, y, g} pairs.
 *   bins   fixed-width buckets with at least `minN` pairs, merged upward
 *   ece    n-weighted mean |predicted - observed|, in percentage points
 *   gap    mean(p) - mean(y): + means the model quotes too high
 */
function calibrate(pairs, width = 0.1, minN = 60) {
  const nb = Math.round(1 / width);
  const raw = Array.from({ length: nb }, () => []);
  for (const q of pairs) raw[Math.min(nb - 1, Math.floor(q.p / width))].push(q);
  // Merge thin buckets into their neighbour above so every reported bin has n.
  const bins = [];
  let carry = [];
  for (let i = 0; i < nb; i++) {
    carry = carry.concat(raw[i]);
    const isLast = i === nb - 1;
    if (carry.length >= minN || (isLast && carry.length)) {
      bins.push({ lo: bins.length ? bins.at(-1).hi : 0, hi: isLast ? 1 : (i + 1) * width, items: carry });
      carry = [];
    }
  }
  if (carry.length && bins.length) { bins.at(-1).items = bins.at(-1).items.concat(carry); bins.at(-1).hi = 1; }
  const table = bins.map((b) => {
    const k = b.items.reduce((a, q) => a + q.y, 0);
    const n = b.items.length;
    const [lo, hi] = wilson(k, n);
    const pred = mean(b.items.map((q) => q.p));
    return { lo: b.lo, hi: b.hi, n, pred, obs: k / n, ci: [lo, hi], gap: pred - k / n, off: pred < lo || pred > hi };
  });
  const N = pairs.length;
  const ece = table.reduce((a, t) => a + (t.n / N) * Math.abs(t.gap), 0);
  // A bucket with a handful of pairs is noise, not a miscalibration.
  const worst = table.filter((t) => t.n >= 200).reduce((a, t) => (Math.abs(t.gap) > Math.abs(a) ? t.gap : a), 0);
  const mp = mean(pairs.map((q) => q.p));
  // Sharpness: how far the quotes move off the base rate. A market the model
  // has no opinion about is calibrated and useless.
  const sdP = Math.sqrt(mean(pairs.map((q) => (q.p - mp) ** 2)));
  let rlo = 1, rhi = 0;
  for (const q of pairs) { if (q.p < rlo) rlo = q.p; if (q.p > rhi) rhi = q.p; }
  const range = [rlo, rhi];
  return { n: N, table, ece, worst, sdP, range, gap: mp - mean(pairs.map((q) => q.y)) };
}

/**
 * RANKING POWER, with the ceiling.
 *
 * `--rank`. The MAE column beside these tables is NOT a ranking metric and
 * must not be read as one. Mean absolute error on a count whose mass sits on
 * zero and one is not minimised at the conditional mean, so a projection can
 * beat the honest one by being wrong in a fixed direction:
 * `docs/BATTER-CALIBRATION-FIX.md` measured total bases projected 20% LOW
 * beating the shipped projection by 5% of MAE and the slate average by 7%.
 * `--scale` below reproduces that table. A metric that pays for a lean cannot
 * say whether a projection ranks.
 *
 * What does say it: the correlation between a player's mean projection and his
 * mean realised production, across players — and, beside it, the highest
 * correlation ANY projection could score against that same target.
 *
 * The target is measured on finitely many games, so it carries sampling noise.
 * For entity j with n_j games, the within-entity outcome variance (Bessel
 * corrected) divided by n_j is the noise in his own mean. Subtract the average
 * of that from the observed variance of the means and what is left is the
 * variance of true ability:
 *
 *     vTrue   = var(ma) - mean(v_j / n_j)
 *     ceiling = sqrt(vTrue / var(ma))
 *
 * A share at or above 1.00 does not mean the model beat the truth; it means
 * the ceiling is an estimate and this one is slightly conservative. The
 * ceiling is also generous in the other direction: it is the ceiling against a
 * NOISY target, not against ability itself.
 *
 * The estimator is `rankStudy()` from `tools/batter-thin-fit.mjs`, lifted here
 * unchanged so pitchers and hitters are scored by the same function.
 */
function rankStudy(items, keyOf, minG) {
  const byKey = new Map();
  for (const it of items) {
    if (!Number.isFinite(it.proj) || !Number.isFinite(it.act)) continue;
    const k = keyOf(it);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  const groups = [...byKey.values()].filter((g) => g.length >= minG);
  if (groups.length < 8) return null;
  const mp = [], ma = [], noise = [];
  for (const g of groups) {
    const n = g.length;
    const p = mean(g.map((x) => x.proj));
    const a = mean(g.map((x) => x.act));
    const v = (mean(g.map((x) => (x.act - a) ** 2)) * n) / (n - 1);
    mp.push(p);
    ma.push(a);
    noise.push(v / n);
  }
  const stat = (idx) => {
    const P = idx.map((i) => mp[i]);
    const A = idx.map((i) => ma[i]);
    const N = idx.map((i) => noise[i]);
    const bp = mean(P), ba = mean(A);
    const vP = mean(P.map((x) => (x - bp) ** 2));
    const vA = mean(A.map((x) => (x - ba) ** 2));
    const cov = mean(P.map((x, i) => (x - bp) * (A[i] - ba)));
    const corr = vP && vA ? cov / Math.sqrt(vP * vA) : NaN;
    const vTrue = Math.max(1e-12, vA - mean(N));
    const ceiling = vA ? Math.sqrt(vTrue / vA) : NaN;
    return { corr, ceiling, share: corr / ceiling, slope: vP ? cov / vP : NaN, sdModel: Math.sqrt(vP), sdTrue: Math.sqrt(vTrue) };
  };
  const all = Array.from({ length: groups.length }, (_, i) => i);
  const base = stat(all);
  // Bootstrap over ENTITIES: one pitcher's starts are not independent draws.
  const cs = [], ss = [];
  for (let b = 0; b < 600; b++) {
    const idx = all.map(() => (Math.random() * all.length) | 0);
    const s = stat(idx);
    if (Number.isFinite(s.corr)) cs.push(s.corr);
    if (Number.isFinite(s.share)) ss.push(s.share);
  }
  cs.sort((a, b) => a - b);
  ss.sort((a, b) => a - b);
  const q = (xs) => (xs.length ? [xs[Math.floor(0.025 * xs.length)], xs[Math.floor(0.975 * xs.length)]] : [NaN, NaN]);
  return { ...base, entities: groups.length, games: groups.reduce((a, g) => a + g.length, 0), corrCi: q(cs), shareCi: q(ss) };
}

/**
 * `--scale`. The demonstration that MAE against the slate average is not a
 * ranking metric: multiply every projection by a constant and score it. If a
 * constant other than 1.0 wins, the metric is paying for a lean.
 */
const SCALES = [0.8, 0.9, 1.0, 1.05, 1.1, 1.2];

/** Point-projection error. `naive` is the MAE of always saying the mean. */
function pointError(items) {
  const p = items.map((x) => x.proj);
  const a = items.map((x) => x.act);
  const mp = mean(p), ma = mean(a);
  const sdp = Math.sqrt(mean(p.map((x) => (x - mp) ** 2)));
  const sda = Math.sqrt(mean(a.map((x) => (x - ma) ** 2)));
  const cov = mean(p.map((x, i) => (x - mp) * (a[i] - ma)));
  return {
    n: items.length,
    meanProj: mp,
    meanActual: ma,
    bias: ma - mp,
    biasPct: mp ? (100 * (ma - mp)) / mp : null,
    mae: mean(p.map((x, i) => Math.abs(x - a[i]))),
    rmse: Math.sqrt(mean(p.map((x, i) => (x - a[i]) ** 2))),
    naiveMae: mean(a.map((x) => Math.abs(x - ma))),
    sdProj: sdp,
    sdActual: sda,
    corr: sdp && sda ? cov / (sdp * sda) : null,
    slope: sdp ? cov / (sdp * sdp) : null,
  };
}

// ── market definitions ──────────────────────────────────────────────────────
const PITCHER_LINES = {
  k: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
  outs: [11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5],
  hits: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  bb: [0.5, 1.5, 2.5, 3.5],
  er: [0.5, 1.5, 2.5, 3.5, 4.5],
};
const BATTER_LINES = {
  hits: [0.5, 1.5, 2.5],
  tb: [0.5, 1.5, 2.5, 3.5, 4.5],
  hr: [0.5, 1.5],
  rbi: [0.5, 1.5, 2.5],
  hrr: [0.5, 1.5, 2.5, 3.5, 4.5],
  runs: [0.5, 1.5],
  k: [0.5, 1.5, 2.5],
  singles: [0.5, 1.5],
  sb: [0.5],
};
const TOTAL_LINES = [6.5, 7.5, 8.5, 9.5, 10.5];
/**
 * The run line is recorded as `spread(point).home` for points -1.5 and +1.5.
 * "Home covers -1.5" is `margin + (-1.5) > 0`, i.e. margin > +1.5, so the
 * THRESHOLD the outcome is compared against is the negated point. Keeping the
 * two straight matters: swapping them turns a calibrated market into a
 * perfectly inverted one.
 */
const SPREAD_THRESHOLDS = [1.5, -1.5];
const SPREAD_NAMES = ['home -1.5', 'home +1.5'];

/** The same two, over the first five innings. Negated points, as above. */
const F5_TOTAL_LINES = [3.5, 4.5, 5.5, 6.5];
const F5_SPREAD_THRESHOLDS = [0.5, -0.5, 1.5, -1.5];
const F5_SPREAD_NAMES = ['F5 home -0.5', 'F5 home +0.5', 'F5 home -1.5', 'F5 home +1.5'];

const LABEL = {
  'P k': 'pitcher strikeouts', 'P outs': 'pitcher outs recorded', 'P hits': 'pitcher hits allowed',
  'P bb': 'pitcher walks', 'P er': 'pitcher earned runs',
  'B hits': 'batter hits', 'B tb': 'batter total bases', 'B hr': 'batter home runs',
  'B rbi': 'batter RBIs', 'B hrr': 'batter hits+runs+RBIs', 'B runs': 'batter runs',
  'B k': 'batter strikeouts', 'B singles': 'batter singles', 'B sb': 'batter stolen bases',
  'G ml': 'moneyline (home win)', 'G tot': 'game total (over)', 'G mar': 'run line (home)',
  'G nrfi': 'first inning (NRFI)',
  'F5 ml': 'F5 moneyline (home leads, ties out)', 'F5 tie': 'F5 level after five',
  'F5 tot': 'F5 total (over)', 'F5 mar': 'F5 run line (home)',
};

/**
 * One market's pairs and point-projection items from a set of records.
 * Records whose projection is null (a pitcher with no prior line at all, a
 * hitter with no history) are counted separately, not silently dropped.
 */
function collect(recs) {
  const out = new Map(); // market -> { pairs, points, lines: Map(line -> pairs), missing }
  const get = (m) => {
    if (!out.has(m)) out.set(m, { pairs: [], points: [], lines: new Map(), missing: 0, n: 0 });
    return out.get(m);
  };
  // `who` is the entity a point projection belongs to — a pitcher-season or a
  // hitter-season — which `--rank` groups by. Nothing else reads it.
  const add = (m, lines, entry, g, names = null, who = null) => {
    const s = get(m);
    s.n++;
    const [proj, act, ps] = entry;
    if (proj == null || act == null || ps.some((p) => p == null)) { s.missing++; return; }
    s.points.push({ proj, act, g, who });
    lines.forEach((l, i) => {
      const q = { p: ps[i], y: act > l ? 1 : 0, g };
      s.pairs.push(q);
      const name = names ? names[i] : l;
      if (!s.lines.has(name)) s.lines.set(name, []);
      s.lines.get(name).push(q);
    });
  };
  for (const r of recs) {
    const who = r.id != null && r.d ? `${r.d.slice(0, 4)}:${r.id}` : null;
    if (r.t === 'p') for (const [m, lines] of Object.entries(PITCHER_LINES)) add(`P ${m}`, lines, r.m[m], r.g, null, who);
    else if (r.t === 'b') for (const [m, lines] of Object.entries(BATTER_LINES)) add(`B ${m}`, lines, r.m[m], r.g, null, who);
    else if (r.t === 'g') {
      const ml = get('G ml');
      ml.n++;
      ml.pairs.push({ p: r.ml[0], y: r.ml[1], g: r.g });
      ml.lines.set('home win', (ml.lines.get('home win') || []).concat([{ p: r.ml[0], y: r.ml[1], g: r.g }]));
      add('G tot', TOTAL_LINES, r.tot, r.g);
      add('G mar', SPREAD_THRESHOLDS, r.mar, r.g, SPREAD_NAMES);
      if (r.nrfi) {
        const s = get('G nrfi');
        s.n++;
        const q = { p: r.nrfi[0], y: r.nrfi[1], g: r.g };
        s.pairs.push(q);
        s.lines.set('no run', (s.lines.get('no run') || []).concat([q]));
      }
      // First five innings. `f5ml` is null on a game that ended five level —
      // the market pushes there and the model's number is conditional on no
      // tie — so the tie is scored on its own line instead of being dropped.
      for (const [market, field, name] of [['F5 ml', 'f5ml', 'home leads'], ['F5 tie', 'f5tie', 'level']]) {
        if (!r[field]) continue;
        const s = get(market);
        s.n++;
        const q = { p: r[field][0], y: r[field][1], g: r.g };
        if (q.p == null) { s.missing++; continue; }
        s.pairs.push(q);
        s.lines.set(name, (s.lines.get(name) || []).concat([q]));
      }
      if (r.f5tot) add('F5 tot', F5_TOTAL_LINES, r.f5tot, r.g);
      if (r.f5mar) add('F5 mar', F5_SPREAD_THRESHOLDS, r.f5mar, r.g, F5_SPREAD_NAMES);
    }
  }
  return out;
}

function score(recs) {
  const collected = collect(recs);
  const report = {};
  for (const [m, s] of collected) {
    if (!s.pairs.length) continue;
    const cal = calibrate(s.pairs);
    // The resample cost is linear in the number of pairs, so the big markets
    // get fewer draws. 150 is enough for a 95% interval read to a tenth.
    const B = s.pairs.length > 120000 ? 150 : s.pairs.length > 40000 ? 300 : 600;
    const gapCi = clusterBoot(s.pairs, (q) => q.g, (xs) => mean(xs.map((q) => q.p)) - mean(xs.map((q) => q.y)), B);
    const eceCi = clusterBoot(s.pairs, (q) => q.g, (xs) => calibrate(xs).ece, Math.min(150, B));
    report[m] = {
      label: LABEL[m] || m,
      nEvents: s.n,
      missing: s.missing,
      calibration: { ...cal, gapCi, eceCi },
      brier: mean(s.pairs.map((q) => (q.p - q.y) ** 2)),
      brierBase: (() => { const b = mean(s.pairs.map((q) => q.y)); return mean(s.pairs.map((q) => (b - q.y) ** 2)); })(),
      perLine: [...s.lines].map(([l, ps]) => {
        const k = ps.reduce((a, q) => a + q.y, 0);
        const [lo, hi] = wilson(k, ps.length);
        const pred = mean(ps.map((q) => q.p));
        return { line: l, n: ps.length, pred, obs: k / ps.length, ci: [lo, hi], gap: pred - k / ps.length, off: pred < lo || pred > hi };
      }),
      point: s.points.length ? pointError(s.points) : null,
    };
  }
  return report;
}

// ── slices ──────────────────────────────────────────────────────────────────
const monthOf = (d) => d.slice(0, 7);
const SLICES = {
  p: {
    side: (r) => (r.h ? 'home' : 'away'),
    rest: (r) => (r.rest == null ? 'unknown' : r.rest <= 4 ? 'short (<=4d)' : r.rest === 5 ? 'normal (5d)' : r.rest <= 7 ? 'long (6-7d)' : 'very long (8d+)'),
    sample: (r) => (r.ns <= 3 ? 'thin (<=3 prior starts)' : r.ns <= 10 ? 'building (4-10)' : 'established (11+)'),
    length: (r) => (r.ip == null ? 'none' : r.ip < 4.5 ? 'short outing projected (<4.5 IP)' : r.ip < 5.5 ? 'mid (4.5-5.5)' : 'full (5.5+)'),
    /**
     * The population the shipped model put him in (docs/OPENER-FIX.md). This
     * is the honest cut for "are openers still unreliable?": `p.length` cuts
     * on the model's own projected depth, which the role split CHANGED, so a
     * before/after on `p.length` is partly a different set of starts.
     */
    role: (r) => (r.role == null ? 'unreadable log' : r.role),
    /** Role crossed with projected depth: the cell the old document named. */
    roleshort: (r) => `${r.role ?? 'unreadable'} / ${r.ip == null ? 'none' : r.ip < 4.5 ? 'short (<4.5 IP)' : 'longer (4.5+)'}`,
    /** Layoff as the rest term itself reads it: days to his previous START. */
    layoff: (r) => (r.rd == null ? 'unknown' : r.rd <= 5 ? 'normal (<=5d)' : r.rd <= 7 ? 'six or seven' : r.rd <= 9 ? 'eight or nine' : r.rd <= 14 ? 'ten to fourteen' : 'fifteen or more'),
    month: (r) => monthOf(r.d),
    season: (r) => r.d.slice(0, 4),
  },
  b: {
    slot: (r) => (r.slot <= 3 ? 'top (1-3)' : r.slot <= 6 ? 'middle (4-6)' : 'bottom (7-9)'),
    side: (r) => (r.h ? 'home' : 'away'),
    sample: (r) => (r.pa26 < 50 ? 'thin (<50 PA this season)' : r.pa26 < 200 ? 'building (50-199)' : 'established (200+)'),
    card: (r) => (r.ps == null ? 'no previous card' : r.ps === r.slot ? 'slot as projected' : 'slot moved'),
    month: (r) => monthOf(r.d),
    season: (r) => r.d.slice(0, 4),
  },
  g: {
    probables: (r) => (r.bs ? 'both starters known' : 'a starter missing'),
    lineups: (r) => (r.lu ? 'both cards posted' : 'a card missing'),
    month: (r) => monthOf(r.d),
    season: (r) => r.d.slice(0, 4),
    projtotal: (r) => projBucket(r.tot[0]),
    starters: (r) => starterBucket(r),
  },
};

// ── where the run environment comes from ────────────────────────────────────
// A total that is right on average can still be wrong at the ends, and the
// ends are where the board disagrees with a price. These two cut the games by
// what the model itself said about them, so a gap can be traced to the part
// of the projection that produced it.

/** The half-run band the model put the game in. */
export function projBucket(t) {
  if (t == null) return 'unknown';
  if (t < 7.5) return 'a  proj < 7.5';
  if (t < 8.0) return 'b  proj 7.5-8.0';
  if (t < 8.5) return 'c  proj 8.0-8.5';
  if (t < 9.0) return 'd  proj 8.5-9.0';
  if (t < 9.5) return 'e  proj 9.0-9.5';
  if (t < 10.0) return 'f  proj 9.5-10.0';
  return 'g  proj 10.0+';
}

/**
 * How good the two starters are, as the model reads them. `sp` is a
 * run-prevention index against league average, so BELOW one is better than
 * league; the pair is summarised by its mean. "Low totals usually mean two
 * strong starters" is exactly this slice.
 */
export function starterBucket(r) {
  const sp = r.sp;
  if (!sp || sp[0] == null || sp[1] == null) return 'unknown';
  const m = (sp[0] + sp[1]) / 2;
  if (m < 0.88) return 'a  two strong starters (<0.88)';
  if (m < 0.96) return 'b  above average (0.88-0.96)';
  if (m < 1.04) return 'c  around league (0.96-1.04)';
  if (m < 1.12) return 'd  below average (1.04-1.12)';
  return 'e  two weak starters (1.12+)';
}

function sliceReport(recs, t, name) {
  const fn = SLICES[t][name];
  const groups = new Map();
  for (const r of recs) {
    if (r.t !== t) continue;
    const k = fn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = {};
  for (const [k, list] of [...groups].sort()) {
    if (list.length < 120) continue;
    const s = collect(list);
    out[k] = {};
    for (const [m, v] of s) {
      if (v.pairs.length < 200) continue;
      const cal = calibrate(v.pairs, 0.1, 120);
      out[k][m] = {
        n: v.points.length || v.pairs.length,
        ece: cal.ece,
        gap: cal.gap,
        mae: v.points.length ? mean(v.points.map((x) => Math.abs(x.proj - x.act))) : null,
        bias: v.points.length ? mean(v.points.map((x) => x.act - x.proj)) : null,
      };
    }
  }
  return out;
}

/** Parks with the biggest calibration gap, for the markets that have a park. */
function parkReport(recs, t, market, lines, minN = 400) {
  const byPark = new Map();
  for (const r of recs) {
    if (r.t !== t) continue;
    if (!byPark.has(r.pk)) byPark.set(r.pk, []);
    byPark.get(r.pk).push(r);
  }
  const out = [];
  for (const [pk, list] of byPark) {
    const s = collect(list).get(market);
    if (!s || s.pairs.length < minN) continue;
    const cal = calibrate(s.pairs, 0.1, 100);
    out.push({
      park: pk,
      n: s.points.length,
      gap: cal.gap,
      ece: cal.ece,
      bias: s.points.length ? mean(s.points.map((x) => x.act - x.proj)) : null,
      mae: s.points.length ? mean(s.points.map((x) => Math.abs(x.proj - x.act))) : null,
    });
  }
  return out.sort((a, b) => b.bias - a.bias);
}

// ── the total, at the lines that get posted ─────────────────────────────────
/**
 * `--totals` answers a narrower question than the market tables above: is the
 * projected total centred on reality, and is its SHAPE right?
 *
 * The overall per-line row ("over 6.5 was quoted at 67.8% and happened 67.6%
 * of the time") is dominated by ordinary games, because almost every game
 * clears 6.5. What a 6.5 board actually asks is the conditional question:
 * among the games the model itself puts NEAR 6.5, how often did it go over?
 * Both are printed, plus the point projection bucketed by the band the model
 * put the game in, which is where a level error and a shape error separate:
 *
 *   level error  every band biased the same way
 *   shape error  the low bands biased one way and the high bands the other
 */
function totalsReport(recs, label) {
  const g = recs.filter((r) => r.t === 'g' && r.tot && r.tot[0] != null && r.tot[1] != null);
  if (!g.length) return null;
  console.log(`\n=== TOTALS: the run environment — ${label} (${g.length} games) ===`);

  const band = (list) => {
    const proj = mean(list.map((r) => r.tot[0]));
    const act = mean(list.map((r) => r.tot[1]));
    return { n: list.length, proj, act, bias: act - proj };
  };
  const all = band(g);
  console.log(
    `  overall   proj ${all.proj.toFixed(3)}  actual ${all.act.toFixed(3)}`
    + `  bias ${all.bias >= 0 ? '+' : ''}${all.bias.toFixed(3)} runs`,
  );

  // 1. Bucketed by what the model said.
  console.log('\n  by projected band   n     proj   actual    bias   [95% on the bias]');
  const byBand = new Map();
  for (const r of g) {
    const k = projBucket(r.tot[0]);
    if (!byBand.has(k)) byBand.set(k, []);
    byBand.get(k).push(r);
  }
  for (const [k, list] of [...byBand].sort()) {
    const b = band(list);
    const ci = clusterBoot(list, (r) => r.g, (xs) => mean(xs.map((x) => x.tot[1] - x.tot[0])), 400);
    console.log(
      `    ${k.padEnd(18)} ${String(b.n).padStart(5)}  ${b.proj.toFixed(2)}   ${b.act.toFixed(2)}`
      + `   ${b.bias >= 0 ? '+' : ''}${b.bias.toFixed(3)}   [${ci[0] >= 0 ? '+' : ''}${ci[0].toFixed(3)}, ${ci[1] >= 0 ? '+' : ''}${ci[1].toFixed(3)}]`,
    );
  }

  // 2. Bucketed by what happened, which catches a model whose projections are
  //    centred but do not MOVE with the games that were actually low or high.
  console.log('\n  by actual total     n     proj   actual    bias');
  const ACT = [[0, 5], [5, 7], [7, 9], [9, 11], [11, 14], [14, 99]];
  for (const [lo, hi] of ACT) {
    const list = g.filter((r) => r.tot[1] >= lo && r.tot[1] < hi);
    if (list.length < 30) continue;
    const b = band(list);
    console.log(
      `    ${`actual ${lo}-${hi - 1}`.padEnd(18)} ${String(b.n).padStart(5)}  ${b.proj.toFixed(2)}   ${b.act.toFixed(2)}`
      + `   ${b.bias >= 0 ? '+' : ''}${b.bias.toFixed(3)}`,
    );
  }

  // 3. The posted ladder, unconditionally and then on the games where that
  //    line is the one a book would hang.
  console.log('\n  line   ALL GAMES  n   pred -> obs   gap        NEAR THE LINE (|proj-line|<=0.75)  n   pred -> obs   gap');
  const perLine = [];
  TOTAL_LINES.forEach((L, i) => {
    const row = (list) => {
      if (!list.length) return null;
      const pred = mean(list.map((r) => r.tot[2][i]));
      const k = list.filter((r) => r.tot[1] > L).length;
      const [lo, hi] = wilson(k, list.length);
      return { n: list.length, pred, obs: k / list.length, ci: [lo, hi], off: pred < lo || pred > hi };
    };
    const a = row(g);
    const near = row(g.filter((r) => Math.abs(r.tot[0] - L) <= 0.75));
    perLine.push({ line: L, all: a, near });
    const fmt = (o) => (o
      ? `n=${String(o.n).padStart(5)}  ${(100 * o.pred).toFixed(1).padStart(5)} -> ${(100 * o.obs).toFixed(1).padStart(5)}`
        + `  ${pct(o.pred - o.obs).padStart(5)}pts${o.off ? ' *' : '  '}`
      : 'n=    0');
    console.log(`   ${String(L).padEnd(5)} ${fmt(a)}      ${fmt(near)}`);
  });

  // 4. The slice the board's disagreement lives in: the games the model itself
  //    calls low. If the over-lean is real it should show up here as an
  //    UNDER-projection, and if it is a bias, as an over-projection.
  console.log('\n  the low end, cumulatively (the games a 6.5-7.5 board is drawn from)');
  for (const cut of [7.0, 7.25, 7.5, 7.75, 8.0]) {
    const list = g.filter((r) => r.tot[0] < cut);
    if (list.length < 25) { console.log(`    proj < ${cut}   n=${list.length} (too few)`); continue; }
    const b = band(list);
    const ci = clusterBoot(list, (r) => r.g, (xs) => mean(xs.map((x) => x.tot[1] - x.tot[0])), 400);
    const o65 = mean(list.map((r) => r.tot[2][0]));
    const a65 = list.filter((r) => r.tot[1] > 6.5).length / list.length;
    const o75 = mean(list.map((r) => r.tot[2][1]));
    const a75 = list.filter((r) => r.tot[1] > 7.5).length / list.length;
    console.log(
      `    proj < ${cut}   n=${String(b.n).padStart(4)}  proj ${b.proj.toFixed(2)}  actual ${b.act.toFixed(2)}`
      + `  bias ${b.bias >= 0 ? '+' : ''}${b.bias.toFixed(3)} [${ci[0] >= 0 ? '+' : ''}${ci[0].toFixed(2)}, ${ci[1] >= 0 ? '+' : ''}${ci[1].toFixed(2)}]`
      + `   over6.5 ${(100 * o65).toFixed(1)}->${(100 * a65).toFixed(1)}`
      + `   over7.5 ${(100 * o75).toFixed(1)}->${(100 * a75).toFixed(1)}`,
    );
  }

  // 5. Does the projection move enough? Regressing what happened on what was
  //    projected: a slope above one means the model does not spread far
  //    enough and is too high at the bottom of its own range.
  const p = g.map((r) => r.tot[0]);
  const a = g.map((r) => r.tot[1]);
  const mp = mean(p);
  const ma = mean(a);
  const varP = mean(p.map((x) => (x - mp) ** 2));
  const cov = mean(p.map((x, i) => (x - mp) * (a[i] - ma)));
  const slope = cov / varP;
  const slopeCi = clusterBoot(g, (r) => r.g, (xs) => {
    const q = xs.map((r) => r.tot[0]);
    const y = xs.map((r) => r.tot[1]);
    const mq = mean(q);
    const my = mean(y);
    const v = mean(q.map((x) => (x - mq) ** 2));
    return v ? mean(q.map((x, i) => (x - mq) * (y[i] - my))) / v : NaN;
  }, 400);
  console.log(
    `\n  spread   sd(projected) ${Math.sqrt(varP).toFixed(3)} runs`
    + `   slope of actual on projected ${slope.toFixed(2)} [${slopeCi[0].toFixed(2)}, ${slopeCi[1].toFixed(2)}]`
    + `   (1.00 = the projection moves exactly as far as reality does)`,
  );
  const gam = amplification(g.map((r) => ({ mu: r.tot[0], y: r.tot[1] })));
  console.log(
    `  amplification   gamma ${gam.g.toFixed(2)} [${gam.lo.toFixed(2)}, ${gam.hi.toFixed(2)}]`
    + `   (mu' = L (mu/L)^gamma; above one = the model damps a signal it already has)`,
  );

  // 6. The width of the per-game distribution, which the tables above cannot
  //    see: they read each line against the whole field. Bucketing every
  //    (game, line) pair by how far the line sits from THAT game's own
  //    projection asks whether the distribution around the projection is the
  //    right size. Too narrow and the model quotes too few overs well above
  //    its projection and too many well below it.
  console.log('\n  line minus this game\'s projection    n      model -> actual    gap   [95% on actual]');
  const pairs = [];
  g.forEach((r) => TOTAL_LINES.forEach((L, i) => pairs.push({ d: L - r.tot[0], p: r.tot[2][i], y: r.tot[1] > L ? 1 : 0 })));
  const CUTS = [-99, -2.5, -1.5, -0.75, -0.25, 0.25, 0.75, 1.5, 2.5, 99];
  for (let i = 0; i < CUTS.length - 1; i++) {
    const l = pairs.filter((q) => q.d >= CUTS[i] && q.d < CUTS[i + 1]);
    if (l.length < 150) continue;
    const pred = mean(l.map((q) => q.p));
    const k = l.filter((q) => q.y).length;
    const [lo, hi] = wilson(k, l.length);
    console.log(
      `    ${String(CUTS[i]).padStart(5)} .. ${String(CUTS[i + 1]).padEnd(5)}  ${String(l.length).padStart(7)}`
      + `    ${(100 * pred).toFixed(1).padStart(5)} -> ${(100 * (k / l.length)).toFixed(1).padStart(5)}`
      + `  ${pct(pred - k / l.length).padStart(5)}pts  [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`
      + `${pred < lo || pred > hi ? '  MISCALIBRATED' : ''}`,
    );
  }
  return { all, perLine, slope, slopeCi, gamma: gam, sdProj: Math.sqrt(varP) };
}

/**
 * The one-parameter shape test. Replace every projection by
 * `L * (mu / L)^gamma`, where `L` is the mean projection, and find the gamma
 * that best explains the counts actually scored (Poisson log-likelihood, with
 * a profile-likelihood 95% interval).
 *
 * gamma = 1 means the projection already moves exactly as far as it should.
 * Above one means the model has the signal and is damping it — the shape error
 * a one-sided lean at the ends of the board would be made of. Below one means
 * it is spreading further than the runs support.
 */
export function amplification(pts) {
  const L = mean(pts.map((p) => p.mu));
  const ll = (gamma) => mean(pts.map((p) => {
    const m = L * (p.mu / L) ** gamma;
    return p.y * Math.log(m) - m;
  }));
  let best = { g: 1, v: -Infinity };
  for (let gamma = 0.2; gamma <= 2.6; gamma += 0.005) {
    const v = ll(gamma);
    if (v > best.v) best = { g: gamma, v };
  }
  const target = best.v - 1.92 / pts.length;
  let lo = best.g;
  let hi = best.g;
  for (let gamma = best.g; gamma > 0.1; gamma -= 0.005) { if (ll(gamma) < target) { lo = gamma; break; } }
  for (let gamma = best.g; gamma < 3.5; gamma += 0.005) { if (ll(gamma) < target) { hi = gamma; break; } }
  return { g: best.g, lo, hi };
}

// ── first five innings, against the full game ───────────────────────────────
/**
 * `--f5` answers the one question the F5 board exists for: is the model
 * RELATIVELY better over five innings, where the starter decides, than over
 * nine, where the bullpen the model carries no signal on decides the end?
 *
 * Like for like. Raw bias and MAE are not comparable — five innings is about
 * 5.0 runs and nine is about 8.9 — so the comparison is on the three
 * scale-free numbers: calibration error in points, Brier skill against the
 * market's own base rate, and the correlation between the point projection
 * and what happened. Every row is scored on the SAME games.
 */
function f5Report(recs, label) {
  const g = recs.filter((r) => r.t === 'g' && r.f5tot);
  if (!g.length) return null;
  console.log(`\n=== FIRST FIVE INNINGS vs THE FULL GAME — ${label} (${g.length} games) ===`);
  const rep = score(g);
  const row = (name, m) => {
    const r = rep[m];
    if (!r) return;
    const c = r.calibration;
    const skill = 100 * (1 - r.brier / r.brierBase);
    const corr = r.point ? r.point.corr.toFixed(3) : '   — ';
    const bias = r.point ? `${r.point.bias >= 0 ? '+' : ''}${r.point.bias.toFixed(3)}` : '  —  ';
    console.log(
      `  ${name.padEnd(22)} ECE ${(100 * c.ece).toFixed(2).padStart(5)}pts`
      + `  gap ${pct(c.gap).padStart(5)}pts`
      + `  brier skill ${skill.toFixed(1).padStart(5)}%`
      + `  corr ${corr}  bias ${bias} runs  n=${c.n}`,
    );
  };
  console.log('  -- the whole game --');
  row('moneyline', 'G ml');
  row('run line', 'G mar');
  row('total', 'G tot');
  console.log('  -- the first five --');
  row('F5 moneyline', 'F5 ml');
  row('F5 run line', 'F5 mar');
  row('F5 total', 'F5 tot');
  row('F5 level after five', 'F5 tie');
  console.log('\n  per line, model -> actual');
  for (const m of ['F5 tot', 'F5 mar', 'F5 ml', 'F5 tie']) {
    const r = rep[m];
    if (r) console.log(`    ${m.padEnd(7)} ${r.perLine.map((l) => `${l.line}: ${(100 * l.pred).toFixed(1)}->${(100 * l.obs).toFixed(1)}${l.off ? '*' : ''}`).join('  ')}`);
  }
  // PAIRED, at the coin-flip line of each market. Brier skill above is pooled
  // over ladders of different length against different base rates, so it is
  // suggestive, not a comparison. This is one line per market per game, chosen
  // as the line each market is actually hung at (over 8.5 and over 4.5 are both
  // within a point of 50/50 league-wide; home -1.5 and home -0.5 are each
  // market's standard run line), scored on the SAME games, with a cluster
  // bootstrap over games on the DIFFERENCE.
  const paired = [
    ['total       over 8.5 / over 4.5', (r) => r.tot[2][2], (r) => (r.tot[1] > 8.5 ? 1 : 0), (r) => r.f5tot[2][1], (r) => (r.f5tot[1] > 4.5 ? 1 : 0), () => true],
    ['run line    -1.5 / -0.5', (r) => r.mar[2][0], (r) => (r.mar[1] > 1.5 ? 1 : 0), (r) => r.f5mar[2][0], (r) => (r.f5mar[1] > 0.5 ? 1 : 0), () => true],
    ['moneyline   home win / home leads', (r) => r.ml[0], (r) => r.ml[1], (r) => r.f5ml[0], (r) => r.f5ml[1], (r) => !!r.f5ml],
  ];
  console.log('\n  paired at the coin-flip line, same games   Brier skill, each against its own base rate');
  for (const [name, pf, yf, p5, y5, keep] of paired) {
    const list = g.filter((r) => r.tot && r.mar && keep(r));
    if (!list.length) continue;
    // Skill, not raw Brier: the two markets have different base rates (home
    // -1.5 lands 36% of the time, F5 home -0.5 lands 45%), and Brier against a
    // different base rate is a different scale. Skill against each market's
    // OWN base rate is the like-for-like number, and positive means the model
    // is doing relatively more over five innings than over nine.
    const skill = (xs, pp, yy) => {
      const b = mean(xs.map((r) => (pp(r) - yy(r)) ** 2));
      const base = mean(xs.map(yy));
      const b0 = base * (1 - base);
      return b0 > 0 ? 1 - b / b0 : NaN;
    };
    const diff = (xs) => skill(xs, p5, y5) - skill(xs, pf, yf);
    const ci = clusterBoot(list, (r) => r.g, diff, 600);
    const f = (x) => `${(100 * x).toFixed(2)}%`;
    console.log(
      `    ${name.padEnd(34)} skill ${f(skill(list, pf, yf)).padStart(6)} -> ${f(skill(list, p5, y5)).padStart(6)}`
      + `   F5 minus full ${diff(list) >= 0 ? '+' : ''}${(100 * diff(list)).toFixed(2)}pts`
      + ` [${ci[0] >= 0 ? '+' : ''}${(100 * ci[0]).toFixed(2)}, ${ci[1] >= 0 ? '+' : ''}${(100 * ci[1]).toFixed(2)}]  n=${list.length}`,
    );
  }

  // The share of the game the F5 markets actually cover, which is the reason
  // to expect anything different at all.
  const t5 = mean(g.map((r) => r.f5tot[1]));
  const t9 = mean(g.filter((r) => r.tot).map((r) => r.tot[1]));
  console.log(`\n  actual runs: first five ${t5.toFixed(3)}, whole game ${t9.toFixed(3)} (${(100 * t5 / t9).toFixed(1)}% of the game)`);
  return rep;
}

// ── run ─────────────────────────────────────────────────────────────────────
const inHoldout = (r) => r.d >= HOLDOUT_FROM && r.d <= HOLDOUT_TO;
const main = rows.filter((r) => !inHoldout(r));
const hold = rows.filter(inHoldout);

const pct = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`;
function printMarkets(rep, label) {
  console.log(`\n########## ${label} ##########`);
  for (const [m, r] of Object.entries(rep)) {
    const c = r.calibration;
    console.log(
      `\n${m} — ${r.label}   ${c.n} probability-outcome pairs`
      + `${r.missing ? ` (${r.missing} of ${r.nEvents} with no projection)` : ''}`,
    );
    console.log(
      `  calibration  ECE ${(100 * c.ece).toFixed(2)}pts [${(100 * c.eceCi[0]).toFixed(2)}, ${(100 * c.eceCi[1]).toFixed(2)}]`
      + `   overall gap ${pct(c.gap)}pts [${pct(c.gapCi[0])}, ${pct(c.gapCi[1])}]   worst bin ${pct(c.worst)}pts`
      + `   ${c.table.filter((t) => t.off).length} of ${c.table.length} bins outside their interval`,
    );
    console.log(`  sharpness  sd of the quoted probability ${(100 * c.sdP).toFixed(1)}pts, range ${(100 * c.range[0]).toFixed(1)}-${(100 * c.range[1]).toFixed(1)}%`);
    console.log(`  brier ${r.brier.toFixed(4)} vs ${r.brierBase.toFixed(4)} for the base rate  (skill ${(100 * (1 - r.brier / r.brierBase)).toFixed(1)}%)`);
    if (r.point) {
      const p = r.point;
      console.log(
        `  point projection  proj ${p.meanProj.toFixed(3)} actual ${p.meanActual.toFixed(3)}`
        + `  bias ${p.bias >= 0 ? '+' : ''}${p.bias.toFixed(3)} (${p.biasPct >= 0 ? '+' : ''}${p.biasPct.toFixed(1)}%)`
        + `  MAE ${p.mae.toFixed(3)} vs ${p.naiveMae.toFixed(3)} naive`
        + `  corr ${p.corr.toFixed(3)}  slope ${p.slope.toFixed(2)}  sd(proj) ${p.sdProj.toFixed(3)} sd(actual) ${p.sdActual.toFixed(3)}`,
      );
    }
    if (has('bins')) {
      console.log('  bin  predicted -> observed [95% on observed]  n');
      for (const t of r.calibration.table) {
        console.log(
          `    ${(100 * t.lo).toFixed(0).padStart(3)}-${(100 * t.hi).toFixed(0).padEnd(3)}  ${(100 * t.pred).toFixed(1).padStart(5)} -> ${(100 * t.obs).toFixed(1).padStart(5)}`
          + ` [${(100 * t.ci[0]).toFixed(1)}, ${(100 * t.ci[1]).toFixed(1)}]  n=${t.n}${t.off ? '   MISCALIBRATED' : ''}`,
        );
      }
    }
    console.log(`  by line: ${r.perLine.map((l) => `${l.line}: ${(100 * l.pred).toFixed(1)}->${(100 * l.obs).toFixed(1)}${l.off ? '*' : ''}`).join('  ')}`);
  }
}

const reportMain = score(main);
const reportHold = hold.length ? score(hold) : null;
printMarkets(reportMain, `EVERYTHING EXCEPT THE HOLDOUT (through ${HOLDOUT_FROM} exclusive)`);
if (reportHold) printMarkets(reportHold, `HOLDOUT ${HOLDOUT_FROM}..${HOLDOUT_TO}`);

const f5 = {};
if (has('f5')) {
  f5.main = f5Report(main, `EVERYTHING EXCEPT THE HOLDOUT (through ${HOLDOUT_FROM} exclusive)`);
  if (hold.length) f5.hold = f5Report(hold, `HOLDOUT ${HOLDOUT_FROM}..${HOLDOUT_TO}`);
  const seasons = [...new Set(rows.filter((r) => r.t === 'g').map((r) => r.d.slice(0, 4)))].sort();
  for (const s of seasons) f5[s] = f5Report(main.filter((r) => r.d.startsWith(s)), `season ${s}, excluding the holdout`);
}

const totals = {};
if (has('totals')) {
  totals.main = totalsReport(main, `EVERYTHING EXCEPT THE HOLDOUT (through ${HOLDOUT_FROM} exclusive)`);
  if (hold.length) totals.hold = totalsReport(hold, `HOLDOUT ${HOLDOUT_FROM}..${HOLDOUT_TO}`);
  // Split the same way the study did, so a level that drifts with the season
  // cannot hide inside a two-season average.
  const seasons = [...new Set(rows.filter((r) => r.t === 'g').map((r) => r.d.slice(0, 4)))].sort();
  for (const s of seasons) totals[s] = totalsReport(main.filter((r) => r.d.startsWith(s)), `season ${s}, excluding the holdout`);
  const months = [...new Set(rows.filter((r) => r.t === 'g').map((r) => monthOf(r.d)))].sort();
  console.log('\n=== TOTALS by month (every game, holdout included) ===');
  console.log('  month      n     proj   actual    bias   [95%]        over8.5 pred -> obs');
  for (const m of months) {
    const list = rows.filter((r) => r.t === 'g' && monthOf(r.d) === m && r.tot?.[0] != null);
    if (list.length < 30) continue;
    const proj = mean(list.map((r) => r.tot[0]));
    const act = mean(list.map((r) => r.tot[1]));
    const ci = clusterBoot(list, (r) => r.g, (xs) => mean(xs.map((x) => x.tot[1] - x.tot[0])), 400);
    const pred = mean(list.map((r) => r.tot[2][2]));
    const obs = list.filter((r) => r.tot[1] > 8.5).length / list.length;
    console.log(
      `  ${m}  ${String(list.length).padStart(5)}  ${proj.toFixed(2)}   ${act.toFixed(2)}`
      + `   ${act - proj >= 0 ? '+' : ''}${(act - proj).toFixed(3)}  [${ci[0] >= 0 ? '+' : ''}${ci[0].toFixed(2)}, ${ci[1] >= 0 ? '+' : ''}${ci[1].toFixed(2)}]`
      + `    ${(100 * pred).toFixed(1)} -> ${(100 * obs).toFixed(1)}`,
    );
  }
}

// RANKING POWER, and the metric that cannot measure it
const ranks = {};
if (has('rank')) {
  console.log('\n=== RANKING POWER: correlation across players, against the ceiling ===');
  console.log('  Read this INSTEAD of the MAE column. Across pitcher-seasons (10+ starts)');
  console.log('  and hitter-seasons (20+ starts): the correlation between one player\'s mean');
  console.log('  projection and his mean realised production, and the highest correlation');
  console.log('  any projection could reach against a target measured that noisily.');
  console.log('\n  market                    entities  games   corr [95%]           ceiling  share [95%]    slope  sd(model) sd(true)');
  for (const [m, sm] of collect(main)) {
    if (!sm.points.length || !sm.points[0].who) continue;
    const r = rankStudy(sm.points, (x) => x.who, m.startsWith('P ') ? 10 : 20);
    if (!r) continue;
    ranks[m] = r;
    console.log(
      `  ${(LABEL[m] || m).padEnd(24)} ${String(r.entities).padStart(6)} ${String(r.games).padStart(7)}`
      + `   ${r.corr.toFixed(3)} [${r.corrCi[0].toFixed(3)}, ${r.corrCi[1].toFixed(3)}]`
      + `   ${r.ceiling.toFixed(3)}   ${r.share.toFixed(2)} [${r.shareCi[0].toFixed(2)}, ${r.shareCi[1].toFixed(2)}]`
      + `   ${r.slope.toFixed(2)}   ${r.sdModel.toFixed(3)}    ${r.sdTrue.toFixed(3)}`,
    );
  }
}

if (has('scale')) {
  console.log('\n=== WHY MAE AGAINST THE SLATE AVERAGE IS NOT A RANKING METRIC ===');
  console.log('  Every projection multiplied by a constant, then scored on MAE. Where a');
  console.log('  constant other than 1.00 wins, the metric is paying for a lean.');
  console.log(`\n  market                 ${SCALES.map((x) => `x${x.toFixed(2)}`.padStart(9)).join('')}   slate avg   best`);
  for (const [m, sm] of collect(main)) {
    if (!sm.points.length) continue;
    const a = sm.points.map((x) => x.act);
    const ma = mean(a);
    const naive = mean(a.map((x) => Math.abs(x - ma)));
    const maes = SCALES.map((k) => mean(sm.points.map((x, i) => Math.abs(k * x.proj - a[i]))));
    let bi = 0;
    maes.forEach((v, i) => { if (v < maes[bi]) bi = i; });
    console.log(
      `  ${(LABEL[m] || m).padEnd(21)} ${maes.map((v) => v.toFixed(4).padStart(9)).join('')}`
      + `    ${naive.toFixed(4)}   x${SCALES[bi].toFixed(2)}${SCALES[bi] === 1 ? '' : '   <- NOT 1.00'}`,
    );
  }
}

/**
 * `--carry`. Not a calibration: the carry-over rate. Of the nine who started a
 * team's last game, how many start the next one, and how many in the same
 * slot. That is what an unconfirmed card costs, and it is a property of
 * managers rather than of the model — which is why it is reported as a rate
 * and never folded into a calibration figure.
 */
if (has('carry')) {
  const byTeam = new Map();
  for (const r of rows) {
    if (r.t !== 'b' || r.tm == null) continue;
    const k = `${r.tm}`;
    if (!byTeam.has(k)) byTeam.set(k, new Map());
    const games = byTeam.get(k);
    if (!games.has(r.g)) games.set(r.g, { d: r.d, nine: new Map() });
    games.get(r.g).nine.set(r.id, r.slot);
  }
  let pairs = 0;
  let started = 0;
  let sameSlot = 0;
  let of = 0;
  for (const games of byTeam.values()) {
    const seq = [...games.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1].nine;
      const now = seq[i].nine;
      if (prev.size < 8 || now.size < 8) continue;
      pairs++;
      for (const [id, slot] of prev) {
        of++;
        if (now.has(id)) {
          started++;
          if (now.get(id) === slot) sameSlot++;
        }
      }
    }
  }
  console.log('\n=== WHAT AN UNCONFIRMED LINEUP COSTS ===');
  console.log(
    `  ${pairs} consecutive team-game pairs, ${of} player-slots.`
    + `  Started again: ${((100 * started) / of).toFixed(1)}%.`
    + `  Started again in the SAME slot: ${((100 * sameSlot) / of).toFixed(1)}%.`,
  );
}

const slices = {};
if (has('slices')) {
  for (const t of ['p', 'b', 'g']) {
    if (!rows.some((r) => r.t === t)) continue;
    for (const name of Object.keys(SLICES[t])) {
      const s = sliceReport(rows, t, name);
      slices[`${t}.${name}`] = s;
      console.log(`\n=== slice ${t}.${name} ===`);
      for (const [k, v] of Object.entries(s)) {
        for (const [m, o] of Object.entries(v)) {
          console.log(
            `  ${k.padEnd(30)} ${m.padEnd(10)} n=${String(o.n).padStart(6)}  ECE ${(100 * o.ece).toFixed(2)}pts  gap ${pct(o.gap)}`
            + `${o.mae != null ? `  MAE ${o.mae.toFixed(3)}  bias ${o.bias >= 0 ? '+' : ''}${o.bias.toFixed(3)}` : ''}`,
          );
        }
      }
    }
  }
  for (const [t, market] of [['p', 'P k'], ['p', 'P er'], ['b', 'B tb'], ['b', 'B hr'], ['g', 'G tot']]) {
    if (!rows.some((r) => r.t === t)) continue;
    const pr = parkReport(rows, t, market);
    if (!pr.length) continue;
    console.log(`\n=== park extremes, ${market} (bias = actual - projected) ===`);
    for (const x of [...pr.slice(0, 4), ...pr.slice(-4)]) {
      console.log(`  ${x.park.padEnd(32)} n=${String(x.n).padStart(5)}  bias ${x.bias >= 0 ? '+' : ''}${x.bias.toFixed(3)}  MAE ${x.mae.toFixed(3)}  gap ${pct(x.gap)}pts`);
    }
  }
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ holdout: [HOLDOUT_FROM, HOLDOUT_TO], main: reportMain, hold: reportHold, slices }, null, 1));
  process.stderr.write(`wrote ${JSON_OUT}\n`);
}
