/**
 * Regression tests for the repaired batter model.
 *
 * Run: `node --test src/model/__tests__/batter.test.mjs`
 *
 * Each block is tied to a BATTER-ANALYSIS.md finding; the comments name the
 * behaviour that used to be wrong so a future edit that reintroduces it fails
 * loudly rather than quietly moving a live market.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectBatter, PA_BY_LINEUP_SLOT } from '../batter.js';
import { LEAGUE_AVG, shrunkRate } from '../league.js';

// ---------------------------------------------------------------------------
// A realistic hitter: 600 PA, .270 with 24 HR, 31 2B, 3 3B, 82 R, 88 RBI,
// 130 K, 12 SB across 150 games. Prior season similar.
// ---------------------------------------------------------------------------
const HITTER_26 = {
  plateAppearances: 600,
  gamesPlayed: 150,
  hits: 148,
  doubles: 31,
  triples: 3,
  homeRuns: 24,
  runs: 82,
  rbi: 88,
  strikeOuts: 130,
  baseOnBalls: 55,
  stolenBases: 12,
};

const HITTER_25 = {
  plateAppearances: 580,
  gamesPlayed: 145,
  hits: 140,
  doubles: 28,
  triples: 2,
  homeRuns: 21,
  runs: 76,
  rbi: 80,
  strikeOuts: 138,
  baseOnBalls: 48,
  stolenBases: 9,
};

// An average-ish starter, expressed as projectPitcher's ADJUSTED rates (what
// data/loadSlate.js actually forwards today).
const SP_RATES = { adjK: 0.235, adjH: 0.215, adjHR: 0.03 };

function project(overrides = {}) {
  return projectBatter({
    season26: HITTER_26,
    season25: HITTER_25,
    slot: 3,
    isAway: true,
    batSide: 'R',
    pitcherHand: 'R',
    spRates: SP_RATES,
    park: 'Nationals Park',
    wx: { tempF: 72 },
    ...overrides,
  });
}

/**
 * Mean of a count distribution recovered from nothing but its public tail
 * function: E[X] = sum_{k>=0} P(X > k).
 */
function meanFromTail(tail, cap = 400) {
  let mean = 0;
  for (let k = 0; k < cap; k++) mean += tail(k + 0.5);
  return mean;
}

// ---------------------------------------------------------------------------
// FIX(1) — fractional PA. `Math.round(pa)` collapsed slots 2-8 onto n = 4.
// ---------------------------------------------------------------------------
test('lineup slot moves the tails: slot 1 and slot 9 differ materially', () => {
  const one = project({ slot: 1 });
  const nine = project({ slot: 9 });

  // The PA table itself must still separate them.
  assert.ok(one.pa > nine.pa);
  assert.equal(one.pa, PA_BY_LINEUP_SLOT[0] + 0.08);
  assert.equal(nine.pa, PA_BY_LINEUP_SLOT[8] + 0.08);

  const gapHits = one.dist.hits(0.5) - nine.dist.hits(0.5);
  const gapTb = one.dist.tb(1.5) - nine.dist.tb(1.5);
  const gapK = one.dist.k(0.5) - nine.dist.k(0.5);

  // ~1 extra PA is worth several points of probability on a 0.5 line; the old
  // model gave slot 1 (n=5) and slot 9 (n=4) a gap for the wrong reason and
  // gave slots 2-8 a gap of exactly zero.
  assert.ok(gapHits > 0.02, `hits gap too small: ${gapHits}`);
  assert.ok(gapTb > 0.02, `tb gap too small: ${gapTb}`);
  assert.ok(gapK > 0.02, `k gap too small: ${gapK}`);
});

test('every lineup slot produces a distinct hits tail (round() collapse gone)', () => {
  const tails = [];
  for (let slot = 1; slot <= 9; slot++) {
    tails.push(project({ slot }).dist.hits(0.5));
  }
  // Strictly decreasing down the order.
  for (let i = 1; i < tails.length; i++) {
    assert.ok(
      tails[i] < tails[i - 1],
      `slot ${i + 1} (${tails[i]}) not below slot ${i} (${tails[i - 1]})`,
    );
  }
  // The old model returned the identical 0.6515 for slots 2 through 8.
  const middle = new Set(tails.slice(1, 8).map((p) => p.toFixed(6)));
  assert.equal(middle.size, 7);
});

test('binomial and TB means equal the reported projections exactly', () => {
  for (const slot of [1, 4, 9]) {
    const p = project({ slot });
    assert.ok(Math.abs(meanFromTail(p.dist.hits) - p.projH) < 1e-9);
    assert.ok(Math.abs(meanFromTail(p.dist.hr) - p.projHR) < 1e-9);
    assert.ok(Math.abs(meanFromTail(p.dist.singles) - p.proj1B) < 1e-9);
    assert.ok(Math.abs(meanFromTail(p.dist.k) - p.projK) < 1e-9);
    assert.ok(Math.abs(meanFromTail(p.dist.tb) - p.projTB) < 1e-9);
  }
});

// ---------------------------------------------------------------------------
// FIX(2) — runs / RBI / HRR were park-, weather- and pitcher-blind.
// ---------------------------------------------------------------------------
test('Coors and Oracle differ for runs AND rbi AND hrr', () => {
  const coors = project({ park: 'Coors Field' });
  const oracle = project({ park: 'Oracle Park' });

  // Point estimates: Coors (runs 112) must beat Oracle (runs 96).
  assert.ok(coors.projR > oracle.projR, `${coors.projR} !> ${oracle.projR}`);
  assert.ok(coors.projRBI > oracle.projRBI);
  assert.ok(coors.projHRR > oracle.projHRR);

  // And by a margin the edge engine can see (LEAN is 0.03 of probability).
  assert.ok(coors.projR / oracle.projR > 1.05);
  assert.ok(coors.projRBI / oracle.projRBI > 1.05);

  // Distributions must move too, not just the displayed number.
  assert.ok(coors.dist.runs(0.5) - oracle.dist.runs(0.5) > 0.01);
  assert.ok(coors.dist.rbi(0.5) - oracle.dist.rbi(0.5) > 0.01);
  assert.ok(coors.dist.hrr(1.5) - oracle.dist.hrr(1.5) > 0.01);
});

test('heat and starter quality reach runs / rbi / hrr', () => {
  const cold = project({ wx: { tempF: 45 } });
  const hot = project({ wx: { tempF: 95 } });
  assert.ok(hot.projR > cold.projR);
  assert.ok(hot.projRBI > cold.projRBI);
  assert.ok(hot.projHRR > cold.projHRR);

  const ace = project({ spRates: { adjK: 0.30, adjH: 0.17, adjHR: 0.015 } });
  const batteringRam = project({ spRates: { adjK: 0.16, adjH: 0.27, adjHR: 0.05 } });
  assert.ok(batteringRam.projR > ace.projR * 1.1);
  assert.ok(batteringRam.projRBI > ace.projRBI * 1.1);

  // With no starter, an indoor game and an unknown park the run context must
  // collapse to exactly 1, i.e. back to the original rate x PA x platoon
  // formula — the new context term may not silently re-scale the neutral case.
  const bare = project({ spRates: null, park: undefined, wx: { indoor: true } });
  const runRate = shrunkRate(
    HITTER_26.runs, HITTER_26.plateAppearances,
    HITTER_25.runs, HITTER_25.plateAppearances, 0.12, 60,
  );
  const rbiRate = shrunkRate(
    HITTER_26.rbi, HITTER_26.plateAppearances,
    HITTER_25.rbi, HITTER_25.plateAppearances, 0.115, 60,
  );
  const platoonTerm = bare.platoon * 0.4 + 0.6;
  assert.ok(Math.abs(bare.projR - bare.pa * runRate * platoonTerm) < 1e-15);
  assert.ok(Math.abs(bare.projRBI - bare.pa * rbiRate * platoonTerm * 0.975) < 1e-15);
});

// ---------------------------------------------------------------------------
// FIX(3) — dist.hrr must be the convolution of its own components.
// ---------------------------------------------------------------------------
test('projHRR equals the mean implied by dist.hrr to within 1e-6', () => {
  for (const park of ['Coors Field', 'Oracle Park', 'Nationals Park']) {
    for (const slot of [1, 5, 9]) {
      const p = project({ park, slot });
      const implied = meanFromTail(p.dist.hrr);
      assert.ok(
        Math.abs(implied - p.projHRR) < 1e-6,
        `${park} slot ${slot}: implied ${implied} vs projHRR ${p.projHRR}`,
      );
    }
  }
});

test('dist.hrr is consistent with dist.hits + dist.runs + dist.rbi', () => {
  const p = project();
  // P(HRR > 0) must equal 1 - P(H=0)P(R=0)P(RBI=0).
  const pH0 = 1 - p.dist.hits(0.5);
  const pR0 = 1 - p.dist.runs(0.5);
  const pRbi0 = 1 - p.dist.rbi(0.5);
  assert.ok(Math.abs(p.dist.hrr(0.5) - (1 - pH0 * pR0 * pRbi0)) < 1e-9);
});

// ---------------------------------------------------------------------------
// FIX(4) — stolen bases go through shrunkRate.
// ---------------------------------------------------------------------------
test('SB rate is shrunk: no unregressed part-timers, no flat-0.04 cliff', () => {
  const partTime = projectBatter({
    season26: { ...HITTER_26, plateAppearances: 90, gamesPlayed: 21, stolenBases: 7 },
    season25: {},
    slot: 7,
    isAway: false,
    park: 'Nationals Park',
  });
  // Was 7/21 = 0.3333 raw; must now be pulled hard toward the 0.04 prior.
  assert.ok(partTime.projSB < 0.2, `projSB=${partTime.projSB}`);
  assert.ok(partTime.projSB > 0.04);

  const justUnder = projectBatter({
    season26: { gamesPlayed: 20, stolenBases: 6 },
    season25: {},
    slot: 7,
    isAway: false,
    park: 'Nationals Park',
  });
  const justOver = projectBatter({
    season26: { gamesPlayed: 21, stolenBases: 6 },
    season25: {},
    slot: 7,
    isAway: false,
    park: 'Nationals Park',
  });
  // The old >20-weighted-games cliff jumped from 0.04 to 0.2857 in one game.
  assert.ok(Math.abs(justOver.projSB - justUnder.projSB) < 0.01);

  // A cold-starting burner is no longer priced at zero...
  const coldStart = projectBatter({
    season26: { gamesPlayed: 22, stolenBases: 0 },
    season25: { gamesPlayed: 150, stolenBases: 40 },
    slot: 1,
    isAway: true,
    park: 'Nationals Park',
  });
  assert.ok(coldStart.projSB > 0.15, `projSB=${coldStart.projSB}`);

  // ...and a full season of real steals still comes through.
  const burner = projectBatter({
    season26: { gamesPlayed: 150, stolenBases: 60 },
    season25: {},
    slot: 1,
    isAway: true,
    park: 'Nationals Park',
  });
  assert.ok(burner.projSB > 0.3);
  assert.ok(burner.projSB < 60 / 150);

  // No playing time at all still returns the model's original 0.04 default.
  const rookie = projectBatter({
    season26: {}, season25: {}, slot: 9, isAway: false, park: 'Nationals Park',
  });
  assert.ok(Math.abs(rookie.projSB - 0.04) < 1e-12);
});

// ---------------------------------------------------------------------------
// FIX(5) — park applied exactly once.
// ---------------------------------------------------------------------------
test('park is applied exactly once to hits / hr / k', () => {
  // Feeding the batter the starter's ALREADY park-adjusted rates must give the
  // same answer as feeding him the raw talent rates, because the batter now
  // divides the park factor back out of the adjusted form.
  const raw = { kRate: 0.235, hRate: 0.215, hrRate: 0.03 };
  const park = 'Coors Field';
  const adjusted = {
    adjK: raw.kRate * (1 + 0.5 * (92 / 100 - 1)),
    adjH: raw.hRate * (1 + 0.7 * (111 / 100 - 1)),
    adjHR: raw.hrRate * (1 + 0.7 * (107 / 100 - 1)),
  };

  const fromRaw = project({ park, spRates: raw });
  const fromAdjusted = project({ park, spRates: adjusted });

  assert.ok(Math.abs(fromRaw.rates.hitPA - fromAdjusted.rates.hitPA) < 1e-12);
  assert.ok(Math.abs(fromRaw.rates.hrPA - fromAdjusted.rates.hrPA) < 1e-12);
  assert.ok(Math.abs(fromRaw.rates.kPA - fromAdjusted.rates.kPA) < 1e-12);

  // The realised uplift on each leg must equal the intended park factor for
  // that leg exactly. The audit measured 1.11686 realised against 1.07700
  // intended on hits (park counted ~1.48x) and 1.0404 against 1.0250 on K.
  const reference = project({ park: undefined, spRates: raw });
  const legs = [
    ['non-HR hits', fromRaw.rates.singlePA / reference.rates.singlePA, 1 + 0.7 * (111 / 100 - 1)],
    ['hr', fromRaw.rates.hrPA / reference.rates.hrPA, 1 + 0.7 * (107 / 100 - 1)],
    ['k', fromRaw.rates.kPA / reference.rates.kPA, 1 + 0.5 * (92 / 100 - 1)],
  ];
  for (const [name, realised, intended] of legs) {
    assert.ok(
      Math.abs(realised - intended) < 1e-9,
      `${name} park uplift ${realised} vs intended ${intended}`,
    );
  }

  // hitPA as a whole is the blend of the two legs, so it sits between them.
  const hitUplift = fromRaw.rates.hitPA / reference.rates.hitPA;
  assert.ok(hitUplift > legs[1][2] && hitUplift < legs[0][2]);

  const neutral = project({ park: 'Wrigley Field', spRates: raw }); // hits 99
  assert.ok(neutral.rates.hitPA < fromRaw.rates.hitPA);
});

test('the batter\'s own team aggregate can be divided back out of spRates', () => {
  // loadSlate builds the opposing starter's adjK against the BATTER'S OWN team
  // rates, so the batter was being pushed by his own team's aggregate. When the
  // caller forwards that aggregate the term is removed and the K projection no
  // longer depends on it.
  const rawK = 0.235;
  const highKTeam = { kRate: 0.25, avg: LEAGUE_AVG.avg };
  const contactTeam = { kRate: 0.19, avg: LEAGUE_AVG.avg };
  const withHighK = project({
    spRates: {
      adjK: rawK * (1 + 0.4 * (highKTeam.kRate / LEAGUE_AVG.kRate - 1)),
      adjH: 0.215,
      adjHR: 0.03,
      opp: highKTeam,
    },
  });
  const withContact = project({
    spRates: {
      adjK: rawK * (1 + 0.4 * (contactTeam.kRate / LEAGUE_AVG.kRate - 1)),
      adjH: 0.215,
      adjHR: 0.03,
      opp: contactTeam,
    },
  });
  assert.ok(Math.abs(withHighK.rates.kPA - withContact.rates.kPA) < 1e-12);
});

// ---------------------------------------------------------------------------
// FIX(6)/FIX(7) — hit conservation and the singles/HR leak.
// ---------------------------------------------------------------------------
test('total hits are conserved across 1B / 2B / 3B / HR', () => {
  const profiles = [
    [HITTER_26, HITTER_25],
    // The pathological case: low average, huge power (601 PA, 78 H, 30 HR).
    [{ plateAppearances: 601, gamesPlayed: 150, hits: 78, doubles: 14, triples: 0,
       homeRuns: 30, runs: 45, rbi: 60, strikeOuts: 210, baseOnBalls: 70 }, {}],
    // Slap hitter with no power at all.
    [{ plateAppearances: 500, gamesPlayed: 130, hits: 140, doubles: 12, triples: 8,
       homeRuns: 1, runs: 60, rbi: 35, strikeOuts: 60, baseOnBalls: 40 }, {}],
    // No data at all -> pure priors.
    [{}, {}],
  ];

  for (const [s26, s25] of profiles) {
    for (const park of ['Coors Field', 'Great American Ball Park', 'Oracle Park', undefined]) {
      for (const tempF of [40, 72, 100]) {
        const p = projectBatter({
          season26: s26,
          season25: s25,
          slot: 4,
          isAway: true,
          batSide: 'L',
          pitcherHand: 'R',
          spRates: { adjK: 0.26, adjH: 0.24, adjHR: 0.06 },
          park,
          wx: { tempF },
        });
        const { singlePA, doublePA, triplePA, hrPA, hitPA } = p.rates;
        const sum = singlePA + doublePA + triplePA + hrPA;
        assert.ok(
          Math.abs(sum - hitPA) < 1e-12,
          `1B+2B+3B+HR=${sum} vs hitPA=${hitPA} (${park}, ${tempF}F)`,
        );
        // Never fabricate a hit: every branch is a real probability.
        assert.ok(singlePA >= 0 && doublePA >= 0 && triplePA >= 0 && hrPA > 0);
        // ...and TB stays consistent with the same rates.
        const impliedTb = p.pa * (singlePA + 2 * doublePA + 3 * triplePA + 4 * hrPA);
        assert.ok(Math.abs(impliedTb - p.projTB) < 1e-12);
      }
    }
  }
});

test('an HR-park boost does not reduce projected singles', () => {
  // Great American: hr 112, hits 100. The hits factor is neutral, so singles
  // must be unchanged — the old model dropped proj1B by 3.5% here purely
  // because nonHrHitPA = hitPA - hrPA.
  const neutral = project({ park: undefined });
  const gabp = project({ park: 'Great American Ball Park' });

  assert.ok(
    gabp.proj1B >= neutral.proj1B - 1e-12,
    `proj1B fell from ${neutral.proj1B} to ${gabp.proj1B}`,
  );
  assert.ok(Math.abs(gabp.proj1B - neutral.proj1B) < 1e-12);
  // The HR boost is real and adds offence rather than reshuffling it.
  assert.ok(gabp.projHR > neutral.projHR);
  assert.ok(gabp.projH > neutral.projH);
  assert.ok(gabp.projTB > neutral.projTB);

  // Same for heat: a 100F day may not shrink the singles projection.
  const cool = project({ wx: { tempF: 55 } });
  const hot = project({ wx: { tempF: 100 } });
  assert.ok(hot.proj1B >= cool.proj1B - 1e-12);
  assert.ok(hot.projHR > cool.projHR);

  // And a homer-prone starter may not shrink it either.
  const homerProne = project({ spRates: { adjK: 0.235, adjH: 0.215, adjHR: 0.06 } });
  const stingy = project({ spRates: { adjK: 0.235, adjH: 0.215, adjHR: 0.015 } });
  assert.ok(homerProne.proj1B >= stingy.proj1B - 1e-12);
  assert.ok(homerProne.projHR > stingy.projHR);
});

// ---------------------------------------------------------------------------
// Shape / contract: the object the UI and the edge engine consume is unchanged.
// ---------------------------------------------------------------------------
test('projection shape and flags are unchanged', () => {
  const p = project({ batSide: 'L', pitcherHand: 'R' });
  for (const key of [
    'pa', 'rates', 'projH', 'projHR', 'projTB', 'projR', 'projRBI', 'projHRR',
    'projK', 'projSB', 'proj1B', 'dist', 'flags', 'platoon',
  ]) {
    assert.ok(key in p, `missing ${key}`);
  }
  for (const key of ['hits', 'hr', 'singles', 'k', 'tb', 'runs', 'rbi', 'hrr', 'sb']) {
    assert.equal(typeof p.dist[key], 'function');
    const value = p.dist[key](0.5);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${key} -> ${value}`);
  }
  assert.deepEqual(p.flags, ['PLATOON+']);

  const small = projectBatter({
    season26: {}, season25: {}, slot: 9, isAway: false, batSide: 'R',
    pitcherHand: 'R', park: 'Nationals Park',
  });
  assert.deepEqual(small.flags, ['SMALL SAMPLE', 'PLATOON−']);
});
