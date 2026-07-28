// BEST BETS board (minified: `uh`) — one card per callable edge, sorted by EV.
//
// Callers pass rows that already carry an `edge` (App filters PASS verdicts out
// before rendering); the card reads `row.edge` unguarded.

import { fmt } from '../lib/format.js';
import { matchesQuery } from './rows.js';
import { explainEmpty } from './filters.js';
import VerdictChip from './VerdictChip.jsx';
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
}) {
  const sorted = rows
    .filter((row) => matchesQuery(row, query))
    // Rows without an edge sort to the bottom via the -99 sentinel.
    .sort((a, b) => (b.edge?.ev ?? -99) - (a.edge?.ev ?? -99));

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
    <div className="cards">
      {sorted.map((row) => {
        const edge = row.edge;
        const inSlip = !!slip[row.key];

        return (
          <div key={row.key} className={`card ${edge.verdict === 'STRONG' ? 'strong' : ''}`}>
            <div className="card-top">
              <div>
                <div className="card-title">
                  {row.name}
                  {' — '}
                  {row.label} {edge.side === 'over' ? 'OVER' : 'UNDER'} {row.line}
                  {row.alt && <span className="book altb">ALT</span>}
                </div>
                <div className="card-sub">
                  {row.matchup}
                  {' · '}
                  {fmt.time(row.gameDate)}
                  {' · vs '}
                  {row.opp}
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
              <VerdictChip edge={edge} />
            </div>

            <div className="card-nums">
              <div className="stat">
                <span className="v">{fmt.n1(row.proj)}</span>
                <span className="l">Model proj</span>
              </div>
              <div className="stat">
                <span className="v">
                  {fmt.pct(edge.side === 'over' ? edge.modelOver : 1 - edge.modelOver)}
                </span>
                <span className="l">Model {edge.side}%</span>
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
                <span className="l">Consensus fair%</span>
              </div>
              <div className="stat">
                <span className={`v ${edge.ev >= 0 ? 'pos' : 'neg'}`}>{fmt.ev(edge.ev)}</span>
                <span className="l">EV @ {fmt.odds(edge.odds)}</span>
              </div>
            </div>

            <DistributionChart
              distFn={row.detailRef?.proj?.dist?.[row.distKey]}
              line={row.line}
              market={row.market}
              side={edge.side}
            />

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
        );
      })}
    </div>
  );
}
