# Porting the rebuilt pitcher model, and the two answers it gives

`docs/PITCHER-EDGE-SEARCH.md` rebuilt the starting-pitcher model properly — two
seasons under a fitted recency decay, fitted partial pooling, the opponent read
from the nine posted batters, a depth-first joint distribution — measured it
once on an untouched holdout, and reported a **FAIL** against the price. That
verdict is unchanged and nothing here reopens it. What the study also found was
a real improvement over the model the board ships: paired on identical
contracts it took strikeouts from **+0.0075 [+0.0031, +0.0120]** worse than the
Kalshi mid to **+0.0029 [−0.0012, +0.0070]** — level with it. This is the port
of that work, and the measurement of it.

**Two questions are answered here and they have opposite answers.**

1. **Does the port beat the shipped model against the PRICE?** No.
   Pooled, on the holdout, against current master: **−0.0001 [−0.0015,
   +0.0014]**. Level. The study's headline gain had three owners and the port
   is the smallest of them — see "Where the study's number went".
2. **Does it beat the shipped model against OUTCOMES?** Yes, and clearly, in
   the one market `docs/ACCURACY.md` said still needed it. Outs recorded goes
   from **1.95 points of calibration error to 0.80**, its mean absolute error
   from 2.798 to 2.755 and its correlation from 0.522 to 0.530, over 9,021
   starts in two seasons. Strikeouts go from 0.81 to **0.55**.

The board's goal is now accuracy, not closeness to a price, so (2) is the
question that decides this branch. But (1) is reported first and in full,
because it is the one that was asked for and because a port measured only
against the metric it happens to win is not measured at all.

## What is in the port, and what each piece was worth

Five things were carried across. Three were measured, fitted, and **not**
shipped; they are listed below with their numbers, because a term that measures
at zero is a finding and deleting it silently loses it.

| | what v37 did | what the port does |
|---|---|---|
| **workload depth** | a flat mean of the last 3 starts | every logged start, weighted `exp(-age / 20 days)` on the study's fitted decay over a compressed calendar |
| **the outs distribution's width** | `budgetSpread` 18 pitches | **12**, refit on the outs ladder's calibration |
| **the outs level and spread** | `outsLevel` 0.98 and a 0.89 shrink anchored at 15.5 | refit against outcomes on the fit window, plus a fitted **season drift** of −0.026 per 100 days |
| **strikeouts, given depth** | binomial in batters faced, smeared ±5 by an invented constant | binomial in the batters the **outs PMF itself** implies — depth is drawn once and strikeouts ride it |
| **the opponent** | 40% of the lineup's deviation in strikeout rate passed through | the fitted exponent, **0.555**, with the two cross-terms the shipped model set to zero |

Each is independently switchable, and each is measured here on the study's fit
window by the calibration error of the market it governs — the fit tail, which
the coefficients never saw, is inside it:

| configuration | K cal. err | K corr | outs cal. err | outs corr |
|---|---|---|---|---|
| **the port** | **0.50** | **0.447** | **0.78** | **0.527** |
| minus the depth-driven strikeouts | 0.87 | 0.447 | 0.78 | 0.527 |
| minus the recency-weighted workload | 0.52 | 0.443 | 1.13 | 0.520 |
| minus the narrower budget spread | 0.46 | 0.447 | 1.71 | 0.527 |
| minus the refitted outs calibration | 0.49 | 0.447 | 2.26 | 0.526 |
| minus the fitted opponent exponent | 0.47 | 0.446 | 0.78 | 0.527 |
| **frozen v37 (current master)** | 0.90 | 0.442 | 1.97 | 0.519 |

Read plainly: **the outs market is fixed by three terms that all had to land
together** — a level, a width and a workload — and **the strikeout calibration
is fixed by one**, the depth-driven distribution. The opponent exponent is
worth a rounding error against outcomes; it is kept because it is worth a small
but consistent amount against the price (below) and because it replaces an
unmeasured constant with a measured one, not because it is large.

### Three things measured and NOT shipped

- **The two-season fitted recency decay and the fitted partial pooling** — the
  study's headline rate change, a 400-day decay with a fitted offseason gap and
  pooling at 150 / 80 / 1,200 batters faced instead of a flat 70. Ported into
  this pipeline it is worth **nothing**: on 990 fit-tail starts, 0.1548 /
  0.1661 / 0.1848 / 0.1568 / 0.1820 of Brier with it against 0.1549 / 0.1662 /
  0.1845 / 0.1568 / 0.1821 without. Asked for the best strikeout pooling
  strength in this structure, the fit window answers **70** — `shrunkRate`'s own
  default. v36's two assumed constants turn out to be about where the data
  wants them for a projection built this way.

  This is the only term that would have cost `loadSlate` a fetch (the pitcher's
  prior-season game log). The code, the fitted constants and a test are kept
  and the switch is off, so the next person to propose that fetch can read what
  it buys. `PITCHER_TUNING.rateDecay`.
- **A refitted calibration for hits, walks and earned runs.** The regression
  slope that minimises squared error is not the slope that calibrates a ladder:
  fitted freely, hits came back at 0.752 against v36's 0.89, which flattens the
  projection and leaves every rung reading low. Fit-window calibration error,
  v37 against the refit: hits 0.38 → 0.93, walks 0.94 → 1.29, earned runs 1.13
  → 1.17. Those three keep v36's curve. Only depth wanted a new one.
- **A season drift for hits and walks.** Both are real and replicate — hits fall
  4.95 → 4.62 and 4.75 → 4.66 from April to September in the two seasons, walks
  1.87 → 1.60 and 1.93 → 1.70 — but those markets keep v36's curve, and half a
  correction is worse than none. Walks got measurably worse with it (0.94 →
  1.29), because 2026's walk rate jumped in August against the trend. Only outs
  ships a drift.

### And two the study told us to leave out

- **The home-plate umpire.** 0.00001 of log loss in the study's ablation, with
  the wrong sign on its coefficient. Not ported, and it would have cost a fetch.
- **Temperature.** The study measured it as worth **less than nothing** for
  pitchers — removing it improved the fit-tail score. There was nothing to
  delete: **`projectPitcher` has never had a temperature term**, and grep
  confirms it — the pitcher model reads `park`, not `wx`, and `loadSlate` has
  never passed it weather. Temperature lives in `projectBatter`'s
  `weatherHrFactor` and in the game model, where `docs/GAME-PORT.md` measured
  it as worth keeping at 4% per 10°F. It stays in both and does not appear
  here. **Nothing was removed and nothing was added; the correct action was
  none.**

`MARKET_WEIGHT`, `PLAY_RULES` and the trading hurdle are **untouched**
(`git diff master -- src/model/edges.js src/trade/` is empty).
`MARKET_WEIGHT.pitcher_earned_runs` in particular is exactly where it was: the
port beats the earned-run mid by 0.0212 on the holdout, and that is still the
midpoint of a book whose median quoted spread is **38 cents**.

## Leg 1: the reproduction check, against the price

Holdout **2026-09-02 .. 2026-09-22**, the study's own window, its own replay,
its own real Kalshi decision-time quotes at T−120, its own cluster bootstrap
over pitcher-start with 20,000 resamples. 10,176 settled pitcher-prop markets,
10,005 matched to a replayed start, **7,004 with a two-sided decision quote and
a binary settlement**. Reproduce with:

```
node tools/pitcher-edge.mjs  --stage fit --cache .work/cache --out .work/model.json
node tools/pitcher-port-fit.mjs --cache .work/cache --out .work/portfit.json
node tools/pitcher-port.mjs  --cache .work/cache --kcache .work/kcache --json .work/port.json
```

The study itself was re-run first, unchanged, on caches rebuilt from scratch on
this machine. It reproduces **digit for digit** — the fitted hyperparameters
(400 / 20 / 60, 150 / 80 / 1,200 / 200), the fit-tail table (M2 0.1537 /
0.1641 / 0.1820 / 0.1562 / 0.1806 against shipped 0.1581 / 0.1680 / 0.1842 /
0.1574 / 0.1817) and the whole holdout table including the −0.0023 [−0.0055,
+0.0009] pooled and the −8.4% [−17.2, +0.6] ROI. The caches are sound and the
study's numbers are real.

### The control

Two frozen copies, because master moved under this branch mid-flight:

- **`tools/pitcher-model-v37.mjs`** — `src/model/pitcher.js` at master 980d4b4,
  after `kLevel` and `hLevel` were set to 1.0. **This is the control.**
- **`tools/pitcher-model-v1.mjs`** — the same file at v36.1, before that
  change. Kept to show how much of the study's ground v37's two-constant fix
  already took. The two differ in exactly those two values.

Frozen for the reason the game port learned the hard way: the study's control
was `src/model/pitcher.js` itself, so the moment this port lands, comparing
against that import is the new model measuring itself.

Both are fed what `loadSlate` feeds — the nine posted batters through
`lineupOpponent`, with the opponent's team aggregate behind it. That matters
more than anything else here and is the subject of the next section.

### Paired Brier, ported − frozen v37. Negative means the port forecasts better.

| market | n | ported | frozen v37 | **ported − v37** |
|---|---|---|---|---|
| **pooled** | 7,004 | 0.1933 | 0.1934 | **−0.0001 [−0.0015, +0.0014]** |
| strikeouts | 3,558 | 0.1693 | 0.1703 | −0.0010 [−0.0034, +0.0013] |
| outs recorded | 499 | 0.2556 | 0.2502 | **+0.0055 [−0.0026, +0.0135]** |
| hits allowed | 807 | 0.2169 | 0.2142 | +0.0027 [−0.0013, +0.0068] |
| earned runs | 1,334 | 0.2135 | 0.2140 | −0.0006 [−0.0022, +0.0010] |
| walks | 806 | 0.2038 | 0.2052 | −0.0014 [−0.0030, +0.0003] |

**The port does not reproduce the study's improvement against the price.** The
study measured −0.0022 pooled and −0.0046 on strikeouts against its baseline;
this is −0.0001 and −0.0010 against the model that actually ships, and not one
interval clears zero. Two markets are worse: outs by +0.0055 and hits by
+0.0027, both on small samples and both with intervals spanning zero.

Against the older v36.1 control the same table reads **−0.0004 pooled** and
**−0.0015 on strikeouts**, which is the honest measure of what this branch plus
v37 achieved together.

### Where the study's number went

The study's −0.0046 on strikeouts was measured against a baseline fed the
opponent's **team season rates**. That is not what the board has had since v33:
`src/model/lineupEnv.js` already reads the nine posted batters, and
`loadSlate.js` already calls it. On the same 7,004 contracts, paired:

| step | pooled | strikeouts |
|---|---|---|
| reading the posted nine instead of team rates (**shipped in v33**) | −0.0008 [−0.0013, −0.0003] | −0.0013 [−0.0022, −0.0004] |
| v37's two retired trims (**shipped last week**) | −0.0003 [−0.0012, +0.0007] | −0.0005 [−0.0024, +0.0014] |
| **this port** | −0.0001 [−0.0015, +0.0014] | −0.0010 [−0.0034, +0.0013] |
| the study's candidate, same baseline | −0.0022 | −0.0046 |

Measured against the study's own baseline, the port lands at **0.1693 against
0.1721 on strikeouts, −0.0028 of the study's −0.0046**. The largest single term
in the study's ablation — "the opponent has to be the posted lineup" — was
already in the product before this branch opened, and the second was shipped by
someone else while it was open. What is left for the port is the remainder, and
the remainder is not significant against a price.

### Per-term, against the price

| term switched off | pooled | strikeouts | outs |
|---|---|---|---|
| depth-driven strikeouts | −0.0002 [−0.0003, −0.0000] | −0.0003 [−0.0006, −0.0001] | 0 |
| fitted opponent exponent | −0.0003 [−0.0006, −0.0000] | −0.0006 [−0.0012, −0.0000] | 0 |
| recency-weighted workload | +0.0003 [−0.0010, +0.0017] | +0.0001 | **+0.0035** |
| narrower budget spread | +0.0002 [+0.0001, +0.0004] | +0.0001 | **+0.0020 [+0.0007, +0.0034]** |
| refitted outs calibration | +0.0002 [−0.0001, +0.0005] | +0.0003 | −0.0000 |

The two terms that fix the outs market against OUTCOMES are the two that cost
it against the PRICE. That is not a contradiction and it is worth being precise
about: `budgetSpread` 18 → 12 narrows a distribution that was measurably too
wide at both ends, which moves every quoted outs probability toward the middle
of the ladder — and on 499 holdout contracts the market's own number was better
there. The calibration curve it was fixing is measured on 9,021 starts and
90,190 probability-outcome pairs; the price comparison is 499 contracts on 144
starts. They are not the same weight of evidence, and the configuration was
chosen on the fit window before either holdout number was looked at.

## Leg 2: what the board will actually get

The study's replay reads the card that **took the field**. A board loaded at
T−120 usually has a projected card — `src/data/projectedLineup.js` builds one
from recent batting orders. The whole holdout was re-run with the opponent read
from the team's **most recent previously-posted card**, never tonight's; one
existed and was usable for **546 of 546** starts.

| inputs | pooled | strikeouts | outs | hits | ER | walks |
|---|---|---|---|---|---|---|
| tonight's posted card (the study's inputs) | −0.0001 [−0.0015, +0.0014] | −0.0010 | +0.0055 | +0.0027 | −0.0006 | −0.0014 |
| **decision-time: the previous card** | **+0.0001 [−0.0013, +0.0015]** | −0.0007 [−0.0030, +0.0016] | +0.0055 | +0.0027 | −0.0006 | −0.0014 |

**It does not collapse, because there was nothing large enough to collapse.**
Hindsight about tonight's card is worth **+0.0006 [−0.0001, +0.0013]** of
pooled Brier to the ported model and +0.0011 on strikeouts — a real cost,
about the size of the port's entire strikeout gain, and consistent with
`docs/ACCURACY.md`'s finding that only 75.9% of last night's nine start again
tonight. The decision-time row is the one to quote: **+0.0001 [−0.0013,
+0.0015] pooled, −0.0007 [−0.0030, +0.0016] on strikeouts.** Level, either way.

## The measurement that decides this branch: against outcomes

Same harness as `docs/ACCURACY.md` — `tools/accuracy-extract.mjs` driving the
lookahead-free replay in `tools/backtest-pitchers.mjs` — so these are directly
comparable to its numbers. The frozen v37 control reproduces its table exactly.
Main window **9,021 starts**, 2025 and 2026 through 2026-09-01.

```
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --out .work/a_25.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --out .work/a_26.ndjson
node tools/accuracy-report.mjs .work/a_25.ndjson .work/a_26.ndjson --slices
```

(`--v1` replays the frozen v36.1 model; `--v1 --tuning '{"kLevel":1,"hLevel":1}'`
is frozen v37 exactly, verified against `tools/pitcher-model-v37.mjs`.)

| market | v36.1 | frozen v37 | **ported** |
|---|---|---|---|
| **strikeouts** calibration error | 2.66 | 0.81 | **0.55** |
| overall gap | −2.6 [−3.2, −2.1] | +0.4 | **+0.3 [−0.2, +0.9]** |
| point bias | +4.3% | −0.9% | **−0.5%** |
| correlation | 0.444 | 0.444 | **0.449** |
| mean abs. error | 1.756 | 1.760 | **1.755** |
| **outs recorded** calibration error | 1.95 | 1.95 | **0.80** |
| overall gap | −1.8 [−2.4, −1.2] | −1.8 | **−0.3 [−0.9, +0.2]** |
| correlation | 0.522 | 0.522 | **0.530** |
| mean abs. error | 2.798 | 2.798 | **2.755** |
| **hits allowed** calibration error | 2.04 | **0.34** | 0.40 |
| **walks** calibration error | 1.05 | 1.05 | 1.07 |
| correlation | 0.249 | 0.249 | **0.254** |
| **earned runs** calibration error | 1.14 | 1.14 | 1.14 |
| correlation | 0.189 | 0.189 | **0.194** |

The outs ladder, quoted → observed, is the clearest single picture of it:

| | 11.5 | 12.5 | 13.5 | 14.5 | 15.5 | 16.5 | 17.5 | 18.5 | 19.5 | 20.5 |
|---|---|---|---|---|---|---|---|---|---|---|
| **v37** | 83.7→86.6 | 74.3→79.2 | 69.4→75.1 | 64.1→70.2 | 47.6→50.3 | 42.4→44.1 | 36.7→37.8 | 18.0→16.0 | 16.0→13.5 | 13.8→11.2 |
| **ported** | 86.8→86.6 | 78.0→79.2 | 73.4→75.1 | 68.4→70.2 | 50.0→50.3 | 44.1→44.1 | 37.7→37.8 | 16.3→16.0 | 14.1→13.5 | 11.7→11.2 |

Every one of v37's ten buckets sits outside its interval. None of the port's
outer four do. This is the item `docs/ACCURACY.md` handed over explicitly —
"removing `outsLevel` re-centres the level but leaves a genuine SHAPE error…
a narrower budget distribution, not another level factor, is what that needs" —
and it is what the port does: `budgetSpread` 18 → 12 for the shape, a refitted
anchor and level for the centre, and the recency-weighted workload underneath
both. `outsLevel` itself is untouched at 0.98 and is now inert, superseded by
`PITCHER_FIT.cal.outs`.

### What is still wrong

**The short outing is still the worst cell in the model, and the port only
dents it.** On starts the model expects to run under 4.5 innings:

| | n | strikeouts | outs | hits |
|---|---|---|---|---|
| frozen v37 | 1,159 | ECE 2.75, gap −2.7, MAE 1.528 | **ECE 6.80, gap −6.8**, MAE 3.157 | ECE 1.79 |
| **ported** | 1,017 | ECE 2.46, gap −2.5, MAE **1.485** | **ECE 6.36, gap −6.4**, MAE **3.043** | ECE 1.80 |

Outs overs on an opener still read six points low. The fitted workload decay
and the narrower budget both help the point number — mean absolute error falls
3.6% — and neither touches the calibration, because the error is not width or
level, it is that **the model does not know a bullpen game is a bullpen game**.
The study's own answer, an empirical outs PMF conditioned on predicted depth,
is not in this port; it replaces the hook-hazard model wholesale and that model
is the single most heavily tested thing in this file. That is the next piece of
work on this market, and it should be measured on that 1,000-start slice.

**Earned runs is still useless as a ranking** — correlation 0.189 → 0.194, on a
market whose own projection spread is 0.39 against an actual spread of 1.99.
Nothing in this port addresses that and nothing in the study did either; its own
earned-run model routes around realised depth because depth is a collider there.
A 3% improvement on the naive "give every start the slate average" is what this
market is, and the trust table's verdict — calibrated, unusable for ordering —
stands.

**Walks are a hair worse** (1.05 → 1.07 of calibration error), which is the
recency-weighted workload moving projected batters faced under a market that
was already well calibrated.

### The holdout window disagrees, and cannot settle anything

The last three weeks alone, 383 starts:

| | strikeouts | outs | hits | walks | ER |
|---|---|---|---|---|---|
| frozen v37 | 2.28 [2.08, 4.88] | 2.42 [1.83, 4.99] | 2.69 [1.89, 5.16] | 2.19 | 2.72 |
| ported | 2.05 [1.76, 4.68] | 2.80 [2.16, 4.80] | 2.38 [1.90, 4.77] | 2.60 | 2.94 |

Every interval is two to five points wide and every pair overlaps almost
completely. September 2026 ran low — 4.59 strikeouts and 14.72 outs a start
against two-season means of 4.76 and 15.43 — so a model trimmed downward looks
good on it and a model centred on two seasons looks high. This is the same trap
the trim removal reported hitting from the other side, and the same answer
applies: **a two-point effect is not resolvable on 383 starts.** The
configuration was chosen on the fit window and is not revised here.

## What falls back, and what happens when a lineup is missing

Every ported term is optional and every one degrades to exactly what v37 did.
`test/pitcher.test.js` pins each row of this table.

| missing | what the model does |
|---|---|
| the **posted lineup** | `lineupOpponent` returns the opponent's **team season aggregate** and flags `source: 'team'` — unchanged since v33, and the app substitutes a projected card first. The port adds nothing here and changes nothing: it reads whatever `input.opp` holds |
| the **opponent entirely** (`opp` null, or fewer than 6 hitters with 30+ PA) | every opponent ratio is 1 and the factor collapses to exactly 1 — the fitted exponent and v36's damping agree to the last bit, and the test asserts byte equality |
| **`input.date`** | no recency weighting (the flat mean of the last three starts, as v37) and **no season drift** (the factor is 1). The model never guesses a date |
| **dates on the game-log entries** | same: the flat last-three mean. A log entry without a date cannot be aged |
| **`input.rateLog`** | the v37 `shrunkRate` blend, untouched — and this is the shipped path, because the decayed alternative measured at zero |
| **the game log** entirely | the season pitches-per-start, then the relief budget, then 82 pitches — the v37 ladder, untouched |
| **`PITCHER_FIT.cal`** (a caller passing `fit: { cal: null }`) | v36's anchors and slopes with v37's level constants. `outsLevel` becomes live again |

`src/data/loadSlate.js` gains exactly one line — `date` — and **no new request**.
The date was already the argument the whole load was made for.

## Calibration tests: nothing moved that should not have

`npm test` passes **242 of 242** (227 before, 15 added here). No test was
loosened, skipped or edited except one, `PITCHER_FIT.cal supersedes kLevel`,
which was rewritten when the calibration was cut back to depth only — it now
pins `outsLevel` instead, and additionally asserts that `kLevel` is live and is
v37's 1.0.

The pitcher calibration tests in `test/game.test.js` — the ERA/FIP shrink, the
opener budget, the home/away terms, the reliever fix — all pass untouched. They
check structure and direction rather than exact projections, which is why they
survive a level change; the projections themselves are checked against 9,021
real starts above, which is the stronger test and the one that moved.

Added in `test/pitcher.test.js`: the decay accumulator's six null cases and its
offseason compression (the study's own worked example — a 2025-07-01 start seen
from 2026-08-01 weighs 0.50, against 0.37 uncompressed and the flat blend's
0.6); the three workload fallbacks; the opponent no-op; the drift no-op; that
`dist.k` still integrates to `projK` on both paths; and that the thinnest call
the board can make — a season line and nothing else — still returns five finite
projections and five probabilities in [0, 1].

## Caveats

- **The holdout has now been looked at three times**: once by the study, once
  by this port, once again after master shipped the trim removal and the
  control had to change. Nothing was chosen on it. Every configuration decision
  in this branch was made on the study's fit window (2025 entire plus 2026
  through 2026-08-09) by the calibration error of the market it governs, and
  the per-term tables above are printed from the same run that chose them.
- **The price replay's fills are idealised** exactly as the study's were, and
  its verdict is unchanged: the model does not beat the price, the bar failed
  on both legs, and nothing here is a reason to trade.
- **The decision-time lineup is a stand-in, not a replay of the live
  projector.** It is the opponent's most recent previously-posted card with
  every batter's line as of the game date — the same idea as
  `src/data/projectedLineup.js`, not the same code, and if anything slightly
  pessimistic.
- **The outs regression against the price is real and is reported as measured.**
  +0.0055 on 499 contracts with an interval spanning zero, attributable to the
  two terms that fix the same market's calibration against outcomes. If the
  board's goal ever moves back to tracking a price, `budgetSpread` is the
  constant to revisit first.
- **`src/ui/MethodologyView.jsx` is now conservative** where it describes outs
  calibration and the short outing: the numbers it quotes are v37's, and the
  port moves both in the model's favour. It was deliberately not edited here —
  the copy is shared with other branches and understating accuracy is the safe
  direction to be stale in.
- **The study's own verdict is untouched.** `MARKET_WEIGHT`, `PLAY_RULES` and
  the hurdle are exactly as they were, `MARKET_WEIGHT.pitcher_earned_runs`
  included, and the 38-cent spread behind that market's apparent edge is still
  38 cents.
