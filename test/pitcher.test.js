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

test('PITCHER_FIT.cal carries depth alone, and supersedes outsLevel where it does', () => {
  const input = base({ date: '2026-07-01' });
  const shipped = projectPitcher(input);

  // outsLevel is inert while cal.outs is present: changing it must do nothing.
  assert.equal(projectPitcher({ ...input, tuning: { outsLevel: 0.5 } }).projOuts, shipped.projOuts);
  // With cal switched off it bites again, which is the fallback path.
  const noCal = { ...PITCHER_FIT, cal: null, progress: null };
  assert.ok(
    projectPitcher({ ...input, fit: noCal, tuning: { outsLevel: 0.5 } }).projOuts <
      projectPitcher({ ...input, fit: noCal }).projOuts,
  );

  // The other four markets have no entry, so their v36 constants are live and
  // v37's levels reach them. `kLevel` at 1.0 is v37's, not this branch's.
  assert.equal(PITCHER_FIT.cal.k, undefined);
  assert.equal(PITCHER_TUNING.kLevel, 1);
  assert.ok(projectPitcher({ ...input, tuning: { kLevel: 0.5 } }).projK < shipped.projK);
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

// ── v38: the role read (docs/OPENER-FIX.md) ─────────────────────────────────
//
// `PITCHER_FIT.role` splits one shrink-to-mean into two, by reading the
// pitcher's own recent appearances with the relief outings left in. It needs
// `input.appearanceLog`, and the board loads plenty of starts without one — a
// probable with no log, a replay that never fetched it. Every one of those has
// to land on exactly the v37 number, which is what the first two tests pin.

/** An appearance log: `n` outings of `outs` outs each, one every `every` days. */
const appearances = (upTo, n, outs, every = 5) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${upTo}T00:00:00Z`) - (n - i) * every * 864e5);
    return { date: d.toISOString().slice(0, 10), gs: outs > 9 ? 1 : 0, outs, pitches: outs * 6 };
  });

/** Every number the board reads off a projection, for an exact-equality check. */
const snapshot = (p) => [
  p.projK, p.projOuts, p.projH, p.projBB, p.projER, p.projIP, p.projBF,
  ...['k', 'outs', 'hits', 'bb', 'er'].flatMap((m) =>
    [0.5, 2.5, 4.5, 11.5, 15.5, 18.5].map((l) => p.dist[m](l))),
];

test('without an appearance log the role term is inert, to the last bit', () => {
  const input = base({ date: '2026-07-01' });
  const off = { ...PITCHER_FIT, role: null };
  assert.deepEqual(
    snapshot(projectPitcher(input)),
    snapshot(projectPitcher({ ...input, fit: off })),
    'a call with no appearanceLog must be byte-identical to the model with role switched off',
  );
  // And so must a log the model cannot read: no dates, or no outs on any entry.
  for (const log of [
    [{ outs: 3 }, { outs: 3 }],
    appearances('2026-07-01', 3, 3).map(({ outs, ...rest }) => rest),
  ]) {
    assert.deepEqual(
      snapshot(projectPitcher({ ...input, appearanceLog: log })),
      snapshot(projectPitcher({ ...input, fit: off })),
      'an unreadable log is a missing log',
    );
  }
});

test('the role term never reads a date it was not given, or a game it cannot have seen', () => {
  const relief = appearances('2026-07-01', 3, 3);
  // No slate date: nothing to age the log against, so the term stays off.
  assert.deepEqual(
    snapshot(projectPitcher(base({ appearanceLog: relief }))),
    snapshot(projectPitcher(base({ fit: { ...PITCHER_FIT, role: null } }))),
  );
  // Appearances ON or AFTER the slate date are invisible. A log made only of
  // them reads as "has not pitched this season", not as tonight's evidence.
  const future = relief.map((a) => ({ ...a, date: '2026-07-05' }));
  const input = base({ date: '2026-07-01' });
  assert.equal(
    projectPitcher({ ...input, appearanceLog: future }).projOuts,
    projectPitcher({ ...input, appearanceLog: [] }).projOuts,
  );
});

test('a run of one-inning relief outings is read as a relief start, and shortens him', () => {
  const input = base({ date: '2026-07-01' });
  const asStarter = projectPitcher({ ...input, appearanceLog: appearances('2026-07-01', 6, 18) });
  const asReliever = projectPitcher({ ...input, appearanceLog: appearances('2026-07-01', 6, 3, 2) });
  assert.ok(
    asReliever.projOuts < asStarter.projOuts - 1,
    `relief pattern ${asReliever.projOuts} should be well under ${asStarter.projOuts}`,
  );
  // The depth change carries into the counting stats, because batters faced
  // moved and the per-batter rates did not.
  assert.ok(asReliever.projK < asStarter.projK);
  assert.ok(asReliever.projH < asStarter.projH);
  // One long outing inside the window is enough to say he is still a starter.
  const oneLong = appearances('2026-07-01', 3, 3, 2);
  oneLong[0].outs = 15;
  assert.ok(projectPitcher({ ...input, appearanceLog: oneLong }).projOuts > asReliever.projOuts);
});

test('the detector reads the window it is given, and only that window', () => {
  const input = base({ date: '2026-07-01' });
  // Six relief outings, the most recent of which is a full start.
  const log = appearances('2026-07-01', 6, 3, 3);
  log[5].outs = 18;
  const withStart = projectPitcher({ ...input, appearanceLog: log });
  // Drop that one outing and the same log reads as relief.
  const relief = projectPitcher({ ...input, appearanceLog: log.slice(0, 5) });
  assert.ok(relief.projOuts < withStart.projOuts - 1);
});

test('a pitcher with no appearance at all this season gets the debut line', () => {
  const input = base({ date: '2026-07-01' });
  const starterLog = appearances('2026-07-01', 6, 18);
  const debut = projectPitcher({ ...input, appearanceLog: [] });
  const starter = projectPitcher({ ...input, appearanceLog: starterLog });
  assert.notEqual(debut.projOuts, starter.projOuts);
  // The debut line is nearly flat (slope 0.19): it barely moves off its anchor,
  // so two very different workloads land close together.
  const deep = { ...input, season26: { ...SEASON, numberOfPitches: 2300 } };
  const shallow = { ...input, season26: { ...SEASON, numberOfPitches: 1300 } };
  const spread = (log) => Math.abs(
    projectPitcher({ ...deep, appearanceLog: log }).projOuts -
      projectPitcher({ ...shallow, appearanceLog: log }).projOuts,
  );
  assert.ok(spread([]) < spread(starterLog), `${spread([])} should be under ${spread(starterLog)}`);
  // `debut: null` puts him back on the starter line.
  const noDebut = { ...PITCHER_FIT, role: { ...PITCHER_FIT.role, debut: null } };
  assert.equal(
    projectPitcher({ ...input, appearanceLog: [], fit: noDebut }).projOuts,
    starter.projOuts,
  );
});

test('`pass` is a switch: with it empty, only the outs market moves', () => {
  const input = base({ date: '2026-07-01', appearanceLog: appearances('2026-07-01', 6, 3, 2) });
  const v37 = projectPitcher({ ...input, fit: { ...PITCHER_FIT, role: null } });
  const outsOnly = projectPitcher({
    ...input,
    fit: { ...PITCHER_FIT, role: { ...PITCHER_FIT.role, pass: {} } },
  });
  assert.notEqual(outsOnly.projOuts, v37.projOuts);
  for (const m of ['projK', 'projH', 'projBB', 'projER']) {
    assert.equal(outsOnly[m], v37[m], `${m} must not move with pass off`);
  }
  // With it on, each one moves by exactly the depth ratio.
  const shipped = projectPitcher(input);
  const ratio = shipped.projOuts / v37.projOuts;
  for (const m of ['projK', 'projH', 'projBB', 'projER']) {
    assert.ok(Math.abs(shipped[m] / v37[m] - ratio) < 1e-9, `${m}: ${shipped[m] / v37[m]} vs ${ratio}`);
  }
});

test('the outs distribution still integrates to the printed projection on the role path', () => {
  const input = base({ date: '2026-07-01', appearanceLog: appearances('2026-07-01', 6, 3, 2) });
  const p = projectPitcher(input);
  let mean = 0;
  for (let k = 0; k <= 27; k++) {
    mean += k * Math.max(0, (k === 0 ? 1 : p.dist.outs(k - 0.5)) - p.dist.outs(k + 0.5));
  }
  assert.ok(Math.abs(mean - p.projOuts) < 0.02, `${mean} vs ${p.projOuts}`);
});

// ── v38.1: the repair (docs/PITCHER-REPAIR.md) ──────────────────────────────
//
// Two terms. `PITCHER_FIT.bend` puts a tent on the raw projection inside the
// starter line, where the straight shrink under-projects; and `role.pass.hits`
// becomes per-class, so hits allowed stops inheriting the starter line's
// re-slope on top of its own calibration. Both are gated on the same input the
// role term is, so a board without an appearance log is still exactly v37 —
// pinned by 'without an appearance log the role term is inert' above, which
// runs with `bend` shipped and live.

/** A start the raw projection puts inside the bend window, on the starter line. */
const inWindow = (over = {}) => base({
  date: '2026-07-01',
  gameLog: Array.from({ length: 5 }, (_, i) => {
    const d = new Date(Date.parse('2026-07-01T00:00:00Z') - (5 - i) * 5 * 864e5);
    return { date: d.toISOString().slice(0, 10), ip: 3.0, pitches: 55, bf: 14, k: 5 };
  }),
  appearanceLog: appearances('2026-07-01', 3, 15),
  ...over,
});
const noBend = { ...PITCHER_FIT, bend: null };

test('without `bend` the model is exactly v38, and `bend` needs the starter class', () => {
  // A start inside the window is the only place the two can differ...
  const inside = inWindow();
  assert.notEqual(projectPitcher(inside).projOuts, projectPitcher({ ...inside, fit: noBend }).projOuts);
  // ...and every way of switching the term off lands back on v38, to the bit.
  for (const off of [
    null,
    { ...PITCHER_FIT.bend, amp: 0 },
    { ...PITCHER_FIT.bend, amp: null },
    { ...PITCHER_FIT.bend, lo: 14, peak: 11.5, hi: 10 },
  ]) {
    assert.deepEqual(
      snapshot(projectPitcher({ ...inside, fit: { ...PITCHER_FIT, bend: off } })),
      snapshot(projectPitcher({ ...inside, fit: noBend })),
      `bend ${JSON.stringify(off)} must be inert`,
    );
  }
  // No appearance log: no class, so no bend — and no role term either.
  const { appearanceLog, ...blind } = inside;
  assert.deepEqual(
    snapshot(projectPitcher(blind)),
    snapshot(projectPitcher({ ...blind, fit: { ...PITCHER_FIT, role: null, bend: null } })),
  );
  // An opener or a debut has its own fitted line and is not bent.
  for (const log of [appearances('2026-07-01', 3, 3), []]) {
    assert.deepEqual(
      snapshot(projectPitcher({ ...inside, appearanceLog: log })),
      snapshot(projectPitcher({ ...inside, appearanceLog: log, fit: noBend })),
      'only the starter class is bent',
    );
  }
});

test('the bend is local: outside its window nothing moves, and it peaks where it is told', () => {
  const at = (ip, pitches, fit) => projectPitcher({
    ...inWindow({
      gameLog: Array.from({ length: 5 }, (_, i) => {
        const d = new Date(Date.parse('2026-07-01T00:00:00Z') - (5 - i) * 5 * 864e5);
        return { date: d.toISOString().slice(0, 10), ip, pitches, bf: Math.round(pitches / 4), k: 5 };
      }),
    }),
    ...(fit ? { fit } : {}),
  });
  // A deep start: raw well above `hi`, so the tent is zero and nothing moves.
  assert.equal(at(5.2, 95).projOuts, at(5.2, 95, noBend).projOuts);
  assert.equal(at(4.4, 78).projOuts, at(4.4, 78, noBend).projOuts);
  // Inside it, the lift is there and it is the whole tent at the peak.
  const lift = (ip, p) => at(ip, p).projOuts / at(ip, p, noBend).projOuts;
  assert.ok(lift(3.0, 55) > 1.05, `${lift(3.0, 55)}`);
  assert.ok(lift(3.0, 55) > lift(4.0, 70), 'the lift falls away toward the top of the window');
  assert.ok(lift(4.0, 70) > 1, `${lift(4.0, 70)}`);
});

test('the bent map from raw depth to projected depth is still monotone', () => {
  // Two starts cannot swap order: a longer raw projection must never come out
  // shorter. Swept across and well beyond the window.
  let prev = -Infinity;
  for (let pitches = 30; pitches <= 120; pitches += 1) {
    const p = projectPitcher(inWindow({
      gameLog: Array.from({ length: 5 }, (_, i) => {
        const d = new Date(Date.parse('2026-07-01T00:00:00Z') - (5 - i) * 5 * 864e5);
        return { date: d.toISOString().slice(0, 10), ip: pitches / 18, pitches, bf: Math.round(pitches / 4), k: 5 };
      }),
    }));
    assert.ok(p.projOuts >= prev - 1e-9, `projOuts fell at ${pitches} pitches: ${p.projOuts} < ${prev}`);
    prev = p.projOuts;
  }
});

test('`bend.pass` is a switch, and every market carries the whole of the bend', () => {
  const inside = inWindow();
  const off = projectPitcher({ ...inside, fit: noBend });
  const outsOnly = projectPitcher({
    ...inside,
    fit: { ...PITCHER_FIT, bend: { ...PITCHER_FIT.bend, pass: {} } },
  });
  assert.notEqual(outsOnly.projOuts, off.projOuts);
  for (const m of ['projK', 'projH', 'projBB', 'projER']) {
    assert.equal(outsOnly[m], off[m], `${m} must not move with bend.pass empty`);
  }
  const on = projectPitcher(inside);
  const ratio = on.projOuts / off.projOuts;
  for (const m of ['projK', 'projH', 'projBB', 'projER']) {
    assert.ok(Math.abs(on[m] / off[m] - ratio) < 1e-9, `${m}: ${on[m] / off[m]} vs ${ratio}`);
  }
});

test('hits no longer inherit the starter line, and still inherit an opener one', () => {
  const v37 = (input) => projectPitcher({ ...input, fit: { ...PITCHER_FIT, role: null, bend: null } });
  // A starter outside the bend window: the role line moves outs, and hits stay
  // exactly where v37's own calibration put them.
  const starter = base({ date: '2026-07-01', appearanceLog: appearances('2026-07-01', 3, 15) });
  const shipped = projectPitcher(starter);
  assert.notEqual(shipped.projOuts, v37(starter).projOuts, 'outs must still move');
  assert.equal(shipped.projH, v37(starter).projH, 'hits must not inherit the starter line');
  // Strikeouts, walks and earned runs still do.
  for (const m of ['projK', 'projBB', 'projER']) {
    assert.notEqual(shipped[m], v37(starter)[m], `${m} still carries the starter line`);
  }
  // An opener's hits do inherit it: his own curve was never fitted for him.
  const opener = base({ date: '2026-07-01', appearanceLog: appearances('2026-07-01', 6, 3, 2) });
  const asOpener = projectPitcher(opener);
  const ratio = asOpener.projOuts / v37(opener).projOuts;
  assert.ok(ratio < 0.95, `an opener should be shortened: ${ratio}`);
  assert.ok(Math.abs(asOpener.projH / v37(opener).projH - ratio) < 1e-9, 'an opener carries the whole of it');
  // And `pass.hits: 1` puts the starter back on v38 exactly.
  const v38Hits = { ...PITCHER_FIT, role: { ...PITCHER_FIT.role, pass: { ...PITCHER_FIT.role.pass, hits: 1 } } };
  const back = projectPitcher({ ...starter, fit: v38Hits });
  assert.ok(Math.abs(back.projH / v37(starter).projH - back.projOuts / v37(starter).projOuts) < 1e-9);
});
