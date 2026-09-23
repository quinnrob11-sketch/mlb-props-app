// Candidate starting-pitcher model for docs/PITCHER-EDGE-SEARCH.md ("M2").
//
// Differences from the shipped `projectPitcher`, all of them things the brief
// asked to be tested rather than assumed:
//
//   - one recency-weighted, partially pooled estimate of each per-BF rate,
//     built from BOTH seasons' game logs with a fitted half-life and a fitted
//     offseason gap, instead of `2026 + 0.6 x 2025` with a fixed shrinkage
//     strength;
//   - the opponent read from the NINE MEN POSTED, each with his own
//     recency-weighted rate, plus a fitted platoon term on lineup handedness,
//     instead of a team-season aggregate;
//   - home-plate umpire and catcher effects, each partially pooled;
//   - park, temperature, home/away and rest as fitted coefficients;
//   - a JOINT distribution. Depth is drawn first (an empirical conditional
//     distribution of outs given predicted outs, so the inning-boundary spikes
//     and the left skew come from the data, not from a normal); then, given
//     depth, strikeouts are binomial in the batter-outs and hits and walks are
//     negative binomial in them. One realisation of depth drives every market,
//     which is what makes K, hits and walks correlate the way they do in life.
//
// Pure functions: `fit()` reads only the rows it is given, `predict()` reads
// only its features and the fitted parameters.

// ── numerics ────────────────────────────────────────────────────────────────
const LG_CACHE = new Float64Array(4096);
let lgFilled = 0;
export function lgamma(x) {
  // Lanczos, g=7, n=9.
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const logFact = (n) => {
  if (n < 4096) {
    if (n >= lgFilled) for (let i = lgFilled; i <= n; i++) LG_CACHE[i] = i < 2 ? 0 : LG_CACHE[i - 1] + Math.log(i);
    if (n >= lgFilled) lgFilled = n + 1;
    return LG_CACHE[n];
  }
  return lgamma(n + 1);
};
const logChoose = (n, k) => logFact(n) - logFact(k) - logFact(n - k);

/** P(X = k), X ~ Binomial(n, p). */
export function binomPmf(k, n, p) {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/** P(X = k), X ~ NegBinomial(r successes, success prob p); support k >= 0 failures. */
export function nbPmf(k, r, p) {
  if (k < 0 || r <= 0) return k === 0 && r <= 0 ? 1 : 0;
  if (p >= 1) return k === 0 ? 1 : 0;
  if (p <= 0) return 0;
  return Math.exp(lgamma(k + r) - lgamma(r) - logFact(k) + r * Math.log(p) + k * Math.log1p(-p));
}

/** Negative binomial parameterised by mean and shape k (Var = m + m^2/k). */
export function nbPmfMean(x, mean, shape) {
  if (mean <= 0) return x === 0 ? 1 : 0;
  const p = shape / (shape + mean);
  return Math.exp(lgamma(x + shape) - lgamma(shape) - logFact(x) + shape * Math.log(p) + x * Math.log1p(-p));
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── time ────────────────────────────────────────────────────────────────────
const EPOCH = Date.parse('2025-01-01');
const dayOf = (date) => Math.round((Date.parse(date) - EPOCH) / 864e5);
/** Real gap between the 2025 and 2026 regular seasons, in days. */
const REAL_OFFSEASON = 179;
/**
 * Compressed calendar: within a season, real days; across the offseason,
 * `offDays` instead of the real 179. One parameter replaces the fixed
 * "prior season at 0.6" blend.
 */
export const ct = (date, season, offDays) => dayOf(date) - (season - 2025) * (REAL_OFFSEASON - offDays);

// ── weighted, partially pooled rate accumulators ────────────────────────────
/**
 * A decaying accumulator over a player's own history.
 * `push` must be called in date order; `at` returns the decayed totals as of a
 * query time (strictly after everything pushed so far).
 */
export class Decay {
  constructor(tau, fields) {
    this.tau = tau; this.fields = fields;
    this.sums = new Float64Array(fields.length);
    this.t = null;
  }
  _advance(t) {
    if (this.t == null) { this.t = t; return; }
    const f = Math.exp(-(t - this.t) / this.tau);
    for (let i = 0; i < this.sums.length; i++) this.sums[i] *= f;
    this.t = t;
  }
  push(t, vals) {
    this._advance(t);
    for (let i = 0; i < this.sums.length; i++) this.sums[i] += vals[i];
  }
  at(t) {
    if (this.t == null) return new Float64Array(this.sums.length);
    const f = Math.exp(-(t - this.t) / this.tau);
    const out = new Float64Array(this.sums.length);
    for (let i = 0; i < this.sums.length; i++) out[i] = this.sums[i] * f;
    return out;
  }
}

/** Partial pooling: weighted rate pulled toward `prior` with `strength` effective trials. */
export const pooled = (num, den, prior, strength) => (num + strength * prior) / (den + strength);

// ── regression helpers ──────────────────────────────────────────────────────
/** Solve A x = b for a small symmetric system (Gauss-Jordan with partial pivoting). */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) continue;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[n]);
}

/** Ordinary least squares with a ridge penalty (intercept is column 0 of X). */
export function ols(X, y, ridge = 1e-6, w = null) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const wi = w ? w[i] : 1;
    for (let j = 0; j < p; j++) {
      b[j] += wi * X[i][j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += wi * X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < p; j++) A[j][j] += ridge * X.length;
  return solve(A, b);
}

/**
 * Poisson / relative-risk regression with a log offset:
 *   E[y_i] = exposure_i * exp(offset_i + x_i . beta)
 * Newton-Raphson; a handful of coefficients, so this is instant.
 */
export function poissonFit(X, y, exposure, offset, { ridge = 1e-4, iters = 30 } = {}) {
  const p = X[0].length;
  let beta = new Array(p).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      let eta = offset[i];
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      const mu = exposure[i] * Math.exp(eta);
      const r = y[i] - mu;
      for (let j = 0; j < p; j++) {
        g[j] += X[i][j] * r;
        for (let k = 0; k < p; k++) H[j][k] += X[i][j] * X[i][k] * mu;
      }
    }
    for (let j = 0; j < p; j++) { g[j] -= ridge * X.length * beta[j]; H[j][j] += ridge * X.length; }
    const step = solve(H, g);
    let big = 0;
    for (let j = 0; j < p; j++) { beta[j] += step[j]; big = Math.max(big, Math.abs(step[j])); }
    if (big < 1e-9) break;
  }
  return beta;
}

// ── the outs distribution: empirical, conditional on predicted depth ────────
/**
 * P(outs = o | predicted outs mu), estimated by Gaussian-kernel-weighting the
 * fit-window starts in mu. Nothing about the shape is assumed: the spikes on
 * multiples of three, the cliff after 18 and the left skew are whatever the
 * data say they are at that depth.
 */
export function fitOutsTable(mu, outs, { grid = 41, lo = 6, hi = 22, bw = 0.55 } = {}) {
  const centres = Array.from({ length: grid }, (_, i) => lo + ((hi - lo) * i) / (grid - 1));
  const table = centres.map(() => new Float64Array(28));
  for (let g = 0; g < grid; g++) {
    const c = centres[g];
    let tot = 0;
    for (let i = 0; i < mu.length; i++) {
      const z = (mu[i] - c) / bw;
      if (Math.abs(z) > 4) continue;
      const w = Math.exp(-0.5 * z * z);
      const o = Math.max(0, Math.min(27, outs[i]));
      table[g][o] += w; tot += w;
    }
    if (tot > 0) for (let o = 0; o < 28; o++) table[g][o] /= tot;
    // A thin floor, so a threshold no fit-window start ever reached is not a
    // hard zero.
    let s = 0;
    for (let o = 0; o < 28; o++) { table[g][o] = table[g][o] * 0.999 + 0.001 / 28; s += table[g][o]; }
    for (let o = 0; o < 28; o++) table[g][o] /= s;
  }
  return { centres, table, lo, hi, grid };
}

/** Linear interpolation between the two nearest kernel centres. */
export function outsPmfFromTable(tab, mu) {
  const x = clamp(((mu - tab.lo) / (tab.hi - tab.lo)) * (tab.grid - 1), 0, tab.grid - 1);
  const i = Math.min(tab.grid - 2, Math.floor(x));
  const f = x - i;
  const pmf = new Float64Array(28);
  for (let o = 0; o < 28; o++) pmf[o] = (1 - f) * tab.table[i][o] + f * tab.table[i + 1][o];
  return pmf;
}

// ── assembling one start's distributions ────────────────────────────────────
/**
 * P(X > line) for a count with mean `m` and variance-to-mean ratio `phi`.
 *
 * One family covers all four counting markets because, measured conditional on
 * depth over 8,252 fit-window starts, they are not all Poisson and they do not
 * all miss in the same direction:
 *
 *     var/mean given outs    hits 0.85   walks 0.86   K 0.95   ER 1.25
 *
 * Hits and walks are UNDERdispersed once depth is known (a start that lasted 18
 * outs cannot have had 12 hits), earned runs are OVERdispersed (the crooked
 * inning), strikeouts are close to Poisson. So: phi < 1 is a binomial, phi > 1
 * a negative binomial, phi = 1 a Poisson. Fitting one number per market
 * replaces four separately-argued distribution choices.
 */
export function dispersedTail(line, m, phi) {
  const kMax = Math.floor(line);
  if (kMax < 0) return 1;
  if (m <= 1e-6) return 0;
  let c = 0;
  if (phi < 0.98) {
    const n = Math.max(1, Math.round(m / (1 - phi)));
    const p = clamp(m / n, 1e-6, 1 - 1e-6);
    for (let k = 0; k <= Math.min(n, kMax); k++) c += binomPmf(k, n, p);
  } else if (phi > 1.02) {
    const shape = clamp(m / (phi - 1), 0.3, 500);
    for (let k = 0; k <= kMax; k++) c += nbPmfMean(k, m, shape);
  } else {
    let p = Math.exp(-m);
    c = p;
    for (let k = 1; k <= kMax; k++) { p *= m / k; c += p; }
  }
  return clamp(1 - c, 0, 1);
}

/**
 * Given a depth PMF and per-start conditional means, produce P(X > line) for
 * every market. Depth is drawn once and everything else is conditioned on it:
 *
 *   outs  o   ~ the empirical depth distribution
 *   X     | o ~ a count with mean mu_X(o, pitcher) and fitted dispersion
 *
 * The conditional means are fitted rather than derived because the directions
 * differ and matter. Measured over 4,860 starts in 2025, K / outs is 0.318,
 * 0.308, 0.315, 0.308, 0.309 at 9, 12, 15, 18 and 21 outs — flat, so
 * strikeouts really are a fixed share of the outs. Hits are NOT: E[hits | outs]
 * runs 4.79, 5.41, 5.03, 4.65, 4.03 over the same depths — flat, then falling,
 * because a pitcher is pulled for traffic as well as for pitch count. Earned
 * runs fall hard with depth (3.55 -> 1.16). Pricing each market from its own
 * independent distribution, as the shipped model does, throws all of that away.
 */
export function assembleDist(outsPmf, means) {
  const oMax = 27;
  const mix = (mu, phi) => (line) => {
    let s = 0;
    for (let o = 0; o <= oMax; o++) {
      const w = outsPmf[o];
      if (w < 1e-9) continue;
      s += w * dispersedTail(line, mu(o), phi);
    }
    return clamp(s, 1e-6, 1 - 1e-6);
  };
  return {
    k: mix(means.k, means.phiK),
    hits: mix(means.h, means.phiH),
    bb: mix(means.bb, means.phiBB),
    er: mix(means.er, means.phiER),
    outs: (line) => {
      let c = 0;
      for (let o = 0; o <= Math.floor(line) && o <= oMax; o++) c += outsPmf[o];
      return clamp(1 - c, 1e-6, 1 - 1e-6);
    },
  };
}
