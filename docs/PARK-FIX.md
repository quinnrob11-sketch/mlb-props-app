# The park: what was really wrong with it, and what a two-season fit can and cannot fix

`docs/TOTALS-CHECK.md` left one lead. Across the 29 parks with 80 or more
games the game model's per-park bias had a standard deviation of **0.44 runs**
against the **0.36** sampling noise alone would produce — about **0.25 runs of
real, unmodelled park error** — and Wrigley Field sat at **+0.55 with the model
too low**. This is the study that went after it.

**Verdict, up front.**

1. **Wrigley's +0.55 is not a park error. It is wind, and it is enormous.**
   When MLB reports the wind blowing out at Wrigley the model reads **3.22 runs
   low** (49 games, ±1.43); when it reports it blowing in, **1.01 runs high**
   (72 games, ±0.98). The raw box scores agree without any model: 13.58 runs in
   the 31 games listed "Out To CF" against 6.97 in the 38 listed "In From CF".
   At **every other outdoor park** the same cut is flat — out −0.04, across
   −0.05, in +0.13 — so the league-wide wind coefficient is right and only
   Wrigley's geometry is unmodelled. The effect replicates independently in
   2025 and 2026 and predicts the season it was not fitted on.
2. **That one term is what shipped.** `PARK_WIND` in `src/lib/parks.js` carries
   fitted multipliers for Wrigley alone — **×1.248 with the wind out, ×0.912
   with it in** — and `src/model/game.js` multiplies them into `env`. Wrigley's
   wind-out bias falls from **+3.22 to +0.98** and its wind-in bias from −1.01
   to −0.30; its overall bias falls from **+0.55 to +0.14**. No other park's
   projection changes by a single digit.
3. **Per-park residual sd: 0.465 → 0.452** outside the holdout, against a
   series-block noise floor of 0.375 — so of the 0.27 runs of apparent real
   park error, about **0.02 runs of sd** came out. That is the honest headline
   and it is small, because one park in twenty-nine cannot move a
   twenty-nine-park standard deviation far. **In the cell a total is actually
   priced in — park × wind state — the residual sd falls from 0.754 to 0.643
   against a floor of 0.646, which takes the implied real error in that cut
   from 0.39 runs to zero.** Wrigley-with-the-wind-out was the single worst
   cell on the board and is no longer in the top five.
4. **The other 0.25 runs should not be fitted, and this study is the reason.**
   A per-park run-level table fitted with proper partial pooling was built,
   and then failed the only test that matters: fitted on 2025 it is worth
   **+0.0** log-likelihood on 2026, and fitted on 2026 it is worth **−1.7** on
   2025. Applied across the season boundary it makes the per-park bias sd
   **worse** (0.679 → 0.688 and 0.587 → 0.615). The per-park residual repeats
   *within* a window (series-blocked split-half covariance 0.064, ≈0.25 runs)
   and does **not** survive to the next season (2025-against-2026 correlation
   **0.03**, covariance 0.012 with a 95% interval of [−0.16, +0.16]). Whatever
   it is, it is not a property of the ballpark, and a table that pretends it is
   would be fitted to last season's ghost.
5. **The 70% damping in the brief is not what the game model applies.**
   `parkFactor`'s default weight is 0.7, and `src/model/batter.js` and
   `src/model/pitcher.js` do use it — but `GAME_INPUTS.parkExp` is **1.5**,
   fitted, so the game model applies 150% of the table's deviation, not 70%.
   Tested again here on the model's own likelihood: 1.0 costs **−4.63** on FIT,
   1.8 gains **+0.47**, 2.1 costs **−0.75**, and every alternative loses on
   VALIDATE. **1.5 stays.**
6. **Posted-line calibration did not move.** Over 4,213 games outside the
   holdout the five posted lines shift by at most **0.1 point** and the whole
   market's ECE goes 0.76 → 0.77 points, while Brier skill rises 7.7% → 8.0%,
   MAE falls 3.561 → 3.550 and the correlation between projection and outcome
   rises **0.177 → 0.194**. On VALIDATE, Brier skill 8.3% → 9.1%. The holdout,
   read once, is unchanged to three decimals.

Every number below is against the **box score**. No price is read anywhere in
this document and nothing is fitted to one. `MARKET_WEIGHT`, `PLAY_RULES` and
the trading hurdle are untouched.

---

## How it was measured

No new replay. `tools/backtest-games-v2.mjs --src` prices the shipped
`src/model/game.js` on the lookahead-free feature table,
`tools/accuracy-extract.mjs` records one row per game and
`tools/accuracy-report.mjs --totals` scores it — exactly the chain
`docs/TOTALS-CHECK.md` used, so the before-numbers here reproduce that document
to the last digit (projected 8.970, actual 8.932, bias −0.039, ECE 0.76).

```
# the feature tables and fitted params are the ones docs/TOTALS-CHECK.md built
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --features .backtest-cache/features_2026.json --features .backtest-cache/features_2025.json \
  --params .backtest-cache/params-core.json --out .backtest-cache/acc_g_before.ndjson

node tools/park-fit.mjs --acc .backtest-cache/acc_g_before.ndjson \
  --features .backtest-cache/features_2025.json \
  --features .backtest-cache/features_2026.json \
  --out .backtest-cache/park-fit.json

node tools/accuracy-report.mjs .backtest-cache/acc_g_before.ndjson --totals
```

`tools/park-fit.mjs` is new and is the whole fit. It reads the accuracy records,
joins the feature table back on for the venue and the first-pitch weather, and
prints sections 1 to 7b below. It fits nothing outside the FIT window.

**Windows.** FIT is 2025 plus 2026 through **08-09** (3,905 games). VALIDATE is
2026-08-10..09-01 (308). The HOLDOUT 2026-09-02..09-22 (273) was looked at
**once**, at the end, after `src/lib/parks.js` and `src/model/game.js` were
already written; nothing in them was chosen on it. Tables headed "outside the
holdout" are FIT plus VALIDATE, 4,213 games, which is the basis
`docs/TOTALS-CHECK.md` quoted 0.44 on.

**Two things in the chain are optimistic and both are inherited, not new.** The
feature table's lineup is the card that took the field and its weather is what
was recorded at first pitch. `docs/TOTALS-CHECK.md` measured that hindsight at
0.03 runs of level. The new term's exposure to it is discussed under
*What this costs the live board* below, and it is real.

---

## 1. Where the park error actually lives

The per-park bias outside the holdout, before anything changed:

| too low (model under-projects) | | too high (model over-projects) | |
|---|---|---|---|
| Coors Field | +0.95 ± 0.86 | Busch Stadium | −0.80 ± 0.66 |
| Nationals Park | +0.71 ± 0.82 | Globe Life Field | −0.74 ± 0.66 |
| Sutter Health Park | +0.57 ± 0.69 | Great American Ball Park | −0.74 ± 0.77 |
| **Wrigley Field** | **+0.56 ± 0.83** | Angel Stadium | −0.72 ± 0.68 |

sd **0.465**, mean −0.052. And the floor under it, three ways:

| | sd |
|---|---|
| observed per-park bias | **0.465** |
| analytic sampling floor, sd(residual)/√n | 0.375 |
| permutation null, games shuffled | 0.369  [0.278, 0.467] |
| permutation null, **whole series** shuffled | 0.377  [0.279, 0.474] |
| implied real park sd | **0.272** |

Games at a park arrive in three-game blocks against one opponent under one
weather system, so the series-block null is the right one; it turns out to
agree with the naive floor to a hundredth. **Note that 0.465 sits inside the
null's own 95% band.** The existence of per-park error is not, on this
statistic alone, established at all — which is the first hint of what sections
4 and 5 confirm.

**The park-level mean is the wrong cut.** It averages a venue's wind states
together, so a park that is three runs low with the wind out and one run high
with it in looks nearly unbiased. Cutting by **park × wind state** instead (67
cells with 20 or more games):

| | sd | floor | implied real |
|---|---|---|---|
| park mean | 0.465 | 0.377 | 0.272 |
| **park × wind state** | **0.754** | 0.646 | **0.390** |

and the five worst cells on the board were:

| cell | n | bias |
|---|---|---|
| **Wrigley Field, wind out** | 49 | **+3.22 ± 1.43** |
| Nationals Park, wind out | 53 | +1.72 ± 1.50 |
| Comerica Park, calm | 29 | −1.33 ± 1.28 |
| Coors Field, wind in | 56 | +1.29 ± 1.40 |
| Great American Ball Park, wind out | 63 | −1.26 ± 1.23 |

One of those is more than twice the size of any other and it is the park the
brief singled out.

---

## 2. Wrigley: park or wind?

**Wind, and it is not close.** Outside the holdout, 140 games:

| | n | mean wind | proj | actual | bias |
|---|---|---|---|---|---|
| wind **out** | 49 | 9.6 mph | 9.39 | 12.61 | **+3.22 ± 1.43** |
| across / calm | 19 | 8.3 mph | 8.71 | 8.37 | −0.34 ± 2.13 |
| wind **in** | 72 | 8.6 mph | 8.44 | 7.43 | **−1.01 ± 0.98** |

Every other outdoor park, the same cut:

| | n | proj | actual | bias |
|---|---|---|---|---|
| wind out | 1,298 | 9.27 | 9.23 | −0.04 ± 0.25 |
| across / calm | 1,166 | 8.95 | 8.90 | −0.05 ± 0.26 |
| wind in | 711 | 8.69 | 8.82 | +0.13 ± 0.33 |

Flat to a tenth of a run in all three. Fitting a slope of the residual on
signed wind speed park by park, Wrigley is **+0.192 runs per mph [±0.085]** and
is the only one of 22 outside its own interval; the other 21 have a spread of
0.054 against a sampling floor of 0.072, which is to say none. Pooled over
every park except Wrigley the residual slope is **−0.014 ± 0.024** — the
league-wide `windCoef` of 0.004 is already right and is left alone.

**It is not temperature wearing a wind costume.** Wrigley's wind days are its
warm days (79°F with the wind out, 67°F with it in), and the model carries a
temperature term. Regressing the residual on both at once:

|  | signed wind (runs/mph) | temperature (runs/°F) |
|---|---|---|
| Wrigley | **+0.180 ± 0.096** | +0.020 ± 0.071 |
| every other park | −0.014 ± 0.024 | −0.001 ± 0.015 |

The wind coefficient survives the control; the temperature coefficient is zero
at Wrigley exactly as it is everywhere else.

**It replicates.** Fitted on 2025 alone the wind-out multiplier is **+36.6%**
and the wind-in **−9.6%**; fitted on 2026 alone, **+33.0%** and **−15.6%**. Of
five functional forms tried — a linear slope in signed mph, separate out and in
slopes, a signed square root, a direction step, and a step plus a level — the
**direction step** scored best both in sample and, more importantly, when
fitted on one season and read on the other (held-out Δ log-likelihood 27.9
against 24.2 for separate slopes and 20.9 for a single linear slope). The
binned residuals say why: the effect is a step in direction, not a ramp in
speed. A 4 mph wind out at Wrigley behaves like a 15 mph one.

---

## 3. How the coefficients were fitted, and how hard they were shrunk

A park hosts about 70 games a season and a game total has a residual sd of 4.5
runs, so a raw per-park mean overfits badly. Everything here is partially
pooled.

**The pool is spike-and-slab, not Gaussian, and that choice is load-bearing.**
An ordinary normal random-effects prior assumes every park's wind response is
drawn from one bell curve. The data are not shaped like that: of the 22 parks
with 20 or more games in at least one wind direction, 21 sit inside their own
sampling error of zero and Wrigley sits **4.4 standard errors** outside it. A Gaussian pool inflates τ on Wrigley's evidence, then spends that
inflated τ giving quiet parks small effects they have not earned *while still*
cutting Wrigley's demonstrated one from +31.8% to +14.8%. Both halves of that
trade are wrong. The fitted prior instead says a park's effect is exactly zero
with probability 1−p and drawn from N(0, τ²) otherwise, with **p = 0.15** and
**slab τ = 0.130 log-runs** estimated from the 22 parks by maximum likelihood.
A park's wind-out and wind-in readings are pooled as **one** claim about that
ballpark, so a venue cannot pass on its loud direction and be shrunk away on
its quiet one.

The result, fitted on FIT:

| park | dir | n | raw | P(the park has a real wind response) | fitted |
|---|---|---|---|---|---|
| **Wrigley Field** | out | 42 | +31.8% | **1.00** | **+24.8%** |
| **Wrigley Field** | in | 69 | −11.1% | **1.00** | **−8.8%** |
| Nationals Park | out | 48 | +17.6% | 0.27 | +3.4% |
| Coors Field | in | 54 | +13.9% | 0.28 | +2.9% |
| Angel Stadium | out | 93 | −9.3% | 0.25 | −2.1% |
| Great American Ball Park | out | 57 | −12.1% | 0.16 | −1.5% |
| *(the other 17 parks)* | | | | ≤ 0.16 | all within ±1.5% |

**The reported shrinkage strength** is therefore not one number but two: a park
that the prior believes in keeps τ²/(τ²+se²) ≈ **80%** of its raw estimate, and
a park it does not believe in keeps **P(real) × 80%**, which at the median
P(real) of 0.07 is about **6%**.

**Then a gate, which is what actually decided the table.** A park reaches
`PARK_WIND` only if, fitted on 2025 alone it improves 2026, *and* fitted on
2026 alone it improves 2025, by a combined Δ log-likelihood above 4:

| park | fitted on 2025 | fitted on 2026 | 25→26 | 26→25 | |
|---|---|---|---|---|---|
| **Wrigley Field** | out +22.5%, in −6.7% | out +12.9%, in −5.5% | **+8.0** | **+8.6** | **KEEP** |
| Angel Stadium | (shrunk away) | out −9.7% | 0.0 | −0.0 | drop |
| Coors Field | (shrunk away) | in +9.1% | 0.0 | +1.5 | drop |
| Nationals Park | (shrunk away) | out +15.4%, in −2.9% | 0.0 | −1.1 | drop |

One park survives. The shipped table is one line long.

---

## 4. The park LEVEL: fitted, measured, and rejected

The same machinery was pointed at the per-park run level, after the wind term.
The Gaussian pool gives **τ = 0.031 log-runs (0.27 runs)** and keeps a mean of
**33%** of each park's raw deviation — Coors +3.8%, Busch −3.3%, Citi +2.3%,
Globe Life −2.4% and so on. It looks like a perfectly reasonable table.

It does not survive the season it was not fitted on.

| test | result |
|---|---|
| fitted on 2025, Δ log-likelihood on 2026 | **+0.0** |
| fitted on 2026, Δ log-likelihood on 2025 | **−1.7** |
| fitted on 2025, per-park bias sd on 2026 | 0.679 → **0.688** (worse) |
| fitted on 2026, per-park bias sd on 2025 | 0.587 → **0.615** (worse) |

And the reason is visible directly in the residual:

| | covariance | ⇒ sd | |
|---|---|---|---|
| per-park bias, **2025 against 2026** | 0.012  [−0.160, +0.161] | 0.11 runs | corr **0.03** |
| per-park bias, series-blocked split-half **within** the window | 0.064  [−0.002, +0.120] | 0.25 runs | |

**The per-park error is repeatable inside a window and gone by the next
season.** Whatever produces it is not the ballpark. It is not a simple
home-team mis-rating either. A team the model over-rates is wrong in the *same*
direction home and away, so that hypothesis predicts a positive correlation
between a team's home bias and its road bias. The correlation is **negative**:
−0.13 in 2025 and −0.35 in 2026. That is the signature of the `ownPark`
neutralisation — get a park factor wrong and the team's own offence index
absorbs the opposite error, which it then carries onto the road — not of team
quality.

A cross-fitted level table does cut the per-park bias sd from 0.452 to **0.364**
— but that split is within one window, so it is measuring the within-window
structure above, not what a shipped table would be worth. Sections 7 and 7b of
`tools/park-fit.mjs` print both numbers side by side so the difference cannot
be quoted by accident.

---

## 5. Is the table wrong, or is the damping wrong?

The classic box-score park factor — a team's home runs-per-game over that same
team's road runs-per-game — computed season by season, needs no model at all:

| | value |
|---|---|
| per-season sampling error of a park factor | 0.080 |
| sd of the observed park factors | 0.122 |
| **corr(2025, 2026)** | **0.368**, cov 0.0055 ⇒ persistent park sd **0.074** (0.66 runs) |
| corr(published table, observed) | **0.696** |
| corr(2025, 2026) of *(observed − table)* | **0.094**, cov 0.00095 |

So the park is real and persistent — **0.66 runs of true park spread** — the
published table has its **shape** right, and **what the table misses does not
persist**. The table is already carrying essentially all of the signal that
carries over from one season to the next. That is why section 4's fitted level
table has nothing left to find.

The **amplitude** is the one place the box scores argue with the model.
Regressing the observed deviation on the table's own deviation gives an
exponent of **2.14 [1.34, 2.94]** — more than the 1.5 the model applies, and
far more than `parkFactor`'s 0.7 default. The forward test agrees weakly:

| predictor of the other season's park factor | 2025→2026 | 2026→2025 |
|---|---|---|
| neutral, no park at all | 0.01686 | 0.01304 |
| the table at 0.7 (`parkFactor` default) | 0.01448 | 0.01001 |
| **the table at 1.5 (what the model applies)** | **0.01305** | **0.00785** |
| the table at 2.1 | 0.01288 | 0.00713 |
| fitted from the other season, kept 40% | 0.01458 | 0.01136 |
| fitted from the other season, kept 100% | 0.01897 | 0.01897 |
| table + 20% of (fitted − table) | 0.01298 | 0.00799 |
| table + 50% of (fitted − table) | 0.01405 | 0.01015 |

Two things fall out of that table and both matter. **The published table beats
any fit these two seasons can produce**, and blending *any* of the fitted
deviation into it makes it monotonically worse. And **0.7 is decisively
refuted** while 2.1 is marginally better than 1.5 on this criterion.

So `parkExp` was re-tested on the model's own likelihood, which is the better
criterion because it controls for the starters and the offences that a raw park
factor cannot:

| parkExp | Δ log-likelihood on FIT | Δ on VALIDATE | per-park bias sd | MAE |
|---|---|---|---|---|
| 1.0 | −4.63 | −0.11 | 0.4819 | 3.5524 |
| **1.5 (shipped)** | **0.00** | **0.00** | 0.4519 | 3.5496 |
| 1.8 | +0.47 | −0.09 | 0.4428 | 3.5484 |
| 2.1 | −0.75 | −0.30 | 0.4409 | 3.5479 |

(all four rows priced with the new wind term in, through
`tools/accuracy-extract.mjs --game-inputs '{"parkExp":2.1}'`, which is new and
overrides `GAME_INPUTS` for a measurement the way `--tuning` already did for
the batter and pitcher models)

FIT is flat between 1.5 and 1.8 and falls away at 2.1; VALIDATE prefers 1.5
over every alternative; and `tools/fit-game-v2.mjs` was already offered 1.8 in
its candidate list and declined it. **`parkExp` stays at 1.5 and nothing in
`GAME_INPUTS` changed.**

**The components — home runs against singles against strikeouts.** The game
model consumes only the table's `runs` column, and it should keep doing so.
Predicting the observed run park factor from the table:

| predictors | R² | coefficients |
|---|---|---|
| runs only | 0.485 | runs 2.14 ± 0.83 |
| hr only | 0.080 | hr 0.60 ± 0.76 |
| runs + hr | 0.504 | runs 2.43 ± 1.01, **hr −0.35 ± 0.69** |
| runs + hr + hits + so | 0.517 | every coefficient inside ±4 |

The home-run column adds nothing the runs column does not already have, and
`hits` and `so` are collinear with `runs` at 0.86 and −0.95, so a four-column
park term is not estimable on 29 parks. Coors and Wrigley *are* different
animals — but on this evidence the difference that matters to a game total is
Wrigley's wind, not a separable home-run channel. The component columns still
earn their place in `src/model/batter.js` and `src/model/pitcher.js`, which
price the components directly; they were not touched.

**Drift, 2025 to 2026.** Two parks of 29 move by more than their own interval,
where 1.5 would be expected at a 5% bar:

| park | 2025 | 2026 | change | z |
|---|---|---|---|---|
| PNC Park | −0.95 (n=77) | +1.97 (n=63) | +2.92 ± 1.65 | **+3.46** |
| Rogers Centre | +0.83 (n=74) | −0.54 (n=65) | −1.37 ± 1.35 | **−1.98** |
| Angel Stadium | −0.09 (n=78) | −1.42 (n=70) | −1.33 ± 1.33 | −1.96 |
| Comerica Park | +0.70 (n=77) | −0.62 (n=66) | −1.32 ± 1.37 | −1.89 |

No dimension change, humidor or roof policy is known behind any of them, none
of the moves is reproduced inside its own season, and the whole distribution is
what section 4 already showed — a per-park bias that is uncorrelated between
the seasons. A park that had genuinely changed would show up as a *persistent*
2026 effect, and 2026's per-park biases predict nothing. **No park was given a
season-specific factor, and PNC's +2.92 is recorded here as the thing to look
at first if a third season repeats it.**

---

## 6. What changed, and what it bought

`src/lib/parks.js` gains `PARK_WIND` and `parkWindFactor(park, sign)`:

```js
export const PARK_WIND = {
  'Wrigley Field': { out: 1.248, in: 0.912 },
};
```

`src/model/game.js` multiplies it into the run environment:

```js
const env = parkFactor(park, 'runs', P.parkExp)
  * weatherFactor(wx)
  * parkWindFactor(park, wx && !wx.indoor ? windSign(wx.windDir) : 0);
```

`parkWindFactor` takes the **sign**, not the weather, so it cannot drift apart
from `windSign` on how MLB's free-text wind string is read. It returns exactly
**1** for a venue with no row, for a wind that is calm or across the field, for
a dome, for a forecast that carries speed but no direction, and for no weather
at all — every one of which is the model's previous behaviour to the last bit.
Two tests in `test/game.test.js` pin that: one walks every missing-input path,
the other checks that Wrigley moves and Target Field does not.

**Wrigley, outside the holdout:**

| | n | proj before | proj after | actual | bias before | bias after |
|---|---|---|---|---|---|---|
| wind out | 49 | 9.39 | 11.64 | 12.61 | **+3.22** | **+0.98** |
| across / calm | 19 | 8.71 | 8.71 | 8.37 | −0.34 | −0.34 |
| wind in | 72 | 8.44 | 7.73 | 7.43 | **−1.01** | **−0.30** |
| all | 140 | 8.81 | 9.23 | 9.37 | **+0.56** | **+0.14** |

Both remaining cells are inside their intervals. The residual **+0.98** on
wind-out is the price of the pool: the raw multiplier would have closed it, the
shrunk one closes 70% of it, and that is the deliberate trade against
overfitting 42 games.

**Every other park is byte-identical.** Out −0.04, across −0.05, in +0.13,
before and after.

**The whole board, 4,213 games outside the holdout:**

| | before | after |
|---|---|---|
| projected / actual | 8.970 / 8.932 | 8.984 / 8.932 |
| bias | −0.039 | −0.053 |
| MAE | 3.561 | **3.550** |
| corr(projection, outcome) | 0.177 | **0.194** |
| sd(projection) | 0.842 | **0.901** |
| Brier skill on the total | 7.7% | **8.0%** |
| ECE across the market | 0.76 pts | 0.77 pts |
| **per-park bias sd** | **0.465** | **0.452** |
| **park × wind-state bias sd** | **0.754** | **0.643** (floor 0.646) |

**Calibration at every posted line** — the test the change was not allowed to
fail:

| line | n | before: model → actual | after: model → actual |
|---|---|---|---|
| over 6.5 | 4,213 | 67.8 → 67.6 | 67.8 → 67.6 |
| over 7.5 | 4,213 | 56.9 → 56.1 | 57.0 → 56.1 |
| over 8.5 | 4,213 | 49.3 → 48.7 | 49.4 → 48.7 |
| over 9.5 | 4,213 | 39.5 → 39.4 | 39.6 → 39.4 |
| over 10.5 | 4,213 | 33.1 → 32.9 | 33.2 → 32.9 |

The largest move is a tenth of a point. Nothing was traded away.

**VALIDATE** (2026-08-10..09-01, 308 games, never used in the fit): Brier skill
**8.3% → 9.1%**, MAE 3.619 → 3.581, correlation 0.182 → 0.235, rmse of the
point projection 4.490 → 4.444. The window's own level bias moves from −0.278
to −0.323 — the window ran under the model before the change and still does —
and no calibration bin is outside its interval either way. The eleven Wrigley
games in it go from **+2.94 to +1.62**.

**HOLDOUT** (2026-09-02..09-22, 273 games, read once, after the code was
written): bias −0.025 → −0.028, MAE 3.233 → 3.235, every posted line identical
to a tenth of a point, and the one line that sat outside its interval before
(over 6.5, 68.6 → 74.4) still does. Nine games were at Wrigley and only seven
of them had a signed wind, so the holdout has essentially nothing to say about
this term and does not pretend to.

**`npm test` is 255 of 255**, up from 253 by the two new tests. The
league-aggregate calibration tests in `test/game.test.js` and
`test/gameFit.test.js` — home win rate, −1.5 cover, over 8.5, NRFI — were not
touched, not loosened, and still pass, which they should: of 4,486 replayed
games the new term changes the projection of **128**, or 2.9% of the schedule,
and every one of them is at Wrigley.

---

## What this costs the live board

`PARK_WIND` only fires when the slate carries a wind **direction**, and
`src/data/loadSlate.js` says plainly where that comes from: MLB publishes it in
the schedule's `weather` hydrate about an hour before first pitch, and the
Open-Meteo forecast that covers every other game has speed but no direction.
**A Wrigley board loaded in the morning gets exactly the projection it got
before this change.** That is not a defect of the term — an unsigned speed is
still worth nothing — but it does mean the measured gain above is only
available late, and a board reloaded near first pitch will move its Wrigley
total by up to two runs when the reading lands. Anyone watching that number
should know why it jumped.

The study's own inputs are first-pitch readings throughout, so the numbers here
are the ceiling, not the median. `docs/TOTALS-CHECK.md` measured hindsight at
0.03 runs of level for the model as a whole; for this term specifically the
honest statement is that it is worth what is quoted **on the games where the
reading exists at decision time, and nothing on the rest.**

---

## Caveats

- **One park, 111 signed-wind games.** The shipped table rests on 42 wind-out
  and 69 wind-in games at one venue. It replicates across both seasons and the
  raw box scores show it without a model, but the size of the coefficient —
  +24.8% — is far less certain than its sign. The pooling is deliberately
  conservative and the residual wind-out bias of +0.98 runs is the visible
  evidence that it is still under-correcting.
- **Wrigley is the only park with enough wind-out games *and* a big enough
  effect to clear the gate.** Nationals Park at +17.6% raw and Great American
  at −12.1% may well be real; they are not in the table because fitted on one
  season they did not help the other. If a third season makes either of them
  survive the gate, `tools/park-fit.mjs` will say so without being changed.
- **"The level table does not persist" is a two-season statement.** The
  cross-season covariance interval is [−0.16, +0.16], which admits a persistent
  park sd up to 0.41 runs as well as zero. What is established is that *these
  two seasons cannot find it* and that a table fitted on them makes the other
  season worse. A longer history might change that; a longer history is the
  right way to try.
- **The `ownPark` neutralisation was not given a wind term.** A team's season
  line carries its home park's *average* wind mix, and the Cubs' does too, so
  strictly `ownPark` should divide by that average rather than by the park
  factor alone. The effect is second order and, more importantly, the
  coefficients above were fitted against the model with `ownPark` exactly as it
  is, so they are correct for the configuration that ships. Changing one
  without refitting the other would not be.
- **The residual still has 0.25 runs of within-window per-park structure and
  this study did not explain it.** It is not the ballpark (it does not persist),
  not the home team's quality (home and road biases point opposite ways), and
  not the published table being mis-scaled (the residual is uncorrelated with
  every column of it, R² 0.04). Two candidates were not tested: the home team's
  *pitching staff*, which throws about half its innings at one venue and turns
  over between seasons, and season-specific groundskeeping and roof or humidor
  policy that no public feed reports. Both are the next lead.
- **The holdout has now been looked at four times** — the study, the port, the
  totals check and this. It contributed nothing to any choice here, and on this
  change it carries almost no information either way.
