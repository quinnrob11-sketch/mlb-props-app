# Can the game model beat the price? A pre-registered search

`docs/KALSHI-GAME-BACKTEST.md` measured the game model against real Kalshi
prices and found it close but never in front: a median 3.1 points from the
moneyline mid, 3.2 from the total, a pooled Brier 0.0021 worse than the price,
and zero contracts able to clear the bot's own hurdle. Matching league averages
turned out to be the easy part.

This study asks the next question. **Is the gap closable by better per-game
inputs?** Starting-pitcher quality with honest uncertainty, bullpen availability
from who actually pitched in the last three days, lineup-specific offence, rest
and travel, a first inning driven by the hitters who actually bat in it — all
things the current model either shrinks to league average or ignores.

Everything in the Pre-registration section below was **written and committed
before any validation or holdout number was computed**. The commit that
contains this section and nothing else is the timestamp.

## Pre-registration

### The split

| | dates | what it is for |
|---|---|---|
| **FIT** | 2025 full regular season + 2026-03-26 .. **2026-08-09** | every parameter of the improved model is estimated here and nowhere else |
| **VALIDATE** | **2026-08-10 .. 2026-09-01** | one configuration is chosen here; may be looked at as often as needed |
| **HOLDOUT** | **2026-09-02 .. 2026-09-22** | touched **once**, at the end, for the single configuration already chosen |

Kalshi's live tier only holds settled game markets back to 2026-07-14, so the
FIT window is scored against **outcomes**, not prices. Validate and holdout both
sit inside the price history.

The current shipped constants (`HOME_ADJUST`, `WALKOFF_EXACT`, `SIGMA_SHARED`,
`SIGMA_TEAM_TOTAL`, `EXPLAINED_TEAM_SD`) were fitted on the whole 2026 season,
which includes validate and holdout. **They are refitted on FIT only** for this
study, so the comparison is clean on both sides.

### What is fitted where

- **FIT**: the coefficient on every team-strength, pitching, bullpen, lineup,
  rest and park term; every regression-to-the-mean constant; the four league
  constants; `EXPLAINED_TEAM_SD`. The objective is the likelihood of the runs
  actually scored per team-game, plus the league-aggregate fit that
  `tools/fit-game-model.mjs` already minimises. No price appears in it.
- **VALIDATE**: exactly one model configuration — which terms are in, and which
  trading screen. The trading screen is chosen from
  `{model weight 0.6, 0.8, 1.0} x {8-point implausibility cap kept, released}`;
  one and only one is carried forward.
- **HOLDOUT**: nothing is fitted or chosen. One run, one number per market.

### The bar (fixed before any P&L was computed)

The improved game model beats the price on a market only if **both** hold on the
**holdout**:

1. **Forecast.** The model's Brier score is **lower** than the Kalshi decision
   mid's on the same rows, and the 95% interval on the paired difference —
   cluster-bootstrapped over **games**, 5,000 resamples, fixed seed — **excludes
   zero**.
2. **Money.** ROI after the bot's own 0.07 fee is **positive** and its 95%
   cluster-bootstrap interval, same clusters, **excludes zero**.

Reported per market (`KXMLBGAME`, `KXMLBSPREAD`, `KXMLBTOTAL`, `KXMLBRFI`) and
pooled, each with `n` and its interval.

**Anything less is a FAIL and is reported as one.** A positive point estimate
whose interval spans zero is not an edge. Beating the price on the forecast
while losing money is not an edge. One market out of four passing is one market
out of four, not a result about the model.

A clearly reported negative result is the expected outcome of this study and is
a complete answer to the question.

### Rules of engagement

- Public Kalshi and public MLB Stats API only. No metered odds feed. Every
  response cached to disk in this worktree.
- Decision time is **T-120 minutes** before the scheduled first pitch, the same
  as the earlier study, with T-30 reported as a sensitivity only.
- Execution is 1 contract, taker at the ask, fee `0.07 * p * (1 - p)` per
  contract, P&L from Kalshi's `settlement_value_dollars`.
- `npm test` must pass, including the league-aggregate calibration tests, which
  are not to be loosened.

## The data (measured)

Two seasons rebuilt game by game by `tools/game-features.mjs`, entirely from
the public MLB Stats API, with every aggregation taken strictly from games
dated **before** the game in question.

| | |
|---|---|
| Games | **2025**: 2,418 · **2026** (to 09-22): 2,343 · 4,761 total |
| Split, after dropping seven-inning games and each team's first ten | FIT **3,905** · VALIDATE **308** · HOLDOUT **273** |
| Per game | both teams' season and prior-season hitting lines; both teams' starter and reliever split lines; the listed probable's own line, his prior season, his rate components and his days of rest; every reliever's own line plus how much he threw on each of the last three days; the posted batting order and its top four; days of rest, whether the team changed city, the time-zone shift; the home-plate umpire; the recorded first-pitch weather |
| Coverage | both lineups posted 4,505/4,761 (95%) · both probables listed 4,203/4,761 (88%) · wind and umpire 4,761/4,761 (100%) |

Two things in that table are **not** available at the decision time, and are
flagged wherever they are used:

- **The posted lineup.** statsapi reports the card that took the field. Most
  are posted two to three hours out, so most would have been visible at T-120,
  but not all. The same optimism is in the earlier study.
- **The weather.** `hydrate=weather` returns what was *recorded* at first
  pitch — "8 mph, Out To LF" — not the forecast. A two-hour temperature and
  wind forecast is close, but it is not free. This is why a no-weather variant
  is carried all the way to the holdout alongside the main one.

## What was tried

The model's shape is unchanged. `tools/game-model-v2.mjs` keeps every part of
`src/model/game.js` below the inputs — the 31x31 convolution, walk-offs, the
skipped bottom of the ninth, ghost-runner extras, the Gauss-Hermite mixture,
the market readers. Only the expected runs going in are different. Their
coefficients are fitted by Poisson maximum likelihood on the runs each team
actually scored, 7,810 team-games in the FIT window, which never sees a price.

The four structural constants were **refitted on FIT alone** — `HOME_ADJUST`
0.984, `WALKOFF_EXACT` 0.65, `SIGMA_SHARED` 0, `SIGMA_TEAM_TOTAL` 0.27, against
the shipped 0.988 / 0.50 / 0 / 0.24 — and `EXPLAINED_TEAM_SD` was measured from
the new model's own spread of projections (0.131 against the shipped 0.12).

### What each term was worth on the FIT window

The likelihood gain from removing one term and leaving everything else where it
was fitted, in quasi-likelihood nats: the raw Poisson gain divided by 1.4, the
observed variance-to-mean ratio of runs per team-game. About 2 nats is the 5%
line for one parameter.

| term | what it adds | nats | kept? |
|---|---|---|---|
| temperature | the shipped 0.0025/F, refitted to 0.0040/F | 16.2 | yes |
| defence | team BABIP allowed, regressed | 12.6 | **no** |
| starter components | K, BB+HBP and HR per batter faced regressed separately, instead of one ERA/FIP lump shrunk by innings | 11.1 | yes |
| rest and travel | days of rest, change of city, time-zone shift, games in the last ten | 10.2 | **no** |
| wind | speed signed by direction (out +, in -), 0.004 per mph | 7.0 | yes |
| lineup | the posted card, centred across the slate | 3.7 | yes |
| prior-season offence | last year's runs per game, worth 30 games against this year's | 3.1 | yes |
| first inning | the top four alone, and the starter's edge first time through | 2.1 | yes |
| umpire | his own runs per game, regressed | 1.7 | **no** |
| bullpen availability | only the arms that did not throw on both of the last two days, plus a fatigue term in the relief innings already covered | 0.8 | **no** |

Four of those deserve their own sentence.

- **Bullpen availability did not work, and the test had power.** 7,810
  team-games, and the fit put the weight on rested arms at zero and the fatigue
  coefficient at zero. The reason is visible in the data rather than in the
  fit: the median team has **93.7%** of its season relief innings in arms that
  are available tonight, so "the available pen" and "the pen" are nearly the
  same group nearly every night. The idea is intuitive; the effect, at the
  resolution a season-level reliever line can see it, is not there.
- **The top of the order does not drive the first inning.** Fitted against
  first-inning runs alone — 7,062 half-innings, so the game-level likelihood is
  not drowning it — the exponent on the top four's OPS came out at **zero**,
  while the exponent on the starter's quality came out at **1.4**. The first
  inning is more about the arm than an average inning is, and no more about the
  bats. The NRFI number does get wider (standard deviation 3.5 points against
  the shipped model's 2.9 on the same games), but the width comes from the
  pitcher, not the card.
- **Defence and rest/travel gained more on FIT than almost anything else and
  then cost Brier on VALIDATE** — the defence term by 9.2, 3.2 and 5.4 points
  of 1e-4 on the moneyline, over 8.5 and the run line. That is what fitting to
  a likelihood and testing on a different window is for. Both were dropped.
- **Weather is the largest single term and the one with the lookahead.** Hence
  the no-weather variant.

### What the starter fit actually says

The largest per-game term came out roughly as the sabermetrics would predict
and quite differently from the shipped model: strikeouts are taken almost at
face value (10 batters faced of prior, against the shipped 60 innings of
league-average ERA/FIP), home runs are regressed almost to nothing (4,000
batters faced of prior), and walks and the ERA half keep the shipped
treatment. The park term also wants to be *stronger*, not weaker: the exponent
on the park factor fitted to 1.5 against the shipped 0.7 damping.

## Validation (measured)

Four configurations were fitted on FIT and scored against **real Kalshi prices**
on VALIDATE, 2026-08-10 .. 2026-09-01: 252 games, 6,432 markets with a
two-sided quote at T-120. `as-v1` is the shipped model run through the same
replay on the same rows; `v1refit` is the shipped inputs with only the four
constants refitted on FIT, which separates "better inputs" from "constants that
had not already seen the test window".

Brier, model minus market. **Negative means the model beat the price.**

| configuration | pooled | `KXMLBGAME` | `KXMLBSPREAD` | `KXMLBTOTAL` | `KXMLBRFI` |
|---|---|---|---|---|---|
| `as-v1` (shipped) | +0.0019 | +0.0066 | +0.0016 | +0.0016 | -0.0002 |
| `v1refit` | +0.0018 | +0.0065 | +0.0020 | +0.0011 | +0.0004 |
| **`core`** | **+0.0006** | +0.0049 | +0.0013 | **-0.0005** | +0.0008 |
| `coreNoWx` | +0.0007 | +0.0050 | +0.0013 | -0.0002 | +0.0002 |
| `all` | +0.0012 | +0.0061 | +0.0019 | -0.0000 | +0.0009 |

`core` is the best pooled, and is the only configuration whose totals number is
clearly on the right side of zero. The whole improvement over the shipped model
is **0.0013 of Brier, pooled** — real, and about two thirds of the way from the
shipped model to the price.

Counterfactual ROI on the same window for the six screens the pre-registration
allows (`core`, one contract, taker at the ask, 0.07 fee):

| screen | n | ROI [95%] |
|---|---|---|
| w 0.6, cap 0.08 | 133 | **+16.0% [-2.1, 34.2]** |
| w 0.6, cap released | 198 | +5.3% [-14.9, 25.6] |
| w 0.8, cap 0.08 | 325 | +6.9% [-6.9, 20.7] |
| w 0.8, cap released | 370 | +4.6% [-11.0, 20.0] |
| w 1.0, cap 0.08 | 494 | +1.7% [-9.9, 13.1] |
| w 1.0, cap released | 538 | -0.1% [-12.6, 12.8] |

Not one of them excludes zero, which is what a 23-day window buys.

## What is carried to the holdout — fixed here, before it was run

- **Configuration: `core`.** Team offence regressed with the prior season, the
  starter regressed component by component, the posted lineup centred across
  the slate, temperature and wind, the first inning driven by the starter, and
  the four constants plus `EXPLAINED_TEAM_SD` refitted on FIT. Bullpen
  availability, rest and travel, the umpire and the defence term are **out**.
- **Screen: model weight 0.6 with the 8-point implausibility cap kept**, the
  15-90c price bounds, one rung per series ladder, one contract, taker at the
  ask, fee `0.07 * p * (1 - p)`, decision at T-120.
- **Also reported on the same rows, and unable to change the verdict:**
  `as-v1` (the shipped model, as a control) and `coreNoWx` (the declared
  weather sensitivity). The verdict comes from `core`.

The holdout is 2026-09-02 .. 2026-09-22, 273 games. Kalshi's live tier holds
all 21 dates.

## The holdout (measured, one run)

2026-09-02 .. 2026-09-22, the `core` configuration and the w-0.6 screen fixed
in the commit above, decision at T-120.

### Coverage

| | |
|---|---|
| games replayed / Kalshi game events matched | 273 / 273 |
| markets in window / matched to a replayed game | 6,829 / 6,793 |
| two-sided decision quote | 5,649 — `KXMLBGAME` 544/546, `KXMLBTOTAL` 2,991/3,363, `KXMLBSPREAD` 1,632/2,374, `KXMLBRFI` 482/510 |
| unmatched | 36 `KXMLBRFI` markets where one starter was not a listed probable |
| non-binary settlements | 0 |
| decision quote age | median 0-1 min, 90th percentile 0-7 min, 100% under an hour (99.6% for `KXMLBRFI`) |
| hand-written screen vs `planOrders` | 272 games, **0** disagreements |

The replay against what happened, same 273 games: home win 53.05% model against
53.85% actual, home -1.5 35.63% against 35.53%, over 8.5 49.71% against 54.21%,
NRFI 49.10% against 45.49%. The window ran hot — five points more overs and
four points fewer scoreless first innings than the model or the market expected.

### Leg 1 — forecast. Brier, model minus market. Negative is the model winning.

| market | n | model | market | difference [95%] | passes? |
|---|---|---|---|---|---|
| **pooled** | 5,649 | 0.1869 | 0.1871 | **-0.0002 [-0.0025, +0.0019]** | **no** |
| `KXMLBGAME` | 544 | 0.2358 | 0.2344 | +0.0013 [-0.0047, +0.0070] | no |
| `KXMLBSPREAD` | 1,632 | 0.1844 | 0.1825 | +0.0018 [-0.0013, +0.0048] | no |
| `KXMLBTOTAL` | 2,991 | 0.1697 | 0.1709 | -0.0012 [-0.0042, +0.0017] | no |
| `KXMLBRFI` | 482 | 0.2464 | 0.2491 | -0.0027 [-0.0072, +0.0015] | no |

Three of the five point estimates are on the model's side, which has never
happened before in this repo. Not one interval excludes zero.

### Leg 2 — money. w 0.6, 8-point cap, 1 contract, taker at the ask, fee 0.07.

| market | n | games | hit vs priced | P&L/contract | ROI [95%] | passes? |
|---|---|---|---|---|---|---|
| **pooled** | 102 | 86 | 50.0% vs 48.4% | +0.04c | **+0.1% [-18.0, +19.2]** | **no** |
| `KXMLBGAME` | 9 | 9 | 44.4% vs 40.6% | +2.24c | +5.3% [-71.0, +72.4] | no |
| `KXMLBSPREAD` | 31 | 31 | 58.1% vs 55.8% | +0.80c | +1.4% [-28.6, +31.7] | no |
| `KXMLBTOTAL` | 56 | 56 | 48.2% vs 45.9% | +0.86c | +1.8% [-22.8, +26.8] | no |
| `KXMLBRFI` | 6 | 6 | 33.3% vs 46.5% | -14.90c | -30.9% [-100.0, +41.1] | no |

At the 0.035 fee the pooled row is +1.6% [-16.7, +20.9]. Still no.

### Verdict: FAIL, in all four markets and pooled

Neither leg of the pre-registered bar is met anywhere. **The improved game
model does not beat the exchange price on the moneyline, the run line, the
total or the first inning.** The conclusion of `docs/KALSHI-GAME-BACKTEST.md`
stands: these markets are not playable on this model.

## What did change, and it is not nothing

The same holdout, scored **paired on identical markets**, v2 against the
shipped model. Negative means the new inputs forecast better than the old ones.

| market | v2 - v1 [95%] | v1 - market [95%] | v2 - market [95%] |
|---|---|---|---|
| pooled | **-0.0025 [-0.0045, -0.0005]** | +0.0023 [-0.0003, +0.0049] | -0.0002 [-0.0025, +0.0019] |
| `KXMLBGAME` | -0.0010 [-0.0037, +0.0017] | +0.0023 [-0.0042, +0.0085] | +0.0013 [-0.0047, +0.0070] |
| `KXMLBSPREAD` | -0.0002 [-0.0019, +0.0013] | +0.0021 [-0.0015, +0.0055] | +0.0018 [-0.0013, +0.0048] |
| `KXMLBTOTAL` | **-0.0036 [-0.0068, -0.0005]** | +0.0024 [-0.0011, +0.0060] | -0.0012 [-0.0042, +0.0017] |
| `KXMLBRFI` | **-0.0052 [-0.0087, -0.0017]** | +0.0024 [-0.0007, +0.0055] | -0.0027 [-0.0072, +0.0015] |

The improvement is real and its interval excludes zero — pooled, on totals and
on the first inning. It is also almost exactly the size of the gap it had to
close. The shipped model sat 0.0023 behind the price; the new one sits 0.0002
in front of it, which is another way of saying **level**.

Consistent with that, the in-sample Brier-optimal weight on (model - market)
moves from near zero to something real: pooled **0.55**, `KXMLBTOTAL` **0.85**,
`KXMLBRFI` **1.00**, `KXMLBGAME` 0.25, `KXMLBSPREAD` 0. The earlier study found
0.05 pooled and no stable per-series value. Blending the new model in no longer
costs anything and on totals it helps slightly (`blend - market` -0.0003
[-0.0006, 0.0000]).

The first inning is the clearest single change. The shipped model has no
opinion about it — a standard deviation of 2.8 points across a slate, which is
why it never disagreed with `KXMLBRFI` enough to trade. The new one has 3.5
points of spread, and on the holdout it forecast the first inning better than
the price did (-0.0027) and better than the shipped model did by -0.0052
[-0.0087, -0.0017]. It still is not a demonstrated edge: the interval against
the price spans zero, and the six contracts the screen actually bought lost
31%.

## Sensitivities (all declared before the holdout ran, none can change the verdict)

| | pooled | `KXMLBGAME` | `KXMLBSPREAD` | `KXMLBTOTAL` | `KXMLBRFI` |
|---|---|---|---|---|---|
| `core` at T-120 (the result) | -0.0002 | +0.0013 | +0.0018 | -0.0012 | -0.0027 |
| `core` at T-30 | -0.0002 | +0.0010 | +0.0019 | -0.0011 | -0.0033 |
| `coreNoWx` (no temperature, no wind) | +0.0002 | +0.0014 | +0.0019 | -0.0006 | -0.0018 |
| `as-v1` (the shipped model) | +0.0023 | +0.0023 | +0.0021 | +0.0024 | +0.0024 |

- **T-30 changes nothing.** Game-line prices still barely move in the last two
  hours, exactly as the earlier study found.
- **The weather term is worth about 0.0004 of pooled Brier against the price**,
  and it is the term with the lookahead. Take it out entirely and the holdout
  reads +0.0002 instead of -0.0002 — a different sign on a number whose
  interval spans zero either way. Nothing in this verdict rests on it.
- **Every screen is positive on the holdout and none of them significantly so**
  (w 0.8 with the cap: +3.7% [-9.7, +17.3] on 265; w 1.0 with the cap: +2.0%
  [-10.4, +14.4] on 402; w 1.0 uncapped: +3.3% [-10.7, +17.0] on 443). The
  locked screen was the worst of the four. That is what choosing a screen on
  23 days of validation buys you, and it is the reason the screen was fixed in
  advance rather than after.
- **Closing-line value is mildly positive** on the locked screen: +0.21c
  against the decision mid, -0.30c against the price paid, with the close
  moving toward the trade on 33% of contracts and against it on 18%. Positive,
  tiny, and smaller than the spread.

## The bot still cannot place any of these bets

`planOrders` screened **zero** contracts on all 273 holdout games, as it did on
all 837 games of the earlier study. `MARKET_WEIGHT.game_*` is now 0.1
(`src/lib/constants.js`), which makes the arithmetic in
`docs/KALSHI-GAME-BACKTEST.md` finding 1 even more decisive: the maximum
achievable edge is `0.1 * 0.08 - 0.005 = 0.003` against a minimum hurdle of
0.0263. Everything above is a counterfactual at weights the bot does not use.

## What this does and does not license

- **It does not license trading game lines.** Nothing passed. The board's
  `gameLinesInformationOnly` rule and the bot's inability to place the bet are
  both still correct, and both are still doing work.
- **It does license believing the number more.** As a displayed forecast the
  new inputs are significantly better than the shipped ones, and level with the
  exchange. Shipping them is not in this task's scope — the terms need
  `src/data/loadSlate.js` to fetch the posted top four, the wind direction and
  the prior-season team line, and that file is outside what this branch may
  touch — so `src/model/game.js` is **deliberately unchanged**. The recipe is
  `tools/game-model-v2.mjs` plus `.backtest-cache/params-core.json`.
- **It closes four specific questions.** Bullpen availability, rest and travel,
  the home-plate umpire, and a team defence term were each built, fitted on two
  seasons and measured. None of them earned its place. They are listed in the
  table above so the next person does not spend a day on them again.
- **The honest summary of the whole exercise**: the shipped model was a fifth
  of a Brier point behind the price; the best per-game inputs the public MLB
  Stats API can supply closed that gap and stopped there. If there is an edge
  in these markets it is not in better baseball inputs of this kind.

## Caveats

- **The holdout is 21 days.** 273 games, 5,649 markets, 102 trades at the
  locked screen. A 102-trade ROI interval is about 37 points wide; nothing
  smaller than a 20% edge could have cleared it. The forecast leg is much
  better powered — 5,649 markets clustered in 273 games — and it is the leg
  that came closest.
- **Posted lineups are the cards that took the field**, not the cards that were
  visible at T-120. Same optimism as the earlier study, and the lineup term is
  worth 3.7 nats of the fit, so this is small.
- **The weather is the recorded first-pitch weather, not a forecast.** Measured
  and reported above; it moves the pooled number by 0.0004.
- **Fills are idealised**: one contract, taker at the quoted top of book, no
  depth, no queue, no latency. `docs/KALSHI-MAKER-STUDY.md` says resting orders
  are worth 2.66c a contract and that you get filled when the market is moving
  against you.
- **The starter is the listed probable**, and `projIP` comes from his own
  starts rather than from `projectPitcher`'s workload model — for both v1 and
  v2, so the comparison between them is clean, but neither is exactly what the
  live board computes.
- **`EXPLAINED_TEAM_SD` is measured on FIT**, which includes 2025. If the
  spread of projections drifts between seasons the sigma is slightly wrong.
- **One configuration, one screen, one window.** The validation window liked
  w 0.6 and the holdout liked w 0.8; both were noise. Reading anything into
  which screen won either window would be the mistake this design exists to
  prevent.

## Reproduce

```
node tools/game-features.mjs --season 2025 --cache .backtest-cache \
  --out .backtest-cache/features_2025.json
node tools/game-features.mjs --season 2026 --to 2026-09-22 --cache .backtest-cache \
  --out .backtest-cache/features_2026.json

node tools/fit-game-v2.mjs --config core \
  --features .backtest-cache/features_2025.json \
  --features .backtest-cache/features_2026.json \
  --out .backtest-cache/params-core.json

node tools/backtest-kalshi-games.mjs --v2 --params .backtest-cache/params-core.json \
  --features .backtest-cache/features_2026.json \
  --features .backtest-cache/features_2025.json \
  --from 2026-09-02 --to 2026-09-22 \
  --cache .backtest-cache --kcache .kalshi-cache --json out.json
```

`--as-v1` prices the shipped model through the identical replay; `--config` takes
`v1refit`, `core`, `coreNoWx`, `coreRest` or `all`.
