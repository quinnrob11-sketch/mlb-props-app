// Venue click-through: every venue quoting a row's line, as chips you can open.
//
// The row hands us `venues` — one entry per venue at this exact line — and the
// only interesting design question is HONESTY, because the entries are not
// equivalent:
//
//   * `exact: true`  — the link lands on this side of this line. The chip is
//     just venue + price: `DK -115`.
//   * `exact: false` — the link lands on something coarser (game page, market
//     page, home page). The chip carries a degree mark — `NVG -104°` — and the
//     full wording lives in the chip's `title` plus ONE legend line per board
//     footer (see `VenueLegend`), instead of a per-card sentence stack.
//   * novig — a real exchange price with no web product at all. The price is
//     shown because it is worth seeing; the chip is a span, not an anchor.
//     A dead <a> is never rendered.
//
// Every venue at the line is listed, not just the winner, because that is what
// makes line shopping possible from the row itself.

import { fmt } from "../lib/format.js";
import { loadLinkPrefs, resolveOfferLink } from "../lib/venues.js";

/** Price on the side the offer was resolved for. DFS entries have none. */
function priceOf(offer) {
  const price = offer?.side === "under" ? offer.under : offer.over;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

/**
 * What a non-exact link actually opens, in the user's words. Title-only now —
 * the chip itself shows a degree mark instead of these words.
 *
 * @param {object} offer
 * @returns {{tag: string, sentence: string}|null} null when the link is exact.
 */
export function inexactNote(offer) {
  if (!offer?.link) return null;
  if (offer.exact) return null;
  switch (offer.granularity) {
    case "event":
      return {
        tag: "game page",
        sentence: "opens the game page, find the player row",
      };
    case "market":
      return {
        tag: "market page",
        sentence: "opens the market page, find your line",
      };
    case "brand":
      return {
        tag: "home page",
        sentence: "opens the site's home page, search for the player",
      };
    default:
      return {
        tag: "not this bet",
        sentence: "does not open this exact bet",
      };
  }
}

/** The one-word reason a venue cannot be clicked. Only novig has one today. */
function deadReason(offer) {
  if (offer?.link) return null;
  return "no link";
}

/** Badge text: price for a two-sided venue, line (+ multiplier) for a DFS app. */
function chipValue(offer) {
  if (offer.kind === "dfs") {
    const mult =
      typeof offer.multiplier === "number" && Number.isFinite(offer.multiplier)
        ? ` ${offer.multiplier}×`
        : "";
    return `${offer.line ?? "—"}${mult}`;
  }
  const price = priceOf(offer);
  return price == null ? "—" : fmt.odds(price);
}

/**
 * Order: the venue behind the called price first, then the other books by
 * price, then exchanges, then DFS apps (whose numbers are not prices at all).
 */
function ordered(row) {
  const kindRank = { book: 0, exchange: 1, dfs: 2 };
  const bestKey = row?.venue?.key ?? null;
  return [...(row?.venues || [])].filter(Boolean).sort((a, b) => {
    if (a.key === bestKey) return -1;
    if (b.key === bestKey) return 1;
    const kr = (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3);
    if (kr) return kr;
    const ap = priceOf(a);
    const bp = priceOf(b);
    if (ap != null && bp != null && ap !== bp) return bp - ap;
    return (a.short || a.key).localeCompare(b.short || b.key);
  });
}

/** Does any row on the board carry a linked-but-not-exact venue chip? */
export function legendApplies(rows) {
  return (rows || []).some((row) =>
    (row?.venues || []).some((v) => v && v.link && v.exact !== true),
  );
}

/**
 * The ONE degree-mark legend a board renders in its footer — the wording every
 * `°` chip on the board defers to instead of repeating it per card.
 */
export function VenueLegend({ rows }) {
  if (!legendApplies(rows)) return null;
  return (
    <div className="vlegend">
      ° opens the venue's page for this game/market — find the bet there
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.row - A row from `flattenRows`.
 * @param {boolean} [props.compact] - Table density (kept for call sites; the
 *   chips are already one line now that the note stack is gone).
 */
export default function VenueLinks({ row, compact = false }) {
  const offers = ordered(row);
  if (!offers.length)
    return <span className="dim">{compact ? "—" : "No venue link on this line."}</span>;

  const bestKey = row?.venue?.key ?? null;
  // User prefs (Novig stake, MGM state) can complete templated outcome links
  // that were unresolvable at parse time — re-resolve each offer at render.
  const prefs = loadLinkPrefs();

  return (
    <div className="venues">
      <div className="venuechips">
        {offers.map((offer) => {
          const resolved = resolveOfferLink(offer, prefs);
          const view = { ...offer, ...resolved };
          const dead = deadReason(view);
          const note = inexactNote(view);
          const body = (
            <>
              {offer.short || offer.key} {chipValue(offer)}
              {/* ↗ = lands on this exact bet; ° = lands on a coarser page */}
              {view.exact ? <span className="golink">↗</span> : note ? "°" : ""}
            </>
          );
          const cls = `vchip v-venue${offer.key === bestKey ? " best" : ""}${
            offer.kind === "dfs" ? " dfs" : ""
          }`;

          if (dead)
            return (
              <span
                key={offer.key}
                className={`${cls} dead`}
                title={`${offer.label} ${chipValue(offer)} — no link available.`}
              >
                {body}
              </span>
            );

          return (
            <a
              key={offer.key}
              className={cls}
              href={view.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={
                view.exact
                  ? offer.key === "novig"
                    ? `Opens ${offer.label} with this bet loaded in the order slip (stake prefilled, nothing placed).`
                    : `Opens ${offer.label} at this exact bet.`
                  : `${offer.label} ${note.sentence}. Not a link to this exact bet.`
              }
            >
              {body}
            </a>
          );
        })}
      </div>
    </div>
  );
}
