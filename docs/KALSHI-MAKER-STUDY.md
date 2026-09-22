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

# Results (run 2026-09-22, after the method above was committed)

**Short answer: no.** Resting orders do not turn this from losing to winning.
They take the pooled result from about −3% to about −1%, the interval spans zero
in every variant, and the improvement disappears entirely if makers turn out to
pay a fee after all. The fills are also demonstrably the wrong half of the
decisions: the same trades, taken at the ask, lost 6.2% on the decisions where
the resting order filled and made +1.6% on the ones where it did not.

**The single number that decides it is 2.66c.** That is the mean per-contract
saving from resting instead of crossing — the spread we no longer pay plus the
fee we no longer pay — and it is the entire prize. The taker strategy lost 1.73c
per contract. So the best case for resting, filling every time with no adverse
selection, is roughly +0.9c per contract, or about +1.6% ROI, with a 95% interval
that would still straddle zero. Everything else in this document is about how
much of that 2.66c survives contact with the order book. The answer is: about
half of it, and only under the fee reading that has never been checked.

## The decision set (measured)

| | |
|---|---|
| Pitcher props | `tools/backtest-kalshi.mjs`, `trades.bot`, 2026-07-10 .. 2026-09-15, T−120 |
| Batter props | `tools/backtest-kalshi-batters.mjs`, `trades.botOnePerPlayer` (that study's headline set), same window, T−120 |
| Game lines | **none.** `docs/KALSHI-GAME-BACKTEST.md` shows the bot cannot place a game-line trade at all — 0 trades over 19,908 markets, by a closed inequality. There is no decision to re-execute, so `KXMLBGAME` (the one series that charges makers) contributes nothing here. |
| Decisions | 1,080 across 603 games; 1,040 across 578 games after dropping dates before 2026-07-16 (see Caveats) |
| Windows | A (Aug 10 – Sep 15) 639 · B (Jul 10 – Aug 9) 401 |

The pitcher set is 591 trades where `docs/KALSHI-BACKTEST.md` reported 623. The
difference is `b4aec45` (v36.1), which raised `minPriceCents` from 15 to 25 after
that document was written; the 15–24c bucket is gone. Nothing else about the
screen changed.

### The spread, again

Mean spread 1.13c. 920 of 1,040 decisions (88%) are on a book one cent wide.
**Resting at the best bid saves at most one cent of price on nine decisions in
ten, and resting one cent inside is not a legal passive order on those at all.**

## The arithmetic ceiling (measured)

```
mean saving per contract if a resting order ALWAYS filled     +2.66c
mean P&L per contract as a taker at the ask, fee 0.07         −1.73c
mean P&L per contract as a taker at the ask, fee 0.035        −0.97c
```

The 2.66c is 1.13c of spread plus 1.53c of fee. Note what that means: **most of
the prize is the fee, not the spread**, and the fee half of it rests entirely on
reading `fee_type: "quadratic"` as "makers pay nothing". If makers pay at the
series' own 0.5 multiplier, the ceiling falls to about 1.9c; if they pay the full
rate the bot charges, it falls to 1.13c — less than the loss, and resting cannot
win under any fill model.

## P&L (measured)

1,040 decisions, 578 games, T−120, order pulled at first pitch. ROI is P&L over
cost; cost is charged on every decision in the "all decisions" column and only on
filled ones in the "on filled" column. 95% intervals are game-cluster bootstraps.

| strategy | fill | ROI on filled | **ROI over all decisions** |
|---|---|---|---|
| **(a)** taker at ask, fee 0.07 (what the bot does) | 100% | −3.0% [−7.8, 1.9] | **−3.0% [−7.8, 1.9]** |
| (a) taker at ask, fee 0.035 | 100% | −1.7% [−6.6, 3.2] | −1.7% [−6.6, 3.2] |
| **(b)** maker at bid, no fee, fill = trade at or through | 55.3% | −2.1% [−8.6, 4.6] | **−1.2% [−5.2, 2.6]** |
| (b) same, minute volume ≥ 5 | 52.4% | −2.2% [−9.2, 4.8] | −1.3% [−5.1, 2.5] |
| (b) same, minute volume ≥ 20 | 49.7% | −0.6% [−7.4, 6.1] | −0.3% [−4.1, 3.4] |
| **(b)** same, **traded through** (queue-proof) | **24.5%** | −4.2% [−14.0, 5.6] | **−1.1% [−3.8, 1.5]** |
| (b) maker at bid, maker fee 0.035 | 55.3% | −3.3% [−9.7, 3.2] | −2.0% [−5.8, 1.8] |
| (b) maker at bid, maker fee 0.07 | 55.3% | −4.6% [−10.9, 1.9] | −2.7% [−6.5, 1.1] |
| **(c)** maker at bid+1, no fee, at or through | **5.7%** | −2.2% [−22.7, 18.5] | −0.1% [−1.3, 1.1] |
| (c) same, traded through | 4.4% | −12.9% [−35.8, 9.9] | −0.6% [−1.7, 0.4] |

**No row passes the pass/fail rule.** No ROI over all decisions is positive with
an interval excluding zero; none is positive at a 0.035 maker fee; none is
positive in both windows. The best row, (b) at volume ≥ 20, is −0.3% [−4.1, 3.4]
— a point estimate indistinguishable from zero on a fill rule chosen after the
fact from three.

By window, for (b) at no fee, at-or-through:

| | fill | ROI all decisions |
|---|---|---|
| A: Aug 10 – Sep 15, n=639 | 53.4% | −4.0% [−9.2, 1.1] |
| B: Jul 10 – Aug 9, n=401 | 58.4% | +2.7% [−3.2, 8.5] |

The sign still flips between the windows, exactly as it does for the taker
strategy (A −7.5% [−13.9, −1.0], B +3.4% [−3.8, 10.7]). Resting does not change
that; it shifts both windows up by two to three points and leaves the instability
untouched.

By source, (b) at no fee, at-or-through: pitcher props fill 85.3% and return
−0.6% [−6.8, 5.6] over all decisions; batter props fill **19.4%** and return
−2.1% [−5.8, 1.7]. The batter markets are far too thin to rest in.

### Closing-line value

Resting does buy real CLV, and it is the only clean win in the study. Measured
against the price actually paid, the closing mid is:

- taker at the ask: **−0.69c [−0.80, −0.57]** — half the spread, as in all three
  earlier studies;
- maker at the bid: **+0.21c [+0.06, +0.35]**.

That swing of 0.9c is the spread being earned rather than paid, and it is
consistent with the ceiling above. It is also not enough.

## Fills: how much is the queue worth? (measured)

| fill rule | fill rate | what it assumes |
|---|---|---|
| trade at or through our price | 55.3% | we are at the **front** of the queue — an upper bound |
| minute volume ≥ 5 contracts | 52.4% | 5× our size traded in that minute |
| minute volume ≥ 20 contracts | 49.7% | 20× our size traded in that minute |
| trade **through** our price | 24.5% | nothing — everything at our level had to clear first; a **lower** bound |

**The true fill rate is between 25% and 55%, and the volume thresholds barely
move it.** That last point is worth stating plainly: requiring 20× our size
traded in the same minute only drops the fill rate from 55% to 50%, because these
minutes are either busy or empty: the median resting window trades about 330
contracts, and 328 of the 1,040 windows trade nothing at all. Volume is a poor proxy
for queue position. The traded-through rule is the informative one, and it says
we would have got fewer than half the fills the optimistic rule grants.

Note the direction this cuts: the traded-through rule has a *worse* ROI on filled
trades (−4.2% vs −2.1%). The fills you are most certain of are the ones where the
price moved furthest through your level — which is the definition of adverse
selection, measured next.

## Adverse selection (measured)

The same resting order, split by whether it filled. 1,040 decisions.

**At-or-through fill rule (575 filled, 465 not):**

| | filled | unfilled |
|---|---|---|
| contract settled in our favour | 57.6% | 53.8% |
| mid drift on the traded side, decision → first pitch | **−0.34c [−0.48, −0.20]** | **+0.50c [+0.29, +0.70]** |
| **the same trade taken at the ask** | **−6.2% [−12.4, +0.1]** | **+1.6% [−6.0, +9.5]** |

**Traded-through fill rule (255 filled, 785 not):**

| | filled | unfilled |
|---|---|---|
| mid drift, decision → first pitch | −1.13c [−1.40, −0.89] | +0.37c [+0.27, +0.47] |
| the same trade taken at the ask | −8.2% [−17.6, +1.1] | −1.1% [−6.9, +4.3] |

Three readings, in order of how much weight they carry:

1. **The price moves against a fill and toward a miss, and the two intervals do
   not overlap.** On the decisions that filled, the market moved 0.34c against us
   by first pitch; on the ones that did not, it moved 0.50c in our favour. The
   traded-through rule triples the gap. This is textbook adverse selection,
   measured directly rather than assumed.
2. **The maker order selects the worse decisions, not just the worse prices.**
   Taken at the ask — same price, same fee, no maker arithmetic involved at all —
   the filled subset returns −6.2% and the unfilled subset +1.6%. The 4.7-point
   difference between them is larger than the 2.66c ceiling resting was supposed
   to earn. Resting does not merely get you a better price on the same trades; it
   changes which trades you get, for the worse.
3. **Settlement follows, weakly.** 57.6% vs 53.8% is in the same direction but is
   within noise on this n, and the point estimate is confounded by the filled set
   having a different price mix. The price-path evidence is the load-bearing one.

The `bid+1` order shows the same pattern more sharply on a much smaller pool
(120 decisions where the spread allowed it): the 46 that filled under the
traded-through rule returned −16.7% as taker trades, and the 74 that did not
returned **+21.8% [−0.8, +46.1]**. Eight of ten profitable price-improved orders
would simply never have been hit.

### Leaving the order resting longer makes it worse, significantly

Sensitivity: the same orders left resting two hours past first pitch rather than
pulled at it.

| | fill | ROI over all decisions |
|---|---|---|
| (b) at or through, pulled at first pitch | 55.3% | −1.2% [−5.2, 2.6] |
| (b) at or through, pulled at first pitch + 2h | 64.7% | **−4.1% [−8.3, +0.2]** |
| (b) traded through, pulled at first pitch | 24.5% | −1.1% [−3.8, 1.5] |
| (b) traded through, pulled at first pitch + 2h | 57.5% | **−7.7% [−11.8, −3.6]** |

More time resting buys more fills and loses more money, and under the queue-proof
rule the loss is the only result in this study whose interval excludes zero. The
extra fills are overwhelmingly the ones where the game had already started to go
the wrong way. **This is the cleanest single demonstration that these fills are
adversely selected**, and it is also a direct warning against the obvious "just
leave the order up longer" fix.

## `makerAlternative()` in `src/trade/signals.js` — is the arithmetic right?

Reviewed, not changed. Six observations, in order of how much they matter.

1. **The fee is wrong under the evidence, and wrong in the direction that hides
   the maker case.** `expectedValueCents(signal.blendedProb, restPrice)` subtracts
   `feePerContractCents(restPrice)`, which is the full `FEE_RATE = 0.07` taker
   rate. Every series the bot can actually trade reports `fee_type: "quadratic"`,
   so on the reading this study uses a resting order pays nothing, and the
   function understates the resting order's EV by up to 1.75c. Even under the
   most conservative reading, the series carries `fee_multiplier: 0.5`, so 0.035
   is the ceiling and 0.07 is too high either way. `src/trade/fees.js:30-45`
   already says this in a comment; the code in `signals.js` has not followed.
2. **`improvementCents` charges 0.07 on both legs, so it is not just offset — the
   comparison itself is distorted.** It computes
   `(taker − rest) + fee₀.₀₇(taker) − fee₀.₀₇(rest)`. The correct quantity under
   the evidence is `(taker − rest) + fee₀.₀₃₅(taker)`. At a 50c ask and a 48c
   rest, the code reports +2.00c where the truth is +2.88c. It understates the
   improvement by roughly the maker fee it should not be charging.
3. **It returns `null` on a 1c spread — which is 88% of the bot's decisions.**
   `if (bestYesAsk - bestYesBid <= 1) return null;` means the only maker order the
   trade layer can describe is the one that is almost never available. Resting
   *at* the bid is perfectly legal on a 1c book, is what this study measures as
   strategy (b), and is where essentially all of the (small) maker value lives.
   `src/ui/makerMode.js` gets this right for the board —
   `restCents = Math.min(bidCents + 1, belowFair, askCents - 1)` degrades to the
   bid on a 1c spread — so the UI and the trade layer disagree about what a maker
   order even is.
4. **The probability is unconditional, and it should not be.** `blendedProb` is
   the probability given the book at decision time. The EV of a resting order is
   the probability **conditional on being filled**, and this study measures that
   conditioning to be worth about 4.7 points of ROI. The `note` field says
   "passive fills are adversely selected" in words; the arithmetic does not.
5. **It compares a certain trade with an uncertain one as if both were certain.**
   `improvementCents = ev − signal.evCents` sets the EV of an order that fills
   25–55% of the time against the EV of one that fills by construction. A caller
   ranking by `improvementCents` would rank a rarely-filled order above a
   certainly-filled one on a difference the rare order mostly will not collect.
6. **The side arithmetic is correct.** For a NO trade, `100 - (bestYesAsk - 1)` is
   the same order as offering YES one tick inside the ask, and pairing it with
   `signal.blendedProb` (already the traded-side probability) is right. No bug
   there.

**It is also dead code.** `makerAlternative` is exported from `src/trade/signals.js`
and called from nowhere in `src/`, `bot/` or `test/`. Nothing depends on the
errors above today, which is why this study reports them rather than fixing them.

## Interpretation (inferred)

- **Execution is not what made these decisions lose.** The whole spread and the
  whole fee together are 2.66c per contract; the decisions lose 1.73c. Fixing
  execution perfectly buys about +1.6% ROI on a strategy whose interval is
  ±5 points wide. It is inside the noise of the thing it is trying to fix.
- **Resting is nonetheless the better of the two orders, on a point estimate.**
  −1.2% against −3.0%, and CLV goes from −0.69c to +0.21c. If the bot were going
  to trade these markets at all, resting at the bid is the better way to do it.
  That is not the same as a reason to trade them.
- **The fee reading is doing more work than the spread.** 1.53c of the 2.66c
  ceiling is the fee. Everything positive in this study depends on an inference
  from the *name* of a fee type. One real maker fill would settle it, and until
  one exists the honest version of the headline is the 0.035 row: −2.0%.
- **`bid + 1c` is not a strategy on these books.** It is legal on 12% of
  decisions and fills on 6% of them. Over all decisions it returns −0.1%, which is
  what "almost never trades" looks like in a ROI column.
- **The adverse selection is real, large, and measured.** A 4.7-point swing in
  taker ROI between filled and unfilled decisions is not a modelling artefact —
  it uses the same prices and the same fees on both sides and differs only in
  which decisions are in which bucket. Any future maker design has to price it.
- **The fill model is generous and it still does not help.** The at-or-through
  rule hands us front-of-queue on every order. Halving the fill rate to the
  queue-proof rule changes the answer from −1.2% to −1.1%, because the fills you
  lose are the good ones and the bad ones fill anyway.

## What would change the conclusion

1. **A real maker fill showing a zero fee AND a second season of data.** The
   ceiling is only 2.66c with a zero maker fee. Even then the point estimate is
   −1.2%; it would take a genuinely positive model edge, not better execution, to
   clear zero.
2. **A market where the spread is not 1c.** Everything here is downstream of an
   88%-one-tick book. A series with a 4–5c spread would make (c) legal and the
   ceiling several times larger. None of the MLB series the bot trades is such a
   market at T−120.
3. **Evidence that the adverse selection is avoidable.** If fills could be
   conditioned on something — cancelling when the book moves, re-pricing, a
   shorter resting window — the 4.7-point selection penalty might shrink. This
   study tested the opposite direction (resting longer) and it got worse.
4. **A model with an edge.** None of this matters otherwise. The three earlier
   studies all found the exchange's price forecasts better than the model in
   every slice measured. Better execution of a negative-edge strategy is a
   smaller loss, not a profit.

## Recommendation

**Do not switch the bot to resting orders on the strength of this.** The IOC
taker order stays. If the maker question is revisited, the order to test is
"rest at the best bid" — not `makerAlternative`'s `bid + 1`, which is illegal on
nine books in ten — and the thing to measure first is a real fill's fee, because
1.53c of the entire 2.66c prize is an inference from a string.

## Caveats

- **The live tier has aged since the earlier studies ran.** Kalshi no longer
  serves candlesticks for the first week of the window: 25 of 591 pitcher
  decisions have candles in the September cache and none from the API today, and
  the same query the pitcher study made returns 0 for them now. All results above
  drop dates before 2026-07-16 for that reason. Putting those 40 decisions back
  moves the headline by less than a tenth of a point (−1.2% either way), because
  they are 4% of the set and are scored as never filled. Re-running this study later will lose more of the
  window; the cache in `mcache/` is what makes it reproducible today.
- **The fill model is an upper and a lower bound, not a fill model.** It has no
  order book, no queue, no depth and no latency. It brackets the truth between
  25% and 55%; it does not locate it.
- **Only one contract, always.** Depth is invisible in candles. A larger order
  fills less often and worse.
- **Cancel-and-replace is not modelled.** A real maker would re-price as the book
  moved. That is a different strategy with different adverse selection, and this
  study says nothing about it.
- **No maker fee was ever observed.** The zero-fee rows are an inference from
  `fee_type`. The 0.035 and 0.07 rows are there precisely because it is an
  inference.
- **Unfilled decisions are charged their full price in the denominator.** That is
  the honest reading of "the capital was committed", but a real desk with many
  resting orders recycles unfilled capital. The conclusion does not depend on it:
  the ROI on filled trades alone is also negative in every variant.
- **`mid drift +2h into game` is thin.** Most of these markets have a one-sided
  book once the game starts, so the two-hour price path exists for only 78 of
  575 filled decisions. It is reported for direction, not for magnitude.
- **One decision time.** T−120 only. The batter study's own T−30 set was not
  re-executed.
- **Nothing here re-tests the model.** The decision set is taken as given from
  studies that already found it has no edge.

## Reproduce

```
# 1. the decision sets (unchanged tools, writing their trade lists to JSON)
node tools/backtest-kalshi.mjs --from 2026-07-10 --to 2026-09-15 \
  --cache mcache/statsapi --kcache mcache --json mcache/pitcher-t120.json
node tools/backtest-kalshi-batters.mjs --from 2026-07-10 --to 2026-09-15 \
  --cache mcache/statsapi-batter --kcache mcache --json mcache/batter.json

# 2. the maker study
node tools/maker-study.mjs \
  --decisions "mcache/pitcher-t120.json#bot,mcache/batter.json#botOnePerPlayer" \
  --kcache mcache --min-date 2026-07-16 --json mcache/maker.json

# sensitivities
node tools/maker-study.mjs ... --deadline 120      # rest 2h into the game
node tools/maker-study.mjs ... --maker-fee-rate 0.035
```

`mcache/` holds every Kalshi response and is not committed. The new fetch is one
batch of 1-minute candlesticks per game over the resting window — about 600
requests, serialised at 350 ms with back-off, roughly four minutes cold and free
thereafter.
