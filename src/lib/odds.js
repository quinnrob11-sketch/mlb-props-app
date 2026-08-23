/**
 * Sportsbook odds maths: conversions, vig removal, consensus pricing, staking.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 94-155).
 * All constants preserved exactly.
 *
 * Minified origins: sn=americanToDecimal, $a=impliedProb, Ei=probToAmerican,
 * _i=devig, Kp=consensusFair, bp=kellyFraction, Ha=blend.
 */

/**
 * Convert American (moneyline) odds to decimal odds.
 *
 * +150 -> 2.50 (win 1.5 per 1 staked, plus the stake back);
 * -120 -> 1.8333 (win 100 per 120 staked).
 *
 * @param {number|null|undefined} american - American odds, e.g. -110 or +145.
 * @returns {number|null} Decimal odds (total return per 1 unit staked), or
 *   null when the input is null/undefined/NaN.
 */
export function americanToDecimal(american) {
  // TODO(recon): verify — american === 0 is not rejected and falls to the
  // negative branch, producing 1 + 100 / -0 = -Infinity.
  return american == null || isNaN(american)
    ? null
    : american > 0
      ? 1 + american / 100
      : 1 + 100 / -american;
}

/**
 * Implied (vig-inclusive) probability of an American price.
 *
 * This is simply 1 / decimal odds, so a two-sided market's two implied
 * probabilities sum to more than 1 by the book's hold.
 *
 * @param {number|null|undefined} american - American odds.
 * @returns {number|null} Probability in (0, 1), or null if the price is
 *   unusable.
 */
export function impliedProb(american) {
  const decimal = americanToDecimal(american);
  return decimal ? 1 / decimal : null;
}

/**
 * Convert a probability back into American odds (fair, no vig added).
 *
 * Favourites (p >= 0.5) get a negative price, underdogs a positive one. The
 * result is rounded to a whole number, matching how books quote.
 *
 * @param {number} prob - Probability in (0, 1) exclusive.
 * @returns {number|null} American odds, or null for degenerate/invalid input.
 */
export function probToAmerican(prob) {
  return !prob || prob <= 0 || prob >= 1
    ? null
    : prob >= 0.5
      ? Math.round((-100 * prob) / (1 - prob))
      : Math.round((100 * (1 - prob)) / prob);
}

/**
 * @typedef {Object} DevigResult
 * @property {number|null} fairOver - Vig-free probability the over hits, or
 *   null when neither side could be priced.
 * @property {number|null} vig - The book's hold as a fraction of 1
 *   (e.g. 0.0476 for a -110/-110 pair); null when only one side was quoted.
 * @property {boolean} twoSided - Whether both sides were available.
 */

/**
 * Strip the vig from a two-sided price pair by proportional (multiplicative)
 * normalisation: fairOver = pOver / (pOver + pUnder).
 *
 * When only one side is quoted there is nothing to normalise against, so a
 * flat 2.5 percentage-point haircut approximates removing half of a typical
 * hold, floored at 2% (and mirrored to a 98% ceiling on the under-only path).
 *
 * @param {number|null|undefined} over - American price on the over.
 * @param {number|null|undefined} under - American price on the under.
 * @returns {DevigResult}
 */
export function devig(over, under) {
  const pOver = impliedProb(over);
  const pUnder = impliedProb(under);
  // FIX(v27) — two-sided quotes now devig by the POWER method rather than
  // multiplicatively. Player props carry 8-15% vig and books shade the longshot
  // side harder, which proportional splitting cannot see; see `devigPower`.
  //
  // This is safe to apply unconditionally because the two methods CONVERGE as
  // vig falls: on a -110/-110 quote they agree to the last decimal place, and
  // on a typical -135/+115 prop they differ by 0.31pp. The correction only
  // becomes material where the bias it fixes is material — 2.85pp on a
  // +400/-600 longshot. Falls back to multiplicative if the solve degenerates.
  const power = pOver != null && pUnder != null ? devigPower(over, under) : null;
  if (power) return { fairOver: power.fairOver, vig: power.vig, twoSided: true };
  return pOver != null && pUnder != null && pOver + pUnder > 0
    ? {
        fairOver: pOver / (pOver + pUnder),
        vig: pOver + pUnder - 1,
        twoSided: true,
      }
    : pOver != null
      ? { fairOver: Math.max(0.02, pOver - 0.025), vig: null, twoSided: false }
      : pUnder != null
        ? {
            fairOver: Math.min(0.98, 1 - Math.max(0.02, pUnder - 0.025)),
            vig: null,
            twoSided: false,
          }
        : { fairOver: null, vig: null, twoSided: false };
}

/**
 * @typedef {Object} BookQuote
 * @property {number|null} over - American price on the over.
 * @property {number|null} under - American price on the under.
 * @property {number} [w] - Book weight (defaults to 1). Sharp books carry a
 *   weight above 1 — see `BOOK_WEIGHT` (`{ PIN: 3 }`) in the bundle.
 */

/**
 * @typedef {Object} ConsensusResult
 * @property {number|null} fairOver - Weighted mean vig-free over probability.
 * @property {number|null} vig - Unweighted mean hold across contributing books.
 * @property {boolean} twoSided
 * @property {number} nBooks - How many two-sided books contributed (1 on the
 *   one-sided fallback, 0 when nothing was priceable).
 * @property {boolean} sharp - True when at least one contributing book had a
 *   weight above 1.
 */

/**
 * Build a consensus fair probability across several books.
 *
 * Two-sided quotes are de-vigged individually and then averaged with book
 * weights. Note the asymmetry: `fairOver` is a *weighted* mean while `vig` is
 * a plain arithmetic mean over the same books. If no book is two-sided, the
 * first one-sided quote is returned as-is.
 *
 * @param {BookQuote[]|null|undefined} quotes
 * @returns {ConsensusResult}
 */
export function consensusFair(quotes) {
  let weightedFairSum = 0;
  let weightSum = 0;
  let vigSum = 0;
  let count = 0;
  let sharp = false;

  for (const quote of quotes || []) {
    const devigged = devig(quote.over, quote.under);
    if (devigged.twoSided && devigged.fairOver != null) {
      const weight = quote.w || 1;
      weightedFairSum += devigged.fairOver * weight;
      weightSum += weight;
      vigSum += devigged.vig;
      count++;
      if (weight > 1) sharp = true;
    }
  }

  if (count) {
    return {
      fairOver: weightedFairSum / weightSum,
      vig: vigSum / count,
      twoSided: true,
      nBooks: count,
      sharp,
    };
  }

  // Fallback: no two-sided market anywhere, take the first usable one-sided
  // price and flag it as a single, non-sharp book.
  for (const quote of quotes || []) {
    const devigged = devig(quote.over, quote.under);
    if (devigged.fairOver != null) return { ...devigged, nBooks: 1, sharp: false };
  }

  return { fairOver: null, vig: null, twoSided: false, nBooks: 0, sharp: false };
}

/**
 * Full-Kelly stake fraction for a binary bet.
 *
 * f* = (p*b - q) / b, where b is the net decimal payout (decimal - 1) and
 * q = 1 - p. Negative edges are floored at 0 (no bet) rather than allowing a
 * short position.
 *
 * @param {number|null} prob - Estimated true win probability in [0, 1].
 * @param {number|null} american - The price being offered, American odds.
 * @returns {number|null} Fraction of bankroll to stake in [0, 1], or null when
 *   either input is unusable.
 */
export function kellyFraction(prob, american) {
  const decimal = americanToDecimal(american);
  if (decimal == null || prob == null) return null;
  const netOdds = decimal - 1;
  return netOdds <= 0 ? 0 : Math.max(0, (prob * netOdds - (1 - prob)) / netOdds);
}

/**
 * Expected value of a 1-unit bet, expressed in percent.
 *
 * EV% = (winProb * decimalOdds - 1) * 100, where winProb is `prob` on the over
 * side and 1 - `prob` on the under side. A return of +4.2 means the bet is
 * worth 4.2% of the stake per placement.
 *
 * NOTE(recon): the glossary maps the minified name `Ha` to `blend`, but the
 * body computes an EV percentage — nothing is blended here. The export keeps
 * the glossary name as instructed.
 * TODO(recon): verify the name — `evPercent` describes the behaviour.
 *
 * @param {number|null} prob - Model probability that the OVER hits, in [0, 1].
 * @param {number|null} american - Offered price, American odds.
 * @param {'over'|'under'} side - Which side of the line is being bet.
 * @returns {number|null} Expected value in percent of stake, or null when
 *   either input is unusable.
 */
export function blend(prob, american, side) {
  const decimal = americanToDecimal(american);
  return decimal == null || prob == null
    ? null
    : ((side === "over" ? prob : 1 - prob) * decimal - 1) * 100;
}

/**
 * Power devigging — the fair probability of the over, correcting for
 * favourite-longshot bias.
 *
 * WHY NOT MULTIPLICATIVE
 *
 * `devig` above splits the overround PROPORTIONALLY: each side keeps its share
 * of the total implied probability. That is the standard method and it is fine
 * on a sharp, low-margin market — at Pinnacle's 1-3% every method converges.
 *
 * Player props are not that market. They carry 8-15% vig, and books do not
 * spread it evenly: bettors systematically overbet longshots, so the longshot
 * side is shaded harder. Multiplicative devigging cannot see that — it removes
 * vig in proportion to price, so it under-removes it from the longshot and
 * leaves that side looking more likely than it is.
 *
 * The power method solves for the exponent k where
 *
 *     p_over^k + p_under^k = 1
 *
 * Raising both to a common power compresses the small probability more than the
 * large one, which is exactly the shape of the bias being corrected. It also
 * cannot produce a negative probability, which the additive method can.
 *
 * DIRECTION, STATED PLAINLY, BECAUSE IT CUTS BOTH WAYS
 *
 * Power assigns the longshot a LOWER fair probability than multiplicative. On a
 * +400 / -600 prop it moves the over's fair value from 18.9% to about 16.0%.
 * So against an unchanged model, apparent edges on longshots get BIGGER, not
 * smaller. That is the correct answer if the model is right about the tail and
 * an expensive one if it is not — which is why the relative clamp in
 * trade/signals.js exists independently of this.
 *
 * @param {number} over  American odds on the over
 * @param {number} under American odds on the under
 * @returns {{fairOver:number, vig:number, twoSided:boolean, k:number}|null}
 */
export function devigPower(over, under) {
  const pOver = impliedProb(over);
  const pUnder = impliedProb(under);
  if (pOver == null || pUnder == null) return null;
  if (!(pOver > 0) || !(pUnder > 0)) return null;

  const total = (k) => Math.pow(pOver, k) + Math.pow(pUnder, k);

  // total(k) is monotonically decreasing in k for probabilities below 1, so a
  // plain bisection converges. k = 1 reproduces the raw (vigged) sum.
  let lo = 0.5;
  let hi = 4;
  // Guard the bracket: if even k=4 cannot reach 1 the quote is degenerate.
  if (total(hi) > 1) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return {
    fairOver: Math.pow(pOver, k),
    vig: pOver + pUnder - 1,
    twoSided: true,
    k,
  };
}
