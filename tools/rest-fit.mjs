// Fit and check the days-of-rest term, on the FIT split only
// (2025 entire + 2026 through 2026-08-09). Prints everything it fits.
//
//   node tools/rest-fit.mjs --from 2025-03-20 --to 2025-10-01 --out .work/rest_25.ndjson
//   node tools/rest-fit.mjs --from 2026-03-20 --to 2026-09-22 --out .work/rest_26.ndjson
//
//   node tools/rest-fit.mjs --shape   .work/rest_2*.ndjson   # what the data says
//   node tools/rest-fit.mjs --leash   .work/rest_2*.ndjson   # leash or effectiveness
//   node tools/rest-fit.mjs --confound .work/rest_2*.ndjson  # calendar, role, bend
//   node tools/rest-fit.mjs --fit     .work/rest_2*.ndjson   # the term itself
//
// Same shape as `tools/opener-fit.mjs`: one row per start, written by the
// existing lookahead-free replay in `tools/backtest-pitchers.mjs`. No new
// replay, no new request. `--ship '{"rest":null}'` writes the rows a tree
// WITHOUT the term would write, which is how the fit is reproduced after it
// has shipped.
import fs from 'node:fs';
import path from 'node:path';
import { buildStarts, pitcherLogs } from './backtest-pitchers.mjs';
import { projectPitcher, PITCHER_FIT, restDaysFrom } from '../src/model/pitcher.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', null);
const MODES = ['shape', 'leash', 'confound', 'fit', 'window'];
const REPORT = MODES.some((m) => process.argv.includes(`--${m}`));

/** Every calibration off, so `raw` is the projection before any of it. */
const RAW_FIT = {
  ...PITCHER_FIT,
  cal: { ...PITCHER_FIT.cal, outs: [0, 1, 1] },
  role: null,
  bend: null,
  rest: null,
  progress: null,
};
/** The model as this working tree ships it, plus any `--ship` override. */
const SHIP_FIT = { ...PITCHER_FIT, ...(arg('ship', null) ? JSON.parse(arg('ship')) : {}) };
/** The control this branch is measured against: master, i.e. no rest term. */
const CTL_FIT = { ...PITCHER_FIT, rest: null };

const MARKETS = ['outs', 'k', 'hits', 'bb', 'er'];
const PROJ = { outs: 'projOuts', k: 'projK', hits: 'projH', bb: 'projBB', er: 'projER' };
const ACT = { outs: 'outs', k: 'k', hits: 'hits', bb: 'bb', er: 'er' };

/** The outs ladder tools/accuracy-report.mjs scores, and its gap in points. */
const LINES = { outs: [11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5] };

const r4 = (x) => (Number.isFinite(x) ? Math.round(1e4 * x) / 1e4 : null);

const starts = REPORT ? [] : buildStarts();
if (!REPORT) process.stderr.write(`${starts.length} starts\n`);
const rows = [];
for (const s of starts) {
  const ctl = projectPitcher({ ...s.input, fit: CTL_FIT });
  const raw = projectPitcher({ ...s.input, fit: RAW_FIT });
  const now = projectPitcher({ ...s.input, fit: SHIP_FIT });
  const log = (pitcherLogs.get(s.id) || [])
    .filter((g) => g.date < s.date)
    .map((g) => ({ date: g.date, gs: Number(g.stat.gamesStarted || 0), outs: Number(g.stat.outs || 0) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastStart = log.filter((a) => a.gs > 0).at(-1) || null;
  const lastApp = log.at(-1) || null;
  // Appearances of ANY kind strictly between his last start and tonight: the
  // difference between a man on the injured list and a man in a piggyback.
  const inGap = lastStart ? log.filter((a) => a.date > lastStart.date).length : 0;
  const l3 = log.slice(-3);
  rows.push({
    d: s.date, id: s.id, g: s.gamePk,
    // Days since his last START, and since his last APPEARANCE of any kind.
    rest: restDaysFrom(log, s.date),
    restApp: lastApp ? Math.round((Date.parse(s.date) - Date.parse(lastApp.date)) / 864e5) : null,
    inGap,
    nApp: log.length,
    // The role class, read exactly as the model reads it.
    l3max: l3.length ? Math.max(...l3.map((x) => x.outs)) : null,
    ip: r4(ctl.projIP),
    raw: r4(raw.projOuts),
    ...Object.fromEntries(MARKETS.flatMap((m) => [
      [`${m}C`, r4(ctl[PROJ[m]])],
      [`${m}N`, r4(now[PROJ[m]])],
      [`${m}A`, s.actual[ACT[m]]],
    ])),
    // Ladder of the CONTROL and of the CURRENT tree, so a slice's calibration
    // gap can be read without re-projecting it.
    ladC: LINES.outs.map((l) => Math.round(1e5 * ctl.dist.outs(l)) / 1e5),
    ladN: LINES.outs.map((l) => Math.round(1e5 * now.dist.outs(l)) / 1e5),
  });
}
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.stderr.write(`wrote ${rows.length} to ${OUT}\n`);
}

// ── reporting ───────────────────────────────────────────────────────────────
const UNTIL = '2026-08-10';
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sem = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length / xs.length); };
const cls = (r) => (r.l3max == null ? 'debut' : r.l3max <= 6 ? 'opener' : 'starter');
const ladGap = (rs, key = 'ladC') => {
  let p = 0, o = 0, n = 0;
  for (const r of rs) {
    if (!r[key]) continue;
    LINES.outs.forEach((l, i) => { p += r[key][i]; o += r.outsA > l ? 1 : 0; n++; });
  }
  return n ? (100 * (p - o)) / n : NaN;
};

/** The bands the reports cut on. `restDaysFrom` returns the DATE difference. */
const BANDS = [
  [0, 4, '<=4 (short)'], [5, 5, '5 (normal)'], [6, 6, '6 (six-man)'], [7, 7, '7'],
  [8, 9, '8-9'], [10, 11, '10-11'], [12, 14, '12-14'], [15, 20, '15-20'], [21, 999, '21+'],
];

function shape(rows) {
  const FIT = rows.filter((r) => r.d < UNTIL);
  console.log(`\nFIT split: ${FIT.length} starts (2025 entire + 2026 through ${UNTIL} exclusive)`);
  const nul = FIT.filter((r) => r.rest == null).length;
  console.log(`${nul} of them have NO previous start this season, so no rest to read.\n`);
  console.log('outs against days since his last start, before this branch:');
  console.log('  band            n     proj  actual    bias   +-se   projIP   ladder gap   2025    2026');
  for (const [lo, hi, lab] of BANDS) {
    const g = FIT.filter((r) => r.rest != null && r.rest >= lo && r.rest <= hi);
    if (g.length < 8) { console.log(`  ${lab.padEnd(14)} n=${g.length} (thin)`); continue; }
    const d = g.map((r) => r.outsA - r.outsC);
    const a = g.filter((r) => r.d < '2026-01-01');
    const b = g.filter((r) => r.d >= '2026-01-01');
    const sg = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
    console.log(
      `  ${lab.padEnd(14)}${String(g.length).padStart(5)}${mean(g.map((r) => r.outsC)).toFixed(2).padStart(9)}` +
      `${mean(g.map((r) => r.outsA)).toFixed(2).padStart(8)}${sg(mean(d)).padStart(8)}${sem(d).toFixed(2).padStart(7)}` +
      `${mean(g.map((r) => r.ip)).toFixed(2).padStart(9)}${sg(ladGap(g)).padStart(13)}` +
      `${(a.length ? sg(mean(a.map((r) => r.outsA - r.outsC))) : '-').padStart(8)}` +
      `${(b.length ? sg(mean(b.map((r) => r.outsA - r.outsC))) : '-').padStart(8)}`,
    );
  }
}

function leash(rows) {
  const FIT = rows.filter((r) => r.d < UNTIL && r.rest != null);
  console.log('\nis it the LEASH or the EFFECTIVENESS? ratio of actual to projected, per market:');
  console.log('  band            n' + MARKETS.map((m) => m.padStart(8)).join(''));
  for (const [lo, hi, lab] of [...BANDS, [8, 999, '8+ (the cell)'], [10, 999, '10+']]) {
    const g = FIT.filter((r) => r.rest >= lo && r.rest <= hi);
    if (g.length < 8) continue;
    console.log(`  ${lab.padEnd(14)}${String(g.length).padStart(5)}` +
      MARKETS.map((m) => (mean(g.map((r) => r[`${m}A`])) / mean(g.map((r) => r[`${m}C`]))).toFixed(3).padStart(8)).join(''));
  }
  console.log('\nthe same, as a per-market exponent on the OUTS ratio (1.0 = pure leash):');
  console.log('  band            n' + MARKETS.slice(1).map((m) => m.padStart(8)).join(''));
  for (const [lo, hi, lab] of [[8, 9, '8-9'], [10, 11, '10-11'], [12, 999, '12+'], [10, 999, '10+'], [8, 999, '8+ (the cell)']]) {
    const g = FIT.filter((r) => r.rest >= lo && r.rest <= hi);
    if (g.length < 8) continue;
    const lo2 = Math.log(mean(g.map((r) => r.outsA)) / mean(g.map((r) => r.outsC)));
    console.log(`  ${lab.padEnd(14)}${String(g.length).padStart(5)}` +
      MARKETS.slice(1).map((m) => {
        const lm = Math.log(mean(g.map((r) => r[`${m}A`])) / mean(g.map((r) => r[`${m}C`])));
        return (lo2 ? (lm / lo2).toFixed(2) : '-').padStart(8);
      }).join(''));
  }
  console.log('\nrealised rates PER REALISED OUT — a pure leash leaves these flat:');
  console.log('  band            n   outs    K/out    H/out   BB/out   ER/out  (projected K/out, H/out)');
  for (const [lo, hi, lab] of BANDS) {
    const g = FIT.filter((r) => r.rest >= lo && r.rest <= hi);
    if (g.length < 8) continue;
    const so = g.reduce((a, r) => a + r.outsA, 0);
    const sp = g.reduce((a, r) => a + r.outsC, 0);
    const f = (m) => (g.reduce((a, r) => a + r[`${m}A`], 0) / so).toFixed(4).padStart(9);
    const fp = (m) => (g.reduce((a, r) => a + r[`${m}C`], 0) / sp).toFixed(4).padStart(9);
    console.log(`  ${lab.padEnd(14)}${String(g.length).padStart(5)}${(so / g.length).toFixed(2).padStart(7)}` +
      f('k') + f('hits') + f('bb') + f('er') + '   ' + fp('k') + fp('hits'));
  }
}

function confound(rows) {
  const FIT = rows.filter((r) => r.d < UNTIL && r.rest != null);
  const bias = (g) => (g.length ? mean(g.map((r) => r.outsA - r.outsC)) : NaN);
  const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');

  console.log('\n1. IS IT THE CALENDAR? the month each rest band lives in:');
  console.log('  band            n   ' + ['03/04', '05', '06', '07', '08', '09/10'].map((m) => m.padStart(7)).join(''));
  const bucket = (d) => { const m = d.slice(5, 7); return m <= '04' ? '03/04' : m >= '09' ? '09/10' : m; };
  for (const [lo, hi, lab] of BANDS) {
    const g = FIT.filter((r) => r.rest >= lo && r.rest <= hi);
    if (g.length < 8) continue;
    console.log(`  ${lab.padEnd(14)}${String(g.length).padStart(5)}   ` +
      ['03/04', '05', '06', '07', '08', '09/10'].map((m) =>
        `${(100 * g.filter((r) => bucket(r.d) === m).length / g.length).toFixed(0)}%`.padStart(7)).join(''));
  }
  console.log('\n  outs bias by rest band WITHIN each month — the rest story has to survive this:');
  console.log('  month      ' + ['5-6', '7', '8-9', '10-11', '12+'].map((m) => m.padStart(14)).join(''));
  for (const m of ['03/04', '05', '06', '07', '08', '09/10']) {
    const mo = FIT.filter((r) => bucket(r.d) === m);
    console.log(`  ${m.padEnd(11)}` + [[5, 6], [7, 7], [8, 9], [10, 11], [12, 999]].map(([lo, hi]) => {
      const g = mo.filter((r) => r.rest >= lo && r.rest <= hi);
      return (g.length >= 8 ? `${sg(bias(g))} (${g.length})` : `- (${g.length})`).padStart(14);
    }).join(''));
  }

  console.log('\n2. IS IT THE ROLE CLASS? bias by rest band within each class:');
  console.log('  class      ' + ['5-6', '7', '8-9', '10-11', '12+'].map((m) => m.padStart(14)).join(''));
  for (const c of ['starter', 'opener', 'debut']) {
    const cc = FIT.filter((r) => cls(r) === c);
    console.log(`  ${c.padEnd(11)}` + [[5, 6], [7, 7], [8, 9], [10, 11], [12, 999]].map(([lo, hi]) => {
      const g = cc.filter((r) => r.rest >= lo && r.rest <= hi);
      return (g.length >= 8 ? `${sg(bias(g))} (${g.length})` : `- (${g.length})`).padStart(14);
    }).join(''));
  }

  console.log('\n3. IS IT THE BEND? bias inside and outside the bend window, starter class:');
  const S = FIT.filter((r) => cls(r) === 'starter');
  const B = PITCHER_FIT.bend || { lo: 10, hi: 14 };
  console.log('  where                ' + ['5-6', '7-9', '10+'].map((m) => m.padStart(16)).join(''));
  for (const [lab, f] of [
    [`inside (raw ${B.lo}-${B.hi})`, (r) => r.raw > B.lo && r.raw < B.hi],
    ['outside', (r) => !(r.raw > B.lo && r.raw < B.hi)],
  ]) {
    console.log(`  ${lab.padEnd(21)}` + [[5, 6], [7, 9], [10, 999]].map(([lo, hi]) => {
      const g = S.filter((r) => f(r) && r.rest >= lo && r.rest <= hi);
      return (g.length >= 8 ? `${sg(bias(g))} (${g.length})` : `- (${g.length})`).padStart(16);
    }).join(''));
  }

  console.log('\n4. FIRST START BACK, or a man in a piggyback? (10+ days since his last START)');
  console.log('  what happened in the gap        n     proj  actual    bias');
  for (const [lab, f] of [
    ['no appearance at all (a layoff)', (r) => r.inGap === 0],
    ['relieved once in the gap', (r) => r.inGap === 1],
    ['relieved 2+ times in the gap', (r) => r.inGap >= 2],
  ]) {
    const g = FIT.filter((r) => r.rest >= 10 && f(r));
    if (!g.length) continue;
    console.log(`  ${lab.padEnd(32)}${String(g.length).padStart(4)}${mean(g.map((r) => r.outsC)).toFixed(2).padStart(9)}` +
      `${mean(g.map((r) => r.outsA)).toFixed(2).padStart(8)}${sg(bias(g)).padStart(8)}`);
  }
  console.log('\n  and by days since his last APPEARANCE of any kind, which is the layoff itself:');
  console.log('  band            n     proj  actual    bias   +-se');
  for (const [lo, hi, lab] of BANDS) {
    const g = FIT.filter((r) => r.restApp != null && r.restApp >= lo && r.restApp <= hi);
    if (g.length < 8) continue;
    const d = g.map((r) => r.outsA - r.outsC);
    console.log(`  ${lab.padEnd(14)}${String(g.length).padStart(5)}${mean(g.map((r) => r.outsC)).toFixed(2).padStart(9)}` +
      `${mean(g.map((r) => r.outsA)).toFixed(2).padStart(8)}${sg(mean(d)).padStart(8)}${sem(d).toFixed(2).padStart(7)}`);
  }
}

/** The ramp, in days: zero at and below `knee`, one per day, flat from `cap`. */
const ramp = (rest, knee, cap) => (rest == null || rest <= knee ? 0 : Math.min(cap, rest) - knee);

function fitTerm(rows) {
  const FIT = rows.filter((r) => r.d < UNTIL && r.rest != null && cls(r) === 'starter');
  const F25 = FIT.filter((r) => r.d < '2026-01-01');
  const F26 = FIT.filter((r) => r.d >= '2026-01-01');
  const VAL = rows.filter((r) => r.d >= UNTIL && r.d <= '2026-09-01' && r.rest != null && cls(r) === 'starter');
  const sse = (rs, f) => rs.reduce((a, r) => a + (r.outsA - f(r)) ** 2, 0);
  const flat = (rs) => sse(rs, (r) => r.outsC);

  /** Shape A, the obvious one: a flat percentage off projected depth. */
  const predA = (r, knee, cap, amp) => r.outsC * (1 - amp * ramp(r.rest, knee, cap));
  const fitA = (rs, knee, cap) => {
    let num = 0, den = 0;
    for (const r of rs) { const x = -r.outsC * ramp(r.rest, knee, cap); num += x * (r.outsA - r.outsC); den += x * x; }
    return den ? num / den : 0;
  };
  /** Shape B, what ships: a ONE-SIDED shrink toward a short-assignment anchor. */
  const predB = (r, knee, cap, anchor, perDay) => {
    if (r.outsC <= anchor) return r.outsC;
    const w = Math.min(0.9, Math.max(0, perDay * ramp(r.rest, knee, cap)));
    return anchor + (1 - w) * (r.outsC - anchor);
  };
  const fitB = (rs, knee, cap, anchor) => {
    let num = 0, den = 0;
    for (const r of rs) {
      if (r.outsC <= anchor) continue;
      const x = -(r.outsC - anchor) * ramp(r.rest, knee, cap);
      num += x * (r.outsA - r.outsC); den += x * x;
    }
    return den ? num / den : 0;
  };
  const seB = (rs, knee, cap, anchor, L) => {
    let den = 0;
    for (const r of rs) { if (r.outsC <= anchor) continue; den += ((r.outsC - anchor) * ramp(r.rest, knee, cap)) ** 2; }
    return den ? Math.sqrt((sse(rs, (r) => predB(r, knee, cap, anchor, L)) / (rs.length - 1)) / den) : 0;
  };

  console.log(`\nfitted on the starter class of the FIT split, ${FIT.length} starts.`);
  console.log(`squared error REMOVED from the outs projection; the flat total is ${flat(FIT).toFixed(0)}.\n`);
  console.log('A. a flat percentage off depth (the obvious term):');
  console.log('  knee  cap  |    amp        2025      2026   |    dSSE   validate dSSE');
  for (const [k, c] of [[9, 15], [9, 16], [9, 18], [8, 16], [10, 18]]) {
    const A = fitA(FIT, k, c);
    console.log(
      `  ${String(k).padStart(4)}  ${String(c).padStart(3)}  |  ${A.toFixed(5)}   ${fitA(F25, k, c).toFixed(5)}   ${fitA(F26, k, c).toFixed(5)}  | ` +
      `${(flat(FIT) - sse(FIT, (r) => predA(r, k, c, A))).toFixed(0).padStart(7)}${(flat(VAL) - sse(VAL, (r) => predA(r, k, c, A))).toFixed(1).padStart(15)}`,
    );
  }
  console.log('\nB. a one-sided shrink toward a short assignment (what ships):');
  console.log('  knee  cap  anchor |   perDay      se      t  |    2025      2026   |    dSSE   validate dSSE   deepest pull');
  for (const [k, c] of [[9, 16], [9, 18], [9, 20], [8, 16], [10, 16]]) {
    for (const anchor of [11.5, 12, 13, 13.5, 14, 15]) {
      const L = fitB(FIT, k, c, anchor);
      const se = seB(FIT, k, c, anchor, L);
      console.log(
        `  ${String(k).padStart(4)}  ${String(c).padStart(3)}  ${String(anchor).padStart(6)} |  ${L.toFixed(5)}  ${se.toFixed(5)}  ${(L / se).toFixed(1).padStart(4)}  | ` +
        ` ${fitB(F25, k, c, anchor).toFixed(5)}  ${fitB(F26, k, c, anchor).toFixed(5)}  | ` +
        `${(flat(FIT) - sse(FIT, (r) => predB(r, k, c, anchor, L))).toFixed(0).padStart(7)}${(flat(VAL) - sse(VAL, (r) => predB(r, k, c, anchor, L))).toFixed(1).padStart(15)}` +
        `${(Math.min(0.9, L * (c - k))).toFixed(3).padStart(15)}`,
      );
    }
  }

  const B = PITCHER_FIT.rest || { knee: 9, cap: 16, anchor: 13, perDay: 0.0946 };
  const shipA = fitA(FIT, B.knee, B.cap);
  console.log(`\nthe two shapes at (knee ${B.knee}, cap ${B.cap}, anchor ${B.anchor}), by the projection the model makes:`);
  console.log('  projected IP     n     line   A says   B says   actual  |  bias A   bias B');
  for (const [lo, hi] of [[0, 4], [4, 4.5], [4.5, 5], [5, 5.5], [5.5, 9]]) {
    const g = FIT.filter((r) => r.rest >= 10 && r.ip >= lo && r.ip < hi);
    if (g.length < 8) continue;
    const a = mean(g.map((r) => predA(r, B.knee, B.cap, shipA)));
    const b = mean(g.map((r) => predB(r, B.knee, B.cap, B.anchor, B.perDay)));
    const act = mean(g.map((r) => r.outsA));
    const sg = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
    console.log(
      `  ${`${lo}-${hi}`.padEnd(13)}${String(g.length).padStart(4)}${mean(g.map((r) => r.outsC)).toFixed(2).padStart(9)}` +
      `${a.toFixed(2).padStart(9)}${b.toFixed(2).padStart(9)}${act.toFixed(2).padStart(9)}  |${sg(act - a).padStart(8)}${sg(act - b).padStart(9)}`,
    );
  }

  console.log('\nand per market on the shipped geometry, as a multiple of the outs coefficient:');
  console.log('  market    perDay       se       t    ratio    2025      2026');
  const L0 = fitB(FIT, B.knee, B.cap, B.anchor);
  for (const m of MARKETS) {
    // Each market on its own scale: the same one-sided shrink, anchored at the
    // share of the outs anchor that market's own line sits at.
    const k = m === 'outs' ? 1 : mean(FIT.map((r) => r[`${m}C`])) / mean(FIT.map((r) => r.outsC));
    const rs = FIT.map((r) => ({ ...r, outsC: r[`${m}C`] / k, outsA: r[`${m}A`] / k }));
    const L = fitB(rs, B.knee, B.cap, B.anchor);
    const se = seB(rs, B.knee, B.cap, B.anchor, L);
    console.log(
      `  ${m.padEnd(8)}${L.toFixed(5).padStart(9)}${se.toFixed(5).padStart(9)}${(L / se).toFixed(1).padStart(8)}` +
      `${(L / L0).toFixed(2).padStart(9)}${fitB(rs.filter((r) => r.d < '2026-01-01'), B.knee, B.cap, B.anchor).toFixed(5).padStart(10)}` +
      `${fitB(rs.filter((r) => r.d >= '2026-01-01'), B.knee, B.cap, B.anchor).toFixed(5).padStart(10)}`,
    );
  }
}

function windowReport(rows) {
  const g = (rs) => (rs.length ? mean(rs.map((r) => r.outsA - r.outsC)) : NaN);
  const gn = (rs) => (rs.length ? mean(rs.map((r) => r.outsA - r.outsN)) : NaN);
  const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
  for (const [lab, f] of [
    ['FIT   ', (r) => r.d < UNTIL],
    ['VALID ', (r) => r.d >= UNTIL && r.d <= '2026-09-01'],
    ['HOLD  ', (r) => r.d > '2026-09-01'],
  ]) {
    const W = rows.filter(f);
    console.log(`\n${lab} n=${W.length} — outs bias and ladder gap, control then this tree:`);
    console.log('  band            n     bias(ctl)  bias(now)   lad(ctl)  lad(now)');
    for (const [lo, hi, lab2] of [...BANDS, [8, 999, '8+ (the cell)']]) {
      const s = W.filter((r) => r.rest != null && r.rest >= lo && r.rest <= hi);
      if (s.length < 8) continue;
      console.log(`  ${lab2.padEnd(14)}${String(s.length).padStart(5)}${sg(g(s)).padStart(11)}${sg(gn(s)).padStart(11)}` +
        `${sg(ladGap(s, 'ladC')).padStart(11)}${sg(ladGap(s, 'ladN')).padStart(10)}`);
    }
    const nul = W.filter((r) => r.rest == null);
    if (nul.length >= 8) {
      console.log(`  ${'no prior start'.padEnd(14)}${String(nul.length).padStart(5)}${sg(g(nul)).padStart(11)}${sg(gn(nul)).padStart(11)}` +
        `${sg(ladGap(nul, 'ladC')).padStart(11)}${sg(ladGap(nul, 'ladN')).padStart(10)}`);
    }
  }
}

if (REPORT) {
  const files = process.argv.filter((a) => a.endsWith('.ndjson'));
  const loaded = [];
  for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) loaded.push(JSON.parse(l));
  process.stderr.write(`${loaded.length} rows from ${files.length} files\n`);
  if (process.argv.includes('--shape')) shape(loaded);
  if (process.argv.includes('--leash')) leash(loaded);
  if (process.argv.includes('--confound')) confound(loaded);
  if (process.argv.includes('--fit')) fitTerm(loaded);
  if (process.argv.includes('--window')) windowReport(loaded);
}
