// Fit and check the walks environment term. Prints everything it fits.
//
//   node tools/walks-fit.mjs --from 2025-03-20 --to 2025-10-01 --out .work/bb_25.ndjson
//   node tools/walks-fit.mjs --from 2026-03-20 --to 2026-09-22 --out .work/bb_26.ndjson
//
//   node tools/walks-fit.mjs --shape   .work/bb_2*.ndjson  # what the data says
//   node tools/walks-fit.mjs --which   .work/bb_2*.ndjson  # level or shrinkage timing
//   node tools/walks-fit.mjs --why     .work/bb_2*.ndjson  # calendar or start count
//   node tools/walks-fit.mjs --markets .work/bb_2*.ndjson  # BB alone? HBP? K?
//   node tools/walks-fit.mjs --weather .work/bb_2*.ndjson  # temperature
//   node tools/walks-fit.mjs --band    .work/bb_2*.ndjson  # the 4.9-5.5 IP band
//   node tools/walks-fit.mjs --league  .work/bb_2*.ndjson  # the league curve, and the fit
//   node tools/walks-fit.mjs --fit     .work/bb_2*.ndjson  # refit on the residual, and OOS
//   node tools/walks-fit.mjs --month   .work/bb_2*.ndjson  # before/after by month
//   node tools/walks-fit.mjs --window  .work/bb_2*.ndjson  # before/after by split
//
// `--league` reads only the cached team hitting logs, so any one row file will
// do as its argument; the others read the rows.
//
// Same shape as `tools/rest-fit.mjs` and `tools/opener-fit.mjs`: one row per
// start, written by the existing lookahead-free replay in
// `tools/backtest-pitchers.mjs`. No new replay. `--ship '{"early":null}'` writes
// the rows a tree WITHOUT the term would write, which is how the fit is
// reproduced after it has shipped.
//
// Two things this tool fetches that the replay does not, both free and public
// and both cached beside it:
//   - the PRIOR season's team hitting logs, from the same unmetered StatsAPI,
//     which give the league walk rate the pitcher's prior-season book was
//     actually accumulated under. Research only: the shipped term never reads
//     it, and it could not — it is not an input `projectPitcher` has (--fit).
//   - first-pitch temperature, from the Open-Meteo reanalysis archive, one
//     request per park per season, matched by the first-pitch hour exactly as
//     tools/game-features-asof.mjs does it. Research only; `projectPitcher`
//     has no weather input and this branch does not give it one. Pass
//     `--temps` when writing rows or the column is empty.
import fs from 'node:fs';
import path from 'node:path';
import { buildStarts, pitcherLogs, teamLogs, schedule } from './backtest-pitchers.mjs';
import { projectPitcher, PITCHER_FIT } from '../src/model/pitcher.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', null);
const MODES = ['shape', 'which', 'markets', 'weather', 'why', 'band', 'league', 'fit', 'month', 'window'];
const REPORT = MODES.some((m) => process.argv.includes(`--${m}`));
const CACHE = arg('cache', path.resolve('.backtest-cache'));
const API = 'https://statsapi.mlb.com/api/v1';

/** The model as this working tree ships it, plus any `--ship` override. */
const SHIP_FIT = { ...PITCHER_FIT, ...(arg('ship', null) ? JSON.parse(arg('ship')) : {}) };
/** The control: master, i.e. no environment term. */
const CTL_FIT = { ...PITCHER_FIT, early: null };

const r5 = (x) => (Number.isFinite(x) ? Math.round(1e5 * x) / 1e5 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(1e3 * x) / 1e3 : null);
const pad = (s, n) => String(s).padEnd(n);
const num = (x, d = 3, n = 8) => (Number.isFinite(x) ? x.toFixed(d) : '–').padStart(n);

// ── row writing ─────────────────────────────────────────────────────────────
async function cached(name, url) {
  const file = path.join(CACHE, name.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const body = await res.json();
      fs.writeFileSync(file, JSON.stringify(body));
      return body;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

async function writeRows() {
  const FROM = arg('from', '2026-03-20');
  const SEASON = Number(FROM.slice(0, 4));
  const SP_TO_LEAGUE_BB = 0.9266;

  // The PRIOR season's league walk rate, whole season, the same way
  // `backtest-pitchers.mjs` builds the current one. This is the environment a
  // pitcher's `season25` line was accumulated in, and it is what `--which`
  // needs to tell a stale prior from a calendar effect. It costs 30 requests.
  let prevPa = 0, prevBb = 0;
  const teamIds = [...teamLogs.keys()];
  for (const id of teamIds) {
    const body = await cached(
      `teamhit_${id}_${SEASON - 1}`,
      `${API}/teams/${id}/stats?stats=gameLog&group=hitting&season=${SEASON - 1}`,
    );
    for (const s of body.stats?.[0]?.splits || []) {
      prevPa += Number(s.stat.plateAppearances || 0);
      prevBb += Number(s.stat.baseOnBalls || 0);
    }
  }
  const lgPrevSp = prevPa ? (prevBb / prevPa) * SP_TO_LEAGUE_BB : null;
  process.stderr.write(`${SEASON - 1} league starter BB/BF ${lgPrevSp?.toFixed(5)} over ${prevPa} PA\n`);

  // First-pitch temperature, from the Open-Meteo reanalysis archive, one
  // request per park per season and matched back by the first-pitch hour —
  // exactly the way `tools/game-features-asof.mjs` builds the game model's
  // weather, and for the same reason: a per-game boxscore fetch would be 2,400
  // multi-megabyte requests a season. Research only; `projectPitcher` has no
  // weather input and this branch does not give it one.
  const WANT_TEMP = process.argv.includes('--temps');
  const tempByGame = new Map();
  if (WANT_TEMP) {
    const gamesByVenue = new Map();
    for (const d of schedule.dates) {
      for (const g of d.games) {
        if (!g.venue?.id || !g.gameDate) continue;
        if (!gamesByVenue.has(g.venue.id)) gamesByVenue.set(g.venue.id, []);
        gamesByVenue.get(g.venue.id).push(g);
      }
    }
    // The reanalysis archive stops a couple of days short of today, so the
    // window is clipped rather than requested and refused.
    const yesterday = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const END_WX = `${SEASON}-10-05` < yesterday ? `${SEASON}-10-05` : yesterday;
    const venueIds = [...gamesByVenue.keys()];
    const venueBody = await cached(
      `venues_${SEASON}_${venueIds.length}`,
      `${API}/venues?venueIds=${venueIds.join(',')}&hydrate=location,fieldInfo`,
    );
    const coords = new Map((venueBody.venues || []).map((v) => [v.id, v.location?.defaultCoordinates]));
    const roofs = new Map((venueBody.venues || []).map((v) => [v.id, v.fieldInfo?.roofType || null]));
    let vi = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (vi < venueIds.length) {
        const id = venueIds[vi++];
        const c = coords.get(id);
        if (!c?.latitude) continue;
        const url = 'https://archive-api.open-meteo.com/v1/archive'
          + `?latitude=${c.latitude}&longitude=${c.longitude}`
          + `&start_date=${SEASON}-03-15&end_date=${END_WX}`
          + '&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC';
        try {
          const body = await cached(`om_arch_${id}_${SEASON}`, url);
          const idx = new Map((body.hourly?.time || []).map((t, i) => [t, i]));
          for (const g of gamesByVenue.get(id)) {
            const i = idx.get(`${new Date(g.gameDate).toISOString().slice(0, 13)}:00`);
            if (i == null) continue;
            tempByGame.set(g.gamePk, {
              temp: Math.round(body.hourly.temperature_2m[i]),
              roof: roofs.get(id),
            });
          }
        } catch { /* a park with no archive simply has no temperature */ }
      }
    }));
    process.stderr.write(`temperature for ${tempByGame.size} games\n`);
  }

  const starts = buildStarts();
  process.stderr.write(`${starts.length} starts\n`);

  const rows = [];
  for (const s of starts) {
    const ctl = projectPitcher({ ...s.input, fit: CTL_FIT });
    const now = projectPitcher({ ...s.input, fit: SHIP_FIT });
    const log = pitcherLogs.get(s.id) || [];
    const g = log.find((x) => x.date === s.date && Number(x.stat.gamesStarted) === 1);
    const wx = tempByGame.get(s.gamePk) || {};
    const yr = Number(s.date.slice(0, 4));
    const doy = Math.round((Date.parse(`${s.date}T00:00:00Z`) - Date.parse(`${yr}-03-20T00:00:00Z`)) / 864e5);
    rows.push({
      d: s.date, id: s.id, g: s.gamePk, doy,
      // The as-of league starter walk rate the model itself was handed, and
      // the prior season's whole-season one it was not.
      lgNow: r5(s.input.lg?.spBbRate),
      lgPrev: r5(lgPrevSp),
      // How much current-season book he has, and how much prior-season. These
      // are the two denominators `shrunkRate` blends at 1 and 0.6.
      bf26: s.input.season26?.battersFaced || 0,
      bf25: s.input.season25?.battersFaced || 0,
      bb26: s.input.season26?.baseOnBalls || 0,
      bb25: s.input.season25?.baseOnBalls || 0,
      gs26: s.input.season26?.gamesStarted || 0,
      // Rate before and after the environment term, and the projections.
      rateC: r5(ctl.rates.bbRate), rateN: r5(now.rates.bbRate),
      adjC: r5(ctl.rates.adjBB), adjN: r5(now.rates.adjBB),
      bf: r3(ctl.projBF),
      bbC: r3(ctl.projBB), bbN: r3(now.projBB),
      kC: r3(ctl.projK), kN: r3(now.projK),
      hC: r3(ctl.projH), hN: r3(now.projH),
      erC: r3(ctl.projER), erN: r3(now.projER),
      outsC: r3(ctl.projOuts), outsN: r3(now.projOuts),
      // What happened, including the two the replay's `actual` leaves out.
      bbA: s.actual.bb, kA: s.actual.k, hA: s.actual.hits, erA: s.actual.er, outsA: s.actual.outs,
      bfA: Number(g?.stat?.battersFaced || 0),
      hbpA: Number(g?.stat?.hitByPitch || 0),
      temp: wx.temp ?? null,
      roof: wx.roof ?? null,
      // Ladder of both trees, so a slice's calibration gap needs no re-projection.
      ladC: BB_LINES.map((l) => Math.round(1e5 * ctl.dist.bb(l)) / 1e5),
      ladN: BB_LINES.map((l) => Math.round(1e5 * now.dist.bb(l)) / 1e5),
    });
  }
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    process.stderr.write(`wrote ${rows.length} rows to ${OUT}\n`);
  }
}

/** The walks ladder `tools/accuracy-report.mjs` scores. */
const BB_LINES = [0.5, 1.5, 2.5, 3.5];

// ── shared reporting helpers ────────────────────────────────────────────────
/** FIT split: 2025 entire plus 2026 through 2026-08-09. */
const isFit = (r) => r.d < '2026-08-10';
const isVal = (r) => r.d >= '2026-08-10' && r.d <= '2026-09-01';
const monthOf = (r) => r.d.slice(0, 7);

/** Ladder gap in points: mean quoted P(over) minus observed, over the ladder. */
function ladderGap(rows, key = 'ladC') {
  let sp = 0, so = 0, n = 0;
  for (const r of rows) {
    const lad = r[key];
    if (!lad) continue;
    for (let i = 0; i < BB_LINES.length; i++) {
      sp += lad[i];
      so += r.bbA > BB_LINES[i] ? 1 : 0;
      n++;
    }
  }
  return n ? (100 * (sp - so)) / n : NaN;
}

/** Calibration error the way accuracy-report computes it: |quoted-observed|. */
function ece(rows, key = 'ladC') {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, o: 0, n: 0 }));
  let n = 0;
  for (const r of rows) {
    const lad = r[key];
    if (!lad) continue;
    for (let i = 0; i < BB_LINES.length; i++) {
      const b = bins[Math.min(9, Math.floor(lad[i] * 10))];
      b.p += lad[i]; b.o += r.bbA > BB_LINES[i] ? 1 : 0; b.n++; n++;
    }
  }
  return n ? (100 * bins.reduce((a, b) => a + (b.n ? Math.abs(b.p - b.o) : 0), 0)) / n : NaN;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const se = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1) / xs.length);
};

/** Weight of the CURRENT season in `shrunkRate`'s two-season blend. */
const w26 = (r) => (r.bf26 || 0) / ((r.bf26 || 0) + 0.6 * (r.bf25 || 0) || 1);

// ── --shape: what the data says ─────────────────────────────────────────────
function shape(rows) {
  console.log('\n### Walks by month — the model against what happened\n');
  console.log('  month     n     proj   actual     bias     ±se     ratio   lgNow(sp)  lgNow/lgPrev');
  const months = [...new Set(rows.map(monthOf))].sort();
  for (const m of months) {
    const g = rows.filter((r) => monthOf(r) === m);
    const d = g.map((r) => r.bbA - r.bbC);
    console.log(
      `  ${m} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbA)))}`
      + ` ${num(mean(d))} ${num(se(d), 3, 7)} ${num(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC)), 4, 9)}`
      + ` ${num(mean(g.map((r) => r.lgNow)), 5, 10)} ${num(mean(g.map((r) => r.lgNow / r.lgPrev)), 4, 13)}`,
    );
  }
  console.log('\n### By days into the season (from March 20)\n');
  console.log('  window      n     proj   actual     bias     ±se    ratio     w26   lgNow/lgPrev  2025    2026');
  const bands = [[0, 7], [8, 14], [15, 21], [22, 30], [31, 45], [46, 60], [61, 90], [91, 120], [121, 200]];
  for (const [lo, hi] of bands) {
    const g = rows.filter((r) => r.doy >= lo && r.doy <= hi);
    if (!g.length) continue;
    const d = g.map((r) => r.bbA - r.bbC);
    const y = (s) => {
      const q = g.filter((r) => r.d.startsWith(s));
      return q.length ? mean(q.map((r) => r.bbA - r.bbC)) : NaN;
    };
    console.log(
      `  ${pad(`${lo}-${hi}`, 8)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbA)))}`
      + ` ${num(mean(d))} ${num(se(d), 3, 7)} ${num(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC)), 4, 8)}`
      + ` ${num(mean(g.map(w26)), 3, 7)} ${num(mean(g.map((r) => r.lgNow / r.lgPrev)), 4, 13)} ${num(y('2025'), 3, 7)} ${num(y('2026'), 3, 7)}`,
    );
  }
}

// ── --which: a level shift, or a shrinkage-timing problem? ──────────────────
function which(rows) {
  console.log('\n### Bias by how much CURRENT-season book he has, within each window\n');
  console.log('  A shrinkage-timing story says the miss belongs to the thin column and');
  console.log('  decays across it. A level story says the whole row moves together.\n');
  const cols = [[0, 0.001], [0.001, 0.15], [0.15, 0.35], [0.35, 0.6], [0.6, 1.01]];
  const bands = [[0, 21], [22, 45], [46, 90], [91, 200]];
  console.log(`  ${pad('window', 9)}` + cols.map(([a, b]) => pad(`w26 ${a}-${b > 1 ? 1 : b}`, 16)).join(''));
  for (const [lo, hi] of bands) {
    let line = `  ${pad(`${lo}-${hi}d`, 9)}`;
    for (const [a, b] of cols) {
      const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && w26(r) >= a && w26(r) < b);
      const d = g.map((r) => r.bbA - r.bbC);
      line += pad(g.length ? `${mean(d) >= 0 ? '+' : ''}${mean(d).toFixed(3)} (${g.length})` : '– ', 16);
    }
    console.log(line);
  }

  console.log('\n### The same cut, as a ratio of actual to projected\n');
  console.log(`  ${pad('window', 9)}` + cols.map(([a, b]) => pad(`w26 ${a}-${b > 1 ? 1 : b}`, 16)).join(''));
  for (const [lo, hi] of bands) {
    let line = `  ${pad(`${lo}-${hi}d`, 9)}`;
    for (const [a, b] of cols) {
      const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && w26(r) >= a && w26(r) < b);
      line += pad(g.length ? `${(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC))).toFixed(3)} (${g.length})` : '– ', 16);
    }
    console.log(line);
  }

  console.log('\n### Is it the LEAGUE or the PITCHER? realised league BB/BF against the model\n');
  console.log('  "league" is every start in the window pooled: total walks over total');
  console.log('  batters faced. "model" is the same pool of projections over the same');
  console.log('  batters faced, so the two are the same quantity computed two ways.\n');
  console.log('  window      n      BF   league BB/BF   model BB/BF   ratio    lgNow    lgPrev');
  for (const [lo, hi] of [[0, 7], [8, 14], [15, 21], [22, 30], [31, 45], [46, 60], [61, 90], [91, 120], [121, 200]]) {
    const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && r.bfA > 0);
    if (!g.length) continue;
    const bfA = g.reduce((a, r) => a + r.bfA, 0);
    const bbA = g.reduce((a, r) => a + r.bbA, 0);
    // The model's rate over the SAME realised batters, so depth cannot confound.
    const mod = g.reduce((a, r) => a + r.adjC * r.bfA, 0) / bfA;
    console.log(
      `  ${pad(`${lo}-${hi}`, 8)} ${String(g.length).padStart(5)} ${String(bfA).padStart(7)}`
      + ` ${num(bbA / bfA, 5, 14)} ${num(mod, 5, 13)} ${num(bbA / bfA / mod, 4, 8)}`
      + ` ${num(mean(g.map((r) => r.lgNow)), 5, 8)} ${num(mean(g.map((r) => r.lgPrev)), 5, 9)}`,
    );
  }

  console.log('\n### Does the miss track the league environment ratio?\n');
  console.log('  For each start, `envRatio` is tonight\'s as-of league starter walk rate');
  console.log('  over the environment his own book was accumulated in:');
  console.log('      lgHist = w26 * lgNow + (1 - w26) * lgPrev');
  console.log('  With the true prior-season league rate, and pooled over both seasons.\n');
  console.log('  envRatio       n     proj   actual    ratio   pred    2025 ratio  2026 ratio');
  const er = (r) => r.lgNow / (w26(r) * r.lgNow + (1 - w26(r)) * r.lgPrev);
  for (const [lo, hi] of [[0, 0.98], [0.98, 1.0], [1.0, 1.02], [1.02, 1.05], [1.05, 1.08], [1.08, 1.12], [1.12, 1.2], [1.2, 9]]) {
    const g = rows.filter((r) => er(r) >= lo && er(r) < hi);
    if (g.length < 30) continue;
    const y = (s) => {
      const q = g.filter((r) => r.d.startsWith(s));
      return q.length > 20 ? mean(q.map((r) => r.bbA)) / mean(q.map((r) => r.bbC)) : NaN;
    };
    console.log(
      `  ${pad(`${lo}-${hi}`, 12)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbA)))}`
      + ` ${num(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC)), 4, 8)} ${num(mean(g.map(er)), 4, 7)}`
      + ` ${num(y('2025'), 4, 11)} ${num(y('2026'), 4, 11)}`,
    );
  }
}

// ── --markets: walks alone? HBP too? strikeouts the mirror? ─────────────────
function markets(rows) {
  console.log('\n### Every pitcher market by window, actual over projected\n');
  console.log('  HBP has no projection of its own — the model carries it as a constant');
  console.log('  per batter faced (HBP_PER_BF) — so its column is the realised rate');
  console.log('  against that constant, 0.011.\n');
  const HBP_PER_BF = 0.011;
  console.log('  window      n     walks      K      hits      ER      outs    BB+HBP    HBP/BF vs const');
  for (const [lo, hi] of [[0, 7], [8, 14], [15, 21], [22, 30], [31, 45], [46, 60], [61, 90], [91, 120], [121, 200]]) {
    const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && r.bfA > 0);
    if (!g.length) continue;
    const R = (a, b) => mean(g.map((r) => r[a])) / mean(g.map((r) => r[b]));
    const bfA = g.reduce((a, r) => a + r.bfA, 0);
    const hbp = g.reduce((a, r) => a + r.hbpA, 0) / bfA;
    const bbh = mean(g.map((r) => r.bbA + r.hbpA)) / mean(g.map((r) => r.bbC + HBP_PER_BF * r.bf));
    console.log(
      `  ${pad(`${lo}-${hi}`, 8)} ${String(g.length).padStart(5)} ${num(R('bbA', 'bbC'), 4, 8)} ${num(R('kA', 'kC'), 4, 8)}`
      + ` ${num(R('hA', 'hC'), 4, 8)} ${num(R('erA', 'erC'), 4, 8)} ${num(R('outsA', 'outsC'), 4, 8)}`
      + ` ${num(bbh, 4, 9)} ${num(hbp / HBP_PER_BF, 4, 15)}`,
    );
  }
}

// ── --weather: does the walk rate respond to temperature? ───────────────────
function weather(rows) {
  const g0 = rows.filter((r) => Number.isFinite(r.temp) && r.bfA > 0);
  if (!g0.length) return console.log('\nno temperatures in these rows — re-write them with --temps\n');
  console.log(`\n### Walks against recorded game-time temperature, ${g0.length} starts\n`);
  console.log('   tempF       n     proj   actual    ratio      BB/BF   mean doy   share April');
  for (const [lo, hi] of [[-99, 45], [45, 52], [52, 60], [60, 68], [68, 75], [75, 82], [82, 200]]) {
    const g = g0.filter((r) => r.temp >= lo && r.temp < hi);
    if (g.length < 40) continue;
    const bfA = g.reduce((a, r) => a + r.bfA, 0);
    console.log(
      `  ${pad(`${lo < 0 ? '<' : lo}-${hi > 100 ? '+' : hi}`, 8)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))}`
      + ` ${num(mean(g.map((r) => r.bbA)))} ${num(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC)), 4, 8)}`
      + ` ${num(g.reduce((a, r) => a + r.bbA, 0) / bfA, 5, 10)} ${num(mean(g.map((r) => r.doy)), 0, 10)}`
      + ` ${num(g.filter((r) => r.doy <= 45).length / g.length, 3, 12)}`,
    );
  }
  console.log('\n### Temperature CONTROLLING for the calendar, and the calendar for temperature\n');
  console.log('  Each cell is the ratio of actual walks to projected, with n.\n');
  const tb = [[-99, 55], [55, 68], [68, 78], [78, 200]];
  console.log(`  ${pad('doy', 9)}` + tb.map(([a, b]) => pad(`${a < 0 ? '<' : a}-${b > 100 ? '+' : b}F`, 15)).join(''));
  for (const [lo, hi] of [[0, 21], [22, 45], [46, 90], [91, 200]]) {
    let line = `  ${pad(`${lo}-${hi}d`, 9)}`;
    for (const [a, b] of tb) {
      const g = g0.filter((r) => r.doy >= lo && r.doy <= hi && r.temp >= a && r.temp < b);
      line += pad(g.length >= 30 ? `${(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC))).toFixed(3)} (${g.length})` : '– ', 15);
    }
    console.log(line);
  }
}

// ── --league: the league's own seasonal walk curve, and the fit to it ───────
/**
 * The shipped shape: a plateau and a ramp in days since March 20. `1 + amp`
 * through `hold`, straight down to exactly 1 at `cap`, and exactly 1 from
 * there on, so nothing outside the early window moves at all. The same shape
 * `PITCHER_FIT.rest` uses, pointing the other way.
 */
export const earlyMul = (doy, amp, hold, cap) => {
  if (!(amp > 0) || !(cap > hold)) return 1;
  const d = Math.max(doy, 0);
  if (d >= cap) return 1;
  return 1 + amp * (d <= hold ? 1 : (cap - d) / (cap - hold));
};
/** The exponential alternative `--league` measures the ramp against. */
const expMul = (doy, amp, tau, cap) => {
  if (!(amp > 0) || !(tau > 0) || !(cap > 0)) return 1;
  const d = Math.min(Math.max(doy, 0), cap);
  const e = Math.exp(-cap / tau);
  return 1 + amp * ((Math.exp(-d / tau) - e) / (1 - e));
};

/** League BB/PA by day of season, from the team hitting logs already cached. */
function leagueCurve(seasons) {
  const out = new Map();
  for (const yr of seasons) {
    const days = new Map();
    let pa = 0, bb = 0;
    const files = fs.readdirSync(CACHE).filter((x) => x.startsWith('teamhit_') && x.endsWith(`${yr}.json`));
    if (!files.length) continue;
    for (const f of files) {
      const body = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
      for (const s of body.stats?.[0]?.splits || []) {
        const doy = Math.round((Date.parse(`${s.date}T00:00:00Z`) - Date.parse(`${yr}-03-20T00:00:00Z`)) / 864e5);
        const p = Number(s.stat.plateAppearances || 0);
        const w = Number(s.stat.baseOnBalls || 0);
        pa += p; bb += w;
        const o = days.get(doy) || { pa: 0, bb: 0 };
        o.pa += p; o.bb += w; days.set(doy, o);
      }
    }
    out.set(yr, { days, rate: bb / pa, pa });
  }
  return out;
}

function leagueReport() {
  const seasons = [2024, 2025, 2026];
  const curve = leagueCurve(seasons);
  const have = [...curve.keys()];
  console.log(`\n### The league's own walk rate by day of season, ${have.join(' / ')}\n`);
  console.log('  Every plate appearance in the majors, not just the ones in a start this');
  console.log('  replay scores. Each cell is that band\'s BB/PA over the SEASON\'s own');
  console.log('  BB/PA, so a between-season difference in the level cannot appear here.');
  console.log('  2024 is in the table and in the fit and is out of sample twice over:');
  console.log('  no 2024 game is an outcome this model is ever scored against.\n');
  for (const yr of have) console.log(`    ${yr} season BB/PA ${curve.get(yr).rate.toFixed(5)} over ${curve.get(yr).pa} PA`);
  const bands = [[0, 3], [4, 7], [8, 11], [12, 15], [16, 21], [22, 28], [29, 35], [36, 45],
    [46, 55], [56, 70], [71, 90], [91, 120], [121, 160], [161, 220]];
  console.log(`\n  doy band  ${have.map((y) => String(y).padStart(9)).join(' ')}    pooled      PA/yr`);
  const pooled = [];
  for (const [lo, hi] of bands) {
    const per = have.map((yr) => {
      const c = curve.get(yr);
      let pa = 0, bb = 0;
      for (let d = lo; d <= hi; d++) { const o = c.days.get(d); if (o) { pa += o.pa; bb += o.bb; } }
      return pa ? { idx: (bb / pa) / c.rate, pa } : null;
    });
    const pa = per.reduce((a, x) => a + (x?.pa || 0), 0);
    if (!pa) continue;
    const idx = per.reduce((a, x) => a + (x ? x.idx * x.pa : 0), 0) / pa;
    pooled.push({ mid: (lo + hi) / 2, idx, pa });
    console.log(
      `  ${pad(`${lo}-${hi}`, 9)} ${per.map((x) => num(x?.idx, 4, 9)).join(' ')} ${num(idx, 4, 9)} ${String(Math.round(pa / have.length)).padStart(10)}`,
    );
  }
  // The far field: the level the curve settles at, taken as the PA-weighted
  // mean from `farFrom` days on. Everything is expressed against THIS, not
  // against the season average, because the season average is itself pulled up
  // by the early weeks and the model's baseline is not.
  const FAR = 75;
  const far = (() => {
    let pa = 0, s = 0;
    for (const p of pooled) if (p.mid >= FAR) { pa += p.pa; s += p.idx * p.pa; }
    return s / pa;
  })();
  console.log(`\n  far field (day ${FAR}+), PA-weighted: ${far.toFixed(4)} of the season average`);
  console.log('  rebased to it, the early bands read:');
  console.log('    ' + pooled.filter((p) => p.mid < FAR).map((p) => `${p.mid}: ${(p.idx / far).toFixed(3)}`).join('  '));

  // Weighted least squares of the rebased daily curve on the shipped shape.
  console.log('\n### The fit, on the LEAGUE curve — not on any model residual\n');
  console.log('  Weighted least squares of the daily rebased index on');
  console.log('  1 + amp * (exp(-d/tau) - exp(-cap/tau)) / (1 - exp(-cap/tau)),');
  console.log('  weights = plate appearances. Every day of every season in one pass.\n');
  const pts = [];
  for (const yr of have) {
    const c = curve.get(yr);
    for (const [d, o] of c.days) {
      if (d < 0 || o.pa < 200) continue;
      pts.push({ d, y: (o.bb / o.pa) / c.rate / far, w: o.pa, yr });
    }
  }
  const wsse = (g, amp, a, b, f = earlyMul) => g.reduce((s, p) => s + p.w * (p.y - f(p.d, amp, a, b)) ** 2, 0);
  const bestAmp = (g, a, b, f = earlyMul) => {
    // Linear in amp: closed form.
    let n2 = 0, den = 0;
    for (const p of g) {
      const k = f(p.d, 1, a, b) - 1;
      n2 += p.w * k * (p.y - 1); den += p.w * k * k;
    }
    return den > 0 ? n2 / den : 0;
  };
  const seOf = (g, amp, a, b, f = earlyMul) => {
    let den = 0;
    for (const p of g) { const k = f(p.d, 1, a, b) - 1; den += p.w * k * k; }
    return Math.sqrt((wsse(g, amp, a, b, f) / Math.max(1, g.length - 1)) / den);
  };
  console.log('  hold   cap      amp        se       t     2024     2025     2026    wSSE');
  for (const hold of [14, 21, 25, 28, 32]) {
    for (const cap of [40, 45, 50, 55]) {
      if (cap <= hold) continue;
      const amp = bestAmp(pts, hold, cap);
      const per = have.map((yr) => bestAmp(pts.filter((p) => p.yr === yr), hold, cap));
      console.log(
        `  ${String(hold).padStart(4)} ${String(cap).padStart(5)} ${num(amp, 4, 8)} ${num(seOf(pts, amp, hold, cap), 4, 9)}`
        + ` ${num(amp / seOf(pts, amp, hold, cap), 1, 7)} ${per.map((x) => num(x, 4, 8)).join(' ')}`
        + ` ${num(wsse(pts, amp, hold, cap), 2, 8)}`,
      );
    }
  }
  console.log('\n  The exponential alternative, same data, same weights:');
  console.log('   cap   tau      amp        se       t     2024     2025     2026    wSSE');
  for (const cap of [60, 75]) {
    for (const tau of [14, 20, 30]) {
      const amp = bestAmp(pts, tau, cap, expMul);
      const per = have.map((yr) => bestAmp(pts.filter((p) => p.yr === yr), tau, cap, expMul));
      console.log(
        `  ${String(cap).padStart(4)} ${String(tau).padStart(5)} ${num(amp, 4, 8)} ${num(seOf(pts, amp, tau, cap, expMul), 4, 9)}`
        + ` ${num(amp / seOf(pts, amp, tau, cap, expMul), 1, 7)} ${per.map((x) => num(x, 4, 8)).join(' ')}`
        + ` ${num(wsse(pts, amp, tau, cap, expMul), 2, 8)}`,
      );
    }
  }
  const SHIP = [Number(arg('hold', 25)), Number(arg('cap', 45))];
  const A = bestAmp(pts, SHIP[0], SHIP[1]);
  console.log(`\n  The shipped curve (hold ${SHIP[0]}, cap ${SHIP[1]}, amp ${A.toFixed(4)}) against the bands:`);
  console.log('    doy      observed   fitted');
  for (const p of pooled) {
    if (p.mid > 130) continue;
    console.log(`    ${pad(p.mid, 8)} ${num(p.idx / far, 4, 9)} ${num(earlyMul(p.mid, A, SHIP[0], SHIP[1]), 4, 8)}`);
  }
}

// ── --why: which clock is it on? ────────────────────────────────────────────
function why(rows) {
  console.log('\n### The calendar against the pitcher\'s own start count\n');
  console.log('  "Pitchers are not stretched out" is a clock that runs per pitcher: his');
  console.log('  Nth start of the season, wherever it falls. "The league walks more in');
  console.log('  April" is a clock that runs on the calendar. A man making his second');
  console.log('  start in June — a call-up, or a man off the injured list — separates');
  console.log('  them. Each cell is actual walks over projected, with n.\n');
  const gsb = [[1, 1], [2, 3], [4, 6], [7, 11], [12, 99]];
  console.log(`  ${pad('doy', 10)}` + gsb.map(([a, b]) => pad(a === b ? `start ${a}` : `starts ${a}-${b > 90 ? '+' : b}`, 15)).join(''));
  for (const [lo, hi] of [[0, 21], [22, 45], [46, 90], [91, 200]]) {
    let line = `  ${pad(`${lo}-${hi}d`, 10)}`;
    for (const [a, b] of gsb) {
      const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && r.gs26 + 1 >= a && r.gs26 + 1 <= b);
      line += pad(g.length >= 25 ? `${(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC))).toFixed(3)} (${g.length})` : `– (${g.length})`, 15);
    }
    console.log(line);
  }

  console.log('\n### Is the seasonal shape a STARTER thing or a LEAGUE thing?\n');
  console.log('  Realised BB/BF over the starts in each window, against the all-pitcher');
  console.log('  BB/PA the same window\'s league carries. If starters alone walked more');
  console.log('  early because they are not stretched out, the ratio would fall.\n');
  console.log('  window      n    starter BB/BF   vs its own season   share of league');
  const byS = {};
  for (const r of rows) {
    const s = r.d.slice(0, 4);
    (byS[s] ||= { bf: 0, bb: 0 });
    byS[s].bf += r.bfA; byS[s].bb += r.bbA;
  }
  for (const [lo, hi] of [[0, 7], [8, 14], [15, 21], [22, 30], [31, 45], [46, 60], [61, 90], [91, 120], [121, 200]]) {
    const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && r.bfA > 0);
    if (!g.length) continue;
    const bf = g.reduce((a, r) => a + r.bfA, 0);
    const bb = g.reduce((a, r) => a + r.bbA, 0);
    // Each season's own full-season starter rate, weighted the way this window
    // mixes the two seasons, so a between-season difference cannot show up here.
    const own = g.reduce((a, r) => a + byS[r.d.slice(0, 4)].bb / byS[r.d.slice(0, 4)].bf, 0) / g.length;
    console.log(
      `  ${pad(`${lo}-${hi}`, 8)} ${String(g.length).padStart(5)} ${num(bb / bf, 5, 14)} ${num(bb / bf / own, 4, 19)}`
      + ` ${num(bb / bf / mean(g.map((r) => r.lgNow)), 4, 16)}`,
    );
  }

  console.log('\n### Does the early-season lift hold once his own book is thick?\n');
  console.log('  Starts by a man with 200+ batters faced ALREADY this season, so the');
  console.log('  projection is mostly his own current-season rate, not last year\'s.\n');
  console.log('  window      n     proj   actual    ratio     2025     2026');
  for (const [lo, hi] of [[0, 45], [46, 90], [91, 200]]) {
    const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && r.bf26 >= 200);
    if (g.length < 30) { console.log(`  ${pad(`${lo}-${hi}`, 8)} ${String(g.length).padStart(5)}   too few`); continue; }
    const y = (s) => {
      const q = g.filter((r) => r.d.startsWith(s));
      return q.length > 20 ? mean(q.map((r) => r.bbA)) / mean(q.map((r) => r.bbC)) : NaN;
    };
    console.log(
      `  ${pad(`${lo}-${hi}`, 8)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbA)))}`
      + ` ${num(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC)), 4, 8)} ${num(y('2025'), 4, 8)} ${num(y('2026'), 4, 8)}`,
    );
  }
}

// ── --band: the 4.9-5.5 innings band, and whether it is the same defect ─────
function band(rows) {
  const ipOf = (r) => r.outsC / 3;
  console.log('\n### Walks by projected innings — the band docs/PITCHER-REPAIR.md named\n');
  console.log('  projIP       n     proj   actual    ratio    gap C    mean doy   share <=45d');
  const bands = [[0, 4.0], [4.0, 4.5], [4.5, 4.9], [4.9, 5.2], [5.2, 5.5], [5.5, 5.8], [5.8, 9]];
  for (const [lo, hi] of bands) {
    const g = rows.filter((r) => ipOf(r) >= lo && ipOf(r) < hi);
    if (g.length < 40) continue;
    console.log(
      `  ${pad(`${lo}-${hi}`, 10)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbA)))}`
      + ` ${num(mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC)), 4, 8)} ${num(ladderGap(g, 'ladC'), 1, 8)}`
      + ` ${num(mean(g.map((r) => r.doy)), 0, 11)} ${num(g.filter((r) => r.doy <= 45).length / g.length, 3, 12)}`,
    );
  }
  console.log('\n### The band against the calendar — one defect, or two?\n');
  console.log('  Each cell is the ladder gap in points, with n. If the band error is the');
  console.log('  April error seen from another angle, the band column empties once the');
  console.log('  early-season rows are taken out of it.\n');
  const ipb = [[0, 4.5], [4.5, 4.9], [4.9, 5.5], [5.5, 9]];
  console.log(`  ${pad('doy', 10)}` + ipb.map(([a, b]) => pad(`IP ${a}-${b > 8 ? '+' : b}`, 16)).join(''));
  for (const [lo, hi] of [[0, 21], [22, 45], [46, 90], [91, 200]]) {
    let line = `  ${pad(`${lo}-${hi}d`, 10)}`;
    for (const [a, b] of ipb) {
      const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && ipOf(r) >= a && ipOf(r) < b);
      line += pad(g.length >= 60 ? `${ladderGap(g, 'ladC') >= 0 ? '+' : ''}${ladderGap(g, 'ladC').toFixed(1)} (${g.length})` : `– (${g.length})`, 16);
    }
    console.log(line);
  }
  console.log('\n### And the same, after the term\n');
  console.log(`  ${pad('doy', 10)}` + ipb.map(([a, b]) => pad(`IP ${a}-${b > 8 ? '+' : b}`, 16)).join(''));
  for (const [lo, hi] of [[0, 21], [22, 45], [46, 90], [91, 200]]) {
    let line = `  ${pad(`${lo}-${hi}d`, 10)}`;
    for (const [a, b] of ipb) {
      const g = rows.filter((r) => r.doy >= lo && r.doy <= hi && ipOf(r) >= a && ipOf(r) < b);
      line += pad(g.length >= 60 ? `${ladderGap(g, 'ladN') >= 0 ? '+' : ''}${ladderGap(g, 'ladN').toFixed(1)} (${g.length})` : `– (${g.length})`, 16);
    }
    console.log(line);
  }
}

// ── --fit: the term ─────────────────────────────────────────────────────────
/**
 * The shipped term's environment ratio, computed from ONLY what
 * `projectPitcher` is handed: the as-of league starter walk rate, and the two
 * season denominators `shrunkRate` blends. `ref` stands in for the league walk
 * environment the prior-season book came from; the fit below sweeps it and
 * reports what the TRUE prior-season rate would have given instead.
 */
const envRatioFrom = (r, ref, priorW = 0.6) => {
  const d26 = r.bf26 || 0;
  const d25 = priorW * (r.bf25 || 0);
  if (d26 + d25 <= 0) return { ratio: r.lgNow / ref, w: 0 };
  const w = d26 / (d26 + d25);
  return { ratio: r.lgNow / (w * r.lgNow + (1 - w) * ref), w };
};

function fitTerm(rows) {
  const fit = rows.filter(isFit);

  // ── the shipped shape, fitted the OTHER way: on this model's own residual ──
  console.log('\n### The shipped ramp, refitted on the model residual instead\n');
  console.log('  The amplitude that ships is fitted on the league curve (--league).');
  console.log('  This is the same shape fitted by least squares of actual walks on');
  console.log('  `bbC * earlyMul(doy, amp, hold, cap)` over the FIT split, which is a');
  console.log('  different target on different data. If the two agree the curve is not');
  console.log('  an artefact of either.\n');
  const ampOn = (g, hold, cap) => {
    // Linear in amp: sum w*(a - p*(1 + amp*k))^2 where k is the ramp in [0,1].
    let n2 = 0, den = 0;
    for (const r of g) {
      const k = r.bbC * (earlyMul(r.doy, 1, hold, cap) - 1);
      n2 += k * (r.bbA - r.bbC); den += k * k;
    }
    return den > 0 ? n2 / den : 0;
  };
  const seOn = (g, amp, hold, cap) => {
    let den = 0, r2 = 0;
    for (const r of g) {
      const k = r.bbC * (earlyMul(r.doy, 1, hold, cap) - 1);
      den += k * k;
      r2 += (r.bbA - r.bbC * earlyMul(r.doy, amp, hold, cap)) ** 2;
    }
    return Math.sqrt((r2 / Math.max(1, g.length - 1)) / den);
  };
  console.log('  hold   cap      amp        se       t     2025     2026   moved');
  for (const hold of [14, 21, 25, 28, 32]) {
    for (const cap of [40, 45, 50, 55]) {
      if (cap <= hold) continue;
      const amp = ampOn(fit, hold, cap);
      console.log(
        `  ${String(hold).padStart(4)} ${String(cap).padStart(5)} ${num(amp, 4, 8)} ${num(seOn(fit, amp, hold, cap), 4, 9)}`
        + ` ${num(amp / seOn(fit, amp, hold, cap), 1, 7)} ${num(ampOn(fit.filter((r) => r.d.startsWith('2025')), hold, cap), 4, 8)}`
        + ` ${num(ampOn(fit.filter((r) => r.d.startsWith('2026')), hold, cap), 4, 8)}`
        + ` ${String(fit.filter((r) => r.doy < cap).length).padStart(7)}`,
      );
    }
  }

  // ── the cross-season test the VALIDATE window cannot run ──────────────────
  console.log('\n### Out of sample across seasons — the only clean test of a calendar term\n');
  console.log('  VALIDATE (2026-08-10..09-01) contains no April, so it cannot test this.');
  console.log('  Fitting the amplitude on ONE season\'s early window and reading the');
  console.log('  OTHER season\'s can, and those are two disjoint sets of starts.\n');
  const H = Number(arg('hold', 25)), C = Number(arg('cap', 45));
  for (const [fitYr, readYr] of [['2025', '2026'], ['2026', '2025']]) {
    const f = fit.filter((r) => r.d.startsWith(fitYr));
    const g = rows.filter((r) => r.d.startsWith(readYr) && r.doy < C);
    const amp = ampOn(f, H, C);
    const before = mean(g.map((r) => r.bbA - r.bbC));
    const after = mean(g.map((r) => r.bbA - r.bbC * earlyMul(r.doy, amp, H, C)));
    const gapB = ladderGap(g, 'ladC');
    console.log(
      `  fit ${fitYr} (amp ${amp.toFixed(4)})  ->  read ${readYr} early window, n=${g.length}:`
      + `  bias ${before >= 0 ? '+' : ''}${before.toFixed(3)} -> ${after >= 0 ? '+' : ''}${after.toFixed(3)}`
      + `   ladder gap before ${gapB.toFixed(1)}`,
    );
  }
  console.log('\n  And the strongest of the three: the amplitude the 2024 league curve');
  console.log('  alone asks for, 0.1102 — a coefficient chosen with no knowledge of any');
  console.log('  2025 or 2026 outcome at all, and not of this model\'s existence.\n');
  for (const [label, amp] of [['2024 league only', 0.1102], ['SHIPPED (3 seasons of league PA)', 0.1134]]) {
    for (const readYr of ['2025', '2026']) {
      const g = rows.filter((r) => r.d.startsWith(readYr) && r.doy < C);
      const after = mean(g.map((r) => r.bbA - r.bbC * earlyMul(r.doy, amp, H, C)));
      console.log(`  amp ${amp} (${label})  ->  ${readYr} early window bias`
        + ` ${mean(g.map((r) => r.bbA - r.bbC)).toFixed(3)} -> ${after >= 0 ? '+' : ''}${after.toFixed(3)}`);
    }
  }

  console.log(`\n### The exponent, by least squares of actual walks on the scaled projection\n`);
  console.log(`  FIT split only, ${fit.length} starts. \`beta\` solves min sum (bbA - bbC * ratio^beta)^2`);
  console.log('  by golden section. `ref` is the standing league starter walk rate the');
  console.log('  prior-season book is assumed to have come from.\n');
  console.log('   ref      beta      se       t     2025     2026   ΔSSE   valΔSSE  maxlift');

  const sse = (g, ref, beta, priorW) =>
    g.reduce((a, r) => a + (r.bbA - r.bbC * envRatioFrom(r, ref, priorW).ratio ** beta) ** 2, 0);
  const fitBeta = (g, ref, priorW = 0.6) => {
    // Least squares in beta by golden section; the residual is smooth and
    // unimodal over [-1, 3] for every ref in the sweep.
    let lo = -1, hi = 3;
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    for (let i = 0; i < 80; i++) {
      if (sse(g, ref, c, priorW) < sse(g, ref, d, priorW)) { hi = d; d = c; c = hi - gr * (hi - lo); }
      else { lo = c; c = d; d = lo + gr * (hi - lo); }
    }
    const beta = (lo + hi) / 2;
    // Standard error from the Gauss-Newton linearisation at the optimum.
    let j2 = 0, r2 = 0;
    for (const r of g) {
      const q = envRatioFrom(r, ref, priorW);
      const f = r.bbC * q.ratio ** beta;
      const dfd = f * Math.log(Math.max(1e-9, q.ratio));
      j2 += dfd * dfd;
      r2 += (r.bbA - f) ** 2;
    }
    const s2 = r2 / Math.max(1, g.length - 1);
    return { beta, se: j2 > 0 ? Math.sqrt(s2 / j2) : NaN };
  };

  const val = rows.filter(isVal);
  const base = sse(fit, 0.0797, 0, 0.6);
  const valBase = sse(val, 0.0797, 0, 0.6);
  const REFS = [0.074, 0.076, 0.0779, 0.0797, 0.081, 0.083];
  for (const ref of REFS) {
    const { beta, se: s } = fitBeta(fit, ref);
    const a = fitBeta(fit.filter((r) => r.d.startsWith('2025')), ref).beta;
    const b = fitBeta(fit.filter((r) => r.d.startsWith('2026')), ref).beta;
    const lift = Math.max(...fit.map((r) => envRatioFrom(r, ref).ratio ** beta));
    console.log(
      `  ${num(ref, 4, 6)} ${num(beta, 4, 8)} ${num(s, 4, 7)} ${num(beta / s, 1, 7)} ${num(a, 4, 8)} ${num(b, 4, 8)}`
      + ` ${num(base - sse(fit, ref, beta, 0.6), 1, 7)} ${num(valBase - sse(val, ref, beta, 0.6), 1, 8)} ${num(lift, 3, 8)}`,
    );
  }

  console.log('\n  With the TRUE prior-season league rate instead of a standing `ref`:');
  const trueRatio = (r) => {
    const d26 = r.bf26 || 0, d25 = 0.6 * (r.bf25 || 0);
    const w = d26 + d25 > 0 ? d26 / (d26 + d25) : 0;
    return r.lgNow / (w * r.lgNow + (1 - w) * r.lgPrev);
  };
  const sseT = (g, beta) => g.reduce((a, r) => a + (r.bbA - r.bbC * trueRatio(r) ** beta) ** 2, 0);
  {
    let lo = -1, hi = 3; const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    for (let i = 0; i < 80; i++) {
      if (sseT(fit, c) < sseT(fit, d)) { hi = d; d = c; c = hi - gr * (hi - lo); }
      else { lo = c; c = d; d = lo + gr * (hi - lo); }
    }
    const beta = (lo + hi) / 2;
    const b25 = fit.filter((r) => r.d.startsWith('2025'));
    const b26 = fit.filter((r) => r.d.startsWith('2026'));
    const one = (g) => {
      let L = -1, H = 3, C = H - gr * (H - L), D = L + gr * (H - L);
      for (let i = 0; i < 80; i++) {
        if (sseT(g, C) < sseT(g, D)) { H = D; D = C; C = H - gr * (H - L); }
        else { L = C; C = D; D = L + gr * (H - L); }
      }
      return (L + H) / 2;
    };
    console.log(`    beta ${beta.toFixed(4)}   2025 ${one(b25).toFixed(4)}   2026 ${one(b26).toFixed(4)}`
      + `   ΔSSE ${(base - sseT(fit, beta)).toFixed(1)}   valΔSSE ${(valBase - sseT(val, beta)).toFixed(1)}`);
  }

  console.log('\n### The two alternatives it is measured against\n');
  // A. A month/calendar dummy: April and March get a level lift.
  for (const cut of [21, 30, 45, 60]) {
    const g = fit.filter((r) => r.doy <= cut);
    const lift = mean(g.map((r) => r.bbA)) / mean(g.map((r) => r.bbC));
    const rest = fit.filter((r) => r.doy > cut);
    const a = g.filter((r) => r.d.startsWith('2025'));
    const b = g.filter((r) => r.d.startsWith('2026'));
    console.log(
      `  calendar lift, doy <= ${String(cut).padStart(3)}  n=${String(g.length).padStart(5)}  lift ${lift.toFixed(4)}`
      + `  2025 ${(mean(a.map((r) => r.bbA)) / mean(a.map((r) => r.bbC))).toFixed(4)}`
      + `  2026 ${(mean(b.map((r) => r.bbA)) / mean(b.map((r) => r.bbC))).toFixed(4)}`
      + `  rest ${(mean(rest.map((r) => r.bbA)) / mean(rest.map((r) => r.bbC))).toFixed(4)}`,
    );
  }
  // B. Sensitivity to lgNow alone, with no history term at all.
  console.log('');
  for (const ref of [0.0779, 0.0797, 0.081]) {
    const g = fit;
    const sseL = (beta) => g.reduce((a, r) => a + (r.bbA - r.bbC * (r.lgNow / ref) ** beta) ** 2, 0);
    let lo = -1, hi = 3; const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    for (let i = 0; i < 80; i++) {
      if (sseL(c) < sseL(d)) { hi = d; d = c; c = hi - gr * (hi - lo); }
      else { lo = c; c = d; d = lo + gr * (hi - lo); }
    }
    const beta = (lo + hi) / 2;
    console.log(`  lgNow alone, ref ${ref}   beta ${beta.toFixed(4)}   ΔSSE ${(base - sseL(beta)).toFixed(1)}`);
  }
}

// ── --month / --window: before and after ────────────────────────────────────
function monthReport(rows) {
  console.log('\n### Walks by month, control against this tree\n');
  console.log('  month      n    projC   projN   actual    biasC    biasN     ECE C   ECE N    gap C   gap N');
  for (const m of [...new Set(rows.map(monthOf))].sort()) {
    const g = rows.filter((r) => monthOf(r) === m);
    console.log(
      `  ${m} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbN)))}`
      + ` ${num(mean(g.map((r) => r.bbA)))} ${num(mean(g.map((r) => r.bbA - r.bbC)))} ${num(mean(g.map((r) => r.bbA - r.bbN)))}`
      + ` ${num(ece(g, 'ladC'), 2, 9)} ${num(ece(g, 'ladN'), 2, 7)} ${num(ladderGap(g, 'ladC'), 1, 8)} ${num(ladderGap(g, 'ladN'), 1, 7)}`,
    );
  }
  console.log('\n### Every market by month — did anything else move?\n');
  console.log('  Only walks can move: the term multiplies the walk RATE and nothing');
  console.log('  else reads it. This prints the other four to show that it did not.\n');
  console.log('  month       K proj C->N      hits C->N       ER C->N       outs C->N');
  for (const m of [...new Set(rows.map(monthOf))].sort()) {
    const g = rows.filter((r) => monthOf(r) === m);
    const P = (a, b) => `${mean(g.map((r) => r[a])).toFixed(4)}->${mean(g.map((r) => r[b])).toFixed(4)}`;
    console.log(`  ${m}  ${pad(P('kC', 'kN'), 16)}${pad(P('hC', 'hN'), 16)}${pad(P('erC', 'erN'), 14)}${P('outsC', 'outsN')}`);
  }
}

function windowReport(rows) {
  const W = { FIT: rows.filter(isFit), VALIDATE: rows.filter(isVal), HOLDOUT: rows.filter((r) => r.d > '2026-09-01') };
  console.log('\n### Walks, by split\n');
  console.log('  split       n     projC    projN   actual    ECE C   ECE N    gap C    gap N');
  for (const [k, g] of Object.entries(W)) {
    if (!g.length) continue;
    console.log(
      `  ${pad(k, 9)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbN)))}`
      + ` ${num(mean(g.map((r) => r.bbA)))} ${num(ece(g, 'ladC'), 2, 8)} ${num(ece(g, 'ladN'), 2, 7)}`
      + ` ${num(ladderGap(g, 'ladC'), 1, 8)} ${num(ladderGap(g, 'ladN'), 1, 8)}`,
    );
  }
  console.log('\n### Early season only (doy <= 45), by split\n');
  console.log('  split       n     projC    projN   actual    ECE C   ECE N    gap C    gap N');
  for (const [k, g0] of Object.entries(W)) {
    const g = g0.filter((r) => r.doy <= 45);
    if (!g.length) { console.log(`  ${pad(k, 9)}     0   — this window contains no early-season start`); continue; }
    console.log(
      `  ${pad(k, 9)} ${String(g.length).padStart(5)} ${num(mean(g.map((r) => r.bbC)))} ${num(mean(g.map((r) => r.bbN)))}`
      + ` ${num(mean(g.map((r) => r.bbA)))} ${num(ece(g, 'ladC'), 2, 8)} ${num(ece(g, 'ladN'), 2, 7)}`
      + ` ${num(ladderGap(g, 'ladC'), 1, 8)} ${num(ladderGap(g, 'ladN'), 1, 8)}`,
    );
  }
  console.log('\n  VALIDATE and HOLDOUT hold no start inside `cap` days of March 20, so');
  console.log('  both are byte-identical and neither can test this term. The out-of-');
  console.log('  sample evidence is the cross-season split under --fit and the 2024');
  console.log('  league season under --league.\n');
}

// ── main ────────────────────────────────────────────────────────────────────
if (!REPORT) {
  await writeRows();
} else {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.ndjson'));
  const loaded = files.flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  console.log(`${loaded.length} rows from ${files.length} files`);
  if (process.argv.includes('--shape')) shape(loaded);
  if (process.argv.includes('--which')) which(loaded);
  if (process.argv.includes('--markets')) markets(loaded);
  if (process.argv.includes('--weather')) weather(loaded);
  if (process.argv.includes('--league')) leagueReport();
  if (process.argv.includes('--why')) why(loaded);
  if (process.argv.includes('--band')) band(loaded);
  if (process.argv.includes('--fit')) fitTerm(loaded);
  if (process.argv.includes('--month')) monthReport(loaded);
  if (process.argv.includes('--window')) windowReport(loaded);
}
