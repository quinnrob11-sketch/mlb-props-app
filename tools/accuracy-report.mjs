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

const LABEL = {
  'P k': 'pitcher strikeouts', 'P outs': 'pitcher outs recorded', 'P hits': 'pitcher hits allowed',
  'P bb': 'pitcher walks', 'P er': 'pitcher earned runs',
  'B hits': 'batter hits', 'B tb': 'batter total bases', 'B hr': 'batter home runs',
  'B rbi': 'batter RBIs', 'B hrr': 'batter hits+runs+RBIs', 'B runs': 'batter runs',
  'B k': 'batter strikeouts', 'B singles': 'batter singles', 'B sb': 'batter stolen bases',
  'G ml': 'moneyline (home win)', 'G tot': 'game total (over)', 'G mar': 'run line (home)',
  'G nrfi': 'first inning (NRFI)',
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
  const add = (m, lines, entry, g, names = null) => {
    const s = get(m);
    s.n++;
    const [proj, act, ps] = entry;
    if (proj == null || act == null || ps.some((p) => p == null)) { s.missing++; return; }
    s.points.push({ proj, act, g });
    lines.forEach((l, i) => {
      const q = { p: ps[i], y: act > l ? 1 : 0, g };
      s.pairs.push(q);
      const name = names ? names[i] : l;
      if (!s.lines.has(name)) s.lines.set(name, []);
      s.lines.get(name).push(q);
    });
  };
  for (const r of recs) {
    if (r.t === 'p') for (const [m, lines] of Object.entries(PITCHER_LINES)) add(`P ${m}`, lines, r.m[m], r.g);
    else if (r.t === 'b') for (const [m, lines] of Object.entries(BATTER_LINES)) add(`B ${m}`, lines, r.m[m], r.g);
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
  },
};

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
