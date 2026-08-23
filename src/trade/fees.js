/**
 * Kalshi trading fees.
 *
 * These are not a rounding detail. Kalshi's fee is largest exactly where a prop
 * model finds most of its edges — near 50c — and it is charged on the way IN
 * regardless of outcome. A 3-point edge on a coin-flip market is roughly a
 * break-even trade after fees, and a system that ignores them will happily
 * trade itself to zero while reporting positive EV.
 *
 * Published formula, per order:
 *
 *     fee = ceil( 0.07 x C x P x (1 - P) )      in DOLLARS
 *
 * where C is the contract count and P the price in dollars (0.01-0.99), rounded
 * up to the next cent. The ceiling applies to the whole order rather than per
 * contract, so fees are very slightly cheaper in size.
 *
 * NOTE ON UNITS — this is worth stating because getting it wrong is silent and
 * expensive. The formula's output is DOLLARS. Everything else in this codebase
 * counts cents, so the conversion has to happen here, once. The first draft of
 * this file treated the result as cents and therefore understated every fee by
 * a factor of 100, which would have had the system trading happily on edges
 * that did not exist. Kalshi's own worked example is the check: 100 contracts
 * at 50c costs $1.75, i.e. 175 cents, not 1.75.
 *
 * Two properties worth holding onto:
 *
 *   - It peaks at P = 0.50 (1.75c per contract) and falls to ~0.16c at 0.02 or
 *     0.98. Cheap markets to trade are the confident ones.
 *   - Maker and taker pay the same. Resting an order saves you the spread, not
 *     the fee.
 *
 * `FEE_RATE` is isolated so a schedule change is a one-line edit, and every
 * consumer reads the function rather than reimplementing the arithmetic.
 */

/** Fee coefficient from Kalshi's published schedule. */
export const FEE_RATE = 0.07;

/**
 * Trading fee for an order, in cents.
 *
 * @param {number} contracts  whole contracts, >= 0
 * @param {number} priceCents 1..99, the price per contract
 * @returns {number} fee in cents, always a whole number
 */
export function tradingFeeCents(contracts, priceCents) {
  if (!(contracts > 0) || !(priceCents > 0) || priceCents >= 100) return 0;
  // Integer arithmetic until the final divide, deliberately. Written as
  // `100 * 0.07 * contracts * p * (1 - p)` this returns 175.00000000000003 for
  // the exchange's own worked example, and `Math.ceil` turns that into 176 —
  // a phantom cent added to EVERY order, always in the same direction.
  //
  // 100 * FEE_RATE is exactly 7, and p * (1 - p) is
  // priceCents * (100 - priceCents) / 10000, so the whole thing is integers
  // over a constant and the ceiling sees an exact value.
  return Math.ceil(
    (7 * contracts * priceCents * (100 - priceCents)) / 10_000,
  );
}

/**
 * Fee expressed per contract, in cents — the form that belongs in an EV
 * calculation, since EV is quoted per contract everywhere else in this model.
 *
 * Uses the un-ceilinged rate deliberately: the ceiling is an order-level
 * artefact, and applying it per contract would overstate the cost by up to a
 * full cent on a one-contract order and mis-rank markets against each other.
 *
 * @param {number} priceCents 1..99
 * @returns {number} fractional cents per contract
 */
export function feePerContractCents(priceCents) {
  if (!(priceCents > 0) || priceCents >= 100) return 0;
  return (7 * priceCents * (100 - priceCents)) / 10_000;
}

/**
 * The edge, in probability points, that a price must clear before a trade is
 * merely break-even after fees.
 *
 * This is the single most useful number for sizing a threshold: at 50c it is
 * 1.75 points, so a "3-point edge" is really 1.25 points of actual expectation.
 *
 * @param {number} priceCents
 * @returns {number} probability points (0..1 scale)
 */
export function breakEvenEdge(priceCents) {
  return feePerContractCents(priceCents) / 100;
}
