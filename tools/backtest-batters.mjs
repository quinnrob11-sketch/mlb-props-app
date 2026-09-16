// Lookahead-free backtest of the batter model against real outcomes.
//
//   node tools/backtest-batters.mjs --from 2026-08-10 --to 2026-09-15 [--split 2026-09-01] [--cache DIR] [--diag]
//
// For every final regular-season game in the window, from the boxscore:
//   - the nine hitters in each POSTED batting order (starters only: the player
//     whose `battingOrder` is "<slot>00"), their slot and home/away side,
//   - the opposing STARTING pitcher (first pitcher listed for the other side),
//   - each starter's actual line (the outcome being scored).
// Then, from games BEFORE that date only:
//   - the hitter's 2026 season line (his hitting game log, summed),
//   - the starter's 2026 season line and start log, run through the real
//     `projectPitcher` to get his raw shrunk rates `proj.rates.{kRate,hRate,
//     hrRate}` exactly as loadSlate forwards them,
//   - the league object loadSlate builds (kRate, bbRate, avg, sbPerGame and the
//     starter baselines) from the 30 team hitting game logs,
// plus the 2025 season lines (fixed, no lookahead possible) and handedness,
// and calls the real `projectBatter` with loadSlate's exact argument shape.
//
// Not replicated, and why it is safe to omit:
//   - weather (`wx`): omitted, so weatherHrFactor is 1 everywhere. It only
//     scales HR (and runs at 0.4 pass-through) by <= +-12%, symmetric around
//     72F; over a five-week window it moves the market level, not the shape.
//   - projected lineups: every row uses the posted card. The board only trades
//     confirmed lineups (bot `requireConfirmedLineup`).
//   - The starter is the boxscore starter, not the listed probable. Differs
//     only for late scratches and openers.
//
// Everything fetched is cached under --cache (statsapi is unmetered, but be
// polite: 8 concurrent requests).

import path from 'node:path';
import { projectBatter } from '../src/model/batter.js';
import { projectPitcher, parseInningsPitched } from '../src/model/pitcher.js';
import {
  API, argv, makeCache, pool, pitcherSeasonBefore, hitterSeasonBefore,
  teamRatesBefore, makeLeagueBefore, pmfOf,
} from './backtest-common.mjs';

const FROM = argv('from', '2026-08-10');
const TO = argv('to', '2026-09-15');
const SPLIT = argv('split', null);
const SEASON = Number(FROM.slice(0, 4));
const cached = makeCache(argv('cache', path.resolve('.backtest-cache-batter')));

// ── data ────────────────────────────────────────────────────────────────────
const schedule = await cached(
  `schedule_${SEASON}_${TO}`,
  `${API}/schedule?sportId=1&gameType=R&startDate=${SEASON}-03-20&endDate=${TO}&hydrate=probablePitcher`,
);
const games = [];
const teamIds = new Set();
for (const d of schedule.dates) {
  for (const g of d.games) {
    teamIds.add(g.teams.away.team.id);
    teamIds.add(g.teams.home.team.id);
    if (d.date >= FROM && d.date <= TO && g.status?.abstractGameState === 'Final' && g.status?.detailedState !== 'Postponed') {
      games.push({ gamePk: g.gamePk, date: d.date, venue: g.venue?.name || '' });
    }
  }
}

const boxes = new Map();
await pool(games, 8, async (g) => {
  boxes.set(g.gamePk, await cached(`box_${g.gamePk}`, `${API}/game/${g.gamePk}/boxscore`));
});

const batterIds = new Set();
const starterIds = new Set();
for (const g of games) {
  const box = boxes.get(g.gamePk);
  for (const side of ['away', 'home']) {
    const t = box.teams[side];
    for (const p of Object.values(t.players)) {
      if (/^[1-9]00$/.test(String(p.battingOrder || ''))) batterIds.add(p.person.id);
    }
    if (t.pitchers?.length) starterIds.add(t.pitchers[0]);
  }
}

const teamLogs = new Map();
await pool([...teamIds], 8, async (id) => {
  const body = await cached(`teamhit_${id}_${SEASON}`, `${API}/teams/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  teamLogs.set(id, body.stats?.[0]?.splits || []);
});

const hitLogs = new Map();
await pool([...batterIds], 8, async (id) => {
  const body = await cached(`hitlog_${id}_${SEASON}`, `${API}/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  hitLogs.set(id, body.stats?.[0]?.splits || []);
});

const pitchLogs = new Map();
await pool([...starterIds], 8, async (id) => {
  const body = await cached(`pitchlog_${id}_${SEASON}`, `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${SEASON}`);
  pitchLogs.set(id, body.stats?.[0]?.splits || []);
});

/**
 * Prior-season line and handedness. `pickSplit` in src/lib/names.js takes the
 * FIRST split for the season; for a player traded mid-season the people
 * hydrate lists per-team splits, so this mirrors the combined line where one
 * exists (a split with no `team`) and the first split otherwise.
 */
async function people(ids, group, tag) {
  const out = new Map();
  const list = [...ids].sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < list.length; i += 40) chunks.push(list.slice(i, i + 40));
  await pool(chunks, 8, async (chunk) => {
    const body = await cached(
      `${tag}_${SEASON - 1}_${chunk[0]}_${chunk.length}`,
      `${API}/people?personIds=${chunk.join(',')}&hydrate=stats(group=[${group}],type=[season],season=${SEASON - 1})`,
    );
    for (const person of body.people || []) {
      const splits = person.stats?.[0]?.splits || [];
      const split = splits.find((s) => !s.team) || splits[0];
      out.set(person.id, {
        prior: split?.stat || null,
        batSide: person.batSide?.code,
        pitchHand: person.pitchHand?.code,
        splits: splits.length,
      });
    }
  });
  return out;
}
const batterPeople = await people(batterIds, 'hitting', 'hitprior');
const pitcherPeople = await people(starterIds, 'pitching', 'pitchprior');

const leagueBefore = makeLeagueBefore(teamLogs);

// ── rows ────────────────────────────────────────────────────────────────────
function starterInput(id, date, park, oppTeamId, lg) {
  const logs = pitchLogs.get(id) || [];
  const gameLog = logs
    .filter((x) => x.date < date && Number(x.stat.gamesStarted) > 0)
    .map((x) => ({
      ip: parseInningsPitched(x.stat.inningsPitched),
      pitches: Number(x.stat.numberOfPitches || 0),
      bf: Number(x.stat.battersFaced || 0),
      k: Number(x.stat.strikeOuts || 0),
      date: x.date,
    }));
  const t = teamRatesBefore(teamLogs.get(oppTeamId) || [], date);
  return {
    season26: pitcherSeasonBefore(logs, date),
    season25: pitcherPeople.get(id)?.prior || null,
    gameLog,
    opp: t.pa ? { kRate: t.k / t.pa, bbRate: t.bb / t.pa, avg: t.h / t.ab } : null,
    park,
    lg,
  };
}

export function buildRows() {
  const rows = [];
  for (const g of games) {
    const box = boxes.get(g.gamePk);
    const lg = leagueBefore(g.date);
    for (const side of ['away', 'home']) {
      const team = box.teams[side];
      const opp = box.teams[side === 'away' ? 'home' : 'away'];
      const spId = opp.pitchers?.[0];
      let spRates = null;
      let pitcherHand;
      if (spId) {
        const proj = projectPitcher(starterInput(spId, g.date, g.venue, team.team.id, lg));
        spRates = { kRate: proj.rates.kRate, hRate: proj.rates.hRate, hrRate: proj.rates.hrRate };
        // loadSlate: `hand: person?.pitchHand?.code || 'R'`
        pitcherHand = pitcherPeople.get(spId)?.pitchHand || 'R';
      }
      // `team.battingOrder` is the FINAL card (a substitute replaces the man he
      // hit for), so the posted starters are found by their own `battingOrder`
      // code instead: "<slot>00" is the player who started in that slot.
      for (const p of Object.values(team.players)) {
        const code = String(p.battingOrder || '');
        if (!/^[1-9]00$/.test(code)) continue;
        const slot = Number(code[0]);
        const id = p.person.id;
        const b = p.stats?.batting || {};
        if (b.plateAppearances == null) continue;
        const who = batterPeople.get(id) || {};
        const h = Number(b.hits || 0), d2 = Number(b.doubles || 0), d3 = Number(b.triples || 0), hr = Number(b.homeRuns || 0);
        const r = Number(b.runs || 0), rbi = Number(b.rbi || 0);
        rows.push({
          id,
          gamePk: g.gamePk,
          date: g.date,
          slot,
          side,
          input: {
            season26: hitterSeasonBefore(hitLogs.get(id) || [], g.date),
            season25: who.prior || null,
            slot,
            isAway: side === 'away',
            batSide: who.batSide,
            pitcherHand,
            spRates,
            park: g.venue,
            lg,
          },
          actual: {
            pa: Number(b.plateAppearances || 0),
            hits: h,
            tb: h + d2 + 2 * d3 + 3 * hr,
            hr,
            rbi,
            runs: r,
            hrr: h + r + rbi,
            k: Number(b.strikeOuts || 0),
            singles: h - d2 - d3 - hr,
            sb: Number(b.stolenBases || 0),
          },
        });
      }
    }
  }
  return rows;
}

// ── evaluation ──────────────────────────────────────────────────────────────
export const MARKETS = {
  // Not a market: the plate-appearance distribution every count market sits on.
  pa:      { key: null,                    proj: 'pa',      lines: [2.5, 3.5, 4.5, 5.5],      max: 9 },
  hits:    { key: 'batter_hits',           proj: 'projH',   lines: [0.5, 1.5, 2.5],           max: 7 },
  tb:      { key: 'batter_total_bases',    proj: 'projTB',  lines: [0.5, 1.5, 2.5, 3.5, 4.5], max: 20 },
  hr:      { key: 'batter_home_runs',      proj: 'projHR',  lines: [0.5, 1.5],                max: 5 },
  rbi:     { key: 'batter_rbis',           proj: 'projRBI', lines: [0.5, 1.5, 2.5],           max: 12 },
  hrr:     { key: 'batter_hits_runs_rbis', proj: 'projHRR', lines: [0.5, 1.5, 2.5, 3.5, 4.5], max: 20 },
  runs:    { key: 'batter_runs_scored',    proj: 'projR',   lines: [0.5, 1.5],                max: 8 },
  k:       { key: 'batter_strikeouts',     proj: 'projK',   lines: [0.5, 1.5, 2.5],           max: 7 },
  singles: { key: 'batter_singles',        proj: 'proj1B',  lines: [0.5, 1.5],                max: 7 },
  sb:      { key: 'batter_stolen_bases',   proj: 'projSB',  lines: [0.5],                     max: 5 },
};

/**
 * Per market: mean bias (actual vs projected, % of projected), slope of actual
 * on projected, dispersion ratio (squared error / the model's own variance),
 * log loss of the full pmf at the actual count, Brier over the listed lines,
 * and predicted-vs-observed at each line. `projs` may be a precomputed array
 * of projections aligned with `rows` (saves re-projecting per market).
 */
export function evaluate(rows, project = projectBatter, only = null, projs = null) {
  const P = projs || rows.map((r) => project(r.input));
  const report = {};
  for (const [m, spec] of Object.entries(MARKETS)) {
    if (only && !only.includes(m)) continue;
    let n = 0, sumP = 0, sumA = 0, sumSq = 0, sumVar = 0, sumPP = 0, sumPA = 0, logLoss = 0, brier = 0, nb = 0;
    const perLine = new Map(spec.lines.map((l) => [l, { p: 0, o: 0, n: 0, ll: 0 }]));
    for (let i = 0; i < rows.length; i++) {
      const proj = P[i];
      const mean = proj[spec.proj];
      const a = rows[i].actual[m];
      if (!Number.isFinite(mean) || !Number.isFinite(a)) continue;
      const dist = m === 'pa'
        ? (line) => proj.paDist.reduce((acc, [n, p]) => acc + (n > line ? p : 0), 0)
        : proj.dist[m];
      const pmf = pmfOf(dist, spec.max);
      // Last bucket carries the whole upper tail.
      pmf[spec.max] = Math.max(0, dist(spec.max - 0.5));
      const pm = pmf.reduce((acc, p, k) => acc + p * k, 0);
      const pv = pmf.reduce((acc, p, k) => acc + p * (k - pm) ** 2, 0);
      n++; sumP += mean; sumA += a; sumSq += (a - mean) ** 2; sumVar += pv;
      sumPP += mean * mean; sumPA += mean * a;
      logLoss += -Math.log(Math.max(1e-9, pmf[Math.min(a, spec.max)]));
      for (const line of spec.lines) {
        const p = dist(line);
        const o = a > line ? 1 : 0;
        brier += (p - o) ** 2; nb++;
        const L = perLine.get(line);
        L.p += p; L.o += o; L.n++;
        L.ll += -Math.log(Math.max(1e-9, o ? p : 1 - p));
      }
    }
    const meanP = sumP / n;
    report[m] = {
      n,
      meanProj: meanP,
      meanActual: sumA / n,
      biasPct: (100 * (sumA / n - meanP)) / meanP,
      slope: (sumPA / n - meanP * (sumA / n)) / (sumPP / n - meanP * meanP),
      dispersion: sumSq / sumVar,
      logLoss: logLoss / n,
      brier: brier / nb,
      lineStats: [...perLine].map(([l, L]) => ({ line: l, pred: L.p / L.n, obs: L.o / L.n, n: L.n, logLoss: L.ll / L.n })),
      lines: [...perLine].map(([l, L]) => `${l}: ${(100 * L.p / L.n).toFixed(1)} vs ${(100 * L.o / L.n).toFixed(1)}`),
    };
  }
  return report;
}

export function printReport(report, label) {
  console.log(`\n=== ${label} ===`);
  for (const [m, r] of Object.entries(report)) {
    console.log(
      `${m.padEnd(7)} n=${r.n}  proj ${r.meanProj.toFixed(3)} actual ${r.meanActual.toFixed(3)} (bias ${r.biasPct >= 0 ? '+' : ''}${r.biasPct.toFixed(1)}%)  slope ${r.slope.toFixed(2)}  disp ${r.dispersion.toFixed(3)}  logloss ${r.logLoss.toFixed(4)}  brier ${r.brier.toFixed(4)}`,
    );
    console.log(`        by line (pred vs obs %): ${r.lines.join('  ')}`);
  }
}

function diagnostics(rows) {
  // Plate appearances by slot and side vs PA_BY_LINEUP_SLOT.
  const bySlot = new Map();
  for (const r of rows) {
    const k = `${r.slot}${r.side[0]}`;
    const s = bySlot.get(k) || { n: 0, pa: 0, proj: 0, pa2: 0 };
    const pr = projectBatter(r.input);
    s.n++; s.pa += r.actual.pa; s.pa2 += r.actual.pa ** 2; s.proj += pr.pa;
    bySlot.set(k, s);
  }
  console.log('\nPA by slot/side: actual mean (sd) vs model');
  for (const [k, s] of [...bySlot].sort()) {
    const m = s.pa / s.n;
    console.log(`  ${k} n=${s.n}  ${m.toFixed(3)} (${Math.sqrt(s.pa2 / s.n - m * m).toFixed(3)}) vs ${(s.proj / s.n).toFixed(3)}`);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'backtest-batters.mjs') {
  const rows = buildRows();
  console.log(`${rows.length} batter-games, ${games.length} games, ${FROM}..${TO}, ${batterIds.size} hitters, ${starterIds.size} starters`);
  if (process.argv.includes('--diag')) diagnostics(rows);
  if (SPLIT) {
    printReport(evaluate(rows.filter((s) => s.date < SPLIT)), `fit window < ${SPLIT}`);
    printReport(evaluate(rows.filter((s) => s.date >= SPLIT)), `holdout >= ${SPLIT}`);
  } else {
    printReport(evaluate(rows), 'all');
  }
}
