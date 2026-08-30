// DFS board — one scannable unit per play, ranked by the margin between the
// model's probability of the played side and the entry format's per-leg
// breakeven.
//
// A DFS entry pays line × multiplier — the sportsbook price is not what you
// take, so book EV is the wrong headline here. The front of a card holds the
// bet in plain words, the model's side% at the softest line (with the book's
// fair% at that line as a reality anchor when one exists), whether it clears
// the selected format's breakeven, the three lines side by side with the
// softest one obvious, and one phrase saying why it is the softest. The
// sportsbook view — book price, book EV, vig, Kelly — lives behind "Details".
//
// All selection logic is in `./dfsRows.js` (pure, tested); this file is layout.

import { useState } from "react";

import { fmt } from "../lib/format.js";
import { matchesQuery } from "./rows.js";
import { explainEmpty } from "./filters.js";
import {
  DFS_FORMATS,
  DFS_SITES,
  breakevenProb,
  buildDfsBoard,
  dfsCoverageCount,
  fmtLine,
  loadDfsFormat,
  saveDfsFormat,
} from "./dfsRows.js";
import DistributionChart from "./DistributionChart.jsx";
import VenueLinks, { VenueLegend } from "./VenueLinks.jsx";
import { TrackChip } from "./VerdictChip.jsx";

/** The multipliers are assumptions the user can switch, not gospel. */
const FORMAT_TITLE = "payout formats change — check the app";

/** Signed cushion, e.g. "+0.9 vs model" / "−0.3 vs model". */
function cushionText(cushion) {
  if (cushion == null) return "no projection";
  const sign = cushion >= 0 ? "+" : "−";
  return `${sign}${fmt.n1(Math.abs(cushion))} vs model`;
}

/** One site badge. The softest is loud; the rest are dimmed. No tag clutter. */
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
  const [formatKey, setFormatKey] = useState(loadDfsFormat);

  const breakeven = breakevenProb(formatKey);
  const bePct = `${(breakeven * 100).toFixed(1)}%`;

  const plays = buildDfsBoard(
    rows.filter((row) => matchesQuery(row, query)),
    { breakeven },
  );

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
      {/* The `.wide-only` prose is dropped below 720px: on a phone this
          preamble is chrome standing between the user and the first play. The
          breakeven selector stays — it is a control, not prose. */}
      <div className="dfshead dfsbar">
        <span>
          <span className="wide-only">
            Line shopping across {DFS_SITES.map((s) => s.label).join(" · ")} —{" "}
            {plays.length} play{plays.length === 1 ? "" : "s"}, softest line
            highlighted, biggest margin over the {bePct} per-leg breakeven
            first.
          </span>
          <span className="narrow-only">{plays.length} plays</span>
        </span>
        <select
          className="dfsformat"
          value={formatKey}
          onChange={(e) => setFormatKey(saveDfsFormat(e.target.value))}
          aria-label="DFS entry format — sets the per-leg breakeven"
          title={FORMAT_TITLE}
        >
          {DFS_FORMATS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="cards dfsboard">
        {plays.map((play) => {
          const row = play.row;
          const edge = row.edge;
          const isOpen = open === play.key;
          const clears = play.modelProb != null && play.modelProb > breakeven;

          return (
            <div
              key={play.key}
              className={`card dfscard ${edge?.verdict === "STRONG" ? "strong" : ""}`}
            >
              <div className="dfstop">
                <div className="dfsplay">{play.play}</div>
                <div
                  className="dfsstat"
                  title={`Model probability of the ${play.side} at the softest DFS line (${fmtLine(play.line)})`}
                >
                  <span
                    className={`v ${play.modelProb == null ? "dim" : clears ? "pos" : "neg"}`}
                  >
                    {fmt.pct(play.modelProb)}
                  </span>
                  <span className="l">model {play.side}%</span>
                  <span className="l">
                    {play.bookProb != null
                      ? `book fair ${fmt.pct(play.bookProb)}`
                      : "no book anchor"}
                  </span>
                </div>
              </div>

              <div className="card-sub">
                {row.matchup} · {fmt.time(row.gameDate)}
                <TrackChip market={row.market} line={play.line} />
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
                <span
                  className={
                    play.modelProb == null ? "dim" : clears ? "pos" : "neg"
                  }
                  title={FORMAT_TITLE}
                >
                  {play.modelProb == null
                    ? "no model probability at this line"
                    : clears
                      ? `clears ${bePct} breakeven`
                      : "below breakeven"}
                </span>
                {" · "}
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
                  <div className="psub dfssbv">
                    Sportsbook view — the book's price and EV, not what a DFS
                    entry pays.
                  </div>
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
                      <span
                        className={`v ${
                          edge?.verdict === "PASS"
                            ? "dim"
                            : (edge?.ev ?? 0) >= 0
                              ? "pos"
                              : "neg"
                        }`}
                        title={
                          edge?.verdict === "PASS"
                            ? "engine passes at this price"
                            : undefined
                        }
                      >
                        {fmt.ev(edge?.ev)}
                      </span>
                      <span className="l">Book EV @ {fmt.odds(edge?.odds)}</span>
                    </div>
                  </div>

                  <DistributionChart
                    proj={row.proj}
                    distFn={row.detailRef?.proj?.dist?.[row.distKey]}
                    line={play.line}
                    market={row.market}
                    side={play.side}
                  />

                  <div className="psub dfsfoot">
                    Book line {row.line} at {row.book || "—"} ·{" "}
                    {cushionText(play.cushion)}
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

      <VenueLegend rows={plays.map((p) => p.row)} />
    </>
  );
}
