/**
 * Position sizing and risk limits.
 *
 * A signal says "this is worth trading". This module says "and this much, given
 * everything else already on". Those are different questions, and conflating
 * them is how automated systems die: not from bad signals, but from correct
 * signals sized wrong or stacked on top of each other.
 *
 * FOUR THINGS THIS GUARDS AGAINST
 *
 *   1. OVERSIZING A SINGLE BET. Kelly is optimal only if your probability is
 *      exactly right. It never is, and Kelly is brutally asymmetric about that —
 *      overestimating your edge by 2x turns the growth-optimal fraction into a
 *      losing one. Quarter-Kelly is the standard haircut and is what the board
 *      already displays, so the automation stakes the same way the app advises.
 *
 *   2. CORRELATION. Nine props on the same game are one bet on that game. The
 *      model prices each marginally and independently — it has no joint
 *      distribution across markets — so without a per-game cap a single
 *      rained-out or blowout game can hit every position at once.
 *
 *   3. RUIN. A daily loss limit that halts trading is the only mechanism here
 *      that cannot be reasoned around by a confident-looking signal.
 *
 *   4. ILLIQUIDITY. Sizing past the resting depth does not get you the price
 *      you modelled; it walks the book and turns a positive-EV trade negative.
 */

/**
 * Default limits. Deliberately conservative — these are the values a system
 * runs at before it has a track record, and every one of them can only be
 * loosened by an explicit decision in `config.js`.
 */
export const DEFAULT_LIMITS = {
  /** Kelly fraction. 0.25 = quarter-Kelly, matching the board's display. */
  kellyFraction: 0.25,
  /** Hard cap on any single position, as a fraction of bankroll. */
  maxPositionFraction: 0.02,
  /** Cap on total open exposure across everything, as a fraction of bankroll. */
  maxTotalExposureFraction: 0.25,
  /** Cap on combined exposure to any one GAME, as a fraction of bankroll. */
  maxGameExposureFraction: 0.06,
  /** Cap on combined exposure to any one PLAYER. */
  maxPlayerExposureFraction: 0.03,
  /** Stop opening positions once realised losses today reach this fraction. */
  dailyLossLimitFraction: 0.08,
  /** Never take more than this share of the resting depth at our price. */
  maxDepthShare: 0.5,
  /**
   * Absolute contract ceiling per order, regardless of everything above.
   * A fat-finger backstop, not a routine constraint — set high enough that it
   * should never be the binding limit on a sane bankroll. If your reports show
   * `binding: 'absolute'`, something upstream is wrong.
   */
  maxContractsPerOrder: 2000,
  /** Below this, an order is not worth the fee or the tracking. */
  minContracts: 5,

  /**
   * Highest price, in cents, this system will pay for a contract. `null` = no
   * cap.
   *
   * WHAT A PRICE CAP DOES AND DOES NOT DO
   *
   * It does NOT make winning easier. The break-even hit rate scales exactly
   * with the price: a 52c contract must win 52% of the time, a 20c contract
   * 20%. Fewer winners are needed and fewer arrive. Anyone reaching for cheap
   * contracts because "you only need one to hit" has the arithmetic backwards.
   *
   * Two things it genuinely does, both of which matter more on a small
   * bankroll:
   *
   *   1. FEES ARE CHEAPEST AT THE EXTREMES. The Kalshi fee peaks at 50c
   *      (1.75c per contract) and falls away either side — 1.12c at 20c, 0.63c
   *      at 10c. Since the fee is the hurdle every edge must clear first, the
   *      same modelled edge is worth more on a cheap contract. This is real,
   *      and it is the strongest argument for a cap.
   *   2. IT WIDENS WHAT A SMALL BANKROLL CAN TRADE. With a $3.60 position cap
   *      and a 5-contract minimum, anything above 72c is untradeable anyway.
   *      Capping lower concentrates the same money into markets it can
   *      actually fill.
   *
   * The cost is that it removes the middle of the board, where the model is
   * best calibrated. The relative-disagreement clamp in signals.js exists
   * precisely because the model is least reliable at low prices, and a price
   * cap steers directly into that territory — so the two work against each
   * other by design, and that is intentional rather than an oversight.
   */
  maxPriceCents: null,
};

/**
 * Growth-optimal fraction of bankroll for a binary contract.
 *
 * A contract bought at price P (dollars) pays 1 and costs P, so it wins
 * `1 − P` and loses `P`. Substituting into the Kelly criterion collapses to:
 *
 *     f* = (p − P) / (1 − P)
 *
 * which is pleasingly interpretable — it is the edge divided by the payout.
 * Returns 0 for a non-positive edge rather than a negative fraction, because
 * this system never shorts by "negative sizing"; it takes the other side
 * explicitly via the signal.
 *
 * @param {number} p          0..1, probability of settling in our favour
 * @param {number} priceCents what we pay per contract
 * @returns {number} full-Kelly fraction, >= 0
 */
export function kellyFraction(p, priceCents) {
  if (p == null || !(priceCents > 0) || priceCents >= 100) return 0;
  const price = priceCents / 100;
  const f = (p - price) / (1 - price);
  return f > 0 ? f : 0;
}

/**
 * Decide the order size for a signal, given current exposure.
 *
 * Every limit is applied as a CAP, and the binding one is reported. That
 * matters more than it sounds: a system that silently sizes to zero is
 * indistinguishable from one that found no signal, and you cannot tune what you
 * cannot see.
 *
 * @param {object} input
 * @param {object} input.signal     from `buildSignal`
 * @param {number} input.bankroll   dollars
 * @param {object} input.exposure   {total, byGame:{}, byPlayer:{}, realisedToday}
 * @param {string} [input.gameId]
 * @param {string} [input.playerId]
 * @param {object} [input.limits]
 * @returns {{contracts:number, costDollars:number, binding:string, detail:object}}
 */
export function sizeOrder({
  signal,
  bankroll,
  exposure = { total: 0, byGame: {}, byPlayer: {}, realisedToday: 0 },
  gameId,
  playerId,
  limits = DEFAULT_LIMITS,
}) {
  const reject = (binding) => ({ contracts: 0, costDollars: 0, binding, detail: {} });

  if (!signal?.tradeable) return reject('signal not tradeable');
  if (!(bankroll > 0)) return reject('no bankroll');

  // The daily loss limit is checked first and is not a cap but a HALT: once
  // tripped, nothing new opens today regardless of how good it looks.
  const lossLimit = limits.dailyLossLimitFraction * bankroll;
  if (-(exposure.realisedToday || 0) >= lossLimit) {
    return reject('daily loss limit reached');
  }

  // Checked before sizing, so a capped-out market reports WHY rather than
  // silently sizing to zero somewhere further down.
  if (limits.maxPriceCents != null && signal.priceCents > limits.maxPriceCents) {
    return reject(`price ${signal.priceCents}c above cap ${limits.maxPriceCents}c`);
  }

  const price = signal.priceCents / 100;
  const full = kellyFraction(signal.blendedProb, signal.priceCents);
  if (!(full > 0)) return reject('no positive Kelly edge');

  // Candidate caps, in dollars of cost. The smallest wins and is reported.
  const caps = {
    kelly: full * limits.kellyFraction * bankroll,
    position: limits.maxPositionFraction * bankroll,
    total: Math.max(
      0,
      limits.maxTotalExposureFraction * bankroll - (exposure.total || 0),
    ),
    game: Math.max(
      0,
      limits.maxGameExposureFraction * bankroll -
        (exposure.byGame?.[gameId] || 0),
    ),
    player: Math.max(
      0,
      limits.maxPlayerExposureFraction * bankroll -
        (exposure.byPlayer?.[playerId] || 0),
    ),
    // Depth is a contract count, converted to dollars at our price.
    depth: signal.availableContracts * limits.maxDepthShare * price,
    absolute: limits.maxContractsPerOrder * price,
  };

  let binding = 'kelly';
  let budget = caps.kelly;
  for (const [name, value] of Object.entries(caps)) {
    if (value < budget) {
      budget = value;
      binding = name;
    }
  }

  const contracts = Math.floor(budget / price);
  if (contracts < limits.minContracts) {
    return {
      contracts: 0,
      costDollars: 0,
      binding: contracts <= 0 ? binding : 'below minimum size',
      detail: { caps, fullKelly: full },
    };
  }

  return {
    contracts,
    costDollars: contracts * price,
    binding,
    detail: { caps, fullKelly: full, stakedFraction: (contracts * price) / bankroll },
  };
}

/**
 * Fold a set of open positions into the exposure shape `sizeOrder` expects.
 *
 * Exposure is measured at COST, not at current mark. What is at risk on a
 * binary contract is exactly what was paid for it — the downside is bounded and
 * known, which is the one genuinely nice property of this instrument.
 *
 * @param {Array} positions   [{costDollars, gameId, playerId}]
 * @param {number} realisedToday  signed dollars, negative for a loss
 */
export function summariseExposure(positions = [], realisedToday = 0) {
  const byGame = {};
  const byPlayer = {};
  let total = 0;
  for (const pos of positions) {
    const cost = pos?.costDollars || 0;
    total += cost;
    if (pos?.gameId) byGame[pos.gameId] = (byGame[pos.gameId] || 0) + cost;
    if (pos?.playerId) byPlayer[pos.playerId] = (byPlayer[pos.playerId] || 0) + cost;
  }
  return { total, byGame, byPlayer, realisedToday };
}
