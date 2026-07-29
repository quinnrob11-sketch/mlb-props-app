// DFS board — one scannable unit per play, ranked by how far the softest DFS
// line sits from the model.
//
// The rule this board is built to: the front of a card holds the bet in plain
// words, the three lines side by side with the softest one obvious, and one
// phrase saying why it is the softest. Everything else — distribution, vig,
// Kelly, book prices, the venue links — lives behind "Details" and is not on
// screen while scanning.
//
// All selection logic is in `./dfsRows.js` (pure, tested); this file is layout.

import { useState } from "react";

import { fmt } from "../lib/format.js";
import { matchesQuery } from "./rows.js";
import { explainEmpty } from "./filters.js";
import { DFS_SITES, buildDfsBoard, dfsCoverageCount, fmtLine } from "./dfsRows.js";
import { verdictClass } from "./VerdictChip.jsx";
import DistributionChart from "./DistributionChart.jsx";
import VenueLinks from "./VenueLinks.jsx";

/** Signed cushion, e.g. "+0.9 vs model" / "−0.3 vs model". */
function cushionText(cushion) {
  if (cushion == null) return "no projection";
  const sign = cushion >= 0 ? "+" : "−";
  return `${sign}${fmt.n1(Math.abs(cushion))} vs model`;
}

/** One site badge. The softest is loud; the rest are dimmed. */
function SiteBadge({ site }) {
  const cls = `dfssite ${site.best ? "best" : "off"}`;
  const body = (
    <>
      <b>{site.short}</b> {fmtLine(site.line)}
    </>
  );
  // Only the softest site is clickable: it is the one you would actually take,
  // and a link is only ever labelled with what it really opens.
  if (!site.best || !site.link) return <span className={cls}>{body}</span>;
  return (
    <a
      className={cls}
      href={site.link}
      target="_blank"
      rel="noopener noreferrer"
      title={
        site.exact
          ? `Opens ${site.label} at this exact pick.`
          : `Opens the ${site.label} home page, search for the player. Not a link to this exact pick.`
      }
    >
      {body}
      <i className="tag">↗</i>
    </a>
  );
}

export default function DfsBoard({
  rows,
  // The same board with no criteria applied, so an empty result can name the
  // filter responsible instead of shrugging.
  unfilteredRows = rows,
  criteria,
  query,
}) {
  const [open, setOpen] = useState(null);

  const plays = buildDfsBoard(rows.filter((row) => matchesQuery(row, query)));

  if (!plays.length) {
    const cut = rows.length === 0 ? explainEmpty(unfilteredRows, criteria) : null;
    if (cut)
      return (
        <div className="notice">
          <b>{cut.headline}</b>
          <div className="sub">{cut.detail}</div>
        </div>
      );
    const covered = dfsCoverageCount(unfilteredRows);
    return (
      <div className="notice">
        <b>Nothing on the DFS board.</b>
        <div className="sub">
          {covered === 0
            ? "PrizePicks, Pick6 and Betr are not posting any prop the sportsbooks are pricing on this slate. A prop no DFS site carries is not a DFS play, so it is left off rather than shown as one."
            : "No called play has DFS coverage right now — clear the search box or loosen your filters."}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="dfshead">
        Line shopping across {DFS_SITES.map((s) => s.label).join(" · ")} —{" "}
        {plays.length} play{plays.length === 1 ? "" : "s"}, softest line
        highlighted, biggest gap to the model first.
        {plays.some((p) => p.best.link && !p.best.exact) && (
          <>
            {" "}
            Tapping a highlighted line opens that app's own board, not the exact
            pick — search the player there.
          </>
        )}
      </div>

      <div className="cards dfsboard">
        {plays.map((play) => {
          const row = play.row;
          const edge = row.edge;
          const isOpen = open === play.key;

          return (
            <div
              key={play.key}
              className={`card dfscard ${edge?.verdict === "STRONG" ? "strong" : ""}`}
            >
              <div className="dfstop">
                <div className="dfsplay">{play.play}</div>
                <span className={`vchip ${verdictClass(edge?.verdict, play.side)}`}>
                  {cushionText(play.cushion)}
                </span>
              </div>

              <div className="card-sub">
                {row.matchup} · {fmt.time(row.gameDate)}
                {play.coverage === "single" && (
                  <span className="flag">1 SITE ONLY</span>
                )}
              </div>

              <div className="dfssites">
                {play.sites.map((site) => (
                  <SiteBadge key={site.key} site={site} />
                ))}
              </div>

              <div className="dfswhy">
                {play.why}
                {play.multiplier != null && (
                  <span className="dim">
                    {" · "}
                    {play.multiplier}× payout <i>indicative</i>
                  </span>
                )}
              </div>

              <button
                className={`chip dfsmore ${isOpen ? "on" : ""}`}
                onClick={() => setOpen(isOpen ? null : play.key)}
                aria-expanded={isOpen}
              >
                {isOpen ? "Hide detail" : "Details"}
              </button>

              {isOpen && (
                <div className="dfsdetail">
                  <div className="card-nums">
                    <div className="stat">
                      <span className="v">{fmt.n1(row.proj)}</span>
                      <span className="l">Model proj</span>
                    </div>
                    <div className="stat">
                      <span className="v">
                        {fmt.pct(
                          edge
                            ? play.side === "over"
                              ? edge.modelOver
                              : 1 - edge.modelOver
                            : null,
                        )}
                      </span>
                      <span className="l">Model {play.side}%</span>
                    </div>
                    <div className="stat">
                      <span className="v">
                        {fmt.pct(
                          edge && edge.fairOver != null
                            ? play.side === "over"
                              ? edge.fairOver
                              : 1 - edge.fairOver
                            : null,
                        )}
                      </span>
                      <span className="l">Book fair%</span>
                    </div>
                    <div className="stat">
                      <span className={`v ${(edge?.ev ?? 0) >= 0 ? "pos" : "neg"}`}>
                        {fmt.ev(edge?.ev)}
                      </span>
                      <span className="l">EV @ {fmt.odds(edge?.odds)}</span>
                    </div>
                  </div>

                  <DistributionChart
                    distFn={row.detailRef?.proj?.dist?.[row.distKey]}
                    line={play.line}
                    market={row.market}
                    side={play.side}
                  />

                  <div className="psub dfsfoot">
                    Book line {row.line} at {row.book || "—"}
                    {edge?.vig != null && ` · vig ${fmt.pct(edge.vig)}`}
                    {edge?.kelly > 0 && ` · ¼-Kelly ${(edge.kelly * 100).toFixed(1)}% of bankroll`}
                    {". "}
                    The DFS number above is a line plus a payout multiplier, not
                    a two-sided price — it is never ranked against these odds.
                  </div>

                  <VenueLinks row={row} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
