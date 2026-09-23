# Full audit: what is worth taking, category by category

Last run 2026-09-23, after four pre-registered edge searches reported. Every number here was measured by a tool in this repo
against settled contracts and real box scores. Nothing is projected, assumed or
carried over from an earlier version of the model.

Read the **interval**, not the point estimate. A category is evidence of
something only when its 95% interval sits entirely on one side of zero.

## The table

ROI is profit divided by money risked, at prices actually available, after
fees. Intervals are cluster bootstraps over games or pitcher-starts, because
several contracts on one game are not independent bets.

| Category | n | ROI [95%] | Model vs market (Brier) | Read |
|---|---|---|---|---|
| Pitcher strikeouts | 623 (all pitcher) | **−7.8% [−14.5, −1.0]** | worse | **AVOID** — the only category whose interval excludes zero on the losing side |
| Batter hits + runs + RBIs | 149 | **−14.6% [−30.8, +0.8]** | worst gap of any series | **AVOID** — −29% in the fit window, and the largest Brier gap measured |
| Pitcher outs | 145 | +3.8% [−11.9, +19.1] | slightly worse | no signal — needs 2,341 trades to resolve, about five seasons |
| Batter hits | 326 | −2.5% | worse | no signal |
| Batter total bases | 254 | −1.8% | worse | no signal |
| Batter home runs | 82 | +0.5% | worse | no signal — the positive cell is 55 NO bets on heavy favourites |
| Batter RBIs | 14 | +35% | worse | no signal — n=14 |
| Game lines (ML, run line, total) | 0 | — | 3.1–3.2 pts from market, no lean | **not playable** — zero contracts ever clear the hurdle, by arithmetic |
| First inning (NRFI/YRFI) | 0 | — | model spans 47–52% | **not playable** — never far enough from the market to call |
| Batter stolen bases | 15 | **−64%** | worst of the six, +0.0016 [0.0005, 0.0028] | **AVOID** — listed as KXMLBSB since v36.4; it is mapped for completeness, not because it should be traded |

## The four searches (2026-09-23)

Each split the data before looking at it, committed its success bar before
computing any profit, and touched the final window once. **All four failed the
bar.** Two produced a better model anyway, and one found a real rule that is
too small to build on.

| Search | Bar | Result | What it left behind |
|---|---|---|---|
| Game model | Brier beats the price AND positive ROI, intervals excluding zero | **FAIL** — pooled −0.0002 [−0.0025, +0.0019], ROI +0.1% [−18.0, +19.2] on 102 contracts | A model that is **level** with the price rather than 0.0023 behind it: paired vs shipped, −0.0025 [−0.0045, −0.0005] |
| Batter model | same | **FAIL** — price wins all six series, pooled +0.0008 [0.0002, 0.0014]; ROI +24.8% [−0.1, 49.5] on 74 trades | Platoon term measured as noise; runs/RBI/H+R+RBI rebuilt from one plate-appearance distribution. Paired vs shipped, 0.0003 [0.0000, 0.0006] |
| Market microstructure | a rule that clears fees, BH-corrected over 26 tests | **FAIL** for 25 of 26 | One real rule: the price lags the box score. See below |
| Pitcher model | same as game | **FAIL** — pooled Brier −0.0023 [−0.0055, +0.0009], ROI −8.4% [−17.2, +0.6] on 543 trades | Strikeouts moved from 0.0075 behind the price to **level**; and the explanation below |

### Why every one of these lands just short

The pitcher search measured the thing that explains the whole programme. Median
quoted spread at the decision, by market:

| market | median spread | who wins the forecast |
|---|---|---|
| strikeouts | **1c** | the price |
| outs recorded | **1c** | the price |
| hits allowed | 9c | the model, narrowly |
| walks | 13c | the model, narrowly |
| earned runs | **38c** | the model, by a mile |

Where the book is a cent wide, the price beats the model. Where the model beats
the mid, **the mid is the midpoint of an empty quote** — and at T−30, once the
thin books fill in, the hits-allowed and walks advantages reverse sign outright.

Earned runs is the only market that clears the forecast bar, at −0.0206
[−0.0294, −0.0116], and it loses 21.5% of money staked. The shipped model
scores identically there, so it is not the new modelling that produces it. A
38c spread does. Raising a market weight on that basis would be the exact
mistake this programme exists to catch.

That is the honest shape of the whole thing: **the model can reach parity with
a tight price, and parity does not pay a 1c spread plus a 1.7c fee.** Every
apparent edge in this repo has lived in a market too wide to trade.

### The only rule that clears zero out of sample

Poll the StatsAPI game feed. The moment it serves a starting lineup, take every
Kalshi player-prop market still open on a player **not** in that lineup; if it
has a two-sided quote 2c wide or tighter, buy YES at the ask and hold to
settlement. Kalshi cancels those markets and settles them at a "fair market
price" that sits about 4c above the last quoted mid.

**+2.42% [+1.64%, +3.23%]** per contract after the fee, p = 0.0002, firing 32.8
times a day. It is implementable — the trigger reads only the published lineup,
never the cancellation — and all 4,054 markets it selected did settle cancelled,
so it gives up almost nothing to the hindsight version.

Its status is *suggestive and replicated*, not proven: all twelve pre-registered
arms were negative, and this rule was written after seeing the discovery window,
then confirmed once on the holdout. Its sibling without the spread cut failed at
−0.24%.

**It cannot be scaled, and the reason is depth.** Four cents of bias, minus a
two-cent half-spread, minus a 1.4c fee, leaves one cent — and nothing at all
above a 2c spread. Meanwhile **51–54% of these markets never trade a single
contract in their entire life** and 82% trade nothing after the news. That is
**25 cents a day at one contract**, and the 24 lots a clip needed to make it $6
would be moving the very quantity Kalshi computes its settlement price from.

Not latency, which was the hypothesis going in: the lineup is public a median
**184 minutes** before first pitch, the market stays open until a median 100
minutes after it, and the mid does not move in between. Nobody is racing you.
An afternoon of free time bought nothing. `docs/SCRATCH-SETTLEMENT-STUDY.md`

### The other rule that works, and why it is not a plan

When a starter records his *s*-th strikeout, "s+ strikeouts" is worth exactly
100c and cannot change; when a reliever throws his first pitch, every rung
above the starter's final total is worth exactly 0c. Buying or selling those
inside sixty seconds paid 7.5c and 18.4c per contract in the confirmation
window. No forecast is involved — the outcome is already settled.

**241 opportunities in 68 days. $21.07 total at one contract.** About $6/day at
twenty lots, and 97% are gone within sixty seconds. It is a latency race
against faster bots, not a research result, and collecting it needs live order
placement with sub-second reaction. `tools/stale-watch.mjs` watches for it live
without placing anything, to establish whether it still exists at all.

### What these searches killed, which is worth as much as what they kept

- **Arbitrage inside Kalshi**: zero riskless violations in 1,290,284 nested pairs.
- **The platoon multiplier**: the model spread hits-1+ over 4.2 points; reality spreads 1.3 and points the other way. Selection, not skill — a hitter's line already averages over the matchups he was given.
- **Bullpen availability**: fitted to zero. The median team already has 93.7% of its relief innings in available arms.
- **Top-of-order for the first inning**: exponent fitted to zero. The first inning is more about the arm, not more about the bats.
- **Umpires, team defence, rest and travel, recent form, lineup slot as a talent signal**: each gained on the fit window and lost on validation.
- **Predicting the closing price instead of the game**: a six-hour round trip with no view costs 3.66c, so it raises the bar rather than lowering it.

Pitcher props were re-tested from scratch in September with a model built
properly — two seasons, recency weighting, partial pooling, the posted lineup,
catcher, umpire, park and weather, and a joint depth-first distribution. It is a
better forecaster than the shipped one in all five pitcher markets, and it still
does not beat the price: pooled Brier difference −0.0023 [−0.0055, +0.0009] and
ROI −8.4% [−17.2, +0.6] on a clean 21-day holdout. Three further Kalshi series
(hits allowed, earned runs, walks) were priced for the first time and lost 14%,
22% and 29%. `docs/PITCHER-EDGE-SEARCH.md`.

Pooled: **1,232 prop trades, −3.7%**. In all seven series the exchange's price
forecast the outcome better than the model did, and the interval on that
difference excludes zero in every one.

A second entry for game lines was added on 2026-09-23. Better per-game inputs —
starters regressed component by component, the prior season in the team line,
the posted card, wind direction — were fitted on 2025 plus 2026 to 08-09,
chosen on 08-10..09-01 and tested once on 09-02..09-22. They forecast
significantly better than the shipped inputs (pooled −0.0025 [−0.0045,
−0.0005], paired on identical markets) and that was exactly enough to pull the
model level with the exchange and no further. Bullpen availability, rest and
travel, the umpire and a defence term were each built and measured, and none of
them earned a place.

## Three things that are NOT the problem

Each of these was the obvious escape hatch, and each was tested and closed.

1. **Execution.** Resting orders instead of crossing the spread is worth 2.66c
   per contract (1.13c spread + 1.53c fee). The trades lose 1.73c. Perfect
   execution would not cover it, and execution is not perfect: the same trades
   taken at the ask returned −6.2% where a resting order would have filled and
   +1.6% where it would not. You get filled when the market is moving against
   you. `docs/KALSHI-MAKER-STUDY.md`.
2. **Fees.** Halving the fee to 0.035 moves every result by about 1.5 points.
   Nothing changes category.
3. **The projections.** They are well calibrated — quoted probabilities land
   within about 1 point of observed frequency across 2,025 batter-games and 534
   starts. Being right about baseball and beating a price are different
   problems. `docs/BATTER-BACKTEST.md`.

## The one thing that is not disproven

Not the model — **the spread between books.** When one sportsbook prices a prop
away from the consensus of the others, that gap is real money and it does not
depend on the model being right about anything.

That is now the only thing the board calls a play: since the weights dropped to
the measured values (v36.2) the model can move a price by at most 1.5–2.25
points, and the smallest call needs 3. Nothing the model believes can produce a
bet on its own.

**This has not been measured yet, and that is the honest gap in this audit.**
Measuring it needs a multi-book price archive with closing prices, which does
not exist — the board's snapshots live in one browser's localStorage and did not
record how many books priced each row until today. The RESULTS tab now records
`nBooks` and slices on it, so the answer starts accumulating from the next slate
graded. Until roughly 50 settled picks exist, RESULTS will correctly refuse to
name anything.

## What would change these conclusions

- **Pitcher outs**: 2,341 trades at the observed effect size, or 9,364 at half
  of it. Paper-trade it with the rule frozen; do not size it up on a good week.
- **The book-disagreement rule**: 50 graded picks before RESULTS names a
  category, and a 95% interval clearing zero before it means anything. Expect
  months, not days.
- **Anything else**: a measured result, not a good stretch. Every category above
  has had a good stretch.

## Method

`tools/backtest-kalshi.mjs`, `tools/backtest-kalshi-batters.mjs`,
`tools/backtest-kalshi-games.mjs`, `tools/outs-study.mjs`,
`tools/maker-study.mjs`. Each writes its own doc in this directory with the
pre-registration, the coverage, the cuts and the sensitivity checks.
