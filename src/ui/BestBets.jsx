// BEST BETS board (minified: `uh`) — one card per callable edge, sorted by EV.
//
// Callers pass rows that already carry an `edge` (App filters PASS verdicts out
// before rendering); the card reads `row.edge` unguarded.

import { Fragment } from 'react';
import { fmt } from '../lib/format.js';
import { matchesQuery, byConviction, pickText } from './rows.js';
import { explainEmpty } from './filters.js';
import VerdictChip, { WhyNote, TrackChip } from './VerdictChip.jsx';
import { trackRank } from '../model/trackRecord.js';
import VenueLinks, { VenueLegend } from './VenueLinks.jsx';
import MakerPanel, { useKalshiBooks } from './MakerPanel.jsx';
import DistributionChart from './DistributionChart.jsx';

export default function BestBets({
  rows,
  // The same board with no criteria applied, so an empty result can name the
  // filters responsible rather than shrugging.
  unfilteredRows = rows,
  criteria,
  query,
  slip,
  toggleSlip,
  bankroll,
  priceMode = 'taker',
}) {
  // Ordered by CONVICTION, not raw EV — verdict tier first, then quarter-Kelly
  // stake, then book agreement. See `byConviction` in rows.js for why EV alone
  // was the wrong key. `topCount` is how many plays share the best tier on the
  // board, so the divider below is drawn from the data rather than a guess.
  // Split by TRACK RECORD before ordering: markets where the replay measured
  // no model edge at all ('none' tier) never mix with the playable board —
  // they render below their own divider, for information only.
  const matched = rows.filter((row) => matchesQuery(row, query));
  const playable = matched.filter((row) => trackRank(row.market, row.line) > 0);
  const noEdge = matched.filter((row) => trackRank(row.market, row.line) === 0);
  const { ordered: playOrdered, topCount, topTier } = byConviction(playable);
  const sorted = [...playOrdered, ...byConviction(noEdge).ordered];
  const noEdgeStart = playOrdered.length;

  // Hook order is fixed: this runs before any of the early returns below.
  const books = useKalshiBooks(sorted, priceMode === 'maker');

  if (!sorted.length) {
    // Criteria first: if they are what emptied the board, say exactly which.
    const cut = rows.length === 0 ? explainEmpty(unfilteredRows, criteria) : null;
    if (cut)
      return (
        <div className="notice">
          <b>{cut.headline}</b>
          <div className="sub">{cut.detail}</div>
        </div>
      );

    if (rows.length > 0)
      return (
        <div className="notice">
          <b>No edge matches “{query}”.</b>
          <div className="sub">
            {rows.length} callable edge{rows.length > 1 ? 's' : ''} pass your filters — clear the
            search box to see them.
          </div>
        </div>
      );

    return (
      <div className="notice">
        <b>No callable edges yet.</b>
        <div className="sub">
          Edges appear when the model's probability beats the devigged book price by enough margin
          (and the sample is trustworthy). Try refreshing after more lines post.
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="trlegend unvalidated top">
      <b>Measured against real prices, this model has no edge on player props.</b> Every settled
      Kalshi contract from 10 Jul to 15 Sep 2026 was replayed with the model's own numbers and
      these rules: 623 pitcher-prop trades returned <b>−4.0%</b> (strikeouts −7.8%) and 609
      batter-prop trades returned <b>−3.4%</b>. In all seven markets the exchange's price
      predicted outcomes <i>better</i> than the model did, and the blend that scored best gave
      the model only 0–25% of the say — less than this board still gives it. See How It Works.
      Treat the plays below as the model's opinion, not as an edge, and check Results before
      risking anything.
    </div>
    {topCount > 0 && (
      <div className="conviction-head">
        <b>Take these first</b>
        <span>
          {topCount} {topTier === 3 ? 'STRONG' : topTier === 2 ? 'SOLID' : 'LEAN'} play
          {topCount > 1 ? 's' : ''} — ordered by ¼-Kelly stake, not raw EV
        </span>
      </div>
    )}
    <div className="cards">
      {sorted.map((row, i) => {
        const edge = row.edge;
        const inSlip = !!slip[row.key];
        // The board is ordered by conviction, so position IS the recommendation.
        // Numbering it makes that explicit instead of leaving the user to infer
        // it from a column of percentages.
        const rank = i + 1;
        const isTop = topCount > 0 && i < topCount;

        return (
          <Fragment key={row.key}>
          {/* First card after the top group gets a full-width rule before it,
              so where conviction drops off is visible rather than inferred. */}
          {topCount > 0 && i === topCount && i < noEdgeStart && (
            <div className="rest-divider">Below this line the engine is less sure</div>
          )}
          {/* The hard floor: markets the replay measured NO model edge in.
              These are never "take" candidates at any rank. */}
          {noEdgeStart > 0 && i === noEdgeStart && (
            <div className="rest-divider noedge">
              ✕ No measured edge in these markets — the market's price is the best
              estimate available. Information only, not bets.
            </div>
          )}
          <div className={`card ${edge.verdict === 'STRONG' ? 'strong' : ''} ${isTop ? 'top-play' : ''}`}>
            <div className="card-top">
              <div>
                <div className="card-title">
                  <span className={`rank ${isTop ? 'rank-top' : ''}`}>{rank}</span>
                  {row.name}
                  {' — '}
                  {pickText(row)}
                  {row.alt && <span className="book altb">ALT</span>}
                </div>
                <div className="card-sub">
                  {row.matchup}
                  {' · '}
                  {fmt.time(row.gameDate)}
                  {row.opp ? ` · vs ${row.opp}` : row.sub ? ` · ${row.sub}` : ''}
                  {row.game?.wx && !row.game.wx.indoor && row.game.wx.tempF != null && (
                    <span>
                      {' · '}
                      {row.game.wx.tempF}
                      °F
                      {/* Only surface wind once it is strong enough to matter. */}
                      {row.game.wx.windMph >= 12 ? ` · ${row.game.wx.windMph}mph wind` : ''}
                    </span>
                  )}
                  {/* Platoon flags are implicit in the projection, so they are
                      not repeated as chips here. */}
                  {(row.flags || [])
                    .filter((flag) => flag !== 'PLATOON+' && flag !== 'PLATOON−')
                    .map((flag) => (
                      <span key={flag} className="flag">
                        {flag}
                      </span>
                    ))}
                </div>
              </div>
              <div className="vwrap">
                <VerdictChip edge={edge} row={row} />
                <TrackChip market={row.market} line={row.line} />
                <WhyNote edge={edge} />
              </div>
            </div>

            <div className="card-nums">
              {row.proj != null && (
                <div className="stat">
                  <span className="v">
                    {row.kind === 'game' && row.market !== 'game_total' && row.proj > 0 ? '+' : ''}
                    {fmt.n1(row.proj)}
                  </span>
                  <span className="l">
                    {row.kind === 'game'
                      ? row.market === 'game_total'
                        ? 'Proj total'
                        : `Proj ${row.game?.home?.abbr || 'home'} margin`
                      : 'Model proj'}
                  </span>
                </div>
              )}
              <div className="stat">
                <span className="v">
                  {fmt.pct(edge.side === 'over' ? edge.modelOver : 1 - edge.modelOver)}
                </span>
                <span className="l">Model chance</span>
              </div>
              <div className="stat">
                <span className="v">
                  {fmt.pct(
                    edge.fairOver != null
                      ? edge.side === 'over'
                        ? edge.fairOver
                        : 1 - edge.fairOver
                      : null,
                  )}
                </span>
                <span className="l">Market chance</span>
              </div>
              <div className="stat">
                {/* A PASS never wears green — the engine refuses this price. */}
                <span
                  className={`v ${
                    edge.verdict === 'PASS' ? 'dim' : edge.ev >= 0 ? 'pos' : 'neg'
                  }`}
                  title={edge.verdict === 'PASS' ? 'engine passes at this price' : undefined}
                >
                  {fmt.ev(edge.ev)}
                </span>
                <span className="l">EV @ {fmt.odds(edge.odds)}</span>
              </div>
            </div>

            <DistributionChart
              proj={row.proj}
              distFn={row.detailRef?.proj?.dist?.[row.distKey]}
              line={row.line}
              market={row.market}
              side={edge.side}
            />

            {priceMode === 'maker' ? (
              <MakerPanel
                row={row}
                entry={books.entries.get(row.key)}
                status={books.status}
                error={books.error}
              />
            ) : (
              <VenueLinks row={row} />
            )}

            <div className="card-foot">
              <span className="psub">
                {'best price '}
                {row.book}
                {(edge.nBooks ?? 0) > 1
                  ? ` · fair from ${edge.nBooks} books${edge.sharp ? ' (PIN-anchored)' : ''}`
                  : ''}
                {/* Kelly is already quarter-sized by the edge model; multiply by
                    the bankroll to get units. */}
                {edge.kelly > 0 ? ` · ¼-Kelly ${(edge.kelly * bankroll).toFixed(1)}u` : ''}
              </span>
              <button className={`addbtn ${inSlip ? 'in' : ''}`} onClick={() => toggleSlip(row)}>
                {inSlip ? '✓ In slip' : '+ Add to slip'}
              </button>
            </div>
          </div>
          </Fragment>
        );
      })}
    </div>
    {/* ONE degree-mark legend per board, instead of a note per card. */}
    {priceMode !== 'maker' && <VenueLegend rows={sorted} />}
    {/* Track-record legend: what the chips mean and where the numbers come
        from, once per board. */}
    <div className="trlegend">
      <b>Track record</b> (replayed vs real games, Aug 3–22: 534 starts, 4,792
      batter-games) — these tiers grade the model against OUTCOMES versus naive
      baselines, not against prices.{' '}
      <span className="tchip t-proven">✓ BEATS BASELINE</span> beat naive
      side-picking at this line. <span className="tchip t-ranked">◆ TOP PICKS
      ONLY</span> only the highest-ranked picks beat the base rate.{' '}
      <span className="tchip t-none">✕ NO EDGE</span> the market already prices
      this right.
    </div>
    </>
  );
}
