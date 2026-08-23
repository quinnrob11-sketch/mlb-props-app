// Small UI-side helpers: the row key builder (minified: `Va`), the slate →
// flat row list transform (`Ro`) and the free-text search predicate (`ad`).

/**
 * Stable identity for a prop row: `kind:playerId:market`.
 * Alternate-line rows append `:alt<line>` at the call site so every rung of an
 * alt ladder gets its own key.
 */
export function propKey(kind, playerId, market) {
  return `${kind}:${playerId}:${market}`;
}

/**
 * Flatten a slate into the row list every board renders from.
 *
 * One row per (player, prop) pair — pitchers first, then batters, in slate
 * order. Each row carries a denormalised copy of the fields the boards need
 * plus `detailRef` (the originating pitcher/batter object, used for the
 * expandable detail panel and the distribution chart) and `game`.
 */
export function flattenRows(slate) {
  const rows = [];
  if (!slate) return rows;

  for (const game of slate.games || []) {
    const matchup = `${game.away?.abbr || '?'} @ ${game.home?.abbr || '?'}`;

    for (const pitcher of game.pitchers || [])
      for (const prop of pitcher.props || [])
        rows.push({
          kind: 'pitcher',
          key: propKey('p', pitcher.id, prop.market) + (prop.alt ? `:alt${prop.line}` : ''),
          alt: !!prop.alt,
          playerId: pitcher.id,
          name: pitcher.name,
          sub: `${pitcher.teamAbbr} · ${pitcher.hand}HP`,
          team: pitcher.teamAbbr,
          teamName: pitcher.team,
          matchup,
          gameDate: game.gameDate,
          opp: pitcher.oppAbbr,
          market: prop.market,
          short: prop.short,
          label: prop.label,
          distKey: prop.distKey,
          line: prop.line,
          book: prop.book,
          overBook: prop.overBook,
          underBook: prop.underBook,
          nBooks: prop.nBooks,
          over: prop.over,
          under: prop.under,
          proj: prop.proj,
          edge: prop.edge,
          // Where the called price came from and every venue quoting this
          // line — the boards' click-through and the DFS board read these.
          venue: prop.venue ?? null,
          venues: prop.venues || [],
          flags: pitcher.flags,
          detailRef: pitcher,
          game,
        });

    for (const batter of game.batters || [])
      for (const prop of batter.props || [])
        rows.push({
          kind: 'batter',
          key: propKey('b', batter.id, prop.market) + (prop.alt ? `:alt${prop.line}` : ''),
          alt: !!prop.alt,
          playerId: batter.id,
          name: batter.name,
          sub: `${batter.teamAbbr} · #${batter.slot} · ${batter.batSide}`,
          team: batter.teamAbbr,
          teamName: batter.team,
          matchup,
          gameDate: game.gameDate,
          opp: `${batter.vs} (${batter.vsHand})`,
          market: prop.market,
          short: prop.short,
          label: prop.label,
          distKey: prop.distKey,
          line: prop.line,
          book: prop.book,
          overBook: prop.overBook,
          underBook: prop.underBook,
          nBooks: prop.nBooks,
          over: prop.over,
          under: prop.under,
          proj: prop.proj,
          edge: prop.edge,
          venue: prop.venue ?? null,
          venues: prop.venues || [],
          flags: batter.flags,
          detailRef: batter,
          game,
        });
  }

  return rows;
}

/**
 * Reorder a row list so every rung of the same (kind, player, market) sits
 * together, and hand back the pairing each row needs to describe itself.
 *
 * WHY: `attachLines` emits a main line and any alternate rungs as independent
 * rows, and the boards sort by EV — so "Hits OVER 0.5" and "Hits ALT UNDER
 * 1.5" can land side by side looking like the model arguing with itself. They
 * are not two opinions: they are one projection sliced at two lines, and taken
 * together they bracket a range (over the low rung + under the high rung is a
 * synthetic "exactly one"). Nothing here changes the model or drops a row —
 * it only makes the relationship visible, because users have been reporting
 * coherent probability as a bug.
 *
 * Group order follows the incoming order (so an EV-sorted list still leads
 * with its best group); within a group the main line comes first and the alt
 * rungs climb by line, which is the order a bettor reads a ladder in.
 *
 * @param {object[]} rows
 * @returns {{ordered: object[], pairing: Map<string, {index:number, size:number, ladder:object[]}>}}
 */
export function pairMarketLines(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groupKey = (row) => `${row?.kind}:${row?.playerId}:${row?.market}`;

  const groups = new Map();
  for (const row of list) {
    const k = groupKey(row);
    const bucket = groups.get(k);
    if (bucket) bucket.push(row);
    else groups.set(k, [row]);
  }

  const ordered = [];
  const pairing = new Map();
  const emitted = new Set();
  for (const row of list) {
    const k = groupKey(row);
    if (emitted.has(k)) continue;
    emitted.add(k);
    const ladder = groups
      .get(k)
      .slice()
      // Main line (alt === false) first, then rungs by line ascending.
      .sort((a, b) => Number(!!a.alt) - Number(!!b.alt) || (a.line ?? 0) - (b.line ?? 0));
    ladder.forEach((member, index) => {
      ordered.push(member);
      pairing.set(member.key, { index, size: ladder.length, ladder });
    });
  }

  return { ordered, pairing };
}

/**
 * Case-insensitive substring match of the search box against player name,
 * team abbreviation, full team name, matchup and prop label. Empty query
 * matches everything.
 */
export function matchesQuery(row, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    row.name.toLowerCase().includes(q) ||
    row.team.toLowerCase().includes(q) ||
    (row.teamName || '').toLowerCase().includes(q) ||
    row.matchup.toLowerCase().includes(q) ||
    row.label.toLowerCase().includes(q)
  );
}

/**
 * Conviction ordering — "which of these should I actually take, and in what
 * order?"
 *
 * The board used to sort Best Bets by raw EV percent alone, and that is the
 * wrong question. EV% is return per unit staked; it says nothing about how much
 * of the bankroll the play deserves. Sorting by it puts a +250 longshot with
 * 12% EV above a -120 play with 6%, when the second is the better bet for
 * almost any bankroll — the longshot wins its EV from price, not from the model
 * knowing more.
 *
 * Conviction is ordered on three keys, in this order:
 *
 *   1. VERDICT TIER. The ladder already encodes the engine's own confidence and
 *      carries every demotion — thin books, one-sided markets, small samples,
 *      punishing prices. A STRONG should never sit below a LEAN, whatever the
 *      arithmetic underneath says.
 *   2. QUARTER-KELLY STAKE. Within a tier, this is literally the answer to "how
 *      much conviction": Kelly combines the size of the edge with the price
 *      being laid, which is exactly the trade-off EV% throws away.
 *   3. BOOK AGREEMENT. A dead heat goes to the play more books priced, because
 *      the fair number behind it is better established.
 *
 * Rows with no edge sort to the bottom rather than being dropped, so nothing
 * silently vanishes from the board.
 */
const VERDICT_RANK = { STRONG: 3, SOLID: 2, LEAN: 1, PASS: 0 };

export function convictionScore(row) {
  const edge = row?.edge;
  if (!edge || edge.ev == null) return { tier: -1, stake: -1, books: -1 };
  return {
    tier: VERDICT_RANK[edge.verdict] ?? 0,
    // `kelly` is already the quarter-Kelly fraction. It can come back null when
    // the price could not be converted; fall back to EV so the row still ranks
    // sensibly among its own tier instead of sinking to the bottom.
    stake: edge.kelly != null && edge.kelly > 0 ? edge.kelly : (edge.ev ?? 0) / 1000,
    books: edge.nBooks ?? 0,
  };
}

/**
 * Sort by conviction and tag each row with its 1-based rank.
 *
 * `topCount` marks how many rows sit in the highest tier present, so the UI can
 * separate "take these" from "and here is the rest of the board" without
 * inventing a threshold of its own.
 */
export function byConviction(rows) {
  const ordered = [...rows].sort((a, b) => {
    const x = convictionScore(a);
    const y = convictionScore(b);
    if (y.tier !== x.tier) return y.tier - x.tier;
    if (y.stake !== x.stake) return y.stake - x.stake;
    return y.books - x.books;
  });
  const topTier = ordered.length ? convictionScore(ordered[0]).tier : -1;
  const topCount =
    topTier <= 0 ? 0 : ordered.filter((r) => convictionScore(r).tier === topTier).length;
  return { ordered, topCount, topTier };
}
