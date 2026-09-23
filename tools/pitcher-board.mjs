// Board-shaped inputs for a replayed start.
//
// `tools/pitcher-fit.mjs`'s `baselineInput` rebuilds what the SHIPPED model is
// given by `tools/backtest-pitchers.mjs`: season splits, a game log, and the
// opponent's TEAM season aggregate. That is not what the live board hands
// `projectPitcher`. Since v33 `src/data/loadSlate.js` calls `lineupOpponent`
// and passes the nine hitters posted behind the plate, falling back to the team
// aggregate only when the card is missing or thin.
//
// The difference matters for this port, because "read the opponent from the
// nine posted batters" is the study's largest single term — and the board
// already has it. Measuring the port against a control fed team aggregates
// would credit the port with something that shipped two versions ago. So every
// model compared in docs/PITCHER-PORT.md is fed from here, and the only row
// that uses team rates is the one explicitly labelled as the study's baseline.
//
// Nothing reads a date on or after the start's own date.

import { baselineInput } from './pitcher-fit.mjs';
import { lineupOpponent } from '../src/model/lineupEnv.js';

/** Season-to-date hitting line for one batter, in the shape `statsFor` wants. */
function batterLineBefore(logs, season, date) {
  if (!logs) return null;
  let pa = 0, k = 0, bb = 0, h = 0, ab = 0;
  for (const g of logs) {
    if (g.season !== season || g.date >= date) continue;
    pa += g.pa; k += g.k; bb += g.bb; h += g.h; ab += g.ab;
  }
  return pa ? { plateAppearances: pa, strikeOuts: k, baseOnBalls: bb, hits: h, atBats: ab } : null;
}

/**
 * Every appearance (relief included) before this start, both seasons, with the
 * counting stats a per-batter-faced rate needs. This is the one input the live
 * board does not have today; `loadSlate` keeps only `{ip, pitches, bf, k}` of
 * the current season's starts. See docs/PITCHER-PORT.md for what it costs.
 */
function rateLogBefore(logs, season, date) {
  const out = [];
  for (const g of logs || []) {
    if (g.season > season || (g.season === season && g.date >= date)) continue;
    const s = g.stat;
    out.push({
      date: g.date, season: g.season,
      bf: s.battersFaced, k: s.strikeOuts, bb: s.baseOnBalls, h: s.hits,
      hr: s.homeRuns, hbp: s.hitByPitch, outs: s.outs, pitches: s.numberOfPitches,
      gamesStarted: s.gamesStarted,
    });
  }
  return out;
}

/**
 * The lineup the board would have seen. `posted` is the card that took the
 * field; `previous` is the opponent's most recent card posted BEFORE tonight,
 * which is what a board loaded at T-120 usually has (see
 * `src/data/projectedLineup.js`).
 */
export function previousCard(raw, start) {
  let best = null;
  for (const g of raw.games.values()) {
    if (g.season !== start.season || g.date >= start.date) continue;
    const home = g.homeId === start.oppId;
    const away = g.awayId === start.oppId;
    if (!home && !away) continue;
    const card = home ? g.lineupHome : g.lineupAway;
    if (!card || card.length < 9) continue;
    if (!best || g.date > best.date) best = { date: g.date, card };
  }
  return best ? best.card : [];
}

/**
 * One start's `projectPitcher` input, as `loadSlate` would build it.
 *
 * @param {object}  raw      from `loadRaw`
 * @param {object}  start    from `buildStarts`
 * @param {Map}     lgCache  shared league cache (one entry per season:date)
 * @param {object}  [opts]
 * @param {Array}   [opts.lineup]   override the posted card (decision-time runs)
 * @param {boolean} [opts.teamOpp]  ignore the card entirely: the study's baseline
 */
export function boardInput(raw, start, lgCache, opts = {}) {
  const base = baselineInput(raw, start, lgCache);
  const input = {
    ...base,
    date: start.date,
    season: start.season,
    rateLog: rateLogBefore(raw.pitcherLogs.get(start.id), start.season, start.date),
  };
  if (opts.teamOpp) return input;

  const lineup = opts.lineup ?? start.oppLineup;
  input.opp = lineupOpponent({
    lineup,
    statsFor: (id) => batterLineBefore(raw.batterLogs.get(id), start.season, start.date),
    teamAgg: base.opp,
  });
  // `lineupOpponent` returns `{...teamAgg, source:'team'}` when the card is
  // unusable, and `baselineInput` returns null when the opponent has not
  // batted yet. Keep that null rather than shipping an empty object.
  if (input.opp && input.opp.kRate == null) input.opp = base.opp;
  return input;
}
