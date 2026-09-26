// Lagging Pinnacle: the rule must depend on the two prices and on nothing
// else. See src/analysis/sharp.js. This mirrors test/shop.test.js on purpose —
// the two rules are cousins and are meant to be held to the same discipline.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bookPrices, lineMoves, sharpGaps, MIN_GAP_PTS, SHARP_BOOK } from '../src/analysis/sharp.js';

// Pinnacle at -115/-105 prices the over as the favourite and de-vigs above
// 50%; DK at -110/-110 de-vigs to exactly 50%. So the over is the side
// Pinnacle implies and DK is the one still lagging on it.
const row = (over = {}) => ({
  key: 'r1',
  gamePk: 1,
  market: 'game_total',
  line: 8.5,
  books: { PIN: [-115, -105], DK: [-110, -110] },
  edge: { fairOver: 0.51, modelOver: 0.9 },
  ...over,
});

test('a book sitting off Pinnacle is a gap, sized in de-vigged points', () => {
  const [gap] = sharpGaps([row()]);
  assert.equal(gap.side, 'over');
  assert.equal(gap.book, 'DK');
  assert.equal(gap.odds, -110);
  assert.ok(gap.gapPts > 1 && gap.gapPts < 1.5, `gap ${gap.gapPts}`);
  // EV takes Pinnacle's number as true: 0.5116 * 1.909 - 1 ≈ -2.3%. Negative,
  // and correctly so: 1.2 points of lag does not cover a 4.5% hold.
  assert.ok(Math.abs(gap.ev - (100 * (gap.pinFair * (1 + 100 / 110) - 1))) < 1e-9);
  assert.equal(gap.nBooks, 2);
});

test('the model is not consulted: an identical board ranks identically', () => {
  // Same prices, opposite model opinions. If the projection leaked in, these
  // would differ — which is the entire point of this module existing.
  const sure = sharpGaps([row({ edge: { fairOver: 0.51, modelOver: 0.99 } })]);
  const doubtful = sharpGaps([row({ edge: { fairOver: 0.51, modelOver: 0.01 } })]);
  assert.deepEqual(
    sure.map((g) => [g.side, g.gapPts, g.ev]),
    doubtful.map((g) => [g.side, g.gapPts, g.ev]),
  );
});

test('no Pinnacle price, no signal — and that is a data gap, not agreement', () => {
  assert.deepEqual(sharpGaps([row({ books: { DK: [-110, -110], FD: [-120, 100] } })]), []);
  assert.equal(SHARP_BOOK, 'PIN');
});

test('two books agreeing is not a gap, and the vig alone never makes one', () => {
  // Same de-vigged number, wildly different holds: 52.4/52.4 against 50/50.
  assert.deepEqual(sharpGaps([row({ books: { PIN: [-110, -110], DK: [100, -100] } })]), []);
  assert.equal(MIN_GAP_PTS, 1);
});

test('the gap floor and the EV floor are both parameters', () => {
  const thin = row({ books: { PIN: [-115, -105], DK: [-110, -110] } });
  assert.equal(sharpGaps([thin], { minGapPts: 5 }).length, 0);
  assert.equal(sharpGaps([thin], { minEvPct: 5 }).length, 0);
  assert.equal(sharpGaps([thin], { minGapPts: 0.5 }).length, 1);
});

test('the under is found as readily as the over', () => {
  // Pinnacle makes the UNDER likelier than DK does.
  const [gap] = sharpGaps([row({ books: { PIN: [-105, -115], DK: [-110, -110] } })]);
  assert.equal(gap.side, 'under');
  assert.equal(gap.odds, -110);
});

test('ranking is widest-first and stable', () => {
  const near = row({ key: 'a', books: { PIN: [-115, -105], DK: [-110, -110] } });
  const far = row({ key: 'b', books: { PIN: [-160, 140], DK: [-110, -110] } });
  const gaps = sharpGaps([near, far]);
  assert.ok(gaps[0].gapPts > gaps[1].gapPts);
  assert.deepEqual(
    sharpGaps([far, near]).map((g) => g.key),
    gaps.map((g) => g.key),
  );
});

test('prices are read from the archive map or the live board, never doubled', () => {
  assert.deepEqual(bookPrices({ books: { PIN: [-115, -105] } }), [
    { book: 'PIN', over: -115, under: -105 },
  ]);
  // A one-sided quote and a DFS multiplier cannot be de-vigged, so neither is a price.
  assert.deepEqual(
    bookPrices({
      venues: [
        { short: 'DK', over: -110, under: -110 },
        { short: 'FD', over: -110, under: null },
        { short: 'PP', over: null, under: null, multiplier: 3 },
      ],
    }),
    [{ book: 'DK', over: -110, under: -110 }],
  );
  // The archive map wins when both are present; a row must not count twice.
  assert.equal(
    bookPrices({ books: { PIN: [-115, -105] }, venues: [{ short: 'PIN', over: -115, under: -105 }] })
      .length,
    1,
  );
});

test('line movement is measured on the de-vigged number, not the posted price', () => {
  const moves = lineMoves([
    { key: 'a', fairOver: 0.5, closeFairOver: 0.55 },
    { key: 'b', fairOver: 0.5, closeFairOver: 0.48 },
    // Both sides widened: more vig, no move. It must not read as one.
    { key: 'c', fairOver: 0.5, closeFairOver: 0.5 },
    { key: 'd', fairOver: 0.5 }, // never closed
  ]);
  assert.deepEqual(
    moves.map((m) => [m.row.key, m.toward, Math.round(m.movePts * 10) / 10]),
    [
      ['a', 'over', 5],
      ['b', 'under', -2],
      ['c', 'none', 0],
    ],
  );
  assert.equal(lineMoves([{ key: 'c', fairOver: 0.5, closeFairOver: 0.5 }], { minPts: 1 }).length, 0);
});
