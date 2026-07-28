// loadSlate — the master slate load (minified: `sh`).
//
// One call fetches everything the board needs for a single date and returns a
// fully-projected slate. Orchestration order is load-bearing and preserved
// exactly as it appears in the bundle:
//
//   1. schedule (+probablePitcher, lineups, team)   — MLB
//   2. team hitting environment for SEASON          — MLB
//   3. projected lineups for teams with no card     — MLB, cached per team
//   4. pitcher stats 2026 + 2025                    — MLB, in parallel
//   5. batter stats 2026 + 2025                     — MLB, in parallel
//   6. odds events list                             — Odds API
//   7. per-event event-odds                         — Odds API, all in parallel
//   8. venues + open-meteo forecast                 — MLB + open-meteo
//   9. build projections (pure, no I/O)
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
  normalizeName,
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
import { projectBatter } from '../model/batter.js';
import { projectNrfi } from '../model/nrfi.js';
import { evaluateEdge } from '../model/edges.js';
import { createLineupProjector, PROJ_LINEUP_FLAG } from './projectedLineup.js';

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

export async function loadSlate({
  date,
  oddsKey,
  onStatus,
  sharp = true,
  projectLineups = true,
}) {
  const status = (message) => onStatus && onStatus(message);

  // ── 1. schedule ────────────────────────────────────────────────────────────
  status('Fetching schedule + probable pitchers…');
  const allGames =
    (
      await mlbFetch(
        `/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team`,
      )
    ).dates?.[0]?.games || [];

  // Only games that have not started are projected. Anything live or Final is
  // dropped here and merely counted, so `skipped` is the only trace of it.
  const games = allGames.filter(
    (game) => game.status?.abstractGameState === 'Preview',
  );
  const skipped = allGames.length - games.length;

  // ── 2. team batting environment ────────────────────────────────────────────
  status('Fetching team batting environment…');
  const teamHitting = await mlbFetch(
    `/api/v1/teams/stats?sportId=1&season=${SEASON}&group=hitting&stats=season`,
  );
  const teamEnv = new Map();
  let lgPa = 0;
  let lgK = 0;
  let lgBb = 0;
  let lgH = 0;
  let lgAb = 0;
  for (const split of teamHitting.stats?.[0]?.splits || []) {
    const stat = split.stat;
    const pa = stat.plateAppearances || 1;
    teamEnv.set(split.team.id, {
      kRate: (stat.strikeOuts || 0) / pa,
      bbRate: (stat.baseOnBalls || 0) / pa,
      avg: parseFloat(stat.avg) || 0.244,
      obp: parseFloat(stat.obp) || 0.315,
      name: split.team.name,
    });
    lgPa += pa;
    lgK += stat.strikeOuts || 0;
    lgBb += stat.baseOnBalls || 0;
    lgH += stat.hits || 0;
    lgAb += stat.atBats || 0;
  }

  // League baseline: measured rates where we have PA, static priors otherwise.
  // Note only kRate / bbRate / avg are recomputed — hRate, hrRate, obp,
  // pitchesPerBF and strikePct always come from the static LEAGUE_AVG.
  const lg = {
    ...LEAGUE_AVG,
    kRate: lgPa ? lgK / lgPa : LEAGUE_AVG.kRate,
    bbRate: lgPa ? lgBb / lgPa : LEAGUE_AVG.bbRate,
    avg: lgAb ? lgH / lgAb : LEAGUE_AVG.avg,
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
  status(`Fetching pitcher stats (${pitcherIds.length} arms)…`);
  // Only the current-season pitcher call hydrates gameLog (4th arg) — the prior
  // season and both batter calls take season splits only.
  const [pitchers26, pitchers25] = await Promise.all([
    fetchPlayerStats(pitcherIds, 'pitching', SEASON, true),
    fetchPlayerStats(pitcherIds, 'pitching', PRIOR_SEASON, false),
  ]);

  status(`Fetching batter stats (${batterIds.length} bats)…`);
  const [batters26, batters25] = await Promise.all([
    fetchPlayerStats(batterIds, 'hitting', SEASON, false),
    fetchPlayerStats(batterIds, 'hitting', PRIOR_SEASON, false),
  ]);

  // ── 6. odds events ─────────────────────────────────────────────────────────
  status('Fetching live odds (events)…');
  let events = [];
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

  try {
    const res = await oddsFetch({ endpoint: 'events' }, oddsKey);
    events = res.body || [];
    noteRemaining(res.remaining);
  } catch (err) {
    oddsError = err.message;
  }

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
  const oddsByEvent = new Map();
  await Promise.all(
    eventIds.map(async (eventId) => {
      try {
        const res = await oddsFetch(
          {
            endpoint: 'event-odds',
            eventId,
            markets: marketsParam(sharp),
            books: sharp ? 'all' : 'core',
          },
          oddsKey,
        );
        oddsByEvent.set(eventId, parseEventOdds(res.body));
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
  status('Fetching weather…');
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

    await Promise.all(
      games.map(async (game) => {
        if (DOMED_PARKS.has(game.venue?.name)) {
          weatherByGame.set(game.gamePk, { indoor: true });
          return;
        }
        const coords = coordsByVenueId.get(game.venue?.id);
        if (coords?.latitude)
          try {
            const forecast = await (
              await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=UTC`,
                { signal: AbortSignal.timeout(12e3) },
              )
            ).json();
            // Forecast is UTC-hourly; match the game's start hour exactly.
            const hourKey =
              new Date(game.gameDate).toISOString().slice(0, 13) + ':00';
            const idx = (forecast.hourly?.time || []).indexOf(hourKey);
            if (idx >= 0)
              weatherByGame.set(game.gamePk, {
                tempF: Math.round(forecast.hourly.temperature_2m[idx]),
                windMph: Math.round(forecast.hourly.wind_speed_10m[idx]),
                indoor: false,
              });
          } catch {
            // per-venue forecast failure: no weather for this game
          }
      }),
    );
  } catch {
    // venue lookup failure: the whole slate simply has no weather
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
      const oppEnv = teamEnv.get(oppTeam.id);
      const proj = projectPitcher({
        season26: s26,
        season25: s25,
        gameLog,
        opp: oppEnv,
        park,
        lg,
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
      const props = attachLines(
        PITCHER_MARKETS,
        normalizeName(probable.fullName),
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

    // ── NRFI: only when *both* probable starters are known ────────────────────
    const awaySp = sp.away;
    const homeSp = sp.home;
    if (awaySp && homeSp) {
      // Mean OBP of the top three lineup slots, posted or projected. Returns
      // null only when nothing could be derived for this side (or none of the
      // top three have a 2026 OBP) — previously that was every unposted game,
      // which handed projectNrfi a silently league-average lineup.
      const topOfOrderObp = (side) => {
        const obps = (lineupBySide.get(sideKey(game.gamePk, side)) || [])
          .slice(0, 3)
          .map((player) => player.id)
          .map((id) =>
            parseFloat(pickSplit(batters26.get(id), 'hitting', SEASON)?.obp || ''),
          )
          .filter((v) => !isNaN(v));
        return obps.length ? obps.reduce((a, b) => a + b, 0) / obps.length : null;
      };

      // IP-weighted ERA blend; 2025 counts 0.6. Falls back to 4.2 under 20 IP.
      const blendedEra = (starter) => {
        const era26 = parseFloat(starter.s26?.era);
        const ip26 = parseInningsPitched(starter.s26?.inningsPitched);
        const era25 = parseFloat(starter.s25?.era);
        const ip25 = parseInningsPitched(starter.s25?.inningsPitched);
        const num =
          (isNaN(era26) ? 0 : era26 * ip26) +
          (isNaN(era25) ? 0 : era25 * ip25 * 0.6);
        const den = ip26 + (isNaN(era25) ? 0 : ip25 * 0.6);
        return den > 20 ? num / den : 4.2;
      };

      row.nrfi = projectNrfi(
        blendedEra(awaySp),
        blendedEra(homeSp),
        topOfOrderObp('away'),
        topOfOrderObp('home'),
        park,
        lg,
        wx,
      );

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
          spRates: oppSp
            ? {
                adjK: oppSp.proj.rates.adjK,
                adjH: oppSp.proj.rates.adjH,
                adjHR: oppSp.proj.rates.adjHR,
              }
            : null,
          park,
          lg,
          wx,
        });

        const smallSample = proj.flags.includes('SMALL SAMPLE');
        const props = attachLines(
          BATTER_MARKETS,
          normalizeName(player.fullName),
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
