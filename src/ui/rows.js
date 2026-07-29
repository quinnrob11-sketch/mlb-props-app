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
