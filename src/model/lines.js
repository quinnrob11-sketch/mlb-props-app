/**
 * Turning a raw odds payload into priced rows.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 793-941).
 * Minified origins: `lh` = parseEventOdds, `gl` = bestQuote, `ba` = attachLines.
 *
 * The three stages are:
 *
 *   parseEventOdds  event payload  -> { marketKey: { playerKey: Quote[] } }
 *   bestQuote       Quote[]        -> one consensus point + the best price on
 *                                    each side at that point
 *   attachLines     a player       -> one row per market (main line), plus at
 *                                    most one extra row per market for the best
 *                                    off-consensus point
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS FIXED (see LINES-ANALYSIS.md for the original behaviour)
 *
 * 1. Split-brain main line. The point used to be voted on by the base market
 *    alone while the prices/book/nBooks were re-derived over base ++ alt, so a
 *    single stale base quote outvoted four books agreeing in the alternate
 *    ladder. The point and the prices now come from ONE pool (`bestQuote` over
 *    the deduplicated base ++ alt union), the vote is BOOK-WEIGHTED, and ties
 *    break on an explicit documented chain instead of CORE_BOOKS iteration
 *    order.
 * 2. Double-counted books. Book identity is canonicalised and quotes are
 *    deduplicated by (book, point) across the base+alt union before anything
 *    counts them, so a book present in both feeds counts once - in `nBooks`,
 *    in `evaluateEdge`'s `nBooks`, and in the weighted fair price.
 * 3. No more null-line rows carrying odds. Quotes without a usable point are
 *    dropped before the vote, so they can never win it; a market with nothing
 *    priceable emits a fully empty row (stable row set for the UI) rather than
 *    a row with real prices and no line.
 * 4. Honest provenance. Every row carries `feed` ("base" | "alt" | "both") and
 *    `altMarket`, so an alternate-ladder price presented as the main line is
 *    visible. `alt` now means exactly one thing: "this row is an alternate
 *    LINE, i.e. not the market's consensus point" - which feed it came from is
 *    `feed`'s job, not `alt`'s.
 * 5. Real identity matching. `parseEventOdds` can be handed the roster for the
 *    event; feed names are then resolved against it (tiered, accent/suffix/
 *    `Last, First` tolerant) and filed under the ROSTER's canonical key, with
 *    MLB-id and team hints used to disambiguate. Two players sharing a full
 *    name are quarantined rather than merged, and both the ambiguous and the
 *    unmatched names are exposed on `attachLines`' return value.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  BASE_TO_ALT,
  BOOK_LABEL,
  BOOK_WEIGHT,
  CORE_BOOKS,
  PARSED_BOOKS,
} from "../lib/markets.js";
import {
  matchName,
  normalizeName,
  playerIdKey,
  teamKey,
} from "../lib/names.js";
import { americanToDecimal } from "../lib/odds.js";
import { isDfs, rowVenue, venue as venueInfo, venueKeyByShort } from "../lib/venues.js";
import { MARKET_WEIGHT, evaluateEdge } from "./edges.js";

/** Player key used for team markets, which carry no `description`. */
const GAME_KEY = "__game__";

/** The one market that is a team total rather than a player prop. */
const GAME_MARKET = "totals_1st_1_innings";

/** Provenance tags. A quote is from the base market or the alternate ladder. */
export const FEED_BASE = "base";
export const FEED_ALT = "alt";
/** A (book, point) that both feeds carry. */
export const FEED_BOTH = "both";

/**
 * @typedef {object} Quote
 * @property {string} book - Short book label, e.g. "DK".
 * @property {string} bookId - Canonical (case/space-folded) book identity. This
 *   is what deduplication and every book count key on.
 * @property {number} point - The line this quote is for.
 * @property {number|null} over - American odds on the over, if posted.
 * @property {number|null} under - American odds on the under, if posted.
 * @property {number} w - Consensus weight for `book` (3 for Pinnacle, else 1).
 * @property {string} [market] - Market key the quote was parsed from.
 * @property {string[]} [feeds] - Which feeds supplied this (book, point):
 *   `["base"]`, `["alt"]` or both.
 * @property {string|null} [bookKey] - Odds API bookmaker key, i.e. the venue
 *   identity `lib/venues.js` is keyed by. `book` is only a display badge.
 * @property {boolean} [consensus] - Whether this quote may vote on the market's
 *   line and be counted as a book. False for the exchange/DFS venues in
 *   EXTRA_BOOKS; see the note there.
 * @property {"book"|"exchange"|"dfs"} [kind] - Venue kind.
 * @property {string|null} [overLink] - Outcome-tier deep link for the over.
 * @property {string|null} [overSid] - The feed's outcome id for the over.
 * @property {string|null} [underLink]
 * @property {string|null} [underSid]
 * @property {string|null} [marketLink] - Market-tier link, the first fallback.
 * @property {string|null} [marketSid]
 * @property {string|null} [eventLink] - Event-tier link, the second fallback.
 * @property {number|null} [overMultiplier] - DFS payout multiplier on the over.
 *   DFS venues quote a line and a multiplier INSTEAD of a two-sided price, so
 *   `over`/`under` stay null for them.
 * @property {number|null} [underMultiplier]
 */

// ── low-level quote plumbing ────────────────────────────────────────────────

/**
 * Canonical book identity. Book labels come from BOOK_LABEL so they are already
 * uniform, but a book that reaches us from anywhere else ("dk ", "Dk") must not
 * be able to masquerade as a second book and inflate a consensus count.
 *
 * @param {unknown} book
 * @returns {string}
 */
export function canonicalBookId(book) {
  return String(book ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toUpperCase();
}

/** Numeric point, or null for anything unusable (undefined, null, NaN, ""). */
function usablePoint(point) {
  if (point == null || point === "") return null;
  const n = Number(point);
  return Number.isFinite(n) ? n : null;
}

/** A quote carries information only if at least one side has a price. */
function isPriced(quote) {
  return quote.over != null || quote.under != null;
}

/** Collapse a feed list to a single provenance tag. */
function feedTag(feeds) {
  const hasBase = feeds.includes(FEED_BASE);
  const hasAlt = feeds.includes(FEED_ALT);
  if (hasBase && hasAlt) return FEED_BOTH;
  if (hasBase) return FEED_BASE;
  if (hasAlt) return FEED_ALT;
  return null;
}

/**
 * Deduplicate quotes by canonical (book, point) across however many feeds the
 * caller concatenated.
 *
 * This is the fix for "one book counted twice". A book that posts the same
 * point in both the base market and the alternate ladder produced two entries,
 * which double-weighted it in the consensus fair price, double-voted it in the
 * modal-point tally, and inflated `evaluateEdge`'s `nBooks` past the `< 2`
 * STRONG demotion.
 *
 * Merge rule, deterministic and order-explicit:
 *   - the first occurrence wins for any side that already has a price (feeds
 *     are concatenated base-first, so the base market's price wins);
 *   - a side the winner left null is filled from a later duplicate, so a book
 *     posting only the over in one feed and only the under in the other yields
 *     one genuine two-sided quote;
 *   - `feeds` accumulates every feed that supplied the pair.
 *
 * Link material travels WITH its side: when a duplicate fills in a side the
 * winner left null, that side's deep link, `sid` and DFS multiplier are taken
 * from the same duplicate. Otherwise a row could show the base feed's over link
 * next to the alternate feed's under price.
 *
 * Input quotes are never mutated; copies are returned.
 *
 * @param {Quote[]|null|undefined} quotes
 * @returns {Quote[]} Deduplicated copies, in first-seen order.
 */
export function dedupeQuotes(quotes) {
  const byIdentity = new Map();
  const out = [];

  for (const quote of quotes || []) {
    if (!quote) continue;
    const bookId = canonicalBookId(quote.book);
    const point = usablePoint(quote.point);
    const identity = `${bookId}@${point == null ? "" : point}`;
    const seen = byIdentity.get(identity);
    const feeds = quote.feeds
      ? [...quote.feeds]
      : quote.feed
        ? [quote.feed]
        : [];

    if (!seen) {
      const copy = {
        ...quote,
        book: quote.book ?? null,
        bookKey: quote.bookKey ?? venueKeyByShort(quote.book),
        bookId,
        point,
        over: quote.over ?? null,
        under: quote.under ?? null,
        w: quote.w || 1,
        feeds,
        // Link/multiplier material, normalised so the merge below can test it.
        overLink: quote.overLink ?? null,
        overSid: quote.overSid ?? null,
        underLink: quote.underLink ?? null,
        underSid: quote.underSid ?? null,
        marketLink: quote.marketLink ?? null,
        marketSid: quote.marketSid ?? null,
        eventLink: quote.eventLink ?? null,
        overMultiplier: quote.overMultiplier ?? null,
        underMultiplier: quote.underMultiplier ?? null,
      };
      byIdentity.set(identity, copy);
      out.push(copy);
      continue;
    }

    if (seen.over == null && quote.over != null) {
      seen.over = quote.over;
      seen.overLink = quote.overLink ?? seen.overLink;
      seen.overSid = quote.overSid ?? seen.overSid;
    }
    if (seen.under == null && quote.under != null) {
      seen.under = quote.under;
      seen.underLink = quote.underLink ?? seen.underLink;
      seen.underSid = quote.underSid ?? seen.underSid;
    }
    // A DFS quote has no price to gate on, so its multiplier is merged on its
    // own terms rather than as a passenger of `over`/`under`.
    if (seen.overMultiplier == null && quote.overMultiplier != null) {
      seen.overMultiplier = quote.overMultiplier;
    }
    if (seen.underMultiplier == null && quote.underMultiplier != null) {
      seen.underMultiplier = quote.underMultiplier;
    }
    if (seen.marketLink == null && quote.marketLink != null) {
      seen.marketLink = quote.marketLink;
    }
    if (seen.eventLink == null && quote.eventLink != null) {
      seen.eventLink = quote.eventLink;
    }
    if ((quote.w || 1) > seen.w) seen.w = quote.w || 1;
    for (const feed of feeds) if (!seen.feeds.includes(feed)) seen.feeds.push(feed);
  }

  return out;
}

// ── the odds index and its metadata ─────────────────────────────────────────

/**
 * @typedef {object} OddsIndexMeta
 * @property {Set<string>} playerKeys - Every canonical player key that has
 *   quotes filed under it (the game sentinel excluded).
 * @property {Map<string, string>} byIdentity - `mlb:<id>` -> canonical key, for
 *   the outcomes whose player could be pinned to a roster entry.
 * @property {Map<string, Set<string>>} teamsByKey - canonical key -> team hints.
 * @property {Map<string, {name: string, key: string, candidates: object[]}>} ambiguousKeys
 *   Names the feed priced that could belong to more than one known player.
 *   Their quotes are QUARANTINED - they are not filed under any player.
 * @property {string[]} unresolvedDescriptions - Feed names that matched no
 *   roster entry (only populated when a roster was supplied).
 * @property {number} quarantinedOutcomes - How many outcomes were dropped as
 *   ambiguous.
 */

const META_KEY = "__meta__";
const derivedMeta = new WeakMap();

function emptyMeta() {
  return {
    playerKeys: new Set(),
    byIdentity: new Map(),
    teamsByKey: new Map(),
    ambiguousKeys: new Map(),
    // bucket key -> the identity that owns it, for buckets whose plain name is
    // shared with somebody else on the roster.
    qualifiedKeys: new Map(),
    // plain name key -> everyone on the roster answering to it.
    collisions: new Map(),
    unresolvedDescriptions: [],
    quarantinedOutcomes: 0,
  };
}

/**
 * Attach metadata to an odds index without making it look like a market.
 * Non-enumerable so `Object.keys(index)` still yields market keys only.
 */
function defineMeta(index, meta) {
  Object.defineProperty(index, META_KEY, {
    value: meta,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return index;
}

/**
 * Metadata for an odds index. Indexes built by hand (tests, fixtures) have
 * none, so a minimal one is derived and cached: the player keys are whatever
 * the market maps contain.
 *
 * @param {Record<string, any>} index - `parseEventOdds` output.
 * @returns {OddsIndexMeta}
 */
export function oddsIndexMeta(index) {
  if (!index || typeof index !== "object") return emptyMeta();
  if (index[META_KEY]) return index[META_KEY];
  const cached = derivedMeta.get(index);
  if (cached) return cached;

  const meta = emptyMeta();
  for (const byPlayer of Object.values(index)) {
    if (!byPlayer || typeof byPlayer !== "object") continue;
    for (const key of Object.keys(byPlayer)) {
      if (key !== GAME_KEY) meta.playerKeys.add(key);
    }
  }
  derivedMeta.set(index, meta);
  return meta;
}

/**
 * Which side of the line an outcome is.
 *
 * The five books all say "Over"/"Under"; the DFS apps and exchanges label the
 * same two sides "More"/"Less" or "Yes"/"No" depending on the venue. Anything
 * unrecognised returns null and the outcome is skipped rather than guessed onto
 * a side.
 *
 * @param {unknown} name
 * @returns {"over"|"under"|null}
 */
function outcomeSide(name) {
  switch (String(name ?? "").trim().toLowerCase()) {
    case "over":
    case "more":
    case "yes":
      return "over";
    case "under":
    case "less":
    case "no":
      return "under";
    default:
      return null;
  }
}

/**
 * DFS payout multiplier on an outcome. The upstream has spelled this field more
 * than one way, so all the observed spellings are accepted; anything
 * non-numeric is treated as absent.
 *
 * @param {object} outcome
 * @returns {number|null}
 */
function outcomeMultiplier(outcome) {
  const raw =
    outcome.multiplier ??
    outcome.payout_multiplier ??
    outcome.payoutMultiplier ??
    null;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Roster lookup structure built from the caller's player list. */
function buildRoster(players) {
  const byKey = new Map();
  for (const person of players || []) {
    if (!person) continue;
    const name = person.fullName ?? person.name ?? null;
    const key = normalizeName(name);
    if (!key) continue;
    const entry = {
      id: person.id ?? person.playerId ?? person.mlbId ?? null,
      name,
      key,
      team: teamKey(
        person.team ?? person.teamAbbr ?? person.teamName ?? person.teamId,
      ),
    };
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }
  return { byKey, keys: [...byKey.keys()], size: byKey.size };
}

/** Identity hints an odds feed may (or may not) hang off an outcome. */
function outcomeHints(outcome) {
  const id =
    outcome.player_id ??
    outcome.playerId ??
    outcome.participant_id ??
    outcome.participantId ??
    null;
  const team =
    outcome.team ?? outcome.description_team ?? outcome.player_team ?? null;
  return { id: id == null ? null : String(id), team: teamKey(team) };
}

/**
 * Bucket key for a resolved roster player.
 *
 * Normally the player's canonical name. When the roster itself contains two
 * people with that name (the Will Smith / Luis Ortiz case), the key is
 * qualified with the MLB id so their quotes can never share a bucket even if
 * the feed does let us tell them apart. `normalizeName` of a qualified key
 * collapses back to the plain name, so a name-only lookup still *finds* both
 * and correctly reports them as ambiguous.
 */
function rosterBucketKey(player, roster) {
  const sharing = roster.byKey.get(player.key) || [];
  return sharing.length > 1 && player.id != null
    ? `${player.key}#${player.id}`
    : player.key;
}

/**
 * Resolve one feed description against the roster.
 *
 * @returns {{status: "unknown"|"resolved"|"ambiguous", key: string|null,
 *   player: object|null, candidates: object[]}}
 *   "unknown" means no roster was supplied, or the name matched nothing in it -
 *   the quote is still filed, under the feed's own canonical key.
 */
function resolveDescription(description, hints, roster) {
  const feedKey = normalizeName(description);
  if (!roster.size) {
    return { status: "unknown", key: feedKey, player: null, candidates: [] };
  }

  const match = matchName(description, roster.keys);
  if (match.status === "missing") {
    return { status: "unknown", key: feedKey, player: null, candidates: [] };
  }

  const candidates = match.candidates.flatMap((k) => roster.byKey.get(k) || []);
  const resolved = (player) => ({
    status: "resolved",
    key: rosterBucketKey(player, roster),
    player,
    candidates,
  });

  if (candidates.length === 1) return resolved(candidates[0]);

  // More than one known player answers to this name. Narrow with whatever the
  // feed hung off the outcome; never guess.
  if (hints.id) {
    const byId = candidates.filter((c) => String(c.id) === hints.id);
    if (byId.length === 1) return resolved(byId[0]);
  }
  if (hints.team) {
    const byTeam = candidates.filter((c) => c.team && c.team === hints.team);
    if (byTeam.length === 1) return resolved(byTeam[0]);
  }
  return { status: "ambiguous", key: feedKey, player: null, candidates };
}

/**
 * Flatten one event's bookmaker payload into quotes indexed by market, then by
 * canonical player key.
 *
 * Shape returned: `{ [marketKey]: { [playerKey]: Quote[] } }`, plus a
 * non-enumerable `__meta__` (read it with `oddsIndexMeta`) carrying the
 * identity bookkeeping.
 *
 * Key points about the reduction:
 *
 *   - The five CORE_BOOKS are read as consensus books; the EXTRA_BOOKS
 *     (exchanges and DFS apps, which `/api/odds` now requests as `books=wide`)
 *     are read too but tagged `consensus: false`, so they can be shown on a row
 *     without voting on its line or inflating its book count. Iteration order is
 *     not load-bearing: `bestQuote` breaks ties on an explicit chain now, not on
 *     whoever happened to be parsed first.
 *   - LINKS. With `includeLinks=true` the upstream hangs a `link` (and a `sid`)
 *     off the outcome, the market and the bookmaker, documented as a fallback
 *     hierarchy in that order. All three tiers are retained per quote, per side,
 *     so `attachLines` can hand `venueLink` everything it needs to say how
 *     precisely a click lands - rather than silently presenting a market-level
 *     link as if it were the bet.
 *   - MULTIPLIERS. A DFS venue posts a line and a payout multiplier, not a
 *     two-sided price (the upstream marks them "indicative only"). Their
 *     `over`/`under` are therefore left null on purpose and the multiplier is
 *     stored beside them; nothing downstream can mistake one for a price.
 *   - Over and Under arrive as two separate outcomes; they are merged into one
 *     Quote per (book, point) pair.
 *   - IDENTITY. With no `players` option the player key is
 *     `normalizeName(outcome.description)`, exactly as before (so existing
 *     callers keep working). With a roster supplied, the description is
 *     resolved against it - tolerating accents, suffixes, `Last, First`,
 *     middle initials and hyphenation - and the quote is filed under the
 *     ROSTER's canonical key, which is what closes the "two feeds spell it
 *     differently" hole. A description that could belong to two roster players
 *     and cannot be split by an id or team hint is QUARANTINED: its quotes are
 *     filed nowhere and the name is recorded in `meta.ambiguousKeys`.
 *   - An outcome with no usable `point` is still stored, but it can no longer
 *     win a vote or reach a row: `bestQuote` drops it.
 *
 * @param {object|null|undefined} event - `/event-odds` response body.
 * @param {object} [options]
 * @param {Array<{id?: number|string, fullName?: string, name?: string,
 *   team?: string|number, teamAbbr?: string, teamId?: number}>} [options.players]
 *   Everyone who could legitimately be priced in this event (both probables and
 *   both lineups). Supplying it turns the name join from "hope the strings
 *   agree" into a real match with collision detection.
 * @returns {Record<string, Record<string, Quote[]>>} Empty object when the
 *   payload has no `bookmakers` array.
 */
export function parseEventOdds(event, options = {}) {
  const byMarket = {};
  const meta = emptyMeta();
  defineMeta(byMarket, meta);
  if (!event?.bookmakers) return byMarket;

  const roster = buildRoster(options.players);
  const resolutionCache = new Map();
  const unresolved = new Set();

  for (const bookKey of PARSED_BOOKS) {
    const bookmaker = event.bookmakers.find((b) => b.key === bookKey);
    if (!bookmaker) continue;

    const label = BOOK_LABEL[bookKey];
    // Consensus membership is decided here, once, by venue identity - not by
    // whether a price happens to look usable further downstream.
    const consensus = CORE_BOOKS.includes(bookKey);
    const dfs = isDfs(bookKey);
    const kind = venueInfo(bookKey)?.kind ?? "book";
    // Bookmaker-tier link: the coarsest tier the upstream offers, i.e. "this
    // event at this venue".
    const eventLink = bookmaker.link ?? null;

    for (const market of bookmaker.markets || []) {
      byMarket[market.key] = byMarket[market.key] || {};
      const byPlayer = byMarket[market.key];
      const marketLink = market.link ?? null;
      const marketSid = market.sid ?? null;

      for (const outcome of market.outcomes || []) {
        let playerKey;

        if (market.key === GAME_MARKET) {
          playerKey = GAME_KEY;
        } else {
          const hints = outcomeHints(outcome);
          const cacheKey = `${outcome.description}|${hints.id}|${hints.team}`;
          let resolved = resolutionCache.get(cacheKey);
          if (!resolved) {
            resolved = resolveDescription(outcome.description, hints, roster);
            resolutionCache.set(cacheKey, resolved);
          }

          if (resolved.status === "ambiguous") {
            // Two players answer to this name and nothing in the payload can
            // separate them. Merging them is how the original silently priced
            // a catcher against a reliever's line - so drop, and report.
            meta.quarantinedOutcomes++;
            const entry = meta.ambiguousKeys.get(resolved.key) || {
              name: outcome.description ?? null,
              key: resolved.key,
              candidates: resolved.candidates.map((c) => ({
                id: c.id,
                name: c.name,
                team: c.team,
              })),
            };
            // Registered under the feed's key AND under every roster key that
            // tied, so a caller looking the player up by their roster spelling
            // gets the ambiguity report rather than a silent miss.
            meta.ambiguousKeys.set(resolved.key, entry);
            for (const candidate of resolved.candidates) {
              if (!meta.ambiguousKeys.has(candidate.key)) {
                meta.ambiguousKeys.set(candidate.key, entry);
              }
            }
            continue;
          }

          playerKey = resolved.key;
          if (resolved.status === "unknown" && roster.size) {
            unresolved.add(outcome.description ?? "");
          }
          if (resolved.player) {
            const idKey = playerIdKey(resolved.player.id);
            if (idKey) meta.byIdentity.set(idKey, playerKey);
            if (resolved.player.team) {
              if (!meta.teamsByKey.has(playerKey)) {
                meta.teamsByKey.set(playerKey, new Set());
              }
              meta.teamsByKey.get(playerKey).add(resolved.player.team);
            }
            if (playerKey !== resolved.player.key) {
              // Bucket is id-qualified because somebody else on the roster
              // answers to the same name. Remember who owns it, so a lookup
              // that cannot prove which of them it is gets told, rather than
              // being handed the other player's quotes.
              meta.qualifiedKeys.set(playerKey, {
                id: resolved.player.id,
                team: resolved.player.team,
                name: resolved.player.name,
                plainKey: resolved.player.key,
              });
              if (!meta.collisions.has(resolved.player.key)) {
                meta.collisions.set(
                  resolved.player.key,
                  roster.byKey
                    .get(resolved.player.key)
                    .map((c) => ({ id: c.id, name: c.name, team: c.team })),
                );
              }
            }
          }
          meta.playerKeys.add(playerKey);
        }

        const quotes = byPlayer[playerKey] || (byPlayer[playerKey] = []);

        // One Quote per (book, point); the Over and Under outcomes for the
        // same point fold into the same object.
        let quote = quotes.find(
          (q) => q.bookId === canonicalBookId(label) && q.point === outcome.point,
        );
        if (!quote) {
          quote = {
            book: label,
            bookKey,
            bookId: canonicalBookId(label),
            point: outcome.point,
            over: null,
            under: null,
            w: BOOK_WEIGHT[label] || 1,
            market: market.key,
            consensus,
            kind,
            overLink: null,
            overSid: null,
            underLink: null,
            underSid: null,
            marketLink,
            marketSid,
            eventLink,
            overMultiplier: null,
            underMultiplier: null,
          };
          quotes.push(quote);
        }

        const side = outcomeSide(outcome.name);
        if (!side) continue;
        if (dfs) {
          // A multiplier is not a price. Leaving `over`/`under` null is what
          // keeps a DFS payout out of `isPriced`, out of the modal-point vote
          // and out of every de-vig in the engine.
          quote[`${side}Multiplier`] = outcomeMultiplier(outcome);
        } else {
          quote[side] = outcome.price;
        }
        quote[`${side}Link`] = outcome.link ?? quote[`${side}Link`];
        quote[`${side}Sid`] = outcome.sid ?? quote[`${side}Sid`];
      }
    }
  }

  meta.unresolvedDescriptions = [...unresolved];
  return byMarket;
}

// ── consensus ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} BestQuote
 * @property {number} point - The consensus point these prices belong to.
 * @property {number|null} over - Best (longest) American odds on the over.
 * @property {number|null} under - Best (longest) American odds on the under.
 * @property {string|null} overBook - Book posting `over`.
 * @property {string|null} underBook - Book posting `under`. May differ from
 *   `overBook`; the two sides are shopped independently.
 * @property {Quote[]} quotes - Every DEDUPLICATED quote at `point`. This is the
 *   same list handed to `evaluateEdge`, so the row's book count and the
 *   engine's book count are derived from identical data.
 * @property {number} nBooks - Distinct books quoting `point`.
 * @property {number} nBooksTwoSided - Distinct books with a two-way price at
 *   `point`. This is the number `evaluateEdge`'s consensus uses.
 * @property {number} weight - Book-weighted vote the winning point received.
 * @property {string[]} books - Book labels at `point`, first-seen order.
 * @property {"base"|"alt"|"both"|null} feed - Which feed(s) supplied `point`.
 */

/**
 * Pick the consensus point out of a quote list, then shop both sides at it.
 *
 * SELECTION RULE, precisely:
 *
 *   1. Deduplicate by canonical (book, point) - see `dedupeQuotes`. One book is
 *      one vote no matter how many feeds carried it.
 *   2. Drop quotes that cannot support a row: no usable numeric point, no price
 *      on either side, or `consensus: false` (an exchange or DFS venue - see
 *      EXTRA_BOOKS). None of them can win the vote. (The original let
 *      `point: undefined` win and then emitted a row with real odds and a null
 *      line, and let a price-less quote both win and count as a book.)
 *   3. Tally a BOOK-WEIGHTED vote per point: each surviving quote contributes
 *      its book weight `w` (Pinnacle 3, everyone else 1). The original counted
 *      raw entries.
 *   4. The winning point is the highest vote, ties broken by an EXPLICIT chain:
 *        a. more distinct books;
 *        b. more books quoting it in the BASE market (a lone book posting a
 *           whole alternate ladder must not drag the main line down to its
 *           lowest rung just because every rung has one vote);
 *        c. more two-sided books (a real market beats a one-way quote);
 *        d. the numerically lower point.
 *      Nothing here depends on CORE_BOOKS order, parse order or feed order, so
 *      the result is stable under reordering of the input.
 *   5. Independently take the best over and best under among the quotes at the
 *      winning point, comparing in DECIMAL space so -105 beats -110 and +120
 *      beats +115. A null price simply does not compete on that side.
 *
 * `over` and `under` remain a synthetic best-of-both-books pair; that is
 * deliberate line shopping, and `overBook`/`underBook` say who is behind each.
 *
 * @param {Quote[]|null|undefined} quotes - Candidate quotes, any points, any
 *   mix of feeds.
 * @returns {BestQuote|null} null when nothing in the list can price a row.
 */
export function bestQuote(quotes) {
  if (!quotes?.length) return null;

  // 1-2. canonical, deduplicated, and only quotes that can actually price a
  // row. Non-consensus venues (`consensus: false` - the exchanges and DFS apps)
  // are excluded HERE rather than only in `attachLines`, so every caller of
  // `bestQuote` - including the NRFI game total, which reads the index directly
  // - gets a consensus built from consensus books alone. A quote that never set
  // the flag is a consensus quote, so hand-built quotes behave as before.
  const pool = dedupeQuotes(quotes).filter(
    (q) => q.point != null && isPriced(q) && q.consensus !== false,
  );
  if (!pool.length) return null;

  // 3. book-weighted tally per point
  const byPoint = new Map();
  for (const q of pool) {
    let bucket = byPoint.get(q.point);
    if (!bucket) {
      bucket = {
        point: q.point,
        weight: 0,
        books: 0,
        baseBooks: 0,
        twoSided: 0,
        quotes: [],
      };
      byPoint.set(q.point, bucket);
    }
    bucket.weight += q.w || 1;
    bucket.books += 1; // one entry per book after dedupe
    if ((q.feeds || []).includes(FEED_BASE)) bucket.baseBooks += 1;
    if (q.over != null && q.under != null) bucket.twoSided += 1;
    bucket.quotes.push(q);
  }

  // 4. winner, with the tie-break chain spelled out
  const winner = [...byPoint.values()].reduce((best, candidate) => {
    if (candidate.weight !== best.weight) {
      return candidate.weight > best.weight ? candidate : best;
    }
    if (candidate.books !== best.books) {
      return candidate.books > best.books ? candidate : best;
    }
    if (candidate.baseBooks !== best.baseBooks) {
      return candidate.baseBooks > best.baseBooks ? candidate : best;
    }
    if (candidate.twoSided !== best.twoSided) {
      return candidate.twoSided > best.twoSided ? candidate : best;
    }
    return candidate.point < best.point ? candidate : best;
  });

  // 5. shop each side independently, in decimal space
  let over = null;
  let overBook = null;
  let under = null;
  let underBook = null;
  for (const q of winner.quotes) {
    if (q.over != null && (over == null || americanToDecimal(q.over) > americanToDecimal(over))) {
      over = q.over;
      overBook = q.book;
    }
    if (q.under != null && (under == null || americanToDecimal(q.under) > americanToDecimal(under))) {
      under = q.under;
      underBook = q.book;
    }
  }

  const feeds = [];
  for (const q of winner.quotes) {
    for (const feed of q.feeds || []) if (!feeds.includes(feed)) feeds.push(feed);
  }

  return {
    point: winner.point,
    over,
    under,
    overBook,
    underBook,
    quotes: winner.quotes,
    // Both counts below are book counts over the SAME deduplicated list that
    // `evaluateEdge` receives; neither can double-count a book that appears in
    // the base market and the alternate ladder.
    nBooks: winner.books,
    nBooksTwoSided: winner.twoSided,
    weight: winner.weight,
    books: winner.quotes.map((q) => q.book),
    feed: feedTag(feeds),
  };
}

// ── player resolution ───────────────────────────────────────────────────────

/**
 * @typedef {object} PlayerQuery
 * @property {string|null} name - Raw name as the caller knows it.
 * @property {string|null} key - Canonical form of `name`.
 * @property {string|null} id - MLB person id, when the caller has one.
 * @property {string} team - Canonical team hint, "" when absent.
 */

/**
 * Accept either the legacy string (a raw or already-normalised name) or a
 * descriptor carrying the identifiers that make disambiguation possible.
 *
 * @param {string|{name?: string, fullName?: string, key?: string,
 *   id?: number|string, playerId?: number|string, team?: string|number,
 *   teamAbbr?: string, teamId?: number}} player
 * @returns {PlayerQuery}
 */
export function toPlayerQuery(player) {
  if (player == null) return { name: null, key: null, id: null, team: "" };
  if (typeof player === "string") {
    return {
      name: player,
      key: normalizeName(player),
      id: null,
      team: "",
    };
  }
  const name = player.name ?? player.fullName ?? player.key ?? null;
  return {
    name,
    key: normalizeName(player.key ?? name),
    id:
      player.id ?? player.playerId ?? player.mlbId ?? null,
    team: teamKey(
      player.team ?? player.teamAbbr ?? player.teamName ?? player.teamId,
    ),
  };
}

/**
 * @typedef {object} PlayerResolution
 * @property {"matched"|"ambiguous"|"unmatched"|"no-odds"} status
 * @property {string|null} key - Index key to read quotes from, when matched.
 * @property {string|null} tier - Which match tier decided it.
 * @property {object[]} candidates - The tie, when ambiguous.
 * @property {string|null} reason
 */

/**
 * Find the odds-index bucket that belongs to a player.
 *
 * Order of attack, strongest first:
 *   1. MLB id, when the index was built with a roster and the id was pinned.
 *      This is the only join that cannot collide.
 *   2. A quarantined ambiguous name -> report AMBIGUOUS. The feed's quotes for
 *      that name belong to two people and were never filed; pricing either
 *      player against them is exactly the bug being fixed.
 *   3. Tiered name match against the keys actually present in the index
 *      (exact -> middle initials dropped -> spacing squashed -> first initial).
 *      A tier that ties between several keys is narrowed by the team hint if
 *      one is available, and otherwise reported AMBIGUOUS. A bucket that is
 *      id-qualified (its plain name is shared with a namesake) will only hand
 *      its quotes to a query that proves ownership with an id or a team - so
 *      "only one of the two Will Smiths is priced" cannot resolve to "both of
 *      them get that price".
 *   4. Nothing -> UNMATCHED (or NO-ODDS when the index holds no players at
 *      all, which distinguishes "this player is not in the feed" from "no odds
 *      were loaded for this game").
 *
 * @param {Record<string, any>} odds - `parseEventOdds` output.
 * @param {PlayerQuery} query
 * @returns {PlayerResolution}
 */
export function resolvePlayer(odds, query) {
  const meta = oddsIndexMeta(odds);

  if (!query.key) {
    return {
      status: "unmatched",
      key: null,
      tier: null,
      candidates: [],
      reason: "no name supplied",
    };
  }

  // 1. id join
  const idKey = playerIdKey(query.id);
  if (idKey && meta.byIdentity.has(idKey)) {
    return {
      status: "matched",
      key: meta.byIdentity.get(idKey),
      tier: "id",
      candidates: [],
      reason: null,
    };
  }

  // 2. quarantined at parse time, on an exact key. (The loose tiers are tried
  //    only after the index itself has been given a chance, so a quarantined
  //    "will smith" cannot swallow a legitimately priced "walker smith".)
  const ambiguousHit = (key) => (key ? meta.ambiguousKeys.get(key) : undefined);
  const quarantinedExact = ambiguousHit(query.key);
  if (quarantinedExact) {
    return {
      status: "ambiguous",
      key: null,
      tier: "quarantined",
      candidates: quarantinedExact.candidates,
      reason: "two players share this name in the odds feed",
    };
  }

  if (!meta.playerKeys.size && !meta.ambiguousKeys.size) {
    return {
      status: "no-odds",
      key: null,
      tier: null,
      candidates: [],
      reason: "no player quotes in this index",
    };
  }

  // 3. tiered name match
  const match = matchName(query.key, meta.playerKeys);
  if (match.status === "matched") {
    // The bucket may be id-qualified because a namesake also exists. Only an
    // id or team that proves ownership may read it; anything else is told the
    // name is not decidable, even though exactly one of the two is priced.
    const owner = meta.qualifiedKeys.get(match.key);
    if (owner) {
      const idKnown = query.id != null && owner.id != null;
      const teamKnown = !!query.team && !!owner.team;
      if (idKnown && String(query.id) === String(owner.id)) {
        return {
          status: "matched",
          key: match.key,
          tier: "id",
          candidates: match.candidates,
          reason: null,
        };
      }
      if (!idKnown && teamKnown && query.team === owner.team) {
        return {
          status: "matched",
          key: match.key,
          tier: `${match.tier}+team`,
          candidates: match.candidates,
          reason: null,
        };
      }
      const collision = meta.collisions.get(owner.plainKey) || [];
      const contradicted =
        (idKnown && String(query.id) !== String(owner.id)) ||
        (teamKnown && query.team !== owner.team);
      return contradicted
        ? {
            // We know these quotes are the namesake's, so this player simply
            // has no market - report it as such rather than as a coin flip.
            status: "unmatched",
            key: null,
            tier: match.tier,
            candidates: collision,
            reason: "the quotes under this name belong to a different player",
          }
        : {
            status: "ambiguous",
            key: null,
            tier: match.tier,
            candidates: collision,
            reason: "two players share this name and nothing distinguishes them",
          };
    }
    return {
      status: "matched",
      key: match.key,
      tier: match.tier,
      candidates: match.candidates,
      reason: null,
    };
  }
  if (match.status === "ambiguous") {
    if (query.team) {
      const byTeam = match.candidates.filter((key) =>
        meta.teamsByKey.get(key)?.has(query.team),
      );
      if (byTeam.length === 1) {
        return {
          status: "matched",
          key: byTeam[0],
          tier: `${match.tier}+team`,
          candidates: match.candidates,
          reason: null,
        };
      }
    }
    return {
      status: "ambiguous",
      key: null,
      tier: match.tier,
      candidates: match.candidates,
      reason: "name matches more than one priced player",
    };
  }

  // 4. last chance: a quarantined name reached on a looser tier.
  if (meta.ambiguousKeys.size) {
    const loose = ambiguousHit(
      matchName(query.key, [...meta.ambiguousKeys.keys()]).key,
    );
    if (loose) {
      return {
        status: "ambiguous",
        key: null,
        tier: "quarantined",
        candidates: loose.candidates,
        reason: "two players share this name in the odds feed",
      };
    }
  }

  // 5. nothing
  return {
    status: meta.playerKeys.size ? "unmatched" : "no-odds",
    key: null,
    tier: null,
    candidates: [],
    reason: meta.playerKeys.size
      ? "no book priced this name"
      : "no player quotes in this index",
  };
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PropRow
 * @property {string} market - Market key.
 * @property {string} label
 * @property {string} short
 * @property {string} distKey
 * @property {string} projKey
 * @property {boolean} alt - True on an ALTERNATE LINE row, i.e. a row whose
 *   point is not the market's consensus point. It says nothing about which
 *   feed the price came from - that is `feed`.
 * @property {"base"|"alt"|"both"|null} feed - Which feed supplied the quotes
 *   behind `line`. "alt" on a main-line row means the base market never posted
 *   this line at all.
 * @property {boolean} altMarket - Shorthand for `feed === "alt"`.
 * @property {number|null} line - The point this row is priced at. Never null
 *   while any of `over`/`under`/`book`/`nBooks` is populated.
 * @property {string|null} book - Book for the side the engine chose.
 * @property {string|null} overBook
 * @property {string|null} underBook
 * @property {number} nBooks - Distinct books quoting `line`, deduplicated
 *   across the base+alt union.
 * @property {number} nBooksTwoSided - Of those, how many posted a two-way
 *   price; this is what `edge.nBooks` counts.
 * @property {number|null} over - Best over price at `line`.
 * @property {number|null} under - Best under price at `line`.
 * @property {number} proj - Point projection for the stat.
 * @property {"matched"|"ambiguous"|"unmatched"|"no-odds"} playerMatch - How the
 *   player was joined to the feed. Anything but "matched" means the empty row
 *   is an identity problem, not an absence of odds.
 * @property {import("../lib/venues.js").RowVenue|null} venue - Where the price
 *   the row is calling came from, and where clicking it goes. `venue.exact`
 *   says whether that link is the specific outcome or something coarser.
 * @property {VenueOffer[]} venues - Every venue quoting this exact line,
 *   consensus books and non-consensus exchange/DFS venues alike.
 * @property {import("./edges.js").EdgeResult|null} edge
 */

/**
 * @typedef {object} VenueOffer
 * @property {string} key - Odds API bookmaker key.
 * @property {string} label
 * @property {string|null} short - Badge text, matching the row's `book`.
 * @property {"book"|"exchange"|"dfs"} kind
 * @property {string|null} link
 * @property {boolean} exact
 * @property {"outcome"|"market"|"event"|"brand"|null} granularity
 * @property {number|null} line
 * @property {"over"|"under"} side - The side this offer was resolved for.
 * @property {number|null} over - American price, or null on a DFS venue, which
 *   posts no two-sided price at all.
 * @property {number|null} under
 * @property {number|null} multiplier - DFS payout multiplier for `side`. Null
 *   everywhere else.
 * @property {boolean} consensus - Whether this venue voted on the row's line.
 */

/**
 * @typedef {object} LineDiagnostics
 * @property {PlayerQuery} player
 * @property {"matched"|"ambiguous"|"unmatched"|"no-odds"} status
 * @property {string|null} tier - Which match tier resolved the player.
 * @property {string[]} unmatched - `[name]` when no bucket could be found.
 * @property {Array<{name: string|null, candidates: object[]}>} ambiguous -
 *   `[{...}]` when the name belongs to more than one player.
 * @property {string|null} reason
 */

const DIAGNOSTICS_KEY = "diagnostics";

/**
 * Read the identity diagnostics off an `attachLines` result.
 *
 * They also live on the array as a non-enumerable `.diagnostics` property, so
 * `rows.diagnostics` works; this accessor exists so callers do not have to know
 * that, and so a plain array (or a `.map`ped copy, which drops the property)
 * still yields a sane empty answer.
 *
 * @param {PropRow[]} rows
 * @returns {LineDiagnostics}
 */
export function lineDiagnostics(rows) {
  return (
    rows?.[DIAGNOSTICS_KEY] || {
      player: { name: null, key: null, id: null, team: "" },
      status: "matched",
      tier: null,
      unmatched: [],
      ambiguous: [],
      reason: null,
    }
  );
}

function withDiagnostics(rows, query, resolution) {
  Object.defineProperty(rows, DIAGNOSTICS_KEY, {
    value: {
      player: query,
      status: resolution.status,
      tier: resolution.tier,
      unmatched:
        resolution.status === "unmatched" || resolution.status === "no-odds"
          ? [query.name ?? query.key ?? ""]
          : [],
      ambiguous:
        resolution.status === "ambiguous"
          ? [{ name: query.name ?? query.key ?? "", candidates: resolution.candidates }]
          : [],
      reason: resolution.reason,
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return rows;
}

/** Tag a feed's quotes with their provenance without mutating the index. */
function tagFeed(quotes, feed, marketKey) {
  return (quotes || []).map((q) => ({ ...q, feed, market: q.market ?? marketKey }));
}

/** The side a row is being called on. No edge means nothing was called: show the over. */
function calledSide(edge) {
  return edge?.side === "under" ? "under" : "over";
}

/**
 * Turn one quote into a venue offer for a given side.
 *
 * The link handed back is whatever `venueLink`'s hierarchy could resolve for
 * THIS side (outcome -> market -> event -> venue builder -> brand), and `exact`
 * comes back with it, so a row can never claim a market-wide link points at the
 * bet it is showing.
 *
 * @param {Quote} quote
 * @param {"over"|"under"} side
 * @returns {VenueOffer|null} null for a quote whose venue we do not know.
 */
function venueOffer(quote, side) {
  const key = quote.bookKey ?? venueKeyByShort(quote.book);
  const info = rowVenue(key, {
    link: side === "under" ? quote.underLink : quote.overLink,
    sid: side === "under" ? quote.underSid : quote.overSid,
    marketLink: quote.marketLink,
    eventLink: quote.eventLink,
  });
  if (!info) return null;

  const multiplier =
    side === "under" ? quote.underMultiplier : quote.overMultiplier;
  return {
    ...info,
    short: quote.book ?? null,
    line: quote.point ?? null,
    side,
    // Null on a DFS venue by construction (see `parseEventOdds`): a payout
    // multiplier is not half of a two-sided price and must not be shown as one.
    over: quote.over ?? null,
    under: quote.under ?? null,
    multiplier: multiplier ?? null,
    consensus: quote.consensus !== false,
  };
}

/**
 * Every venue quoting `line`, plus the one the row's price came from.
 *
 * @param {Quote[]} quotes - The full pool, consensus and non-consensus alike.
 * @param {number|null} line
 * @param {string|null} book - Short label of the book behind the chosen side.
 * @param {"over"|"under"} side
 * @returns {{venue: import("../lib/venues.js").RowVenue|null, venues: VenueOffer[]}}
 */
function venuesForLine(quotes, line, book, side) {
  if (line == null) return { venue: null, venues: [] };
  const venues = quotes
    .filter((q) => q.point === line)
    .map((q) => venueOffer(q, side))
    .filter(Boolean);
  const chosen = book ? venues.find((v) => v.short === book) : null;
  return {
    venue: chosen
      ? {
          key: chosen.key,
          label: chosen.label,
          kind: chosen.kind,
          link: chosen.link,
          exact: chosen.exact,
          granularity: chosen.granularity,
        }
      : null,
    venues,
  };
}

/**
 * Build the priced rows for one player across a table of markets.
 *
 * SELECTION RULE, precisely, per market `marketKey`:
 *
 *   pool = dedupeQuotes( base(marketKey) ++ alt(BASE_TO_ALT[marketKey]) )
 *
 *   MAIN LINE
 *     a. `bestQuote(pool)` chooses the point AND the prices from the SAME
 *        quotes. The base market no longer gets to name a point it cannot
 *        price: four books agreeing at 5.5 in the alternate ladder outvote one
 *        stale base quote at 8.5, because the vote is book-weighted over the
 *        union rather than counted over the base market alone.
 *     b. Every book counts once. A book present in both feeds is merged into a
 *        single quote before the vote, `nBooks` and `evaluateEdge` see it.
 *     c. Quotes with no usable point, or with no price on either side, are not
 *        in the pool at all, so a row can never carry odds with a null line.
 *     d. `feed`/`altMarket` record where the winning line came from, so an
 *        alternate-ladder line shown as the main line is visible to the UI.
 *     e. The row is still emitted when nothing priceable exists (the UI wants a
 *        stable row set) - but then every odds field is null/0, and
 *        `playerMatch` says whether that is an identity failure or a genuine
 *        absence of odds.
 *
 *   ALTERNATE LINE ROW
 *     f. Every other point in the pool is priced from that point's quotes.
 *     g. PASS candidates are discarded; among the rest the highest EV wins
 *        (null EV sorts as -99, EV ties break to the lower point so the choice
 *        does not depend on iteration order).
 *     h. At most one such row per market, tagged `alt: true` - meaning "not the
 *        consensus line". Its own `feed` says whether it came from the base
 *        market or the alternate ladder.
 *
 *   VENUES (both kinds of row)
 *     i. `venues` lists every venue quoting the row's line - the consensus books
 *        that priced it AND the exchange/DFS venues that did not vote on it -
 *        each with its own link resolved for the side the row is calling. A DFS
 *        entry carries `multiplier` and null prices, because a payout multiplier
 *        is not half of a two-sided market.
 *     j. `venue` is that list's entry for the book behind the chosen price, i.e.
 *        the one thing a "bet this" button should open. Its `exact` flag is the
 *        difference between "this link is the bet" and "this link is the
 *        neighbourhood the bet lives in"; both happen, and only one of them may
 *        be presented as the former.
 *
 * @param {Record<string, import("../lib/markets.js").MarketSpec>} markets -
 *   PITCHER_MARKETS or BATTER_MARKETS.
 * @param {string|{name?: string, fullName?: string, id?: number|string,
 *   team?: string|number}} player - Legacy: `normalizeName(person.fullName)`.
 *   Preferred: `{ name, id, team }`, which lets the resolver disambiguate.
 * @param {Record<string, Record<string, Quote[]>>} odds - `parseEventOdds`
 *   output for this game.
 * @param {object} projection - `projectPitcher` / `projectBatter` output; must
 *   expose `dist[distKey]` and the `projKey` point estimates.
 * @param {boolean} smallSample - Player carries the "SMALL SAMPLE" flag.
 * @returns {PropRow[]} One row per market, plus up to one alternate-line row
 *   each. The array also carries non-enumerable `diagnostics` (see
 *   `lineDiagnostics`) naming the player if they could not be matched.
 */
export function attachLines(markets, player, odds, projection, smallSample) {
  const query = toPlayerQuery(player);
  const resolution = resolvePlayer(odds || {}, query);
  const playerKey = resolution.status === "matched" ? resolution.key : null;
  const rows = [];

  for (const [marketKey, spec] of Object.entries(markets)) {
    const altKey = BASE_TO_ALT[marketKey] || null;
    // Everything quoting this market for this player, deduplicated across feeds.
    const offered = playerKey
      ? dedupeQuotes([
          ...tagFeed(odds?.[marketKey]?.[playerKey], FEED_BASE, marketKey),
          ...(altKey
            ? tagFeed(odds?.[altKey]?.[playerKey], FEED_ALT, altKey)
            : []),
        ])
      : [];

    // Only consensus venues price the row. The exchange/DFS venues stay in
    // `offered` so a row can show them, but they do not vote on the line, are
    // not counted in `nBooks` and never reach `evaluateEdge` - see EXTRA_BOOKS.
    const pool = offered.filter((q) => q.consensus !== false);

    // (a-c) one pool decides the point and the prices.
    const main = bestQuote(pool);
    const line = main ? main.point : null;

    const modelOver = line != null ? projection.dist[spec.distKey](line) : null;
    const edge =
      line != null
        ? evaluateEdge(modelOver, line, main.over, main.under, {
            smallSample,
            weight: MARKET_WEIGHT[marketKey],
            // Deduplicated: the engine's nBooks and the row's nBooks are two
            // views of the same book set now, not two different countings.
            quotes: main.quotes,
          })
        : null;

    // Book for the chosen side, other side as fallback. `main` is null exactly
    // when there is nothing to show, so this can no longer advertise a book for
    // a row that has no price.
    const book = main
      ? edge?.side === "under"
        ? main.underBook || main.overBook
        : main.overBook || main.underBook
      : null;

    const mainVenues = venuesForLine(offered, line, book, calledSide(edge));

    rows.push({
      market: marketKey,
      ...spec,
      alt: false,
      line,
      feed: main?.feed ?? null,
      altMarket: main?.feed === FEED_ALT,
      book: book || null,
      overBook: main?.overBook || null,
      underBook: main?.underBook || null,
      nBooks: main?.nBooks || 0,
      nBooksTwoSided: main?.nBooksTwoSided || 0,
      over: main?.over ?? null,
      under: main?.under ?? null,
      proj: projection[spec.projKey],
      playerMatch: resolution.status,
      venue: mainVenues.venue,
      venues: mainVenues.venues,
      edge,
    });

    if (!main) continue;

    // ── alternate-line scan ───────────────────────────────────────────────
    let best = null;
    for (const point of [...new Set(pool.map((q) => q.point))]) {
      if (point === line || point == null) continue;

      const sub = bestQuote(pool.filter((q) => q.point === point));
      if (!sub) continue;

      const modelOverAlt = projection.dist[spec.distKey](point);
      const edgeAlt = evaluateEdge(modelOverAlt, point, sub.over, sub.under, {
        smallSample,
        weight: MARKET_WEIGHT[marketKey],
        quotes: sub.quotes,
      });
      if (!edgeAlt || edgeAlt.verdict === "PASS") continue;

      // (g) highest EV; an EV tie breaks to the lower point rather than to
      // whichever point the feed happened to list first.
      const ev = edgeAlt.ev ?? -99;
      const bestEv = best ? (best.edge.ev ?? -99) : -Infinity;
      if (ev > bestEv || (ev === bestEv && best && point < best.pt)) {
        best = { sub, edge: edgeAlt, pt: point };
      }
    }

    if (best) {
      const bookAlt =
        best.edge.side === "under"
          ? best.sub.underBook || best.sub.overBook
          : best.sub.overBook || best.sub.underBook;

      const altVenues = venuesForLine(
        offered,
        best.pt,
        bookAlt || null,
        calledSide(best.edge),
      );

      rows.push({
        market: marketKey,
        ...spec,
        alt: true,
        line: best.pt,
        feed: best.sub.feed,
        altMarket: best.sub.feed === FEED_ALT,
        book: bookAlt || null,
        overBook: best.sub.overBook || null,
        underBook: best.sub.underBook || null,
        nBooks: best.sub.nBooks || 0,
        nBooksTwoSided: best.sub.nBooksTwoSided || 0,
        over: best.sub.over ?? null,
        under: best.sub.under ?? null,
        proj: projection[spec.projKey],
        playerMatch: resolution.status,
        venue: altVenues.venue,
        venues: altVenues.venues,
        edge: best.edge,
      });
    }
  }

  return withDiagnostics(rows, query, resolution);
}
