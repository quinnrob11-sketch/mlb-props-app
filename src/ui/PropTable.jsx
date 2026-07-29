import { Fragment, useState } from "react";

import { fmt } from "../lib/format.js";
import { matchesQuery } from "./rows.js";
import { explainEmpty } from "./filters.js";
import VerdictChip from "./VerdictChip.jsx";
import VenueLinks from "./VenueLinks.jsx";
import MakerPanel, { useKalshiBooks } from "./MakerPanel.jsx";
import PitcherCard from "./PitcherCard.jsx";
import BatterCard from "./BatterCard.jsx";

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
 */
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
  const [linesOnly, setLinesOnly] = useState(true);

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
  const emptyState = criteriaCut || {
    headline: "Nothing matches.",
    detail: linesOnly
      ? 'No book lines in this view yet — toggle "Lines only" off to see raw projections.'
      : "Adjust filters or search.",
  };

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
                        <span className={edge.ev >= 0 ? "pos" : "neg"}>
                          {fmt.ev(edge.ev)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <VerdictChip edge={edge} />
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
    </>
  );
}
