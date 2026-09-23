import { Fragment, useEffect, useState } from "react";

import { fmt } from "../lib/format.js";
import { matchesQuery } from "./rows.js";
import { explainEmpty, rowLineupSource } from "./filters.js";
import VerdictChip, { WhyNote } from "./VerdictChip.jsx";
import VenueLinks, { VenueLegend } from "./VenueLinks.jsx";
import MakerPanel, { useKalshiBooks } from "./MakerPanel.jsx";
import PitcherCard from "./PitcherCard.jsx";
import BatterCard from "./BatterCard.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

/**
 * The shared prop board (minified: `Wa`) — used for both the PITCHERS and the
 * BATTERS tab; `kind` only changes the first column header and which detail
 * card the expanded row renders.
 *
 * Local UI state only: market filter chip, sort key, which row is expanded and
 * the "Lines only" toggle (on by default — rows without a book line are
 * projections, not bets).
 *
 * The VENUES column lists every venue quoting the row's line — not just the
 * best — so the row itself is enough to line shop from. In maker mode the same
 * column shows Kalshi's live book instead of a price to cross.
 *
 * Below 720px the table is replaced by stacked `PropCard`s — fifteen columns
 * cannot be read on a phone without panning sideways.
 */
/**
 * True while the viewport is narrow enough that fifteen columns cannot be read
 * without panning. The same 720px breakpoint the stylesheet uses.
 *
 * The table and the stacked cards are alternatives, not a CSS toggle over two
 * copies of the same rows: only one of them is ever in the DOM.
 */
const NARROW = "(max-width: 720px)";

function useIsNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * One row as a card, for phone widths.
 *
 * The play and its number are the headline — everything the table spreads over
 * fifteen columns is stacked here in reading order, so nothing needs panning.
 */
function PropCard({ row, kind, isOpen, onToggle, slip, toggleSlip, priceMode, books }) {
  const edge = row.edge;
  // Both percentages are shown from the perspective of the side being called,
  // so they are directly comparable — same rule as the table.
  const modelPct = edge ? (edge.side === "over" ? edge.modelOver : 1 - edge.modelOver) : null;
  const bookPct =
    edge && edge.fairOver != null
      ? edge.side === "over"
        ? edge.fairOver
        : 1 - edge.fairOver
      : null;
  const side = edge ? (edge.side === "over" ? "OVER" : "UNDER") : null;
  const proj =
    row.market === "batter_home_runs" || row.market === "batter_stolen_bases"
      ? fmt.n2(row.proj)
      : fmt.n1(row.proj);

  return (
    <div className={`card propcard ${edge?.verdict === "STRONG" ? "strong" : ""}`}>
      <div className="card-top">
        <div>
          <div className="card-title">{row.name}</div>
          <div className="card-sub">
            {row.matchup}
            {" · "}
            {fmt.time(row.gameDate)}
            {" · vs "}
            {row.opp}
            {(row.flags || [])
              .filter((f) => !f.startsWith("PLATOON"))
              .map((f) => (
                <span className="flag" key={f}>
                  {f}
                </span>
              ))}
          </div>
        </div>
        <div className="vwrap">
          <VerdictChip edge={edge} />
          <WhyNote edge={edge} />
        </div>
      </div>

      <div className="propplay">
        {row.label}
        {row.line != null ? (
          <>
            {side ? ` ${side}` : ""} {row.line}
          </>
        ) : (
          <span className="dim"> — no line</span>
        )}
        {row.alt && <span className="book altb">ALT</span>}
        {row.book && <span className="book">{row.book}</span>}
      </div>

      <div className="card-nums">
        <div className="stat">
          <span className="v">{proj}</span>
          <span className="l">Model proj</span>
        </div>
        <div className="stat">
          <span className={`v ${modelPct != null && modelPct > (bookPct ?? 0.5) ? "pos" : ""}`}>
            {modelPct != null ? fmt.pct(modelPct) : "—"}
          </span>
          <span className="l">Model {edge ? edge.side : ""}%</span>
        </div>
        <div className="stat">
          <span className="v">{bookPct != null ? fmt.pct(bookPct) : "—"}</span>
          <span className="l">Book fair%</span>
        </div>
        <div className="stat">
          {/* A PASS never wears green: whatever the EV number says, the engine
              refuses to bet this price, so it renders dim, not `pos`. */}
          <span
            className={`v ${
              !edge ? "" : edge.verdict === "PASS" ? "dim" : edge.ev >= 0 ? "pos" : "neg"
            }`}
            title={edge?.verdict === "PASS" ? "engine passes at this price" : undefined}
          >
            {edge ? fmt.ev(edge.ev) : "—"}
          </span>
          <span className="l">EV @ {fmt.odds(edge?.odds)}</span>
        </div>
      </div>

      <div className="psub propprice">
        {"best O/U "}
        {fmt.odds(row.over)} / {fmt.odds(row.under)}
      </div>

      {row.line != null &&
        (priceMode === "maker" ? (
          <MakerPanel
            row={row}
            entry={books.entries.get(row.key)}
            status={books.status}
            error={books.error}
          />
        ) : (
          <VenueLinks row={row} />
        ))}

      <div className="card-foot">
        <button
          className={`chip propmore ${isOpen ? "on" : ""}`}
          onClick={onToggle}
          aria-expanded={isOpen}
        >
          {isOpen ? "Hide detail" : "Details"}
        </button>
        {edge && edge.verdict !== "PASS" && (
          <button
            className={`addbtn ${slip[row.key] ? "in" : ""}`}
            onClick={() => toggleSlip(row)}
          >
            {slip[row.key] ? "✓ In slip" : "+ Add to slip"}
          </button>
        )}
      </div>

      {isOpen && (
        <div className="propdetail">
          {/* Boundaried: a detail panel that cannot render must not take the
              board with it. See ErrorBoundary.jsx. */}
          <ErrorBoundary label={row.name}>
            {kind === "pitcher" ? (
              <PitcherCard p={row.detailRef} />
            ) : (
              <BatterCard b={row.detailRef} />
            )}
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}

export default function PropTable({
  rows,
  // The same board with no criteria applied — only used to explain an empty
  // result. Defaults to `rows` so the component still works uncontrolled.
  unfilteredRows = rows,
  criteria,
  query,
  markets,
  kind,
  slip,
  toggleSlip,
  priceMode = "taker",
}) {
  const [market, setMarket] = useState("ALL");
  const [sort, setSort] = useState("ev");
  const [expanded, setExpanded] = useState(null);
  // On by default — except when nothing on the slate has a line at all (the
  // odds feed is down), where it would open every prop board on an empty table.
  const [linesOnly, setLinesOnly] = useState(() => unfilteredRows.some((r) => r.line != null));
  const narrow = useIsNarrow();

  const visible = rows
    .filter((r) => market === "ALL" || r.market === market)
    .filter((r) => !linesOnly || r.line != null)
    .filter((r) => matchesQuery(r, query))
    .sort((a, b) => {
      // Rows with no edge sort to the bottom of the EV order via the -99 floor.
      return sort === "ev"
        ? (b.edge?.ev ?? -99) - (a.edge?.ev ?? -99)
        : sort === "proj"
          ? (b.proj ?? 0) - (a.proj ?? 0)
          : sort === "time"
            ? new Date(a.gameDate) - new Date(b.gameDate)
            : sort === "name"
              ? a.name.localeCompare(b.name)
              : 0;
    });

  // Kalshi books are only fetched while maker mode is on, and only for the
  // rows actually on screen.
  const books = useKalshiBooks(visible, priceMode === "maker");

  // Chip counts respect the "Lines only" toggle but not the market filter.
  const counts = {
    ALL: rows.filter((r) => !linesOnly || r.line != null).length,
  };
  for (const key of Object.keys(markets))
    counts[key] = rows.filter(
      (r) => r.market === key && (!linesOnly || r.line != null),
    ).length;

  // Why is the table blank? Blame the criteria filter only when it is actually
  // responsible — i.e. it removed every row before this component's own market
  // chip / "Lines only" / search narrowed anything further.
  const criteriaCut = rows.length === 0 ? explainEmpty(unfilteredRows, criteria) : null;

  // A search that matches nobody is usually not a filter problem: the board
  // only carries the nine hitters in each card, so a player whose team has not
  // posted yet is simply absent. "Nothing matches" made that look like a broken
  // search, which is exactly how it was reported.
  const projectedTeams =
    kind === "batter"
      ? new Set(
          unfilteredRows
            .filter((r) => {
              const src = rowLineupSource(r);
              return src && src !== "confirmed";
            })
            .map((r) => r.team),
        ).size
      : 0;
  const searchFoundNothing = query && rows.length > 0 && visible.length === 0;
  const emptyState =
    criteriaCut ||
    (searchFoundNothing
      ? {
          headline: `No ${kind === "batter" ? "batter" : "pitcher"} matches “${query}”.`,
          detail:
            kind === "batter" && projectedTeams > 0
              ? `The board carries the nine hitters in each card, and ${projectedTeams} of today's lineups are still PROJECTED rather than posted — a hitter who did not start his team's last game will not appear until the real card drops. Only about three quarters of a posted nine start again the next day, so check back closer to first pitch.`
              : "Check the spelling, or clear the other filters — the market chips and “Lines only” narrow this table too.",
        }
      : {
          headline: "Nothing matches.",
          detail: linesOnly
            ? 'No book lines in this view yet — toggle "Lines only" off to see raw projections.'
            : "Adjust filters or search.",
        });

  return (
    <>
      <div className="toolbar">
        <div className="chips">
          <button
            className={`chip ${market === "ALL" ? "on" : ""}`}
            onClick={() => setMarket("ALL")}
          >
            ALL ({counts.ALL})
          </button>
          {Object.entries(markets).map(([key, def]) => (
            <button
              className={`chip ${market === key ? "on" : ""}`}
              onClick={() => setMarket(key)}
              key={key}
            >
              {def.short} ({counts[key]})
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort"
        >
          <option value="ev">Sort: Best EV</option>
          <option value="proj">Sort: Projection</option>
          <option value="time">Sort: Game time</option>
          <option value="name">Sort: Name</option>
        </select>
        <button
          className={`chip ${linesOnly ? "on" : ""}`}
          onClick={() => setLinesOnly((v) => !v)}
        >
          Lines only
        </button>
      </div>

      {/* Phone: stacked cards, one per row, in reading order. */}
      {narrow ? (
        visible.length === 0 ? (
          <div className="notice">
            <b>{emptyState.headline}</b>
            <div className="sub">{emptyState.detail}</div>
          </div>
        ) : (
          <div className="propcards">
            {visible.map((row) => (
              <PropCard
                key={row.key}
                row={row}
                kind={kind}
                isOpen={expanded === row.key}
                onToggle={() => setExpanded(expanded === row.key ? null : row.key)}
                slip={slip}
                toggleSlip={toggleSlip}
                priceMode={priceMode}
                books={books}
              />
            ))}
          </div>
        )
      ) : (
        <div className="tblwrap">
            <table>
            <thead>
              <tr>
                <th>{kind === "pitcher" ? "Pitcher" : "Batter"}</th>
                <th>Matchup</th>
                <th>Prop</th>
                <th className="num">Line</th>
                <th className="num">Proj</th>
                <th className="num">Model %</th>
                <th className="num">Book %</th>
                <th className="num">Best O/U</th>
                <th className="num">EV</th>
                <th>Call</th>
                <th>{priceMode === "maker" ? "Kalshi book" : "Venues"}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={12}>
                    <div className="notice">
                      <b>{emptyState.headline}</b>
                      <div className="sub">{emptyState.detail}</div>
                    </div>
                  </td>
                </tr>
              )}
              {visible.map((row) => {
                const edge = row.edge;
                const isOpen = expanded === row.key;
                // Both percentages are shown from the perspective of the side
                // being called, so they are directly comparable.
                const modelPct = edge
                  ? edge.side === "over"
                    ? edge.modelOver
                    : 1 - edge.modelOver
                  : null;
                const bookPct =
                  edge && edge.fairOver != null
                    ? edge.side === "over"
                      ? edge.fairOver
                      : 1 - edge.fairOver
                    : null;

                return (
                  <Fragment key={row.key}>
                    <tr
                      className="rowbtn"
                      onClick={() => setExpanded(isOpen ? null : row.key)}
                    >
                      <td>
                        <div className="pname">{row.name}</div>
                        <div className="psub">
                          {row.sub}
                          {(row.flags || [])
                            .filter((f) => !f.startsWith("PLATOON"))
                            .map((f) => (
                              <span className="flag" key={f}>
                                {f}
                              </span>
                            ))}
                        </div>
                      </td>
                      <td>
                        <div>{row.matchup}</div>
                        <div className="psub">
                          {fmt.time(row.gameDate)} · vs {row.opp}
                        </div>
                      </td>
                      <td className="mkt">{row.label}</td>
                      <td className="num">
                        {row.line != null ? (
                          row.line
                        ) : (
                          <span className="dim">—</span>
                        )}
                        {row.alt && <span className="book altb">ALT</span>}
                        {row.book && <span className="book">{row.book}</span>}
                      </td>
                      <td className="num">
                        <b>
                          {row.market === "batter_home_runs" ||
                          row.market === "batter_stolen_bases"
                            ? fmt.n2(row.proj)
                            : fmt.n1(row.proj)}
                        </b>
                      </td>
                      <td className="num">
                        {modelPct != null ? (
                          <span
                            className={modelPct > (bookPct ?? 0.5) ? "pos" : ""}
                          >
                            {fmt.pct(modelPct)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num">
                        {bookPct != null ? fmt.pct(bookPct) : "—"}
                      </td>
                      <td className="num dim">
                        {fmt.odds(row.over)} / {fmt.odds(row.under)}
                      </td>
                      <td className="num">
                        {edge ? (
                          // A PASS never wears green — the engine refuses this
                          // price, so its EV renders dim whatever the sign.
                          <span
                            className={
                              edge.verdict === "PASS"
                                ? "dim"
                                : edge.ev >= 0
                                  ? "pos"
                                  : "neg"
                            }
                            title={
                              edge.verdict === "PASS"
                                ? "engine passes at this price"
                                : undefined
                            }
                          >
                            {fmt.ev(edge.ev)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <VerdictChip edge={edge} />
                        <WhyNote edge={edge} />
                      </td>
                      <td className="venuecell">
                        {row.line == null ? (
                          <span className="dim">—</span>
                        ) : priceMode === "maker" ? (
                          <MakerPanel
                            row={row}
                            entry={books.entries.get(row.key)}
                            status={books.status}
                            error={books.error}
                            compact
                          />
                        ) : (
                          <VenueLinks row={row} compact />
                        )}
                      </td>
                      <td>
                        {edge && edge.verdict !== "PASS" && (
                          <button
                            className={`addbtn ${slip[row.key] ? "in" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSlip(row);
                            }}
                          >
                            {slip[row.key] ? "✓" : "+"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="detail">
                        <td colSpan={12}>
                          {kind === "pitcher" ? (
                            <PitcherCard p={row.detailRef} />
                          ) : (
                            <BatterCard b={row.detailRef} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              </tbody>
            </table>
        </div>
      )}

      {/* ONE degree-mark legend per board, instead of a note per card. */}
      {priceMode !== "maker" && <VenueLegend rows={visible} />}
    </>
  );
}
