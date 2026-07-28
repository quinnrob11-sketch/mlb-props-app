import { flattenRows } from "./rows.js";
import { rowLineupSource } from "./filters.js";
import {
  DAY_SCHEMA,
  SCHEMA_VERSION,
  buildExport,
  gradedKey,
  parseGradedDay,
  parseImport,
  readGradedHistory,
} from "../analysis/profitability.js";

/**
 * localStorage persistence for slates (bundle: `Os`, `hh`, `mh`, `kh`, `Sh`).
 *
 * Four stores, all keyed by slate date:
 *   `snap:<date>`  — bet-time projection snapshot, append-only. This is what
 *                    RESULTS grades against, so a row is written once and
 *                    never overwritten: the first price you saw is the price
 *                    you are held to.
 *   `close:<date>` — last-seen prices per line, overwritten on every refresh.
 *                    The final value before first pitch is the "close" that
 *                    CLV is measured against.
 *   `graded:<date>` — the day's snapshot rows after RESULTS has scored them
 *                    against the boxscores, cached so the cumulative profit
 *                    breakdown never has to refetch. Schema and field list are
 *                    documented at the top of src/analysis/profitability.js.
 *   `slateCacheV19` — the whole slate, for instant reload (see serializeSlate).
 *
 * Every write is wrapped in try/catch: a full or disabled localStorage must
 * never break a slate load.
 */

/**
 * |probability edge| in points for a snapshot row's edge object, rounded to
 * three decimals. Prefers `sideEdge` (already signed toward the called side)
 * and falls back to the raw over-signed `edge`.
 */
function edgePointsOf(edge) {
  const v = edge?.sideEdge ?? edge?.edge;
  return typeof v === "number" && Number.isFinite(v)
    ? Math.round(Math.abs(v) * 1e3) / 1e3
    : null;
}

/** Stable identity for a snapshot row. Alternate lines get their own row. */
export function snapshotRowKey(row) {
  return `${row.kind}:${row.playerId}:${row.market}${row.alt ? ":alt" + row.line : ""}`;
}

/**
 * Append any newly-seen priced rows to the day's snapshot. Rows already
 * present are left untouched, which is what freezes the bet-time record.
 */
export function saveSnapshot(date, slate) {
  try {
    const storeKey = `snap:${date}`;
    const existing = JSON.parse(localStorage.getItem(storeKey) || "null");
    const rows = Array.isArray(existing?.rows) ? [...existing.rows] : [];
    const seen = new Set(rows.map(snapshotRowKey));

    for (const row of flattenRows(slate)) {
      if (row.line == null || !row.edge || seen.has(snapshotRowKey(row)))
        continue;
      seen.add(snapshotRowKey(row));
      rows.push({
        playerId: row.playerId,
        name: row.name,
        kind: row.kind,
        market: row.market,
        short: row.short,
        label: row.label,
        distKey: row.distKey,
        line: row.line,
        book: row.book,
        alt: row.alt || undefined,
        side: row.edge.side,
        verdict: row.edge.verdict,
        proj: Math.round(row.proj * 100) / 100,
        modelOver: Math.round(row.edge.modelOver * 1e3) / 1e3,
        ev: row.edge.ev != null ? Math.round(row.edge.ev * 10) / 10 : null,
        // |probability edge| in points, signed toward the called side where
        // that is available. The profit breakdown buckets on it, and it cannot
        // be recovered later from the fields above.
        edgePts: edgePointsOf(row.edge),
        odds: row.edge.odds,
        team: row.team,
        matchup: row.matchup,
        // Provenance the breakdown slices on. Both are `undefined` when the
        // slate does not carry them, which keeps the JSON the same size as
        // before for rows that have nothing to say.
        lineupSource: rowLineupSource(row) || undefined,
        flags: row.flags?.length ? [...row.flags] : undefined,
      });
    }

    localStorage.setItem(
      storeKey,
      JSON.stringify({
        date,
        savedAt: existing?.savedAt || new Date().toISOString(),
        rows,
      }),
    );
  } catch {}
}

/**
 * Overwrite the closing-line store with the current two-sided prices.
 * Note the key here includes the line but not the alt marker, unlike
 * snapshotRowKey.
 */
export function saveClosingLines(date, slate) {
  try {
    const storeKey = `close:${date}`;
    const store = JSON.parse(localStorage.getItem(storeKey) || "{}");
    for (const row of flattenRows(slate)) {
      if (row.line == null) continue;
      store[`${row.kind}:${row.playerId}:${row.market}:${row.line}`] = {
        over: row.over,
        under: row.under,
        ts: Date.now(),
      };
    }
    localStorage.setItem(storeKey, JSON.stringify(store));
  } catch {}
}

// ── graded history ─────────────────────────────────────────────────────────
//
// Grading a date costs one schedule fetch plus one boxscore fetch per game, so
// the outcome is cached under `graded:<date>` and never recomputed. Everything
// below is best-effort: a full or disabled localStorage degrades to "no
// history", never to an exception.

/** Slate dates that have a bet-time snapshot, newest first. */
export function listSnapshotDates() {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith("snap:"))
      .map((k) => k.slice(5))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The bet-time snapshot for a date, or null. */
export function loadSnapshot(date) {
  try {
    const snap = JSON.parse(localStorage.getItem(`snap:${date}`) || "null");
    return snap && Array.isArray(snap.rows) ? snap : null;
  } catch {
    return null;
  }
}

/** Cache one graded day. Overwrites any previous grading of that date. */
export function saveGradedDay(date, rows) {
  try {
    localStorage.setItem(
      gradedKey(date),
      JSON.stringify({
        schema: DAY_SCHEMA,
        version: SCHEMA_VERSION,
        date,
        gradedAt: new Date().toISOString(),
        rows,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** One cached graded day, or null. */
export function loadGradedDay(date) {
  try {
    return parseGradedDay(localStorage.getItem(gradedKey(date)), date);
  } catch {
    return null;
  }
}

/** Dates already graded and cached, newest first. */
export function listGradedDates() {
  return loadGradedHistory()
    .map((d) => d.date)
    .sort()
    .reverse();
}

/** Every cached graded day, oldest first. */
export function loadGradedHistory() {
  try {
    return readGradedHistory(localStorage);
  } catch {
    return [];
  }
}

/**
 * Snapshot dates that are worth grading: strictly before `today` (a slate that
 * has not finished cannot be graded) and not already cached.
 */
export function ungradedDates(today) {
  const done = new Set(listGradedDates());
  return listSnapshotDates()
    .filter((d) => d < today && !done.has(d))
    .sort();
}

/** The whole graded history in the documented export envelope. */
export function exportGradedHistory() {
  return buildExport(loadGradedHistory());
}

/**
 * Write an imported export file back into localStorage.
 *
 * Days are written whole, so importing a file re-grades nothing and simply
 * replaces the matching dates.
 *
 * @returns {{days:number, rows:number, dates:string[], errors:string[]}}
 */
export function importGradedHistory(payload) {
  const { days, errors } = parseImport(payload);
  const written = [];
  let rows = 0;
  for (const day of days) {
    try {
      localStorage.setItem(
        gradedKey(day.date),
        JSON.stringify({ ...day, schema: DAY_SCHEMA }),
      );
      written.push(day.date);
      rows += day.rows.length;
    } catch {
      errors.push(`Could not store ${day.date} — storage is full.`);
    }
  }
  return { days: written.length, rows, dates: written.sort(), errors };
}

/**
 * Strip the non-serialisable bits of a slate so it can be cached (bundle: `kh`).
 * `proj.dist` holds closures over the distribution model — drop them.
 */
export function serializeSlate(slate) {
  return JSON.parse(
    JSON.stringify(slate, (key, value) => (key === "dist" ? undefined : value)),
  );
}

/**
 * Revive a cached slate (bundle: `Sh`). The dropped `dist` closures are
 * replaced with a Proxy whose every property is a function returning null, so
 * the cards render "—" instead of throwing until a real load replaces them.
 */
export function reviveSlate(slate) {
  const nullDist = new Proxy({}, { get: () => () => null });
  for (const game of slate.games || []) {
    for (const p of game.pitchers || []) {
      if (p.proj && !p.proj.dist) p.proj.dist = nullDist;
      p.props = p.props || [];
      p.flags = p.flags || [];
    }
    for (const b of game.batters || []) {
      if (b.proj && !b.proj.dist) b.proj.dist = nullDist;
      b.props = b.props || [];
      b.flags = b.flags || [];
    }
  }
  return slate;
}
