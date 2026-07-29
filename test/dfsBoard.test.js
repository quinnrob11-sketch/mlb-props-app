/**
 * DFS board selection.
 *
 * The thing under test is the board's whole promise: that the site it
 * highlights really is the softest one FOR THE SIDE BEING PLAYED, that a
 * one-site row is labelled as a one-site row rather than dressed up as a
 * comparison, that a payout multiplier never gets ranked against a two-sided
 * price, and that a prop no DFS app carries is simply absent.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DFS_SITES,
  buildDfsBoard,
  dfsCoverageCount,
  dfsOffers,
  dfsPlay,
  isSofter,
  pointText,
} from "../src/ui/dfsRows.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A DFS venue offer as `attachLines` builds it: a line and a multiplier, no price. */
function dfs(key, line, multiplier = null, extra = {}) {
  return {
    key,
    label: key,
    short: key.toUpperCase(),
    kind: "dfs",
    link: `https://example.test/${key}`,
    exact: false,
    granularity: "brand",
    line,
    side: "over",
    over: null,
    under: null,
    multiplier,
    consensus: false,
    ...extra,
  };
}

/** A sportsbook offer: a genuine two-sided American price. */
function book(short, line, over, under) {
  return {
    key: short.toLowerCase(),
    label: short,
    short,
    kind: "book",
    link: `https://example.test/${short}`,
    exact: true,
    granularity: "outcome",
    line,
    side: "over",
    over,
    under,
    multiplier: null,
    consensus: true,
  };
}

function row({
  key = "p:1:pitcher_strikeouts",
  name = "Paul Skenes",
  short = "K",
  line = 6.5,
  proj = 7.4,
  side = "over",
  ev = 4.2,
  venues = [],
} = {}) {
  return {
    key,
    name,
    short,
    label: "Strikeouts",
    market: "pitcher_strikeouts",
    matchup: "PIT @ CHC",
    gameDate: "2026-07-29T23:05:00Z",
    line,
    proj,
    book: "DK",
    venues,
    edge: { side, ev, verdict: "SOLID", modelOver: 0.58, usedOver: 0.56 },
  };
}

// ── 1. picking the softest line ─────────────────────────────────────────────

test("on an over, the LOWEST of the three DFS lines is the play", () => {
  const play = dfsPlay(
    row({
      venues: [
        book("DK", 6.5, -115, -105),
        dfs("prizepicks", 6.5, 1.25),
        dfs("pick6", 7),
        dfs("betr_us_dfs", 6.5),
      ],
    }),
  );

  assert.equal(play.best.key, "prizepicks");
  assert.equal(play.line, 6.5);
  assert.equal(play.play, "Paul Skenes OVER 6.5 K");
  // Every site level with the best is highlighted, not just the first.
  assert.deepEqual(
    play.sites.filter((s) => s.best).map((s) => s.key),
    ["prizepicks", "betr_us_dfs"],
  );
  assert.equal(play.runnerUp.key, "pick6");
  assert.equal(play.why, "½ point softer than Pick6 (matched at PP and BETR)");
  assert.equal(play.coverage, "shopped");
  // Cushion is the projection measured against the line actually taken.
  assert.equal(Math.round(play.cushion * 10) / 10, 0.9);
});

test("on an under, the HIGHEST DFS line is the soft one", () => {
  const play = dfsPlay(
    row({
      side: "under",
      proj: 5.1,
      venues: [dfs("prizepicks", 6.5), dfs("pick6", 7), dfs("betr_us_dfs", 6)],
    }),
  );

  assert.equal(play.best.key, "pick6");
  assert.equal(play.line, 7);
  assert.equal(play.play, "Paul Skenes UNDER 7.0 K");
  assert.equal(play.runnerUp.key, "prizepicks");
  assert.equal(play.why, "½ point softer than PrizePicks");
  assert.equal(Math.round(play.cushion * 10) / 10, 1.9);
  assert.equal(isSofter(7, 6.5, "under"), true);
  assert.equal(isSofter(7, 6.5, "over"), false);
});

test("all three level: no line edge is claimed", () => {
  const play = dfsPlay(
    row({
      venues: [dfs("prizepicks", 6.5), dfs("pick6", 6.5), dfs("betr_us_dfs", 6.5)],
    }),
  );

  assert.equal(play.coverage, "level");
  assert.equal(play.runnerUp, null);
  assert.equal(play.gap, null);
  assert.match(play.why, /^Same 6\.5 at PP, P6 and BETR/);
  assert.equal(play.sites.every((s) => s.best), true);
});

// ── 2. one site is not a comparison ─────────────────────────────────────────

test("a single-site row says so instead of implying line shopping", () => {
  const play = dfsPlay(row({ venues: [book("DK", 6.5, -115, -105), dfs("betr_us_dfs", 6.5, 1.4)] }));

  assert.equal(play.coverage, "single");
  assert.equal(play.sites.length, 1);
  assert.equal(play.runnerUp, null);
  assert.equal(play.gap, null);
  assert.equal(play.why, "Only Betr lists this prop — nothing to shop against");
  // and no phrase in it can be read as a comparison
  assert.doesNotMatch(play.why, /softer|same/i);
  assert.equal(play.multiplier, 1.4);
});

// ── 3. a multiplier is never ranked against a price ─────────────────────────

test("DFS offers carry no price fields at all", () => {
  const offers = dfsOffers(
    row({ venues: [book("DK", 6.5, -115, -105), dfs("prizepicks", 6.5, 1.25)] }),
  );

  assert.equal(offers.length, 1);
  const [pp] = offers;
  assert.ok(!("over" in pp), "a DFS offer must not carry an over price");
  assert.ok(!("under" in pp), "a DFS offer must not carry an under price");
  assert.equal(pp.multiplier, 1.25);
});

test("only kind:dfs counts — a book with a multiplier is not a DFS site, and a DFS venue with a two-sided price is still read as line-only", () => {
  // A book that (wrongly) arrives with a multiplier stays out of the board.
  const impostor = { ...book("DK", 6.5, -115, -105), multiplier: 1.9 };
  assert.deepEqual(dfsOffers(row({ venues: [impostor] })), []);

  // A DFS entry that (wrongly) arrives with prices contributes its line only;
  // the prices are dropped rather than compared with anything.
  const priced = dfs("pick6", 7, 1.5, { over: -110, under: -110 });
  const offers = dfsOffers(row({ venues: [priced] }));
  assert.equal(offers.length, 1);
  assert.ok(!("over" in offers[0]) && !("under" in offers[0]));
  assert.equal(offers[0].line, 7);
});

test("ranking is driven by the line, never by the price on the row", () => {
  // Two rows, identical DFS lines; the one with the worse book price but the
  // bigger projection cushion still ranks first.
  const soft = row({
    key: "a",
    name: "A Hitter",
    proj: 8.0,
    venues: [book("DK", 6.5, -250, +180), dfs("prizepicks", 6.5)],
  });
  const tight = row({
    key: "b",
    name: "B Hitter",
    proj: 6.8,
    ev: 30,
    venues: [book("DK", 6.5, +150, -170), dfs("prizepicks", 6.5)],
  });

  assert.deepEqual(
    buildDfsBoard([tight, soft]).map((p) => p.key),
    ["a", "b"],
  );
});

// ── 4. sort order ───────────────────────────────────────────────────────────

test("board is sorted by cushion descending, unprojected rows last", () => {
  const mk = (key, proj, line, ev = 1) =>
    row({ key, name: key, proj, ev, venues: [dfs("prizepicks", line)] });

  const board = buildDfsBoard([
    mk("small", 6.6, 6.5), // +0.1
    mk("none", null, 6.5), // no projection
    mk("big", 9.0, 6.5), // +2.5
    mk("mid", 7.5, 6.5), // +1.0
  ]);

  assert.deepEqual(
    board.map((p) => p.key),
    ["big", "mid", "small", "none"],
  );
  assert.equal(board[3].cushion, null);
});

test("cushion ties fall back to EV, then to the play text, so the order is stable", () => {
  const mk = (key, ev, name) =>
    row({ key, name, proj: 7.5, ev, venues: [dfs("prizepicks", 6.5)] });

  assert.deepEqual(
    buildDfsBoard([mk("x", 2, "Zed Zebra"), mk("y", 9, "Al Alpha")]).map((p) => p.key),
    ["y", "x"],
  );
  assert.deepEqual(
    buildDfsBoard([mk("x", 5, "Zed Zebra"), mk("y", 5, "Al Alpha")]).map((p) => p.key),
    ["y", "x"],
  );
});

// ── 5. no DFS coverage means no row ─────────────────────────────────────────

test("a prop only the sportsbooks price is not on the board", () => {
  const booksOnly = row({
    venues: [book("DK", 6.5, -115, -105), book("FD", 6.5, -110, -110)],
  });
  assert.equal(dfsPlay(booksOnly), null);
  assert.deepEqual(buildDfsBoard([booksOnly]), []);
  assert.equal(dfsCoverageCount([booksOnly]), 0);
});

test("DFS apps the user does not play are ignored, and an empty row list is empty", () => {
  const other = dfs("underdog", 6.5);
  assert.deepEqual(dfsOffers(row({ venues: [other] })), []);
  assert.deepEqual(buildDfsBoard([row({ venues: [other] })]), []);
  assert.deepEqual(buildDfsBoard([]), []);
  assert.deepEqual(buildDfsBoard(null), []);
  assert.deepEqual(
    DFS_SITES.map((s) => s.key),
    ["prizepicks", "pick6", "betr_us_dfs"],
  );
});

test("a row with no called side, or a DFS entry with no line, is left off", () => {
  const noSide = row({ venues: [dfs("prizepicks", 6.5)] });
  noSide.edge = null;
  assert.equal(dfsPlay(noSide), null);

  const noLine = row({ venues: [dfs("prizepicks", null)] });
  assert.equal(dfsPlay(noLine), null);
});

// ── wording ─────────────────────────────────────────────────────────────────

test("gaps are worded as points, with the fractions people say out loud", () => {
  assert.equal(pointText(0.5), "½ point");
  assert.equal(pointText(1), "1 point");
  assert.equal(pointText(1.5), "1½ points");
  assert.equal(pointText(2), "2 points");
  assert.equal(pointText(0.25), "¼ point");
  assert.equal(pointText(2.75), "2¾ points");
});

test("coverage count reports how many distinct sites the slate can be shopped across", () => {
  const rows = [
    row({ key: "a", venues: [dfs("prizepicks", 6.5), dfs("pick6", 7)] }),
    row({ key: "b", venues: [dfs("prizepicks", 1.5)] }),
  ];
  assert.equal(dfsCoverageCount(rows), 2);
});
