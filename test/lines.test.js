/**
 * Regression tests for the five defects listed in LINES-ANALYSIS.md that were
 * fixed in `src/model/lines.js` and `src/lib/names.js`.
 *
 * Run: npm test   (node --test test/)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  attachLines,
  bestQuote,
  dedupeQuotes,
  lineDiagnostics,
  parseEventOdds,
} from "../src/model/lines.js";
import { evaluateEdge } from "../src/model/edges.js";
import { matchName, nameVariants, normalizeName } from "../src/lib/names.js";
import { BATTER_MARKETS, PITCHER_MARKETS } from "../src/lib/markets.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** One market table entry, so a test's row list stays readable. */
const only = (table, key) => ({ [key]: table[key] });

/**
 * A projection stub. `probs` maps a line to the model's P(over) for it; any
 * line not listed gets `fallback`.
 */
function projection(distKey, probs, fallback = 0.5, projKey = "projK") {
  return {
    dist: { [distKey]: (line) => (line in probs ? probs[line] : fallback) },
    [projKey]: 6,
  };
}

const quote = (book, point, over, under, w = 1) => ({
  book,
  point,
  over,
  under,
  w,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Main-line split brain: the alternate-ladder consensus must win.
// ─────────────────────────────────────────────────────────────────────────────

test("four books agreeing in the alt ladder outvote one stale base quote", () => {
  const odds = {
    // The whole base market is one stale Caesars quote at 8.5.
    pitcher_strikeouts: {
      "test player": [quote("CZR", 8.5, 400, -600)],
    },
    // Four books agree at 5.5 in the alternate ladder.
    pitcher_strikeouts_alternate: {
      "test player": [
        quote("DK", 5.5, -110, -102),
        quote("FD", 5.5, -110, -102),
        quote("MGM", 5.5, -110, -102),
        quote("PIN", 5.5, -110, -102, 3),
      ],
    },
  };

  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_strikeouts"),
    "test player",
    odds,
    projection("k", {}, 0.5),
    false,
  );

  const main = rows.find((r) => !r.alt);
  assert.equal(main.line, 5.5, "consensus line, not the outlier");
  assert.equal(main.over, -110);
  assert.equal(main.under, -102);
  assert.equal(main.nBooks, 4);
  assert.equal(main.edge.nBooks, 4);
  // Provenance is honest about where the main line came from.
  assert.equal(main.feed, "alt");
  assert.equal(main.altMarket, true);
  // The 8.5 outlier is never the main row.
  assert.ok(!rows.some((r) => !r.alt && r.line === 8.5));
});

test("the modal point is book-weighted, and ties break deterministically", () => {
  // Pinnacle alone (weight 3) outvotes two weight-1 books.
  const weighted = bestQuote([
    quote("DK", 6.5, -110, -110),
    quote("FD", 6.5, -110, -110),
    quote("PIN", 5.5, -105, -115, 3),
  ]);
  assert.equal(weighted.point, 5.5);
  assert.equal(weighted.weight, 3);

  // A genuine tie (2 books v 2 books, equal weight) must not depend on the
  // order the quotes arrive in: same answer forwards and backwards.
  const tied = [
    quote("DK", 6.5, -110, -110),
    quote("FD", 6.5, -110, -110),
    quote("MGM", 5.5, -110, -110),
    quote("CZR", 5.5, -110, -110),
  ];
  assert.equal(bestQuote(tied).point, bestQuote([...tied].reverse()).point);
  assert.equal(bestQuote(tied).point, 5.5, "documented tie-break: lower point");
});

test("a lone book's alt ladder does not drag the main line off the base market", () => {
  const odds = {
    pitcher_strikeouts: { "test player": [quote("DK", 5.5, -110, -110)] },
    pitcher_strikeouts_alternate: {
      "test player": [
        quote("DK", 3.5, -260, 210),
        quote("DK", 4.5, -170, 145),
        quote("DK", 6.5, 150, -180),
      ],
    },
  };
  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_strikeouts"),
    "test player",
    odds,
    projection("k", {}, 0.5),
    false,
  );
  const main = rows.find((r) => !r.alt);
  assert.equal(main.line, 5.5, "every rung has one vote; the base market wins");
  assert.equal(main.feed, "base");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A book present in both feeds counts once.
// ─────────────────────────────────────────────────────────────────────────────

test("a book quoting the same point in both feeds is counted once", () => {
  const dk = quote("DK", 5.5, 150, -180);
  const odds = {
    pitcher_strikeouts: { "test player": [dk] },
    pitcher_strikeouts_alternate: { "test player": [{ ...dk }] },
  };

  // Model sits exactly 0.15 above the market's fair price: without the
  // demotion this is a STRONG.
  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_strikeouts"),
    "test player",
    odds,
    projection("k", { 5.5: 0.5335 }),
    false,
  );
  const main = rows[0];

  assert.equal(main.nBooks, 1, "row book count");
  assert.equal(main.edge.nBooks, 1, "engine book count agrees with the row");
  assert.equal(main.nBooksTwoSided, 1);
  assert.equal(main.feed, "both", "provenance records both feeds");

  // The counts matter: one book cannot make a STRONG.
  assert.equal(main.edge.verdict, "SOLID");
  // Proof that the pre-fix input really did defeat the demotion - the same
  // engine call with the duplicated quote list still returns STRONG.
  const doubled = evaluateEdge(0.5335, 5.5, 150, -180, {
    weight: 0.45,
    quotes: [dk, { ...dk }],
  });
  assert.equal(doubled.nBooks, 2);
  assert.equal(doubled.verdict, "STRONG");
});

test("dedupe merges one-sided halves of the same (book, point)", () => {
  const merged = dedupeQuotes([
    { book: "DK", point: 5.5, over: -115, under: null, w: 1, feed: "base" },
    { book: "dk ", point: 5.5, over: null, under: 105, w: 1, feed: "alt" },
  ]);
  assert.equal(merged.length, 1, "canonical book identity, case/space folded");
  assert.deepEqual(
    [merged[0].over, merged[0].under, merged[0].feeds.sort()],
    [-115, 105, ["alt", "base"]],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A quote with no point never produces a row with odds.
// ─────────────────────────────────────────────────────────────────────────────

test("point-less quotes never yield a null-line row carrying odds", () => {
  const odds = {
    pitcher_strikeouts: {
      "test player": [
        { book: "FD", point: undefined, over: -115, under: 100, w: 1 },
        { book: "DK", point: undefined, over: -120, under: 105, w: 1 },
      ],
    },
  };

  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_strikeouts"),
    "test player",
    odds,
    projection("k", {}),
    false,
  );

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.line, null);
  // A null line must mean a completely empty row - no prices, no book, no count.
  assert.deepEqual(
    [row.over, row.under, row.book, row.overBook, row.underBook, row.nBooks, row.edge],
    [null, null, null, null, null, 0, null],
  );
});

test("a point-less quote cannot win the modal vote against a real one", () => {
  const odds = {
    pitcher_strikeouts: {
      "test player": [
        { book: "FD", point: undefined, over: -115, under: 100, w: 1 },
        { book: "DK", point: undefined, over: -120, under: 105, w: 1 },
        quote("MGM", 5.5, -110, -110),
      ],
    },
  };
  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_strikeouts"),
    "test player",
    odds,
    projection("k", {}),
    false,
  );
  assert.equal(rows[0].line, 5.5);
  assert.equal(rows[0].nBooks, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Provenance: base-market outlier vs alternate-as-main.
// ─────────────────────────────────────────────────────────────────────────────

test("a base-market outlier is an alternate LINE, not an alternate MARKET", () => {
  // pitcher_outs has no alternate ladder at all.
  const odds = {
    pitcher_outs: {
      "test player": [
        quote("DK", 17.5, -110, -110),
        quote("FD", 17.5, -110, -110),
        quote("MGM", 17.5, -110, -110),
        quote("CZR", 15.5, -140, 120),
      ],
    },
  };

  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_outs"),
    "test player",
    odds,
    projection("outs", { 15.5: 0.7 }, 0.5, "projOuts"),
    false,
  );

  const main = rows.find((r) => !r.alt);
  assert.equal(main.line, 17.5);
  assert.equal(main.feed, "base");
  assert.equal(main.altMarket, false);

  const alt = rows.find((r) => r.alt);
  assert.equal(alt.line, 15.5);
  assert.equal(alt.feed, "base", "off-consensus, but from the base market");
  assert.equal(alt.altMarket, false, "there is no alternate ladder here at all");
});

test("an alternate-ladder line used as the main line says so", () => {
  const odds = {
    // base market empty for this player
    pitcher_strikeouts: {},
    pitcher_strikeouts_alternate: {
      "test player": [quote("DK", 5.5, -125, 110), quote("FD", 5.5, -120, 105)],
    },
  };

  const rows = attachLines(
    only(PITCHER_MARKETS, "pitcher_strikeouts"),
    "test player",
    odds,
    projection("k", {}),
    false,
  );

  const main = rows.find((r) => !r.alt);
  assert.equal(main.line, 5.5);
  assert.equal(main.alt, false, "it IS the consensus line");
  assert.equal(main.feed, "alt", "but only the alternate ladder posted it");
  assert.equal(main.altMarket, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Identity: same-named players are dropped and reported, never merged.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal /event-odds payload. */
function event(outcomesByBook, market = "batter_hits") {
  return {
    bookmakers: Object.entries(outcomesByBook).map(([key, outcomes]) => ({
      key,
      markets: [{ key: market, outcomes }],
    })),
  };
}

const over = (description, point, price, extra = {}) => ({
  name: "Over",
  description,
  point,
  price,
  ...extra,
});
const under = (description, point, price, extra = {}) => ({
  name: "Under",
  description,
  point,
  price,
  ...extra,
});

const TWO_SMITHS = [
  { id: 111, fullName: "Will Smith", team: "LAD" },
  { id: 222, fullName: "Will Smith", team: "KC" },
  { id: 333, fullName: "Aaron Judge", team: "NYY" },
];

test("two players with the same full name are quarantined, not merged", () => {
  const odds = parseEventOdds(
    event({
      draftkings: [
        over("Will Smith", 0.5, -180),
        under("Will Smith", 0.5, 145),
        over("Aaron Judge", 1.5, 120),
        under("Aaron Judge", 1.5, -145),
      ],
      fanduel: [over("Will Smith", 1.5, 255), under("Will Smith", 1.5, -330)],
    }),
    { players: TWO_SMITHS },
  );

  // Nothing was filed under the shared name.
  assert.deepEqual(Object.keys(odds.batter_hits), ["aaron judge"]);

  const proj = projection("hits", {}, 0.5, "projH");
  const markets = only(BATTER_MARKETS, "batter_hits");

  for (const person of [TWO_SMITHS[0], TWO_SMITHS[1]]) {
    const rows = attachLines(
      markets,
      { name: person.fullName, id: person.id, team: person.team },
      odds,
      proj,
      false,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].line, null, "no line rather than the wrong line");
    assert.equal(rows[0].over, null);
    assert.equal(rows[0].playerMatch, "ambiguous");

    const diag = lineDiagnostics(rows);
    assert.equal(diag.status, "ambiguous");
    assert.equal(diag.ambiguous.length, 1);
    assert.equal(diag.ambiguous[0].name, "Will Smith");
    assert.deepEqual(
      diag.ambiguous[0].candidates.map((c) => c.id).sort(),
      [111, 222],
    );
    assert.deepEqual(rows.diagnostics, diag, "also readable off the array");
  }

  // A name-only (legacy) lookup is reported too, not silently emptied.
  const legacy = attachLines(markets, "will smith", odds, proj, false);
  assert.equal(lineDiagnostics(legacy).status, "ambiguous");

  // The unaffected player is untouched.
  const judge = attachLines(markets, "Aaron Judge", odds, proj, false);
  assert.equal(judge[0].line, 1.5);
  assert.equal(lineDiagnostics(judge).status, "matched");
});

test("a feed that carries player ids or teams splits the same-named pair", () => {
  const odds = parseEventOdds(
    event({
      draftkings: [
        over("Will Smith", 0.5, -180, { player_id: 111 }),
        under("Will Smith", 0.5, 145, { player_id: 111 }),
        over("Will Smith", 1.5, 260, { player_id: 222 }),
        under("Will Smith", 1.5, -340, { player_id: 222 }),
      ],
    }),
    { players: TWO_SMITHS },
  );

  const proj = projection("hits", {}, 0.5, "projH");
  const markets = only(BATTER_MARKETS, "batter_hits");

  const catcher = attachLines(
    markets,
    { name: "Will Smith", id: 111 },
    odds,
    proj,
    false,
  );
  const reliever = attachLines(
    markets,
    { name: "Will Smith", id: 222 },
    odds,
    proj,
    false,
  );
  assert.equal(catcher[0].line, 0.5);
  assert.equal(reliever[0].line, 1.5);
  assert.equal(catcher[0].nBooks, 1);

  // The team hint works when the caller has no id.
  const byTeam = attachLines(
    markets,
    { name: "Will Smith", team: "KC" },
    odds,
    proj,
    false,
  );
  assert.equal(byTeam[0].line, 1.5);

  // With neither, it is still ambiguous - and still reported.
  const blind = attachLines(markets, { name: "Will Smith" }, odds, proj, false);
  assert.equal(blind[0].line, null);
  assert.equal(lineDiagnostics(blind).status, "ambiguous");
});

test("when only one namesake is priced, the other is not handed his line", () => {
  const odds = parseEventOdds(
    event({
      draftkings: [
        over("Will Smith", 0.5, -180, { player_id: 111 }),
        under("Will Smith", 0.5, 145, { player_id: 111 }),
      ],
    }),
    { players: TWO_SMITHS },
  );

  const proj = projection("hits", {}, 0.5, "projH");
  const markets = only(BATTER_MARKETS, "batter_hits");

  const priced = attachLines(markets, { name: "Will Smith", id: 111 }, odds, proj, false);
  assert.equal(priced[0].line, 0.5);

  const other = attachLines(markets, { name: "Will Smith", id: 222 }, odds, proj, false);
  assert.equal(other[0].line, null, "the reliever does not inherit the catcher's line");
  assert.equal(other[0].playerMatch, "unmatched");

  const blind = attachLines(markets, "Will Smith", odds, proj, false);
  assert.equal(blind[0].line, null);
  assert.equal(lineDiagnostics(blind).status, "ambiguous");
});

test("spelling divergence resolves against the roster instead of vanishing", () => {
  const players = [
    { id: 1, fullName: "Luis Ortiz", team: "PIT" },
    { id: 2, fullName: "Ronald Acuña Jr.", team: "ATL" },
    { id: 3, fullName: "Jung Hoo Lee", team: "SF" },
  ];
  const odds = parseEventOdds(
    event({
      draftkings: [
        // middle initial only on the feed side
        over("Luis L. Ortiz", 1.5, -120),
        under("Luis L. Ortiz", 1.5, 100),
        // "Last, First" ordering and a stray suffix space
        over("Acuna Jr. , Ronald", 1.5, 130),
        under("Acuna Jr. , Ronald", 1.5, -155),
        // hyphenation divergence
        over("Jung-hoo Lee", 0.5, -140),
        under("Jung-hoo Lee", 0.5, 115),
      ],
    }),
    { players },
  );

  const proj = projection("hits", {}, 0.5, "projH");
  const markets = only(BATTER_MARKETS, "batter_hits");
  for (const person of players) {
    const rows = attachLines(markets, person.fullName, odds, proj, false);
    assert.equal(
      lineDiagnostics(rows).status,
      "matched",
      `${person.fullName} should match`,
    );
    assert.ok(rows[0].line != null, `${person.fullName} should be priced`);
  }
});

test("an unmatched player is reported, not silently empty", () => {
  const odds = parseEventOdds(
    event({ draftkings: [over("Aaron Judge", 1.5, 120), under("Aaron Judge", 1.5, -145)] }),
  );
  const rows = attachLines(
    only(BATTER_MARKETS, "batter_hits"),
    "Shohei Ohtani",
    odds,
    projection("hits", {}, 0.5, "projH"),
    false,
  );
  assert.equal(rows[0].line, null);
  assert.equal(rows[0].playerMatch, "unmatched");
  assert.deepEqual(lineDiagnostics(rows).unmatched, ["Shohei Ohtani"]);

  // ... and "no odds at all for this game" is a different answer.
  const empty = attachLines(
    only(BATTER_MARKETS, "batter_hits"),
    "Shohei Ohtani",
    parseEventOdds(null),
    projection("hits", {}, 0.5, "projH"),
    false,
  );
  assert.equal(lineDiagnostics(empty).status, "no-odds");
});

// ── name normalisation units ────────────────────────────────────────────────

test("normalizeName handles suffixes, accents, punctuation and Last, First", () => {
  assert.equal(normalizeName("Will Smith"), "will smith");
  assert.equal(normalizeName("Smith, Will"), "will smith");
  assert.equal(normalizeName("Ronald Acuña Jr. "), "ronald acuna");
  assert.equal(normalizeName("O'Neill, Tyler"), "tyler oneill");
  assert.equal(normalizeName("Jung-hoo Lee"), "jung hoo lee");
  assert.equal(normalizeName(undefined), "");
  // idempotent, so callers may pass a key or a raw name interchangeably
  for (const raw of ["Smith, Will", "Ronald Acuña Jr.", "Michael A. Taylor"]) {
    assert.equal(normalizeName(normalizeName(raw)), normalizeName(raw));
  }
});

test("matchName reports ties instead of picking one", () => {
  assert.equal(matchName("Luis L. Ortiz", ["luis ortiz"]).status, "matched");
  assert.equal(matchName("Luis L. Ortiz", ["luis ortiz"]).tier, "noMiddle");

  const tie = matchName("W. Smith", ["will smith", "walker smith"]);
  assert.equal(tie.status, "ambiguous");
  assert.deepEqual(tie.candidates, ["walker smith", "will smith"]);

  assert.equal(matchName("Nobody Here", ["will smith"]).status, "missing");
  assert.equal(nameVariants("Michael A. Taylor").noMiddle, "michael taylor");
});
