// Lookahead-free backtest of the starting-pitcher model against real outcomes.
//
//   node tools/backtest-pitchers.mjs --from 2026-08-10 --to 2026-09-15 [--cache DIR] [--split 2026-09-01]
//
// Works for any season with the same flags (e.g. --from 2025-04-15 --to
// 2025-09-28); the prior season is always FROM's year minus one.
//
// Besides level (bias), spread (dispersion) and the proper scores, it reports
// per-pitcher discrimination: `corr` (projection vs actual across starts) and
// `mae` (mean |projection - actual|).
//
// For every start in the window it rebuilds, from games BEFORE that date only:
//   - the pitcher's season line (from his game log) and recent starts,
//   - the opponent's season hitting rates (from the team game log),
//   - league K/BB/AVG and the starter baselines loadSlate derives from them,
// then runs the real `projectPitcher` and scores it against what happened.
//
// Not replicated: posted lineups (the team aggregate is used, which is what
// loadSlate falls back to), platoon splits, and weather — none of which
// projectPitcher's distributions depend on for their SHAPE.
//
// Everything fetched is cached under --cache, so re-running after a model change
// costs nothing. Statsapi is unmetered.

import fs from 'node:fs';
import path from 'node:path';
import { projectPitcher, parseInningsPitched } from '../src/model/pitcher.js';
import { LEAGUE_AVG } from '../src/model/league.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const FROM = arg('from', '2026-08-10');
const TO = arg('to', '2026-09-15');
const SPLIT = arg('split', null);
const SEASON = Number(FROM.slice(0, 4));
const CACHE = arg('cache', path.resolve('.backtest-cache'));
fs.mkdirSync(CACHE, { recursive: true });

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

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const API = 'https://statsapi.mlb.com/api/v1';

// ── data ────────────────────────────────────────────────────────────────────
const schedule = await cached(
  `schedule_${SEASON}_${TO}`,
  `${API}/schedule?sportId=1&gameType=R&startDate=${SEASON}-03-20&endDate=${TO}&hydrate=probablePitcher`,
);
export { schedule };
const venueByGame = new Map();
const teamIds = new Set();
const pitcherIds = new Set();
for (const d of schedule.dates) {
  for (const g of d.games) {
    venueByGame.set(g.gamePk, g.venue?.name || '');
    teamIds.add(g.teams.away.team.id);
    teamIds.add(g.teams.home.team.id);
    if (d.date >= FROM && d.date <= TO) {
      for (const side of ['away', 'home']) {
        const p = g.teams[side].probablePitcher;
        if (p) pitcherIds.add(p.id);
      }
    }
  }
}

export const teamLogs = new Map();
await pool([...teamIds], 8, async (id) => {
  const body = await cached(`teamhit_${id}_${SEASON}`, `${API}/teams/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  teamLogs.set(id, body.stats?.[0]?.splits || []);
});

export const pitcherLogs = new Map();
await pool([...pitcherIds], 8, async (id) => {
  const body = await cached(`pitchlog_${id}_${SEASON}`, `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${SEASON}`);
  pitcherLogs.set(id, body.stats?.[0]?.splits || []);
});

const prior = new Map();
const ids = [...pitcherIds];
for (let i = 0; i < ids.length; i += 40) {
  const chunk = ids.slice(i, i + 40);
  const body = await cached(
    `prior_${SEASON - 1}_${chunk[0]}_${chunk.length}`,
    `${API}/people?personIds=${chunk.join(',')}&hydrate=stats(group=[pitching],type=[season],season=${SEASON - 1})`,
  );
  for (const person of body.people || []) {
    const split = person.stats?.[0]?.splits?.find((s) => !s.team) || person.stats?.[0]?.splits?.[0];
    if (split) prior.set(person.id, split.stat);
  }
}

// ── as-of aggregation ───────────────────────────────────────────────────────
const SUM_FIELDS = ['gamesStarted', 'gamesPlayed', 'battersFaced', 'strikeOuts', 'baseOnBalls', 'hits', 'homeRuns', 'numberOfPitches', 'earnedRuns', 'outs', 'strikes'];

function pitcherSeasonBefore(logs, date) {
  const s = Object.fromEntries(SUM_FIELDS.map((f) => [f, 0]));
  for (const g of logs) {
    if (g.date >= date) continue;
    for (const f of SUM_FIELDS) s[f] += Number(g.stat[f] || 0);
  }
  if (!s.gamesPlayed) return null;
  const ip = s.outs / 3;
  return {
    ...s,
    inningsPitched: `${Math.floor(s.outs / 3)}.${s.outs % 3}`,
    era: ip > 0 ? ((9 * s.earnedRuns) / ip).toFixed(2) : '-.--',
    strikePercentage: s.numberOfPitches ? (s.strikes / s.numberOfPitches).toFixed(3).replace(/^0/, '') : undefined,
  };
}

function teamRatesBefore(logs, date) {
  let pa = 0, k = 0, bb = 0, h = 0, ab = 0;
  for (const g of logs) {
    if (g.date >= date) continue;
    const st = g.stat;
    pa += Number(st.plateAppearances || 0);
    k += Number(st.strikeOuts || 0);
    bb += Number(st.baseOnBalls || 0);
    h += Number(st.hits || 0);
    ab += Number(st.atBats || 0);
  }
  return { pa, k, bb, h, ab };
}

// ── run ─────────────────────────────────────────────────────────────────────
const SP_TO_LEAGUE_H = 1.0187;
const SP_TO_LEAGUE_K = 0.9871;
const SP_TO_LEAGUE_BB = 0.9266;
const leagueCache = new Map();
function leagueBefore(date) {
  if (leagueCache.has(date)) return leagueCache.get(date);
  let pa = 0, k = 0, bb = 0, h = 0, ab = 0;
  for (const logs of teamLogs.values()) {
    const t = teamRatesBefore(logs, date);
    pa += t.pa; k += t.k; bb += t.bb; h += t.h; ab += t.ab;
  }
  const lg = {
    ...LEAGUE_AVG,
    kRate: k / pa, bbRate: bb / pa, avg: h / ab,
    spHRate: (h / pa) * SP_TO_LEAGUE_H, spKRate: (k / pa) * SP_TO_LEAGUE_K, spBbRate: (bb / pa) * SP_TO_LEAGUE_BB,
  };
  leagueCache.set(date, lg);
  return lg;
}

export function buildStarts() {
  const starts = [];
  for (const [id, logs] of pitcherLogs) {
    for (const g of logs) {
      if (g.date < FROM || g.date > TO || Number(g.stat.gamesStarted) !== 1) continue;
      const s26 = pitcherSeasonBefore(logs, g.date);
      const gameLog = logs
        .filter((x) => x.date < g.date && Number(x.stat.gamesStarted) > 0)
        .map((x) => ({
          ip: parseInningsPitched(x.stat.inningsPitched),
          pitches: Number(x.stat.numberOfPitches || 0),
          bf: Number(x.stat.battersFaced || 0),
          k: Number(x.stat.strikeOuts || 0),
          date: x.date,
        }));
      // Every appearance before tonight, RELIEF INCLUDED. `gameLog` above is
      // the same log with the relief rows filtered out, which is exactly what
      // `loadSlate` does; v38's role read needs the rows it throws away, and
      // costs no extra request in either place.
      const appearanceLog = logs
        .filter((x) => x.date < g.date)
        .map((x) => ({
          date: x.date,
          gs: Number(x.stat.gamesStarted || 0),
          outs: Number(x.stat.outs || 0),
          pitches: Number(x.stat.numberOfPitches || 0),
        }));
      const t = teamRatesBefore(teamLogs.get(g.opponent.id) || [], g.date);
      starts.push({
        id,
        date: g.date,
        // Identity of the game, for joining starts to external markets
        // (tools/backtest-kalshi.mjs). Not used by the model.
        name: g.player?.fullName || null,
        gamePk: g.game?.gamePk ?? null,
        teamId: g.team?.id ?? null,
        oppId: g.opponent?.id ?? null,
        isHome: g.isHome ?? null,
        // Context the model does not read; for research scripts only.
        meta: { team: g.team?.id, opp: g.opponent?.id, isHome: g.isHome, gamePk: g.game?.gamePk },
        input: {
          // The slate date. `loadSlate` has always known it; it reached
          // `projectPitcher` only in v36.2, when the workload term started
          // weighting a start by how long ago it was. Passing it here is not
          // new information — every game log entry is already filtered by it.
          date: g.date,
          season26: s26,
          season25: prior.get(id) || null,
          gameLog,
          appearanceLog,
          opp: t.pa ? { kRate: t.k / t.pa, bbRate: t.bb / t.pa, avg: t.h / t.ab } : null,
          park: venueByGame.get(g.game.gamePk) || '',
          lg: leagueBefore(g.date),
          // loadSlate knows which side the starter is on; so does the log.
          isHome: g.isHome,
        },
        actual: {
          k: Number(g.stat.strikeOuts),
          outs: Number(g.stat.outs),
          hits: Number(g.stat.hits),
          bb: Number(g.stat.baseOnBalls),
          er: Number(g.stat.earnedRuns),
        },
      });
    }
  }
  return starts;
}

const MARKETS = {
  k: { proj: 'projK', lines: [3.5, 4.5, 5.5, 6.5, 7.5], max: 20 },
  outs: { proj: 'projOuts', lines: [13.5, 14.5, 15.5, 16.5, 17.5, 18.5], max: 27 },
  hits: { proj: 'projH', lines: [3.5, 4.5, 5.5, 6.5], max: 20 },
  bb: { proj: 'projBB', lines: [0.5, 1.5, 2.5], max: 12 },
  er: { proj: 'projER', lines: [0.5, 1.5, 2.5, 3.5], max: 15 },
};

/** Model pmf from its survival function at half-integer lines. */
function pmfOf(dist, max) {
  const pmf = [];
  for (let k = 0; k <= max; k++) {
    const atLeast = k === 0 ? 1 : dist(k - 0.5);
    const above = dist(k + 0.5);
    pmf.push(Math.max(0, atLeast - above));
  }
  return pmf;
}

export function evaluate(starts, project = projectPitcher, only = null) {
  const report = {};
  for (const [m, spec] of Object.entries(MARKETS)) {
    if (only && !only.includes(m)) continue;
    let n = 0, sumP = 0, sumA = 0, sumSq = 0, sumVar = 0, sumPP = 0, sumPA = 0, sumAA = 0, sumAbs = 0, logLoss = 0, brier = 0, nb = 0;
    const bins = Array.from({ length: 10 }, () => ({ p: 0, o: 0, n: 0 }));
    const perLine = new Map(spec.lines.map((l) => [l, { p: 0, o: 0, n: 0 }]));
    for (const s of starts) {
      const proj = project(s.input);
      const mean = proj[spec.proj];
      const a = s.actual[m];
      if (!Number.isFinite(mean) || !Number.isFinite(a)) continue;
      const dist = proj.dist[m];
      const pmf = pmfOf(dist, spec.max);
      const pm = pmf.reduce((acc, p, k) => acc + p * k, 0);
      const pv = pmf.reduce((acc, p, k) => acc + p * (k - pm) ** 2, 0);
      n++; sumP += mean; sumA += a; sumSq += (a - mean) ** 2; sumVar += pv;
      sumPP += mean * mean; sumPA += mean * a; sumAA += a * a; sumAbs += Math.abs(a - mean);
      logLoss += -Math.log(Math.max(1e-6, pmf[Math.min(a, spec.max)] || 1e-6));
      for (const line of spec.lines) {
        const p = dist(line);
        const o = a > line ? 1 : 0;
        brier += (p - o) ** 2; nb++;
        const b = bins[Math.min(9, Math.floor(p * 10))];
        b.p += p; b.o += o; b.n++;
        const L = perLine.get(line);
        L.p += p; L.o += o; L.n++;
      }
    }
    const meanP = sumP / n;
    const cov = sumPA / n - meanP * (sumA / n);
    const slope = cov / (sumPP / n - meanP * meanP);
    // Per-pitcher discrimination: how well the projection ranks starts, and its
    // typical miss. Level-independent (corr) and level-sensitive (mae).
    const corr = cov / Math.sqrt((sumPP / n - meanP * meanP) * (sumAA / n - (sumA / n) ** 2));
    report[m] = {
      n,
      meanProj: meanP,
      meanActual: sumA / n,
      biasPct: (100 * (sumA / n - meanP)) / meanP,
      slope,
      corr,
      mae: sumAbs / n,
      dispersion: sumSq / sumVar, // >1: real outcomes spread wider than the model's distribution
      logLoss: logLoss / n,
      brier: brier / nb,
      ece: bins.reduce((acc, b) => acc + (b.n ? Math.abs(b.p - b.o) : 0), 0) / nb,
      bins: bins.filter((b) => b.n >= 15).map((b) => `${(100 * b.p / b.n).toFixed(0)}→${(100 * b.o / b.n).toFixed(0)} (${b.n})`),
      lines: [...perLine].map(([l, L]) => `${l}: ${(100 * L.p / L.n).toFixed(1)} vs ${(100 * L.o / L.n).toFixed(1)}`),
    };
  }
  return report;
}

export function printReport(report, label) {
  console.log(`\n=== ${label} ===`);
  for (const [m, r] of Object.entries(report)) {
    console.log(
      `${m.padEnd(5)} n=${r.n}  proj ${r.meanProj.toFixed(2)} actual ${r.meanActual.toFixed(2)} (bias ${r.biasPct >= 0 ? '+' : ''}${r.biasPct.toFixed(1)}%)  slope ${r.slope.toFixed(2)}  corr ${r.corr.toFixed(3)}  mae ${r.mae.toFixed(3)}  dispersion ${r.dispersion.toFixed(2)}  logloss ${r.logLoss.toFixed(4)}  brier ${r.brier.toFixed(4)}`,
    );
    console.log(`      predicted→observed by bin: ${r.bins.join('  ')}`);
    console.log(`      by line (pred vs obs %): ${r.lines.join('  ')}`);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'backtest-pitchers.mjs') {
  const starts = buildStarts();
  console.log(`${starts.length} starts, ${FROM}..${TO}, ${pitcherIds.size} pitchers`);
  if (SPLIT) {
    printReport(evaluate(starts.filter((s) => s.date < SPLIT)), `fit window < ${SPLIT}`);
    printReport(evaluate(starts.filter((s) => s.date >= SPLIT)), `holdout >= ${SPLIT}`);
  } else {
    printReport(evaluate(starts), 'all');
  }
}
