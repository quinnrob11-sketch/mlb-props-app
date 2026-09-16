# Batter model vs real Kalshi prices: backtest

Question: would trading the batter model on KXMLBHIT (hits), KXMLBTB (total
bases), KXMLBHR (home runs), KXMLBRBI (RBIs) and KXMLBHRR (hits + runs + RBIs),
with the bot's own rules, have made money?

The companion pitcher study is `docs/KALSHI-BACKTEST.md`. This study reuses its
method. Differences are called out below.

## Method (fixed before any P&L was computed)

This section was written and committed before the tool was run over the full
windows. Nothing in it was changed after seeing P&L.

1. **Markets.** Every settled market in the five series from Kalshi's public
   live tier (`GET /markets?series_ticker=…&status=settled`), which holds
   2026-07-10 onward. Doubleheader tickers (`…DETCLEG2`) are parsed by the tool
   and matched to the statsapi `gameNumber`. A same-day pair of games without a
   suffix is skipped, as the bot does.
2. **Windows.**
   - **B**: Jul 10 – Aug 9. Fully out of sample for the batter model.
   - **A**: Aug 10 – Sep 15. Split into **A1** (Aug 10–31), the fit window for
     `BATTER_TUNING`, which is in sample, and **A2** (Sep 1–15), the holdout.
   - **OOS** means B + A2 pooled, and **A+B** means everything.
3. **Model probability.** Rows come from the lookahead-free replay in
   `tools/backtest-batters.mjs`, extended back to Jul 10. It uses the posted
   starters from each boxscore and inputs built only from games before that
   date. Each starter goes on a one-game slate as `lineupSource: 'confirmed'`
   with `name = person.fullName` and `proj = projectBatter(input)`. The
   probability is the bot's own `modelProbability`, which applies the same name
   match and the same `P(X > N − 0.5)` for an "N+" contract, and runs
   `calibrate()` (currently a no-op for batter lines). Markets on players who
   are not posted starters cannot be priced and are counted as unmatched. The
   live bot never trades those either, because it requires confirmed lineups.
4. **Decision quotes.**
   - The first-pitch time T is the ET time in the ticker.
   - The primary decision time is **T−120 min** and the secondary is
     **T−30 min**. The close is read at T.
   - The quote is the close of the last candle ending at or before the decision
     time, and never a later candle.
   - Candles are fetched as hourly candles up to E = the hour boundary at or
     before T−120, then 1-minute candles from E−60 to T. They are merged so
     that hourly candles cover ≤ E and minute candles cover > E. This gives the
     same top of book as pure 1-minute candles: checked on 195 (ticker, time)
     pairs from the pitcher cache, with 0 differences. It uses about a tenth of
     the requests.
   - A bid of 0 or an ask of 100 counts as no quote.
5. **Bot rules.** `planOrders` runs once per game per decision time, with
   `screenOnly: true`, the `config.example.json` settings, `now` set to the
   decision time, and a one-level book from the quote. That applies:
   - `buildSignal`: the `MARKET_WEIGHT` blend and the edge ≥ fee(0.07) + 2 pts
     hurdle;
   - the 12-pt implausibility cap;
   - the 15–90c bounds;
   - one rung per player per series.

   Three trade sets are reported:
   - `every`: every market `buildSignal` alone would trade;
   - `bot`: the `planOrders` screen;
   - `botOnePerPlayer`: `bot`, plus the sizing loop's one bet per player across
     **all five series**, in `planOrders`' ranking order (EV per dollar).

   Order-count, spend and Kelly limits are not simulated. **`botOnePerPlayer`
   is the headline "bot rules" result.**
6. **Execution and P&L.**
   - One contract per trade, taken at the ask. YES costs the yes ask; NO costs
     100 − yes bid.
   - P&L uses Kalshi's `settlement_value_dollars`. A market that settled
     `scalar` (a starter with no plate appearance) pays its fair-price value
     and is counted separately.
   - The fee is quadratic, unrounded, and reported at **0.07**, the bot's
     `FEE_RATE`, and at **0.035**. Every batter series reports
     `fee_multiplier: 0.5`, and 0.035 is probably the real rate.
   - The trade set is always the one the bot's 0.07 hurdle selects. Only the
     fee charged changes.
7. **Statistics.**
   - ROI is P&L ÷ (cost + fees).
   - 95% intervals use a **cluster bootstrap over games** (gamePk), with 5,000
     resamples and a fixed seed. Clustering is by game, not player, because
     batters in one game share the run environment, and H, TB, HRR and RBI on
     one player are nearly the same bet.
   - Hit rate is compared with the average price paid.
   - CLV is the closing mid minus the decision mid on the traded side, plus the
     closing mid minus the price paid.
8. **Forecast skill.**
   - Computed on every matched market with a two-sided decision quote and a
     0/1 settlement.
   - Brier score for the model, the market (decision mid) and the bot's blend
     (`blendedProbability` with `MARKET_WEIGHT`).
   - Paired model − market and blend − market differences, with the same
     game-cluster bootstrap.
   - The Brier-minimising weight on (model − market), on a grid of 0.05. This
     is a diagnostic, not a tuning.
   - Shown per series and per window. As a secondary view, the same is repeated
     on quotes with a spread of 5c or less, because a wide-spread mid is a poor
     benchmark and is not tradeable anyway.
9. **What counts as evidence of an edge.** A series qualifies only if all of
   these hold for `bot`, T−120:
   - (a) the pooled A+B ROI 95% CI lower bound is > 0 at fee 0.035;
   - (b) the point ROI is > 0 in **both** window A and window B at fee 0.035;
   - (c) the model − market Brier point estimate is < 0 in both windows.

   With five series and two decision times, one false positive at the 5% level
   is roughly a coin flip. So a series that qualifies is a candidate for frozen
   forward paper-trading, not a green light. The same test is applied to the
   pooled `botOnePerPlayer`.
10. **What is not changed.** The model, `BATTER_TUNING`, `MARKET_WEIGHT`, the
    hurdle and the bounds all stay as they are on this branch. Nothing is tuned
    to these prices.

Reproduce:

```
node tools/backtest-kalshi-batters.mjs --from 2026-07-10 --to 2026-09-15 \
  --cache <statsapi batter cache> --kcache <kalshi cache> [--json out.json]
```

The run covers both decision times and all windows. Kalshi responses are cached
under `--kcache`: `settled_<SERIES>.json` and `candles-bat/<game>.json`.
