# Resting orders instead of crossing the spread: a maker study

Run with `tools/maker-study.mjs`. The question: the bot sends IOC taker orders at
the ask and pays the full fee. If it had instead RESTED a bid — at the best bid,
or one tick inside it — on exactly the same historical decisions, would it have
made money, and how often would it actually have filled?

This is a follow-up to three studies that all found no edge:
`docs/KALSHI-BACKTEST.md` (pitcher props, −4.0% ROI pooled),
`docs/KALSHI-BATTER-BACKTEST.md` (batter props, −3.4%) and
`docs/KALSHI-GAME-BACKTEST.md` (game lines, no trades possible at all). In every
one of them Kalshi's own price beat the model's Brier score. Nothing here
re-opens that. The only question is whether the *execution* was what made the
decisions lose.

**Everything in the Data, Method and Pass/fail sections below was written and
committed BEFORE any maker P&L was computed** (commit history on
`agent/maker-study`). The one number looked at first was the spread histogram of
the decision set, because it decides whether "bid + 1c" is a legal order at all;
it is reported under Data and it was not used to choose any rule.

### The spread at the decision time (measured, before the method was fixed)

591 `bot` decisions, T−120, 2026-07-10 .. 2026-09-15:

| yes ask − yes bid | decisions |
|---|---|
| 1c | 534 (90.4%) |
| 2c | 50 |
| 3c | 7 |

**Nine decisions in ten are on a book that is one cent wide.** On those, "rest at
bid + 1c" is not a resting order — it is the ask, and the order crosses. Strategy
(c) is therefore only legal on 57 of 591 decisions, and strategy (b) can save at
most one cent of price.

## Data (measured)

| | |
|---|---|
| Source | Kalshi public API, no auth: `GET /markets?series_ticker=…&status=settled`, `GET /markets/candlesticks` (`period_interval=1`), `GET /series/<S>`. No authenticated endpoint, no order was placed. |
| Decision set | Read from the JSON `tools/backtest-kalshi.mjs` already writes. Not rebuilt. |
| New data fetched | 1-minute candles over the resting window, keeping the fields the earlier studies dropped: `volume_fp` and the traded-price range `price.low_dollars` / `price.high_dollars`. The earlier tools cached only `yes_bid.close` / `yes_ask.close`, which cannot model a fill. |
| Cache | `mcache/` in this worktree (git-ignored). |

### Fee metadata, read from the exchange on 2026-09-22

`GET /series/<ticker>`, all eleven MLB series the bot can see:

| `fee_type` | `fee_multiplier` | series |
|---|---|---|
| `quadratic` | 0.5 | KXMLBKS, KXMLBOUTS, KXMLBHIT, KXMLBTB, KXMLBHR, KXMLBRBI, KXMLBHRR, KXMLBSPREAD, KXMLBTOTAL, KXMLBRFI |
| `quadratic_with_maker_fees` | 0.5 | KXMLBGAME |

There is **no `maker_fee_type`, `maker_fee_multiplier` or any other fee field**
on the series object, and none on the market object either. So the only evidence
available from public data is the name of the fee type. `quadratic` and
`quadratic_with_maker_fees` are two distinct schedules, and the second one is
named for the thing the first one lacks; the natural reading is that a maker pays
nothing on a `quadratic` series. **That reading is not verified.** It cannot be
verified without a real fill, which this study does not do. Results are therefore
reported at a maker fee of 0, at 0.035 and at the full 0.07, and the conclusion
is required to hold at all three.

## Method (pre-registered)

1. **The decision set is not rebuilt.** `tools/backtest-kalshi.mjs` is run
   unchanged over 2026-07-10 .. 2026-09-15 at T−120 with `--json`, and
   `tools/maker-study.mjs` reads `trades.bot` out of that file — the markets, the
   model probabilities, the decision time and the `planOrders` screen are
   byte-identical to the published pitcher study. Only the order that is assumed
   to have been sent changes.
2. **The decision book is reconstructed exactly.** The base study records, per
   trade, the traded side, the taker price and the book mid expressed on that
   side. Those pin the YES book: for a YES trade `ask = price`,
   `bid = 2·mid − ask`; for a NO trade `bid = 100 − price`,
   `ask = 2·(100 − midSide) − bid`. Both must come out whole cents or the tool
   throws. No quote is re-read and nothing is re-fetched for the decision itself.
3. **The three orders**, all for 1 contract, all on the side the bot chose:
   - **(a) taker at the ask** — what the bot does now. YES costs the yes ask, NO
     costs 100 − yes bid. Fee `0.07·P·(1−P)` per contract, unrounded, exactly as
     `src/trade/fees.js` charges it. Assumed to fill, as all three earlier
     studies assume.
   - **(b) maker resting at the best bid on the traded side** — a YES buy rests
     at the yes bid. A NO buy rests at `100 − yes ask`, which is the same order as
     offering YES at the current best ask. Either way it *joins* an existing queue
     and does not improve the price.
   - **(c) maker one tick inside** — `bid + 1` on the traded side, which is
     `makerAlternative()`'s price. This is only a resting order when the spread is
     at least 2c; at a 1c spread `bid + 1` is the ask and the order crosses. Those
     decisions are counted as "no maker order possible" and score $0.
4. **The fill rule.** An order resting at P from the decision time until the
   deadline fills if a later 1-minute candle prints a trade at or through P with
   non-zero volume:
   - a resting YES bid at P fills if `price.low ≤ P`;
   - a resting NO bid at Q — an offer of YES at 100 − Q — fills if
     `price.high ≥ 100 − Q`.

   **This overstates fills**, and not slightly: it assumes we are at the front of
   the queue. On Kalshi's price-time priority, an order joining the best bid sits
   behind everything already resting there, and the candle does not show how much
   that is. Three things bound the overstatement, and all three are reported:
   - **volume thresholds.** The same rule requiring the minute's volume to be
     ≥ 5 and ≥ 20 contracts against our 1 contract — a crude proxy for "enough
     traded through to clear the queue ahead of us".
   - **the traded-through rule.** Requiring the print to be *strictly* past our
     level (`price.low < P`, or `price.high > 100 − Q`). Nothing can trade through
     a price while orders rest at it, so a traded-through fill is one we would
     have got from any queue position. This is a **lower** bound on the fill rate;
     the at-or-through rule is an upper bound. The truth is between them.
   - for **(c)**, `bid + 1` creates a new best level at which nobody else is
     resting, so there is no queue and the at-or-through rule is close to exact.
     The price of that is that (c) is only legal on a wide enough spread.
5. **Deadline.** The order rests from T−120 to the scheduled first pitch T and is
   then pulled. Unfilled decisions score **$0**. A sensitivity leaves it resting
   two hours into the game.
6. **P&L and the two ROIs.** P&L per contract is `payout − price − fee`, payout
   from Kalshi's settlement on the traded side. Cost is `price + fee` and is
   charged on **every decision**, filled or not, because an order ties up its
   price while it rests. So:
   - **ROI on filled trades** = P&L ÷ cost over the filled subset;
   - **ROI over all decisions** = P&L ÷ cost over every decision, with unfilled
     ones contributing 0 to the numerator and their full price to the
     denominator. This is the honest denominator and it is the headline.
7. **Statistics.** 95% intervals are cluster bootstraps over **games** (the event
   segment of the ticker), 5,000 resamples, fixed seed — not over contracts,
   because rungs of one pitcher-start move together. Mean CLV and mean price
   drift get the same game-cluster bootstrap.
8. **Adverse selection, tested directly.** Resting orders fill preferentially
   when the market is moving against you. For the same resting order, the filled
   and unfilled decisions are compared on four things:
   - the rate at which the contract actually settled in our favour;
   - the mid drift on the traded side from the decision to first pitch;
   - the same drift two hours into the game;
   - the ROI the *same decisions* would have earned as taker trades. That last
     one is the cleanest: it strips the price difference out and asks only
     whether the maker order selected the worse decisions.
9. **Nothing is tuned.** No model constant, weight, hurdle or bound is changed.
   `src/`, `bot/` and `test/` are not touched.

## Pass/fail rule (fixed before any P&L was computed)

Resting orders turn this from losing to winning only if **all** of these hold for
strategy (b) or (c) on the pooled decision set:

1. **ROI over all decisions** is positive and its 95% game-cluster interval
   excludes zero;
2. it holds under the **traded-through** fill rule, not only the at-or-through
   one — i.e. it does not depend on assuming front-of-queue;
3. it survives a maker fee of **0.035**, so the conclusion does not rest on the
   unverified reading that `quadratic` series charge makers nothing;
4. the point estimate is positive in **both** windows (A: Aug 10 – Sep 15,
   B: Jul 10 – Aug 9) separately.

Anything else is **no improvement demonstrated**. A positive ROI on filled trades
alone does not count: filling 15% of decisions at a profit while the other 85%
earn nothing is not a strategy, it is a smaller strategy.

## The arithmetic ceiling

Before any fill model, there is a hard bound on what resting can be worth. A
maker order saves, per contract, exactly

```
(taker price − rest price) + (taker fee − maker fee)
```

and nothing else. The first term is at most the spread. The second is at most
`0.07·P·(1−P)`, which is 1.75c at 50c and less everywhere else. If that sum is
smaller than the taker strategy's loss per contract, resting cannot turn a loss
into a profit **however well it fills** — and a fill rate below 100% only makes
it worse, because unfilled decisions still tie up capital. This number is
reported first, and it is the single number that decides the question.

---

*(Results below were computed after the above was committed.)*
