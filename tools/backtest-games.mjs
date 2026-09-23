// Lookahead-free replay of the GAME model (moneyline, run line, total, NRFI).
//
//   node tools/backtest-games.mjs --from 2026-07-14 --to 2026-09-16 \
//     [--cache DIR] [--lineups] [--json out.json]
//
// For every completed regular-season game in the window it rebuilds, from games
// played strictly BEFORE that date only:
//
//   - each team's season hitting line (runs, games, OPS) from its game log;
//   - each team's STARTER and RELIEVER pitching split lines, rebuilt from every
//     pitcher's game log (`gamesStarted > 0` goes to the sp bucket, the rest to
//     rp), which is what `loadSlate` gets live from
//     `/teams/stats?stats=statSplits&sitCodes=sp,rp`;
//   - the league baselines `loadSlate` derives from those two payloads (runs per
//     team-game and `leagueRunPrevention`);
//   - both starters' as-of season and prior-season lines and their `projIP`,
//     from the same replay `tools/backtest-pitchers.mjs` uses;
//   - the venue, and each team's own home venue (the park term is two-sided);
//   - with `--lineups`, the posted batting orders and their as-of OPS, centred
//     across the slate exactly as `loadSlate` centres them.
//
// then runs the real `projectGame` and scores pHome, the total ladder, the run
// line and NRFI against what happened.
//
// NOT replicated: weather (`projectGame` gets no `wx`, so `weatherFactor` is 1 —
// there is no free historical forecast archive in this repo), and the starter is
// whoever actually started rather than whoever was the listed probable.
//
// Everything fetched is cached under --cache. Statsapi is free and unmetered.

import fs from 'node:fs';
import path from 'node:path';
import { buildStarts, schedule, teamLogs, pitcherLogs } from './backtest-pitchers.mjs';
import { projectPitcher } from '../src/model/pitcher.js';
import { projectGame, leagueRunPrevention } from '../src/model/game.js';
import { PA_BY_LINEUP_SLOT } from '../src/model/batter.js';
import { makeCache, pool, API } from './backtest-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

export const FROM = arg('from', '2026-07-14');
export const TO = arg('to', '2026-09-16');
export const SEASON = Number(FROM.slice(0, 4));
const CACHE = arg('cache', path.resolve('.backtest-cache'));
export const USE_LINEUPS = has('lineups');
const cached = makeCache(CACHE);

// ── venues ──────────────────────────────────────────────────────────────────
// The park a game is played in, and the park each team calls home. `projectGame`
// needs both: a team's own season lines carry its home park in both directions,
// and are neutralised by it before tonight's venue is applied.
const venueByGame = new Map();
const homeVenueCount = new Map(); // teamId -> Map(venue -> games)
const scheduleGames = [];
for (const d of schedule.dates) {
  for (const g of d.games) {
    const venue = g.venue?.name || '';
    venueByGame.set(g.gamePk, venue);
    const homeId = g.teams.home.team.id;
    if (!homeVenueCount.has(homeId)) homeVenueCount.set(homeId, new Map());
    const m = homeVenueCount.get(homeId);
    m.set(venue, (m.get(venue) || 0) + 1);
    scheduleGames.push({ date: d.date, g });
  }
}
export const homePark = new Map(
  [...homeVenueCount].map(([id, m]) => [id, [...m].sort((a, b) => b[1] - a[1])[0][0]]),
);

// ── team abbreviations ──────────────────────────────────────────────────────
// The same abbreviations `loadSlate` carries, which is what a Kalshi event
// ticker spells ("ATHTB"). The schedule payload does not hydrate them.
export const teamAbbr = new Map(
  ((await cached(`teams_${SEASON}`, `${API}/teams?sportId=1&season=${SEASON}`)).teams || [])
    .map((t) => [t.id, t.abbreviation]),
);

// ── actual results ──────────────────────────────────────────────────────────
// One schedule request for the window with the linescore hydrated: final score
// and the first-inning runs, which is what NRFI settles on.
const results = new Map(); // gamePk -> { away, home, firstInningRuns, innings }
{
  const body = await cached(
    `schedule_line_${SEASON}_${FROM}_${TO}`,
    `${API}/schedule?sportId=1&gameType=R&startDate=${FROM}&endDate=${TO}&hydrate=linescore`,
  );
  for (const d of body.dates || []) {
    for (const g of d.games || []) {
      const ls = g.linescore;
      if (g.status?.abstractGameState !== 'Final' || !ls) continue;
      const first = (ls.innings || []).find((i) => i.num === 1);
      results.set(g.gamePk, {
        away: ls.teams?.away?.runs ?? null,
        home: ls.teams?.home?.runs ?? null,
        firstInningRuns:
          first ? (first.away?.runs ?? 0) + (first.home?.runs ?? 0) : null,
        innings: (ls.innings || []).length,
      });
    }
  }
}

// ── every pitcher's game log, for the team sp/rp splits ─────────────────────
// `/teams/stats?stats=statSplits&sitCodes=sp,rp` has no date range (it silently
// returns the whole season), so the split is rebuilt from the player game logs.
const allPitcherLogs = new Map(pitcherLogs); // reuse whatever backtest-pitchers already pulled
{
  const list = await cached(
    `pitchers_season_${SEASON}`,
    `${API}/stats?stats=season&group=pitching&sportId=1&season=${SEASON}&limit=2000&playerPool=All`,
  );
  const ids = (list.stats?.[0]?.splits || []).map((s) => s.player?.id).filter(Boolean);
  const missing = ids.filter((id) => !allPitcherLogs.has(id));
  process.stderr.write(`pitcher logs: ${allPitcherLogs.size} reused, ${missing.length} to fetch\n`);
  await pool(missing, 8, async (id) => {
    const body = await cached(
      `pitchlog_${id}_${SEASON}`,
      `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${SEASON}`,
    );
    allPitcherLogs.set(id, body.stats?.[0]?.splits || []);
  });
}

/** One flat list of pitcher-appearances: which team, which date, starter or not. */
const appearances = [];
for (const logs of allPitcherLogs.values()) {
  for (const g of logs) {
    if (g.gameType && g.gameType !== 'R') continue;
    const teamId = g.team?.id;
    if (!teamId) continue;
    appearances.push({
      teamId,
      date: g.date,
      isStart: Number(g.stat.gamesStarted || 0) > 0,
      outs: Number(g.stat.outs || 0),
      er: Number(g.stat.earnedRuns || 0),
      hr: Number(g.stat.homeRuns || 0),
      bb: Number(g.stat.baseOnBalls || 0),
      hbp: Number(g.stat.hitByPitch || 0),
      k: Number(g.stat.strikeOuts || 0),
    });
  }
}
appearances.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

/** Outs -> the "123.1" innings string statsapi returns and `game.js` parses. */
const ipString = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
const toStat = (t) =>
  t.outs > 0
    ? {
        inningsPitched: ipString(t.outs),
        earnedRuns: t.er,
        homeRuns: t.hr,
        baseOnBalls: t.bb,
        hitByPitch: t.hbp,
        strikeOuts: t.k,
      }
    : null;

const pitchingMemo = new Map();
/** Every team's sp and rp split line from appearances strictly before `date`. */
export function teamPitchingBefore(date) {
  if (pitchingMemo.has(date)) return pitchingMemo.get(date);
  const byTeam = new Map();
  for (const a of appearances) {
    if (a.date >= date) break; // sorted
    if (!byTeam.has(a.teamId)) {
      byTeam.set(a.teamId, {
        sp: { outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0 },
        rp: { outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0 },
      });
    }
    const t = byTeam.get(a.teamId)[a.isStart ? 'sp' : 'rp'];
    t.outs += a.outs; t.er += a.er; t.hr += a.hr; t.bb += a.bb; t.hbp += a.hbp; t.k += a.k;
  }
  const out = { sp: new Map(), rp: new Map(), spSplits: [], rpSplits: [] };
  for (const [id, t] of byTeam) {
    const sp = toStat(t.sp);
    const rp = toStat(t.rp);
    if (sp) { out.sp.set(id, sp); out.spSplits.push(sp); }
    if (rp) { out.rp.set(id, rp); out.rpSplits.push(rp); }
  }
  pitchingMemo.set(date, out);
  return out;
}

// ── team hitting, as of a date ──────────────────────────────────────────────
const HIT = ['runs', 'gamesPlayed', 'hits', 'doubles', 'triples', 'homeRuns', 'baseOnBalls', 'hitByPitch', 'atBats', 'sacFlies', 'totalBases', 'plateAppearances'];

/**
 * The `offense` object `projectGame` reads: runs, gamesPlayed and OPS. Only the
 * first two feed the run model; OPS is the denominator of `lineupOpsRatio`.
 */
function teamOffenseBefore(logs, date) {
  const s = Object.fromEntries(HIT.map((f) => [f, 0]));
  for (const g of logs) {
    if (g.date >= date) continue;
    for (const f of HIT) s[f] += Number(g.stat[f] || 0);
  }
  if (!s.gamesPlayed) return null;
  const obpDen = s.atBats + s.baseOnBalls + s.hitByPitch + s.sacFlies;
  const obp = obpDen ? (s.hits + s.baseOnBalls + s.hitByPitch) / obpDen : 0;
  const slg = s.atBats ? s.totalBases / s.atBats : 0;
  return { runs: s.runs, gamesPlayed: s.gamesPlayed, ops: obp + slg || null };
}

const leagueMemo = new Map();
/** `gameLeague` as loadSlate builds it: runs per team-game + run-prevention baselines. */
export function gameLeagueBefore(date) {
  if (leagueMemo.has(date)) return leagueMemo.get(date);
  let runs = 0;
  let games = 0;
  for (const logs of teamLogs.values()) {
    const o = teamOffenseBefore(logs, date);
    if (o) { runs += o.runs; games += o.gamesPlayed; }
  }
  const { spSplits, rpSplits } = teamPitchingBefore(date);
  const prevention = leagueRunPrevention(spSplits, rpSplits);
  const lg = {
    rpg: games && runs ? runs / games : 4.49,
    ...(prevention?.spRa9 && prevention?.rpRa9
      ? prevention
      : { spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 }),
  };
  leagueMemo.set(date, lg);
  return lg;
}

// ── starters ────────────────────────────────────────────────────────────────
// `backtest-pitchers.buildStarts()` already rebuilds every start's inputs from
// games before that date. Its season line drops `hitByPitch`, which the FIP
// numerator needs, so the season line is rebuilt here from the same game log.
const SP_SUM = ['gamesStarted', 'gamesPlayed', 'battersFaced', 'strikeOuts', 'baseOnBalls', 'hits', 'homeRuns', 'hitByPitch', 'numberOfPitches', 'earnedRuns', 'outs', 'strikes'];
function starterSeasonBefore(logs, date) {
  const s = Object.fromEntries(SP_SUM.map((f) => [f, 0]));
  for (const g of logs) {
    if (g.date >= date) continue;
    for (const f of SP_SUM) s[f] += Number(g.stat[f] || 0);
  }
  if (!s.gamesPlayed) return null;
  const ip = s.outs / 3;
  return {
    ...s,
    inningsPitched: ipString(s.outs),
    era: ip > 0 ? ((9 * s.earnedRuns) / ip).toFixed(2) : '-.--',
  };
}

// ── lineups (optional) ──────────────────────────────────────────────────────
// The posted batting orders, from the SAME schedule hydration `loadSlate` uses.
// Caveat: statsapi reports the card that actually took the field, so a lineup
// posted after the decision time is visible here but would not have been live.
const lineupRatio = new Map(); // `${gamePk}:${side}` -> ratio, slate-centred
if (USE_LINEUPS) {
  const windowDates = [...new Set(scheduleGames.filter((x) => x.date >= FROM && x.date <= TO).map((x) => x.date))].sort();
  const lineupsByGame = new Map(); // gamePk -> { away: [ids], home: [ids] }
  const wanted = new Set();
  await pool(windowDates, 6, async (date) => {
    const body = await cached(
      `sched_lineups_${date}`,
      `${API}/schedule?sportId=1&date=${date}&hydrate=lineups,team`,
    );
    for (const g of body.dates?.[0]?.games || []) {
      const away = (g.lineups?.awayPlayers || []).map((p) => p.id);
      const home = (g.lineups?.homePlayers || []).map((p) => p.id);
      if (!away.length && !home.length) continue;
      lineupsByGame.set(g.gamePk, { away, home, date });
      for (const id of [...away, ...home]) wanted.add(id);
    }
  });
  const hitLogs = new Map();
  process.stderr.write(`lineups: ${lineupsByGame.size} games, ${wanted.size} batters\n`);
  await pool([...wanted], 8, async (id) => {
    const body = await cached(
      `hitlog_${id}_${SEASON}`,
      `${API}/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`,
    );
    hitLogs.set(id, body.stats?.[0]?.splits || []);
  });
  const batterOpsBefore = (id, date) => {
    let ab = 0, h = 0, bb = 0, hbp = 0, sf = 0, tb = 0, pa = 0;
    for (const g of hitLogs.get(id) || []) {
      if (g.date >= date) continue;
      ab += Number(g.stat.atBats || 0); h += Number(g.stat.hits || 0);
      bb += Number(g.stat.baseOnBalls || 0); hbp += Number(g.stat.hitByPitch || 0);
      sf += Number(g.stat.sacFlies || 0); tb += Number(g.stat.totalBases || 0);
      pa += Number(g.stat.plateAppearances || 0);
    }
    const den = ab + bb + hbp + sf;
    return { pa, ops: den && ab ? (h + bb + hbp) / den + tb / ab : null };
  };
  // Raw ratios first, then centre per date, exactly as loadSlate does per slate.
  const raw = new Map(); // date -> [[key, ratio]]
  for (const [gamePk, lu] of lineupsByGame) {
    const g = scheduleGames.find((x) => x.g.gamePk === gamePk)?.g;
    if (!g) continue;
    for (const side of ['away', 'home']) {
      const ids = lu[side];
      const team = teamOffenseBefore(teamLogs.get(g.teams[side].team.id) || [], lu.date);
      if (ids.length < 9 || !team?.ops) continue;
      let weighted = 0;
      let weights = 0;
      ids.slice(0, 9).forEach((id, index) => {
        const b = batterOpsBefore(id, lu.date);
        const weight = PA_BY_LINEUP_SLOT[index] ?? PA_BY_LINEUP_SLOT[8];
        weighted += weight * (b.pa >= 50 && Number.isFinite(b.ops) ? b.ops : team.ops);
        weights += weight;
      });
      if (!weights) continue;
      if (!raw.has(lu.date)) raw.set(lu.date, []);
      raw.get(lu.date).push([`${gamePk}:${side}`, weighted / weights / team.ops]);
    }
  }
  for (const [, list] of raw) {
    if (list.length < 6) continue;
    const centre = list.reduce((a, b) => a + b[1], 0) / list.length;
    for (const [k, v] of list) lineupRatio.set(k, v / centre);
  }
}

// ── build ───────────────────────────────────────────────────────────────────
const startsByGame = new Map();
for (const s of buildStarts()) {
  if (!startsByGame.has(s.gamePk)) startsByGame.set(s.gamePk, []);
  startsByGame.get(s.gamePk).push(s);
}

/**
 * Every completed game in the window, replayed. `model` is the real
 * `projectGame` output (so `total(line)` and `spread(point)` are live
 * functions); `actual` is the box score.
 */
export function buildGames() {
  const out = [];
  const skip = {};
  const bump = (r) => (skip[r] = (skip[r] || 0) + 1);
  for (const { date, g } of scheduleGames) {
    if (date < FROM || date > TO) continue;
    const res = results.get(g.gamePk);
    if (!res || res.away == null || res.home == null) { bump('no final score'); continue; }
    const starts = startsByGame.get(g.gamePk) || [];
    const byTeam = new Map(starts.map((s) => [s.teamId, s]));
    const league = gameLeagueBefore(date);
    const pitching = teamPitchingBefore(date);
    const side = (which) => {
      const team = g.teams[which].team;
      const s = byTeam.get(team.id) || null;
      return {
        offense: teamOffenseBefore(teamLogs.get(team.id) || [], date),
        homePark: homePark.get(team.id) || '',
        lineupOpsRatio: lineupRatio.get(`${g.gamePk}:${which}`) || null,
        starter: s
          ? {
              s26: starterSeasonBefore(pitcherLogs.get(s.id) || [], date),
              s25: s.input.season25 || null,
              projIP: projectPitcher(s.input).projIP,
            }
          : null,
        bullpen: pitching.rp.get(team.id) || null,
      };
    };
    const away = side('away');
    const home = side('home');
    if (!away.offense || !home.offense) { bump('no team hitting yet'); continue; }
    const model = projectGame({
      away,
      home,
      league,
      park: venueByGame.get(g.gamePk) || '',
      // No historical weather archive here; weatherFactor() is 1 without `wx`.
      wx: null,
    });
    out.push({
      gamePk: g.gamePk,
      gameNumber: g.gameNumber ?? 1,
      date,
      gameDate: g.gameDate,
      awayId: g.teams.away.team.id,
      homeId: g.teams.home.team.id,
      awayAbbr: teamAbbr.get(g.teams.away.team.id) || '',
      homeAbbr: teamAbbr.get(g.teams.home.team.id) || '',
      park: venueByGame.get(g.gamePk) || '',
      bothStarters: starts.length === 2,
      hasLineups: lineupRatio.has(`${g.gamePk}:home`) && lineupRatio.has(`${g.gamePk}:away`),
      model,
      actual: {
        away: res.away,
        home: res.home,
        total: res.away + res.home,
        margin: res.home - res.away,
        homeWin: res.home > res.away ? 1 : 0,
        firstInningRuns: res.firstInningRuns,
        innings: res.innings,
      },
    });
  }
  return { games: out, skip };
}

// ── validation against known league rates ───────────────────────────────────
// Lives in tools/backtest-common.mjs, so the v2 replay scores itself with the
// identical function.
export { validateGames as validate } from './backtest-common.mjs';
import { validateGames as validate } from './backtest-common.mjs';

if (process.argv[1] && path.basename(process.argv[1]) === 'backtest-games.mjs') {
  const { games, skip } = buildGames();
  const v = validate(games);
  console.log(`${games.length} games replayed, ${FROM}..${TO}${USE_LINEUPS ? ' (with posted lineups)' : ''}`);
  console.log('skipped:', JSON.stringify(skip));
  const row = (label, o) => console.log(`${label.padEnd(16)} model ${(100 * o.pred).toFixed(2)}%  actual ${(100 * o.actual).toFixed(2)}%  (n=${o.n})`);
  row('home win', v.homeWin);
  if (v.nrfi) row('NRFI', v.nrfi);
  for (const [k, o] of Object.entries(v.totals)) row(k, o);
  for (const [k, o] of Object.entries(v.spreads)) row(k, o);
  console.log(`runs/game        model ${(v.runs.projAway + v.runs.projHome).toFixed(3)} (a ${v.runs.projAway.toFixed(3)} / h ${v.runs.projHome.toFixed(3)})  actual ${(v.runs.actualAway + v.runs.actualHome).toFixed(3)} (a ${v.runs.actualAway.toFixed(3)} / h ${v.runs.actualHome.toFixed(3)})`);
  console.log(`extras           actual ${(100 * v.extras.actual).toFixed(2)}%`);
  console.log(`brier            pHome ${v.brier.pHome.toFixed(4)}  over8.5 ${v.brier.over85.toFixed(4)}`);
  console.log(`both starters replayed: ${v.bothStarters}/${v.n}; with posted lineups: ${v.withLineups}/${v.n}`);
  const out = arg('json', null);
  if (out) fs.writeFileSync(out, JSON.stringify({ validation: v, skip }, null, 1));
}
