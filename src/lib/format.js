// Display formatting helpers (minified: `L`) plus the slate-date helper
// (minified: `Li`).
//
// Every formatter is null/NaN tolerant and renders an em dash for "no value",
// so callers can pass raw model output straight through without guarding.

export const fmt = {
  // One decimal place. Rounds to 1dp first so `toFixed` never sees a value
  // that would round differently (e.g. 0.05 float noise).
  n1: (v) => (v == null || isNaN(v) ? '—' : (Math.round(v * 10) / 10).toFixed(1)),

  // Two decimal places — used for low-rate markets (HR, SB) where 1dp
  // collapses everything to 0.0/0.1.
  n2: (v) => (v == null || isNaN(v) ? '—' : (Math.round(v * 100) / 100).toFixed(2)),

  // Probability 0..1 → whole percent.
  pct: (v) => (v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'),

  // American odds, always signed.
  odds: (v) => (v == null || isNaN(v) ? '—' : v > 0 ? `+${v}` : `${v}`),

  // Expected value, already expressed in percent (not a 0..1 fraction).
  ev: (v) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'),

  // Local wall-clock time of a game/timestamp, e.g. "7:05 PM".
  time: (v) => new Date(v).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
};

/**
 * Local-timezone `YYYY-MM-DD` for today plus `dayOffset` days.
 *
 * Built from the local date parts (not `toISOString()`) on purpose: the slate
 * date must match the user's calendar day, not UTC's.
 *
 * @param {number} dayOffset days from today; negative looks backwards
 *   (RESULTS defaults to `slateDate(-1)`).
 */
export function slateDate(dayOffset = 0) {
  // 864e5 = 86_400_000 ms per day.
  const d = new Date(Date.now() + dayOffset * 864e5);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
