// v36.2: the pitcher port (docs/PITCHER-PORT.md).
//
// Every term ported in is optional, and every one of them has to degrade to
// exactly what v36 did when its input is missing — a board that loads before
// the lineups are posted, or a replay that never knew the slate date, must not
// silently get a different model. These are those fallbacks, one test each,
// plus the two invariants the port must not break: the printed projection is
// the mean of the distribution priced from it, and nothing reads a date it was
// not given.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectPitcher,
  decayedRateTotals,
  PITCHER_FIT,
  PITCHER_TUNING,
} from '../src/model/pitcher.js';

const SEASON = {
  gamesStarted: 20,
  gamesPlayed: 20,
  battersFaced: 480,
  strikeOuts: 120,
  baseOnBalls: 38,
  hits: 105,
  homeRuns: 14,
  numberOfPitches: 1800,
  earnedRuns: 48,
  outs: 360,
  strikes: 1170,
  inningsPitched: '120.0',
  era: '3.60',
  strikePercentage: '.650',
};

/** A dated game log: five starts, one every fifth day, ending the day before. */
const datedLog = (upTo = '2026-07-01', n = 5, pitches = 95) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${upTo}T00:00:00Z`) - (n - i) * 5 * 864e5);
    return { date: d.toISOString().slice(0, 10), ip: 5.2, pitches, bf: 24, k: 6 };
  });

const undated = (log) => log.map(({ date, ...rest }) => rest);

const base = (over = {}) => ({
  season26: SEASON,
  season25: null,
  gameLog: datedLog(),
  park: 'Target Field',
  ...over,
});

// ── the decayed two-season rate accumulator ─────────────────────────────────

test('decayedRateTotals returns null for every input it cannot use', () => {
  const log = [{ date: '2026-06-01', season: 2026, bf: 24, k: 6, bb: 2, h: 5, hr: 1, hbp: 0 }];
  assert.equal(decayedRateTotals(null, '2026-07-01', 2026, 400, 60), null, 'no log');
  assert.equal(decayedRateTotals([], '2026-07-01', 2026, 400, 60), null, 'empty log');
  assert.equal(decayedRateTotals(log, null, 2026, 400, 60), null, 'no date');
  assert.equal(decayedRateTotals(log, 'not a date', 2026, 400, 60), null, 'unparseable date');
  assert.equal(decayedRateTotals(log, '2026-07-01', 2026, 0, 60), null, 'no decay constant');
  // Nothing on or after the start's own date may count. With one appearance,
  // and that appearance being today's, there is nothing left.
  assert.equal(decayedRateTotals(log, '2026-06-01', 2026, 400, 60), null, 'no lookahead');
});

test('the decay weights a recent start above an old one, and compresses the offseason', () => {
  const one = (date, season) => [{ date, season, bf: 100, k: 25, bb: 8, h: 22, hr: 3, hbp: 1 }];
  const at = (log) => decayedRateTotals(log, '2026-08-01', 2026, 400, 60).bf;

  const recent = at(one('2026-07-01', 2026));
  const older = at(one('2026-04-01', 2026));
  assert.ok(recent > older, `a July start must outweigh an April one: ${recent} vs ${older}`);

  // 2025-07-01 is 396 real days before 2026-08-01. Compressed by the fitted
  // 60-day offseason it is 396 - 119 = 277 days, which is exactly one
  // half-life at tau = 400 — the study's own worked example, where the implied
  // weight on that start comes out at 0.50 against the flat blend's 0.6.
  const acrossOffseason = at(one('2025-07-01', 2025));
  assert.ok(Math.abs(acrossOffseason / 100 - 0.5) < 0.01, `implied weight ${acrossOffseason / 100}`);

  // Without the compression it would be exp(-396/400) = 0.37.
  const uncompressed = decayedRateTotals(one('2025-07-01', 2025), '2026-08-01', 2026, 400, 179).bf;
  assert.ok(uncompressed / 100 < 0.38);
});

test('without rateLog the rates are exactly v36: shrunkRate, untouched', () => {
  const withoutLog = projectPitcher(base({ date: '2026-07-01' }));
  const forcedOff = projectPitcher(base({ date: '2026-07-01', tuning: { rateDecay: false } }));
  assert.equal(withoutLog.rates.kRate, forcedOff.rates.kRate);
  assert.equal(withoutLog.rates.hRate, forcedOff.rates.hRate);
  assert.equal(withoutLog.projK, forcedOff.projK);
});

test('rateLog is read when it is supplied AND switched on, and is inert otherwise', () => {
  const rateLog = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-${String(3 + Math.floor(i / 7)).padStart(2, '0')}-${String(1 + (i % 7) * 4).padStart(2, '0')}`,
    season: 2026,
    bf: 24, k: 9, bb: 2, h: 4, hr: 0, hbp: 0,
  }));
  const input = base({ date: '2026-07-01', season: 2026, rateLog });
  const off = projectPitcher(input);
  const on = projectPitcher({ ...input, tuning: { rateDecay: true } });
  // Shipped OFF: measured worth nothing, and it is the only term that would
  // cost loadSlate a fetch. See PITCHER_TUNING.rateDecay.
  assert.equal(PITCHER_TUNING.rateDecay, false);
  assert.equal(off.rates.kRate, projectPitcher({ ...input, rateLog: undefined }).rates.kRate);
  // A 9-K-per-24-batters log is a far better strikeout rate than the season
  // line, so switching it on must move the projection up.
  assert.ok(on.rates.kRate > off.rates.kRate, `${on.rates.kRate} vs ${off.rates.kRate}`);
});

// ── the recency-weighted workload ───────────────────────────────────────────

test('without a slate date the workload is v36: a flat mean of the last three starts', () => {
  const log = datedLog();
  const noDate = projectPitcher(base({ gameLog: log }));
  const flat = projectPitcher(base({ gameLog: log, tuning: { workDecay: false } }));
  assert.equal(noDate.workload.budget, flat.workload.budget);
  assert.equal(noDate.projOuts, flat.projOuts);
});

test('without dates ON the log entries the workload is v36, even when the slate date is known', () => {
  const log = datedLog();
  const stripped = projectPitcher(base({ date: '2026-07-01', gameLog: undated(log) }));
  const flat = projectPitcher(base({ date: '2026-07-01', gameLog: undated(log), tuning: { workDecay: false } }));
  assert.equal(stripped.workload.budget, flat.workload.budget);
});

test('with dates, a stale outing counts for less than a fresh one', () => {
  // Same two outings, same order, different gaps: 105 pitches long ago and 75
  // recently should leash him shorter than 75 long ago and 105 recently.
  const mk = (a, b) => [
    { date: '2026-05-01', ip: 5, pitches: a, bf: 22, k: 5 },
    { date: '2026-06-28', ip: 5, pitches: b, bf: 22, k: 5 },
  ];
  const fadingUp = projectPitcher(base({ date: '2026-07-01', gameLog: mk(75, 105) }));
  const fadingDown = projectPitcher(base({ date: '2026-07-01', gameLog: mk(105, 75) }));
  assert.ok(fadingUp.workload.budget > fadingDown.workload.budget);
  // v36 could not tell them apart at all: a flat mean of the same two numbers.
  const flatUp = projectPitcher(base({ date: '2026-07-01', gameLog: mk(75, 105), tuning: { workDecay: false } }));
  const flatDown = projectPitcher(base({ date: '2026-07-01', gameLog: mk(105, 75), tuning: { workDecay: false } }));
  assert.equal(flatUp.workload.budget, flatDown.workload.budget);
});

// ── the fitted opponent exponent ────────────────────────────────────────────

test('a missing opponent leaves the opponent factor at exactly 1', () => {
  // No `opp` at all: every ratio is 1, so the fitted exponents and v36's
  // damping have to agree to the last bit.
  const none = projectPitcher(base({ date: '2026-07-01' }));
  const v36opp = projectPitcher(base({ date: '2026-07-01', fit: { ...PITCHER_FIT, opp: null } }));
  assert.equal(none.rates.adjK, v36opp.rates.adjK);
  assert.equal(none.rates.adjBB, v36opp.rates.adjBB);
  assert.equal(none.rates.adjH, v36opp.rates.adjH);
});

test('the strikeout exponent is fitted; walks, hits and home runs keep v36 damping', () => {
  const opp = { kRate: 0.25, bbRate: 0.09, avg: 0.26 };
  const ported = projectPitcher(base({ date: '2026-07-01', opp }));
  const v36 = projectPitcher(base({ date: '2026-07-01', opp, fit: { ...PITCHER_FIT, opp: null } }));
  // Only strikeouts move: the fitted pass-through is 0.55 against v36's 0.40,
  // so a high-strikeout lineup pushes him further.
  assert.ok(ported.rates.adjK > v36.rates.adjK, `${ported.rates.adjK} vs ${v36.rates.adjK}`);
  assert.equal(ported.rates.adjBB, v36.rates.adjBB);
  assert.equal(ported.rates.adjH, v36.rates.adjH);
  assert.equal(PITCHER_FIT.opp.bb, null);
  assert.equal(PITCHER_FIT.opp.h, null);
  assert.equal(PITCHER_FIT.opp.hr, null);
});

// ── the season-drift term ───────────────────────────────────────────────────

test('without a slate date there is no season drift, and with one there is', () => {
  const noDate = projectPitcher(base());
  const inert = projectPitcher(base({ fit: { ...PITCHER_FIT, progress: null } }));
  assert.equal(noDate.projOuts, inert.projOuts);

  // The fitted drift is negative for outs, so September must project shorter
  // than April for the same pitcher.
  const april = projectPitcher(base({ date: '2026-04-10', season: 2026 }));
  const september = projectPitcher(base({ date: '2026-09-10', season: 2026 }));
  assert.ok(september.projOuts < april.projOuts, `${september.projOuts} vs ${april.projOuts}`);
  // And only where a drift was fitted: strikeouts and earned runs have none
  // worth the name, hits and walks are not shipped with one at all.
  assert.equal(PITCHER_FIT.progress.hits, undefined);
  assert.equal(PITCHER_FIT.progress.bb, undefined);
});

// ── the depth-driven strikeout distribution ─────────────────────────────────

test('dist.k still has projK as its mean, drawn over the depth PMF', () => {
  const p = projectPitcher(base({ date: '2026-07-01' }));
  // E[X] = sum over k of P(X > k - 0.5) for a non-negative integer count.
  let mean = 0;
  for (let k = 1; k <= 25; k++) mean += p.dist.k(k - 0.5);
  assert.ok(Math.abs(mean - p.projK) < 0.06, `mean of dist.k ${mean} vs projK ${p.projK}`);
});

test('depthK off restores the v36 three-point batters-faced mixture exactly', () => {
  const input = base({ date: '2026-07-01' });
  const on = projectPitcher(input);
  const off = projectPitcher({ ...input, tuning: { depthK: false } });
  // Same projection, different distribution around it.
  assert.equal(on.projK, off.projK);
  assert.notEqual(on.dist.k(7.5), off.dist.k(7.5));
  // The v36 path is reachable and still integrates to the same mean.
  let mean = 0;
  for (let k = 1; k <= 25; k++) mean += off.dist.k(k - 0.5);
  assert.ok(Math.abs(mean - off.projK) < 0.06);
});

// ── the calibration, and the level factors it supersedes ────────────────────

test('PITCHER_FIT.cal supersedes kLevel, and the v36 constants are the fallback', () => {
  const input = base({ date: '2026-07-01' });
  const shipped = projectPitcher(input);
  // kLevel is inert while cal.k is present: changing it must do nothing.
  const trimmed = projectPitcher({ ...input, tuning: { kLevel: 0.5 } });
  assert.equal(shipped.projK, trimmed.projK);
  // With cal switched off it bites again, which is the fallback path.
  const noCal = projectPitcher({ ...input, fit: { ...PITCHER_FIT, cal: null, progress: null } });
  const noCalTrimmed = projectPitcher({ ...input, fit: { ...PITCHER_FIT, cal: null, progress: null }, tuning: { kLevel: 0.5 } });
  assert.ok(noCalTrimmed.projK < noCal.projK);
});

test('hLevel is retired at 1.0 — the trim docs/ACCURACY.md measured as wrong', () => {
  assert.equal(PITCHER_TUNING.hLevel, 1);
  const input = base({ date: '2026-07-01' });
  const shipped = projectPitcher(input);
  const old = projectPitcher({ ...input, tuning: { hLevel: 0.97 } });
  // Hits allowed keeps v36's anchor and slope, so the level factor is live
  // here and the whole of the change: every hits projection is 1/0.97 higher.
  assert.ok(Math.abs(shipped.projH / old.projH - 1 / 0.97) < 1e-9);
});

test('every ported term is off together without its inputs, and the model still projects', () => {
  // The thinnest call the board can make: a probable with a season line and
  // nothing else. No date, no log, no opponent, no lineup.
  const bare = projectPitcher({ season26: SEASON, season25: null, gameLog: [], park: '' });
  for (const v of [bare.projK, bare.projOuts, bare.projH, bare.projBB, bare.projER]) {
    assert.ok(Number.isFinite(v) && v > 0, `${v}`);
  }
  for (const m of ['k', 'outs', 'hits', 'bb', 'er']) {
    const p = bare.dist[m](2.5);
    assert.ok(p >= 0 && p <= 1 && Number.isFinite(p), `${m}: ${p}`);
  }
});
