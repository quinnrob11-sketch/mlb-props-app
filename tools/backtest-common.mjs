// Shared plumbing for the lookahead-free backtests (tools/backtest-*.mjs).
//
// Disk-cached statsapi fetches, a small concurrency pool, and the as-of-date
// aggregations both the pitcher and batter replays need. These mirror the
// helpers in tools/backtest-pitchers.mjs one for one (that file keeps its own
// copies so it runs unchanged); the batter backtest imports from here.

import fs from 'node:fs';
import path from 'node:path';
import { LEAGUE_AVG } from '../src/model/league.js';

export const API = 'https://statsapi.mlb.com/api/v1';

export function argv(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

/** A fetcher that caches each JSON body under `dir`, keyed by `name`. */
export function makeCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return async function cached(name, url) {
    const file = path.join(dir, name.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
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
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  };
}

export async function pool(items, n, fn) {
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

// ── as-of aggregation ───────────────────────────────────────────────────────
// hitByPitch rides along because the game model's FIP term reads it; dropping
// it made every replayed FIP slightly optimistic.
const PITCH_FIELDS = ['gamesStarted', 'gamesPlayed', 'battersFaced', 'strikeOuts', 'baseOnBalls', 'hits', 'homeRuns', 'hitByPitch', 'numberOfPitches', 'earnedRuns', 'outs', 'strikes'];

/** A pitcher's season line from every game-log entry dated before `date`. */
export function pitcherSeasonBefore(logs, date) {
  const s = Object.fromEntries(PITCH_FIELDS.map((f) => [f, 0]));
  for (const g of logs) {
    if (g.date >= date) continue;
    for (const f of PITCH_FIELDS) s[f] += Number(g.stat[f] || 0);
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

const HIT_FIELDS = ['gamesPlayed', 'plateAppearances', 'atBats', 'hits', 'doubles', 'triples', 'homeRuns', 'runs', 'rbi', 'strikeOuts', 'baseOnBalls', 'stolenBases', 'caughtStealing', 'totalBases'];

/** A batter's season line from every game-log entry dated before `date`. */
export function hitterSeasonBefore(logs, date) {
  const s = Object.fromEntries(HIT_FIELDS.map((f) => [f, 0]));
  for (const g of logs) {
    if (g.date >= date) continue;
    for (const f of HIT_FIELDS) s[f] += Number(g.stat[f] || 0);
  }
  return s.gamesPlayed ? s : null;
}

export function teamRatesBefore(logs, date) {
  let pa = 0, k = 0, bb = 0, h = 0, ab = 0, sb = 0, games = 0;
  for (const g of logs) {
    if (g.date >= date) continue;
    const st = g.stat;
    pa += Number(st.plateAppearances || 0);
    k += Number(st.strikeOuts || 0);
    bb += Number(st.baseOnBalls || 0);
    h += Number(st.hits || 0);
    ab += Number(st.atBats || 0);
    sb += Number(st.stolenBases || 0);
    games += 1;
  }
  return { pa, k, bb, h, ab, sb, games };
}

// Same constants as src/data/loadSlate.js (FIX v22.8).
const SP_TO_LEAGUE_H = 1.0187;
const SP_TO_LEAGUE_K = 0.9871;
const SP_TO_LEAGUE_BB = 0.9266;

/**
 * League object as loadSlate builds it, from team game logs before `date`.
 * `teamLogs` is a Map(teamId -> gameLog splits).
 */
export function makeLeagueBefore(teamLogs) {
  const memo = new Map();
  return function leagueBefore(date) {
    if (memo.has(date)) return memo.get(date);
    let pa = 0, k = 0, bb = 0, h = 0, ab = 0, sb = 0, games = 0;
    for (const logs of teamLogs.values()) {
      const t = teamRatesBefore(logs, date);
      pa += t.pa; k += t.k; bb += t.bb; h += t.h; ab += t.ab; sb += t.sb; games += t.games;
    }
    const lg = {
      ...LEAGUE_AVG,
      kRate: k / pa, bbRate: bb / pa, avg: h / ab,
      sbPerGame: sb / games / 9,
      spHRate: (h / pa) * SP_TO_LEAGUE_H, spKRate: (k / pa) * SP_TO_LEAGUE_K, spBbRate: (bb / pa) * SP_TO_LEAGUE_BB,
    };
    memo.set(date, lg);
    return lg;
  };
}

/** Model pmf from its survival function P(X > line) at half-integer lines. */
export function pmfOf(dist, max) {
  const pmf = [];
  let prev = 1;
  for (let k = 0; k <= max; k++) {
    const above = dist(k + 0.5);
    pmf.push(Math.max(0, prev - above));
    prev = above;
  }
  return pmf;
}
