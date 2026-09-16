// loadSlate — the master slate load (minified: `sh`).
//
// One call fetches everything the board needs for a single date and returns a
// fully-projected slate. The numbered steps below are the order results are
// *consumed*, which is load-bearing; the order requests are *issued* is not,
// and several of them are now fired earlier than the step that reads them:
//
//   1. schedule (+probablePitcher, lineups, team)   — MLB      ─┐ one wave
//   2. team hitting environment for SEASON          — MLB       │ (independent)
//   6. odds events list                             — Odds API ─┘
//   3. projected lineups for teams with no card     — MLB, cached per team
//   4/5. pitcher + batter stats, 2026 and 2025      — MLB, one wave of four
//   7. per-event event-odds                         — Odds API, all in parallel
//   8. venues + open-meteo forecast                 — MLB + open-meteo,
//      issued as soon as `games` exists, awaited here
//   9. build projections (pure, no I/O)
//
// Steps 1, 2 and 6 have no dependency on one another and step 8 depends only
// on `games`, so running them strictly in sequence charged the load the SUM of
// those round trips before the first lineup could be projected. They are still
// awaited in their original order, so failure precedence and the `status()`
// narration are unchanged — only the waiting overlaps.
//
// Network failures are *collected*, never thrown: the odds error is kept in
// `oddsError`, lineup-projection failures in `lineupError`, and weather
// failures are silently dropped, so a partial slate is still returned. Only the
// MLB calls (schedule / team stats / player stats) can reject the whole load.
//
// Every batter row carries `lineupSource` — 'confirmed' when MLB posted the
// card, 'projected' when it was derived from recent batting orders, 'fallback'
// when it came off the active roster by playing time. Anything other than
// 'confirmed' also carries the `PROJ LINEUP` flag, and the slate-level
// `lineupCounts` lets the UI say honestly how much of the board is a guess.

import { SEASON, PRIOR_SEASON, mlbFetch, oddsFetch } from '../lib/api.js';
import {
  fetchPlayerStats,
  pickSplit,
  pickGameLogSplits as pickGameLog,
} from '../lib/names.js';
import {
  PITCHER_MARKETS,
  BATTER_MARKETS,
  marketsParam,
  DOMED_PARKS,
} from '../lib/markets.js';
import { MARKET_WEIGHT } from '../lib/constants.js';
import { parseEventOdds, bestQuote, attachLines } from '../model/lines.js';
import { LEAGUE_AVG } from '../model/league.js';
import { projectPitcher, parseInningsPitched } from '../model/pitcher.js';
import { lineupOpponent } from '../model/lineupEnv.js';
import { lineupHandedness, platoonMultipliers } from '../model/platoon.js';
import { projectBatter, SB_PER_GAME_PRIOR, PA_BY_LINEUP_SLOT } from '../model/batter.js';
import { evaluateEdge } from '../model/edges.js';
import { projectGame, leagueRunPrevention } from '../model/game.js';
import { fetchTeamMarketQuotes, priceTeamMarkets } from './teamMarkets.js';
import { createLineupProjector, PROJ_LINEUP_FLAG } from './projectedLineup.js';

/**
 * Detailed states that are coded pre-game but will never be played as
 * scheduled, so they must not reach the board.
 */
const UNPLAYABLE_STATES = new Set([
  'Postponed',
  'Cancelled',
  'Canceled',
  'Suspended',
  'Game Over',
]);

/**
 * Coded states that mean first pitch has not been thrown.
 *
 * MLB uses 'S' (Scheduled) until roughly an hour before first pitch and only
 * then flips to 'P' (Pre-Game). Accepting 'P' alone therefore emptied the board
 * for any slate more than an hour out — tomorrow's card always, today's card
 * every morning — which is precisely the "never an empty board" failure the
 * `codedGameState` fallback below exists to prevent.
 */
const PREGAME_CODES = new Set(['P', 'S']);

/**
 * Is this game still ahead of first pitch, and therefore projectable?
 *
 * Exported for the regression test. See the note at the call site for the live
 * status distribution that motivated it.
 */
export function isBettableGame(game) {
  const status = game?.status || {};
  if (UNPLAYABLE_STATES.has(status.detailedState)) return false;
  // Fall back to the old test when `codedGameState` is absent, so a schema
  // change degrades to v24 behaviour rather than to an empty board.
  return status.codedGameState
    ? PREGAME_CODES.has(status.codedGameState)
    : status.abstractGameState === 'Preview';
}

/** `game.lineups` key for a side. */
const LINEUP_KEY = { away: 'awayPlayers', home: 'homePlayers' };

/** Cache key for one team's half of one game. */
const sideKey = (gamePk, side) => `${gamePk}:${side}`;

/**
 * Collapse a side's batters into a single status.
 *
 * 'confirmed' only when every name came off the posted card; 'fallback' as soon
 * as any name came from the roster tier, since that is the weakest claim in the
 * list and the one the UI should surface.
 *
 * @param {Array<{lineupSource: string}>} lineup
 * @returns {'confirmed'|'projected'|'fallback'|'none'}
 */
function sideLineupStatus(lineup) {
  if (!lineup.length) return 'none';
  if (lineup.every((p) => p.lineupSource === 'confirmed')) return 'confirmed';
  if (lineup.some((p) => p.lineupSource === 'fallback')) return 'fallback';
  return 'projected';
}

/**
 * Venue coordinates plus a game-hour forecast for every park on the slate.
 *
 * Depends on nothing but `games`, so `loadSlate` starts this the moment the
 * schedule lands and only awaits it at step 8 — the whole venue + forecast
 * latency now overlaps the lineup, stats and odds work instead of trailing it.
 *
 * Open-Meteo accepts comma-separated `latitude=`/`longitude=` and answers with
 * an array of forecasts in request order, so ~11 outdoor parks cost ONE
 * request instead of eleven. The bytes were never the problem; the tail was.
 * Each forecast carried its own `AbortSignal.timeout(12e3)` inside a
 * `Promise.all`, so a single park whose forecast hung held the entire slate
 * for up to twelve seconds. One request has one timeout.
 *
 * Verified against the live API before relying on any of it: a multi-location
 * request returns an array (a single-location request still returns a bare
 * object, hence the normalisation below), the array is in request order, and
 * the echoed `latitude`/`longitude` are snapped to the forecast grid rather
 * than echoed verbatim — which is why forecasts are matched back by request
 * position and never by comparing coordinates.
 *
 * `forecast_days` drops 3 -> 2: exactly one hour is ever read, and two days
 * already spans 00:00 UTC today through 23:00 UTC tomorrow, which covers every
 * start time on a slate for `date`.
 *
 * Weather is optional and every failure path is silent — a game with no
 * forecast simply gets no entry, and `projectPitcher`/`projectBatter` fall
 * back to their neutral weather terms. The one behaviour batching changes is
 * that a failed forecast request now costs the whole slate its outdoor weather
 * rather than one park; domes are recorded before the request is issued, so
 * they survive regardless.
 *
 * @param {Array<object>} games - Preview games from the slate schedule.
 * @returns {Promise<Map<number, object>>} gamePk -> weather. Never rejects.
 */
async function fetchWeather(games) {
  const weatherByGame = new Map();
  try {
    const venueIds = [
      ...new Set(games.map((game) => game.venue?.id).filter(Boolean)),
    ];
    const venuePayload = venueIds.length
      ? await mlbFetch(
          `/api/v1/venues?venueIds=${venueIds.join(',')}&hydrate=location`,
        )
      : { venues: [] };
    const coordsByVenueId = new Map(
      (venuePayload.venues || []).map((venue) => [
        venue.id,
        venue.location?.defaultCoordinates,
      ]),
    );

    // Domes are answered without a forecast at all, and are set before the
    // network call so they survive a forecast failure.
    const outdoor = [];
    for (const game of games) {
      if (DOMED_PARKS.has(game.venue?.name)) {
        weatherByGame.set(game.gamePk, { indoor: true });
        continue;
      }
      if (coordsByVenueId.get(game.venue?.id)?.latitude) outdoor.push(game);
    }
    if (!outdoor.length) return weatherByGame;

    // Distinct parks, not games: a doubleheader is one location.
    const venueOrder = [...new Set(outdoor.map((game) => game.venue.id))];
    const coords = venueOrder.map((id) => coordsByVenueId.get(id));
    const body = await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coords
          .map((c) => c.latitude)
          .join(',')}&longitude=${coords
          .map((c) => c.longitude)
          .join(',')}&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2&timezone=UTC`,
        { signal: AbortSignal.timeout(12e3) },
      )
    ).json();
    const forecasts = Array.isArray(body) ? body : [body];
    const forecastByVenueId = new Map(
      venueOrder.map((id, i) => [id, forecasts[i]]),
    );

    for (const game of outdoor) {
      const forecast = forecastByVenueId.get(game.venue.id);
      // Forecast is UTC-hourly; match the game's start hour exactly.
      const hourKey = new Date(game.gameDate).toISOString().slice(0, 13) + ':00';
      const idx = (forecast?.hourly?.time || []).indexOf(hourKey);
      if (idx >= 0)
        weatherByGame.set(game.gamePk, {
          tempF: Math.round(forecast.hourly.temperature_2m[idx]),
          windMph: Math.round(forecast.hourly.wind_speed_10m[idx]),
          indoor: false,
        });
    }
  } catch {
    // Venue lookup or forecast failure: the slate simply has no weather.
  }
  return weatherByGame;
}

/**
 * Per-pitcher vs-LHB / vs-RHB splits for every probable on the slate.
 *
 * The statSplits endpoint takes one person at a time, so this is one request
 * per probable — around 30 on a full slate. They are issued together with the
 * rest of the stats wave, so the cost is latency of the slowest one, not the
 * sum. The MLB API is unmetered, unlike the odds feed.
 *
 * Current season first, prior season when the current one is too thin to say
 * anything (April, or a pitcher just up). `platoonMultipliers` shrinks each
 * side toward the pitcher's own overall rate on top of this, so a thin split
 * degrades to a neutral 1.0 rather than to noise.
 *
 * Never rejects: a pitcher with no usable splits simply gets no entry, and his
 * projection is unadjusted.
 *
 * @param {number[]} pitcherIds
 * @returns {Promise<Map<number, {vl: object, vr: object}>>}
 */
const MIN_SPLIT_BF = 80;

async function fetchPlatoonSplits(pitcherIds) {
  const out = new Map();
  const ids = [...new Set(pitcherIds)].filter(Boolean);
  const forSeason = async (id, season) => {
    const body = await mlbFetch(
      `/api/v1/people/${id}/stats?stats=statSplits&sitCodes=vl,vr` +
        `&group=pitching&season=${season}`,
    );
    const entry = {};
    for (const st of body.stats || []) {
      for (const sp of st.splits || []) {
        const code = sp.split?.code;
        if (code === 'vl' || code === 'vr') entry[code] = sp.stat;
      }
    }
    const ok =
      entry.vl &&
      entry.vr &&
      (entry.vl.battersFaced || 0) >= MIN_SPLIT_BF &&
      (entry.vr.battersFaced || 0) >= MIN_SPLIT_BF;
    return ok ? entry : null;
  };

  await Promise.all(
    ids.map(async (id) => {
      try {
        const entry =
          (await forSeason(id, SEASON)) || (await forSeason(id, PRIOR_SEASON));
        if (entry) out.set(id, entry);
      } catch {
        // No splits for this arm; he is projected without the adjustment.
      }
    }),
  );
  return out;
}

export async function loadSlate({
  date,
  oddsKey,
  onStatus,
  sharp = true,
  projectLineups = true,
}) {
  const status = (message) => onStatus && onStatus(message);

  // ── 1/2/6. one wave: schedule, team stats, odds events ─────────────────────
  // None of these three reads any of the others, yet they used to be issued at
  // three different points in the load and paid for serially — the odds events
  // list in particular sat behind every MLB call on the board even though it
  // is the input to the *next* thing that needs to happen. Fired together they
  // cost the slowest one instead of the sum.
  //
  // Each is still awaited at the step that consumes it, in the original order,
  // so error precedence is unchanged: a schedule failure is still the error
  // that rejects the load even if the team-stats call also failed. The one
  // cost is that a load which dies on the schedule has now already issued the
  // other two requests.
  status('Fetching schedule + probable pitchers…');
  const schedulePromise = mlbFetch(
    `/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team`,
  );
  const teamHittingPromise = mlbFetch(
    `/api/v1/teams/stats?sportId=1&season=${SEASON}&group=hitting&stats=season`,
  );
  // A promise nobody has awaited *yet* still counts as unhandled the moment it
  // rejects, so a schedule failure would surface this one as an uncaught
  // rejection in the console before its own `await` below ever ran. Attaching
  // a no-op handler to a derived promise marks it handled without touching
  // what `await teamHittingPromise` sees.
  teamHittingPromise.catch(() => {});
  // Starter / reliever pitching splits for every team, one request. Feeds the
  // game model's bullpen term and the league run-prevention baselines. Optional:
  // a failure leaves every bullpen at league average rather than failing the load.
  // `limit=100`: this endpoint pages at 50 rows, and 30 teams x 2 roles is 60 —
  // without it six teams silently had no bullpen line.
  const teamPitchingPromise = mlbFetch(
    `/api/v1/teams/stats?sportId=1&season=${SEASON}&group=pitching&stats=statSplits&sitCodes=sp,rp&limit=100`,
  ).catch(() => null);
  // Same contract as the try/catch this replaces: the odds path may never
  // reject the load, it may only populate `oddsError`. Folding the catch into
  // the promise keeps that true while it is in flight unattended.
  const oddsEventsPromise = oddsFetch({ endpoint: 'events' }, oddsKey).then(
    (res) => ({ events: res.body || [], remaining: res.remaining, error: null }),
    (err) => ({ events: [], remaining: null, error: err.message }),
  );

  const allGames = (await schedulePromise).dates?.[0]?.games || [];

  // Only games that have not started are projected. Anything live or Final is
  // dropped here and merely counted, so `skipped` is the only trace of it.
  //
  // FIX(v24.1) — this filtered on `abstractGameState === 'Preview'`, which
  // silently dropped roughly half the bettable board every evening.
  //
  // A game in WARMUP reports `abstractGameState: 'Live'` while `codedGameState`
  // is still 'P' — pre-game. First pitch has not been thrown, the lineup is
  // posted and confirmed, and every book is still taking action. Observed on a
  // live 15-game slate:
  //
  //     5  abstract=Live     detailed=Warmup       coded=P   <- was dropped
  //     5  abstract=Preview  detailed=Pre-Game     coded=P
  //     3  abstract=Live     detailed=In Progress  coded=I
  //     2  abstract=Final                          coded=F
  //
  // So the board lost five of ten playable games, and it lost them at the WORST
  // possible moment: warmup starts ~30-40 minutes before first pitch, which is
  // exactly when lineups firm up and when a card is actually being decided.
  // Worse, it looked like normal behaviour — games aged out one at a time as
  // the evening went on, and `skipped` counted them without saying why.
  //
  // `codedGameState` is the reliable field: 'P' covers Pre-Game and Warmup, 'I'
  // is In Progress, 'F' is Final. The detailed-state exclusions below cover the
  // states that are also coded 'P' but will never be played as scheduled.
  const games = allGames.filter(isBettableGame);
  const skipped = allGames.length - games.length;

  // ── 8 (issued). weather ────────────────────────────────────────────────────
  // Venues + forecast need `games` and nothing else, and nothing between here
  // and step 9 reads the result, so this whole leg overlaps the rest of the
  // load rather than adding its latency to the end of it. `fetchWeather` never
  // rejects, so it is safe to leave in flight across the awaits below.
  const weatherPromise = fetchWeather(games);
  // Game lines (sportsbooks + Kalshi) need only `games` too. Never rejects.
  const teamMarketsPromise = fetchTeamMarketQuotes({ games, date, oddsKey });

  // ── 2. team batting environment ────────────────────────────────────────────
  status('Fetching team batting environment…');
  const teamHitting = await teamHittingPromise;
  const teamEnv = new Map();
  let lgPa = 0;
  let lgK = 0;
  let lgBb = 0;
  let lgH = 0;
  let lgAb = 0;
  let lgSb = 0;
  let lgGames = 0;
  let lgRuns = 0;
  for (const split of teamHitting.stats?.[0]?.splits || []) {
    const stat = split.stat;
    const pa = stat.plateAppearances || 1;
    teamEnv.set(split.team.id, {
      kRate: (stat.strikeOuts || 0) / pa,
      bbRate: (stat.baseOnBalls || 0) / pa,
      avg: parseFloat(stat.avg) || 0.244,
      obp: parseFloat(stat.obp) || 0.315,
      ops: parseFloat(stat.ops) || null,
      runs: stat.runs ?? null,
      gamesPlayed: stat.gamesPlayed || 0,
      name: split.team.name,
    });
    lgRuns += stat.runs || 0;
    lgPa += pa;
    lgK += stat.strikeOuts || 0;
    lgBb += stat.baseOnBalls || 0;
    lgH += stat.hits || 0;
    lgAb += stat.atBats || 0;
    lgSb += stat.stolenBases || 0;
    lgGames += stat.gamesPlayed || 0;
  }

  // League baseline: measured rates where we have PA, static priors otherwise.
  //
  // `hRate` and `hrRate` are deliberately NOT recomputed from this payload,
  // even though it contains the numbers. Both of their consumers want the
  // rate allowed by STARTING PITCHERS, not the league-wide batting rate:
  // `projectPitcher` uses `lg.hRate` as the shrinkage prior for a starter's
  // hits per batter faced, and `projectBatter` uses it as the denominator of
  // `spHit` and of the run-environment ratio, where the numerator is likewise
  // a starter's rate. Relievers are better than starters, so the all-pitcher
  // figure sits below the starter figure — measured over 2,674 starts in the
  // backtest window, starters allowed 0.2227 hits per BF against a league-wide
  // 0.2165 per PA. The frozen 0.221 is within 0.8% of the right number;
  // swapping in the live batting rate would have introduced a 2.8% error
  // pointing the wrong way. Left alone on evidence, not by omission.
  //
  // `sbPerGame` has no such ambiguity — it is a batting rate consumed as a
  // batting rate. Team steals over team games gives the per-team rate, and the
  // nine lineup spots share it. See SB_PER_GAME_PRIOR in model/batter.js.
  // FIX(v22.8) — the STARTER baselines are now derived live too.
  //
  // The note above is right that a starter's rate is not the league-wide rate,
  // and that swapping the live batting figure straight in would bias the wrong
  // way. But freezing them was only half the answer: `spHRate` and friends are
  // fixed constants, so they cannot follow the run environment, and the
  // backtest showed the cost — `pitcher_hits_allowed` sat at -1.8% in 2025 and
  // -2.4% in 2026, the same constant landing differently in two seasons.
  //
  // Every plate appearance a batter takes is a batter faced by some pitcher, so
  // `lgH / lgPa` IS the all-pitcher rate. Starters differ from that by a stable
  // multiplier, measured over 8,138 starts against 26,682 relief appearances:
  //
  //     H / BF    starters 0.2223   all 0.2183   ratio 1.0187
  //     K / BF    starters 0.2191   all 0.2220   ratio 0.9871
  //     BB / BF   starters 0.0797   all 0.0860   ratio 0.9266
  //
  // The RATIO is the durable quantity — it is a fact about how relief usage
  // differs from starting, not about any particular season's offence — so
  // carrying it and applying it to a live denominator tracks the environment,
  // where carrying the product could not.
  const SP_TO_LEAGUE_H = 1.0187;
  const SP_TO_LEAGUE_K = 0.9871;
  const SP_TO_LEAGUE_BB = 0.9266;

  const lg = {
    ...LEAGUE_AVG,
    kRate: lgPa ? lgK / lgPa : LEAGUE_AVG.kRate,
    bbRate: lgPa ? lgBb / lgPa : LEAGUE_AVG.bbRate,
    avg: lgAb ? lgH / lgAb : LEAGUE_AVG.avg,
    sbPerGame: lgGames ? lgSb / lgGames / 9 : SB_PER_GAME_PRIOR,
    // Fall back to the frozen constants when the team payload is unusable, so
    // a bad stats response degrades to v22 behaviour rather than to zero.
    spHRate: lgPa ? (lgH / lgPa) * SP_TO_LEAGUE_H : LEAGUE_AVG.spHRate,
    spKRate: lgPa ? (lgK / lgPa) * SP_TO_LEAGUE_K : LEAGUE_AVG.spKRate,
    spBbRate: lgPa ? (lgBb / lgPa) * SP_TO_LEAGUE_BB : LEAGUE_AVG.spBbRate,
  };

  // Game-model baselines: league runs per team-game, and the ERA/FIP blend for
  // starters, relievers and everyone, all from this season's team splits.
  const teamPitching = await teamPitchingPromise;
  const bullpenByTeam = new Map();
  const spSplits = [];
  const rpSplits = [];
  for (const split of teamPitching?.stats?.[0]?.splits || []) {
    const code = split.split?.code;
    if (code === 'rp') {
      bullpenByTeam.set(split.team.id, split.stat);
      rpSplits.push(split.stat);
    } else if (code === 'sp') spSplits.push(split.stat);
  }
  const prevention = leagueRunPrevention(spSplits, rpSplits);
  const gameLeague = {
    rpg: lgGames && lgRuns ? lgRuns / lgGames : 4.49,
    ...(prevention?.spRa9 && prevention?.rpRa9
      ? prevention
      : { spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 }),
  };

  // ── 3. lineups ─────────────────────────────────────────────────────────────
  // A posted card is authoritative. Every other half-game gets a lineup derived
  // from that team's recent batting orders, so the batter board is populated for
  // the whole slate instead of only the games MLB has gotten around to.
  const pitcherIds = [];
  const lineupBySide = new Map(); // `${gamePk}:${side}` -> ProjectedPlayer[]
  const needsProjection = [];

  for (const game of games)
    for (const side of ['away', 'home']) {
      const probable = game.teams[side].probablePitcher;
      if (probable) pitcherIds.push(probable.id);

      const posted = game.lineups?.[LINEUP_KEY[side]] || [];
      if (posted.length) {
        lineupBySide.set(
          sideKey(game.gamePk, side),
          posted.map((player) => ({
            id: player.id,
            fullName: player.fullName,
            lineupSource: 'confirmed',
            lineupProvenance: 'posted lineup',
          })),
        );
      } else {
        lineupBySide.set(sideKey(game.gamePk, side), []);
        needsProjection.push({ game, side });
      }
    }

  let lineupError = null;
  if (projectLineups && needsProjection.length) {
    // Distinct teams, not distinct half-games: the projector caches per team, so
    // both ends of a doubleheader cost one team's worth of fetches.
    const teamCount = new Set(
      needsProjection.map(({ game, side }) => game.teams[side].team.id),
    ).size;
    status(`Projecting lineups for ${teamCount} teams…`);

    const projector = createLineupProjector({ date });
    await Promise.all(
      needsProjection.map(async ({ game, side }) => {
        try {
          const lineup = await projector.projectLineup(game.teams[side].team.id, {
            excludeIds: [game.teams[side].probablePitcher?.id],
          });
          lineupBySide.set(sideKey(game.gamePk, side), lineup);
        } catch (err) {
          // First error wins, same convention as the odds block. A team we
          // cannot project just stays empty rather than failing the slate.
          lineupError = lineupError || err.message;
        }
      }),
    );
  }

  const batterIds = [];
  for (const lineup of lineupBySide.values())
    for (const player of lineup) batterIds.push(player.id);

  // ── 4/5. player stats ──────────────────────────────────────────────────────
  // One wave of four, not two waves of two. The batter calls never depended on
  // the pitcher calls — both `pitcherIds` and `batterIds` are already complete
  // above — so the second `Promise.all` was simply queueing behind the first
  // and charging the load a second full round trip (each of these is itself a
  // chunked multi-request fan-out, so the two waves were the slowest pitcher
  // chunk PLUS the slowest batter chunk).
  //
  // Only the current-season pitcher call hydrates gameLog (4th arg) — the prior
  // season and both batter calls take season splits only.
  status(`Fetching pitcher stats (${pitcherIds.length} arms)…`);
  const statsPromise = Promise.all([
    fetchPlayerStats(pitcherIds, 'pitching', SEASON, true),
    fetchPlayerStats(pitcherIds, 'pitching', PRIOR_SEASON, false),
    fetchPlayerStats(batterIds, 'hitting', SEASON, false),
    fetchPlayerStats(batterIds, 'hitting', PRIOR_SEASON, false),
    fetchPlatoonSplits(pitcherIds),
  ]);
  // Both narration lines are still emitted, in their original order, so the UI
  // reads the same; they just bracket one await instead of two.
  status(`Fetching batter stats (${batterIds.length} bats)…`);
  const [pitchers26, pitchers25, batters26, batters25, platoonByPitcher] =
    await statsPromise;

  // ── 6. odds events ─────────────────────────────────────────────────────────
  status('Fetching live odds (events)…');
  let remaining = null;
  let oddsError = null;

  // The quota header is per-response and the per-event calls run in parallel,
  // so keep the *smallest* figure any of them reported rather than whichever
  // one happened to land last — the displayed balance must never overstate.
  const noteRemaining = (value) => {
    if (!value) return;
    if (remaining == null) {
      remaining = value;
      return;
    }
    const [prev, next] = [Number(remaining), Number(value)];
    remaining = isNaN(prev) || isNaN(next) ? value : String(Math.min(prev, next));
  };

  // Already in flight since step 1; the try/catch that used to wrap this call
  // now lives on the promise itself, with identical semantics — a failure sets
  // `oddsError` and leaves `events` empty, and never throws.
  const oddsEvents = await oddsEventsPromise;
  const events = oddsEvents.events;
  oddsError = oddsEvents.error;
  noteRemaining(oddsEvents.remaining);

  // ── 7. per-event odds ──────────────────────────────────────────────────────
  // Games are resolved to event ids first, then each *distinct* event is bought
  // once. A doubleheader the feed lists as a single event used to fire two
  // identical requests in parallel and pay for both; now both gamePks read the
  // one payload.
  status(`Fetching live odds for ${games.length} games…`);
  const eventIdByGame = new Map();
  for (const game of games) {
    const awayTeam = game.teams.away.team;
    const homeTeam = game.teams.home.team;
    const gameDate = new Date(game.gameDate);

    // Match by exact full team names, then disambiguate (doubleheaders) by
    // the event whose commence_time is nearest this game's start.
    const candidates = events.filter(
      (ev) => ev.home_team === homeTeam.name && ev.away_team === awayTeam.name,
    );
    if (!candidates.length) continue;
    const event = candidates.reduce((best, ev) =>
      Math.abs(new Date(ev.commence_time) - gameDate) <
      Math.abs(new Date(best.commence_time) - gameDate)
        ? ev
        : best,
    );
    eventIdByGame.set(game.gamePk, event.id);
  }

  const eventIds = [...new Set(eventIdByGame.values())];

  // Everyone who could legitimately be priced in each event: both probables and
  // both lineups, with their MLB ids and teams.
  //
  // `parseEventOdds` has taken this since v20 and has never been given it, so
  // the entire identity layer — id joins, team tie-breaks, collision detection —
  // was inert and the odds/stats join fell back to bare string equality. That
  // silently dropped players the books HAD priced: any name the two feeds spell
  // differently resolves to nothing, and any name shared by two real players
  // (there is a pair of Will Smiths and a pair of Luis Ortizes most seasons)
  // had their quotes merged into one pool and handed to both. Neither case
  // raised anything — an unmatched player looks exactly like an unpriced one.
  //
  // A doubleheader can map two gamePks onto one event, so rosters are unioned
  // by event rather than built per game.
  const playersByEvent = new Map();
  for (const [gamePk, eventId] of eventIdByGame) {
    const game = games.find((g) => g.gamePk === gamePk);
    if (!game) continue;
    const roster = playersByEvent.get(eventId) || [];
    for (const side of ['away', 'home']) {
      const team = game.teams[side].team;
      const teamHint = team?.abbreviation || team?.teamName || team?.name || '';
      const probable = game.teams[side].probablePitcher;
      if (probable) {
        roster.push({ id: probable.id, fullName: probable.fullName, team: teamHint });
      }
      for (const player of lineupBySide.get(sideKey(gamePk, side)) || []) {
        roster.push({ id: player.id, fullName: player.fullName, team: teamHint });
      }
    }
    playersByEvent.set(eventId, roster);
  }

  const oddsByEvent = new Map();
  await Promise.all(
    eventIds.map(async (eventId) => {
      try {
        const res = await oddsFetch(
          {
            endpoint: 'event-odds',
            eventId,
            markets: marketsParam(sharp),
            // Always `wide`: 10 pinned bookmakers, which bills identically to
            // the old 5-key `core` (cost is per 10 books) but adds Kalshi,
            // Novig and the three DFS boards. `all` is deliberately no longer
            // used even in sharp mode — it swapped the pinned list for
            // `regions=us,us2`, which costs more AND dropped Pinnacle, the one
            // book the model weights 3x.
            books: 'wide',
          },
          oddsKey,
        );
        oddsByEvent.set(
          eventId,
          parseEventOdds(res.body, { players: playersByEvent.get(eventId) }),
        );
        noteRemaining(res.remaining);
      } catch (err) {
        // First error wins; later per-event failures are dropped entirely.
        oddsError = oddsError || err.message;
      }
    }),
  );

  const oddsByGame = new Map();
  for (const [gamePk, eventId] of eventIdByGame) {
    const parsed = oddsByEvent.get(eventId);
    if (parsed) oddsByGame.set(gamePk, parsed);
  }

  // ── 8. weather ─────────────────────────────────────────────────────────────
  // Issued back at step 1; by the time the odds fan-out is done this has almost
  // always already resolved, so the await is usually free. See `fetchWeather`.
  status('Fetching weather…');
  const weatherByGame = await weatherPromise;

  status('Fetching game lines…');
  const teamMarkets = await teamMarketsPromise;
  noteRemaining(teamMarkets.remaining);

  // Lineup OPS relative to each team's season OPS, for the game model. Nine
  // regulars out-hit a season line that includes the bench and call-ups, so the
  // raw ratio runs high for every team; dividing by the slate average leaves
  // only tonight's DIFFERENCES (a rested star, a platoon-heavy card).
  const lineupOpsRatio = new Map();
  for (const game of games) {
    for (const side of ['away', 'home']) {
      const lineup = lineupBySide.get(sideKey(game.gamePk, side)) || [];
      const team = teamEnv.get(game.teams[side].team.id);
      if (lineup.length < 9 || !team?.ops) continue;
      let weighted = 0;
      let weights = 0;
      lineup.slice(0, 9).forEach((player, index) => {
        const s = pickSplit(batters26.get(player.id), 'hitting', SEASON);
        const ops = parseFloat(s?.ops);
        const pa = s?.plateAppearances || 0;
        const weight = PA_BY_LINEUP_SLOT[index] ?? PA_BY_LINEUP_SLOT[8];
        weighted += weight * (pa >= 50 && Number.isFinite(ops) ? ops : team.ops);
        weights += weight;
      });
      if (weights) lineupOpsRatio.set(sideKey(game.gamePk, side), weighted / weights / team.ops);
    }
  }
  if (lineupOpsRatio.size >= 6) {
    const centre = [...lineupOpsRatio.values()].reduce((a, b) => a + b, 0) / lineupOpsRatio.size;
    for (const [k, v] of lineupOpsRatio) lineupOpsRatio.set(k, v / centre);
  } else {
    // Too few cards to know what "normal" looks like; use season lines only.
    lineupOpsRatio.clear();
  }

  // ── 9. projections ─────────────────────────────────────────────────────────
  const out = [];
  status('Building projections…');
  for (const game of games) {
    const awayTeam = game.teams.away.team;
    const homeTeam = game.teams.home.team;
    const park = game.venue?.name || '';
    const isFinal = game.status?.abstractGameState === 'Final';
    const gameOdds = oddsByGame.get(game.gamePk) || {};
    const wx = weatherByGame.get(game.gamePk) || null;

    const row = {
      gamePk: game.gamePk,
      venue: park,
      gameDate: game.gameDate,
      isFinal,
      wx,
      status: game.status?.detailedState,
      away: {
        id: awayTeam.id,
        name: awayTeam.name,
        abbr: awayTeam.abbreviation || awayTeam.teamName || awayTeam.name,
      },
      home: {
        id: homeTeam.id,
        name: homeTeam.name,
        abbr: homeTeam.abbreviation || homeTeam.teamName || homeTeam.name,
      },
      pitchers: [],
      batters: [],
      nrfi: null,
      nrfiLine: null,
      // Per-side lineup provenance, plus the game-level roll-up the banner reads.
      lineups: {
        away: sideLineupStatus(lineupBySide.get(sideKey(game.gamePk, 'away')) || []),
        home: sideLineupStatus(lineupBySide.get(sideKey(game.gamePk, 'home')) || []),
      },
      lineupStatus: 'none',
    };

    // 'confirmed' only when both cards are posted; 'none' only when neither side
    // produced a single batter. Everything in between is a guess worth labelling.
    row.lineupStatus =
      row.lineups.away === 'confirmed' && row.lineups.home === 'confirmed'
        ? 'confirmed'
        : row.lineups.away === 'none' && row.lineups.home === 'none'
          ? 'none'
          : 'projected';

    // starters, keyed by side, reused by the NRFI and batter blocks below
    const sp = {};

    for (const side of ['away', 'home']) {
      const probable = game.teams[side].probablePitcher;
      if (!probable) continue;

      const person = pitchers26.get(probable.id);
      const s26 = pickSplit(person, 'pitching', SEASON);
      const s25 = pickSplit(
        pitchers25.get(probable.id),
        'pitching',
        PRIOR_SEASON,
      );
      const gameLog = pickGameLog(person, 'pitching')
        .filter((split) => (split.stat?.gamesStarted || 0) > 0)
        .map((split) => ({
          ip: parseInningsPitched(split.stat.inningsPitched),
          pitches: split.stat.numberOfPitches || 0,
          bf: split.stat.battersFaced || 0,
          k: split.stat.strikeOuts || 0,
          date: split.date,
        }));

      const oppTeam = side === 'away' ? homeTeam : awayTeam;
      // The nine hitters he actually faces, weighted by expected trips, rather
      // than his opponent's full-season team aggregate. `lineupOpponent` falls
      // back to that aggregate whenever the card is not posted or too few of
      // its hitters have usable season stats, which is also the honest
      // behaviour for an early load.
      //
      // Safe against the v19 feedback loop: this only reaches adjK/adjBB/adjH,
      // and `projectBatter` below is handed the starter's RAW talent rates, not
      // his adjusted ones. See the note at the top of model/lineupEnv.js.
      // `lineupBySide` already carries the confirmed card when MLB has posted
      // one and the projected card when it has not, so the pitcher sees the
      // same nine hitters the batter board is about to price.
      const oppSide = side === 'away' ? 'home' : 'away';
      const oppEnv = lineupOpponent({
        lineup: lineupBySide.get(sideKey(game.gamePk, oppSide)),
        statsFor: (id) => pickSplit(batters26.get(id), 'hitting', SEASON),
        teamAgg: teamEnv.get(oppTeam.id),
      });
      // Pitcher-specific platoon adjustment. A blanket league coefficient was
      // measured and rejected (see model/lineupEnv.js); splits are strongly
      // pitcher-specific, so this uses each starter's own.
      const platoonSplits = platoonByPitcher.get(probable.id);
      const handComp = lineupHandedness({
        lineup: lineupBySide.get(sideKey(game.gamePk, oppSide)),
        batSideFor: (id) => batters26.get(id)?.batSide?.code,
        starterHand: person?.pitchHand?.code,
        paBySlot: PA_BY_LINEUP_SLOT,
      });
      const platoon =
        platoonSplits && handComp
          ? platoonMultipliers({
              vsL: platoonSplits.vl,
              vsR: platoonSplits.vr,
              shareVsL: handComp.shareVsL,
            })
          : undefined;

      const proj = projectPitcher({
        season26: s26,
        season25: s25,
        gameLog,
        opp: oppEnv,
        park,
        lg,
        platoon,
      });

      sp[side] = {
        proj,
        s26,
        s25,
        name: probable.fullName,
        // NB: default 'R' here, but '?' on the emitted row below
        hand: person?.pitchHand?.code || 'R',
      };

      const smallSample = proj.flags.includes('SMALL SAMPLE');
      // Identity, not just a name — `attachLines` can then join on the MLB id
      // and break a same-name tie on team instead of guessing. See the roster
      // note at the `parseEventOdds` call above.
      const props = attachLines(
        PITCHER_MARKETS,
        {
          id: probable.id,
          fullName: probable.fullName,
          team: (side === 'away' ? awayTeam : homeTeam)?.abbreviation ||
            (side === 'away' ? awayTeam : homeTeam)?.teamName || '',
        },
        gameOdds,
        proj,
        smallSample,
      );
      const team = side === 'away' ? awayTeam : homeTeam;

      row.pitchers.push({
        id: probable.id,
        name: probable.fullName,
        hand: person?.pitchHand?.code || '?',
        team: team.name,
        teamAbbr: team.abbreviation || team.teamName || '',
        side,
        opp: oppTeam.name,
        oppAbbr: oppTeam.abbreviation || oppTeam.teamName || '',
        oppK: oppEnv?.kRate,
        oppAvg: oppEnv?.avg,
        season: s26
          ? {
              era: s26.era,
              whip: s26.whip,
              ip: s26.inningsPitched,
              gs: s26.gamesStarted,
              k: s26.strikeOuts,
              bb: s26.baseOnBalls,
              k9: s26.strikeoutsPer9Inn,
            }
          : null,
        prior: s25
          ? { era: s25.era, whip: s25.whip, gs: s25.gamesStarted }
          : null,
        recentLog: gameLog.slice(-5),
        proj,
        props,
        flags: proj.flags,
      });
    }

    // ── game lines: moneyline, run line, total ──────────────────────────────────
    const gameSide = (side, team) => ({
      offense: teamEnv.get(team.id) || null,
      homePark: team.venue?.name || '',
      lineupOpsRatio: lineupOpsRatio.get(sideKey(game.gamePk, side)) || null,
      starter: sp[side] ? { s26: sp[side].s26, s25: sp[side].s25, projIP: sp[side].proj.projIP } : null,
      bullpen: bullpenByTeam.get(team.id) || null,
    });
    row.game = projectGame({
      away: gameSide('away', awayTeam),
      home: gameSide('home', homeTeam),
      league: gameLeague,
      park,
      wx,
    });
    const lineQuotes = teamMarkets.quotesByGame.get(game.gamePk);
    row.teamLines = priceTeamMarkets(row.game, lineQuotes?.books, lineQuotes?.kalshi);

    // ── NRFI: only when *both* probable starters are known ────────────────────
    const awaySp = sp.away;
    const homeSp = sp.home;
    if (awaySp && homeSp) {
      // FIX(v35) — NRFI now comes from the game model's first inning rather than
      // the separate hand-tuned model in the old model/nrfi.js. That model was
      // centred on a 54% NRFI rate and a .325 top-of-order OBP; the real 2026
      // figures are 49.5% and .341, so it leaned NRFI by 3-4 points on every
      // game. The game model is fitted to the measured first-inning run
      // distributions for each side (the bottom of the first scores 32% more
      // than the top) and lands at 50.1% for two average teams.
      row.nrfi = row.game.nrfi;

      const nrfiQuote = bestQuote(gameOdds.totals_1st_1_innings?.__game__);
      if (nrfiQuote && nrfiQuote.point === 0.5) {
        row.nrfiLine = {
          book: nrfiQuote.underBook || nrfiQuote.overBook,
          yrfiBook: nrfiQuote.overBook,
          nrfiBook: nrfiQuote.underBook,
          nBooks: nrfiQuote.nBooks,
          yrfiOdds: nrfiQuote.over,
          nrfiOdds: nrfiQuote.under,
        };
        row.nrfiEdge = evaluateEdge(
          row.nrfi.yrfiProb,
          0.5,
          nrfiQuote.over,
          nrfiQuote.under,
          { weight: MARKET_WEIGHT.nrfi, quotes: nrfiQuote.quotes },
        );
      }
    }

    // ── batters: posted card where there is one, projection otherwise ─────────
    for (const side of ['away', 'home']) {
      const lineup = lineupBySide.get(sideKey(game.gamePk, side)) || [];
      const oppSp = sp[side === 'away' ? 'home' : 'away'];
      const team = side === 'away' ? awayTeam : homeTeam;

      lineup.forEach((player, index) => {
        const b26 = pickSplit(batters26.get(player.id), 'hitting', SEASON);
        const b25 = pickSplit(batters25.get(player.id), 'hitting', PRIOR_SEASON);
        const person = batters26.get(player.id);

        const proj = projectBatter({
          season26: b26,
          season25: b25,
          slot: index + 1, // lineup order is array order
          isAway: side === 'away',
          batSide: person?.batSide?.code,
          pitcherHand: oppSp?.hand,
          // The RAW shrunk talent rates, not the adjusted ones.
          //
          // `projectBatter` prefers these (see `starterTalentRates`) precisely
          // because `adjK`/`adjH`/`adjHR` have already been multiplied by this
          // park's factor AND by an opponent-lineup term computed against the
          // batter's OWN team. Passing the adjusted rates made the batter model
          // divide the park back out by hand and left the circular own-team
          // term in place — a high-strikeout team's hitters each picked up an
          // extra ~3% strikeout bump on top of their own already-measured
          // strikeout rate, which is where they got it from.
          //
          // These three are park-free, opponent-free and clamp-free, so nothing
          // is double counted and nothing has to be inverted.
          spRates: oppSp
            ? {
                kRate: oppSp.proj.rates.kRate,
                hRate: oppSp.proj.rates.hRate,
                hrRate: oppSp.proj.rates.hrRate,
              }
            : null,
          park,
          lg,
          wx,
        });

        const smallSample = proj.flags.includes('SMALL SAMPLE');
        const props = attachLines(
          BATTER_MARKETS,
          {
            id: player.id,
            fullName: player.fullName,
            team: team?.abbreviation || team?.teamName || '',
          },
          gameOdds,
          proj,
          smallSample,
        );

        // Guessed slots carry a visible flag alongside the model's own. Copied
        // rather than pushed onto `proj.flags`, which the pitcher/NRFI blocks
        // also read.
        const isConfirmed = player.lineupSource === 'confirmed';
        const flags = isConfirmed
          ? proj.flags
          : [...proj.flags, PROJ_LINEUP_FLAG];

        row.batters.push({
          id: player.id,
          name: player.fullName,
          slot: index + 1,
          lineupSource: player.lineupSource,
          lineupProvenance: player.lineupProvenance,
          team: team.name,
          teamAbbr: team.abbreviation || team.teamName,
          side,
          batSide: person?.batSide?.code || '?',
          vs: oppSp?.name || 'TBD',
          vsHand: oppSp?.hand || '?',
          season: b26
            ? {
                avg: b26.avg,
                obp: b26.obp,
                slg: b26.slg,
                hr: b26.homeRuns,
                pa: b26.plateAppearances,
                sb: b26.stolenBases,
                g: b26.gamesPlayed,
              }
            : null,
          proj,
          props,
          flags,
        });
      });
    }

    out.push(row);
  }

  status('Done.');
  return {
    date,
    games: out,
    lg,
    remaining,
    oddsError,
    lineupError,
    // Game-line sources fail independently of the prop feed and of each other.
    gameLinesError: teamMarkets.booksError,
    kalshiGameError: teamMarkets.kalshiError,
    skipped,
    loadedAt: new Date().toISOString(),
    // Unchanged meaning: games for which MLB posted at least one card. It is no
    // longer "games with batters" — that is now most of the slate.
    lineupsPosted: out.filter((g) =>
      g.batters.some((b) => b.lineupSource === 'confirmed'),
    ).length,
    // Honest denominators for the banner: every game lands in exactly one bin.
    lineupCounts: {
      confirmed: out.filter((g) => g.lineupStatus === 'confirmed').length,
      projected: out.filter((g) => g.lineupStatus === 'projected').length,
      none: out.filter((g) => g.lineupStatus === 'none').length,
    },
    // Distinct paid odds requests actually issued (was: one per matched game).
    oddsRequests: eventIds.length,
  };
}
