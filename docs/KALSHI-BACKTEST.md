# Pitcher model vs real Kalshi prices: backtest

Run on 2026-09-16 with `tools/backtest-kalshi.mjs`. The question: would trading the
pitcher model on KXMLBKS (strikeouts) and KXMLBOUTS (outs recorded), using the bot's
own rules, have made money?

**Short answer: no.** Under the bot's rules, pitcher-prop trading lost about 11% of
money staked over Aug 10 – Sep 15. In the earlier window (Jul 10 – Aug 9) it made
about +5%, but that result is within noise. Across both windows combined it lost
4% (95% CI −10% to +2%). Strikeout markets lost money in both windows combined
(−7.8%, CI −14.5% to −1.0%). The model forecast outcomes worse than Kalshi's own
price in every slice we measured, and adding the model to the price made the
forecast worse, not better. Trades captured no closing-line value.

## Data (measured)

| | |
|---|---|
| Source | Kalshi public API, no auth: `GET /markets?series_ticker=…&status=settled` (paginated) and `GET /markets/candlesticks` (batch, `period_interval=1`) |
| History available | The live tier holds settled markets back to **2026-07-10** for both series. The historical cutoff (`GET /historical/cutoff`) is 2026-07-18; older data is only on `/historical/*`, which we did not use. |
| Series size | KXMLBKS: 12,097 settled markets, about 7 rungs per starter per game. KXMLBOUTS: 1,596, about **one** rung per starter. |
| Price history | 1-minute candles with best `yes_bid` and `yes_ask` (open/high/low/close). A candle is emitted only when something changes. Trades are also available (`/markets/trades`) but were not needed. |
| Settlement | Each market has `result` and `settlement_value_dollars`. 271 markets settled `scalar` (a scratched pitcher resolves to the "fair market price"). None of the markets we matched were scalar. Settlement agreed with the statsapi box score on **every** matched binary market. |

Coverage per window (T−120 run):

| window | markets in window | matched to a replayed start | starts | two-sided quote at decision |
|---|---|---|---|---|
| A: 2026-08-10..09-15 | 7,671 | 7,560 | 919 | 7,470 |
| B: 2026-07-10..08-09 | 5,861 | 5,622 | 680 | 5,583 |

Why markets went unmatched:
- **Pitcher did not start:** 111 in A, 120 in B. These were scratches, and the replay contains only actual starts.
- **Postponed game:** 119 in B.
- **Doubleheaders:** 161 markets carry a `G1`/`G2` suffix that `parseKalshiGameTicker` does not parse, so they are excluded from the window counts altogether.

## Method

Everything below was fixed before the full-window P&L was seen. A 6-game debug
run was looked at while building the tool, and nothing was changed because of it.

1. **Model probability.** `buildStarts()` from `tools/backtest-pitchers.mjs` rebuilds each start's inputs from games strictly before that date. Those inputs go into `projectPitcher`, and the result is priced through the bot's own `modelProbability` (`bot/plan.mjs`): the same name match, the same doubleheader rule and the same `P(X > N−0.5)` for an "N+" contract. The slate is built from the statsapi schedule and statsapi team abbreviations, which is what `loadSlate` uses.
2. **Decision time.** The scheduled first pitch comes from the ET time in the ticker. The primary decision time is **T−120 min**; the secondary is **T−30 min**. The quote used is the close of the last 1-minute candle whose `end_period_ts ≤ decision time`, so it never uses a later candle. A bid of 0 or an ask of 100 counts as no quote. The closing quote is read the same way at T.
3. **Bot rules.** `planOrders` itself runs with `screenOnly: true`, the `config.example.json` settings, `now` set to the decision time, and a one-level book of bid and ask built from the quote. That applies:
   - `buildSignal`, which blends the model toward the mid with `MARKET_WEIGHT` and requires the edge to clear fee plus 2 pts;
   - the 12-pt implausibility cap;
   - the 15–90c price bounds;
   - one rung per pitcher-series ladder.
   Three trade sets are reported:
   - `every`: every market `buildSignal` alone would trade;
   - `bot`: the `planOrders` screen;
   - `botOnePerPlayer`: `bot`, plus the sizing loop's one-bet-per-player rule across K and outs, ranked by EV per dollar.
   Order-count and daily limits are not simulated.
4. **Execution.** One contract per trade, taken at the ask. YES costs the yes ask and NO costs 100 − yes bid. The fee is the bot's own formula, 0.07·P·(1−P) per contract, unrounded. Depth is not known from candles, so it is assumed to be at least 1 contract; median KXMLBKS volume is about 3,000 contracts. P&L uses `settlement_value_dollars`.
5. **Statistics.**
   - ROI is P&L divided by (cost + fees).
   - 95% intervals come from a cluster bootstrap over pitcher-starts (5,000 resamples, fixed seed), because rungs of one start are not independent.
   - CLV compares the closing mid with the decision mid on the traded side ("mid"), and the closing mid with the price paid ("vs paid"). "Close moved for/against" gives the % of trades where the close moved toward or away from the trade. Ties make up the rest.
   - Forecast skill uses Brier score and log loss on every matched market with a two-sided decision quote. The paired model-minus-market Brier difference gets the same cluster-bootstrap interval.
6. **Sensitivity checks.**
   - **Fee rate 0.035.** Both series report `fee_multiplier: 0.5` since 2026-08-07 (`/series/fee_changes`); see Findings.
   - **Window B.** It sits entirely before the Aug 10–31 fit window used to tune `PITCHER_TUNING` (v35.1), so for the model it is out of sample.

## Results (measured)

### P&L, bot rules (`bot`), 1 contract per signal

| run | trades | hit rate vs priced | P&L / contract | ROI [95% CI] | CLV mid / vs paid |
|---|---|---|---|---|---|
| A, T−120 | 362 | 50.3% vs 54.9% | −6.04c | **−10.7% [−19.0, −2.5]** | +0.01c / −0.55c |
| A, T−30 | 355 | 51.5% vs 55.0% | −4.89c | −8.7% [−17.1, −0.1] | +0.01c / −0.54c |
| B, T−120 | 261 | 63.2% vs 58.9% | +2.89c | +4.8% [−4.4, 13.7] | +0.03c / −0.52c |
| B, T−30 | 259 | 63.3% vs 58.8% | +3.04c | +5.1% [−4.2, 13.8] | −0.06c / −0.63c |
| **A+B, T−120** | 623 | | −2.30c | **−4.0% [−10.1, 2.3]** | |
| A+B, T−30 | 614 | | −1.54c | −2.7% [−8.6, 3.5] | |

At a fee rate of 0.035, ROI rises by about 1 point in each run (A T−120: −9.6% [−18.0, −1.3]).

`every` (all `buildSignal` trades, no cap, bounds or ladder rule):
- A T−120: −10.7% [−17.8, −3.9] on 1,127 trades.
- B T−120: −3.7% [−11.9, 4.2] on 687 trades.
- Pooled A+B T−120: −7.9% [−13.1, −2.7].

`botOnePerPlayer`:
- A T−120: −11.9% [−20.6, −3.4].
- B T−120: +2.0% [−7.9, 11.4].
- Pooled: −5.9% [−12.4, 0.6].

### By series, bot rules, pooled A+B

| | T−120 | T−30 |
|---|---|---|
| KXMLBKS | n=469, −7.8% [−14.5, −1.0] | n=463, −7.1% [−13.4, −0.6] |
| KXMLBOUTS | n=154, +9.1% [−5.3, 23.4] | n=151, +12.6% [−2.5, 27.0] |

### By side and price, bot rules, window A, T−120

- **Sides:**
  - YES: n=167, −22.5% [−38.0, −6.1].
  - NO: n=195, −4.6% [−13.9, 4.2].
  - K YES is the worst cell: n=111, −34.7% [−53.2, −15.8].
- **Price buckets:**
  - 15–24c: −33%
  - 25–39c: −52%
  - 40–59c: −4%
  - 60–74c: −10%
  - 75–90c: −7.5%

  Every bucket is negative, and the intervals on the small ones are wide.

In window B the same slices are mostly positive but none is clearly positive after multiple comparisons. The largest is outs YES (n=32): +51% [19, 81]. In window A that same slice was −4.5% [−29.5, 21.0].

### CLV (measured)

Mean closing-line movement on the traded side is about 0c in every run, between −0.2c and +0.2c across the headline rows. The close moved toward the trade as often as against it: A T−120 bot 35% for vs 34% against, B 32% vs 31%. Measured against the price actually paid, CLV is about −0.55c, which is half the spread. **The model's disagreements carry no information that the market later prices in.**

### Forecast skill: model vs market vs blend (measured)

Brier score, lower is better. The difference is paired and has a cluster-bootstrap 95% CI.

| | n | model | market (decision mid) | bot blend | model − market | blend − market |
|---|---|---|---|---|---|---|
| A, all | 7,470 | 0.1717 | **0.1627** | 0.1644 | +0.0090 [0.0057, 0.0124] | +0.0017 [0.0005, 0.0029] |
| A, K | 6,561 | 0.1598 | **0.1516** | 0.1534 | +0.0082 [0.0050, 0.0116] | +0.0018 [0.0006, 0.0030] |
| A, outs | 909 | 0.2572 | **0.2427** | 0.2438 | +0.0145 [0.0066, 0.0226] | +0.0011 [−0.0018, 0.0040] |
| B, all | 5,583 | 0.1737 | **0.1667** | 0.1678 | +0.0071 [0.0036, 0.0107] | +0.0011 [−0.0002, 0.0025] |
| B, K | 4,954 | 0.1637 | **0.1571** | 0.1583 | +0.0065 [0.0030, 0.0101] | +0.0012 [−0.0002, 0.0026] |
| B, outs | 629 | 0.2532 | **0.2418** | 0.2424 | +0.0114 [0.0025, 0.0207] | +0.0006 [−0.0029, 0.0041] |

- **Market beats model everywhere.** The market beats the model in every row, and the interval excludes zero in every row.
- **The blend is worse than the market alone.** It is significantly worse on K in window A.
- **Best weight on the model is about zero.** On the same rows, the linear weight on (model − market) that minimises Brier is **0** for all and for K in both windows, and 0.1 for outs in window B. This is a diagnostic, not a tuning.
- **The model is reasonably calibrated.** For K in window A, 6→8, 25→29, 45→47, 65→64, 85→86, 93→89. It is simply less sharp and less accurate than the price.
- **Model and market differ a lot.** The median absolute gap between them is 4.3 pts, and the 90th percentile is 13.7 pts.
- **The price hardly moves after the decision time.** The closing quote scores almost the same as the T−120 quote (0.1626 vs 0.1631).

## Interpretation (inferred)

- The model is noisier than the market, and its deviations from the market are
  mostly noise. The bot's 12-pt cap and 2-pt edge hurdle select the markets where
  that noise is largest, and so select losing trades. `MARKET_WEIGHT` is 0.45 for
  strikeouts and 0.5 for outs, but these data support a weight near 0.
- Strikeouts: this is a clear, repeated loss across both windows and both decision
  times. Do not trade KXMLBKS with this model.
- Outs: the pooled point estimate is positive, but the intervals include zero, and
  the Brier score is worse than the market in both windows. That combination
  usually means luck. There is only one rung per pitcher and about 150 trades.
  Treat outs as unproven, not promising: at most, paper-trade it forward with the
  rule frozen now.
- The out-of-sample window B looks better than the in-sample window A, which is the
  opposite of overfitting. It looks like noise: window B's Brier gap to the market
  is the same sign and about the same size.

## Findings in the bot and model code

1. **The fee is probably overstated by 2× for these series (inferred).**
   - `src/trade/fees.js:38` uses `FEE_RATE = 0.07` for every series.
   - `GET /series/KXMLBKS` and `/series/KXMLBOUTS` return `fee_type: "quadratic"` with `fee_multiplier: 0.5`, and `/series/fee_changes` shows that change scheduled for 2026-08-07.
   - Kalshi's docs describe the multiplier as "applied to the fee calculations", which suggests 0.035. This is not verified against a real fill.
   - It makes the hurdle conservative, and P&L here is only about 1 pt better at 0.035.
   - The comment at `fees.js:30` ("Maker and taker pay the same") is also doubtful for `quadratic` series. The `quadratic_with_maker_fees` type exists precisely for series that do charge makers; `KXMLBGAME` is one.
2. **Doubleheader tickers are never priced.**
   - Kalshi disambiguates doubleheaders with a `G1`/`G2` suffix, for example `KXMLBKS-26SEP041915DETCLEG2`.
   - The regex at `src/data/teamMarkets.js:122` requires the ticker to end in letters directly after the time, so these tickers fail to parse and the bot skips them as "unparseable ticker".
   - Separately, `bot/plan.mjs:39` refuses any same-day pair of the same teams.
   - This fails safe and only costs coverage (161 markets across both windows).
3. **Scratched pitchers settle at a "fair market price" (scalar), not 0/1.** This affected 271 settled markets. The bot has no special handling. A position on a scratch returns roughly its price minus fees, so the result is small but not zero.

## Caveats

- **The replay is not the live slate.** It has no posted lineups, platoon splits or weather. `backtest-pitchers.mjs` states these do not change the shape of the distributions, but the live projection may differ somewhat.
- **Only actual starters are included.** Markets on pitchers who were scratched were excluded; the live bot could have traded them.
- **Window A is the model's tuning window.** `PITCHER_TUNING` was fit on Aug 10–31 and validated on Sep 1–15, so window A flatters the model. It still lost.
- **Fills are idealised.** 1-contract taker fills at the quoted top of book. Depth, queue position and latency are ignored, which favours the bot.
- **Single decision times.** T−120 and T−30 only. The scheduled bot runs at fixed clock times and checks repeatedly, so it may trade at other times.
- **Limits not modelled.** Order-count, daily-spend and Kelly sizing limits were not simulated.

## Reproduce

```
node tools/backtest-kalshi.mjs --from 2026-08-10 --to 2026-09-15 \
  --cache <statsapi cache> --kcache <kalshi cache> [--decision-min 30] [--json out.json]
```

Kalshi responses are cached under `--kcache`: about 80 MB for both windows, which
is not committed. Requests go out one at a time, at least 250 ms apart, with
back-off on 429. A cold run of one window takes about 15–20 minutes.
