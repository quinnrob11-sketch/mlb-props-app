/**
 * DFS board selection logic — pure, DOM-free, React-free.
 *
 * The DFS edge is line shopping: PrizePicks, Pick6 and Betr all post a LINE and
 * a payout MULTIPLIER for the same player, and they do not agree. Taking the
 * softest of the three is the whole game, so this module's only job is:
 *
 *   1. find, per row, the line each of the three sites posts;
 *   2. pick the softest one FOR THE SIDE THE MODEL CALLS (lower is softer on an
 *      over, higher is softer on an under);
 *   3. say in one phrase why it is the softest, or say plainly that only one
 *      site lists the prop and no comparison happened;
 *   4. rank by how far the softest line sits from the model's projection.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE
 *
 * A DFS entry carries a payout multiplier, not a two-sided price. A multiplier
 * and an American price are not the same kind of number and cannot be ranked
 * against each other, so the offers this module emits carry NO price fields at
 * all: `over`/`under` are dropped on the way in and never read. Nothing
 * downstream can accidentally sort a 1.25x payout against −110.
 *
 * `kind === "dfs"` is the only membership test. A venue that somehow arrives
 * carrying a multiplier but is typed as a book or an exchange is not a DFS
 * offer and is ignored.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The three DFS apps the board covers, in display order.
 *
 * Underdog is deliberately absent (the user does not play it) and Sleeper is
 * not carried by the feed at all. `short` is a DISPLAY badge chosen for this
 * board — Pick6 reads "P6" here where `VENUES.pick6.short` is "PK6"; the venue
 * key is what joins to data, so the two never need to agree.
 *
 * @type {Array<{key: string, short: string, label: string}>}
 */
export const DFS_SITES = [
  { key: "prizepicks", short: "PP", label: "PrizePicks" },
  { key: "pick6", short: "P6", label: "Pick6" },
  { key: "betr_us_dfs", short: "BETR", label: "Betr" },
];

/** key -> site descriptor plus its display order. */
const SITE_BY_KEY = new Map(
  DFS_SITES.map((site, order) => [site.key, { ...site, order }]),
);

/** Finite-number coercion; anything else is "absent". */
function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @typedef {object} DfsOffer
 * @property {string} key - Venue key.
 * @property {string} short - Board badge ("PP" / "P6" / "BETR").
 * @property {string} label - Full site name.
 * @property {number} line - The point this site posts.
 * @property {number|null} multiplier - Payout multiplier, indicative only.
 * @property {string|null} link
 * @property {boolean} exact
 * @property {string|null} granularity
 * @property {boolean} best - Ties on the softest line are all marked best.
 *
 * Note the absence of `over`/`under`. See the module header.
 */

/**
 * The DFS offers on one row, one per site, in display order.
 *
 * @param {object} row - A row from `flattenRows`.
 * @returns {DfsOffer[]}
 */
export function dfsOffers(row) {
  const seen = new Map();
  for (const entry of row?.venues || []) {
    // Kind is the only gate: a multiplier on a book/exchange entry is not a
    // DFS offer, and a DFS entry's price fields are never read.
    if (!entry || entry.kind !== "dfs") continue;
    const site = SITE_BY_KEY.get(entry.key);
    if (!site) continue;
    const line = num(entry.line);
    if (line == null) continue;
    if (seen.has(site.key)) continue;
    seen.set(site.key, {
      key: site.key,
      short: site.short,
      label: site.label,
      order: site.order,
      line,
      multiplier: num(entry.multiplier),
      link: entry.link ?? null,
      exact: entry.exact === true,
      granularity: entry.granularity ?? null,
    });
  }
  return [...seen.values()].sort((a, b) => a.order - b.order);
}

/** The side the model is calling; null when nothing was called. */
function calledSide(row) {
  const side = row?.edge?.side;
  return side === "over" || side === "under" ? side : null;
}

/**
 * "Softer" means easier to beat for the side being played: a LOWER line on an
 * over, a HIGHER line on an under.
 *
 * @param {number} a @param {number} b @param {"over"|"under"} side
 * @returns {boolean} true when `a` is softer than `b`.
 */
export function isSofter(a, b, side) {
  return side === "under" ? a > b : a < b;
}

/** Vulgar-fraction wording for a half/quarter-point gap. */
export function pointText(diff) {
  const n = Math.abs(num(diff) ?? 0);
  const whole = Math.floor(n + 1e-9);
  const frac = Math.round((n - whole) * 100) / 100;
  const FRACTIONS = { 0.25: "¼", 0.5: "½", 0.75: "¾" };
  const glyph = FRACTIONS[frac];
  let text;
  if (glyph) text = whole ? `${whole}${glyph}` : glyph;
  else if (frac === 0) text = String(whole);
  else text = String(Math.round(n * 100) / 100);
  // "½ point" and "1 point"; anything above a full point pluralises.
  return `${text} point${n > 0 && n <= 1 ? "" : "s"}`;
}

/**
 * DFS lines, printed so three of them line up when scanned: a whole number
 * gets its `.0` back (7 -> "7.0") because it sits next to 6.5 and the eye
 * should not have to re-align. Anything already fractional is left alone.
 */
export function fmtLine(line) {
  const n = num(line);
  if (n == null) return "—";
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** "PP, P6 and BETR" */
function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * @typedef {object} DfsPlay
 * @property {string} key - The row key; stable board identity.
 * @property {object} row - The originating row (detail panel reads it).
 * @property {"over"|"under"} side
 * @property {number} line - The SOFTEST line, i.e. the one to actually take.
 * @property {string} play - The whole bet in words: "Paul Skenes OVER 6.5 K".
 * @property {DfsOffer[]} sites - Every site carrying it, display order.
 * @property {DfsOffer} best - The softest site (first, on a tie).
 * @property {DfsOffer[]} tied - Every site level with `best`.
 * @property {DfsOffer|null} runnerUp - Softest of the sites that are NOT tied.
 * @property {number|null} gap - Points between `best` and `runnerUp`.
 * @property {number|null} cushion - Model projection minus the softest line,
 *   signed toward the side being played. The board's sort key.
 * @property {"single"|"level"|"shopped"} coverage - single: one site only, so
 *   no comparison happened. level: every site posts the same number. shopped:
 *   one site is genuinely softer.
 * @property {string} why - One phrase explaining `coverage`.
 * @property {number|null} multiplier - Best site's multiplier, indicative.
 */

/**
 * Build the board entry for one row, or null when the row does not belong on
 * the DFS board at all.
 *
 * Excluded, deliberately: rows with no called side (there is no play to state),
 * rows with no line, and rows no DFS site carries — a prop the sportsbooks
 * price but PrizePicks/Pick6/Betr do not is simply not a DFS play.
 *
 * @param {object} row
 * @returns {DfsPlay|null}
 */
export function dfsPlay(row) {
  const side = calledSide(row);
  if (!side) return null;
  const sites = dfsOffers(row);
  if (!sites.length) return null;

  let best = sites[0];
  for (const site of sites) if (isSofter(site.line, best.line, side)) best = site;

  const tied = sites.filter((site) => site.line === best.line);
  for (const site of sites) site.best = site.line === best.line;

  const rest = sites.filter((site) => site.line !== best.line);
  let runnerUp = null;
  for (const site of rest)
    if (!runnerUp || isSofter(site.line, runnerUp.line, side)) runnerUp = site;
  const gap = runnerUp ? Math.abs(runnerUp.line - best.line) : null;

  const proj = num(row.proj);
  const cushion =
    proj == null ? null : side === "over" ? proj - best.line : best.line - proj;

  let coverage;
  let why;
  if (sites.length === 1) {
    coverage = "single";
    why = `Only ${best.label} lists this prop — nothing to shop against`;
  } else if (!runnerUp) {
    coverage = "level";
    why = `Same ${fmtLine(best.line)} at ${joinNames(sites.map((s) => s.short))} — no line edge, take the payout`;
  } else {
    coverage = "shopped";
    const matched =
      tied.length > 1
        ? ` (matched at ${joinNames(tied.map((s) => s.short))})`
        : "";
    why = `${pointText(gap)} softer than ${runnerUp.label}${matched}`;
  }

  return {
    key: row.key,
    row,
    side,
    line: best.line,
    play: `${row.name} ${side.toUpperCase()} ${fmtLine(best.line)}${row.short ? ` ${row.short}` : ""}`,
    sites,
    best,
    tied,
    runnerUp,
    gap,
    cushion,
    coverage,
    why,
    multiplier: best.multiplier,
  };
}

/**
 * The whole board: every row that has DFS coverage, ranked by how far the
 * softest DFS line sits from the model's projection, biggest first.
 *
 * Entries whose projection is unreadable sort to the bottom rather than
 * pretending to a cushion of zero. Ties fall back to EV and then to the play
 * text, so the order is total and stable across renders.
 *
 * @param {object[]} rows
 * @returns {DfsPlay[]}
 */
export function buildDfsBoard(rows) {
  const plays = [];
  for (const row of rows || []) {
    const play = dfsPlay(row);
    if (play) plays.push(play);
  }
  return plays.sort((a, b) => {
    const ac = a.cushion == null ? -Infinity : a.cushion;
    const bc = b.cushion == null ? -Infinity : b.cushion;
    if (bc !== ac) return bc - ac;
    const ae = a.row?.edge?.ev ?? -99;
    const be = b.row?.edge?.ev ?? -99;
    if (be !== ae) return be - ae;
    return a.play.localeCompare(b.play);
  });
}

/** How many sites the board would be shopping across, for the empty state. */
export function dfsCoverageCount(rows) {
  const keys = new Set();
  for (const row of rows || [])
    for (const site of dfsOffers(row)) keys.add(site.key);
  return keys.size;
}
