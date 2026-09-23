// Fit the role-conditioned outs calibration, on the FIT split only
// (2025 entire + 2026 through 2026-08-09). Prints everything it fits.
//
//   node tools/opener-fit.mjs --from 2025-03-20 --to 2025-10-01 --out .work/orf_25.ndjson
//
// Writes one row per start: the RAW (pre-calibration) outs projection, the
// shipped one, the model's own PMF spread, the actual, and the role features
// derived from the pitcher's full appearance log.
import fs from 'node:fs';
import path from 'node:path';
import { buildStarts, pitcherLogs } from './backtest-pitchers.mjs';
import { projectPitcher, PITCHER_FIT } from '../src/model/pitcher.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', null);

/**
 * raw = the projection before `cal.outs`, before the role term and before the
 * season drift. `role: null` matters: once v38 ships, `PITCHER_FIT.role`
 * supersedes `cal.outs`, so leaving it on would make "raw" the calibrated
 * number and every line fitted from it an identity.
 */
const RAW_FIT = { ...PITCHER_FIT, cal: { ...PITCHER_FIT.cal, outs: [0, 1, 1] }, role: null, progress: null };
/** The v37 control: the shipped model with the role term switched off. */
const CTL_FIT = { ...PITCHER_FIT, role: null };
/** The outs ladder `tools/accuracy-report.mjs` scores. */
const OUTS_LINES = [11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5];

function appearancesBefore(logs, date) {
  const out = [];
  for (const g of logs) {
    if (g.date >= date) continue;
    out.push({ date: g.date, gs: Number(g.stat.gamesStarted || 0), outs: Number(g.stat.outs || 0), pitches: Number(g.stat.numberOfPitches || 0) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

const REPORT = process.argv.includes('--report');
const starts = REPORT ? [] : buildStarts();
if (!REPORT) process.stderr.write(`${starts.length} starts\n`);
const rows = [];
for (const s of starts) {
  const ship = projectPitcher({ ...s.input, fit: CTL_FIT });
  const raw = projectPitcher({ ...s.input, fit: RAW_FIT });
  const app = appearancesBefore(pitcherLogs.get(s.id) || [], s.date);
  const s26 = s.input.season26 || {};
  const s25 = s.input.season25 || {};
  const l3 = app.slice(-3);
  // sd of the shipped outs PMF, from its own survival function
  let m1 = 0, m2 = 0;
  for (let k = 0; k <= 27; k++) {
    const p = Math.max(0, (k === 0 ? 1 : ship.dist.outs(k - 0.5)) - ship.dist.outs(k + 0.5));
    m1 += p * k; m2 += p * k * k;
  }
  rows.push({
    d: s.date, id: s.id, g: s.gamePk,
    raw: Math.round(1e4 * raw.projOuts) / 1e4,
    ship: Math.round(1e4 * ship.projOuts) / 1e4,
    sd: Math.round(1e3 * Math.sqrt(Math.max(0, m2 - m1 * m1))) / 1e3,
    ip: Math.round(1e3 * ship.projIP) / 1e3,
    a: s.actual.outs, ak: s.actual.k,
    kraw: Math.round(1e4 * raw.projK) / 1e4, kship: Math.round(1e4 * ship.projK) / 1e4,
    // v37's own outs ladder, so --report can print the calibration gap of a
    // slice without re-projecting it.
    lad: OUTS_LINES.map((l) => Math.round(1e5 * ship.dist.outs(l)) / 1e5),
    nApp: app.length,
    l3max: l3.length ? Math.max(...l3.map((x) => x.outs)) : null,
    // longest outing in the last 1..6 appearances, for the window sweep
    wmax: [1, 2, 3, 4, 5, 6].map((w) => {
      const s2 = app.slice(-w);
      return s2.length ? Math.max(...s2.map((x) => x.outs)) : null;
    }),
    l3maxPit: l3.length ? Math.max(...l3.map((x) => x.pitches)) : null,
    l3gs: l3.reduce((a2, x) => a2 + (x.gs > 0 ? 1 : 0), 0),
    gs26: Number(s26.gamesStarted || 0), gp26: Number(s26.gamesPlayed || 0),
    gs25: Number(s25.gamesStarted || 0), gp25: Number(s25.gamesPlayed || 0),
  });
}
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.stderr.write(`wrote ${rows.length} to ${OUT}\n`);
}

// ── the diagnosis, printed from the rows above ──────────────────────────────
//
//   node tools/opener-fit.mjs --report .work/orf_25.ndjson .work/orf_26.ndjson
//
// Everything docs/OPENER-FIX.md claims about WHY the model was wrong comes out
// of here, on the FIT split only.
export function report(rows, until = '2026-08-10') {
  const FIT = rows.filter((r) => r.d < until);
  const cls = (r) => (r.l3max == null ? 'debut' : r.l3max <= 6 ? 'opener' : 'starter');
  const line = (lab, rs) => {
    const mr = rs.reduce((a, r) => a + r.raw, 0) / rs.length;
    const ms = rs.reduce((a, r) => a + r.ship, 0) / rs.length;
    const ma = rs.reduce((a, r) => a + r.a, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, r) => a + (r.a - ma) ** 2, 0) / rs.length);
    const msd = rs.reduce((a, r) => a + r.sd, 0) / rs.length;
    console.log(
      `  ${lab.padEnd(26)} n=${String(rs.length).padStart(4)}  raw ${mr.toFixed(2)}  v37 ${ms.toFixed(2)}` +
      `  actual ${ma.toFixed(2)}  bias ${ma - ms >= 0 ? '+' : ''}${(ma - ms).toFixed(2)}` +
      `  model sd ${msd.toFixed(2)} vs realised ${sd.toFixed(2)}`,
    );
  };
  /** actual ~ raw by least squares, in the model's own [anchor, slope, level] form. */
  const fit = (rs, anchor = 15.5) => {
    const n = rs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const r of rs) { sx += r.raw; sy += r.a; sxx += r.raw * r.raw; sxy += r.raw * r.a; }
    const b1 = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const b0 = (sy - b1 * sx) / n;
    const l = b0 / anchor + b1;
    return [anchor, +(b1 / l).toFixed(4), +l.toFixed(4)];
  };

  console.log(`\nFIT split: ${FIT.length} starts (2025 entire + 2026 through ${until} exclusive)\n`);
  console.log('v37, by the projection it makes — one line through two populations:');
  for (const [lo, hi] of [[0, 8], [8, 11], [11, 13], [13, 14], [14, 15], [15, 16], [16, 17], [17, 30]]) {
    const rs = FIT.filter((r) => r.ship >= lo && r.ship < hi);
    if (rs.length >= 50) line(`v37 says ${lo}-${hi} outs`, rs);
  }
  console.log('\nthe two populations, read off his own last three appearances:');
  for (const c of ['opener', 'starter', 'debut']) line(c, FIT.filter((r) => cls(r) === c));
  const gap = (rs) => {
    let p = 0, o = 0, n = 0;
    for (const r of rs) {
      if (!r.lad) continue;
      OUTS_LINES.forEach((l, i) => { p += r.lad[i]; o += r.a > l ? 1 : 0; n++; });
    }
    return n ? (100 * (p - o)) / n : NaN;
  };
  // The same cut `tools/accuracy-report.mjs`'s p.length slice uses.
  const short = FIT.filter((r) => r.ip != null && r.ip < 4.5);
  if (short.length && short[0].lad) {
    console.log(`\nwhere v37's short slice (n=${short.length}) actually loses its ${gap(short).toFixed(1)}-point gap:`);
    for (const [lab, f] of [
      ['a genuine relief start (l3 max <= 6 outs)', (r) => r.l3max != null && r.l3max <= 6],
      ['l3 max 7-11 outs', (r) => r.l3max > 6 && r.l3max <= 11],
      ['l3 max 12+, or no appearance at all', (r) => r.l3max == null || r.l3max > 11],
    ]) {
      const rs = short.filter(f);
      console.log(
        `  ${lab.padEnd(42)} n=${String(rs.length).padStart(3)} (${((100 * rs.length) / short.length).toFixed(0)}%)` +
        `  gap ${gap(rs) >= 0 ? '+' : ''}${gap(rs).toFixed(1)}`,
      );
    }
  }
  console.log('\nthe shrink each one wants, fitted on RAW (actual ~ raw, least squares):');
  console.log(`  all together (what v37 has)  ${JSON.stringify(fit(FIT))}`);
  for (const c of ['opener', 'starter', 'debut']) {
    console.log(`  ${c.padEnd(27)} ${JSON.stringify(fit(FIT.filter((r) => cls(r) === c), c === 'opener' ? 6 : 15.5))}`);
  }
  console.log('\ndetector threshold sweep (longest of the last `w` appearances <= `th`):');
  for (const w of [1, 2, 3, 4, 5, 6]) {
    const out = [];
    for (const th of [3, 4, 5, 6, 7, 8, 9]) {
      const sel = FIT.filter((r) => r.wmax[w - 1] != null && r.wmax[w - 1] <= th);
      const rest = FIT.filter((r) => r.wmax[w - 1] != null && r.wmax[w - 1] > th);
      out.push(`${th}: n=${String(sel.length).padStart(3)} slope ${fit(rest)[1].toFixed(3)}`);
    }
    console.log(`  w=${w}  ${out.join('  ')}`);
  }
}

if (process.argv.includes('--report')) {
  const files = process.argv.filter((a) => a.endsWith('.ndjson'));
  const rows = [];
  for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l));
  report(rows);
}
