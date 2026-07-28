/**
 * Starting-pitcher projection.
 *
 * Reconstructed from `/tmp/work/app.js` lines 228-361 (`Wp` -> `projectPitcher`).
 * Every clamp bound, damping coefficient and dispersion parameter is preserved
 * exactly.  Comments describe *what each adjustment models and which way it
 * pushes*; they are not endorsements of the modelling choice.
 *
 * Shape of the pipeline:
 *
 *   season stats ──shrunkRate──▶ raw per-BF rates
 *                                     │
 *                    opponent + park adjustments (clamped)
 *                                     ▼
 *                              adjusted per-BF rates
 *                                     │
 *   pitch-count budget ──▶ IP budget ──┴──▶ projBF ──▶ every counting stat
 */

import { clamp, normalCdf, binomTailOver, poissonTailOver, negBinomTailOver }
  from '../lib/probability.js';
import { parkFactor } from '../lib/parks.js';
import { LEAGUE_AVG, shrunkRate } from './league.js';

/**
 * Parse an MLB-style innings-pitched string ("5.2" = 5 and 2/3 innings) into a
 * real number.  The fractional digit counts *outs*, not tenths.
 *
 * NOTE(recon): in the bundle this is a free-standing shared helper (`An`,
 * bundle.pretty.js:9034) also used by `loadSlate` and `gradeSlate`.  It is
 * exported here so those call sites have a home; it arguably belongs in a
 * shared `lib/stats.js`.  TODO(recon): verify final placement.
 */
export function parseInningsPitched(ip) {
  if (ip == null) return 0;
  const text = String(ip);
  const [whole, frac] = text.split('.');
  return (parseInt(whole, 10) || 0) + (frac ? (parseInt(frac, 10) || 0) / 3 : 0);
}

/**
 * Project a starting pitcher's line and the per-market tail distributions the
 * edge engine consumes.
 *
 * @param {object}   input
 * @param {object}   input.season26  current-season pitching split
 * @param {object}   input.season25  prior-season pitching split
 * @param {Array}    input.gameLog   per-start log: {ip, pitches, bf, k, date}
 * @param {object}   input.opp       opposing team rates {kRate, bbRate, avg}
 * @param {string}   input.park      venue name (keys PARK_FACTORS)
 * @param {object}   input.lg        league overrides merged onto LEAGUE_AVG
 */
export function projectPitcher(input) {
  const {
    season26,
    season25,
    gameLog = [],
    opp,
    park,
  } = input;

  const lg = { ...LEAGUE_AVG, ...(input.lg || {}) };
  const s26 = season26 || {};
  const s25 = season25 || {};

  const bf26 = s26.battersFaced || 0;
  const bf25 = s25.battersFaced || 0;

  // ---------------------------------------------------------------------
  // 1. Raw per-batter-faced talent rates, shrunk to league priors.
  //    HR gets strength 120 (vs the 70 default) because per-BF home-run rate
  //    is the noisiest of the four — bigger strength ⇒ heavier regression ⇒
  //    the projection moves less off a hot/cold HR run.
  // ---------------------------------------------------------------------
  const kRate  = shrunkRate(s26.strikeOuts,  bf26, s25.strikeOuts,  bf25, lg.kRate);
  const bbRate = shrunkRate(s26.baseOnBalls, bf26, s25.baseOnBalls, bf25, lg.bbRate);
  const hRate  = shrunkRate(s26.hits,        bf26, s25.hits,        bf25, lg.hRate);
  const hrRate = shrunkRate(s26.homeRuns,    bf26, s25.homeRuns,    bf25, lg.hrRate, 120);

  // Opponent lineup quality. Falls back to league average when the opponent
  // aggregate is missing, which makes the adjustment a no-op (ratio = 1).
  const oppK   = opp?.kRate  ?? lg.kRate;
  const oppBB  = opp?.bbRate ?? lg.bbRate;
  const oppAvg = opp?.avg    ?? lg.avg;

  // ---------------------------------------------------------------------
  // 2. Opponent + park adjustments.
  //
  //    Each is `rate * (1 + damping * (oppRate/leagueRate - 1))`. The damping
  //    coefficient is the fraction of the opponent's deviation from league
  //    average that is passed through to this pitcher:
  //      K   0.40 — a high-K lineup pushes projected K rate UP by 40% of its
  //                 own excess K rate.
  //      BB  0.30 — patient lineups push walks UP, more weakly.
  //      H   0.35 — the opponent's team AVG pushes hits allowed UP.
  //    Park weights differ by stat: strikeouts use a HALF-weight park factor
  //    (0.5) because K park effects are mostly a foul-territory/backdrop
  //    artifact, hits/HR use the standard 0.7.
  //
  //    Walks receive NO park factor at all even though PARK_FACTORS carries a
  //    `bb` column — the `bb` column is dead data. HR receives NO opponent
  //    adjustment even though lineup HR power obviously matters.
  // ---------------------------------------------------------------------
  const adjK = clamp(
    kRate * (1 + 0.4 * (oppK / lg.kRate - 1)) * parkFactor(park, 'so', 0.5),
    0.05, 0.45,
  );
  const adjBB = clamp(
    bbRate * (1 + 0.3 * (oppBB / lg.bbRate - 1)),
    0.02, 0.18,
  );
  const adjH = clamp(
    hRate * (1 + 0.35 * (oppAvg / lg.avg - 1)) * parkFactor(park, 'hits', 0.7),
    0.12, 0.34,
  );
  const adjHR = clamp(
    hrRate * parkFactor(park, 'hr', 0.7),
    0.005, 0.07,
  );

  // ---------------------------------------------------------------------
  // 3. Pitch-count budget — how deep the manager will let him go.
  // ---------------------------------------------------------------------
  const recent = gameLog.slice(-5);

  // Median pitch count over the last five starts, used only as a yardstick.
  const medianPitches = (() => {
    const sorted = recent.map((g) => g.pitches || 0).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  })();

  // Keep only "real" starts: >= 60% of the median pitch count. This drops
  // rain-shortened / ejected / opener outings so they don't drag the budget
  // DOWN artificially.
  const fullOutings = recent.filter((g) => (g.pitches || 0) >= 0.6 * medianPitches);

  const recentPitchAvg = fullOutings.length
    ? fullOutings.reduce((sum, g) => sum + (g.pitches || 0), 0) / fullOutings.length
    : null;

  // A season only counts as "starter usage" if he started at all and his
  // appearances are within 25% of his starts (i.e. he isn't mostly relieving).
  const isStarterSeason = (season) =>
    (season.gamesStarted || 0) > 0 &&
    (season.gamesPlayed || season.gamesStarted) <= (season.gamesStarted || 0) * 1.25;

  // Season-long pitches per start. The prior season is discounted 0.95 —
  // a small downward nudge for age/role drift.
  const seasonPitchesPerStart =
    isStarterSeason(s26) && s26.numberOfPitches
      ? s26.numberOfPitches / s26.gamesStarted
      : isStarterSeason(s25) && s25.numberOfPitches
        ? (s25.numberOfPitches / s25.gamesStarted) * 0.95
        : null;

  // Blend recent form (55%) with season baseline (45%); fall back to 82
  // pitches when neither is available. Clamped to a plausible MLB range —
  // 45 is opener territory, 112 is a workhorse ceiling.
  let pitchBudget;
  if (recentPitchAvg != null && seasonPitchesPerStart != null) {
    pitchBudget = 0.55 * recentPitchAvg + 0.45 * seasonPitchesPerStart;
  } else {
    pitchBudget = recentPitchAvg ?? seasonPitchesPerStart ?? 82;
  }
  pitchBudget = clamp(pitchBudget, 45, 112);

  // ---------------------------------------------------------------------
  // 4. Convert the pitch budget into innings.
  // ---------------------------------------------------------------------

  // Pitch economy, 2025 weighted 0.6 exactly as in shrunkRate. Requires >50
  // weighted BF before trusting it; clamped to 3.3-4.5 P/BF.
  const pitchesWeighted = (s26.numberOfPitches || 0) + 0.6 * (s25.numberOfPitches || 0);
  const bfWeighted = bf26 + 0.6 * bf25;
  const pitchesPerBF = bfWeighted > 50
    ? clamp(pitchesWeighted / bfWeighted, 3.3, 4.5)
    : lg.pitchesPerBF;

  // Out rate per batter faced. Starts from 1 - (hits + walks + 0.008), where
  // 0.008 stands in for HBP; the +0.045 credits double plays / caught
  // stealing, i.e. outs recorded on batters who did reach. Both the inner
  // on-base sum (0.20-0.50) and the resulting out rate (0.55-0.85) are clamped.
  const outRatePerBF = 1 - clamp(adjH + adjBB + 0.008, 0.2, 0.5) + 0.045;

  // Batters faced per inning = 3 outs / out-rate.
  const bfPerInning = 3 / clamp(outRatePerBF, 0.55, 0.85);

  // Innings the pitch budget buys.
  const ipBudget = pitchBudget / (pitchesPerBF * bfPerInning);

  // Observed recent innings (same filtered outings), or the budget if we have
  // no usable log.
  const recentIp = fullOutings.length
    ? fullOutings.reduce((sum, g) => sum + g.ip, 0) / fullOutings.length
    : ipBudget;

  // 60% budget / 40% observed. Clamped 1.5-7.4 IP.
  const projIP = clamp(0.6 * ipBudget + 0.4 * recentIp, 1.5, 7.4);

  const projBF = projIP * bfPerInning;
  const projPitches = projBF * pitchesPerBF;

  const strikePct = s26.strikePercentage
    ? clamp(parseFloat(s26.strikePercentage), 0.55, 0.72)
    : lg.strikePct;

  // ---------------------------------------------------------------------
  // 5. Counting-stat projections.
  // ---------------------------------------------------------------------
  const projK = projBF * adjK;

  // Outs = 3 per inning MINUS 0.6. The subtraction models the partial inning
  // a starter is typically pulled in (he rarely exits on exactly the third
  // out), pushing the outs projection DOWN by roughly a fifth of an inning.
  // Floored at 3 (one inning).
  const projOuts = Math.max(3, projIP * 3 - 0.6);

  const projH = projBF * adjH;
  const projBB = projBF * adjBB;
  const projHR = projBF * adjHR;

  const ip26 = parseInningsPitched(s26.inningsPitched);
  const ip25 = parseInningsPitched(s25.inningsPitched);

  // IP-weighted ERA blend, prior season again at 0.6. Note the numerator
  // weights 2025 by `ip25 * 0.6` while the denominator uses `ip25 * 0.6` too,
  // so this is a consistent weighted mean. Default 4.20 with no innings.
  const eraBlend = ip26 + ip25 > 0
    ? (parseFloat(s26.era || 0) * ip26 + parseFloat(s25.era || 0) * ip25 * 0.6) /
      (ip26 + ip25 * 0.6)
    : 4.2;

  // FIP with the classic 13/3/-2 weights and a 3.12 constant. Defence-
  // independent, so it pulls the ER projection toward "true talent" and away
  // from the batted-ball luck baked into ERA.
  const fip = ip26 + ip25 > 0
    ? (13 * ((s26.homeRuns || 0) + 0.6 * (s25.homeRuns || 0)) +
        3 * ((s26.baseOnBalls || 0) + 0.6 * (s25.baseOnBalls || 0)) -
        2 * ((s26.strikeOuts || 0) + 0.6 * (s25.strikeOuts || 0))) /
       (ip26 + 0.6 * ip25) +
      3.12
    : 4.2;

  // Bottom-up run estimate from this start's projected events: each non-HR hit
  // is worth 0.47 runs, each HR 1.4, each walk 0.33, then the whole thing is
  // scaled 0.92 (roughly the earned/total split plus sequencing damping).
  const runsFromEvents = ((projH - projHR) * 0.47 + projHR * 1.4 + projBB * 0.33) * 0.92;

  // Final ER = 40% bottom-up events, 30% FIP-scaled, 30% ERA-scaled, minus a
  // flat 0.25 (shading DOWN — unearned-run / sequencing haircut). Floored 0.2.
  const projER = Math.max(
    0.2,
    0.4 * runsFromEvents + 0.3 * ((fip * projIP) / 9) + 0.3 * ((eraBlend * projIP) / 9) - 0.25,
  );

  // Integer BF used as the binomial trial count for strikeouts.
  const bfTrials = Math.max(1, Math.round(projBF));

  // Standard deviation of outs recorded, in outs. 3.8 outs ≈ 1.27 innings.
  const outsSd = 3.8;

  // ---------------------------------------------------------------------
  // 6. Market tail distributions: each returns P(stat > line).
  // ---------------------------------------------------------------------
  const dist = {
    // Strikeouts: binomial in BF. Because BF itself is uncertain, this is a
    // 3-point equal-weight mixture over BF-3 / BF / BF+3, which fattens both
    // tails relative to a single binomial. The per-BF K probability is
    // re-derived from projK/bfTrials and re-clamped 0.02-0.60.
    k: (line) => {
      const p = clamp(projK / bfTrials, 0.02, 0.6);
      return (
        binomTailOver(line, Math.max(1, bfTrials - 3), p) +
        binomTailOver(line, bfTrials, p) +
        binomTailOver(line, bfTrials + 3, p)
      ) / 3;
    },

    // Outs recorded: normal approximation with a +0.5 continuity correction.
    // Outs is the one market where a symmetric continuous distribution is
    // used, which ignores the hard floor at 0 and the manager-driven left skew.
    outs: (line) => 1 - normalCdf(line + 0.5, projOuts, outsSd),

    // Hits allowed and walks: Poisson (variance = mean).
    hits: (line) => poissonTailOver(line, projH),
    bb: (line) => poissonTailOver(line, projBB),

    // Earned runs: negative binomial with dispersion k = 1.15. Var = mu +
    // mu^2/1.15, i.e. strongly overdispersed relative to Poisson — this models
    // the blow-up start (crooked-number innings) and fattens the OVER tail.
    er: (line) => negBinomTailOver(line, projER, 1.15),
  };

  // ---------------------------------------------------------------------
  // 7. Warning flags (exact strings — consumed by the UI and by
  //    `attachLines`, which halves the market weight on "SMALL SAMPLE").
  // ---------------------------------------------------------------------
  const flags = [];
  const gamesStarted = s26.gamesStarted || 0;

  // Thin in BOTH seasons — note the `&&`: a pitcher with 90 BF this year is
  // never flagged regardless of last year.
  if (bf26 < 80 && bf25 < 200) flags.push('SMALL SAMPLE');

  // Under 62 projected pitches — likely to be pulled early.
  if (pitchBudget < 62) flags.push('SHORT LEASH');

  // Recent starts averaging under 3.4 IP — bulk guy or following an opener.
  if (fullOutings.length && recentIp < 3.4) flags.push('BULK/OPENER RISK');

  // Listed as a probable but has never started this season.
  if (gamesStarted === 0 && (s26.gamesPlayed || 0) > 0) flags.push('RELIEF ROLE?');

  return {
    rates: {
      kRate,
      bbRate,
      hRate,
      hrRate,
      adjK,
      adjBB,
      adjH,
      adjHR,
    },
    workload: {
      budget: pitchBudget,
      pPerBF: pitchesPerBF,
      bfPerIp: bfPerInning,
      ipBudget,
      recentIp,
    },
    projIP,
    projBF,
    projPitches,
    projK,
    projOuts,
    projH,
    projBB,
    projER,
    projHR,
    projStrikes: projPitches * strikePct,
    projBalls: projPitches * (1 - strikePct),
    fip,
    eraBlend,
    dist,
    flags,
  };
}
