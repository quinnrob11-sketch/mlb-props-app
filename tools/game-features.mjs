// A lookahead-free, per-game FEATURE TABLE for the game model, for one season.
//
//   node tools/game-features.mjs --season 2026 --to 2026-09-22 \
//     --cache .backtest-cache --out .backtest-cache/features_2026.json
//
// `tools/backtest-games.mjs` rebuilds the inputs the SHIPPED model reads. This
// rebuilds a wider set, so a better model can be fitted and tested without
// re-aggregating: everything above, plus the things the shipped model does not
// look at —
//
//   - the starter's rate components (K, BB+HBP, HR per batter faced) and his
//     days of rest, so his quality can be regressed component by component
//     instead of as one ERA/FIP blend;
//   - who actually pitched in relief on each of the last three days, and how
//     much, so tonight's AVAILABLE bullpen can be told from the season one;
//   - the posted lineup, weighted by batting order, and the top four alone
//     (the cards that bat in the first inning);
//   - days of rest, whether the team changed city, and the time-zone shift;
//   - the home-plate umpire;
//   - the recorded first-pitch weather, including WIND DIRECTION.
//
// Every aggregation is strictly from games dated BEFORE the game in question.
// The two exceptions are marked in the output and discussed in the doc: the
// posted lineup (statsapi reports the card that took the field) and the
// weather (recorded conditions, not the forecast that was available at the
// decision time).
//
// Public MLB Stats API only, everything cached under --cache.

import fs from 'node:fs';
import path from 'node:path';
import { makeCache, pool, API, argv } from './backtest-common.mjs';
import { DOMED_PARKS } from '../src/lib/markets.js';
import { PA_BY_LINEUP_SLOT } from '../src/model/batter.js';

const SEASON = Number(argv('season', '2026'));
const FROM = argv('from', `${SEASON}-03-01`);
const TO = argv('to', `${SEASON}-11-15`);
const CACHE = argv('cache', path.resolve('.backtest-cache'));
const OUT = argv('out', path.resolve(`.backtest-cache/features_${SEASON}.json`));
const cached = makeCache(CACHE);
const log = (s) => process.stderr.write(`${s}\n`);

/**
 * Venue time zones, as hours behind Eastern. Used for the travel term: what
 * matters for a body clock is the shift, not the mileage.
 */
const VENUE_TZ = {
  'Fenway Park': 0, 'Yankee Stadium': 0, 'Citi Field': 0, 'Oriole Park at Camden Yards': 0,
  'Nationals Park': 0, 'Citizens Bank Park': 0, 'PNC Park': 0, 'Progressive Field': 0,
  'Comerica Park': 0, 'Rogers Centre': 0, 'Truist Park': 0, 'loanDepot park': 0,
  'Tropicana Field': 0, 'George M. Steinbrenner Field': 0, 'Great American Ball Park': 0,
  'Wrigley Field': -1, 'Rate Field': -1, 'Guaranteed Rate Field': -1, 'American Family Field': -1,
  'Target Field': -1, 'Busch Stadium': -1, 'Kauffman Stadium': -1, 'Daikin Park': -1,
  'Minute Maid Park': -1, 'Globe Life Field': -1,
  'Coors Field': -2, 'Chase Field': -3,
  'Dodger Stadium': -3, 'Angel Stadium': -3, 'Petco Park': -3, 'Oracle Park': -3,
  'T-Mobile Park': -3, 'Sutter Health Park': -3, 'Oakland Coliseum': -3,
};
const tzOf = (venue) => VENUE_TZ[venue] ?? 0;

// ── schedule ────────────────────────────────────────────────────────────────
// One request per DATE, hydrated with everything a game row needs. The
// per-date form is the only one that carries posted lineups.
const seasonSchedule = await cached(
  `gf_schedule_${SEASON}`,
  `${API}/schedule?sportId=1&gameType=R&startDate=${SEASON}-03-01&endDate=${SEASON}-11-15`,
);
const dates = (seasonSchedule.dates || []).map((d) => d.date).filter((d) => d >= FROM && d <= TO);
log(`${SEASON}: ${dates.length} dates`);

const HYDRATE = 'lineups,probablePitcher,officials,weather,linescore,venue,team';
const gamesByDate = new Map();
await pool(dates, 6, async (date) => {
  const body = await cached(`gf_day_${date}`, `${API}/schedule?sportId=1&gameType=R&date=${date}&hydrate=${HYDRATE}`);
  gamesByDate.set(date, body.dates?.[0]?.games || []);
});

const allGames = [];
for (const date of dates) for (const g of gamesByDate.get(date) || []) allGames.push({ date, g });
log(`${SEASON}: ${allGames.length} scheduled regular-season games`);

// Each team's home park (its most frequent venue as the home side) and the
// venue it played in on every date, for the travel term. Built from the WHOLE
// season, not the requested window, so a short window still knows where a team
// lives and what it did the day before.
const homeVenueCount = new Map();
const teamVenueByDate = new Map(); // `${teamId}:${date}` -> venue
const teamDates = new Map(); // teamId -> sorted [date]
for (const d of seasonSchedule.dates || []) for (const g of d.games || []) {
  const date = d.date;
  const venue = g.venue?.name || '';
  const homeId = g.teams.home.team.id;
  if (!homeVenueCount.has(homeId)) homeVenueCount.set(homeId, new Map());
  const m = homeVenueCount.get(homeId);
  m.set(venue, (m.get(venue) || 0) + 1);
  for (const side of ['away', 'home']) {
    const id = g.teams[side].team.id;
    teamVenueByDate.set(`${id}:${date}`, venue);
    if (!teamDates.has(id)) teamDates.set(id, []);
    const list = teamDates.get(id);
    if (list[list.length - 1] !== date) list.push(date);
  }
}
for (const list of teamDates.values()) list.sort();
const homePark = new Map(
  [...homeVenueCount].map(([id, m]) => [id, [...m].sort((a, b) => b[1] - a[1])[0][0]]),
);

const teamsBody = await cached(`teams_${SEASON}`, `${API}/teams?sportId=1&season=${SEASON}`);
const teamAbbr = new Map((teamsBody.teams || []).map((t) => [t.id, t.abbreviation]));

// ── game logs ───────────────────────────────────────────────────────────────
const teamIds = [...homePark.keys()];
const teamHitLogs = new Map();
const teamHitLogsPrior = new Map();
await pool(teamIds, 8, async (id) => {
  const a = await cached(`teamhit_${id}_${SEASON}`, `${API}/teams/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  teamHitLogs.set(id, a.stats?.[0]?.splits || []);
  const b = await cached(`teamhit_${id}_${SEASON - 1}`, `${API}/teams/${id}/stats?stats=gameLog&group=hitting&season=${SEASON - 1}`);
  teamHitLogsPrior.set(id, b.stats?.[0]?.splits || []);
});

const pitcherList = await cached(
  `pitchers_season_${SEASON}`,
  `${API}/stats?stats=season&group=pitching&sportId=1&season=${SEASON}&limit=2000&playerPool=All`,
);
const pitcherIds = (pitcherList.stats?.[0]?.splits || []).map((s) => s.player?.id).filter(Boolean);
const pitcherLogs = new Map();
log(`${SEASON}: ${pitcherIds.length} pitcher logs`);
await pool(pitcherIds, 8, async (id) => {
  const body = await cached(`pitchlog_${id}_${SEASON}`, `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${SEASON}`);
  pitcherLogs.set(id, body.stats?.[0]?.splits || []);
});

// Prior-season pitching lines, for the starters only (chunked).
const probableIds = new Set();
for (const { g } of allGames) {
  for (const side of ['away', 'home']) {
    const p = g.teams[side].probablePitcher;
    if (p?.id) probableIds.add(p.id);
  }
}
const priorPitching = new Map();
{
  const ids = [...probableIds];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const body = await cached(
      `prior_${SEASON - 1}_${chunk[0]}_${chunk.length}`,
      `${API}/people?personIds=${chunk.join(',')}&hydrate=stats(group=[pitching],type=[season],season=${SEASON - 1})`,
    );
    for (const person of body.people || []) {
      const split = person.stats?.[0]?.splits?.find((s) => !s.team) || person.stats?.[0]?.splits?.[0];
      if (split) priorPitching.set(person.id, split.stat);
    }
  }
}

// Batters that appear in any posted lineup.
const batterIds = new Set();
for (const { g } of allGames) {
  for (const k of ['awayPlayers', 'homePlayers']) for (const p of g.lineups?.[k] || []) if (p.id) batterIds.add(p.id);
}
const batterLogs = new Map();
log(`${SEASON}: ${batterIds.size} batter logs`);
await pool([...batterIds], 8, async (id) => {
  const body = await cached(`hitlog_${id}_${SEASON}`, `${API}/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  batterLogs.set(id, body.stats?.[0]?.splits || []);
});

// ── as-of aggregation ───────────────────────────────────────────────────────
const n = (v) => Number(v || 0);
const ipOuts = (ip) => {
  if (ip == null) return 0;
  const [w, f] = String(ip).split('.');
  return (parseInt(w, 10) || 0) * 3 + (f ? parseInt(f, 10) || 0 : 0);
};

const HIT = ['runs', 'gamesPlayed', 'plateAppearances', 'atBats', 'hits', 'doubles', 'triples', 'homeRuns',
  'baseOnBalls', 'hitByPitch', 'sacFlies', 'totalBases', 'strikeOuts'];
/** Cumulative hitting line from every log entry strictly before `date`. */
function hitBefore(logs, date) {
  const s = Object.fromEntries(HIT.map((f) => [f, 0]));
  for (const g of logs) {
    if (date != null && g.date >= date) continue;
    for (const f of HIT) s[f] += n(g.stat[f]);
  }
  return s.gamesPlayed ? s : null;
}

/** One flat, date-sorted list of pitcher appearances. */
const appearances = [];
for (const [id, logs] of pitcherLogs) {
  for (const g of logs) {
    if (g.gameType && g.gameType !== 'R') continue;
    if (!g.team?.id) continue;
    appearances.push({
      id, teamId: g.team.id, date: g.date,
      isStart: n(g.stat.gamesStarted) > 0,
      outs: n(g.stat.outs), er: n(g.stat.earnedRuns), hr: n(g.stat.homeRuns),
      bb: n(g.stat.baseOnBalls), hbp: n(g.stat.hitByPitch), k: n(g.stat.strikeOuts),
      bf: n(g.stat.battersFaced), h: n(g.stat.hits), pitches: n(g.stat.numberOfPitches),
    });
  }
}
appearances.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const ZERO = () => ({ outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0, bf: 0, h: 0, app: 0 });
const add = (t, a) => {
  t.outs += a.outs; t.er += a.er; t.hr += a.hr; t.bb += a.bb; t.hbp += a.hbp;
  t.k += a.k; t.bf += a.bf; t.h += a.h; t.app += 1;
};

/**
 * Everything derived from appearances before `date`, in one pass per date:
 * team starter/reliever split lines, each reliever's own relief line, and how
 * much each pitcher threw on each of the last three days.
 */
const pitchingMemo = new Map();
function pitchingBefore(date) {
  if (pitchingMemo.has(date)) return pitchingMemo.get(date);
  const team = new Map(); // teamId -> { sp, rp }
  const relief = new Map(); // pitcherId -> { teamId, line }
  const recent = new Map(); // pitcherId -> { d1, d2, d3 } outs+pitches
  const teamRecent = new Map(); // teamId -> { outs1, outs2, outs3 }
  const d = (k) => {
    const t = new Date(`${date}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - k);
    return t.toISOString().slice(0, 10);
  };
  const d1 = d(1), d2 = d(2), d3 = d(3);
  for (const a of appearances) {
    if (a.date >= date) break; // sorted
    if (!team.has(a.teamId)) team.set(a.teamId, { sp: ZERO(), rp: ZERO() });
    add(team.get(a.teamId)[a.isStart ? 'sp' : 'rp'], a);
    if (!a.isStart) {
      if (!relief.has(a.id)) relief.set(a.id, { teamId: a.teamId, line: ZERO() });
      const r = relief.get(a.id);
      r.teamId = a.teamId;
      add(r.line, a);
    }
    if (a.date === d1 || a.date === d2 || a.date === d3) {
      const slot = a.date === d1 ? 1 : a.date === d2 ? 2 : 3;
      if (!recent.has(a.id)) recent.set(a.id, { 1: 0, 2: 0, 3: 0, p1: 0, p2: 0, p3: 0, lastStart: false });
      const r = recent.get(a.id);
      r[slot] += a.outs;
      r[`p${slot}`] += a.pitches;
      if (!teamRecent.has(a.teamId)) teamRecent.set(a.teamId, { outs1: 0, outs2: 0, outs3: 0 });
      const tr = teamRecent.get(a.teamId);
      if (!a.isStart) tr[`outs${slot}`] += a.outs;
    }
  }
  const out = { team, relief, recent, teamRecent };
  pitchingMemo.set(date, out);
  return out;
}

/** A pitcher's own cumulative line before `date`, starts only or all. */
function pitcherBefore(id, date, startsOnly) {
  const t = ZERO();
  let pitches = 0;
  let gs = 0;
  let lastDate = null;
  for (const g of pitcherLogs.get(id) || []) {
    if (g.date >= date) continue;
    if (startsOnly && n(g.stat.gamesStarted) === 0) continue;
    t.outs += n(g.stat.outs); t.er += n(g.stat.earnedRuns); t.hr += n(g.stat.homeRuns);
    t.bb += n(g.stat.baseOnBalls); t.hbp += n(g.stat.hitByPitch); t.k += n(g.stat.strikeOuts);
    t.bf += n(g.stat.battersFaced); t.h += n(g.stat.hits); t.app += 1;
    pitches += n(g.stat.numberOfPitches);
    gs += n(g.stat.gamesStarted);
    if (!lastDate || g.date > lastDate) lastDate = g.date;
  }
  return t.app ? { ...t, pitches, gs, lastDate } : null;
}

const priorLine = (stat) => {
  if (!stat) return null;
  const outs = ipOuts(stat.inningsPitched);
  if (!outs) return null;
  return {
    outs, er: n(stat.earnedRuns), hr: n(stat.homeRuns), bb: n(stat.baseOnBalls),
    hbp: n(stat.hitByPitch), k: n(stat.strikeOuts), bf: n(stat.battersFaced), h: n(stat.hits),
    gs: n(stat.gamesStarted),
  };
};

const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400e3);

/** Lineup offence, weighted by the plate appearances each batting slot gets. */
function lineupLine(ids, date, slots) {
  let w = 0, pa = 0;
  const acc = { ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, tb: 0, so: 0, d2: 0, d3: 0, hr: 0 };
  let known = 0;
  ids.slice(0, slots).forEach((id, i) => {
    const b = hitBefore(batterLogs.get(id) || [], date);
    const weight = PA_BY_LINEUP_SLOT[i] ?? PA_BY_LINEUP_SLOT[8];
    w += weight;
    if (!b || b.plateAppearances < 25) return;
    known += weight;
    const scale = weight / b.plateAppearances;
    acc.ab += b.atBats * scale; acc.h += b.hits * scale; acc.bb += b.baseOnBalls * scale;
    acc.hbp += b.hitByPitch * scale; acc.sf += b.sacFlies * scale; acc.tb += b.totalBases * scale;
    acc.so += b.strikeOuts * scale; acc.d2 += b.doubles * scale; acc.d3 += b.triples * scale;
    acc.hr += b.homeRuns * scale;
    pa += b.plateAppearances;
  });
  if (!w || known / w < 0.6) return null;
  const den = acc.ab + acc.bb + acc.hbp + acc.sf;
  return {
    knownShare: known / w,
    pa,
    obp: den ? (acc.h + acc.bb + acc.hbp) / den : null,
    slg: acc.ab ? acc.tb / acc.ab : null,
    kRate: known ? acc.so / known : null,
    bbRate: known ? (acc.bb + acc.hbp) / known : null,
    hrRate: known ? acc.hr / known : null,
  };
}

const windOf = (wx) => {
  const s = String(wx?.wind || '');
  const mph = /(\d+)\s*mph/i.exec(s);
  const dir = /mph,\s*(.+)$/i.exec(s);
  return { mph: mph ? Number(mph[1]) : null, dir: dir ? dir[1].trim() : null };
};

// ── build ───────────────────────────────────────────────────────────────────
const rows = [];
const skip = {};
const bump = (r) => (skip[r] = (skip[r] || 0) + 1);
let done = 0;
for (const { date, g } of allGames) {
  if (++done % 400 === 0) log(`  ${done}/${allGames.length}`);
  const ls = g.linescore;
  if (g.status?.abstractGameState !== 'Final' || !ls?.teams) { bump('not final'); continue; }
  if (ls.teams.away?.runs == null || ls.teams.home?.runs == null) { bump('no score'); continue; }
  const pit = pitchingBefore(date);
  const first = (ls.innings || []).find((i) => i.num === 1);
  const venue = g.venue?.name || '';

  const side = (which) => {
    const teamId = g.teams[which].team.id;
    const off = hitBefore(teamHitLogs.get(teamId) || [], date);
    if (!off) return null;
    const offPrior = hitBefore(teamHitLogsPrior.get(teamId) || [], null);
    const tp = pit.team.get(teamId) || { sp: ZERO(), rp: ZERO() };

    // Starter: the LISTED probable, which is what the board has at the
    // decision time. Falls back to null (the model then uses a league arm).
    const prob = g.teams[which].probablePitcher;
    let starter = null;
    if (prob?.id) {
      const cur = pitcherBefore(prob.id, date, false);
      const curStarts = pitcherBefore(prob.id, date, true);
      starter = {
        id: prob.id,
        cur, curStarts,
        prior: priorLine(priorPitching.get(prob.id)),
        restDays: cur?.lastDate ? daysBetween(date, cur.lastDate) : null,
      };
    }

    // Bullpen: every reliever on this team with a relief line, split by
    // whether he threw in the last two days.
    const rested = ZERO();
    const tired = ZERO();
    let restedOuts = 0;
    let allOuts = 0;
    for (const [pid, r] of pit.relief) {
      if (r.teamId !== teamId) continue;
      const rc = pit.recent.get(pid);
      const usedRecently = rc && (rc[1] > 0 || rc[2] > 0);
      const backToBack = rc && rc[1] > 0 && rc[2] > 0;
      const heavy = rc && rc.p1 >= 25;
      const out = !usedRecently ? rested : backToBack || heavy ? tired : rested;
      // A man who threw a light inning yesterday is usually available; one who
      // threw on both of the last two days, or 25+ pitches yesterday, is not.
      add(out, { ...r.line, bf: r.line.bf });
      allOuts += r.line.outs;
      if (out === rested) restedOuts += r.line.outs;
    }
    const tr = pit.teamRecent.get(teamId) || { outs1: 0, outs2: 0, outs3: 0 };

    const lu = g.lineups?.[which === 'away' ? 'awayPlayers' : 'homePlayers'] || [];
    const luIds = lu.map((p) => p.id).filter(Boolean);

    const myDates = teamDates.get(teamId) || [];
    const i = myDates.indexOf(date);
    const prevDate = i > 0 ? myDates[i - 1] : null;
    const prevVenue = prevDate ? teamVenueByDate.get(`${teamId}:${prevDate}`) : null;
    const gamesLast10 = myDates.filter((d) => d < date && daysBetween(date, d) <= 10).length;

    return {
      teamId,
      abbr: teamAbbr.get(teamId) || '',
      homePark: homePark.get(teamId) || '',
      off,
      offPrior,
      sp: tp.sp,
      rp: tp.rp,
      starter,
      bull: {
        rested, tired, restedOutsShare: allOuts ? restedOuts / allOuts : null,
        reliefOutsD1: tr.outs1, reliefOutsD2: tr.outs2, reliefOutsD3: tr.outs3,
      },
      lineup: luIds.length >= 9
        ? { nine: lineupLine(luIds, date, 9), top4: lineupLine(luIds, date, 4) }
        : null,
      rest: {
        daysSinceLast: prevDate ? daysBetween(date, prevDate) : null,
        changedCity: prevVenue ? (prevVenue !== venue ? 1 : 0) : null,
        tzShift: prevVenue ? tzOf(venue) - tzOf(prevVenue) : 0,
        gamesLast10,
        isHomePark: (homePark.get(teamId) || '') === venue ? 1 : 0,
      },
    };
  };

  const away = side('away');
  const home = side('home');
  if (!away || !home) { bump('no team hitting yet'); continue; }

  const w = windOf(g.weather);
  rows.push({
    gamePk: g.gamePk,
    gameNumber: g.gameNumber ?? 1,
    date,
    gameDate: g.gameDate,
    season: SEASON,
    venue,
    dayNight: g.dayNight || null,
    seriesGameNumber: g.seriesGameNumber ?? null,
    umpId: (g.officials || []).find((o) => o.officialType === 'Home Plate')?.official?.id ?? null,
    wx: {
      tempF: g.weather?.temp != null ? Number(g.weather.temp) : null,
      condition: g.weather?.condition || null,
      windMph: w.mph,
      windDir: w.dir,
      indoor: DOMED_PARKS.has(venue) ? 1 : 0,
    },
    away,
    home,
    actual: {
      away: ls.teams.away.runs,
      home: ls.teams.home.runs,
      firstAway: first ? n(first.away?.runs) : null,
      firstRuns: first ? n(first.away?.runs) + n(first.home?.runs) : null,
      innings: (ls.innings || []).length,
      scheduledInnings: g.scheduledInnings ?? 9,
    },
  });
}

log(`${SEASON}: ${rows.length} feature rows, skipped ${JSON.stringify(skip)}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ season: SEASON, from: FROM, to: TO, builtAt: new Date().toISOString(), skip, rows }));
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
