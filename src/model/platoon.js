/**
 * Pitcher-specific platoon adjustment.
 *
 * WHY THE BLANKET VERSION FAILED
 *
 * The obvious way to do this is one league coefficient: "a lineup with more
 * opposite-handed bats strikes out N% less". That was measured over 4,520
 * starts (`PLATOON_PROBE=1 node tools/backtest.mjs`) and the effect was not
 * there — K/BF came back +2.3% over a full swing, the wrong direction, on a
 * non-monotonic decile column. See the note on `platoonShare` in lineupEnv.js.
 *
 * The reason is that platoon splits are strongly PITCHER-SPECIFIC. A sidearmer
 * with a 12-point split and a four-seam/curveball starter with none are not the
 * same problem, and averaging them across the league produces the null. This
 * module uses each starter's OWN vs-LHB / vs-RHB splits instead.
 *
 * HOW IT NORMALISES
 *
 * The multiplier is self-normalising, which is what keeps it from introducing a
 * level shift. A pitcher's season rate is already the average over the mix of
 * hitters he happened to face, so the reference point is his OWN season mix:
 *
 *     effective = shareVsL·rateVsL + shareVsR·rateVsR        (tonight's card)
 *     reference = seasonShareVsL·rateVsL + seasonShareVsR·rateVsR
 *     multiplier = effective / reference
 *
 * Face a lineup with your usual handedness mix and the multiplier is exactly
 * 1.0 — no league constant needed, and nothing to re-centre when the league
 * drifts. Only the DEVIATION from your own normal mix moves the projection.
 *
 * SHRINKAGE
 *
 * Split samples are small — a starter sees a few hundred batters from each side
 * in a season — so the raw split is mostly noise for anyone short of a full
 * workload. Each side is shrunk toward the pitcher's own overall rate, so a
 * pitcher with no meaningful measured split gets a multiplier of 1.0 and the
 * adjustment simply does not fire.
 */

/**
 * Regression strength for a platoon split, in batters faced.
 *
 * Deliberately heavy. At 200 BF from one side — a bit over half a season's
 * worth against that hand — the raw split still only gets half its weight. The
 * quantity being estimated is a DIFFERENCE between two noisy rates, so its
 * variance is roughly the sum of theirs; treating it as gently as a single rate
 * (strength 70 elsewhere in this model) would let a 40-batter hot streak swing
 * a projection.
 */
const SPLIT_STRENGTH = 200;

/**
 * Cap on how far the platoon multiplier may move a rate.
 *
 * Real starter K-rate splits run to roughly ±15% in the tails. Anything beyond
 * that is a small-sample artefact that shrinkage has not fully absorbed, and a
 * projection is not the place to find out.
 */
const MAX_SWING = 0.15;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Handedness composition of a lineup, from the STARTER's point of view.
 *
 * Switch hitters bat opposite the arm throwing, so they count as left-handed
 * against a right-hander and right-handed against a left-hander. That is the
 * whole reason this cannot be read off a batter's listed side alone.
 *
 * Weighted by expected plate appearances, like every other lineup aggregate
 * here — the leadoff hitter's handedness matters ~27% more than the nine-hole's.
 *
 * @param {object}   input
 * @param {Array}    input.lineup       posted lineup, in batting order
 * @param {Function} input.batSideFor   (playerId) -> 'L' | 'R' | 'S' | undefined
 * @param {string}   input.starterHand  'L' | 'R'
 * @param {number[]} input.paBySlot     expected PA per slot
 * @returns {{shareVsL: number, shareVsR: number}|null}
 */
export function lineupHandedness({ lineup, batSideFor, starterHand, paBySlot }) {
  if (!Array.isArray(lineup) || !lineup.length) return null;
  if (starterHand !== 'L' && starterHand !== 'R') return null;
  if (typeof batSideFor !== 'function') return null;

  let known = 0;
  let vsL = 0;
  lineup.slice(0, 9).forEach((player, index) => {
    const side = batSideFor(player?.id);
    if (side !== 'L' && side !== 'R' && side !== 'S') return;
    const weight = paBySlot[index] ?? paBySlot[paBySlot.length - 1];
    known += weight;
    // A switch hitter takes the favourable side: left against a RHP, right
    // against a LHP.
    const effective = side === 'S' ? (starterHand === 'R' ? 'L' : 'R') : side;
    if (effective === 'L') vsL += weight;
  });

  const total = lineup
    .slice(0, 9)
    .reduce((t, _, i) => t + (paBySlot[i] ?? paBySlot[paBySlot.length - 1]), 0);
  // Below two thirds of the card known, the composition is too noisy to act on.
  if (known <= 0 || known < 0.66 * total) return null;

  const shareVsL = vsL / known;
  return { shareVsL, shareVsR: 1 - shareVsL };
}

/**
 * Multipliers to apply to a starter's rates for tonight's specific lineup.
 *
 * @param {object} input
 * @param {object} input.vsL      {battersFaced, strikeOuts, hits, baseOnBalls, homeRuns}
 * @param {object} input.vsR      same shape
 * @param {number} input.shareVsL fraction of tonight's PAs from the left side
 * @returns {{k:number, h:number, bb:number, hr:number}} all 1.0 when unusable
 */
export function platoonMultipliers({ vsL, vsR, shareVsL }) {
  const neutral = { k: 1, h: 1, bb: 1, hr: 1 };
  if (!vsL || !vsR || shareVsL == null || isNaN(shareVsL)) return neutral;

  const bfL = vsL.battersFaced || 0;
  const bfR = vsR.battersFaced || 0;
  if (bfL <= 0 || bfR <= 0) return neutral;

  const bfTotal = bfL + bfR;
  // The pitcher's own season mix is the reference point, so a normal lineup
  // yields exactly 1.0 and only the deviation from it moves anything.
  const seasonShareVsL = bfL / bfTotal;

  const out = {};
  for (const [key, field] of [
    ['k', 'strikeOuts'],
    ['h', 'hits'],
    ['bb', 'baseOnBalls'],
    ['hr', 'homeRuns'],
  ]) {
    const nL = vsL[field] || 0;
    const nR = vsR[field] || 0;
    const overall = (nL + nR) / bfTotal;
    if (!(overall > 0)) {
      out[key] = 1;
      continue;
    }
    // Each side shrunk toward the pitcher's own overall rate.
    const rateL = (nL + overall * SPLIT_STRENGTH) / (bfL + SPLIT_STRENGTH);
    const rateR = (nR + overall * SPLIT_STRENGTH) / (bfR + SPLIT_STRENGTH);

    const effective = shareVsL * rateL + (1 - shareVsL) * rateR;
    const reference = seasonShareVsL * rateL + (1 - seasonShareVsL) * rateR;
    out[key] = reference > 0
      ? clamp(effective / reference, 1 - MAX_SWING, 1 + MAX_SWING)
      : 1;
  }
  return out;
}
