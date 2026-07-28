// Unit tests for the cumulative profitability analysis
// (src/analysis/profitability.js).
//
//   node --test test/          (npm test)
//
// Pure module — no DOM, no React, no localStorage. The storage readers are
// handed plain objects and Storage-alikes instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIMENSIONS,
  GRADED_PREFIX,
  HISTORY_SCHEMA,
  MIN_HISTORY,
  MIN_N,
  aggregateBy,
  breakdownFromStorage,
  buildBreakdown,
  buildExport,
  centsLine,
  clvCents,
  compareCells,
  edgeBucket,
  evBucket,
  flattenHistory,
  isCountable,
  oddsBucket,
  parseImport,
  readGradedHistory,
  toDecimal,
  unitsFor,
  wilson,
} from '../src/analysis/profitability.js';

const near = (actual, expected, eps = 1e-9, what = '') =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${what} expected ${expected}, got ${actual}`,
  );

/** A settled, countable graded row with sensible defaults. */
function row(over = {}) {
  return {
    playerId: 1,
    kind: 'batter',
    market: 'batter_hits',
    label: 'Hits',
    line: 0.5,
    book: 'DK',
    side: 'over',
    verdict: 'SOLID',
    ev: 6,
    edgePts: 0.055,
    odds: -110,
    result: 'WIN',
    ...over,
  };
}

/** n copies of `over`, with distinct player ids. */
function rows(n, over = {}) {
  return Array.from({ length: n }, (_, i) => row({ playerId: i + 1, ...over }));
}

// ── odds maths ─────────────────────────────────────────────────────────────

test('toDecimal converts both signs of American odds', () => {
  near(toDecimal(-110), 1 + 100 / 110, 1e-12, '-110');
  near(toDecimal(100), 2, 1e-12, '+100');
  near(toDecimal(150), 2.5, 1e-12, '+150');
  near(toDecimal(-200), 1.5, 1e-12, '-200');
  assert.equal(toDecimal(null), null);
  assert.equal(toDecimal(0), null);
  assert.equal(toDecimal('nope'), null);
});

test('unitsFor pays the actual price on a win, one unit on a loss, zero on a push', () => {
  // -110 pays 100/110 = 0.909090… on a 1-unit stake.
  near(unitsFor('WIN', -110), 0.9090909090909091, 1e-12, 'win at -110');
  near(unitsFor('WIN', 120), 1.2, 1e-12, 'win at +120');
  assert.equal(unitsFor('LOSS', -110), -1);
  assert.equal(unitsFor('PUSH', -110), 0);
  assert.equal(unitsFor('NO DATA', -110), null);
  // A win with no readable price cannot be scored.
  assert.equal(unitsFor('WIN', null), null);
});

test('ROI at mixed odds is the units risked, not the hit rate', () => {
  // Worked by hand: 3 wins at -110 = 3 x 100/110 = +2.727272…, 2 losses = -2.
  // Net +0.727272… over 5 risked units = +14.5455% ROI. (The brief's "-0.27"
  // is the 3W-3L case, checked immediately below.)
  const five = [
    ...rows(3, { result: 'WIN' }),
    ...rows(2, { result: 'LOSS', playerId: 90 }),
  ];
  const dim = aggregateBy(five, 'market', { minN: 1 });
  const cell = dim.cells[0];
  assert.equal(cell.n, 5);
  assert.equal(cell.wins, 3);
  assert.equal(cell.losses, 2);
  assert.equal(cell.decided, 5);
  near(cell.units, 3 * (100 / 110) - 2, 1e-12, 'units');
  near(cell.units, 0.7272727272727275, 1e-12, 'units (literal)');
  near(cell.roi, 0.7272727272727275 / 5, 1e-12, 'roi');
  near(cell.roi * 100, 14.54545454545455, 1e-9, 'roi %');
  near(cell.hitRate, 0.6, 1e-12, 'hit rate');

  // 3 wins and 3 losses at -110 is the losing case: 2.727272… - 3 = -0.272727…
  const six = [
    ...rows(3, { result: 'WIN' }),
    ...rows(3, { result: 'LOSS', playerId: 90 }),
  ];
  const sixCell = aggregateBy(six, 'market', { minN: 1 }).cells[0];
  near(sixCell.units, -0.2727272727272725, 1e-12, 'units at 3W-3L');
  near(sixCell.roi, -0.04545454545454542, 1e-12, 'roi at 3W-3L');
  // 50% hit rate at -110 loses money: hit rate alone is the misleading number.
  near(sixCell.hitRate, 0.5, 1e-12, 'hit rate at 3W-3L');

  // Mixed prices: 1 win at +150, 1 win at -200, 2 losses.
  const mixed = [
    row({ playerId: 1, result: 'WIN', odds: 150 }),
    row({ playerId: 2, result: 'WIN', odds: -200 }),
    row({ playerId: 3, result: 'LOSS', odds: -110 }),
    row({ playerId: 4, result: 'LOSS', odds: 105 }),
  ];
  const mixedCell = aggregateBy(mixed, 'market', { minN: 1 }).cells[0];
  // +1.5 and +0.5 on the two winners, -1 each on the two losers: exactly flat,
  // at a 50% hit rate. Price, not frequency, is what decides.
  near(mixedCell.units, 0, 1e-12, 'mixed units');
  near(mixedCell.roi, 0, 1e-12, 'mixed roi');
  near(mixedCell.hitRate, 0.5, 1e-12, 'mixed hit rate');

  // Same 50% hit rate, all four at plus money: now it is a big winner.
  const plus = [
    row({ playerId: 1, result: 'WIN', odds: 140 }),
    row({ playerId: 2, result: 'WIN', odds: 140 }),
    row({ playerId: 3, result: 'LOSS', odds: 140 }),
    row({ playerId: 4, result: 'LOSS', odds: 140 }),
  ];
  const plusCell = aggregateBy(plus, 'market', { minN: 1 }).cells[0];
  near(plusCell.hitRate, 0.5, 1e-12, 'same hit rate');
  near(plusCell.units, 0.8, 1e-12, 'plus-money units');
  near(plusCell.roi, 0.2, 1e-12, 'plus-money roi');
});

test('pushes are excluded from hit rate and ROI but counted in n', () => {
  const list = [
    ...rows(3, { result: 'WIN' }),
    ...rows(1, { result: 'LOSS', playerId: 50 }),
    ...rows(2, { result: 'PUSH', playerId: 60 }),
  ];
  const cell = aggregateBy(list, 'market', { minN: 1 }).cells[0];
  assert.equal(cell.n, 6, 'n counts pushes');
  assert.equal(cell.pushes, 2);
  assert.equal(cell.decided, 4, 'decided excludes pushes');
  near(cell.hitRate, 0.75, 1e-12, 'hit rate is 3/4, not 3/6');
  // The push neither wins nor risks anything: 3 x 0.909090… - 1 over 4 risked.
  near(cell.units, 3 * (100 / 110) - 1, 1e-12, 'units');
  near(cell.roi, (3 * (100 / 110) - 1) / 4, 1e-12, 'roi denominator excludes pushes');
});

test('a decided row with no readable price is kept out of the ROI denominator', () => {
  const list = [
    row({ playerId: 1, result: 'WIN', odds: -110 }),
    row({ playerId: 2, result: 'WIN', odds: null }),
    row({ playerId: 3, result: 'LOSS', odds: undefined }),
  ];
  const cell = aggregateBy(list, 'market', { minN: 1 }).cells[0];
  assert.equal(cell.n, 3);
  assert.equal(cell.decided, 3, 'unpriced rows still count as decided');
  assert.equal(cell.unpriced, 2);
  near(cell.hitRate, 2 / 3, 1e-12, 'hit rate uses every decided row');
  near(cell.units, 100 / 110, 1e-12, 'only the priced row contributes units');
  near(cell.roi, 100 / 110, 1e-12, 'roi is over the one priced pick');
});

test('CLV is measured in cents on the continuous American line', () => {
  assert.equal(centsLine(-110), -10);
  assert.equal(centsLine(110), 10);
  assert.equal(centsLine(-100), 0);
  assert.equal(centsLine(100), 0);
  // Taking +105 into a -105 close is a 10-cent beat, not a 210-cent one.
  assert.equal(clvCents(105, -105), 10);
  assert.equal(clvCents(-110, -120), 10);
  assert.equal(clvCents(-120, -110), -10);
  assert.equal(clvCents(-110, null), null);

  const list = [
    row({ playerId: 1, odds: -110, closeOdds: -120 }),
    row({ playerId: 2, odds: -110, closeOdds: -100 }),
    row({ playerId: 3, odds: -110 }), // no close: excluded from the average
  ];
  const cell = aggregateBy(list, 'market', { minN: 1 }).cells[0];
  near(cell.avgClvCents, (10 + -10) / 2, 1e-12, 'avg clv cents');
});

// ── Wilson ─────────────────────────────────────────────────────────────────

test('wilson matches published 95% intervals', () => {
  // Standard textbook values for the Wilson score interval, z = 1.96.
  const a = wilson(8, 10);
  near(a.lo, 0.4901, 5e-4, '8/10 lower');
  near(a.hi, 0.9432, 5e-4, '8/10 upper');

  const b = wilson(50, 100);
  near(b.lo, 0.4038, 5e-4, '50/100 lower');
  near(b.hi, 0.5962, 5e-4, '50/100 upper');

  const c = wilson(0, 10);
  near(c.lo, 0, 1e-12, '0/10 lower');
  near(c.hi, 0.2775, 5e-4, '0/10 upper');

  assert.equal(wilson(1, 0), null);
  assert.equal(wilson(3, null), null);
});

test('wilson endpoints solve the score equation (independent check)', () => {
  // Both endpoints p satisfy |p̂ - p| = z * sqrt(p(1-p)/n), which is the
  // definition the closed form is derived from — a check that does not reuse
  // the implementation's algebra.
  const z = 1.959963984540054;
  for (const [w, n] of [
    [8, 10],
    [50, 100],
    [17, 40],
    [1, 3],
  ]) {
    const { lo, hi } = wilson(w, n);
    const p = w / n;
    for (const bound of [lo, hi]) {
      near(
        Math.abs(p - bound),
        z * Math.sqrt((bound * (1 - bound)) / n),
        1e-9,
        `score equation at ${w}/${n}`,
      );
    }
  }
});

test('wilson keeps a perfect record honest', () => {
  const { lo, hi } = wilson(4, 4);
  near(lo, 0.5101, 5e-4, '4/4 lower');
  assert.equal(hi, 1, '4/4 upper is clamped to 1');
  assert.ok(lo < 0.6, 'a 4-0 record is consistent with a coin flip');
});

// ── buckets ────────────────────────────────────────────────────────────────

test('odds / edge / EV buckets have no gaps at their boundaries', () => {
  assert.equal(oddsBucket(-250).key, 'heavyfav');
  assert.equal(oddsBucket(-200).key, 'heavyfav');
  assert.equal(oddsBucket(-199).key, 'fav');
  assert.equal(oddsBucket(-121).key, 'fav');
  assert.equal(oddsBucket(-120).key, 'even');
  assert.equal(oddsBucket(120).key, 'even');
  assert.equal(oddsBucket(121).key, 'plus');
  assert.equal(oddsBucket(250).key, 'plus');
  assert.equal(oddsBucket(300).key, 'longshot');
  assert.equal(oddsBucket(null), null);

  assert.equal(edgeBucket(0.02).label, '0–3 pts');
  assert.equal(edgeBucket(0.03).label, '3–5 pts');
  assert.equal(edgeBucket(-0.06).label, '5–7 pts', 'sign is ignored');
  assert.equal(edgeBucket(0.2).label, '7+ pts');
  assert.equal(edgeBucket(null), null);

  assert.equal(evBucket(1).label, 'under 2.5%');
  assert.equal(evBucket(2.5).label, '2.5–5%');
  assert.equal(evBucket(9.99).label, '5–10%');
  assert.equal(evBucket(10).label, '10%+');
  assert.equal(evBucket(null), null);
});

// ── row selection ──────────────────────────────────────────────────────────

test('only settled, called picks are counted', () => {
  assert.ok(isCountable(row()));
  assert.ok(isCountable(row({ result: 'push' })), 'result is case-insensitive');
  assert.ok(!isCountable(row({ result: 'NO DATA' })));
  assert.ok(!isCountable(row({ verdict: 'PASS' })), 'PASS is not a bet');
  assert.ok(!isCountable(row({ side: null })));
  assert.ok(!isCountable(null));

  const mix = [row({ playerId: 1 }), row({ playerId: 2, verdict: 'PASS' })];
  assert.equal(buildBreakdown(mix).nGraded, 1);
});

// ── the minimum-n guard ────────────────────────────────────────────────────

test('the minimum-n guard suppresses a 4-0 cell', () => {
  const four = rows(4, { result: 'WIN', market: 'batter_home_runs', label: 'Home Runs' });
  const dim = aggregateBy(four, 'market');
  const cell = dim.cells[0];

  assert.equal(cell.wins, 4);
  near(cell.hitRate, 1, 1e-12, 'it really did go 4-0');
  assert.ok(cell.roi > 0.9, 'and its raw ROI is enormous');
  assert.equal(cell.qualified, false, `4 < MIN_N (${MIN_N})`);
  assert.equal(dim.leader, null, 'so it is not the leader of its dimension');
  assert.equal(dim.enough, false, 'and the dimension reports no usable data');
  assert.ok(cell.ci.lo < 0.6, 'the interval says a coin flip is still possible');

  // Even with a healthy overall history behind it, the 4-0 cell is never named.
  const history = [
    ...four,
    ...rows(60, { result: 'LOSS', playerId: 500, market: 'batter_hits' }),
  ].map((r, i) => ({ ...r, playerId: i + 1 }));
  const out = buildBreakdown(history);
  assert.ok(out.nSettled >= MIN_HISTORY, 'history is not thin');
  assert.notEqual(out.headline?.cell.value, 'batter_home_runs');

  // Lowering the bar is the only way to surface it, which is the point.
  assert.equal(aggregateBy(four, 'market', { minN: 4 }).leader.value, 'batter_home_runs');
});

test('a thin overall history is never ranked', () => {
  const out = buildBreakdown(rows(10, { result: 'WIN' }));
  assert.equal(out.thin, true);
  assert.equal(out.headline, null);
  assert.match(out.message, /not enough to rank/i);
  assert.equal(buildBreakdown([]).message, 'No graded picks yet. Grade your saved slates and this breakdown fills in.');
});

test('a fat history names the best qualifying cell', () => {
  const history = [
    // 30 hits picks at -110, 20-10: +8.18 units over 30 = +27.3% ROI.
    ...rows(20, { result: 'WIN', market: 'batter_hits', label: 'Hits' }),
    ...rows(10, { result: 'LOSS', market: 'batter_hits', label: 'Hits' }),
    // 30 strikeout picks at -110, 12-18: losing.
    ...rows(12, { result: 'WIN', market: 'pitcher_strikeouts', label: 'Strikeouts', kind: 'pitcher' }),
    ...rows(18, { result: 'LOSS', market: 'pitcher_strikeouts', label: 'Strikeouts', kind: 'pitcher' }),
  ].map((r, i) => ({ ...r, playerId: i + 1 }));

  const out = buildBreakdown(history);
  assert.equal(out.thin, false);
  assert.equal(out.nSettled, 60);
  assert.equal(out.headline.cell.value, 'batter_hits');
  near(out.headline.cell.roi, (20 * (100 / 110) - 10) / 30, 1e-12, 'headline roi');

  const market = out.dimensions.find((d) => d.key === 'market');
  assert.deepEqual(
    market.cells.map((c) => c.value),
    ['batter_hits', 'pitcher_strikeouts'],
    'cells are ROI-sorted',
  );
  // Every dimension is present, whether or not it has data.
  assert.deepEqual(
    out.dimensions.map((d) => d.key),
    DIMENSIONS.map((d) => d.key),
  );
});

test('a dimension with nothing to read reports it rather than inventing a cell', () => {
  const out = buildBreakdown(rows(60, { result: 'WIN' }));
  const lineup = out.dimensions.find((d) => d.key === 'lineup');
  assert.equal(lineup.cells.length, 0);
  assert.equal(lineup.enough, false);
  assert.equal(lineup.nUnknown, 60, 'the rows are reported as unreadable, not dropped silently');

  const sample = out.dimensions.find((d) => d.key === 'sample');
  assert.equal(sample.nUnknown, 60, 'no flags array at all is unknown, not "clean"');

  const withFlags = buildBreakdown(rows(60, { result: 'WIN', flags: [] }));
  const sample2 = withFlags.dimensions.find((d) => d.key === 'sample');
  assert.equal(sample2.cells[0].value, 'clean');
  assert.equal(sample2.nUnknown, 0);
});

// ── ranking stability ──────────────────────────────────────────────────────

test('ranking is stable and total', () => {
  const cell = (o) => ({ qualified: true, roi: 0, decided: 10, n: 10, value: 'x', ...o });

  // Qualified always outranks unqualified, whatever the ROI.
  assert.ok(
    compareCells(cell({ roi: 0.01 }), cell({ roi: 5, qualified: false })) < 0,
  );
  // Then ROI, then the larger sample, then the label.
  assert.ok(compareCells(cell({ roi: 0.2 }), cell({ roi: 0.1 })) < 0);
  assert.ok(compareCells(cell({ decided: 40 }), cell({ decided: 30 })) < 0);
  assert.ok(compareCells(cell({ value: 'a' }), cell({ value: 'b' })) < 0);
  assert.equal(compareCells(cell({}), cell({})), 0);
  // A cell with no ROI at all sorts last among its qualification group.
  assert.ok(compareCells(cell({ roi: -9 }), cell({ roi: null })) < 0);

  // Same rows in any order produce the same table.
  const history = [
    ...rows(30, { result: 'WIN', market: 'batter_hits' }),
    ...rows(30, { result: 'LOSS', market: 'batter_home_runs' }),
    ...rows(15, { result: 'WIN', market: 'batter_rbis' }),
    ...rows(15, { result: 'LOSS', market: 'batter_rbis' }),
  ].map((r, i) => ({ ...r, playerId: i + 1 }));
  const order = (list) =>
    aggregateBy(list, 'market').cells.map((c) => `${c.value}:${c.qualified}`);
  const forward = order(history);
  assert.deepEqual(order([...history].reverse()), forward);
  assert.deepEqual(order([...history].sort((a, b) => a.market.localeCompare(b.market))), forward);
  assert.deepEqual(forward, [
    'batter_hits:true',
    'batter_rbis:true',
    'batter_home_runs:true',
  ]);
});

// ── storage, export, import ────────────────────────────────────────────────

const DAY_A = {
  schema: 'recon.graded-day',
  version: 1,
  date: '2026-07-02',
  gradedAt: '2026-07-03T05:00:00.000Z',
  rows: [row({ playerId: 1 }), row({ playerId: 2, result: 'LOSS' })],
};
const DAY_B = {
  ...DAY_A,
  date: '2026-07-01',
  rows: [row({ playerId: 3, result: 'PUSH' })],
};

test('readGradedHistory reads a plain map, a Storage-alike, or nothing', () => {
  const map = {
    [`${GRADED_PREFIX}2026-07-02`]: JSON.stringify(DAY_A),
    [`${GRADED_PREFIX}2026-07-01`]: JSON.stringify(DAY_B),
    'snap:2026-07-02': JSON.stringify({ rows: [] }),
    junk: 'not json',
    [`${GRADED_PREFIX}bad`]: '{{{',
  };
  const days = readGradedHistory(map);
  assert.deepEqual(days.map((d) => d.date), ['2026-07-01', '2026-07-02'], 'oldest first, non-graded keys ignored');
  assert.equal(flattenHistory(days).length, 3);
  assert.equal(flattenHistory(days)[0].date, '2026-07-01', 'rows are stamped with their date');

  // Storage-alike (length / key(i) / getItem).
  const entries = Object.entries(map);
  const storage = {
    length: entries.length,
    key: (i) => entries[i][0],
    getItem: (k) => map[k] ?? null,
  };
  assert.deepEqual(readGradedHistory(storage).map((d) => d.date), ['2026-07-01', '2026-07-02']);

  // No storage at all (node): empty history, no throw.
  assert.deepEqual(readGradedHistory(null), []);
  const out = breakdownFromStorage(null);
  assert.equal(out.nGraded, 0);
  assert.equal(out.nDates, 0);
});

test('breakdownFromStorage counts dates as well as rows', () => {
  const map = {
    [`${GRADED_PREFIX}2026-07-02`]: JSON.stringify(DAY_A),
    [`${GRADED_PREFIX}2026-07-01`]: JSON.stringify(DAY_B),
  };
  const out = breakdownFromStorage(map);
  assert.equal(out.nGraded, 3, 'two wins/losses plus one push');
  assert.equal(out.nSettled, 2);
  assert.equal(out.nDates, 2);
  assert.deepEqual(out.dates, ['2026-07-01', '2026-07-02']);
});

test('export and import round-trip', () => {
  const file = buildExport([DAY_A, DAY_B], new Date('2026-07-28T12:00:00Z'));
  assert.equal(file.schema, HISTORY_SCHEMA);
  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, '2026-07-28T12:00:00.000Z');
  assert.equal(file.nDays, 2);
  assert.equal(file.nRows, 3);
  assert.deepEqual(file.days.map((d) => d.date), ['2026-07-01', '2026-07-02']);

  const back = parseImport(JSON.stringify(file));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.days.map((d) => d.date), ['2026-07-01', '2026-07-02']);
  assert.equal(flattenHistory(back.days).length, 3);

  // A bare array of days, and a single day, both load.
  assert.equal(parseImport([DAY_A]).days.length, 1);
  assert.equal(parseImport(DAY_A).days.length, 1);
  // A day missing its date is skipped, with a reason.
  const partial = parseImport({ days: [DAY_A, { rows: [] }] });
  assert.equal(partial.days.length, 1);
  assert.equal(partial.errors.length, 1);
  // Junk is rejected, not half-imported.
  assert.equal(parseImport('nope').days.length, 0);
  assert.match(parseImport('nope').errors[0], /not valid json/i);
  assert.match(parseImport({ hello: 'world' }).errors[0], /unrecognised/i);
});
