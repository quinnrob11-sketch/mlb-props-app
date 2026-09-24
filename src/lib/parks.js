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
/**
 * Venue names the schedule uses that are the same ballpark as a table entry.
 *
 * FIX(v35) — the 2026 schedule names the Dodgers' park "UNIQLO Field at Dodger
 * Stadium" for all 81 home games. The table only knew "Dodger Stadium", and an
 * unknown venue silently returns a neutral 1.0, so no Dodgers home game had a
 * park adjustment all season: hits allowed ran ~2% high for both starters and
 * HR ~1.8% low for every hitter, on about 5% of the schedule.
 *
 * Aliases live here rather than as duplicate rows so they cannot shift the
 * column means below.
 */
export const PARK_ALIASES = {
  "UNIQLO Field at Dodger Stadium": "Dodger Stadium",
};

/**
 * Column means of PARK_FACTORS, computed once at module load.
 *
 * A park factor is a RELATIVE quantity: 110 means "10% more than an average
 * park". That only holds if the average park actually sits at 100, and in this
 * table it does not:
 *
 *     hits   99.76      so    100.76
 *     runs   99.91      hr   101.33
 *
 * So before any park-to-park difference was applied, every venue was pushing
 * home runs up 1.33% and strikeouts up 0.76% — a league-wide bias wearing the
 * costume of a park adjustment. It is small, but it is one-directional, it
 * lands on every player in every game, and it is the wrong SHAPE of error:
 * a park factor should redistribute between venues, never add to the total.
 *
 * Dividing by the column mean re-centres the table without touching any park's
 * position relative to another. Coors is exactly as extreme as it was; the
 * average park is now genuinely average.
 */
const PARK_FACTOR_MEANS = (() => {
  const means = {};
  const parks = Object.values(PARK_FACTORS);
  for (const key of ['hits', 'hr', 'so', 'runs', 'bb']) {
    const values = parks.map((p) => p[key]).filter((v) => typeof v === 'number');
    means[key] = values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 100;
  }
  return means;
})();

export function parkFactor(park, key, weight = 0.7) {
  const factors = PARK_FACTORS[park] ?? PARK_FACTORS[PARK_ALIASES[park]];
  if (!factors || factors[key] == null) return 1;
  // Re-centre on the league mean first, so an average park returns exactly 1.0
  // and the adjustment redistributes rather than inflates.
  const centred = factors[key] / (PARK_FACTOR_MEANS[key] || 100);
  return 1 + weight * (centred - 1);
}

/**
 * How a park's own geometry answers the wind, over and above the league-wide
 * wind coefficient the game model already applies.
 *
 * FITTED, not published. `tools/park-fit.mjs` gives every park with 20 or more
 * games in a wind direction its own pair of multipliers, estimated from the
 * game model's own residuals on 2025 plus 2026 through 08-09, and then pools
 * them with a spike-and-slab prior: a park is neutral unless the evidence says
 * otherwise, and the prior's own parameters (P(a park has a wind response of
 * its own) = 0.15, slab sd 0.130 in log-runs) are fitted from the 22 parks
 * rather than chosen. A park then has to clear one more bar before it is
 * written here — fitted on 2025 alone it must improve 2026, and fitted on 2026
 * alone it must improve 2025.
 *
 * ONE PARK CLEARS IT, and it is not close. At Wrigley, over the 140 games
 * outside the holdout, the model reads **3.22 runs low** when MLB reports the
 * wind blowing out and **1.01 runs high** when it reports it blowing in; the
 * raw box scores say 13.58 runs in the 31 games listed "Out To CF" against
 * 6.97 in the 38 listed "In From CF". Every other outdoor park is flat to
 * within a tenth of a run in the same cut (out -0.04, across -0.05, in +0.13),
 * which is why the league-wide `windCoef` is left exactly as it was. The
 * effect replicates independently in both seasons (out +36.6% fitted on 2025,
 * +33.0% on 2026) and its held-out log-likelihood gain is +8.0 and +8.6.
 *
 * The numbers here are the pooled posterior means, so they sit inside the raw
 * ones: out x1.248 against a raw x1.318, in x0.912 against a raw x0.889.
 *
 * Reproduce with:
 *   node tools/park-fit.mjs --acc .backtest-cache/acc_g_before.ndjson \
 *     --features .backtest-cache/features_2025.json \
 *     --features .backtest-cache/features_2026.json
 *
 * See docs/PARK-FIX.md. A park that is not in this table, and a game whose
 * wind is calm, across the field, indoors or simply not reported, get exactly
 * 1 and therefore exactly the behaviour this file had before the table existed.
 *
 * @type {Record<string, {out?: number, in?: number}>}
 */
export const PARK_WIND = {
  'Wrigley Field': { out: 1.248, in: 0.912 },
};

/**
 * The park-specific wind multiplier for one game.
 *
 * Takes the SIGN rather than the weather, so that this file and
 * `windSign` in src/model/game.js cannot drift apart on how MLB's free-text
 * wind string is read: +1 is out of the park, -1 is in from it, and 0 — calm,
 * across the field, indoors, unknown, or a forecast that carries no direction
 * at all — returns 1 and changes nothing.
 *
 * @param {string} park - Venue name, matched through `PARK_ALIASES`.
 * @param {number} sign - +1 out, -1 in, 0 / null / undefined for neither.
 * @returns {number} Multiplier to scale a run projection by (dimensionless).
 */
export function parkWindFactor(park, sign) {
  if (!sign) return 1;
  const w = PARK_WIND[park] ?? PARK_WIND[PARK_ALIASES[park]];
  if (!w) return 1;
  return (sign > 0 ? w.out : w.in) ?? 1;
}
