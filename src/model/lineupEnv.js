/**
 * Lineup-derived opponent environment for a starting pitcher.
 *
 * WHY THIS EXISTS
 *
 * The matchup was modelled in one direction only. Every batter was projected
 * against the ACTUAL starter he faces — that pitcher's own shrunk rates plus his
 * handedness driving the platoon split — while the pitcher was projected against
 * his opponent's FULL-SEASON TEAM AGGREGATE. He never saw the nine hitters
 * actually in the card, and never saw their handedness at all.
 *
 * The cost is not subtle. Holding a starter fixed and swapping the lineup
 * between a contact team and a strikeout team, the batters imply 5.03 and 7.85
 * strikeouts respectively — a 2.8-strikeout spread, about ±22% — while the
 * pitcher's own projection is byte-identical in both cases. So the two halves of
 * the model could disagree by a fifth of the number being bet, on the highest
 * weighted pitcher market in the book, and nothing reconciled them. A team
 * resting its three highest-strikeout bats moved the market and did not move
 * this model at all.
 *
 * WHY THIS CANNOT CREATE A FEEDBACK LOOP
 *
 * v19 had exactly that bug: a batter's own team aggregate reached the opposing
 * starter's adjusted rates, which were then fed back into that batter's own
 * projection. It is safe now, and for a structural reason rather than by luck —
 * `loadSlate` hands `projectBatter` the starter's RAW shrunk talent rates
 * (`kRate`/`hRate`/`hrRate`), which are park-free, opponent-free and clamp-free.
 * The opponent term computed here only ever reaches `adjK`/`adjH`/`adjBB`, which
 * no batter ever reads. One hop, strictly.
 *
 * Keep it that way: if a caller ever starts passing `adjK` and friends to
 * `projectBatter`, the loop comes back and `starterTalentRates` has to divide
 * this term out (it already supports that, via `spRates.opp`).
 */

import { PA_BY_LINEUP_SLOT } from './batter.js';

/**
 * The minimum number of lineup slots we need real season stats for before
 * trusting the lineup over the team aggregate. Below this the sample is doing
 * more harm than the coarser-but-complete team number.
 */
const MIN_SLOTS_WITH_STATS = 6;

/**
 * Plate appearances the SEASON stats must cover for a hitter to count toward
 * the aggregate. A September call-up with 11 PA should not swing a lineup rate;
 * he falls through to the team number along with anyone else missing.
 */
const MIN_PA = 30;

/**
 * Build the opponent environment a starting pitcher should be projected
 * against, from the lineup actually posted behind him.
 *
 * Rates are weighted by EXPECTED PLATE APPEARANCES, not counted flat. The
 * leadoff hitter takes ~4.51 trips and the nine-hole ~3.54, so a flat mean
 * over-weights the bottom of the order by roughly a fifth. `PA_BY_LINEUP_SLOT`
 * is the same table the batter model uses, so the two sides agree on how often
 * each slot bats.
 *
 * @param {object}   input
 * @param {Array}    input.lineup      posted lineup, in batting order
 * @param {Function} input.statsFor    (playerId) -> {plateAppearances, strikeOuts,
 *                                     baseOnBalls, hits, atBats} | null
 * @param {object}   input.teamAgg     season team aggregate, the fallback
 * @returns {{kRate:number, bbRate:number, avg:number, obp?:number,
 *            source:'lineup'|'team', slotsUsed:number}}
 */
export function lineupOpponent({ lineup, statsFor, teamAgg }) {
  const fallback = { ...(teamAgg || {}), source: 'team', slotsUsed: 0 };
  if (!Array.isArray(lineup) || !lineup.length || typeof statsFor !== 'function') {
    return fallback;
  }

  let wPa = 0;
  let wK = 0;
  let wBb = 0;
  let wH = 0;
  let wAb = 0;
  let slotsUsed = 0;

  lineup.slice(0, 9).forEach((player, index) => {
    const stat = statsFor(player?.id);
    const pa = stat?.plateAppearances || 0;
    if (!stat || pa < MIN_PA) return;

    // Expected trips for this slot, used as the weight. Falls back to the
    // nine-hole value for any lineup longer than nine (it should not be).
    const weight = PA_BY_LINEUP_SLOT[index] ?? PA_BY_LINEUP_SLOT[8];

    // Weighted per-PA rates: scale each hitter's own rate by his expected trips.
    wPa += weight;
    wK += weight * ((stat.strikeOuts || 0) / pa);
    wBb += weight * ((stat.baseOnBalls || 0) / pa);
    const ab = stat.atBats || 0;
    if (ab > 0) {
      wH += weight * ((stat.hits || 0) / ab);
      wAb += weight;
    }
    slotsUsed += 1;
  });

  if (slotsUsed < MIN_SLOTS_WITH_STATS || wPa <= 0) return fallback;

  return {
    kRate: wK / wPa,
    bbRate: wBb / wPa,
    // `avg` is a per-AB rate, so it carries its own weight total — a hitter with
    // no at-bats logged contributes to neither.
    avg: wAb > 0 ? wH / wAb : teamAgg?.avg,
    obp: teamAgg?.obp,
    source: 'lineup',
    slotsUsed,
  };
}

/**
 * Share of a lineup's expected plate appearances that carry the platoon
 * advantage against a given starter.
 *
 * A batter has the advantage when he bats from the opposite side to the arm
 * throwing — a left-handed bat against a right-handed starter, and vice versa.
 * Switch hitters take whichever side is favourable, so they always count.
 *
 * Weighted by expected trips for the same reason the rates are: the leadoff
 * hitter's handedness matters about 27% more than the nine-hole's.
 *
 * Returns null when the starter's hand or too much of the lineup's handedness
 * is unknown, so callers can fall through to a neutral adjustment rather than
 * to a confidently wrong one.
 *
 * NOT WIRED INTO THE MODEL — DELIBERATELY.
 *
 * This exists because a platoon term for the pitcher is the obvious next
 * adjustment, and it is measurable. It was measured, over 4,520 starts, with
 * `PLATOON_PROBE=1 node tools/backtest.mjs`. The effect is not there:
 *
 *     d(K/BF)  / d(share)   +2.3% over a full 0->1 swing   WRONG DIRECTION
 *     d(H/BF)  / d(share)   -0.1%                          zero
 *     d(BB/BF) / d(share)   +4.0%                          decile-1 artefact
 *
 * A platoon edge should SUPPRESS strikeouts. It measures slightly positive, and
 * the decile columns are non-monotonic — noise, not signal. The likeliest
 * reason is that the variation is endogenous: managers already build the card
 * for the matchup, so a lineup with many opposite-handed bats is also a lineup
 * picked for that pitcher, and the two effects confound.
 *
 * The version that would work needs the STARTER'S OWN vs-LHB / vs-RHB splits
 * rather than a blanket league constant, because platoon splits are strongly
 * pitcher-specific (a sidearmer and a four-seam/curveball starter are not the
 * same problem). That is a real feature with its own data dependency, not a
 * coefficient.
 *
 * Shipping a blanket term on theory alone would have been exactly the invented
 * constant every other fix in this model has been careful to avoid, so it is
 * kept here, exported and tested, for the probe and for that future work.
 *
 * @param {object}   input
 * @param {Array}    input.lineup       posted lineup, in batting order
 * @param {Function} input.batSideFor   (playerId) -> 'L' | 'R' | 'S' | undefined
 * @param {string}   input.starterHand  'L' | 'R'
 * @returns {number|null} 0..1
 */
export function platoonShare({ lineup, batSideFor, starterHand }) {
  if (!Array.isArray(lineup) || !lineup.length) return null;
  if (starterHand !== 'L' && starterHand !== 'R') return null;
  if (typeof batSideFor !== 'function') return null;

  let known = 0;
  let advantaged = 0;
  lineup.slice(0, 9).forEach((player, index) => {
    const side = batSideFor(player?.id);
    if (side !== 'L' && side !== 'R' && side !== 'S') return;
    const weight = PA_BY_LINEUP_SLOT[index] ?? PA_BY_LINEUP_SLOT[8];
    known += weight;
    // Switch hitters always take the favourable side.
    if (side === 'S' || side !== starterHand) advantaged += weight;
  });

  // Below two thirds of the card known, the share is too noisy to act on.
  if (known <= 0 || known < 0.66 * PA_BY_LINEUP_SLOT.slice(0, 9).reduce((a, b) => a + b, 0)) {
    return null;
  }
  return advantaged / known;
}
