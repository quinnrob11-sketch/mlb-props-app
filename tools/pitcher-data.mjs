// Two-season starting-pitcher dataset for the edge search (docs/PITCHER-EDGE-SEARCH.md).
//
// Everything comes from the PUBLIC MLB Stats API (unmetered) and is cached on
// disk. One row per real start in 2025 and 2026, carrying:
//
//   - the pitcher's own game log (both seasons, date-ordered) so any as-of
//     aggregate can be rebuilt with an arbitrary recency weight,
//   - the opponent's team hitting log,
//   - the posted lineup for that game (ids + primary position), which gives
//     opponent handedness composition and the pitcher's own catcher,
//   - the home-plate umpire, the park and the final weather,
//   - what actually happened.
//
// Nothing here reads a date on or after the start's own date, so a row built
// for 2026-09-02 is exactly what was knowable that morning.

import fs from 'node:fs';
import path from 'node:path';

export const API = 'https://statsapi.mlb.com/api/v1';

export function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

export function makeCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return async function cached(name, url) {
    const file = path.join(dir, name.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        const body = await res.json();
        fs.writeFileSync(file, JSON.stringify(body));
        return body;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
  };
}

export async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const MONTH_SPANS = (season) => [
  [season + '-03-01', season + '-04-30'],
  [season + '-05-01', season + '-06-15'],
  [season + '-06-16', season + '-07-31'],
  [season + '-08-01', season + '-09-10'],
  [season + '-09-11', season + '-11-10'],
];

const PITCH_FIELDS = ['gamesStarted', 'gamesPlayed', 'battersFaced', 'strikeOuts', 'baseOnBalls', 'hits', 'homeRuns', 'hitByPitch', 'numberOfPitches', 'earnedRuns', 'runs', 'outs', 'strikes', 'balls'];

/** Fetch (cached) everything both seasons need. */
export async function loadRaw({ cacheDir, seasons = [2025, 2026], through, batters = true }) {
  const cached = makeCache(cacheDir);
  const games = new Map();          // gamePk -> context
  const pitcherIds = new Set();
  const teamIds = new Set();
  const lineupPlayerIds = new Set();
  const latest = Math.max(...seasons);

  for (const season of seasons) {
    for (const [a, b] of MONTH_SPANS(season)) {
      const to = through && b > through ? through : b;
      if (a > to) continue;
      const body = await cached(
        `sched_${season}_${a}_${to}`,
        `${API}/schedule?sportId=1&gameType=R&startDate=${a}&endDate=${to}&hydrate=lineups,officials,weather,probablePitcher`,
      );
      for (const d of body.dates || []) {
        for (const g of d.games || []) {
          const hp = (g.officials || []).find((o) => o.officialType === 'Home Plate');
          const lineup = (side) => (g.lineups?.[side] || []).map((p) => ({ id: p.id, pos: p.primaryPosition?.abbreviation || null }));
          games.set(g.gamePk, {
            gamePk: g.gamePk,
            date: d.date,
            season,
            gameDate: g.gameDate,
            gameNumber: g.gameNumber || 1,
            doubleHeader: g.doubleHeader || 'N',
            status: g.status?.detailedState || '',
            venue: g.venue?.name || '',
            homeId: g.teams?.home?.team?.id ?? null,
            awayId: g.teams?.away?.team?.id ?? null,
            umpId: hp?.official?.id ?? null,
            umpName: hp?.official?.fullName ?? null,
            temp: g.weather?.temp != null ? Number(g.weather.temp) : null,
            wind: g.weather?.wind || null,
            condition: g.weather?.condition || null,
            lineupHome: lineup('homePlayers'),
            lineupAway: lineup('awayPlayers'),
          });
          teamIds.add(g.teams?.home?.team?.id);
          teamIds.add(g.teams?.away?.team?.id);
          for (const p of [...lineup('homePlayers'), ...lineup('awayPlayers')]) lineupPlayerIds.add(p.id);
        }
      }
    }
    // Every pitcher who started at all this season.
    const all = await cached(
      `allpitch_${season}${season === latest ? '_' + through : ''}`,
      `${API}/stats?stats=season&group=pitching&season=${season}&playerPool=All&limit=2000&sportId=1`,
    );
    for (const s of all.stats?.[0]?.splits || []) {
      if (Number(s.stat?.gamesStarted || 0) > 0) pitcherIds.add(s.player.id);
    }
  }
  teamIds.delete(undefined);
  teamIds.delete(null);

  // Game logs. Two seasons per pitcher; the live season's logs must be
  // refetched whenever the window extends, so its cache key carries `through`.
  const pitcherLogs = new Map();   // id -> [{date, season, ...}]
  for (const season of seasons) {
    const tag = season === latest ? `_${through}` : '';
    await pool([...pitcherIds], 8, async (id) => {
      const body = await cached(`plog_${id}_${season}${tag}`, `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}`);
      const splits = body.stats?.[0]?.splits || [];
      if (!pitcherLogs.has(id)) pitcherLogs.set(id, []);
      for (const g of splits) {
        pitcherLogs.get(id).push({
          date: g.date, season, gamePk: g.game?.gamePk ?? null,
          teamId: g.team?.id ?? null, oppId: g.opponent?.id ?? null, isHome: g.isHome ?? null,
          name: g.player?.fullName || null,
          stat: Object.fromEntries(PITCH_FIELDS.map((f) => [f, Number(g.stat?.[f] || 0)])),
          ip: g.stat?.inningsPitched ?? null,
        });
      }
    });
  }
  for (const [, logs] of pitcherLogs) logs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const teamLogs = new Map();      // `${teamId}:${season}` -> splits
  for (const season of seasons) {
    const tag = season === latest ? `_${through}` : '';
    await pool([...teamIds], 8, async (id) => {
      const body = await cached(`tlog_${id}_${season}${tag}`, `${API}/teams/${id}/stats?stats=gameLog&group=hitting&season=${season}`);
      teamLogs.set(`${id}:${season}`, body.stats?.[0]?.splits || []);
    });
  }

  // Handedness for every player who ever appeared in a posted lineup, plus
  // every starting pitcher (for his own throwing hand).
  const hands = new Map();
  const ids = [...new Set([...lineupPlayerIds, ...pitcherIds])];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const body = await cached(`hands_${chunk[0]}_${chunk.length}`, `${API}/people?personIds=${chunk.join(',')}&fields=people,id,fullName,batSide,pitchHand,code`);
    for (const p of body.people || []) hands.set(p.id, { bat: p.batSide?.code || null, throws: p.pitchHand?.code || null, name: p.fullName });
  }

  // Hitting game logs for every player who ever appeared in a posted lineup.
  // This is what lets the opponent adjustment read the nine men actually
  // playing tonight instead of a team-season aggregate.
  const batterLogs = new Map();    // id -> [{date, season, pa, k, bb, h, ab, hr}]
  if (batters) {
    const bids = [...lineupPlayerIds];
    for (const season of seasons) {
      const tag = season === latest ? `_${through}` : '';
      await pool(bids, 8, async (id) => {
        const body = await cached(`blog_${id}_${season}${tag}`, `${API}/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`);
        if (!batterLogs.has(id)) batterLogs.set(id, []);
        for (const g of body.stats?.[0]?.splits || []) {
          const s = g.stat || {};
          batterLogs.get(id).push({
            date: g.date, season,
            pa: Number(s.plateAppearances || 0), k: Number(s.strikeOuts || 0), bb: Number(s.baseOnBalls || 0),
            h: Number(s.hits || 0), ab: Number(s.atBats || 0), hr: Number(s.homeRuns || 0),
          });
        }
      });
    }
    for (const [, logs] of batterLogs) logs.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  return { games, pitcherLogs, teamLogs, batterLogs, hands, pitcherIds, teamIds };
}

// ── as-of aggregates ────────────────────────────────────────────────────────

/** Team hitting totals from every logged game strictly before `date`. */
export function teamRatesBefore(logs, date) {
  let pa = 0, k = 0, bb = 0, h = 0, ab = 0, hr = 0, games = 0;
  for (const g of logs) {
    if (g.date >= date) continue;
    const s = g.stat;
    pa += Number(s.plateAppearances || 0); k += Number(s.strikeOuts || 0);
    bb += Number(s.baseOnBalls || 0); h += Number(s.hits || 0);
    ab += Number(s.atBats || 0); hr += Number(s.homeRuns || 0); games++;
  }
  return { pa, k, bb, h, ab, hr, games };
}

/** One row per real start, with the raw context every candidate model reads. */
export function buildStarts(raw, { seasons = [2025, 2026] } = {}) {
  const { games, pitcherLogs, hands } = raw;
  const starts = [];
  for (const [id, logs] of pitcherLogs) {
    for (let i = 0; i < logs.length; i++) {
      const g = logs[i];
      if (g.stat.gamesStarted !== 1) continue;
      if (!seasons.includes(g.season)) continue;
      const ctx = games.get(g.gamePk) || null;
      const prevStart = logs.slice(0, i).filter((x) => x.stat.gamesStarted === 1).pop();
      const prevAny = logs[i - 1];
      const oppLineup = ctx ? (g.isHome ? ctx.lineupAway : ctx.lineupHome) : [];
      const ownLineup = ctx ? (g.isHome ? ctx.lineupHome : ctx.lineupAway) : [];
      const catcher = ownLineup.find((p) => p.pos === 'C') || null;
      starts.push({
        id, name: g.name, date: g.date, season: g.season, gamePk: g.gamePk,
        teamId: g.teamId, oppId: g.oppId, isHome: g.isHome,
        venue: ctx?.venue || '', umpId: ctx?.umpId ?? null, umpName: ctx?.umpName ?? null,
        temp: ctx?.temp ?? null, wind: ctx?.wind ?? null, condition: ctx?.condition ?? null,
        gameDate: ctx?.gameDate ?? null, gameNumber: ctx?.gameNumber ?? 1,
        throws: hands.get(id)?.throws || null,
        catcherId: catcher?.id ?? null,
        oppLineup: oppLineup.map((p) => ({ id: p.id, bat: hands.get(p.id)?.bat || null })),
        restDays: prevStart ? Math.round((Date.parse(g.date) - Date.parse(prevStart.date)) / 864e5) : null,
        restAnyDays: prevAny ? Math.round((Date.parse(g.date) - Date.parse(prevAny.date)) / 864e5) : null,
        logIndex: i,
        actual: {
          k: g.stat.strikeOuts, outs: g.stat.outs, hits: g.stat.hits, bb: g.stat.baseOnBalls,
          er: g.stat.earnedRuns, bf: g.stat.battersFaced, pitches: g.stat.numberOfPitches,
          hr: g.stat.homeRuns, hbp: g.stat.hitByPitch, strikes: g.stat.strikes,
        },
      });
    }
  }
  starts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  return starts;
}
