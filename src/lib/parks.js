/**
 * Ballpark factors and the helper that applies them to a projection.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 156-212).
 * Every park number is preserved exactly.
 *
 * Minified origins: Vp=PARK_FACTORS, un=parkFactor.
 */

/**
 * Park factors keyed by MLB venue name, as reported by the venue field of the
 * schedule payload.
 *
 * Each value is an index where 100 = league average, so 112 means 12% more of
 * that event than a neutral park and 94 means 6% fewer.
 *
 * Categories:
 *   - `runs`  - total runs scored
 *   - `hr`    - home runs
 *   - `hits`  - base hits
 *   - `so`    - strikeouts
 *   - `bb`    - walks
 *
 * NOTE(recon): several venues are duplicated under both their old and current
 * sponsorship names with identical numbers ("Rate Field"/"Guaranteed Rate
 * Field", "Daikin Park"/"Minute Maid Park"). "Sutter Health Park",
 * "George M. Steinbrenner Field" and "Tropicana Field" all appear, covering
 * the temporary A's and Rays homes.
 *
 * @type {Record<string, {runs: number, hr: number, hits: number, so: number, bb: number}>}
 */
export const PARK_FACTORS = {
  "Chase Field": { runs: 103, hr: 103, hits: 103, so: 98, bb: 100 },
  "Truist Park": { runs: 101, hr: 104, hits: 100, so: 101, bb: 100 },
  "Oriole Park at Camden Yards": {
    runs: 99,
    hr: 104,
    hits: 99,
    so: 102,
    bb: 100,
  },
  "Fenway Park": { runs: 104, hr: 96, hits: 107, so: 96, bb: 99 },
  "Wrigley Field": { runs: 98, hr: 100, hits: 99, so: 101, bb: 100 },
  "Rate Field": { runs: 101, hr: 106, hits: 100, so: 101, bb: 100 },
  "Guaranteed Rate Field": { runs: 101, hr: 106, hits: 100, so: 101, bb: 100 },
  "Great American Ball Park": {
    runs: 103,
    hr: 112,
    hits: 100,
    so: 102,
    bb: 100,
  },
  "Progressive Field": { runs: 98, hr: 99, hits: 98, so: 102, bb: 101 },
  "Coors Field": { runs: 112, hr: 107, hits: 111, so: 92, bb: 98 },
  "Comerica Park": { runs: 98, hr: 96, hits: 99, so: 101, bb: 100 },
  "Daikin Park": { runs: 100, hr: 103, hits: 99, so: 101, bb: 100 },
  "Minute Maid Park": { runs: 100, hr: 103, hits: 99, so: 101, bb: 100 },
  "Kauffman Stadium": { runs: 101, hr: 95, hits: 104, so: 98, bb: 100 },
  "Angel Stadium": { runs: 100, hr: 102, hits: 99, so: 101, bb: 99 },
  "Dodger Stadium": { runs: 100, hr: 104, hits: 97, so: 102, bb: 99 },
  "loanDepot park": { runs: 97, hr: 95, hits: 99, so: 103, bb: 100 },
  "American Family Field": { runs: 101, hr: 105, hits: 99, so: 102, bb: 101 },
  "Target Field": { runs: 99, hr: 100, hits: 99, so: 101, bb: 100 },
  "Citi Field": { runs: 97, hr: 99, hits: 97, so: 103, bb: 100 },
  "Yankee Stadium": { runs: 101, hr: 110, hits: 97, so: 102, bb: 101 },
  "Sutter Health Park": { runs: 103, hr: 102, hits: 104, so: 97, bb: 100 },
  "Citizens Bank Park": { runs: 102, hr: 107, hits: 100, so: 102, bb: 100 },
  "PNC Park": { runs: 97, hr: 94, hits: 100, so: 100, bb: 100 },
  "Petco Park": { runs: 96, hr: 98, hits: 96, so: 102, bb: 100 },
  "Oracle Park": { runs: 96, hr: 91, hits: 98, so: 103, bb: 100 },
  "T-Mobile Park": { runs: 94, hr: 98, hits: 94, so: 105, bb: 101 },
  "Busch Stadium": { runs: 98, hr: 96, hits: 100, so: 100, bb: 100 },
  "Tropicana Field": { runs: 97, hr: 97, hits: 98, so: 102, bb: 100 },
  "George M. Steinbrenner Field": {
    runs: 102,
    hr: 108,
    hits: 100,
    so: 100,
    bb: 100,
  },
  "Rogers Centre": { runs: 100, hr: 103, hits: 100, so: 100, bb: 100 },
  "Nationals Park": { runs: 100, hr: 101, hits: 100, so: 101, bb: 100 },
  "Globe Life Field": { runs: 98, hr: 100, hits: 97, so: 102, bb: 100 },
};

/**
 * Multiplier to apply to a projection for a given venue and stat category.
 *
 * Returns `1 + weight * (factor/100 - 1)`: the raw park index is converted to a
 * ratio around 1 and then shrunk toward neutral by `weight`. The default 0.7
 * reflects that a full park factor overstates the effect on a single game —
 * only ~70% of the published edge is applied. Unknown venues and unknown stat
 * keys are neutral (1).
 *
 * @param {string} park - Venue name, must match a `PARK_FACTORS` key exactly.
 * @param {'runs'|'hr'|'hits'|'so'|'bb'} key - Stat category.
 * @param {number} [weight=0.7] - How much of the park effect to apply
 *   (dimensionless; 0 = neutral, 1 = full published factor).
 * @returns {number} Multiplier to scale an expected count by (dimensionless).
 */
export function parkFactor(park, key, weight = 0.7) {
  const factors = PARK_FACTORS[park];
  if (!factors || factors[key] == null) return 1;
  return 1 + weight * (factors[key] / 100 - 1);
}
