# Can the pitcher model be made to beat the price?

`docs/KALSHI-BACKTEST.md` measured 623 replayed pitcher-prop trades at −4.0%,
strikeouts alone at −7.8% [−14.5, −1.0], and — the part that matters — the
exchange's own price forecasting outcomes better than the model in every slice,
with the Brier-optimal weight on (model − market) equal to 0 for strikeouts and
0.1 for outs. The projections are well calibrated; they are simply less sharp
than the price.

This study asks whether that is fixable: whether a pitcher model built properly
— two seasons, recency weighting, partial pooling, lineup handedness, catcher,
umpire, park and weather, and a batters-faced/rate decomposition instead of
independent counting stats — can beat the Kalshi decision-mid price on
strikeouts, outs recorded, hits allowed, earned runs and walks.

**Part 1 below was written and committed before any profit number, any Brier
comparison against a price, and any look at the validation or holdout windows.**

---

## Part 1 — Pre-registration

### The split, fixed before anything was measured

By calendar date, not by data:

| split | dates | what it may be used for |
|---|---|---|
| **FIT** | all of 2025 + 2026 through **2026-08-09** | fitting model parameters against **outcomes** (log loss / Brier vs what happened). No price data enters here. |
| **VALIDATE** | **2026-08-10 .. 2026-09-01** | choosing between candidate configurations, and choosing the one blend weight, against **prices**. |
| **HOLDOUT** | **2026-09-02 .. 2026-09-22** | touched **once**, for the single configuration already chosen. |

The model's parameters are fit on FIT only. Anything that requires seeing a
price — which candidate wins, what weight to put on the model against the market
— is decided on VALIDATE only. If the holdout is inspected more than once, the
report says so explicitly.

Note on price history: the Kalshi live tier holds settled markets for KXMLBKS
and KXMLBOUTS back to **2026-07-17**, and for KXMLBHA / KXMLBERA / KXMLBWA only
back to **2026-08-17**. So the three new series have no price data in FIT at all,
and their VALIDATE slice is 2026-08-17 .. 09-01. That is a coverage fact, not a
choice; FIT is an outcome-only window regardless.

### Markets

| series | market | thresholds seen |
|---|---|---|
| KXMLBKS | strikeouts | 1+ .. 13+ |
| KXMLBOUTS | outs recorded | 6+ .. 21+ |
| KXMLBHA | hits allowed | 1+ .. 8+ |
| KXMLBERA | earned runs | 1+ .. 7+ |
| KXMLBWA | walks allowed | 1+ .. 5+ |

An "N+" contract settles YES when the stat is at least N, so the model
probability is P(X > N − 0.5).

### Decision time and price

Primary **T−120 min** before the scheduled first pitch parsed from the ET time in
the event ticker; **T−30 min** reported as a secondary, not part of the bar. The
quote is the close of the last 1-minute candlestick whose `end_period_ts ≤` the
decision time — never a later candle. A yes bid of 0 or a yes ask of 100 counts
as no quote; both sides are required.

### Trade rule (pre-registered)

The bot's own `planOrders` only knows KXMLBKS and KXMLBOUTS, so this study uses
an explicit rule of its own, fixed here, applied identically to all five series:

1. Blended probability `p = mid + w · (model − mid)`, with **one** weight `w`
   chosen on VALIDATE (searched over 0, 0.1, … 1.0) and then frozen.
2. Buy YES at the ask when `p − ask/100 > fee + 0.02`; buy NO at `100 − bid` when
   `(1 − p) − (100 − bid)/100 > fee + 0.02`. Fee is the bot's own
   `0.07 · P · (1 − P)` per contract, unrounded.
3. Price bounds 15–90c.
4. Cap: no trade where |model − mid| exceeds 12 points (the bot's
   `IMPLAUSIBLE.prop` — a disagreement that large is a data problem, not an edge).
5. One contract per trade, taker at the quoted top of book, one rung per
   pitcher-start per series (the largest edge).
6. P&L from Kalshi's `settlement_value_dollars`. ROI = P&L / (cost + fees).

### Statistics

95% intervals from a cluster bootstrap over **pitcher-start** (`pitcherId:date`,
20,000 resamples, fixed seed), because rungs of one start are not independent.
Brier differences are paired and get the same cluster bootstrap.

### The bar — what counts as success

Both must hold on the **HOLDOUT**, at T−120, for the single chosen configuration:

- **(A)** The model's Brier beats the exchange decision-mid price, with the
  paired cluster-bootstrap 95% interval on (model − market) lying entirely
  **below zero**.
- **(B)** ROI after the 0.07 fee is **positive** with its 95% interval lying
  entirely **above zero**.

Anything less is a **FAIL** and is reported as one. Per-market results (K, outs,
hits allowed, ER, walks) and pooled are reported either way, always with n and
intervals. A negative result, clearly reported, is the successful outcome of this
exercise; tuning until the number looks good is the failure mode it exists to
avoid.

### Pre-declared secondary reporting (not part of the bar)

T−30; fee 0.035 (both series report `fee_multiplier: 0.5`); per-series and
per-side cuts; the Brier-optimal weight on (model − market) as a diagnostic; the
baseline (shipped `projectPitcher`) measured on the same rows, so the question
"did the new modelling work help at all" has an answer independent of the bar.

### Pre-registered stopping condition

One holdout run of the tool at T−120 produces the primary numbers. It is not
re-run with different settings in search of a better one.

---

## Part 2 — What was built and what the validation said

*(written after Part 1 was committed)*

## Part 3 — Holdout

*(one run, at the end)*

## Verdict

*(to follow)*
