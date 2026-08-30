/**
 * Track record per market/line — what the model has PROVEN on real games,
 * measured, and nothing else.
 *
 * Source: the lookahead-free replay of THIS model (level-calibrated, 2026-08-23)
 * over Aug 3-22 2026 — 534 real pitcher starts, 4,792 real batter-games, actual
 * posted lineups, as-of-date stats only. Harness: /tmp/backtest2 run3.mjs /
 * run3b.mjs. Two numbers decide the tier:
 *
 *   edge  — hit rate of the model's side pick minus the always-pick-the-
 *           majority-side baseline. This is what generic over/under calling
 *           earns. Most lopsided lines score high on raw hit rate and ZERO
 *           here, because "most guys don't homer" is not an edge.
 *   lift  — how much more often the model's TOP-DECILE picks (by probability)
 *           hit than the league base rate. This is what the ranked board
 *           earns even where generic side-calling adds nothing.
 *
 * Tiers:
 *   proven  — the model beats naive side-picking outright (edge >= +5pts).
 *             Take these on model probability alone, price permitting.
 *   ranked  — generic side-picking adds ~nothing, but the top of the ranked
 *             board reliably beats the base rate (lift >= +4pts). Only trust
 *             these when they surface HIGH on this board — a mid-list entry
 *             in a ranked market is noise wearing a percentage.
 *   none    — no measured advantage either way. The market's price is the
 *             best estimate available; the model has nothing to add.
 *
 * Measured values (edge / top-decile lift):
 *   K@4.5    +12.7 / +40.6   proven      K@6.5    +1.3 / +34.1   ranked
 *   K@5.5     +5.8 / +43.8   proven      K@7.5    +0.4 / +22.9   none
 *   outs@16.5 +7.9 / +27.3   proven      outs@14.5 +2.4 / +12.2  ranked
 *   outs@17.5 +1.5 / +19.7   ranked      outs@18.5 -0.7 / +18.4  none
 *   H@0.5     -0.0 / +7.5    ranked      HRR@1.5  -0.1 / +7.6    ranked
 *   H@1.5     +0.0 / +5.1    ranked      HRR@2.5  +0.0 / +5.3    ranked
 *   TB@1.5    -0.4 / +5.9    ranked      R@0.5    -0.3 / +8.6    ranked
 *   HR@0.5    +0.0 / +5.9    ranked      RBI@0.5  +0.0 / +4.3    ranked
 *
 * Unmeasured (market, line) pairs fall back to the market family's default
 * tier, marked measured:false — absence of a measurement is not evidence of
 * an edge, so nothing unmeasured can ever rate 'proven'.
 *
 * Re-derive after every model change, exactly like src/trade/calibration.js.
 */

/** Exact (market, line) tiers from the Aug 3-22 replay. */
const BY_LINE = {
  pitcher_strikeouts: {
    4.5: 'proven',
    5.5: 'proven',
    6.5: 'ranked',
    7.5: 'none',
  },
  pitcher_outs: {
    14.5: 'ranked',
    16.5: 'proven',
    17.5: 'ranked',
    18.5: 'none',
  },
  batter_hits: { 0.5: 'ranked', 1.5: 'ranked' },
  batter_total_bases: { 1.5: 'ranked' },
  batter_home_runs: { 0.5: 'ranked' },
  batter_runs_scored: { 0.5: 'ranked' },
  batter_rbis: { 0.5: 'ranked' },
  batter_hits_runs_rbis: { 1.5: 'ranked', 2.5: 'ranked' },
};

/** Family default for lines the replay did not score. Never 'proven'. */
const FAMILY_DEFAULT = {
  pitcher_strikeouts: 'ranked',
  pitcher_outs: 'ranked',
  batter_hits: 'ranked',
  batter_total_bases: 'ranked',
  batter_home_runs: 'ranked',
  batter_runs_scored: 'ranked',
  batter_rbis: 'ranked',
  batter_hits_runs_rbis: 'ranked',
};

const LABEL = {
  proven: '✓ PROVEN',
  ranked: '◆ TOP PICKS ONLY',
  none: '✕ NO EDGE',
};

const NOTE = {
  proven:
    'Backtest-proven: on Aug 3-22 real games the model beat naive side-picking outright at this line. Take on model probability, price permitting.',
  ranked:
    'The model only earns here at the TOP of the ranked board — its best-ranked picks beat the league rate, but generic over/under calling adds nothing at this line. Trust high-ranked entries; skip mid-list ones.',
  none:
    'No measured advantage at this line — the market price is the best estimate available. Shown for information; not a bet.',
};

/**
 * @param {string} market The Odds API market key (alternates resolve to their
 *   base market before lookup — pass `row.market`).
 * @param {number} line
 * @returns {{tier:'proven'|'ranked'|'none', measured:boolean, label:string, note:string}|null}
 *   null for market families the replay never scored (NRFI, singles, …):
 *   claiming any tier there would be inventing a measurement.
 */
export function trackRecord(market, line) {
  const family = BY_LINE[market];
  const fallback = FAMILY_DEFAULT[market];
  if (!family && !fallback) return null;
  const exact = family?.[line];
  const tier = exact || fallback;
  const measured = !!exact;
  return {
    tier,
    measured,
    label: measured ? LABEL[tier] : `${LABEL[tier]} · unmeasured line`,
    note: measured
      ? NOTE[tier]
      : `${NOTE[tier]} (This exact line was not in the replay window; tier is the market's default and is deliberately never 'proven'.)`,
  };
}

/** Sort demotion: 'none'-tier rows sink below proven/ranked at equal verdict. */
export function trackRank(market, line) {
  const tr = trackRecord(market, line);
  if (!tr) return 1;
  return tr.tier === 'none' ? 0 : tr.tier === 'proven' ? 2 : 1;
}
