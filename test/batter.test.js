// 2026-09-16 batter refit: PA distribution and rate spread (BATTER_TUNING).
//
// The refit widened every count distribution; these pin the property that made
// the old ones trustworthy — each distribution's mean is exactly the projection
// printed beside it — and that the old two-point mixture is still reachable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectBatter, BATTER_TUNING, PA_BY_LINEUP_SLOT } from '../src/model/batter.js';
import { binomTailOver } from '../src/lib/probability.js';

const season26 = {
  plateAppearances: 480, gamesPlayed: 112, hits: 118, doubles: 24, triples: 2, homeRuns: 21,
  runs: 66, rbi: 70, strikeOuts: 104, baseOnBalls: 44, stolenBases: 9,
};
const season25 = {
  plateAppearances: 610, gamesPlayed: 148, hits: 150, doubles: 30, triples: 3, homeRuns: 25,
  runs: 80, rbi: 85, strikeOuts: 130, baseOnBalls: 55, stolenBases: 12,
};
const base = {
  season26, season25, isAway: true, batSide: 'L', pitcherHand: 'R',
  spRates: { kRate: 0.23, hRate: 0.22, hrRate: 0.03 }, park: 'Wrigley Field',
};

const meanOf = (dist, max = 30) => {
  let m = 0;
  let prev = 1;
  for (let k = 0; k <= max; k++) {
    const above = dist(k + 0.5);
    m += k * (prev - above);
    prev = above;
  }
  return m;
};

test('PA distribution is a proper pmf whose mean is the lineup-slot PA, every slot', () => {
  for (let slot = 1; slot <= 9; slot++) {
    for (const isAway of [true, false]) {
      const p = projectBatter({ ...base, slot, isAway });
      const total = p.paDist.reduce((a, [, w]) => a + w, 0);
      const mean = p.paDist.reduce((a, [n, w]) => a + n * w, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `slot ${slot} sums to ${total}`);
      assert.ok(Math.abs(mean - p.pa) < 1e-6, `slot ${slot} mean ${mean} vs ${p.pa}`);
      assert.equal(p.pa, PA_BY_LINEUP_SLOT[slot - 1] + (isAway ? 0.08 : -0.08));
      // Wider than the old floor/ceil pair: 3 or more PA counts carry weight.
      assert.ok(p.paDist.filter(([, w]) => w > 0.01).length >= 3);
    }
  }
});

test('every count distribution still has mean exactly equal to its projection', () => {
  for (const slot of [1, 5, 9, undefined]) {
    const p = projectBatter({ ...base, slot });
    assert.ok(Math.abs(meanOf(p.dist.hits) - p.projH) < 1e-6, 'hits');
    assert.ok(Math.abs(meanOf(p.dist.tb) - p.projTB) < 1e-6, 'tb');
    assert.ok(Math.abs(meanOf(p.dist.hr) - p.projHR) < 1e-6, 'hr');
    assert.ok(Math.abs(meanOf(p.dist.singles) - p.proj1B) < 1e-6, 'singles');
    assert.ok(Math.abs(meanOf(p.dist.k) - p.projK) < 1e-6, 'k');
    assert.ok(Math.abs(meanOf(p.dist.hrr, 60) - p.projHRR) < 1e-4, 'hrr');
  }
});

test('teamPaSd 0 and rateSpread 0 reproduce the old two-point binomial mixture', () => {
  const tuning = { teamPaSd: 0, paLossRate: 0, rateSpread: 0 };
  const p = projectBatter({ ...base, slot: 3, tuning });
  const lo = Math.floor(p.pa);
  const f = p.pa - lo;
  for (const line of [0.5, 1.5, 2.5]) {
    const old = (1 - f) * binomTailOver(line, lo, p.rates.hitPA) + f * binomTailOver(line, lo + 1, p.rates.hitPA);
    assert.ok(Math.abs(p.dist.hits(line) - old) < 1e-12, `hits@${line}`);
  }
});

test('the refit widened hits: less mass on 1+ hits, more on 3+, same mean', () => {
  const narrow = projectBatter({ ...base, slot: 2, tuning: { teamPaSd: 0, paLossRate: 0, rateSpread: 0 } });
  const wide = projectBatter({ ...base, slot: 2 });
  assert.equal(wide.projH, narrow.projH);
  assert.ok(wide.dist.hits(0.5) < narrow.dist.hits(0.5));
  assert.ok(wide.dist.hits(2.5) > narrow.dist.hits(2.5));
  assert.ok(BATTER_TUNING.teamPaSd > 0 && BATTER_TUNING.rateSpread > 0);
});

// 2026-09-23 thin-hitter correction (BATTER_TUNING.thin / thinPaCap).
//
// docs/ACCURACY.md measured a hitter under 50 plate appearances this season
// reading about two points high on hits, total bases and singles. These pin
// the three properties that make the correction safe: it is exactly inert
// above the cap, exactly inert when the caller supplies no season line at all,
// and each shade moves its own markets in the measured direction.

const thinSeason = {
  plateAppearances: 18, gamesPlayed: 7, hits: 4, doubles: 1, triples: 0, homeRuns: 0,
  runs: 2, rbi: 2, strikeOuts: 6, baseOnBalls: 1, stolenBases: 0,
};
const OFF = { thinPaCap: 0, thin: {} };   // the pre-2026-09-23 model

test('the thin correction is exactly inert for a hitter at or above the cap', () => {
  for (const pa of [BATTER_TUNING.thinPaCap, BATTER_TUNING.thinPaCap + 1, 480]) {
    const input = { ...base, slot: 4, season26: { ...season26, plateAppearances: pa } };
    const on = projectBatter(input);
    const off = projectBatter({ ...input, tuning: OFF });
    for (const k of ['pa', 'projH', 'projTB', 'projHR', 'projR', 'projRBI', 'projHRR', 'projK', 'proj1B']) {
      assert.equal(on[k], off[k], `${k} moved at ${pa} PA`);
    }
  }
});

test('the thin correction is exactly inert when NEITHER season line is supplied', () => {
  // Missing input, not a short book: the model cannot tell a debutant from a
  // caller that fetched nothing, so it does what it did before.
  const input = { ...base, slot: 4, season26: null, season25: null };
  const on = projectBatter(input);
  const off = projectBatter({ ...input, tuning: OFF });
  for (const k of ['pa', 'projH', 'projTB', 'projHR', 'projR', 'projRBI', 'projHRR', 'projK', 'proj1B']) {
    assert.equal(on[k], off[k], `${k} moved with no season line at all`);
  }
  // A prior season on its own IS a book of zero plate appearances this season,
  // and is discounted.
  const priorOnly = projectBatter({ ...base, slot: 4, season26: null });
  assert.ok(priorOnly.projH < projectBatter({ ...base, slot: 4, season26: null, tuning: OFF }).projH);
});

test('each thin shade moves its own markets, in the direction it was measured', () => {
  const input = { ...base, slot: 4, season26: thinSeason };
  const off = projectBatter({ ...input, tuning: OFF });
  const only = (thin) => projectBatter({ ...input, tuning: { thin } });

  // Plate appearances: a short-book hitter is lifted more often.
  assert.ok(only({ pa: 0.03 }).pa < off.pa);
  assert.equal(only({ offence: 0.085 }).pa, off.pa);

  // Offence: hits, total bases, home runs and singles down; strikeouts not.
  const o = only({ offence: 0.085 });
  assert.ok(o.projH < off.projH && o.projTB < off.projTB && o.projHR < off.projHR && o.proj1B < off.proj1B);
  assert.equal(o.projK, off.projK);

  // Scoring: runs and RBI down, hits untouched.
  const s = only({ scoring: 0.11 });
  assert.ok(s.projR < off.projR && s.projRBI < off.projRBI);
  assert.equal(s.projH, off.projH);

  // Strikeouts go the OTHER way: the same hitter strikes out more.
  const k = only({ k: 0.04 });
  assert.ok(k.projK > off.projK);
  assert.equal(k.projH, off.projH);

  // The shipped settings: every one of them is on, and the ramp is strictly
  // between 0 and 1 for this hitter.
  const shipped = projectBatter(input);
  assert.ok(shipped.projH < off.projH && shipped.pa < off.pa);
  assert.ok(BATTER_TUNING.thinPaCap > thinSeason.plateAppearances);
});

test('the thin correction still leaves every distribution mean equal to its projection', () => {
  const p = projectBatter({ ...base, slot: 6, season26: thinSeason });
  assert.ok(Math.abs(meanOf(p.dist.hits) - p.projH) < 1e-6, 'hits');
  assert.ok(Math.abs(meanOf(p.dist.tb) - p.projTB) < 1e-6, 'tb');
  assert.ok(Math.abs(meanOf(p.dist.k) - p.projK) < 1e-6, 'k');
  assert.ok(Math.abs(meanOf(p.dist.hrr, 60) - p.projHRR) < 1e-4, 'hrr');
  assert.ok(Math.abs(p.paDist.reduce((a, [n, w]) => a + n * w, 0) - p.pa) < 1e-6, 'pa');
});
