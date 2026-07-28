// projectedLineup — derive a probable batting order for a team whose lineup the
// league has not posted yet.
//
// Why this exists: `game.lineups?.[key]` is empty until MLB posts a card, which
// on a staggered slate is most of the board. `loadSlate` used to take that as
// "this team has no batters", which silently dropped every batter prop for the
// game. This module fills the gap with an explicitly-labelled guess.
//
// Derivation, in strict order (each tier only tops up what the previous one
// could not supply, so a single lineup can mix tiers):
//
//   1. LAST GAME    — the actual batting order from the team's most recent
//                     completed game, restricted to players still on the
//                     active roster.                      -> 'projected'
//   2. MODAL ORDER  — per slot, the player who has started that slot most often
//                     across the last N completed games.  -> 'projected'
//   3. ROSTER BY PA — active-roster position players ranked by season plate
//                     appearances.                        -> 'fallback'
//
// The team's own probable starter is always excluded (universal DH means he
// never bats, but a boxscore from an older rule set could still list him).
//
// Every emitted player carries `lineupSource` and `lineupProvenance`, so a row
// can always answer "where did this name come from?".
//
// Network shape per team, in the common case: one `/schedule` (team's recent
// dates), one `/teams/{id}/roster`, one `/game/{pk}/boxscore` — the remaining
// boxscores are only fetched when tier 1 comes up short. Everything is cached
// per team for the life of one projector, so a doubleheader (or any team that
// appears twice on a slate) never refetches.

import { SEASON, mlbFetch } from '../lib/api.js';

/** Flag pushed onto every non-confirmed batter row. The UI filters on literals. */
export const PROJ_LINEUP_FLAG = 'PROJ LINEUP';

/** Completed games inspected when building the modal order. */
export const LOOKBACK_GAMES = 7;

/** Calendar window searched for those completed games. */
export const LOOKBACK_DAYS = 21;

/** A full batting order. */
const LINEUP_SIZE = 9;

/**
 * @typedef {object} ProjectedPlayer
 * @property {number} id - MLB person id.
 * @property {string} fullName - Display name, as the odds feed would spell it.
 * @property {'projected'|'fallback'} lineupSource
 * @property {string} lineupProvenance - Human-readable origin of this name.
 */

/** Shift a YYYY-MM-DD date string by whole days, in UTC. */
function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pull one team's starting batting order out of a boxscore payload.
 *
 * MLB encodes the order on each player as a stringified 3+ digit number: slot
 * in the leading digits, sequence-within-slot in the trailing two ("300" is the
 * three-hole starter, "301" the man who replaced him). Starters are therefore
 * the entries where `battingOrder % 100 === 0`.
 *
 * Falls back to the team's flat `battingOrder` id array when the per-player
 * field is absent, which is how older/partial payloads present it.
 *
 * @param {object} box - `/api/v1/game/{pk}/boxscore` body.
 * @param {number} teamId
 * @returns {Array<{id: number, fullName: string}>}
 */
export function battingOrderFromBoxscore(box, teamId) {
  for (const side of ['away', 'home']) {
    const team = box?.teams?.[side];
    if (!team || team.team?.id !== teamId) continue;

    const players = Object.values(team.players || {});
    const starters = players
      .filter((p) => p.battingOrder != null && Number(p.battingOrder) % 100 === 0)
      .sort((a, b) => Number(a.battingOrder) - Number(b.battingOrder))
      .map((p) => ({ id: p.person?.id, fullName: p.person?.fullName || '' }))
      .filter((p) => p.id);
    if (starters.length) return starters;

    // Flat-array fallback: ids only, names resolved from the players map.
    const byId = new Map(
      players.map((p) => [p.person?.id, p.person?.fullName || '']),
    );
    const flat = (team.battingOrder || [])
      .map((id) => Number(id))
      .filter(Boolean)
      .slice(0, LINEUP_SIZE)
      .map((id) => ({ id, fullName: byId.get(id) || '' }));
    if (flat.length) return flat;
  }
  return [];
}

/**
 * Per slot, the player who has started there most often.
 *
 * Ties break toward the most recent game (orders are passed newest-first and
 * counting is stable). A player who is modal in two slots is only emitted for
 * the first one; the second slot falls through to its runner-up.
 *
 * @param {Array<{order: Array<{id: number, fullName: string}>}>} orders
 *   Recent batting orders, newest first.
 * @returns {Array<{id: number, fullName: string}>}
 */
export function modalBattingOrder(orders) {
  const out = [];
  const taken = new Set();
  for (let slot = 0; slot < LINEUP_SIZE; slot++) {
    const counts = new Map();
    for (const { order } of orders) {
      const player = order[slot];
      if (!player) continue;
      const entry = counts.get(player.id) || { player, n: 0 };
      entry.n += 1;
      counts.set(player.id, entry);
    }
    const best = [...counts.values()]
      .filter(({ player }) => !taken.has(player.id))
      .sort((a, b) => b.n - a.n)[0];
    if (best) {
      taken.add(best.player.id);
      out.push(best.player);
    }
  }
  return out;
}

/**
 * Active-roster position players, ranked by current-season plate appearances.
 *
 * Pitchers are dropped outright. Anyone with no hitting split sorts last at 0
 * PA rather than being excluded — on a September roster he may be the only body
 * left, and `projectBatter` copes with an empty stat line via league priors.
 *
 * @param {object} payload - `/api/v1/teams/{id}/roster` body, person-hydrated.
 * @returns {Array<{id: number, fullName: string, pa: number}>}
 */
export function positionPlayersByPa(payload) {
  return (payload?.roster || [])
    .filter(
      (entry) =>
        entry.position?.abbreviation !== 'P' && entry.position?.type !== 'Pitcher',
    )
    .map((entry) => {
      const person = entry.person || {};
      let pa = 0;
      for (const block of person.stats || [])
        for (const split of block.splits || [])
          pa = Math.max(pa, split.stat?.plateAppearances || 0);
      return { id: person.id, fullName: person.fullName || '', pa };
    })
    .filter((p) => p.id)
    .sort((a, b) => b.pa - a.pa);
}

/**
 * Create a per-slate lineup projector.
 *
 * The returned object owns a cache keyed by team id. Two games involving the
 * same team on one slate (a doubleheader, or the two halves of one matchup)
 * share every fetch; the cache lives exactly as long as the projector, so a
 * REFRESH still gets fresh data.
 *
 * @param {object} options
 * @param {string} options.date - Slate date, YYYY-MM-DD. The lookback window
 *   ends here, so a completed earlier game of a doubleheader is usable.
 * @param {number} [options.season] - Season used for the roster PA hydrate.
 * @param {number} [options.lookbackGames]
 * @param {number} [options.lookbackDays]
 * @param {(path: string) => Promise<object>} [options.fetchMlb] - Injectable
 *   for tests; defaults to the real proxy client.
 */
export function createLineupProjector({
  date,
  season = SEASON,
  lookbackGames = LOOKBACK_GAMES,
  lookbackDays = LOOKBACK_DAYS,
  fetchMlb = mlbFetch,
} = {}) {
  /** teamId -> Promise<TeamContext>. One entry per team, ever. */
  const contexts = new Map();
  let teamsFetched = 0;

  /**
   * Schedule + roster for one team, plus a lazily-filled boxscore cache.
   * Fetch failures degrade to empty data rather than rejecting: a team we
   * cannot read simply produces no projected lineup.
   */
  async function buildContext(teamId) {
    teamsFetched += 1;
    const startDate = shiftDate(date, -lookbackDays);

    const [schedule, roster] = await Promise.all([
      fetchMlb(
        `/api/v1/schedule?sportId=1&teamId=${teamId}` +
          `&startDate=${startDate}&endDate=${date}`,
      ).catch(() => null),
      fetchMlb(
        `/api/v1/teams/${teamId}/roster?rosterType=active` +
          `&hydrate=person(stats(type=season,season=${season},group=hitting))`,
      ).catch(() => null),
    ]);

    const finals = (schedule?.dates || [])
      .flatMap((d) => d.games || [])
      .filter((g) => g.status?.abstractGameState === 'Final')
      .sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate))
      .slice(0, lookbackGames);

    const rosterPlayers = positionPlayersByPa(roster);
    const rosterIds = new Set(rosterPlayers.map((p) => p.id));

    /** gamePk -> Promise<order>. Boxscores are pulled only when needed. */
    const boxscores = new Map();
    const orderFor = (game) => {
      if (!boxscores.has(game.gamePk))
        boxscores.set(
          game.gamePk,
          fetchMlb(`/api/v1/game/${game.gamePk}/boxscore`)
            .then((box) => ({
              gamePk: game.gamePk,
              gameDate: game.gameDate,
              order: battingOrderFromBoxscore(box, teamId),
            }))
            .catch(() => ({
              gamePk: game.gamePk,
              gameDate: game.gameDate,
              order: [],
            })),
        );
      return boxscores.get(game.gamePk);
    };

    return {
      finals,
      rosterPlayers,
      rosterIds,
      mostRecentOrder: () => (finals.length ? orderFor(finals[0]) : null),
      allOrders: () => Promise.all(finals.map(orderFor)),
    };
  }

  function context(teamId) {
    if (!contexts.has(teamId)) contexts.set(teamId, buildContext(teamId));
    return contexts.get(teamId);
  }

  /**
   * Derive a probable lineup for one team.
   *
   * @param {number} teamId
   * @param {object} [options]
   * @param {Array<number>} [options.excludeIds] - Ids that must not appear,
   *   i.e. the team's own probable pitcher.
   * @returns {Promise<ProjectedPlayer[]>} Up to nine players in slot order.
   *   Empty when nothing could be derived (new franchise, total fetch failure).
   */
  async function projectLineup(teamId, { excludeIds = [] } = {}) {
    const ctx = await context(teamId);
    const excluded = new Set(excludeIds.filter(Boolean).map(Number));
    // An empty roster means the roster call failed; don't let that filter
    // everything out — an unverified name beats no name.
    const onRoster = (id) => ctx.rosterIds.size === 0 || ctx.rosterIds.has(id);

    const out = [];
    const used = new Set();
    const push = (player, lineupSource, lineupProvenance) => {
      if (out.length >= LINEUP_SIZE) return;
      if (!player?.id || used.has(player.id) || excluded.has(player.id)) return;
      used.add(player.id);
      out.push({
        id: player.id,
        fullName: player.fullName || '',
        lineupSource,
        lineupProvenance,
      });
    };

    // ── tier 1: the most recent completed game's actual order ────────────────
    const recent = await ctx.mostRecentOrder();
    if (recent?.order.length) {
      const when = String(recent.gameDate || '').slice(0, 10);
      for (const player of recent.order)
        if (onRoster(player.id))
          push(player, 'projected', `last lineup ${when}`.trim());
    }

    // ── tier 2: modal order across the lookback window ───────────────────────
    if (out.length < LINEUP_SIZE && ctx.finals.length > 1) {
      const orders = (await ctx.allOrders()).filter((o) => o.order.length);
      const provenance = `most common order, last ${orders.length} games`;
      for (const player of modalBattingOrder(orders))
        if (onRoster(player.id)) push(player, 'projected', provenance);
    }

    // ── tier 3: active-roster position players by plate appearances ──────────
    if (out.length < LINEUP_SIZE)
      for (const player of ctx.rosterPlayers)
        push(player, 'fallback', 'active roster by PA');

    return out;
  }

  return {
    projectLineup,
    /** Diagnostics: how many teams this projector actually went to the wire for. */
    get teamsFetched() {
      return teamsFetched;
    },
  };
}
