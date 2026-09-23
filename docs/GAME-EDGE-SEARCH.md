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
