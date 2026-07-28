/**
 * Cumulative profitability analysis — "which aspect of the model actually makes
 * money?"
 *
 * Pure, DOM-free. Everything here operates on plain graded rows; the only
 * environment touch is an optional Storage-like object passed into
 * `readGradedHistory`, which is duck-typed so tests can hand it a plain map.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STORAGE / EXPORT SCHEMA
 * ─────────────────────────────────────────────────────────────────────────────
 * RESULTS caches one graded day per localStorage key, `graded:<YYYY-MM-DD>`:
 *
 *   GradedDay {
 *     schema:   "recon.graded-day"        // sentinel, always this string
 *     version:  1                          // SCHEMA_VERSION
 *     date:     "2026-07-14"               // slate date, local calendar day
 *     gradedAt: "2026-07-15T04:12:09.881Z" // when the boxscores were read
 *     rows:     GradedRow[]
 *   }
 *
 *   GradedRow — a bet-time snapshot row (see snapshotStore.saveSnapshot) plus
 *   the three fields grading adds. Every field is optional except `result`;
 *   rows written by older builds simply lack the newer ones and are treated as
 *   "unknown" by the dimension that reads them.
 *
 *     playerId     number   MLB person id
 *     name         string   "Tarik Skubal"
 *     kind         string   "pitcher" | "batter" | "nrfi"
 *     market       string   "pitcher_strikeouts" | …
 *     short        string   "K"
 *     label        string   "Strikeouts"
 *     distKey      string   key used to pull the actual out of the boxscore
 *     line         number   the point that was bet
 *     book         string   "DK" | "FD" | "MGM" | "CZR" | "PIN"
 *     alt          boolean  true when this is an alternate-ladder rung
 *     side         string   "over" | "under" — the side the model called
 *     verdict      string   "STRONG" | "SOLID" | "LEAN" | "PASS"
 *     proj         number   model point estimate
 *     modelOver    number   raw model P(over)
 *     ev           number   EV in percent of stake, at the price taken
 *     edgePts      number   |probability edge| in points (0.06 = 6 pts)
 *     odds         number   American odds actually taken
 *     team         string
 *     matchup      string   "DET @ CLE"
 *     lineupSource string   "confirmed" | "projected" | "fallback"
 *     flags        string[] player flags, e.g. ["SMALL SAMPLE"]
 *     actual       number   what the player actually did (null when no data)
 *     result       string   "WIN" | "LOSS" | "PUSH" | "NO DATA" | "—"
 *     closeOdds    number   closing American price on the side taken
 *     clv          number   closing line value, in percent of decimal price
 *
 * The export file wraps every cached day:
 *
 *   GradedHistoryFile {
 *     schema:     "recon.graded-history"
 *     version:    1
 *     exportedAt: "2026-07-28T18:00:00.000Z"
 *     nDays:      7
 *     nRows:      1843
 *     days:       GradedDay[]     // sorted by date ascending
 *   }
 *
 * `importGradedHistory` accepts that file, a bare `GradedDay[]`, or a single
 * `GradedDay`, so a file hand-edited by whoever the user sends it to still
 * loads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS MEASURED
 * ─────────────────────────────────────────────────────────────────────────────
 * ROI is the only ranking metric. Hit rate across cells priced differently is
 * not comparable — 60% at −200 loses money, 45% at +130 makes it — so every
 * cell is scored in units risked at the price actually taken:
 *
 *   WIN  → decimal(odds) − 1     (+0.909 at −110)
 *   LOSS → −1
 *   PUSH →  0, and the stake is not counted as risked
 *
 *   roi = units / (wins + losses)
 *
 * Pushes are excluded from hit rate and from the ROI denominator but are still
 * counted in `n`, because "how often did this cell come up" is a different
 * question from "how often did it win".
 */

// ── schema constants ───────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const DAY_SCHEMA = 'recon.graded-day';
export const HISTORY_SCHEMA = 'recon.graded-history';

/** localStorage key prefix for one cached graded day. */
export const GRADED_PREFIX = 'graded:';

/** localStorage key for one cached graded day. */
export const gradedKey = (date) => `${GRADED_PREFIX}${date}`;

/**
 * Minimum settled (non-push) picks in a cell before it may be ranked or named
 * as a leader. Twenty-five is not a lot of baseball, but it is the point at
 * which a 60% cell's Wilson interval stops containing 35%.
 */
export const MIN_N = 25;

/**
 * Minimum settled picks across the whole history before any leader is named at
 * all. Below this the honest answer is "come back in a fortnight".
 */
export const MIN_HISTORY = 50;

/** z for a 95% interval. */
const Z95 = 1.959963984540054;

// ── odds maths ─────────────────────────────────────────────────────────────

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** American odds → decimal (payout multiple incl. stake). Null-tolerant. */
export function toDecimal(american) {
  const a = num(american);
  if (a == null || a === 0) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

/**
 * Profit in units from a 1-unit stake.
 * @returns {number|null} null when the row did not settle.
 */
export function unitsFor(result, odds) {
  const r = typeof result === 'string' ? result.toUpperCase() : null;
  if (r === 'PUSH') return 0;
  if (r === 'LOSS') return -1;
  if (r !== 'WIN') return null;
  const dec = toDecimal(odds);
  return dec == null ? null : dec - 1;
}

/**
 * American odds on the continuous "cents" number line used by every
 * bet-tracking convention: +100 and −100 are the same point (0), −110 is −10,
 * +110 is +10. Taking +105 into a −105 close is therefore a 10-cent beat.
 */
export function centsLine(american) {
  const a = num(american);
  if (a == null) return null;
  return a > 0 ? a - 100 : a + 100;
}

/** CLV in cents: how many cents better than the close the taken price was. */
export function clvCents(oddsTaken, closeOdds) {
  const taken = centsLine(oddsTaken);
  const close = centsLine(closeOdds);
  return taken == null || close == null ? null : taken - close;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * The endpoints are the two p solving |p̂ − p| = z·√(p(1−p)/n), i.e. the score
 * test inverted — which is why a 4-0 cell comes back as [0.51, 1.00] instead of
 * the [1, 1] a naive Wald interval would report.
 *
 * @returns {{lo:number, hi:number}|null} null for n <= 0.
 */
export function wilson(wins, n, z = Z95) {
  const w = num(wins);
  const total = num(n);
  if (w == null || total == null || total <= 0) return null;
  const p = w / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return {
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
  };
}

// ── buckets ────────────────────────────────────────────────────────────────

/**
 * American-odds bands. Chosen so the two bands that matter for a props bettor
 * are separated: −120…+120 is where most main lines live, and anything longer
 * than +250 is a price the verdict ladder refuses outright.
 */
export const ODDS_BUCKETS = [
  { key: 'heavyfav', label: 'Heavy favourite (≤ −200)', test: (o) => o <= -200 },
  { key: 'fav', label: 'Favourite (−199…−121)', test: (o) => o <= -121 },
  { key: 'even', label: 'Near-even (−120…+120)', test: (o) => o <= 120 },
  { key: 'plus', label: 'Plus money (+121…+250)', test: (o) => o <= 250 },
  { key: 'longshot', label: 'Longshot (> +250)', test: () => true },
];

export function oddsBucket(odds) {
  const o = num(odds);
  if (o == null) return null;
  return ODDS_BUCKETS.find((b) => b.test(o));
}

/** Probability edge in points (0.06 → "5–7 pts"). */
export const EDGE_BUCKETS = [
  { key: 'e0', label: '0–3 pts', max: 0.03 },
  { key: 'e3', label: '3–5 pts', max: 0.05 },
  { key: 'e5', label: '5–7 pts', max: 0.07 },
  { key: 'e7', label: '7+ pts', max: Infinity },
];

export function edgeBucket(edgePts) {
  const e = num(edgePts);
  if (e == null) return null;
  const abs = Math.abs(e);
  return EDGE_BUCKETS.find((b) => abs < b.max) || EDGE_BUCKETS[EDGE_BUCKETS.length - 1];
}

/** EV in percent of stake. */
export const EV_BUCKETS = [
  { key: 'v0', label: 'under 2.5%', max: 2.5 },
  { key: 'v2', label: '2.5–5%', max: 5 },
  { key: 'v5', label: '5–10%', max: 10 },
  { key: 'v10', label: '10%+', max: Infinity },
];

export function evBucket(ev) {
  const v = num(ev);
  if (v == null) return null;
  return EV_BUCKETS.find((b) => v < b.max) || EV_BUCKETS[EV_BUCKETS.length - 1];
}

export const FLAG_SMALL_SAMPLE = 'SMALL SAMPLE';

// ── the dimensions ─────────────────────────────────────────────────────────

const bucketOf = (bucket) => (bucket ? { value: bucket.key, label: bucket.label } : null);

const plain = (v) => (v == null || v === '' ? null : { value: String(v), label: String(v) });

const KIND_LABEL = { pitcher: 'Pitchers', batter: 'Batters', nrfi: 'NRFI' };

const LINEUP_LABEL = {
  confirmed: 'Confirmed lineup',
  projected: 'Projected lineup',
  fallback: 'Fallback lineup',
};

/**
 * One descriptor per dimension. `of(row)` returns `{value, label}` or null when
 * the row cannot answer that question — a null is counted as `nUnknown` rather
 * than being bucketed into a fake "other" cell.
 *
 * `order` optionally fixes the natural ordering of a dimension's values so the
 * unranked/thin view still reads sensibly (STRONG before LEAN, short prices
 * before long ones).
 *
 * @type {Array<{key:string, label:string, blurb:string, of:(row:object)=>({value:string,label:string}|null), order?:string[]}>}
 */
export const DIMENSIONS = [
  {
    key: 'market',
    label: 'Market',
    blurb: 'Which prop type the model prices best.',
    of: (r) => (r.market ? { value: r.market, label: r.label || r.market } : null),
  },
  {
    key: 'kind',
    label: 'Pitcher / batter',
    blurb: 'Which half of the model earns.',
    of: (r) => (r.kind ? { value: r.kind, label: KIND_LABEL[r.kind] || r.kind } : null),
    order: ['pitcher', 'batter', 'nrfi'],
  },
  {
    key: 'verdict',
    label: 'Verdict tier',
    blurb: 'Whether the confidence ladder is monotonic in profit.',
    of: (r) => plain(r.verdict),
    order: ['STRONG', 'SOLID', 'LEAN'],
  },
  {
    key: 'side',
    label: 'Side',
    blurb: 'Over vs under — a persistent gap means a biased projection.',
    of: (r) => (r.side ? { value: r.side, label: r.side.toUpperCase() } : null),
    order: ['over', 'under'],
  },
  {
    key: 'book',
    label: 'Book',
    blurb: 'Where the beatable prices are.',
    of: (r) => plain(r.book),
  },
  {
    key: 'odds',
    label: 'Price taken',
    blurb: 'Whether the edge survives the juice.',
    of: (r) => bucketOf(oddsBucket(r.odds)),
    order: ODDS_BUCKETS.map((b) => b.key),
  },
  {
    key: 'edge',
    label: 'Edge size',
    blurb: 'Does a bigger disagreement with the market actually pay more?',
    of: (r) => bucketOf(edgeBucket(r.edgePts)),
    order: EDGE_BUCKETS.map((b) => b.key),
  },
  {
    key: 'ev',
    label: 'EV band',
    blurb: 'Does modelled EV predict realised EV?',
    of: (r) => bucketOf(evBucket(r.ev)),
    order: EV_BUCKETS.map((b) => b.key),
  },
  {
    key: 'line',
    label: 'Main vs alternate',
    blurb: 'Whether the alternate ladders are worth the extra credits.',
    of: (r) => (r.alt ? { value: 'alt', label: 'Alternate' } : { value: 'main', label: 'Main line' }),
    order: ['main', 'alt'],
  },
  {
    key: 'lineup',
    label: 'Lineup source',
    blurb: 'The cost of betting before lineups post.',
    of: (r) =>
      r.lineupSource
        ? { value: r.lineupSource, label: LINEUP_LABEL[r.lineupSource] || r.lineupSource }
        : null,
    order: ['confirmed', 'projected', 'fallback'],
  },
  {
    key: 'sample',
    label: 'Sample quality',
    blurb: 'What the SMALL SAMPLE flag is really worth.',
    of: (r) =>
      Array.isArray(r.flags)
        ? r.flags.includes(FLAG_SMALL_SAMPLE)
          ? { value: 'small', label: 'SMALL SAMPLE' }
          : { value: 'clean', label: 'Full sample' }
        : null,
    order: ['clean', 'small'],
  },
];

export const DIMENSION_BY_KEY = new Map(DIMENSIONS.map((d) => [d.key, d]));

// ── row selection ──────────────────────────────────────────────────────────

const SETTLED = new Set(['WIN', 'LOSS', 'PUSH']);

/**
 * A row counts toward profitability only if the model actually called it (a
 * side and a non-PASS verdict) and it settled against a real boxscore.
 */
export function isCountable(row) {
  if (!row || typeof row !== 'object') return false;
  const result = typeof row.result === 'string' ? row.result.toUpperCase() : '';
  if (!SETTLED.has(result)) return false;
  if (row.side !== 'over' && row.side !== 'under') return false;
  return typeof row.verdict === 'string' && row.verdict !== 'PASS';
}

// ── aggregation ────────────────────────────────────────────────────────────

function emptyAcc() {
  return {
    n: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    units: 0,
    unpriced: 0,
    clvCentsSum: 0,
    clvCentsN: 0,
    clvPctSum: 0,
    clvPctN: 0,
  };
}

function accumulate(acc, row) {
  const result = row.result.toUpperCase();
  acc.n += 1;
  if (result === 'WIN') acc.wins += 1;
  else if (result === 'LOSS') acc.losses += 1;
  else acc.pushes += 1;

  // A decided row with an unreadable price cannot be scored in units at all —
  // neither the profit nor the risked stake is known. It still counts toward n
  // and hit rate; `unpriced` keeps the ROI denominator honest by excluding it
  // for wins and losses alike.
  const priced = toDecimal(row.odds) != null;
  if (result !== 'PUSH' && !priced) acc.unpriced += 1;
  else acc.units += unitsFor(result, row.odds) ?? 0;

  const cents = clvCents(row.odds, row.closeOdds);
  if (cents != null) {
    acc.clvCentsSum += cents;
    acc.clvCentsN += 1;
  }
  const pct = num(row.clv);
  if (pct != null) {
    acc.clvPctSum += pct;
    acc.clvPctN += 1;
  }
}

/**
 * Close an accumulator into the reported cell shape.
 *
 * `decided` (wins + losses) is the denominator for hit rate, ROI and the Wilson
 * interval; `n` includes pushes.
 */
function finish(acc, extra = {}) {
  const decided = acc.wins + acc.losses;
  const priced = decided - acc.unpriced;
  return {
    ...extra,
    n: acc.n,
    wins: acc.wins,
    losses: acc.losses,
    pushes: acc.pushes,
    decided,
    unpriced: acc.unpriced,
    hitRate: decided > 0 ? acc.wins / decided : null,
    units: acc.units,
    roi: priced > 0 ? acc.units / priced : null,
    avgClvCents: acc.clvCentsN ? acc.clvCentsSum / acc.clvCentsN : null,
    avgClvPct: acc.clvPctN ? acc.clvPctSum / acc.clvPctN : null,
    ci: wilson(acc.wins, decided),
    qualified: decided >= (extra.minN ?? MIN_N),
  };
}

/**
 * Deterministic cell ordering: qualified cells first, then ROI descending, then
 * the larger sample, then the label. Every tiebreak is total, so the same input
 * always produces the same order regardless of insertion sequence.
 */
export function compareCells(a, b) {
  if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
  const ar = a.roi == null ? -Infinity : a.roi;
  const br = b.roi == null ? -Infinity : b.roi;
  if (br !== ar) return br - ar;
  if (b.decided !== a.decided) return b.decided - a.decided;
  if (b.n !== a.n) return b.n - a.n;
  return String(a.value).localeCompare(String(b.value));
}

/**
 * Aggregate rows along one dimension.
 *
 * @param {object[]} rows - countable graded rows.
 * @param {object|string} dimension - a DIMENSIONS entry or its key.
 * @param {{minN?:number}} [opts]
 * @returns {{key:string, label:string, blurb:string, cells:object[], leader:object|null, nUnknown:number, enough:boolean}}
 */
export function aggregateBy(rows, dimension, opts = {}) {
  const dim =
    typeof dimension === 'string' ? DIMENSION_BY_KEY.get(dimension) : dimension;
  if (!dim) throw new Error(`unknown dimension: ${dimension}`);
  const minN = opts.minN ?? MIN_N;

  const accs = new Map();
  let nUnknown = 0;

  for (const row of rows || []) {
    if (!isCountable(row)) continue;
    const hit = dim.of(row);
    if (!hit) {
      nUnknown += 1;
      continue;
    }
    let entry = accs.get(hit.value);
    if (!entry) {
      entry = { label: hit.label, acc: emptyAcc() };
      accs.set(hit.value, entry);
    }
    accumulate(entry.acc, row);
  }

  const order = dim.order || [];
  const cells = [...accs.entries()]
    .map(([value, { label, acc }]) =>
      finish(acc, {
        value,
        label,
        minN,
        rank: order.indexOf(value) === -1 ? order.length : order.indexOf(value),
      }),
    )
    .sort(compareCells);

  const qualified = cells.filter((c) => c.qualified && c.roi != null);

  return {
    key: dim.key,
    label: dim.label,
    blurb: dim.blurb,
    cells,
    qualified,
    // The best cell that clears the bar. `cells` is already sorted so the first
    // qualified entry is the ROI leader.
    leader: qualified[0] || null,
    nUnknown,
    enough: qualified.length > 0,
  };
}

/**
 * The whole picture: overall totals plus every dimension, with the single
 * best-performing dimension-value that clears both guards.
 *
 * @param {object[]} rows - graded rows across every date (uncountable rows are
 *   filtered here, so callers can pass everything).
 * @param {{minN?:number, minHistory?:number, dates?:string[]}} [opts]
 */
export function buildBreakdown(rows, opts = {}) {
  const minN = opts.minN ?? MIN_N;
  const minHistory = opts.minHistory ?? MIN_HISTORY;

  const all = (rows || []).filter(isCountable);
  const overallAcc = emptyAcc();
  const dateSet = new Set(opts.dates || []);
  for (const row of all) {
    accumulate(overallAcc, row);
    if (row.date) dateSet.add(row.date);
  }
  const overall = finish(overallAcc, { value: 'all', label: 'All picks', minN: minHistory });

  const dimensions = DIMENSIONS.map((dim) => aggregateBy(all, dim, { minN }));

  const nGraded = overall.n;
  const nSettled = overall.decided;
  const thin = nSettled < minHistory;

  // Rank across dimensions only once the history as a whole is worth ranking.
  let headline = null;
  if (!thin) {
    for (const dim of dimensions) {
      const leader = dim.leader;
      if (!leader) continue;
      if (!headline || leader.roi > headline.cell.roi) {
        headline = { dimension: dim.key, dimensionLabel: dim.label, cell: leader };
      } else if (
        leader.roi === headline.cell.roi &&
        leader.decided > headline.cell.decided
      ) {
        headline = { dimension: dim.key, dimensionLabel: dim.label, cell: leader };
      }
    }
  }

  return {
    nGraded,
    nSettled,
    nDates: dateSet.size,
    dates: [...dateSet].sort(),
    overall,
    dimensions,
    headline,
    thin,
    minN,
    minHistory,
    message: describeState({ nGraded, nSettled, thin, headline, minHistory, minN }),
  };
}

/** Plain-English state line. Never ranks noise. */
export function describeState({ nGraded, nSettled, thin, headline, minHistory, minN }) {
  if (!nGraded)
    return 'No graded picks yet. Grade your saved slates and this breakdown fills in.';
  if (thin)
    return `Only ${nSettled} settled pick${nSettled === 1 ? '' : 's'} so far — not enough to rank anything. ${minHistory} is the minimum before a leader is named; keep grading.`;
  if (!headline)
    return `${nSettled} settled picks, but no single cell has reached ${minN} yet. The totals below are real; the per-cell ordering is still noise.`;
  return `${nSettled} settled picks graded.`;
}

// ── storage ────────────────────────────────────────────────────────────────

/** Duck-type a Storage or a plain object into `{keys(), get(k)}`. */
function adapt(storage) {
  const s =
    storage ??
    (typeof globalThis !== 'undefined' && globalThis.localStorage) ??
    null;
  if (!s) return null;
  if (typeof s.getItem === 'function' && typeof s.key === 'function') {
    return {
      keys: () => {
        const out = [];
        for (let i = 0; i < s.length; i += 1) {
          const k = s.key(i);
          if (typeof k === 'string') out.push(k);
        }
        return out;
      },
      get: (k) => s.getItem(k),
    };
  }
  if (typeof s.getItem === 'function')
    return { keys: () => Object.keys(s), get: (k) => s.getItem(k) };
  return { keys: () => Object.keys(s), get: (k) => s[k] };
}

/** Parse a stored graded day, tolerating anything that is not one. */
export function parseGradedDay(raw, dateHint) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.rows)) return null;
  const date = typeof obj.date === 'string' ? obj.date : dateHint;
  if (!date) return null;
  return {
    schema: DAY_SCHEMA,
    version: num(obj.version) ?? SCHEMA_VERSION,
    date,
    gradedAt: typeof obj.gradedAt === 'string' ? obj.gradedAt : null,
    rows: obj.rows.filter((r) => r && typeof r === 'object'),
  };
}

/**
 * Every cached graded day, oldest first.
 *
 * @param {Storage|object} [storage] - defaults to `globalThis.localStorage`;
 *   under node, absent storage yields an empty history rather than throwing.
 */
export function readGradedHistory(storage) {
  const s = adapt(storage);
  if (!s) return [];
  const days = [];
  let keys = [];
  try {
    keys = s.keys();
  } catch {
    return [];
  }
  for (const key of keys) {
    if (!key.startsWith(GRADED_PREFIX)) continue;
    let day = null;
    try {
      day = parseGradedDay(s.get(key), key.slice(GRADED_PREFIX.length));
    } catch {
      day = null;
    }
    if (day) days.push(day);
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Flatten a history into rows, stamping each with the date it came from. */
export function flattenHistory(days) {
  const out = [];
  for (const day of days || [])
    for (const row of day.rows || []) out.push({ ...row, date: day.date });
  return out;
}

/** Read storage and build the breakdown in one call. */
export function breakdownFromStorage(storage, opts = {}) {
  const days = readGradedHistory(storage);
  const rows = flattenHistory(days);
  return buildBreakdown(rows, { ...opts, dates: days.map((d) => d.date) });
}

// ── export / import ────────────────────────────────────────────────────────

/** Wrap cached days in the documented export envelope. */
export function buildExport(days, now = new Date()) {
  const list = [...(days || [])].sort((a, b) => a.date.localeCompare(b.date));
  return {
    schema: HISTORY_SCHEMA,
    version: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    nDays: list.length,
    nRows: list.reduce((sum, d) => sum + (d.rows?.length || 0), 0),
    days: list,
  };
}

/**
 * Coerce an export file (or a bare array, or one day) into a list of days.
 *
 * @returns {{days:object[], errors:string[]}}
 */
export function parseImport(payload) {
  let obj = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch (err) {
      return { days: [], errors: [`Not valid JSON: ${err.message}`] };
    }
  }
  const raw = Array.isArray(obj)
    ? obj
    : Array.isArray(obj?.days)
      ? obj.days
      : obj && typeof obj === 'object' && Array.isArray(obj.rows)
        ? [obj]
        : null;
  if (!raw)
    return {
      days: [],
      errors: ['Unrecognised file — expected a graded-history export.'],
    };

  const errors = [];
  const days = [];
  for (const entry of raw) {
    const day = parseGradedDay(entry);
    if (day) days.push(day);
    else errors.push(`Skipped an entry with no usable date/rows.`);
  }
  if (!days.length && !errors.length) errors.push('File contained no graded days.');
  return { days, errors };
}
