# Is the game model's run environment accurate, and is tonight's over-lean real?

On the 2026-09-23 board the game model's four largest disagreements with the
market were all totals and all **overs** — MIA @ CHC over 6.5 by 19.5 points,
TB @ NYY over 6.5 by 15.0, MIL @ PHI over 7 by 12.5, STL @ PIT over 7.5 by
11.8 — every one of them on a posted total of 6.5 to 7.5. A one-sided lean
that large is either a real read or a fresh bias in a model that shipped hours
earlier (`docs/GAME-EDGE-SEARCH.md`, `docs/GAME-PORT.md`). This is the check.

**Verdict, up front.**

1. **The projected total is accurate**, at the level, in its shape, and at
   every line books actually post. Over 4,213 games outside the holdout it
   projects **8.970** against **8.932** actually scored — a bias of **−0.04
   runs** — and its quoted probability is within **0.8 points** of the observed
   frequency at 6.5, 7.5, 8.5, 9.5 and 10.5.
2. **The lean is not a low-total bias.** The games the model itself prices
   below 7.5 come in at **+0.04 runs [−0.65, +0.87]** against the projection.
   There is no level error at the bottom of the board and no shape error
   anywhere: the amplification exponent that best explains the runs scored is
   **γ = 1.01 [0.92, 1.09]** on 7,810 team-games. The model is not damping a
   signal it has.
3. **Nor is it a starter, a park or a September effect.** Each was tested and
   each came back inside its interval.
4. **But tonight's four overs are still not a read, and a bet on them would
   have lost.** When this model has sat a run or more above the exchange's
   total, the runs have come in **1.57 below the model [−2.41, −0.72]** and
   0.31 below the market. The disagreement is the model being *less informed*,
   not *biased*: the market's total carries **0.577 runs of standard deviation
   the model cannot see**, and about half of that predicts what the model
   misses. It reaches totals the model never reaches — 1st percentile 7.21
   against the model's 7.59 — which is also the mechanical reason the largest
   disagreements are overs: **70% of them always have been.**
5. **Nothing in `src/model/game.js` was changed**, because every test that
   could have justified a change came back saying the number is already right.
   What changed is measurement: `tools/` now measures this, repeatably, and
   this document records what it says.

Every number below is against the **box score**. The one section that uses a
price uses it to choose the sample, never as a target, and nothing was fitted.

---

## How it was measured

No new replay. `tools/backtest-games-v2.mjs --src` prices the shipped
`src/model/game.js` on the lookahead-free feature table, `tools/accuracy-extract.mjs`
records one compact row per game, and `tools/accuracy-report.mjs` scores it.

```
node tools/game-features.mjs --season 2025 --cache .backtest-cache --out .backtest-cache/features_2025.json
node tools/game-features.mjs --season 2026 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/features_2026.json
node tools/fit-game-v2.mjs --config core --no-score \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/params-core.json
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --features .backtest-cache/features_2026.json --features .backtest-cache/features_2025.json \
  --params .backtest-cache/params-core.json --out .backtest-cache/acc_g_all.ndjson
node tools/accuracy-report.mjs .backtest-cache/acc_g_all.ndjson --totals --slices
```

The feature tables were rebuilt from scratch in this worktree and the fit
reproduced the shipped configuration exactly — `parkExp` 1.5, `spKPriorBF` 10,
`spHrPriorBF` 4000, `tempCoef` 0.004, `windCoef` 0.004, `top4Exp` 0,
`spFirstInningExp` 1.4, `offPriorSeasonGames` 30, `explainedTeamSd` 0.1310 —
so what is scored below is the file the board runs, on the data the study used.

**Windows.** Everything is reported outside the holdout first (2025 plus 2026
through 09-01, 4,213 games). The fit/validate split of
`docs/GAME-EDGE-SEARCH.md` is kept where a parameter is estimated: the
amplification test is fitted on **FIT only** (2025 plus 2026 through 08-09) and
then read on validate and holdout. The holdout 2026-09-02..09-22 was looked at
**once**, at the end, and nothing here was chosen on it.

**Two caveats, both measured rather than assumed.** The feature table's lineup
is the card that took the field and its weather is what was recorded at first
pitch; the live board gets a projected card and a forecast with no wind
direction. `tools/game-features-asof.mjs` builds the decision-time substitutes
(Open-Meteo's archive reaches back 92 days, so this comparison runs on
2026-08-01..09-22, 705 games):

| inputs | projected | actual | bias | slope | gap at 7.5 / 8.5 / 9.5 |
|---|---|---|---|---|---|
| posted card + recorded weather | 9.151 | 8.908 | −0.243 | 1.01 | +0.6 / +0.8 / +1.4 pts |
| **decision time** (projected card, forecast) | 9.120 | 8.908 | −0.212 | 0.99 | +0.3 / +0.6 / +1.1 pts |

The two are the same number. Hindsight is worth about 0.03 runs of level and
nothing at all to the conclusions, so the main tables use the study's inputs.
The hard bound — the lineup and weather terms switched off entirely — is worse,
as it should be (γ rises to 1.06 [0.96, 1.16] on FIT), which is the sign that
those terms carry real spread rather than noise.

---

## 1. Is the total calibrated against outcomes?

**Level.** 4,213 games outside the holdout: projected **8.970**, actual
**8.932**, bias **−0.039 runs**.

**At the lines books post.** Averaged over every game, the model's stated
probability against the frequency the thing happened:

| line | n | model says | actually happened | gap |
|---|---|---|---|---|
| over 6.5 | 4,213 | 67.8% | 67.6% | +0.2 pts |
| over 7.5 | 4,213 | 56.9% | 56.1% | +0.8 pts |
| over 8.5 | 4,213 | 49.3% | 48.7% | +0.7 pts |
| over 9.5 | 4,213 | 39.5% | 39.4% | +0.1 pts |
| over 10.5 | 4,213 | 33.1% | 32.9% | +0.1 pts |

Not one of the five is outside its interval. The whole-market calibration
error is **ECE 0.76 points [0.60, 1.72]** with an overall gap of **+0.4 points
[−1.0, +1.8]** and a Brier skill of 7.7% against the base rate.

**Bucketed by what the model said** — where a level error (every band the same
way) separates from a shape error (the low bands one way, the high bands the
other):

| projected band | n | projected | actual | bias | 95% |
|---|---|---|---|---|---|
| < 7.5 | 112 | 7.25 | 7.29 | **+0.04** | [−0.73, +0.84] |
| 7.5–8.0 | 385 | 7.78 | 7.48 | −0.30 | [−0.69, +0.09] |
| 8.0–8.5 | 759 | 8.27 | 8.45 | +0.18 | [−0.13, +0.49] |
| 8.5–9.0 | 984 | 8.75 | 8.94 | +0.19 | [−0.06, +0.47] |
| 9.0–9.5 | 923 | 9.23 | 9.04 | −0.19 | [−0.47, +0.13] |
| 9.5–10.0 | 593 | 9.73 | 9.44 | −0.29 | [−0.61, +0.11] |
| 10.0+ | 457 | 10.52 | 10.46 | −0.06 | [−0.52, +0.36] |

Seven bands, no monotone tilt, every interval containing zero.

**The shape, not just the mean.** Two tests.

*Does the projection move as far as reality does?* Regressing the runs scored
on the projection gives a slope of **0.96 [0.79, 1.13]**. The stronger version
fits one free parameter — μ′ = L·(μ/L)^γ, Poisson maximum likelihood on the
runs each side actually scored, **on the FIT window alone**:

| window | n | γ | 95% |
|---|---|---|---|
| **FIT** (2025 + 2026 to 08-09) | 7,810 team-games | **1.01** | [0.92, 1.09] |
| VALIDATE (08-10..09-01) | 616 | 1.03 | [0.71, 1.36] |
| HOLDOUT (09-02..09-22) | 546 | 1.16 | [0.84, 1.47] |
| the total itself, FIT | 3,905 games | 0.96 | [0.85, 1.07] |

γ = 1 to within ±0.09. **A model that damped its own signal enough to explain
tonight's board would need γ near 1.3, and the FIT interval excludes it.**

*Is the distribution around the projection the right width?* Every (game, line)
pair bucketed by how far the line sits from that game's own projection — a
distribution that is too narrow quotes too few overs well above its projection
and too many well below:

| line − projection | n | model says | happened | gap |
|---|---|---|---|---|
| ≤ −2.5 | 2,499 | 72.1% | 71.1% | +0.9 |
| −2.5..−1.5 | 3,714 | 62.8% | 62.5% | +0.3 |
| −1.5..−0.75 | 3,110 | 55.0% | 54.8% | +0.2 |
| −0.75..−0.25 | 2,131 | 49.3% | 47.6% | +1.6 |
| −0.25..+0.25 | 2,037 | 44.8% | 44.2% | +0.6 |
| +0.25..+0.75 | 2,070 | 40.5% | 39.5% | +1.0 |
| +0.75..+1.5 | 2,745 | 35.5% | 35.0% | +0.4 |
| +1.5..+2.5 | 2,245 | 29.3% | 30.9% | −1.6 |
| ≥ +2.5 | 514 | 22.3% | 22.6% | −0.3 |

Across six runs of line movement the largest error is 1.6 points and no bucket
is outside its interval. The inning-by-inning convolution, the ghost-runner
extras and the Gauss-Hermite mixture produce the right width.

**Holdout, once.** 273 games: projected 9.080, actual 9.055, bias −0.025, slope
1.03 [0.49, 1.56], γ 1.05 [0.63, 1.47]. Per line the model reads 3–6 points
*low* on overs (over 8.5 50.3% against 54.2%) — the window ran hot, as
`docs/GAME-PORT.md` already recorded, and the miss is in the **opposite**
direction to tonight's lean.

---

## 2. Is the lean specific to LOW totals? (the first hypothesis, and the answer is no)

Every game flagged tonight had a posted total of 6.5–7.5. Cutting the model's
own low end as finely as the sample allows:

| | n | projected | actual | bias | over 6.5 model → actual | over 7.5 model → actual |
|---|---|---|---|---|---|---|
| proj < 7.25 | 41 | 7.01 | 6.73 | −0.28 [−1.53, +0.94] | 50.8 → 48.8 | 38.6 → 34.1 |
| proj < 7.5 | 112 | 7.25 | 7.29 | +0.04 [−0.65, +0.87] | 53.3 → 50.9 | 41.1 → 38.4 |
| proj < 7.75 | 271 | 7.48 | 7.08 | −0.39 [−0.88, +0.11] | 55.5 → 50.9 | 43.4 → 38.4 |
| proj < 8.0 | 497 | 7.66 | 7.44 | −0.22 [−0.60, +0.17] | 57.3 → 54.3 | 45.2 → 41.0 |

Every interval contains zero, and the point estimates do not agree on a sign.
Restricted to the games where each line is the one a book would actually hang
(|projection − line| ≤ 0.75), the model reads +2.1 points at 6.5 (n=41), +3.1
at 7.5 (n=832), −0.5 at 8.5 (n=2,488), +1.6 at 9.5 and +2.8 at 10.5 — a
scatter of a couple of points with no pattern in the line.

**There is a real finding at the low end, and it is not a bias.** It is
*reach*. The model's projected totals have a 1st percentile of **7.26** and a
minimum of 6.34 over 4,486 games — and on the 831 games where the exchange's
number can be read beside it, a 1st percentile of 7.59 against the market's
7.21. It almost never prices a game the way books priced four games tonight. That is not the model shrinking a signal — γ says it
is not — it is the model not having the signal at all. Section 5 measures how
much.

---

## 3. Does it depend on the starter?

Low posted totals usually mean two strong starters, so the obvious mechanism is
a run-prevention term regressed too hard toward league average. Three tests,
all negative.

**The fit already searched for it.** `spExp` — the exponent on the starter's
run-prevention index — is a free parameter of `tools/fit-game-v2.mjs` with the
candidate list `[0.6, 0.8, 1.0, 1.2, 1.4, 1.7, 2.0]`. Poisson maximum
likelihood on 7,810 FIT team-games chose **1.0**. Amplifying the starter term
is not something the fit was never allowed to do; it is something it was
offered and declined.

**The index is not clipped.** Over 8,972 starter-games the index has mean
1.003, sd 0.110, range 0.666 to 1.435, and **not one game** sits on either
clamp (`spLo` 0.55, `spHi` 1.70). The bullpen index likewise: sd 0.095, range
0.751 to 1.311, zero at a clamp. Nothing is being squashed.

**The runs agree.** Runs scored against the starter faced, per team-game, on
the FIT window:

| starter index faced | n | projected | actual | bias |
|---|---|---|---|---|
| < 0.75 (the best arms) | 146 | 3.66 | 3.61 | −0.05 ± 0.52 |
| 0.75–0.85 | 452 | 3.89 | 3.65 | −0.24 ± 0.24 |
| 0.85–1.00 | 2,797 | 4.27 | 4.30 | +0.03 ± 0.12 |
| 1.00–1.10 | 2,317 | 4.64 | 4.63 | −0.00 ± 0.13 |
| 1.10+ | 1,350 | 4.93 | 4.87 | −0.06 ± 0.16 |

The slope of the residual on (index − 1) is **−0.005 ± 0.659**, and on an
elite-only hinge, max(0, 1 − index), **−0.56 ± 1.12**. Pooling all three
windows the elite bucket (< 0.85, n=720) reaches −0.24 ± 0.21 — but so does the
*weakest* bucket (> 1.2, n=307) at −0.39 ± 0.37, in the same direction, which
is not what under-crediting good pitching looks like, and neither survives
being asked for on the fit window alone.

**Verdict: the starter term is correctly weighted.** If the market's low totals
come from the arms, they come from something about the arms this model does not
measure, not from a coefficient it measures too weakly.

---

## 4. September

| month | n | projected | actual | bias | 95% | over 8.5 model → actual |
|---|---|---|---|---|---|---|
| 2025-04 | 304 | 8.54 | 8.64 | +0.10 | [−0.36, +0.62] | 45.6 → 46.7 |
| 2025-05 | 412 | 8.71 | 8.64 | −0.07 | [−0.50, +0.40] | 47.0 → 45.9 |
| 2025-06 | 398 | 8.92 | 8.89 | −0.03 | [−0.52, +0.41] | 48.9 → 48.0 |
| 2025-07 | 370 | 9.12 | 8.99 | −0.12 | [−0.57, +0.31] | 50.6 → 53.2 |
| 2025-08 | 422 | 9.10 | 9.36 | +0.26 | [−0.17, +0.66] | 50.5 → 52.8 |
| **2025-09** | 374 | 9.01 | 8.80 | −0.20 | [−0.59, +0.19] | 49.7 → 45.7 |
| 2026-04 | 316 | 8.75 | 9.13 | +0.38 | [−0.08, +0.84] | 47.5 → 50.6 |
| 2026-05 | 419 | 8.80 | 8.61 | −0.19 | [−0.55, +0.21] | 47.9 → 47.7 |
| 2026-06 | 395 | 9.11 | 9.35 | +0.24 | [−0.21, +0.77] | 50.5 → 52.2 |
| 2026-07 | 371 | 9.31 | 9.01 | −0.30 | [−0.75, +0.20] | 52.2 → 45.0 |
| 2026-08 | 417 | 9.19 | 8.70 | **−0.49** | [−0.86, −0.05] | 51.2 → 47.0 |
| **2026-09** | 288 | 9.10 | 9.20 | +0.11 | [−0.37, +0.59] | 50.4 → 54.5 |

The model tracks the month. Both Septembers are inside their interval, and they
point in **opposite** directions (2025 −0.20, 2026 +0.11), so there is no
expanded-roster or cold-weather drift to correct. One month of twelve, 2026-08,
sits just outside its interval at −0.49, which is one in twelve at a 5% bar.
Expanded rosters are visible in the *inputs* — the model reads September's
scoring level through `league.rpg` and its parks through the forecast — and
those are enough.

## 4b. The one place there is real structure: the park

The largest residual structure anywhere in this check is by venue. Across the
29 parks with 80 or more games, the bias (actual − projected) has a standard
deviation of **0.44 runs**, against the **0.36** pure sampling noise would
produce at that sample size — so roughly **0.25 runs of real per-park error**,
symmetric, with no level in it:

| too low (model under-projects) | | too high (model over-projects) | |
|---|---|---|---|
| Coors Field | +0.91 ± 0.81 | Busch Stadium | −0.79 ± 0.63 |
| Nationals Park | +0.63 ± 0.80 | Angel Stadium | −0.74 ± 0.65 |
| Sutter Health Park | +0.62 ± 0.69 | Great American Ball Park | −0.70 ± 0.74 |
| **Wrigley Field** | **+0.55 ± 0.79** | Globe Life Field | −0.62 ± 0.62 |

Four of 29 fall outside their own interval where about 1.5 would be expected,
so some of this is real. It is **not** the explanation for tonight: the park
with the biggest flagged over is Wrigley, where the model has historically run
**too low**, not too high. Fixing 0.25 runs of park error means refitting park
factors on about 150 games per park, which is a study of its own and a good way
to overfit; it is recorded here as the best available next lead, not acted on.

---

## 5. So what IS tonight, then?

Everything above says the projection is right on average, right in shape, right
by month, right by starter. It cannot, by construction, say whether the market
knows something the model does not — a model can be perfectly calibrated and
still be missing half the available information. That question needs the price,
so `tools/totals-vs-market.mjs` asks it in the only way that keeps outcomes as
the judge: the market **selects the games**, and the runs decide who was wrong.

831 games, 2026-07-16..09-16, the exchange's KXMLBTOTAL ladder read at T−120
from the settled public candlesticks another study already cached. The implied
total is the sum of the mids, E[T] = Σ P(T > k). **Nothing is fitted and the
market is not an input to anything.**

| | n | model | market | ACTUAL | model bias | market bias |
|---|---|---|---|---|---|---|
| every game | 831 | 9.22 | 9.04 | 8.93 | −0.28 [−0.58, +0.02] | −0.10 [−0.40, +0.20] |
| **model ≥ 1 run ABOVE market** | **62** | **9.94** | **8.68** | **8.37** | **−1.57 [−2.41, −0.72]** | −0.31 [−1.17, +0.55] |
| within a run of each other | 743 | 9.13 | 8.99 | 8.93 | −0.21 [−0.53, +0.11] | −0.06 [−0.39, +0.26] |
| model ≥ 1 run BELOW market | 26 | 9.85 | 11.23 | 10.46 | +0.62 [−1.06, +2.29] | −0.76 [−2.48, +0.95] |

**When the model has sat a run or more above the price, the runs came in 1.57
below the model and the interval excludes zero.** That is exactly tonight's
configuration, and historically it has been the model that was wrong.

Three more facts from the same table explain the shape of the board:

- **Of the 88 disagreements of a run or more, 62 are the model high — 70%
  overs.** A board whose biggest gaps are all overs is the normal state of this
  model, not a new symptom. It follows mechanically from the next line.
- **The market reaches lower than the model does.** sd 1.000 against 0.863;
  1st percentile 7.21 against 7.59; minimum 6.53 against 7.16. The two agree
  much better at the top (95th: 10.95 against 10.74) than at the bottom, so the
  biggest gaps land on the market's low games and read as overs.
- **The market's extra spread is real information, not noise.** Put both
  numbers in one regression of the runs actually scored and the market's
  coefficient is **+0.514 [+0.049, +0.984]** while the model's is +0.434
  [−0.100, +0.986]. The part of the market orthogonal to the model has a
  standard deviation of **0.577 runs**, and regressing (actual − model) on it
  gives a slope of **0.514 [0.033, 1.006]** — it predicts what the model
  misses.

And in the games that look most like tonight's:

| | n | model | market | ACTUAL | model bias | market bias |
|---|---|---|---|---|---|---|
| market prices it under 7.75 | 58 | 7.99 | 7.48 | 7.05 | −0.94 [−1.81, −0.07] | −0.43 [−1.30, +0.44] |
| model prices it under 7.75 | 22 | 7.59 | 7.43 | 6.09 | −1.50 [−2.75, −0.25] | −1.34 [−2.58, −0.10] |

When the market posts a low total the game really is low — it averaged 7.05
runs, and the model had it at 7.99.

**The conclusion is specific.** The model's own signal is scaled exactly right
(γ = 1.01); it simply has less of it than the market does, by about 0.58 runs
of standard deviation, and the shortfall is concentrated at the bottom of the
board. Amplifying what it has would make it worse, and blending the market in
is `MARKET_WEIGHT`, which is out of scope here and already set deliberately.

## 6. What this means for the board

Tonight's four overs were never bettable and are not now. A team-market row
whose model-minus-market gap exceeds `IMPLAUSIBLE_TEAM_EDGE` (0.08) is forced
to PASS with "model >8pts off market — treated as model error, not edge", and
every game line carries `PLAY_RULES.gameLinesInformationOnly` on top of that.
All four flagged rows are 11.8 to 19.5 points off and are screened twice. The
measurement above says the screen has been calling it correctly: a disagreement
of that size has been the model's error 62 times out of 88.

---

## What changed

**`src/model/game.js` is untouched, and so are `MARKET_WEIGHT` and
`PLAY_RULES`.** Every test that could have justified a change said the number
is already right, and the one-parameter shape test rules out the change the
board's symptom would suggest.

Measurement, in `tools/` only:

- `tools/accuracy-extract.mjs` now records the run-environment terms behind
  each game — the two starter and bullpen run-prevention indices, the two
  offence indices and the park × weather factor — so a calibration gap can be
  traced to the part of the projection that caused it instead of only observed.
- `tools/accuracy-report.mjs --totals` prints the whole of sections 1, 2 and 4:
  the level, the projected-total and actual-total bands, the posted ladder both
  unconditionally and restricted to the games where each line would be hung,
  the low end cumulatively, the regression slope, the **amplification γ** with
  a profile-likelihood interval, and the width of the per-game distribution
  bucketed by line-minus-projection. Two slices were added to `--slices`,
  `g.projtotal` and `g.starters`.
- `tools/totals-vs-market.mjs` is new: it reads the accuracy records and the
  cached public Kalshi ladders and answers section 5. It makes no request, fits
  nothing, and exists so that "whose disagreement is wrong?" can be settled by
  the box score rather than argued about.

`npm test` is 242 of 242. The league-aggregate calibration tests in
`test/game.test.js` and `test/gameFit.test.js` were not touched or loosened;
nothing they pin was changed.

## Caveats

- **The holdout has now been looked at three times** — the study, the port and
  this check. Nothing here was chosen on it: the only parameter estimated in
  this document, γ, was fitted on FIT alone and the holdout reading is
  reported, not used.
- **The market comparison spans 2026-07-16..09-16 only**, because Kalshi's
  live tier holds settled game markets back to 2026-07-14. 62 games in the
  decisive bucket is not many, and the interval on −1.57 is wide. The
  *direction* is the robust part; the size is not.
- **The implied total is a sum of mids over a ladder**, so it carries the
  exchange's spread and the geometric tail past the top rung. Both are small
  against a gap of a run, and both push the market's number slightly toward the
  middle rather than away from it.
- **The decision-time comparison covers 705 games (2026-08-01..09-22)**, the
  reach of Open-Meteo's 92-day archive. It agrees with the study's inputs to
  0.03 runs of level, so the main tables are quoted on the study's inputs; an
  earlier run that tried to stretch the archive back to June produced
  implausibly cold forecast temperatures at the boundary, and those months are
  excluded rather than reported.
- **"The market is better informed" is not "the market is right."** Its own
  bias over 831 games is −0.10 [−0.40, +0.20], and in the games it prices under
  7.75 it was still 0.43 runs high. Both numbers are estimates of the same
  runs.
