// Price shopping: the rule must depend on prices and book count, and on
// nothing else. See src/analysis/shop.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { priceGaps, twoSidedBooks, MIN_BOOKS } from '../src/analysis/shop.js';

const row = (over = {}) => ({
  key: 'r1',
  gamePk: 1,
  playerId: 10,
  market: 'batter_hits',
  line: 0.5,
  over: -110,
  under: -110,
  overBook: 'DK',
  underBook: 'FD',
  nBooksTwoSided: 4,
  edge: { fairOver: 0.5, nBooks: 4, modelOver: 0.9 },
  ...over,
});

test('a book paying more than the consensus is a gap, sized in EV', () => {
  // Consensus says 55%; DK pays -110 (52.4% implied) on that side.
  const [gap] = priceGaps([row({ over: -110, edge: { fairOver: 0.55, nBooks: 4 } })]);
  assert.equal(gap.side, 'over');
  assert.equal(gap.book, 'DK');
  // 0.55 * 1.909 - 1 = 5.0%
  assert.ok(Math.abs(gap.ev - 5.0) < 0.05, `ev ${gap.ev}`);
  assert.ok(Math.abs(gap.gapPts - 2.6) < 0.1, `gap ${gap.gapPts}`);
});

test('the model is not consulted: an identical board ranks identically', () => {
  // Same prices, opposite model opinions. If the projection leaked in, these
  // would differ — which is the entire point of this module existing.
  const sure = priceGaps([row({ edge: { fairOver: 0.55, nBooks: 4, modelOver: 0.99 } })]);
  const doubtful = priceGaps([row({ edge: { fairOver: 0.55, nBooks: 4, modelOver: 0.01 } })]);
  assert.deepEqual(
    sure.map((g) => [g.side, g.ev]),
    doubtful.map((g) => [g.side, g.ev]),
  );
});

test('two books is not a consensus', () => {
  const thin = row({ nBooksTwoSided: 2, edge: { fairOver: 0.6, nBooks: 2 } });
  assert.equal(priceGaps([thin]).length, 0);
  assert.ok(priceGaps([thin], { minBooks: 2 }).length > 0, 'and the floor is a parameter');
  assert.equal(MIN_BOOKS, 3);
});

test('a fair price is not a gap', () => {
  // Consensus 50%, price -110 both sides: the vig is the whole difference.
  assert.deepEqual(priceGaps([row()]), []);
});

test('the two-sided count is preferred, with the engine count as fallback', () => {
  assert.equal(twoSidedBooks({ nBooksTwoSided: 3, edge: { nBooks: 6 } }), 3);
  // lines.js computes the two-sided count and rows.js used to drop it; older
  // snapshots have only the engine's number.
  assert.equal(twoSidedBooks({ edge: { nBooks: 6 } }), 6);
  assert.equal(twoSidedBooks({}), 0);
});

test('ranking is best-first and stable', () => {
  const a = { ...row({ key: 'a', edge: { fairOver: 0.55, nBooks: 4 } }) };
  const b = { ...row({ key: 'b', over: 120, edge: { fairOver: 0.55, nBooks: 4 } }) };
  const gaps = priceGaps([a, b]);
  assert.ok(gaps[0].ev > gaps[1].ev);
  assert.deepEqual(priceGaps([b, a]).map((g) => g.key), gaps.map((g) => g.key));
});
