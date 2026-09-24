// Fit the park out of the game model's OWN residuals, and say honestly whether
// a fitted park factor beats the table that is already there.
//
//   node tools/park-fit.mjs --acc .backtest-cache/acc_g_before.ndjson \
//     --features .backtest-cache/features_2025.json \
//     --features .backtest-cache/features_2026.json \
//     [--fit-to 2026-08-09] [--validate-to 2026-09-01] [--out .backtest-cache/park-fit.json]
//
// This is NOT a replay. It reads the records `tools/accuracy-extract.mjs`
// writes for `tools/backtest-games-v2.mjs --src` — one projected total and one
// actual total per game — and joins the feature table back on for the venue
// and the first-pitch weather. Every as-of rule lives in those files.
//
// WHAT IT ESTIMATES, AND WHY IN THIS ORDER
//
//   1. the per-park residual, and the NOISE FLOOR under it. A park hosts about
//      140 games over two seasons and a game total has a residual sd of ~4.5
//      runs, so a park mean carries ~0.37 runs of pure sampling error before
//      anything real is added. Both a game-level and a SERIES-BLOCK permutation
//      null are reported, because games at a park arrive in three-game blocks
//      against one opponent and are not independent.
//   2. the park x WIND interaction, per park, partially pooled. The model
//      carries a single league-wide wind coefficient; this asks whether any
//      park responds differently, and shrinks every park's answer toward "no".
//   3. the park LEVEL, per park, partially pooled, after the wind term.
//   4. whether any of it PERSISTS: 2025 against 2026, and a series-blocked
//      split-half within each season. A coefficient that does not survive to
//      the next season is not a property of the ballpark and must not be
//      shipped as one.
//   5. the classic box-score park factor (home runs-per-game over the same
//      team's road runs-per-game), season by season, against the published
//      table — which answers "is the table wrong, or is the damping wrong?"
//      and gives the forward test: predict one season's park factor from the
//      other, and see whether the fit or the table wins.
//
// Nothing here reads a price and nothing is fitted against one.

import fs from 'node:fs';
import { PARK_ALIASES, parkFactor } from '../src/lib/parks.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const multi = (name) => process.argv.map((a, i) => (a === `--${name}` ? process.argv[i + 1] : null)).filter(Boolean);

const ACC = arg('acc', '.backtest-cache/acc_g_before.ndjson');
const FIT_TO = arg('fit-to', '2026-08-09');
const VALIDATE_TO = arg('validate-to', '2026-09-01');
const MIN_GAMES = Number(arg('min-games', 80));
const OUT = arg('out', null);

// ── statistics ──────────────────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const corr = (x, y) => { const mx = mean(x); const my = mean(y); return mean(x.map((v, i) => (v - mx) * (y[i] - my))) / (sd(x) * sd(y)); };
const cov = (x, y) => { const mx = mean(x); const my = mean(y); return mean(x.map((v, i) => (v - mx) * (y[i] - my))); };

/** Deterministic RNG, so every number in docs/PARK-FIX.md reproduces. */
let seed = 20260923;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = (xs) => xs.map((v) => [rnd(), v]).sort((a, b) => a[0] - b[0]).map((v) => v[1]);

/**
 * DerSimonian-Laird between-group variance, the shrinkage strength of a
 * partial pool. `r` are per-group estimates and `se` their sampling errors;
 * the return is tau^2, the variance of the TRUE group effects around zero.
 *
 * Shrinking toward ZERO rather than toward the pooled mean is deliberate:
 * zero is the model's current behaviour, so a park with nothing to say keeps
 * exactly what it has, and a pooled mean that is really non-zero shows up
 * separately in `pooled` below instead of being smuggled into every park.
 */
function tauSquared(r, se) {
  const w = se.map((s) => 1 / (s * s));
  const sw = w.reduce((a, b) => a + b, 0);
  const sw2 = w.reduce((a, b) => a + b * b, 0);
  const rw = r.reduce((a, v, i) => a + w[i] * v, 0) / sw;
  const Q = r.reduce((a, v, i) => a + w[i] * (v - rw) ** 2, 0);
  const denom = sw - sw2 / sw;
  return { tau2: Math.max(0, (Q - (r.length - 1)) / denom), Q, df: r.length - 1, pooled: rw };
}

/**
 * Partial pooling with a SPIKE-AND-SLAB prior, and why it is not the ordinary
 * Gaussian one.
 *
 * A single normal prior assumes every park's true effect is drawn from one
 * bell curve. The wind data are not shaped like that: sixteen parks sit inside
 * their own sampling error of zero and one, Wrigley, sits four standard errors
 * outside it. A Gaussian pool splits the difference — it inflates tau on
 * Wrigley's evidence and then uses that inflated tau to give every quiet park
 * a small effect it has not earned, while still cutting Wrigley's demonstrated
 * one in half. Both halves of that trade are wrong.
 *
 * The prior fitted here says a park's effect is exactly zero with probability
 * 1-p and drawn from N(0, tau^2) otherwise, with p and tau both estimated from
 * the parks by maximum likelihood. The posterior mean is then
 *
 *     w_i * (tau^2 / (tau^2 + se_i^2)) * r_i
 *
 * where w_i is the posterior probability that park i is a real effect at all.
 * A park with nothing to say gets w near zero and keeps the model's current
 * behaviour exactly; a park with overwhelming evidence keeps nearly all of its
 * raw estimate. Section 2b then checks the result out of sample rather than
 * taking the prior's word for it.
 *
 * `groups` is one array of {r, se} per PARK, not per coefficient: a park's
 * wind-out and wind-in readings are one physical claim about that ballpark, so
 * "does this park respond to wind at all" is decided once on both of them
 * together and only then is each direction shrunk. Splitting them would let a
 * park pass on its loud direction and be shrunk away on its quiet one.
 */
function spikeSlab(groups) {
  const dn = (x, v) => Math.exp(-(x * x) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
  const like = (g, tau2) => {
    let spike = 1; let slab = 1;
    for (const { r, se } of g) { spike *= dn(r, se * se); slab *= dn(r, tau2 + se * se); }
    return { spike, slab };
  };
  let best = null;
  for (let pi = 1; pi <= 40; pi++) {
    const p = pi / 40;
    for (let ti = 1; ti <= 120; ti++) {
      const tau2 = (0.005 * ti) ** 2;
      let ll = 0;
      for (const g of groups) { const { spike, slab } = like(g, tau2); ll += Math.log((1 - p) * spike + p * slab + 1e-300); }
      if (!best || ll > best.ll) best = { p, tau2, ll };
    }
  }
  const keep = groups.map((g) => {
    const { spike, slab } = like(g, best.tau2);
    const w = (best.p * slab) / ((1 - best.p) * spike + best.p * slab + 1e-300);
    return { w, est: g.map(({ r, se }) => w * (best.tau2 / (best.tau2 + se * se)) * r) };
  });
  return { ...best, tau: Math.sqrt(best.tau2), keep };
}

/** The multiplicative correction a set of games wants, and its sampling error. */
function multiplier(list) {
  const sy = list.reduce((a, r) => a + r.y, 0);
  const sm = list.reduce((a, r) => a + r.mu, 0);
  const m = sy / sm;
  // se of the ratio, from the scatter of the residual around the fitted m.
  const se = Math.sqrt(list.reduce((a, r) => a + (r.y - m * r.mu) ** 2, 0)) / sm;
  return { m, se, n: list.length, mu: sm / list.length, y: sy / list.length };
}

// ── data ────────────────────────────────────────────────────────────────────
const canon = (p) => PARK_ALIASES[p] || p;

const featRows = [];
for (const f of multi('features')) featRows.push(...JSON.parse(fs.readFileSync(f, 'utf8')).rows);
const feat = new Map(featRows.map((r) => [r.gamePk, r]));

const acc = fs.readFileSync(ACC, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.t === 'g' && r.tot?.[0] != null && r.tot?.[1] != null && feat.has(r.g));

/** out of the park = +1, in from it = -1, across / calm / indoor / unknown = 0. */
function windSign(wx) {
  if (!wx || wx.indoor) return 0;
  const d = String(wx.windDir || '').toLowerCase();
  return d.startsWith('out') ? 1 : d.startsWith('in') ? -1 : 0;
}

const games = acc.map((r) => {
  const f = feat.get(r.g);
  return {
    g: r.g,
    d: r.d,
    season: r.d.slice(0, 4),
    pk: canon(r.pk),
    mu: r.tot[0],
    y: r.tot[1],
    sign: windSign(f.wx),
    mph: f.wx?.indoor ? 0 : (f.wx?.windMph ?? 0),
    tempF: f.wx?.tempF ?? null,
    homeId: f.home.teamId,
    awayId: f.away.teamId,
    // A series: one opponent, at one park, inside one month. Games inside a
    // series share an opponent, a pitching staff and a weather system, so they
    // are the block a permutation null has to move as one.
    series: `${canon(r.pk)}|${f.away.teamId}|${r.d.slice(0, 7)}`,
  };
});

const FIT = games.filter((r) => r.d <= FIT_TO);
const VAL = games.filter((r) => r.d > FIT_TO && r.d <= VALIDATE_TO);
const HOLD = games.filter((r) => r.d > VALIDATE_TO);
const OUTSIDE = games.filter((r) => r.d <= VALIDATE_TO);

const counts = new Map();
for (const r of OUTSIDE) counts.set(r.pk, (counts.get(r.pk) || 0) + 1);
const PARKS = [...counts].filter(([, n]) => n >= MIN_GAMES).map(([p]) => p).sort();
const inPark = (rows, p) => rows.filter((r) => r.pk === p);

console.log(`park-fit: ${games.length} games  (FIT ${FIT.length} to ${FIT_TO}, VALIDATE ${VAL.length}, HOLDOUT ${HOLD.length})`);
console.log(`${PARKS.length} parks with ${MIN_GAMES}+ games outside the holdout\n`);

// ── 1. the per-park residual, and the floor under it ────────────────────────
function perParkBias(rows, adjust = () => 1) {
  const out = [];
  for (const p of PARKS) {
    const l = inPark(rows, p).map((r) => ({ ...r, mu: r.mu * adjust(r) }));
    if (!l.length) continue;
    const res = l.map((r) => r.y - r.mu);
    out.push({ pk: p, n: l.length, proj: mean(l.map((r) => r.mu)), act: mean(l.map((r) => r.y)), bias: mean(res), se: sd(res) / Math.sqrt(l.length) });
  }
  return out;
}

/** The sd a per-park bias table would show if the park meant nothing at all. */
function nullSd(rows, blocked, reps = 400) {
  const sds = [];
  const byPark = new Map(PARKS.map((p) => [p, inPark(rows, p)]));
  if (!blocked) {
    const pool = rows.filter((r) => PARKS.includes(r.pk)).map((r) => r.y - r.mu);
    for (let i = 0; i < reps; i++) {
      const s = shuffle(pool);
      let k = 0;
      const bias = [];
      for (const p of PARKS) { const n = byPark.get(p).length; bias.push(mean(s.slice(k, k + n))); k += n; }
      sds.push(sd(bias));
    }
  } else {
    const blocks = new Map();
    for (const r of rows) { if (!PARKS.includes(r.pk)) continue; if (!blocks.has(r.series)) blocks.set(r.series, []); blocks.get(r.series).push(r.y - r.mu); }
    const pool = [...blocks.values()];
    const nb = new Map(PARKS.map((p) => [p, 0]));
    for (const k of blocks.keys()) nb.set(k.split('|')[0], nb.get(k.split('|')[0]) + 1);
    for (let i = 0; i < reps; i++) {
      const s = shuffle(pool);
      let k = 0;
      const bias = [];
      for (const p of PARKS) { const take = s.slice(k, k + nb.get(p)).flat(); k += nb.get(p); bias.push(mean(take)); }
      sds.push(sd(bias));
    }
  }
  sds.sort((a, b) => a - b);
  return { mean: mean(sds), lo: sds[Math.floor(0.025 * reps)], hi: sds[Math.floor(0.975 * reps)] };
}

console.log('=== 1. the per-park residual, outside the holdout ===');
const base = perParkBias(OUTSIDE);
base.sort((a, b) => b.bias - a.bias);
console.log('  park                              n    proj  actual    bias      95%');
for (const r of base) {
  console.log(`  ${r.pk.padEnd(32)} ${String(r.n).padStart(4)}  ${r.proj.toFixed(2)}   ${r.act.toFixed(2)}   ${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(3)}  +-${(1.96 * r.se).toFixed(2)}`);
}
const sdBase = sd(base.map((r) => r.bias));
const analytic = Math.sqrt(mean(base.map((r) => r.se ** 2)));
const nullG = nullSd(OUTSIDE, false);
const nullB = nullSd(OUTSIDE, true);
console.log(`\n  observed sd of the per-park bias   ${sdBase.toFixed(4)} runs   (mean ${mean(base.map((r) => r.bias)).toFixed(4)})`);
console.log(`  analytic sampling floor            ${analytic.toFixed(4)}`);
console.log(`  permutation floor, game level      ${nullG.mean.toFixed(4)}  95% [${nullG.lo.toFixed(4)}, ${nullG.hi.toFixed(4)}]`);
console.log(`  permutation floor, series blocks   ${nullB.mean.toFixed(4)}  95% [${nullB.lo.toFixed(4)}, ${nullB.hi.toFixed(4)}]`);
console.log(`  implied real park sd               ${Math.sqrt(Math.max(0, sdBase ** 2 - nullB.mean ** 2)).toFixed(4)} runs`
  + `   (zero if the observed sd is inside the null band)`);
{
  // A park-level mean averages a park's wind states together, so a venue that
  // is 3 runs low with the wind out and 1 run high with it in can look almost
  // unbiased. The cell that a total is actually priced in is park x wind.
  const cells = [];
  for (const p of PARKS) {
    for (const s of [1, 0, -1]) {
      const l = inPark(OUTSIDE, p).filter((r) => r.sign === s);
      if (l.length < 20) continue;
      const res = l.map((r) => r.y - r.mu);
      cells.push({ pk: p, s, n: l.length, bias: mean(res), se: sd(res) / Math.sqrt(l.length) });
    }
  }
  const floor = Math.sqrt(mean(cells.map((c) => c.se ** 2)));
  const s = sd(cells.map((c) => c.bias));
  console.log(`  ... and over the ${cells.length} park x wind-state cells with 20+ games:`
    + ` sd ${s.toFixed(4)}, floor ${floor.toFixed(4)}, implied real ${Math.sqrt(Math.max(0, s ** 2 - floor ** 2)).toFixed(4)} runs`);
  cells.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
  console.log('  the five worst cells:');
  for (const c of cells.slice(0, 5)) {
    console.log(`    ${c.pk.padEnd(30)} wind ${c.s > 0 ? 'out  ' : c.s < 0 ? 'in   ' : 'calm '} n=${String(c.n).padStart(3)}  bias ${c.bias >= 0 ? '+' : ''}${c.bias.toFixed(2)} +-${(1.96 * c.se).toFixed(2)}`);
  }
}

// ── 2. park x wind, partially pooled ────────────────────────────────────────
console.log('\n=== 2. does any park respond to the wind differently? (fitted on FIT only) ===');
console.log('  Each park gets two multipliers on top of everything the model already does,');
console.log('  including its league-wide 0.004/mph wind term: one for the games MLB reported');
console.log('  as blowing OUT, one for blowing IN. Both are then shrunk toward 1.');
const MIN_WIND = Number(arg('min-wind', 20));
const pll = (rows, f) => rows.reduce((a, r) => { const m = r.mu * f(r); return a + r.y * Math.log(m) - m; }, 0);

/** Every park's raw wind readings on a given set of games. */
function windReadings(rows) {
  const out = [];
  for (const p of PARKS) {
    const l = rows.filter((r) => r.pk === p);
    const g = [];
    for (const [key, want] of [['out', 1], ['in', -1]]) {
      const d = l.filter((r) => r.sign === want);
      if (d.length < MIN_WIND) continue;
      const m = multiplier(d);
      g.push({ key, r: Math.log(m.m), se: m.se / m.m, n: m.n, m: m.m });
    }
    if (g.length) out.push({ pk: p, g });
  }
  return out;
}
/** The shipped wind table a set of games produces, spike-and-slab pooled. */
function fitWind(rows) {
  const readings = windReadings(rows);
  const ss = spikeSlab(readings.map((x) => x.g));
  const table = {};
  readings.forEach((x, i) => {
    x.g.forEach((d, j) => {
      const v = Math.exp(ss.keep[i].est[j]);
      if (Math.abs(v - 1) < 0.02) return; // neutral: leave the model alone
      table[x.pk] = table[x.pk] || {};
      table[x.pk][d.key] = v;
    });
  });
  return { table, readings, ss };
}

const wf = fitWind(FIT);
console.log(`  spike-and-slab across ${wf.readings.length} parks with ${MIN_WIND}+ games in at least one direction:`);
console.log(`    P(a park has a wind response of its own) ${wf.ss.p.toFixed(2)},  slab tau ${wf.ss.tau.toFixed(3)} log-runs,  logL ${wf.ss.ll.toFixed(1)}`);
console.log('  park                             dir    n     raw    P(real)   FITTED');
wf.readings.forEach((x, i) => {
  x.g.forEach((d, j) => {
    const v = Math.exp(wf.ss.keep[i].est[j]);
    const flag = Math.abs(v - 1) > 0.03 ? '  <-' : '';
    console.log(`  ${x.pk.padEnd(30)} ${d.key.padEnd(4)} ${String(d.n).padStart(4)} ${(100 * (d.m - 1)).toFixed(1).padStart(6)}%    ${wf.ss.keep[i].w.toFixed(2)}   ${(100 * (v - 1)).toFixed(1).padStart(6)}%${flag}`);
  });
});

// ── 2b. the gate: fitted on one season of FIT, scored on the other ──────────
console.log('\n=== 2b. the gate — fitted on ONE season of FIT and scored on the OTHER ===');
console.log('  Poisson log-likelihood of the game totals against the current model; positive is better.');
console.log('  A park only reaches the shipped table if BOTH directions of this test are positive,');
console.log('  which is the difference between a coefficient and a coincidence.');
const windFit = {};
{
  const A = FIT.filter((r) => r.season === '2025');
  const B = FIT.filter((r) => r.season === '2026');
  const tA = fitWind(A).table; const tB = fitWind(B).table;
  const use = (t) => (r) => { const w = t[r.pk]; if (!w) return 1; return r.sign > 0 ? (w.out ?? 1) : r.sign < 0 ? (w.in ?? 1) : 1; };
  for (const p of Object.keys(wf.table)) {
    const a = A.filter((r) => r.pk === p); const b = B.filter((r) => r.pk === p);
    const only = (t) => { const s = {}; if (t[p]) s[p] = t[p]; return s; };
    const d1 = pll(b, use(only(tA))) - pll(b, () => 1);
    const d2 = pll(a, use(only(tB))) - pll(a, () => 1);
    const pass = d1 > 0 && d2 > 0 && d1 + d2 > 4;
    console.log(`  ${p.padEnd(30)} 25-fit ${JSON.stringify(tA[p] ? Object.fromEntries(Object.entries(tA[p]).map(([k, v]) => [k, Number((100 * (v - 1)).toFixed(1))])) : {})}`
      + `  26-fit ${JSON.stringify(tB[p] ? Object.fromEntries(Object.entries(tB[p]).map(([k, v]) => [k, Number((100 * (v - 1)).toFixed(1))])) : {})}`
      + `   dLL 25->26 ${d1.toFixed(1)}  26->25 ${d2.toFixed(1)}   ${pass ? 'KEEP' : 'drop'}`);
    if (pass) windFit[p] = wf.table[p];
  }
}
console.log(`\n  the shipped wind table: ${JSON.stringify(windFit, (k, v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v))}`);

// ── 3. the park level, partially pooled, after the wind term ────────────────
const windAdjust = (table) => (r) => {
  const w = table[r.pk];
  if (!w) return 1;
  return r.sign > 0 ? (w.out ?? 1) : r.sign < 0 ? (w.in ?? 1) : 1;
};
const applyWind = windAdjust(windFit);

console.log('\n=== 3. the park LEVEL, partially pooled (fitted on FIT only, after the wind term) ===');
const levelRaw = PARKS.map((p) => ({ pk: p, ...multiplier(inPark(FIT, p).map((r) => ({ ...r, mu: r.mu * applyWind(r) }))) }));
const lr = levelRaw.map((x) => Math.log(x.m));
const lse = levelRaw.map((x) => x.se / x.m);
const lt = tauSquared(lr, lse);
const lss = spikeSlab(levelRaw.map((x, i) => [{ r: lr[i], se: lse[i] }]));
console.log(`  Gaussian pool:  tau ${Math.sqrt(lt.tau2).toFixed(4)} log-runs (${(Math.sqrt(lt.tau2) * 8.95).toFixed(3)} runs at a league-average total)`
  + `   Q ${lt.Q.toFixed(1)} on ${lt.df} df   pooled ${(100 * (Math.exp(lt.pooled) - 1)).toFixed(2)}%`);
console.log(`  spike-and-slab: P(a park has any level effect) ${lss.p.toFixed(2)}, slab tau ${lss.tau.toFixed(3)}`);
const levelFit = {};
console.log('  park                              n     raw     gauss  P(real)  FITTED   -> runs at 8.95');
levelRaw.forEach((x, i) => {
  const B = lt.tau2 / (lt.tau2 + lse[i] ** 2);
  const gauss = Math.exp(B * lr[i]);
  const s = Math.exp(lss.keep[i].est[0]);
  levelFit[x.pk] = s;
  console.log(`  ${x.pk.padEnd(32)} ${String(x.n).padStart(4)} ${(100 * (x.m - 1)).toFixed(1).padStart(6)}% ${(100 * (gauss - 1)).toFixed(1).padStart(6)}%    ${lss.keep[i].w.toFixed(2)}  ${(100 * (s - 1)).toFixed(1).padStart(6)}%   ${((s - 1) * 8.95 >= 0 ? '+' : '')}${((s - 1) * 8.95).toFixed(2)}`);
});
const meanKept = mean(levelRaw.map((x, i) => lt.tau2 / (lt.tau2 + lse[i] ** 2)));
console.log(`  mean Gaussian shrinkage: ${(100 * meanKept).toFixed(0)}% of each park's raw deviation kept`);
{
  // The same gate the wind term had to pass: fit the level on one season of
  // FIT, score it on the other.
  const A = FIT.filter((r) => r.season === '2025'); const B = FIT.filter((r) => r.season === '2026');
  const fitLevel = (rows) => {
    const raw = PARKS.map((p) => ({ pk: p, ...multiplier(rows.filter((r) => r.pk === p).map((r) => ({ ...r, mu: r.mu * applyWind(r) }))) }));
    const r = raw.map((x) => Math.log(x.m)); const se = raw.map((x) => x.se / x.m);
    const t = tauSquared(r, se); const tab = {};
    raw.forEach((x, i) => { tab[x.pk] = Math.exp((t.tau2 / (t.tau2 + se[i] ** 2)) * r[i]); });
    return { tab, kept: mean(raw.map((x, i) => t.tau2 / (t.tau2 + se[i] ** 2))) };
  };
  const fa = fitLevel(A); const fb = fitLevel(B);
  const d1 = pll(B, (r) => applyWind(r) * (fa.tab[r.pk] ?? 1)) - pll(B, applyWind);
  const d2 = pll(A, (r) => applyWind(r) * (fb.tab[r.pk] ?? 1)) - pll(A, applyWind);
  console.log(`  the gate: fitted on 2025 (keeping ${(100 * fa.kept).toFixed(0)}%) it scores ${d1 >= 0 ? '+' : ''}${d1.toFixed(1)} dLL on 2026;`
    + ` fitted on 2026 (keeping ${(100 * fb.kept).toFixed(0)}%) it scores ${d2 >= 0 ? '+' : ''}${d2.toFixed(1)} dLL on 2025.`);
  console.log(`  ${d1 > 0 && d2 > 0 ? 'KEEP — a fitted level table earns its place.' : 'DROP — a fitted level table does not survive the season it was not fitted on.'}`);
}

// ── 4. does any of it persist? ──────────────────────────────────────────────
console.log('\n=== 4. persistence — the only test that matters for a table that ships ===');
function persistBySeason(adjust) {
  const X = []; const Y = []; const rows = [];
  for (const p of PARKS) {
    const a = inPark(OUTSIDE.filter((r) => r.season === '2025'), p);
    const b = inPark(OUTSIDE.filter((r) => r.season === '2026'), p);
    if (a.length < 30 || b.length < 30) continue;
    const ba = mean(a.map((r) => r.y - r.mu * adjust(r)));
    const bb = mean(b.map((r) => r.y - r.mu * adjust(r)));
    X.push(ba); Y.push(bb); rows.push({ pk: p, a: ba, b: bb, na: a.length, nb: b.length });
  }
  return { X, Y, rows };
}
for (const [label, adj] of [['before the wind term', () => 1], ['after the wind term', applyWind]]) {
  const { X, Y } = persistBySeason(adj);
  const c = cov(X, Y);
  // bootstrap over parks
  const boots = [];
  for (let i = 0; i < 2000; i++) {
    const idx = Array.from({ length: X.length }, () => Math.floor(rnd() * X.length));
    boots.push(cov(idx.map((j) => X[j]), idx.map((j) => Y[j])));
  }
  boots.sort((a, b) => a - b);
  console.log(`  2025 vs 2026 park bias, ${label.padEnd(20)} n=${X.length}  corr ${corr(X, Y).toFixed(3)}`
    + `  cov ${c.toFixed(4)} 95% [${boots[50].toFixed(4)}, ${boots[1949].toFixed(4)}]`
    + `  => persistent sd ${c > 0 ? Math.sqrt(c).toFixed(3) : '0'} runs`);
}
{
  // series-blocked split-half WITHIN the window: does the bias repeat at all?
  const reps = 300; const covs = [];
  for (let rep = 0; rep < reps; rep++) {
    const X = []; const Y = [];
    for (const p of PARKS) {
      const blocks = new Map();
      for (const r of inPark(OUTSIDE, p)) { if (!blocks.has(r.series)) blocks.set(r.series, []); blocks.get(r.series).push(r); }
      const bl = shuffle([...blocks.values()]);
      const h = Math.floor(bl.length / 2);
      const A = bl.slice(0, h).flat(); const B = bl.slice(h).flat();
      if (A.length < 20 || B.length < 20) continue;
      X.push(mean(A.map((r) => r.y - r.mu * applyWind(r))));
      Y.push(mean(B.map((r) => r.y - r.mu * applyWind(r))));
    }
    covs.push(cov(X, Y));
  }
  covs.sort((a, b) => a - b);
  const m = mean(covs);
  console.log(`  series-blocked split-half WITHIN the window            cov ${m.toFixed(4)} [${covs[7].toFixed(4)}, ${covs[292].toFixed(4)}]`
    + `  => within-window sd ${m > 0 ? Math.sqrt(m).toFixed(3) : '0'} runs`);
}

// ── 4b. if it is not the ballpark, is it the home team? ─────────────────────
console.log('\n=== 4b. is the per-park bias really the home TEAM? ===');
for (const season of ['2025', '2026']) {
  const L = OUTSIDE.filter((r) => r.season === season);
  const home = new Map(); const road = new Map();
  for (const r of L) {
    if (!home.has(r.homeId)) home.set(r.homeId, []);
    home.get(r.homeId).push(r.y - r.mu * applyWind(r));
    if (!road.has(r.awayId)) road.set(r.awayId, []);
    road.get(r.awayId).push(r.y - r.mu * applyWind(r));
  }
  const X = []; const Y = [];
  for (const [t, hl] of home) { const rl = road.get(t) || []; if (hl.length < 30 || rl.length < 30) continue; X.push(mean(hl)); Y.push(mean(rl)); }
  console.log(`  ${season}: ${X.length} teams   sd(bias at home) ${sd(X).toFixed(3)}   sd(bias on the road) ${sd(Y).toFixed(3)}`
    + `   corr ${corr(X, Y).toFixed(3)}`);
}
console.log('  A team the model simply over-rates is wrong in the SAME direction home and away, so a');
console.log('  positive correlation would say "team, not park". A NEGATIVE one is the signature of the');
console.log('  ownPark neutralisation: get a park factor wrong and the team\'s own index absorbs the');
console.log('  opposite error, which it then carries on the road.');

// ── 4c. which parks moved between the seasons ───────────────────────────────
console.log('\n=== 4c. drift, park by park (after the wind term) ===');
{
  const rows = [];
  for (const p of PARKS) {
    const a = inPark(OUTSIDE.filter((r) => r.season === '2025'), p);
    const b = inPark(OUTSIDE.filter((r) => r.season === '2026'), p);
    if (a.length < 30 || b.length < 30) continue;
    const st = (l) => { const res = l.map((r) => r.y - r.mu * applyWind(r)); return { n: l.length, b: mean(res), se: sd(res) / Math.sqrt(l.length) }; };
    const s1 = st(a); const s2 = st(b);
    const se = Math.sqrt(s1.se ** 2 + s2.se ** 2);
    rows.push({ pk: p, s1, s2, d: s2.b - s1.b, z: (s2.b - s1.b) / se, se });
  }
  rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  for (const r of rows.slice(0, 6)) {
    console.log(`  ${r.pk.padEnd(30)} 2025 ${r.s1.b >= 0 ? '+' : ''}${r.s1.b.toFixed(2)} (n=${r.s1.n})   2026 ${r.s2.b >= 0 ? '+' : ''}${r.s2.b.toFixed(2)} (n=${r.s2.n})`
      + `   change ${r.d >= 0 ? '+' : ''}${r.d.toFixed(2)} +-${(1.96 * r.se).toFixed(2)}   z ${r.z.toFixed(2)}`);
  }
  console.log(`  ${rows.filter((r) => Math.abs(r.z) > 1.96).length} of ${rows.length} parks outside their own interval; about ${(0.05 * rows.length).toFixed(1)} expected by chance.`);
}

// ── 5. the box-score park factor, against the published table ───────────────
console.log('\n=== 5. the classic box-score park factor, and what it says about the table ===');
function rawPF(season) {
  const home = new Map(); const road = new Map(); const parkOf = new Map();
  for (const r of featRows) {
    if (String(r.season) !== season || r.actual?.scheduledInnings !== 9) continue;
    const t = r.actual.away + r.actual.home;
    parkOf.set(r.home.teamId, canon(r.venue));
    if (!home.has(r.home.teamId)) home.set(r.home.teamId, []);
    home.get(r.home.teamId).push(t);
    if (!road.has(r.away.teamId)) road.set(r.away.teamId, []);
    road.get(r.away.teamId).push(t);
  }
  const o = new Map();
  for (const [t, hl] of home) {
    const rl = road.get(t) || [];
    if (hl.length < 50 || rl.length < 50) continue;
    o.set(parkOf.get(t), { pf: mean(hl) / mean(rl), se: Math.sqrt(sd(hl) ** 2 / hl.length + sd(rl) ** 2 / rl.length) / mean(rl) });
  }
  return o;
}
const A = rawPF('2025'); const B = rawPF('2026');
const PP = [...A.keys()].filter((p) => B.has(p)).sort();
const rA = PP.map((p) => A.get(p).pf); const rB = PP.map((p) => B.get(p).pf);
const tbl = PP.map((p) => parkFactor(p, 'runs', 1.5));
const pfSe = Math.sqrt(mean(PP.map((p) => (A.get(p).se ** 2 + B.get(p).se ** 2) / 2)));
console.log(`  n=${PP.length} parks.  per-season sampling se ${pfSe.toFixed(4)};  sd(observed PF) ${((sd(rA) + sd(rB)) / 2).toFixed(4)};  sd(table at 1.5) ${sd(tbl).toFixed(4)}`);
console.log(`  corr(2025, 2026)                 ${corr(rA, rB).toFixed(3)}   cov ${cov(rA, rB).toFixed(5)}  => persistent park sd ${Math.sqrt(Math.max(0, cov(rA, rB))).toFixed(4)} (${(Math.sqrt(Math.max(0, cov(rA, rB))) * 8.95).toFixed(2)} runs)`);
console.log(`  corr(table, observed both)       ${corr(tbl, PP.map((p, i) => (rA[i] + rB[i]) / 2)).toFixed(3)}`);
{
  const eA = PP.map((p, i) => rA[i] - tbl[i]); const eB = PP.map((p, i) => rB[i] - tbl[i]);
  console.log(`  what the table MISSES: corr(2025, 2026) of (observed - table)  ${corr(eA, eB).toFixed(3)}   cov ${cov(eA, eB).toFixed(5)}`);
}
{
  const X = tbl.map((v, i) => parkFactor(PP[i], 'runs', 1) - 1);
  const Y = PP.map((p, i) => (rA[i] + rB[i]) / 2 - 1);
  const b = cov(X, Y) / (sd(X) ** 2);
  const res = Y.map((v, i) => v - mean(Y) - b * (X[i] - mean(X)));
  const se = Math.sqrt(mean(res.map((r) => r * r)) / (PP.length * sd(X) ** 2));
  console.log(`  the exponent the box scores want on the table: ${b.toFixed(2)} [${(b - 1.96 * se).toFixed(2)}, ${(b + 1.96 * se).toFixed(2)}]   (the model applies 1.5; parkFactor's default is 0.7)`);
}
console.log('\n  forward test — predict one season\'s park factor from the other:');
const mse = (pred, act) => mean(pred.map((v, i) => (v - act[i]) ** 2));
for (const [lab, xs, ys] of [['2025 -> 2026', rA, rB], ['2026 -> 2025', rB, rA]]) {
  const cands = [
    ['neutral, no park at all', PP.map(() => 1)],
    ['the table at 0.7 (parkFactor default)', PP.map((p) => parkFactor(p, 'runs', 0.7))],
    ['the table at 1.5 (what the model applies)', tbl],
    ['the table at 2.1', PP.map((p) => parkFactor(p, 'runs', 2.1))],
    ['fitted from the other season, kept 40%', xs.map((v) => 1 + 0.4 * (v - 1))],
    ['fitted from the other season, kept 100%', xs],
    ['table at 1.5 + 20% of (fitted - table)', PP.map((p, i) => tbl[i] + 0.2 * (xs[i] - tbl[i]))],
    ['table at 1.5 + 50% of (fitted - table)', PP.map((p, i) => tbl[i] + 0.5 * (xs[i] - tbl[i]))],
  ];
  console.log(`    ${lab}`);
  for (const [name, pred] of cands) console.log(`      ${name.padEnd(44)} MSE ${mse(pred, ys).toFixed(5)}`);
}
console.log(`    (every MSE above carries the target season's own sampling noise, ~${(pfSe ** 2).toFixed(5)}, which no predictor can remove)`);

// ── 6. what the fitted tables do on VALIDATE ────────────────────────────────
console.log('\n=== 6. the fitted terms on VALIDATE (never used in the fit) ===');
const report = (rows, label, adjust) => {
  if (!rows.length) return;
  const res = rows.map((r) => r.y - r.mu * adjust(r));
  console.log(`  ${label.padEnd(40)} n=${String(rows.length).padStart(4)}  bias ${mean(res) >= 0 ? '+' : ''}${mean(res).toFixed(3)}  rmse ${Math.sqrt(mean(res.map((x) => x * x))).toFixed(3)}`);
};
for (const [wname, wrows] of [['VALIDATE', VAL], ['FIT (in sample)', FIT]]) {
  report(wrows, `${wname}: current model`, () => 1);
  report(wrows, `${wname}: + the wind term`, applyWind);
  report(wrows, `${wname}: + wind + fitted level`, (r) => applyWind(r) * (levelFit[r.pk] ?? 1));
}
{
  const w = VAL.filter((r) => r.pk === 'Wrigley Field');
  if (w.length) {
    report(w, 'VALIDATE, Wrigley only: current', () => 1);
    report(w, 'VALIDATE, Wrigley only: + wind', applyWind);
  }
}

// ── 7. cross-fitted, so no game informs its own correction ──────────────────
console.log('\n=== 7. cross-fitted per-park bias (two folds by series; no game corrects itself) ===');
{
  const folds = [[], []];
  const byPark = new Map(PARKS.map((p) => [p, new Map()]));
  for (const r of OUTSIDE) { if (!byPark.has(r.pk)) continue; const m = byPark.get(r.pk); if (!m.has(r.series)) m.set(r.series, []); m.get(r.series).push(r); }
  for (const p of PARKS) { shuffle([...byPark.get(p).values()]).forEach((b, i) => folds[i % 2].push(...b)); }
  const fitFold = (rows) => {
    const raw = PARKS.map((p) => ({ pk: p, ...multiplier(rows.filter((r) => r.pk === p).map((r) => ({ ...r, mu: r.mu * applyWind(r) }))) }));
    const r = raw.map((x) => Math.log(x.m)); const se = raw.map((x) => x.se / x.m);
    const t = tauSquared(r, se);
    const tab = {};
    raw.forEach((x, i) => { tab[x.pk] = Math.exp((t.tau2 / (t.tau2 + se[i] ** 2)) * r[i]); });
    return { tab, kept: mean(raw.map((x, i) => t.tau2 / (t.tau2 + se[i] ** 2))) };
  };
  const f0 = fitFold(folds[0]); const f1 = fitFold(folds[1]);
  console.log(`  fold A keeps ${(100 * f0.kept).toFixed(0)}% of each raw deviation, fold B ${(100 * f1.kept).toFixed(0)}%`);
  const scored = [...folds[1].map((r) => ({ r, tab: f0.tab })), ...folds[0].map((r) => ({ r, tab: f1.tab }))];
  const perPark = [];
  for (const p of PARKS) {
    const l = scored.filter((x) => x.r.pk === p);
    perPark.push({
      pk: p,
      before: mean(l.map((x) => x.r.y - x.r.mu)),
      wind: mean(l.map((x) => x.r.y - x.r.mu * applyWind(x.r))),
      after: mean(l.map((x) => x.r.y - x.r.mu * applyWind(x.r) * (x.tab[p] ?? 1))),
    });
  }
  console.log(`  per-park bias sd   before ${sd(perPark.map((x) => x.before)).toFixed(4)}`
    + `   after the wind term ${sd(perPark.map((x) => x.wind)).toFixed(4)}`
    + `   after wind + a cross-fitted level ${sd(perPark.map((x) => x.after)).toFixed(4)}`);
  console.log(`  (the series-block noise floor is ${nullB.mean.toFixed(4)}.  This split is WITHIN one window, so it`);
  console.log('   measures the within-window structure section 4 already found, not what a table would be worth');
  console.log('   next season. 7b is the number that decides whether anything ships.)');
}

// ── 7b. the same thing across the season boundary ───────────────────────────
console.log('\n=== 7b. cross-SEASON: fit the level on 2025, spend it on 2026, and the reverse ===');
{
  const fitLevel = (rows) => {
    const raw = PARKS.map((p) => ({ pk: p, ...multiplier(rows.filter((r) => r.pk === p).map((r) => ({ ...r, mu: r.mu * applyWind(r) }))) }))
      .filter((x) => x.n >= 30);
    const r = raw.map((x) => Math.log(x.m)); const se = raw.map((x) => x.se / x.m);
    const t = tauSquared(r, se); const tab = {};
    raw.forEach((x, i) => { tab[x.pk] = Math.exp((t.tau2 / (t.tau2 + se[i] ** 2)) * r[i]); });
    return tab;
  };
  const S = { 2025: OUTSIDE.filter((r) => r.season === '2025'), 2026: OUTSIDE.filter((r) => r.season === '2026') };
  const T = { 2025: fitLevel(S['2025']), 2026: fitLevel(S['2026']) };
  for (const [from, to] of [['2025', '2026'], ['2026', '2025']]) {
    const rows = S[to];
    const bias = (adj) => {
      const out = [];
      for (const p of PARKS) { const l = rows.filter((r) => r.pk === p); if (l.length < 30) continue; out.push(mean(l.map((r) => r.y - r.mu * adj(r)))); }
      return out;
    };
    const b0 = bias(applyWind);
    const b1 = bias((r) => applyWind(r) * (T[from][r.pk] ?? 1));
    console.log(`  a level table fitted on ${from}, applied to ${to}:  per-park bias sd ${sd(b0).toFixed(4)} -> ${sd(b1).toFixed(4)}`
      + `   (the ${to} noise floor alone is ~${(4.48 / Math.sqrt(mean(PARKS.map((p) => rows.filter((r) => r.pk === p).length)))).toFixed(4)})`);
  }
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({
    fitTo: FIT_TO, validateTo: VALIDATE_TO, minGames: MIN_GAMES,
    wind: windFit, level: levelFit,
  }, null, 1));
  console.log(`\nwrote ${OUT}`);
}
