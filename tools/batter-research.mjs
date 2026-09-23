// Search for a better batter model. Pre-registration: docs/BATTER-EDGE-SEARCH.md.
//
//   node tools/batter-research.mjs --cache DIR --mode <mode>
//
// Loads the lookahead-free replay from tools/backtest-batters.mjs once (every
// posted-lineup starter in every final 2026 game), then scores model variants
// against the OUTCOMES only. No price is read here; that is
// tools/backtest-kalshi-batters.mjs.
//
// Windows (fixed in the pre-registration):
//   FIT  every 2026 game through 2026-08-09   -- everything is chosen here
//   VAL  2026-08-10 .. 2026-09-01
//   HOLD 2026-09-02 .. 2026-09-22             -- touched once, at the end
//
// Modes:
//   base        report the shipped model on all three windows
//   shrink      re-derive the prior strengths and the prior-season weight
//   recency     re-derive the recency half-life of the current-season line
//   pa          plate-appearance model: team context and the 5th trip
//   joint       the joint plate-appearance outcome model (hits/R/RBI/H+R+RBI)
//   tune        a final coordinate search over everything still open
//   compare     score a list of named configurations side by side

import fs from 'node:fs';
import path from 'node:path';
import { projectBatter, BATTER_TUNING } from '../src/model/batter.js';
import { buildRows, hitLogs, MARKETS } from './backtest-batters.mjs';
import { pmfOf } from './backtest-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

export const FIT_END = '2026-08-10';   // exclusive upper bound of FIT
export const VAL_END = '2026-09-02';   // exclusive upper bound of VALIDATE
export const windowOf = (date) => (date < FIT_END ? 'FIT' : date < VAL_END ? 'VAL' : 'HOLD');

// ── recency-weighted current-season line ────────────────────────────────────
const HIT_FIELDS = ['gamesPlayed', 'plateAppearances', 'atBats', 'hits', 'doubles', 'triples', 'homeRuns', 'runs', 'rbi', 'strikeOuts', 'baseOnBalls', 'stolenBases', 'caughtStealing', 'totalBases'];
const DAY = 86400e3;

/**
 * A batter's 2026 line from every game-log entry before `date`, with game i
 * weighted exp(-age / tau) and the weights rescaled so they sum to the game
 * count. Rescaling keeps the denominator (and therefore the shrinkage a player
 * receives) equal to his real playing time; only the mix inside it moves.
 * `tau = Infinity` reproduces the flat season-to-date sum exactly.
 */
export function weightedSeason(logs, date, tau) {
  if (!(tau > 0) || !Number.isFinite(tau)) {
    const s = Object.fromEntries(HIT_FIELDS.map((f) => [f, 0]));
    let any = false;
    for (const g of logs) {
      if (g.date >= date) continue;
      any = true;
      for (const f of HIT_FIELDS) s[f] += Number(g.stat[f] || 0);
    }
    return any && s.gamesPlayed ? s : null;
  }
  const t = Date.parse(date);
  const used = [];
  let wsum = 0;
  for (const g of logs) {
    if (g.date >= date) continue;
    const w = Math.exp(-((t - Date.parse(g.date)) / DAY) / tau);
    used.push([g, w]);
    wsum += w;
  }
  if (!used.length) return null;
  const scale = used.length / wsum;
  const s = Object.fromEntries(HIT_FIELDS.map((f) => [f, 0]));
  for (const [g, w] of used) {
    const k = w * scale;
    for (const f of HIT_FIELDS) s[f] += k * Number(g.stat[f] || 0);
  }
  return s.gamesPlayed ? s : null;
}

// ── evaluation ──────────────────────────────────────────────────────────────
// The markets the pre-registration scores. `pa` is not a market; it is the
// distribution every count market sits on, and it is reported because it is
// where the 0.5 lines live.
const SCORED = ['pa', 'hits', 'tb', 'hr', 'rbi', 'hrr', 'runs', 'k', 'singles', 'sb'];

/**
 * Per market: log loss of the model's own pmf at the observed count, Brier over
 * the lines Kalshi lists, mean bias, the regression slope of actual on
 * projected (1.0 = the model believes player differences exactly as much as it
 * should) and the dispersion ratio (>1 = the distribution is too narrow).
 */
export function evaluate(rows, tuning, { only = SCORED } = {}) {
  const acc = Object.fromEntries(only.map((m) => [m, {
    n: 0, sumP: 0, sumA: 0, sumSq: 0, sumVar: 0, sumPP: 0, sumPA: 0, ll: 0, brier: 0, nb: 0,
    lines: new Map(MARKETS[m].lines.map((l) => [l, { p: 0, o: 0, n: 0 }])),
  }]));
  for (const r of rows) {
    const proj = projectBatter(tuning ? { ...r.input, tuning } : r.input);
    for (const m of only) {
      const spec = MARKETS[m];
      const mean = proj[spec.proj];
      const a = r.actual[m];
      if (!Number.isFinite(mean) || !Number.isFinite(a)) continue;
      const dist = m === 'pa'
        ? (line) => proj.paDist.reduce((s, [n, p]) => s + (n > line ? p : 0), 0)
        : proj.dist[m];
      const pmf = pmfOf(dist, spec.max);
      pmf[spec.max] = Math.max(0, dist(spec.max - 0.5));
      const pm = pmf.reduce((s, p, k) => s + p * k, 0);
      const pv = pmf.reduce((s, p, k) => s + p * (k - pm) ** 2, 0);
      const A = acc[m];
      A.n++; A.sumP += mean; A.sumA += a; A.sumSq += (a - mean) ** 2; A.sumVar += pv;
      A.sumPP += mean * mean; A.sumPA += mean * a;
      A.ll += -Math.log(Math.max(1e-9, pmf[Math.min(a, spec.max)]));
      for (const line of spec.lines) {
        const p = dist(line);
        const o = a > line ? 1 : 0;
        A.brier += (p - o) ** 2; A.nb++;
        const L = A.lines.get(line);
        L.p += p; L.o += o; L.n++;
      }
    }
  }
  const out = {};
  for (const m of only) {
    const A = acc[m];
    if (!A.n) continue;
    const mp = A.sumP / A.n;
    out[m] = {
      n: A.n,
      meanProj: mp,
      meanActual: A.sumA / A.n,
      biasPct: (100 * (A.sumA / A.n - mp)) / mp,
      slope: (A.sumPA / A.n - mp * (A.sumA / A.n)) / (A.sumPP / A.n - mp * mp),
      dispersion: A.sumSq / A.sumVar,
      logLoss: A.ll / A.n,
      brier: A.brier / A.nb,
      lines: [...A.lines].map(([l, L]) => `${l}: ${(100 * L.p / L.n).toFixed(1)}/${(100 * L.o / L.n).toFixed(1)}`),
    };
  }
  return out;
}

/** The one number a search is allowed to minimise: total log loss over the traded markets. */
export const TRADED = ['hits', 'tb', 'hr', 'rbi', 'hrr', 'sb'];
export const objective = (rep, markets = TRADED) => markets.reduce((s, m) => s + (rep[m]?.logLoss ?? 0), 0);

export function printReport(rep, label) {
  console.log(`\n=== ${label} ===`);
  for (const [m, r] of Object.entries(rep)) {
    console.log(
      `${m.padEnd(7)} n=${r.n}  proj ${r.meanProj.toFixed(3)} act ${r.meanActual.toFixed(3)} (${r.biasPct >= 0 ? '+' : ''}${r.biasPct.toFixed(1)}%)` +
      `  slope ${r.slope.toFixed(3)}  disp ${r.dispersion.toFixed(3)}  LL ${r.logLoss.toFixed(5)}  Brier ${r.brier.toFixed(5)}   ${r.lines.join(' ')}`,
    );
  }
  console.log(`objective (traded LL sum) ${objective(rep).toFixed(5)}`);
}

// ── rows, with a recency knob ───────────────────────────────────────────────
export function loadRows({ tau = Infinity } = {}) {
  const rows = buildRows();
  if (Number.isFinite(tau)) {
    for (const r of rows) r.input = { ...r.input, season26: weightedSeason(hitLogs.get(r.id) || [], r.date, tau) };
  }
  return rows;
}

export const split = (rows) => ({
  FIT: rows.filter((r) => windowOf(r.date) === 'FIT'),
  VAL: rows.filter((r) => windowOf(r.date) === 'VAL'),
  HOLD: rows.filter((r) => windowOf(r.date) === 'HOLD'),
});

// ── driver ──────────────────────────────────────────────────────────────────
function merged(over = {}) {
  return { ...BATTER_TUNING, ...over, priorStrength: { ...BATTER_TUNING.priorStrength, ...(over.priorStrength || {}) } };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'batter-research.mjs') {
  const mode = arg('mode', 'base');
  const JSON_OUT = arg('json', null);
  const rows = loadRows();
  const W = split(rows);
  console.log(`rows FIT ${W.FIT.length}  VAL ${W.VAL.length}  HOLD ${W.HOLD.length}`);
  const results = {};

  if (mode === 'base') {
    for (const k of ['FIT', 'VAL']) printReport(evaluate(W[k], null), `${k} — shipped model`);
  }

  if (mode === 'shrink') {
    // One rate at a time on FIT, everything else held at the shipped value.
    const base = evaluate(W.FIT, merged());
    console.log(`FIT baseline objective ${objective(base).toFixed(5)}`);
    for (const [key, market, grid] of [
      ['hit', 'hits', [60, 100, 150, 200, 300, 450, 600, 900]],
      ['single', 'singles', [60, 100, 150, 200, 300, 450, 600, 900]],
      ['double', 'tb', [80, 120, 180, 260, 400, 600, 900]],
      ['triple', 'tb', [120, 200, 300, 500, 800]],
      ['run', 'runs', [60, 100, 150, 250, 400, 600, 900]],
      ['rbi', 'rbi', [60, 100, 150, 250, 400, 600, 900, 1400]],
      ['k', 'k', [40, 60, 100, 150, 250, 400]],
      ['sb', 'sb', [15, 30, 60, 100, 160, 250]],
    ]) {
      const line = grid.map((v) => {
        const rep = evaluate(W.FIT, merged({ priorStrength: { [key]: v } }), { only: [market] });
        return `${v}:${rep[market].logLoss.toFixed(5)}/s${rep[market].slope.toFixed(2)}`;
      });
      console.log(`${key.padEnd(7)} ${line.join('  ')}`);
    }
    for (const v of [60, 100, 200, 300, 450, 600, 900]) {
      const rep = evaluate(W.FIT, merged({ hrPriorStrength: v }), { only: ['hr', 'tb'] });
      console.log(`hr      ${v}:${(rep.hr.logLoss + rep.tb.logLoss).toFixed(5)}/s${rep.hr.slope.toFixed(2)}`);
    }
    for (const w of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.3]) {
      const rep = evaluate(W.FIT, merged({ seasonPriorWeight: w }));
      console.log(`w25 ${w}  objective ${objective(rep).toFixed(5)}  hits LL ${rep.hits.logLoss.toFixed(5)} slope ${rep.hits.slope.toFixed(3)}`);
    }
  }

  if (mode === 'recency') {
    for (const tau of [Infinity, 240, 150, 100, 70, 50, 35, 25, 18]) {
      const rs = split(loadRows({ tau }));
      const rep = evaluate(rs.FIT, merged());
      console.log(`tau ${String(tau).padStart(4)}  objective ${objective(rep).toFixed(5)}  hits ${rep.hits.logLoss.toFixed(5)} (slope ${rep.hits.slope.toFixed(3)})  hrr ${rep.hrr.logLoss.toFixed(5)}  sb ${rep.sb.logLoss.toFixed(5)}`);
    }
  }

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
}
