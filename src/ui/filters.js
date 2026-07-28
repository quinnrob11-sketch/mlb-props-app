/**
 * Criteria filter for the prop boards.
 *
 * Pure, DOM-free predicate logic: every accessor reads the row shape
 * defensively (`row.edge?.ev`, `row.flags?.includes(...)`) so a row that is
 * mid-migration — missing `edge`, missing `flags`, missing the not-yet-landed
 * `lineupSource` — narrows the board instead of throwing.
 *
 * Layout of this file:
 *   1. Vocabulary (tiers, books, kinds, market choices).
 *   2. Row accessors — one per physical field the criteria read.
 *   3. `DEFAULT_CRITERIA` + `normalizeCriteria`.
 *   4. `CRITERION_SPECS` — one descriptor per criterion: is it active, what
 *      does it read, how is it labelled, what resets it.
 *   5. `applyCriteria` / `countActiveCriteria` / `describeCriteria` /
 *      `diagnoseCriteria` / `explainEmpty`.
 *   6. localStorage persistence under `criteriaV1`.
 */

import { PITCHER_MARKETS, BATTER_MARKETS } from '../lib/markets.js';

// ── 1. vocabulary ──────────────────────────────────────────────────────────

/** Verdict ladder, best first. Selecting all four means "no tier filter". */
export const VERDICT_TIERS = ['STRONG', 'SOLID', 'LEAN', 'PASS'];

/** Book short labels, matching `BOOK_LABEL` in lib/markets.js. */
export const BOOK_CHOICES = ['DK', 'FD', 'MGM', 'CZR', 'PIN'];

/** Row kinds. `nrfi` has no rows today; the criterion is wired for when it does. */
export const KIND_CHOICES = ['pitcher', 'batter', 'nrfi'];

export const KIND_LABEL = { pitcher: 'Pitchers', batter: 'Batters', nrfi: 'NRFI' };

/** Flags the data-quality group can exclude on. */
export const FLAG_SMALL_SAMPLE = 'SMALL SAMPLE';
export const FLAG_BULK_OPENER = 'BULK/OPENER RISK';
export const FLAG_SHORT_LEASH = 'SHORT LEASH';
export const FLAG_PROJ_LINEUP = 'PROJ LINEUP';

/**
 * Every selectable market, in board order, tagged with the kind it belongs to
 * so the modal can group them. Labels come straight from the market tables.
 * @type {Array<{key:string, kind:string, label:string, short:string}>}
 */
export const MARKET_CHOICES = [
  ...Object.entries(PITCHER_MARKETS).map(([key, def]) => ({
    key,
    kind: 'pitcher',
    label: def.label,
    short: def.short,
  })),
  ...Object.entries(BATTER_MARKETS).map(([key, def]) => ({
    key,
    kind: 'batter',
    label: def.label,
    short: def.short,
  })),
];

const MARKET_BY_KEY = new Map(MARKET_CHOICES.map((m) => [m.key, m]));

/** Display label for a market key; falls back to the raw key. */
export function marketLabel(key) {
  return MARKET_BY_KEY.get(key)?.label || key;
}

/** Batters faced per inning, used only to derive a pitcher sample from IP. */
const BF_PER_INNING = 4.3;

// ── 2. row accessors ───────────────────────────────────────────────────────

/** Finite-number coercion; strings from the stats feed are accepted. */
function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Baseball innings-pitched string ("45.1" = 45⅓) → decimal innings. */
export function parseIp(v) {
  const n = toNum(v);
  if (n == null) return null;
  const whole = Math.floor(n);
  // The fractional digit is a count of outs (.1 = 1 out, .2 = 2 outs).
  const outs = Math.round((n - whole) * 10);
  return whole + (outs > 0 && outs < 3 ? outs / 3 : 0);
}

/** EV in percent of stake for the called side, or null. */
export function rowEv(row) {
  return toNum(row?.edge?.ev);
}

/**
 * Absolute probability edge in 0..1 (0.05 = 5 points). Prefers `sideEdge`
 * (signed toward the called side) and falls back to the raw `edge`.
 */
export function rowEdgePts(row) {
  const v = toNum(row?.edge?.sideEdge) ?? toNum(row?.edge?.edge);
  return v == null ? null : Math.abs(v);
}

/** Quarter-Kelly stake as a fraction of bankroll, or null. */
export function rowKelly(row) {
  return toNum(row?.edge?.kelly);
}

/** American odds of the called side; falls back to the posted side price. */
export function rowOdds(row) {
  const o = toNum(row?.edge?.odds);
  if (o != null) return o;
  const side = row?.edge?.side;
  if (side === 'over') return toNum(row?.over);
  if (side === 'under') return toNum(row?.under);
  return null;
}

/** Market overround as a decimal (0.045 = 4.5%), or null when unpriced. */
export function rowVig(row) {
  return toNum(row?.edge?.vig);
}

/** Distinct books backing the line. Row-level count wins over the edge's. */
export function rowBookCount(row) {
  return toNum(row?.nBooks) ?? toNum(row?.edge?.nBooks);
}

/**
 * Every book label known to be attached to this row (best price, over side,
 * under side, plus any `books` / `quotes` arrays a later shape may add).
 * @returns {Set<string>} upper-cased short labels
 */
export function rowBooks(row) {
  const out = new Set();
  const add = (b) => {
    if (typeof b === 'string' && b) out.add(b.toUpperCase());
  };
  add(row?.book);
  add(row?.overBook);
  add(row?.underBook);
  if (Array.isArray(row?.books)) row.books.forEach(add);
  if (Array.isArray(row?.quotes)) row.quotes.forEach((q) => add(q?.book));
  return out;
}

/** True when a genuine two-way price exists. */
export function rowTwoSided(row) {
  const flag = row?.edge?.twoSided;
  if (typeof flag === 'boolean') return flag;
  return toNum(row?.over) != null && toNum(row?.under) != null;
}

/** Player flags, always an array. */
export function rowFlags(row) {
  return Array.isArray(row?.flags) ? row.flags : [];
}

export function hasFlag(row, flag) {
  return rowFlags(row).includes(flag);
}

/**
 * Season sample behind the projection: plate appearances for batters, batters
 * faced for pitchers. Returns 0 — not null — when nothing is readable, because
 * "no season line at all" is genuinely the smallest possible sample.
 */
export function rowSample(row) {
  const direct = toNum(row?.sampleSize) ?? toNum(row?.detailRef?.sampleSize);
  if (direct != null) return direct;
  const s = row?.detailRef?.season;
  if (!s) return 0;
  const pa = toNum(s.pa) ?? toNum(s.plateAppearances);
  if (pa != null) return pa;
  const bf = toNum(s.bf) ?? toNum(s.battersFaced);
  if (bf != null) return bf;
  const ip = parseIp(s.ip ?? s.inningsPitched);
  return ip == null ? 0 : Math.round(ip * BF_PER_INNING);
}

/**
 * Lineup provenance, if the field has landed yet. Checked on the row, the
 * originating player object and the game, in that order.
 * @returns {'confirmed'|'projected'|'fallback'|string|null}
 */
export function rowLineupSource(row) {
  const v = row?.lineupSource ?? row?.detailRef?.lineupSource ?? row?.game?.lineupSource;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Whether this row rests on a confirmed lineup.
 *
 * Pitcher rows are exempt — a starting pitcher is announced independently of
 * the batting order. A batter row with neither a `PROJ LINEUP` flag nor a
 * `lineupSource` is treated as confirmed: the field is still landing, and a
 * missing field must not silently empty the batter board.
 */
export function isConfirmedLineup(row) {
  if (row?.kind !== 'batter') return true;
  if (hasFlag(row, FLAG_PROJ_LINEUP)) return false;
  const src = rowLineupSource(row);
  if (src == null) return true;
  return src === 'confirmed';
}

/** Local wall-clock first pitch as minutes past midnight, or null. */
export function rowStartMinutes(row) {
  const raw = row?.gameDate ?? row?.game?.gameDate;
  if (raw == null) return null;
  const d = new Date(raw);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  return d.getHours() * 60 + d.getMinutes();
}

/** "HH:MM" → minutes past midnight, or null when unparseable. */
export function parseHm(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The game this row belongs to, as the human-readable "AWY @ HOM" matchup. */
export function rowGame(row) {
  return typeof row?.matchup === 'string' ? row.matchup : null;
}

/**
 * Both team abbreviations involved in the row's game, plus the row's own team.
 * @returns {Set<string>}
 */
export function rowTeams(row) {
  const out = new Set();
  if (typeof row?.team === 'string' && row.team) out.add(row.team.toUpperCase());
  const matchup = rowGame(row);
  if (matchup)
    for (const part of matchup.split('@')) {
      const t = part.trim().toUpperCase();
      if (t && t !== '?') out.add(t);
    }
  return out;
}

/** Distinct team abbreviations across a row list, sorted, for the picker. */
export function teamOptions(rows) {
  const out = new Set();
  for (const row of rows || []) for (const t of rowTeams(row)) out.add(t);
  return [...out].sort();
}

/** Distinct matchups across a row list, sorted by first pitch then name. */
export function gameOptions(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const g = rowGame(row);
    if (g && !seen.has(g)) seen.set(g, rowStartMinutes(row) ?? 1e9);
  }
  return [...seen.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([g]) => g);
}

// ── 3. the criteria object ─────────────────────────────────────────────────

/**
 * Every criterion, with the value that means "not filtering".
 *
 * Numeric bounds use `null` for "no bound" so an unset control is
 * distinguishable from a deliberate 0. Multi-selects use `[]` for "all"
 * except `verdicts`/`kinds`, which enumerate their full sets so the UI can
 * render them as toggle chips.
 */
export const DEFAULT_CRITERIA = Object.freeze({
  // 1 — edge & confidence
  /** @type {number|null} minimum |probability edge|, 0..1 (0.05 = 5 points) */
  minEdge: null,
  /** @type {number|null} minimum EV, in percent of stake */
  minEv: null,
  /** @type {string[]} verdict tiers to keep; all four = no filter */
  verdicts: [...VERDICT_TIERS],
  /** @type {number|null} minimum ¼-Kelly stake as a bankroll fraction */
  minKelly: null,

  // 2 — odds & book
  /** @type {number|null} lowest acceptable American price on the called side */
  oddsMin: null,
  /** @type {number|null} highest acceptable American price on the called side */
  oddsMax: null,
  /** @type {number|null} maximum overround, decimal (0.06 = 6%) */
  maxVig: null,
  /** @type {number|null} minimum distinct books at the line */
  minBooks: null,
  /** @type {string|null} require a price from this book (DK/FD/MGM/CZR/PIN) */
  requireBook: null,
  /** @type {boolean} keep only genuine two-way markets */
  twoSidedOnly: false,

  // 3 — data quality
  /** @type {number|null} minimum season PA (batters) / BF (pitchers) */
  minSample: null,
  /** @type {boolean} drop rows flagged SMALL SAMPLE */
  excludeSmallSample: false,
  /** @type {boolean} batters only from confirmed lineups */
  confirmedLineupOnly: false,
  /** @type {boolean} drop arms flagged BULK/OPENER RISK */
  excludeBulkOpener: false,
  /** @type {boolean} drop arms flagged SHORT LEASH */
  excludeShortLeash: false,

  // 4 — slate & market
  /** @type {string[]} market keys to keep; [] = all */
  markets: [],
  /** @type {string[]} row kinds to keep; all three = no filter */
  kinds: [...KIND_CHOICES],
  /** @type {string|null} earliest first pitch, local "HH:MM" */
  startAfter: null,
  /** @type {string|null} latest first pitch, local "HH:MM" */
  startBefore: null,
  /** @type {string[]} team abbreviations to keep; [] = all */
  teams: [],
  /** @type {string[]} "AWY @ HOM" matchups to keep; [] = all */
  games: [],
  /** @type {boolean} hide alternate-line rungs (on by default, as before) */
  hideAlts: true,
});

function cleanNum(v, { min, max, integer } = {}) {
  const n = toNum(v);
  if (n == null) return null;
  let out = integer ? Math.round(n) : n;
  if (min != null && out < min) out = min;
  if (max != null && out > max) out = max;
  return out;
}

function cleanList(v, allowed) {
  if (!Array.isArray(v)) return null;
  const set = allowed ? new Set(allowed) : null;
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    if (set && !set.has(item)) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Coerce anything (a restored localStorage blob, a partial patch) into a full,
 * well-typed criteria object. Unknown keys are dropped; malformed values fall
 * back to their default.
 */
export function normalizeCriteria(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const bool = (k) => (typeof c[k] === 'boolean' ? c[k] : DEFAULT_CRITERIA[k]);
  const verdicts = cleanList(c.verdicts, VERDICT_TIERS);
  const kinds = cleanList(c.kinds, KIND_CHOICES);
  const markets = cleanList(c.markets, MARKET_CHOICES.map((m) => m.key));
  const teams = cleanList(c.teams);
  const games = cleanList(c.games);

  return {
    minEdge: cleanNum(c.minEdge, { min: 0, max: 1 }),
    minEv: cleanNum(c.minEv),
    // An empty tier list would hide everything with no way back; treat it as
    // "all tiers", which is also the default.
    verdicts: verdicts && verdicts.length ? verdicts : [...VERDICT_TIERS],
    minKelly: cleanNum(c.minKelly, { min: 0, max: 1 }),

    oddsMin: cleanNum(c.oddsMin, { integer: true }),
    oddsMax: cleanNum(c.oddsMax, { integer: true }),
    maxVig: cleanNum(c.maxVig, { min: 0 }),
    minBooks: cleanNum(c.minBooks, { min: 0, integer: true }),
    requireBook: BOOK_CHOICES.includes(c.requireBook) ? c.requireBook : null,
    twoSidedOnly: bool('twoSidedOnly'),

    minSample: cleanNum(c.minSample, { min: 0, integer: true }),
    excludeSmallSample: bool('excludeSmallSample'),
    confirmedLineupOnly: bool('confirmedLineupOnly'),
    excludeBulkOpener: bool('excludeBulkOpener'),
    excludeShortLeash: bool('excludeShortLeash'),

    markets: markets || [],
    kinds: kinds && kinds.length ? kinds : [...KIND_CHOICES],
    startAfter: parseHm(c.startAfter) != null ? c.startAfter.trim() : null,
    startBefore: parseHm(c.startBefore) != null ? c.startBefore.trim() : null,
    teams: teams || [],
    games: games || [],
    hideAlts: bool('hideAlts'),
  };
}

// ── 4. criterion specs ─────────────────────────────────────────────────────

const pct1 = (v) => `${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;
const pts = (v) => `${(v * 100).toFixed(1).replace(/\.0$/, '')} pts`;
const american = (v) => (v > 0 ? `+${v}` : `${v}`);

/**
 * One descriptor per criterion.
 *
 * @typedef {object} CriterionSpec
 * @property {string} key      Stable id, also used by `diagnoseCriteria`.
 * @property {string} group    Which of the four UI groups it belongs to.
 * @property {string[]} keys   Criteria fields this spec owns (reset together).
 * @property {(c:object)=>boolean} active  Is this criterion doing anything?
 * @property {(row:object, c:object)=>boolean} test  Keep the row?
 * @property {(c:object)=>string} label  Human-readable statement of the rule.
 */

export const GROUPS = {
  edge: 'Edge & confidence',
  odds: 'Odds & book',
  data: 'Data quality',
  slate: 'Slate & market',
};

/** @type {CriterionSpec[]} */
export const CRITERION_SPECS = [
  // ── edge & confidence ──
  {
    key: 'minEdge',
    group: GROUPS.edge,
    keys: ['minEdge'],
    active: (c) => c.minEdge != null,
    test: (row, c) => {
      const v = rowEdgePts(row);
      return v != null && v >= c.minEdge;
    },
    label: (c) => `edge ≥ ${pts(c.minEdge)}`,
  },
  {
    key: 'minEv',
    group: GROUPS.edge,
    keys: ['minEv'],
    active: (c) => c.minEv != null,
    test: (row, c) => {
      const v = rowEv(row);
      return v != null && v >= c.minEv;
    },
    label: (c) => `EV ≥ ${c.minEv}%`,
  },
  {
    key: 'verdicts',
    group: GROUPS.edge,
    keys: ['verdicts'],
    active: (c) => c.verdicts.length < VERDICT_TIERS.length,
    test: (row, c) => {
      const v = row?.edge?.verdict;
      return typeof v === 'string' && c.verdicts.includes(v);
    },
    label: (c) => `verdict in ${c.verdicts.join('/')}`,
  },
  {
    key: 'minKelly',
    group: GROUPS.edge,
    keys: ['minKelly'],
    active: (c) => c.minKelly != null,
    test: (row, c) => {
      const v = rowKelly(row);
      return v != null && v >= c.minKelly;
    },
    label: (c) => `¼-Kelly ≥ ${pct1(c.minKelly)} of bankroll`,
  },

  // ── odds & book ──
  {
    key: 'odds',
    group: GROUPS.odds,
    keys: ['oddsMin', 'oddsMax'],
    active: (c) => c.oddsMin != null || c.oddsMax != null,
    test: (row, c) => {
      const v = rowOdds(row);
      if (v == null) return false;
      if (c.oddsMin != null && v < c.oddsMin) return false;
      if (c.oddsMax != null && v > c.oddsMax) return false;
      return true;
    },
    label: (c) =>
      c.oddsMin != null && c.oddsMax != null
        ? `price ${american(c.oddsMin)}…${american(c.oddsMax)}`
        : c.oddsMin != null
          ? `price ≥ ${american(c.oddsMin)}`
          : `price ≤ ${american(c.oddsMax)}`,
  },
  {
    key: 'maxVig',
    group: GROUPS.odds,
    keys: ['maxVig'],
    active: (c) => c.maxVig != null,
    test: (row, c) => {
      const v = rowVig(row);
      return v != null && v <= c.maxVig;
    },
    label: (c) => `vig ≤ ${pct1(c.maxVig)}`,
  },
  {
    key: 'minBooks',
    group: GROUPS.odds,
    keys: ['minBooks'],
    active: (c) => c.minBooks != null,
    test: (row, c) => {
      const v = rowBookCount(row);
      return v != null && v >= c.minBooks;
    },
    label: (c) => `${c.minBooks}+ books`,
  },
  {
    key: 'requireBook',
    group: GROUPS.odds,
    keys: ['requireBook'],
    active: (c) => !!c.requireBook,
    test: (row, c) => rowBooks(row).has(c.requireBook),
    label: (c) => `priced at ${c.requireBook}`,
  },
  {
    key: 'twoSidedOnly',
    group: GROUPS.odds,
    keys: ['twoSidedOnly'],
    active: (c) => c.twoSidedOnly,
    test: (row) => rowTwoSided(row),
    label: () => 'two-sided markets only',
  },

  // ── data quality ──
  {
    key: 'minSample',
    group: GROUPS.data,
    keys: ['minSample'],
    active: (c) => c.minSample != null,
    test: (row, c) => rowSample(row) >= c.minSample,
    label: (c) => `sample ≥ ${c.minSample} PA/BF`,
  },
  {
    key: 'excludeSmallSample',
    group: GROUPS.data,
    keys: ['excludeSmallSample'],
    active: (c) => c.excludeSmallSample,
    test: (row) => !hasFlag(row, FLAG_SMALL_SAMPLE),
    label: () => `no ${FLAG_SMALL_SAMPLE}`,
  },
  {
    key: 'confirmedLineupOnly',
    group: GROUPS.data,
    keys: ['confirmedLineupOnly'],
    active: (c) => c.confirmedLineupOnly,
    test: (row) => isConfirmedLineup(row),
    label: () => 'confirmed lineups only',
  },
  {
    key: 'excludeBulkOpener',
    group: GROUPS.data,
    keys: ['excludeBulkOpener'],
    active: (c) => c.excludeBulkOpener,
    test: (row) => !hasFlag(row, FLAG_BULK_OPENER),
    label: () => `no ${FLAG_BULK_OPENER}`,
  },
  {
    key: 'excludeShortLeash',
    group: GROUPS.data,
    keys: ['excludeShortLeash'],
    active: (c) => c.excludeShortLeash,
    test: (row) => !hasFlag(row, FLAG_SHORT_LEASH),
    label: () => `no ${FLAG_SHORT_LEASH}`,
  },

  // ── slate & market ──
  {
    key: 'markets',
    group: GROUPS.slate,
    keys: ['markets'],
    active: (c) => c.markets.length > 0,
    test: (row, c) => c.markets.includes(row?.market),
    label: (c) =>
      c.markets.length <= 3
        ? `market: ${c.markets.map(marketLabel).join(', ')}`
        : `${c.markets.length} markets selected`,
  },
  {
    key: 'kinds',
    group: GROUPS.slate,
    keys: ['kinds'],
    active: (c) => c.kinds.length < KIND_CHOICES.length,
    test: (row, c) => c.kinds.includes(row?.kind),
    label: (c) => `${c.kinds.map((k) => KIND_LABEL[k] || k).join(' + ')} only`,
  },
  {
    key: 'startWindow',
    group: GROUPS.slate,
    keys: ['startAfter', 'startBefore'],
    active: (c) => c.startAfter != null || c.startBefore != null,
    test: (row, c) => {
      const t = rowStartMinutes(row);
      if (t == null) return false;
      const after = parseHm(c.startAfter);
      const before = parseHm(c.startBefore);
      if (after != null && t < after) return false;
      if (before != null && t > before) return false;
      return true;
    },
    label: (c) =>
      c.startAfter != null && c.startBefore != null
        ? `first pitch ${c.startAfter}–${c.startBefore}`
        : c.startAfter != null
          ? `first pitch from ${c.startAfter}`
          : `first pitch until ${c.startBefore}`,
  },
  {
    key: 'teams',
    group: GROUPS.slate,
    keys: ['teams'],
    active: (c) => c.teams.length > 0,
    test: (row, c) => {
      const teams = rowTeams(row);
      return c.teams.some((t) => teams.has(t));
    },
    label: (c) =>
      c.teams.length <= 4 ? `teams: ${c.teams.join(', ')}` : `${c.teams.length} teams selected`,
  },
  {
    key: 'games',
    group: GROUPS.slate,
    keys: ['games'],
    active: (c) => c.games.length > 0,
    test: (row, c) => c.games.includes(rowGame(row)),
    label: (c) =>
      c.games.length <= 2 ? `game: ${c.games.join(', ')}` : `${c.games.length} games selected`,
  },
  {
    key: 'hideAlts',
    group: GROUPS.slate,
    keys: ['hideAlts'],
    active: (c) => c.hideAlts,
    test: (row) => !row?.alt,
    label: () => 'alternate lines hidden',
  },
];

// ── 5. the public API ──────────────────────────────────────────────────────

/**
 * Specs currently narrowing the board, in declaration order.
 *
 * Note this includes `hideAlts`, which is on by default: it genuinely removes
 * rows, so the empty-state diagnostics must consider it.
 */
export function activeSpecs(criteria) {
  const c = normalizeCriteria(criteria);
  return CRITERION_SPECS.filter((spec) => spec.active(c));
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/**
 * Specs the user has moved off their default. This — not `activeSpecs` — is
 * what the Filters badge counts, so a fresh install reads "no filters set"
 * even though alternate lines are hidden by default.
 */
export function changedSpecs(criteria) {
  const c = normalizeCriteria(criteria);
  return CRITERION_SPECS.filter(
    (spec) => !spec.keys.every((k) => sameValue(c[k], DEFAULT_CRITERIA[k])),
  );
}

/** Badge count on the Filters button: criteria moved off their default. */
export function countActiveCriteria(criteria) {
  return changedSpecs(criteria).length;
}

/** One human-readable phrase per active criterion. */
export function describeCriteria(criteria) {
  const c = normalizeCriteria(criteria);
  return activeSpecs(c).map((spec) => spec.label(c));
}

/** True when every criterion still sits at its default. */
export function isDefaultCriteria(criteria) {
  return changedSpecs(criteria).length === 0;
}

/**
 * Filter a row list down to the rows satisfying every active criterion.
 *
 * @param {object[]} rows
 * @param {object} criteria - partial or full; normalised internally.
 * @returns {object[]} a new array (never the input)
 */
export function applyCriteria(rows, criteria) {
  const list = Array.isArray(rows) ? rows : [];
  const c = normalizeCriteria(criteria);
  const specs = CRITERION_SPECS.filter((spec) => spec.active(c));
  if (!specs.length) return list.slice();
  return list.filter((row) => specs.every((spec) => spec.test(row, c)));
}

/** Reset the fields owned by one criterion back to their defaults. */
export function relaxCriterion(criteria, key) {
  const c = normalizeCriteria(criteria);
  const spec = CRITERION_SPECS.find((s) => s.key === key);
  if (!spec) return c;
  const patch = {};
  for (const field of spec.keys) patch[field] = clone(DEFAULT_CRITERIA[field]);
  return normalizeCriteria({ ...c, ...patch });
}

function clone(v) {
  return Array.isArray(v) ? [...v] : v;
}

/**
 * For each active criterion, how many rows come back if that criterion alone
 * is relaxed. Sorted most-recovered first, so the caller can name the single
 * filter doing the most damage.
 *
 * @param {object[]} rows - the UNFILTERED rows for the board in question.
 * @returns {Array<{key:string, label:string, group:string, recovered:number}>}
 */
export function diagnoseCriteria(rows, criteria) {
  const c = normalizeCriteria(criteria);
  const kept = applyCriteria(rows, c).length;
  return activeSpecs(c)
    .map((spec) => ({
      key: spec.key,
      group: spec.group,
      label: spec.label(c),
      recovered: applyCriteria(rows, relaxCriterion(c, spec.key)).length - kept,
    }))
    .sort((a, b) => b.recovered - a.recovered);
}

/**
 * Honest empty state for a board that is showing nothing.
 *
 * @param {object[]} rows - the unfiltered rows the board would show.
 * @param {object} criteria
 * @returns {{headline:string, detail:string}|null} null when the criteria are
 *   not the reason the board is empty (caller should show its own message).
 */
export function explainEmpty(rows, criteria) {
  const c = normalizeCriteria(criteria);
  const specs = activeSpecs(c);
  if (!specs.length) return null;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  const diag = diagnoseCriteria(list, c);
  const blockers = diag.filter((d) => d.recovered > 0);
  const all = diag.map((d) => d.label).join(' · ');

  if (!blockers.length)
    return {
      headline: `All ${list.length} rows are excluded by your filters.`,
      detail: `No single filter is responsible — ${specs.length} are active together (${all}). Loosen a few, or hit Reset.`,
    };

  const top = blockers[0];
  const rest = blockers.slice(1, 3);
  const restText = rest.length
    ? ` Next: ${rest.map((d) => `${d.label} (+${d.recovered})`).join(', ')}.`
    : '';

  return {
    headline: `Filtered out all ${list.length} rows.`,
    detail: `“${top.label}” is the biggest cut — relaxing just that brings back ${top.recovered} row${
      top.recovered === 1 ? '' : 's'
    }.${restText} Active: ${all}.`,
  };
}

// ── 6. persistence ─────────────────────────────────────────────────────────

export const CRITERIA_STORAGE_KEY = 'criteriaV1';
/** Pre-criteria key that owned the alt-line toggle; kept in sync both ways. */
export const LEGACY_ALTS_KEY = 'showAlts';

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Restore criteria from `criteriaV1`. On a first run the alt-line rule is
 * seeded from the pre-existing `showAlts` key so an upgrading user keeps their
 * setting. Any parse failure falls back to the defaults rather than throwing.
 */
export function loadCriteria() {
  const ls = storage();
  if (!ls) return normalizeCriteria(DEFAULT_CRITERIA);
  try {
    const raw = ls.getItem(CRITERIA_STORAGE_KEY);
    if (raw) return normalizeCriteria(JSON.parse(raw));
  } catch {}
  return normalizeCriteria({ hideAlts: ls.getItem(LEGACY_ALTS_KEY) !== 'on' });
}

/** Persist criteria, mirroring the alt rule back onto the legacy key. */
export function saveCriteria(criteria) {
  const c = normalizeCriteria(criteria);
  const ls = storage();
  if (!ls) return c;
  try {
    ls.setItem(CRITERIA_STORAGE_KEY, JSON.stringify(c));
    ls.setItem(LEGACY_ALTS_KEY, c.hideAlts ? 'off' : 'on');
  } catch {}
  return c;
}
