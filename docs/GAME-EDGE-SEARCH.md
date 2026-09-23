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
