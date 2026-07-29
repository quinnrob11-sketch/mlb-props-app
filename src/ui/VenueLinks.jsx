// Venue click-through: every venue quoting a row's line, as chips you can open.
//
// The row hands us `venues` — one entry per venue at this exact line — and the
// only interesting design question is HONESTY, because the entries are not
// equivalent:
//
//   * `exact: true`  — the link lands on this side of this line. Say nothing.
//   * `exact: false` — the link lands on something coarser. The chip states
//     what you actually get ("game page", "market page", "home page") and a
//     note under the chips spells it out in words.
//   * novig — a real exchange price with no web product at all. The price is
//     shown because it is worth seeing; the chip is a span, not an anchor, and
//     reads "app only". A dead <a> is never rendered.
//
// Every venue at the line is listed, not just the winner, because that is what
// makes line shopping possible from the row itself.

import { fmt } from "../lib/format.js";

/** Price on the side the offer was resolved for. DFS entries have none. */
function priceOf(offer) {
  const price = offer?.side === "under" ? offer.under : offer.over;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

/**
 * What a non-exact link actually opens, in the user's words.
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

/** Agree the note's leading verb with more than one venue: "DK, FD open…". */
function plural(sentence) {
  return sentence.replace(
    /^(opens|is|has)\b/,
    (verb) => ({ opens: "open", is: "are", has: "have" })[verb],
  );
}

/** The one-word reason a venue cannot be clicked. Only novig has one today. */
function deadReason(offer) {
  if (offer?.link) return null;
  return offer?.key === "novig" ? "app only" : "no link";
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

/**
 * @param {object} props
 * @param {object} props.row - A row from `flattenRows`.
 * @param {boolean} [props.compact] - Table density: notes render at 10px and
 *   the "best price" wording is dropped.
 */
export default function VenueLinks({ row, compact = false }) {
  const offers = ordered(row);
  if (!offers.length)
    return <span className="dim">{compact ? "—" : "No venue link on this line."}</span>;

  const bestKey = row?.venue?.key ?? null;

  // One note per distinct wording, listing the venues it applies to, so three
  // coarse links cost one line rather than three.
  const notes = new Map();
  for (const offer of offers) {
    const dead = deadReason(offer);
    const note = inexactNote(offer);
    const sentence = dead
      ? offer.key === "novig"
        ? "is app-only — the price is real, there is no web page to open"
        : "has no link"
      : note?.sentence;
    if (!sentence) continue;
    if (!notes.has(sentence)) notes.set(sentence, []);
    notes.get(sentence).push(offer.short || offer.key);
  }

  return (
    <div className="venues">
      <div className="venuechips">
        {offers.map((offer) => {
          const dead = deadReason(offer);
          const note = inexactNote(offer);
          const tag = dead || note?.tag || null;
          const body = (
            <>
              {offer.short || offer.key} {chipValue(offer)}
              {tag && <i className="tag">{tag}</i>}
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
                title={`${offer.label} ${chipValue(offer)} — ${
                  offer.key === "novig"
                    ? "mobile app only, there is no web page to open."
                    : "no link available."
                }`}
              >
                {body}
              </span>
            );

          return (
            <a
              key={offer.key}
              className={cls}
              href={offer.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={
                offer.exact
                  ? `Opens ${offer.label} at this exact bet.`
                  : `${offer.label} ${note.sentence}. Not a link to this exact bet.`
              }
            >
              {body}
            </a>
          );
        })}
      </div>
      {[...notes.entries()].map(([sentence, shorts]) => (
        <div className="vnote" key={sentence}>
          {shorts.join(", ")} {shorts.length > 1 ? plural(sentence) : sentence}.
        </div>
      ))}
    </div>
  );
}
