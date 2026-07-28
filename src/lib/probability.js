/**
 * Probability / distribution helpers.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 1-93).
 * Every numeric constant is preserved bit-for-bit; no behaviour has been
 * "improved". Where the original does something questionable it is flagged
 * with a `TODO(recon)` comment rather than fixed.
 *
 * Minified origins: zp=erf, Dp=normalCdf, $p=poissonPmf, Hp=poissonCdf,
 * Up=binomPmf, ln=binomTailOver, Ni=poissonTailOver, vl=negBinomTailOver,
 * oe=clamp.
 */

/**
 * Clamp a value into an inclusive range.
 *
 * @param {number} value - Value to constrain.
 * @param {number} lo - Lower bound (inclusive).
 * @param {number} hi - Upper bound (inclusive).
 * @returns {number} `value` limited to `[lo, hi]`. Units follow the input.
 */
export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Gauss error function, erf(x).
 *
 * Abramowitz & Stegun formula 7.1.26 — a single-precision rational/exponential
 * approximation with |error| <= 1.5e-7. Odd symmetry (erf(-x) = -erf(x)) is
 * applied explicitly because the approximation is only valid for x >= 0.
 *
 * @param {number} x - Dimensionless argument.
 * @returns {number} erf(x) in [-1, 1] (dimensionless).
 */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  // A&S 7.1.26: t = 1 / (1 + p*x), then a degree-5 Horner polynomial in t.
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/**
 * Cumulative distribution function of a normal distribution: P(X <= x).
 *
 * @param {number} x - Value to evaluate at (same units as `mean`).
 * @param {number} [mean=0] - Distribution mean.
 * @param {number} [sd=1] - Standard deviation. Non-positive collapses the
 *   distribution to a point mass at `mean`.
 * @returns {number} Probability in [0, 1].
 */
export function normalCdf(x, mean = 0, sd = 1) {
  // TODO(recon): verify — the degenerate branch returns 1 (not 0.5) when
  // x === mean exactly, which is what the bundle does.
  return sd <= 0
    ? x >= mean
      ? 1
      : 0
    : 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

/**
 * Poisson probability mass function: P(X = k) for mean `lambda`.
 *
 * Computed in log space (-lambda + k*ln(lambda) - ln(k!)) so that large k does
 * not overflow the factorial.
 *
 * @param {number} k - Non-negative integer count. Non-integers are treated as
 *   if the factorial loop ran to floor(k) — see the note below.
 * @param {number} lambda - Poisson mean (expected count, same units as k).
 * @returns {number} Probability in [0, 1].
 */
export function poissonPmf(k, lambda) {
  // Degenerate mean: all mass sits on zero.
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  // ln(k!) = sum_{r=2}^{k} ln(r); r = 1 contributes 0 so the loop starts at 2.
  // TODO(recon): verify — a non-integer k only accumulates terms up to
  // floor(k), so the result is not a true pmf for fractional k.
  for (let r = 2; r <= k; r++) logP -= Math.log(r);
  return Math.exp(logP);
}

/**
 * Poisson cumulative distribution: P(X <= k) for mean `lambda`.
 *
 * Straight summation of the pmf from 0 to k; capped at 1 to absorb
 * floating-point drift.
 *
 * @param {number} k - Upper bound of the sum (counts). Negative returns 0.
 * @param {number} lambda - Poisson mean.
 * @returns {number} Probability in [0, 1].
 */
export function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  let total = 0;
  for (let r = 0; r <= k; r++) total += poissonPmf(r, lambda);
  return Math.min(1, total);
}

/**
 * Binomial probability mass function: P(X = k) for n trials of success
 * probability p.
 *
 * The binomial coefficient is accumulated in log space
 * (sum of ln(n - i) - ln(i + 1)) to stay numerically stable for large n.
 *
 * @param {number} k - Number of successes; outside [0, n] returns 0.
 * @param {number} n - Number of trials.
 * @param {number} p - Per-trial success probability in (0, 1).
 * @returns {number} Probability in [0, 1].
 */
export function binomPmf(k, n, p) {
  if (k < 0 || k > n) return 0;
  let logCoeff = 0;
  for (let i = 0; i < k; i++) logCoeff += Math.log(n - i) - Math.log(i + 1);
  // TODO(recon): verify — p exactly 0 or 1 yields 0 * -Infinity = NaN here.
  // Callers inside the bundle guard against that (see binomTailOver).
  return Math.exp(logCoeff + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * Binomial over-tail: P(X > floor(line)) for n trials of probability p.
 *
 * This is the "over" side of a sportsbook count line — a line of 1.5 means the
 * bet wins on 2 or more, so the tail starts at floor(1.5) + 1 = 2.
 *
 * @param {number} line - Betting line (counts, typically a .5 number).
 * @param {number} n - Number of trials.
 * @param {number} p - Per-trial success probability.
 * @returns {number} Probability in [0, 1] that the over cashes.
 */
export function binomTailOver(line, n, p) {
  if (n <= 0 || p <= 0) return 0;
  // TODO(recon): verify — p >= 1 short-circuits to 1 without consulting the
  // line, so binomTailOver(5, 3, 1) returns 1 even though P(X > 5) = 0.
  if (p >= 1) return 1;
  const cutoff = Math.floor(line) + 1;
  let cdf = 0;
  for (let k = 0; k < cutoff; k++) cdf += binomPmf(k, n, p);
  return Math.max(0, Math.min(1, 1 - cdf));
}

/**
 * Poisson over-tail: P(X > floor(line)) for mean `mean`.
 *
 * @param {number} line - Betting line (counts, typically a .5 number).
 * @param {number} mean - Poisson mean (expected count).
 * @returns {number} Probability in [0, 1] that the over cashes.
 */
export function poissonTailOver(line, mean) {
  const k = Math.floor(line);
  return Math.max(0, Math.min(1, 1 - poissonCdf(k, mean)));
}

/**
 * Lanczos g=7, n=9 series coefficients for the log-gamma approximation.
 *
 * In the bundle this array is re-allocated on every call inside
 * `negBinomTailOver`; hoisting it is behaviour-preserving. The last two
 * entries appear minified as `9984369578019572e-21` and
 * `15056327351493116e-23`, i.e. 9.984369578019572e-6 and 1.5056327351493116e-7.
 */
const LANCZOS_G7_COEFFICIENTS = [
  0.9999999999998099, 676.5203681218851, -1259.1392167224028,
  771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9984369578019572e-21, 15056327351493116e-23,
];

/**
 * Natural log of the gamma function, ln Γ(z), via the Lanczos approximation
 * (g = 7, 9 coefficients). Arguments below 0.5 are reflected through the
 * Euler reflection formula ln Γ(z) = ln(π / sin(πz)) - ln Γ(1 - z).
 *
 * Internal helper — the bundle defines it inline inside `negBinomTailOver`.
 *
 * @param {number} z - Argument (dimensionless).
 * @returns {number} ln Γ(z) (dimensionless, natural log).
 */
function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let series = LANCZOS_G7_COEFFICIENTS[0];
  for (let i = 1; i < 9; i++) series += LANCZOS_G7_COEFFICIENTS[i] / (z + i);
  const t = z + 7 + 0.5; // g + 0.5, with g = 7
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series)
  );
}

/**
 * Negative-binomial probability mass function: P(X = k) for a count
 * distribution with the given mean and dispersion.
 *
 * Same (r, p) parameterisation as `negBinomTailOver`: r = `dispersion`,
 * p = dispersion / (dispersion + mean), so E[X] = mean exactly.
 *
 * ADDITIVE(recon): not present in the bundle — `negBinomTailOver` inlines this
 * expression in its own loop. Exported so callers that need the *mass* (e.g.
 * the H+R+RBI convolution in `model/batter.js`) do not have to re-derive it.
 * The tail function is left untouched.
 *
 * @param {number} k - Non-negative integer count.
 * @param {number} mean - Expected count.
 * @param {number} [dispersion=1.3] - Shape parameter r (dimensionless).
 * @returns {number} Probability in [0, 1].
 */
export function negBinomPmf(k, mean, dispersion = 1.3) {
  if (k < 0) return 0;
  // Degenerate mean: all mass sits on zero (matches negBinomTailOver's guard).
  if (mean <= 0) return k === 0 ? 1 : 0;
  const p = dispersion / (dispersion + mean);
  const logPmf =
    logGamma(k + dispersion) -
    logGamma(dispersion) -
    logGamma(k + 1) +
    dispersion * Math.log(p) +
    k * Math.log(1 - p);
  return Math.exp(logPmf);
}

/**
 * Negative-binomial over-tail: P(X > floor(line)) for a count distribution with
 * the given mean and dispersion.
 *
 * Uses the (r, p) parameterisation where r = `dispersion` and
 * p = dispersion / (dispersion + mean). Smaller `dispersion` means more
 * overdispersion relative to Poisson; as dispersion -> infinity this converges
 * to `poissonTailOver`. The default of 1.3 is the model's standing assumption
 * for player-prop counts, which are fatter-tailed than Poisson.
 *
 * @param {number} line - Betting line (counts, typically a .5 number).
 * @param {number} mean - Expected count.
 * @param {number} [dispersion=1.3] - Shape parameter r (dimensionless).
 * @returns {number} Probability in [0, 1] that the over cashes.
 */
export function negBinomTailOver(line, mean, dispersion = 1.3) {
  if (mean <= 0) return 0;
  const p = dispersion / (dispersion + mean);
  const cutoff = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= cutoff; k++) {
    // log pmf = ln Γ(k+r) - ln Γ(r) - ln Γ(k+1) + r ln p + k ln(1-p)
    const logPmf =
      logGamma(k + dispersion) -
      logGamma(dispersion) -
      logGamma(k + 1) +
      dispersion * Math.log(p) +
      k * Math.log(1 - p);
    cdf += Math.exp(logPmf);
  }
  return clamp(1 - cdf, 0, 1);
}
