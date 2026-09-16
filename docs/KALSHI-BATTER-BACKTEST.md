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

---

# Results (run 2026-09-16, after the method above was committed)

**Short answer: no.** The batter model shows no edge against Kalshi prices.

- **Bot rules lose, but inside the noise.** Trading at T−120 with one bet per
  player across all five series, 609 trades lost 3.4% of money staked at the
  bot's fee (95% CI −11.0% to +4.4%), or 1.8% at fee 0.035 (−9.5% to +6.2%).
  - The hit rate was exactly the price-implied rate: 40.6% vs 40.6%.
  - Closing-line value was 0.00c.
- **The market is the better forecaster.** Kalshi's own price beat the model on
  Brier score in every series and every window. The interval excludes zero
  everywhere except the Sep 1–15 holdout, where it still points the same way.
- **The best weight on the model is low.** The Brier-optimal weight is 0–0.25,
  against the bot's `MARKET_WEIGHT` of 0.35–0.5.
- **No series passes the pre-registered edge test.** That holds at T−120 and at
  T−30.

The batter model is much closer to the market than the pitcher model was. The
median |model − market| gap is 2.0 pts (pitchers: 4.3), and the Brier gap is
about 0.001 (pitchers: 0.009). That closeness is why the losses are small
rather than large. There is still no sign of information the price lacks.

## Coverage (measured)

| | |
|---|---|
| Settled markets, live tier (Jul 10 – Sep 15) | HIT 49,778 · TB 60,553 · HR 29,373 · RBI 31,259 · HRR 75,493 = 246,456 |
| In window | 246,456: B 105,287 · A1 83,276 · A2 57,893 |
| Matched to a replayed posted starter and priced | **240,571** (97.6%), across 863 games and 15,145 player-games |
| Two-sided quote at T−120 / T−30 | 153,758 (64%) / 219,033 (91%) |
| Doubleheader (G1/G2) markets matched | 2,897. The bot skips all of these; see Findings. |
| Settled `scalar` | 3,647 in the series. 64 of them are among matched starters; no bot trade hit one. |
| Settlement ≠ statsapi box score | 110 markets in 43 player-games (0.05%). P&L uses Kalshi's settlement. |

Why markets went unmatched (5,885 in total):
- **3,482 settled scalar.** These players did not start, which is expected.
- **1,223 were for games not on the schedule** (postponed).
- **1,180 settled 0/1 but were not priced.** Every one of these is **Max Muncy**:
  Kalshi writes "Max Muncy (LAD)" / "Max Muncy (ATH)", and the bot's name
  matcher cannot read it (Findings 1). No other started player went unmatched.

**Quotes are thin before lineups.** Batter markets open a median of about 140
minutes before first pitch, and only about 70% are listed by T−120. So T−120
already sits close to lineup time for most of them.

## P&L (measured)

One contract per trade, taken at the ask. ROI is P&L ÷ (cost + fee), with a 95%
cluster bootstrap over games. "Hit" is the win rate vs the average price paid.
CLV is shown as mid / vs paid, in cents.

### Headline: `botOnePerPlayer`, T−120

| window | n | hit vs priced | ROI @0.07 | ROI @0.035 | CLV mid / paid |
|---|---|---|---|---|---|
| **A+B** | 609 | 40.6 / 40.6 | **−3.4% [−11.0, 4.4]** | **−1.8% [−9.5, 6.2]** | 0.00 / −0.60 |
| A (Aug 10–Sep 15) | 382 | 33.5 / 35.2 | −8.2% [−19.8, 3.3] | −6.5% [−18.3, 5.2] | −0.01 / −0.64 |
| B (Jul 10–Aug 9) | 227 | 52.4 / 49.8 | +2.3% [−8.0, 12.5] | +3.7% [−6.7, 14.1] | 0.03 / −0.55 |
| A1 (fit, in sample) | 217 | 31.8 / 35.2 | −13.0% [−28.1, 2.1] | −11.3% [−26.8, 4.1] | −0.05 / −0.66 |
| A2 (holdout) | 165 | 35.8 / 35.1 | −1.9% [−19.3, 15.7] | −0.1% [−17.7, 17.9] | 0.04 / −0.61 |
| OOS (B + A2) | 392 | 45.4 / 43.7 | +0.8% [−8.1, 9.8] | +2.4% [−6.7, 11.4] | 0.04 / −0.57 |

The same set at T−30 (1,031 trades):
- A+B: −3.2% [−9.8, 3.3] at 0.07, −1.6% [−8.3, 5.1] at 0.035.
- A: −2.8%. B: −3.7%.

T−30 is when every lineup is posted and quotes are two-sided; it is no better.

### By series, `bot` (one rung per player per series), T−120, fee 0.035

| series | A+B | A | B |
|---|---|---|---|
| KXMLBHIT | n=326, −0.7% [−13.6, 12.4] | +0.5% [−17.1, 17.6] | −3.1% [−21.4, 17.7] |
| KXMLBTB | n=254, −0.1% [−12.6, 12.6] | −0.1% [−19.3, 20.1] | −0.1% [−16.2, 16.4] |
| KXMLBHR | n=82, +1.2% [−9.4, 11.4] | −0.1% [−20.2, 16.3] | +1.8% [−10.6, 14.6] |
| KXMLBRBI | n=14, +38.0% [−47.3, 137.3] | +58.6% (n=9) | +15.6% (n=5) |
| KXMLBHRR | n=149, **−13.1% [−29.6, 2.6]** | **−29.0% [−52.2, −6.1]** | +8.8% [−11.1, 28.0] |

At fee 0.07, every ROI is about 1.5 pts lower: HIT −2.5%, TB −1.8%, HR +0.5%,
RBI +35%, HRR −14.6% [−30.8, 0.8].

T−30 `bot` at fee 0.035, A+B:
- HIT +0.7% [−9.7, 11.5] (A +9.9%, B −11.8%)
- TB −3.3% [−13.5, 7.2]
- HR +0.5% [−9.2, 10.9]
- RBI −10.0% [−53.5, 40.0]
- HRR −10.0% [−21.2, 1.3]

`every` (every `buildSignal` trade, no cap, bounds or ladder rule), T−120:
- 1,603 trades: −2.7% [−10.6, 5.5] at 0.07, −1.0% [−9.1, 7.3] at 0.035.

At T−30:
- 2,890 trades: −5.6% [−12.2, 1.1] at 0.07.
- HRR −10.1% [−19.8, −0.5].
- HIT in window B −15.8% [−28.7, −3.6].

### By side and price, `botOnePerPlayer`, T−120, A+B, fee 0.07

**Side:**
- YES: n=401, −1.7% [−15.6, 12.8].
- NO: n=208, −4.9% [−13.2, 3.1].

**Price bucket:**

| price | n | ROI [95% CI] |
|---|---|---|
| 15–24c | 240 | −9.2% [−33.2, 16.0] |
| 25–39c | 80 | +3.1% [−29.7, 36.7] |
| 40–59c | 151 | −10.5% [−24.8, 4.0] |
| 60–74c | 87 | +1.2% [−12.2, 14.2] |
| 75–90c | 51 | +6.7% [−5.2, 16.7] |

**Series × side:**
- **HRR YES** is the worst cell: n=60, −36.9% [−64.6, −11.6]. It is −52% in A
  and +0.5% in B.
- **HR** trades are all NO at 75–90c: n=55, +7.2% [−4.4, 17.3]. That is +4.5%
  in A and +8.8% in B, but its Brier score is worse than the market in both
  windows.
- **HR YES almost never passes** the bot's 15c floor, because HR YES prices
  mostly sit at 5–15c.
- **At T−30, HR in window A reads +21.6% [5.3, 38.4]** (n=21), and +2.3% OOS.
  This is one of dozens of slices, and window B is −2.4%.

## Forecast skill: model vs market vs blend (measured)

Brier score (lower is better) on every matched market with a two-sided T−120
quote and a 0/1 settlement. Differences are paired, with a game-cluster
bootstrap 95% CI. "w" is the Brier-optimal weight on (model − market), a
diagnostic only. The bot's `MARKET_WEIGHT` is HIT 0.45, TB 0.45, HR 0.5,
RBI 0.35 and HRR 0.4.

| window | series | n | model | market | blend | model − market | blend − market | w |
|---|---|---|---|---|---|---|---|---|
| A+B | all | 153,728 | 0.1543 | **0.1533** | 0.1534 | +0.0011 [0.0006, 0.0015] | +0.0001 [−0.0001, 0.0003] | 0.10 |
| A+B | HIT | 30,817 | 0.1511 | **0.1501** | 0.1502 | +0.0010 [0.0005, 0.0014] | +0.0001 | 0.10 |
| A+B | TB | 40,742 | 0.1489 | **0.1480** | 0.1481 | +0.0009 [0.0005, 0.0013] | +0.0001 | 0.15 |
| A+B | HR | 13,426 | 0.0832 | **0.0827** | 0.0828 | +0.0005 [0.0002, 0.0008] | +0.0001 | 0 |
| A+B | RBI | 19,512 | 0.1465 | **0.1456** | 0.1456 | +0.0009 [0.0004, 0.0014] | +0.0000 | 0.15 |
| A+B | HRR | 49,231 | 0.1835 | **0.1820** | 0.1822 | +0.0015 [0.0008, 0.0021] | +0.0002 | 0.10 |
| A | all | 98,416 | 0.1562 | **0.1552** | 0.1553 | +0.0011 [0.0006, 0.0016] | +0.0001 | 0.10 |
| B | all | 55,312 | 0.1510 | **0.1499** | 0.1500 | +0.0010 [0.0003, 0.0018] | +0.0001 | 0.15 |
| A1 (fit) | all | 57,738 | 0.1515 | **0.1501** | 0.1504 | +0.0014 [0.0007, 0.0020] | +0.0003 [0.0000, 0.0005] | 0 |
| A2 (holdout) | all | 40,678 | 0.1630 | **0.1624** | 0.1623 | +0.0006 [−0.0002, 0.0014] | −0.0000 | 0.25 |
| OOS | all | 95,990 | 0.1561 | **0.1552** | 0.1552 | +0.0009 [0.0003, 0.0014] | +0.0000 | 0.20 |

- **Market beats model in every series and window, by point estimate.** At
  A+B, A, B and OOS level the interval excludes zero for every series. The one
  exception is HRR in window B, whose lower bound is 0.0000.
  - Window B per series: HIT +0.0010, TB +0.0009, HR +0.0006, RBI +0.0012,
    HRR +0.0012.
  - The only rows whose CI reaches zero are A2 per series (HIT, TB, RBI, HRR)
    and HR in A1.
- **The blend is never significantly better than the market alone.** It is
  significantly worse in A1 and on HR in A2.
- **The same holds on tighter quotes and at T−30.** Restricting to spreads of
  5c or less changes nothing (A+B all: +0.0012 [0.0008, 0.0016], w = 0). At T−30
  it is +0.0012 [0.0008, 0.0015], with w = 0.05.
- **Both forecasts are well calibrated** (A+B, all, model → observed):
  - model: 6→7, 14→15, 25→25, 34→35, 45→45, 55→55, 65→66, 73→72;
  - market: 6→6, 14→15, 24→26, 34→35, 44→45, 55→56, 65→66, 73→74.

  The market is simply sharper.
- **The price barely moves before first pitch.** The closing quote scores the
  same as the T−120 quote (0.1558 vs 0.1557).
- **CLV is zero.** Mean closing-line movement on the traded side is within
  ±0.3c in every pooled and per-series row with n ≥ 50. Only the tiny RBI sets
  reach −1.2c. and the close moved for and against
  the trade about equally (T−120 A+B: 30% vs 26%). Against the price paid,
  CLV is about −0.6c, which is half the spread.

## Pre-registered edge test (Method 9): `bot`, T−120, fee 0.035

| | (a) A+B CI lower > 0 | (b) ROI > 0 in A and in B | (c) model beats market Brier in A and B | qualifies |
|---|---|---|---|---|
| KXMLBHIT | no | no | no | **no** |
| KXMLBTB | no | no | no | **no** |
| KXMLBHR | no | no | no | **no** |
| KXMLBRBI | no | yes (n = 9 and 5) | no | **no** |
| KXMLBHRR | no | no | no | **no** |
| pooled `botOnePerPlayer` | no | no | no | **no** |

No series qualifies. Every series fails (c): the model's forecast is worse than
the price everywhere.

## Interpretation (inferred)

- **The model cannot beat the price.** The batter model is well calibrated and
  close to the market, but the market is consistently a little sharper, and the
  model's disagreements with it carry no information: CLV is 0 and the best
  weight is about 0.1.
  - The bot's hurdle and cap pick out the largest disagreements, which are
    mostly model noise. So trades land on price-implied hit rates, minus the
    spread and fee.
  - The expected result is a small, steady loss, and that is what we see: −2%
    to −5% depending on the set and the fee.
- **HRR is the one series with a consistent negative sign.** It is −7% to
  −23% A+B across sets and decision times at fee 0.07, with CIs at or just past zero, and
  the largest Brier gap (+0.0015). Its losses sit mostly in A1, the model's own
  fit window. Do not trade KXMLBHRR with this model.
- **The HR NO trades are the only positive-looking cell.** n=55, +8%, CI
  includes 0. They sit next to a Brier score that is worse than the market's in
  both windows and a best weight of 0.
  - That combination usually means luck on heavy favourites: 75–90c prices,
    where a few extra wins swing ROI.
  - Not evidence of an edge. At most, paper-trade it forward with the rule
    frozen now.
- **Out-of-sample looks better than in-sample.** Window B and the A2 holdout
  look better than A1 (OOS `botOnePerPlayer` +2.4% vs A1 −11.3%). This is the
  reverse of overfitting and matches the pitcher study. The Brier gap has the
  same sign in every window, so this looks like noise.
- **Decision for the bot:** these data support no batter-prop trading with the
  current model. Together with the pitcher study, the model has not shown an
  edge over Kalshi's price in any of the seven prop series tested.

## Findings in the bot and model code

1. **Kalshi's same-name disambiguation breaks name matching (measured).**
   - Kalshi titles the two Max Muncys "Max Muncy (LAD)" and "Max Muncy (ATH)"
     (`yes_sub_title`).
   - `playerNameOf` (`src/lib/kalshi.js:246`) passes that string through, and
     `normalizeName` (`src/lib/names.js:100`) turns it into "max muncy lad".
   - `matchName` at `bot/plan.mjs:69` therefore reports `missing`.
   - Both players are never priced: 1,180 settled markets, Jul 10 – Sep 15.
   - This fails safe (no trade). It will recur for any future same-name pair,
     and a fix must use the team to pick the player, not just strip it.
2. **Doubleheaders are never priced (measured, same as the pitcher study).**
   - `parseKalshiGameTicker` (`src/data/teamMarkets.js:122`) requires the
     ticker to end in letters, so `…G1`/`…G2` fails to parse.
   - The bot also refuses same-day pairs at `bot/plan.mjs:39`.
   - Batter series carry 2,944 suffixed markets. This tool priced 2,897 of them
     by mapping `G<n>` to statsapi `gameNumber`.
   - Headline results with doubleheaders excluded are unchanged (−3.3% vs −3.4%).
3. **The fee rate is probably 2× too high (inferred for the rate, measured for
   the flag).**
   - `GET /series/{KXMLBHIT,KXMLBTB,KXMLBHR,KXMLBRBI,KXMLBHRR}` all return
     `fee_type: "quadratic"` with `fee_multiplier: 0.5`.
   - `src/trade/fees.js:38` uses 0.07.
   - At 0.035, ROI improves by about 1.5 pts and no conclusion changes.
4. **`MARKET_WEIGHT` for batter markets is too high for these data (inferred).**
   - `src/lib/constants.js:57-65` sets 0.35–0.5.
   - The Brier-optimal weight is 0–0.25 in every window, and 0 in the fit
     window.
   - Not changed here (Method 10).
5. **Scratches settle at a fair price (measured).** 3,647 batter markets settled
   `scalar`, almost all on non-starters. The confirmed-lineup rule avoids most
   of these. No bot trade here hit one.
6. **Limits would bind at T−30.** `botOnePerPlayer` averages 16 trades a day
   there, up to 36, against `maxOrdersPerDay: 15`. At T−120 it averages 9.7 a
   day, up to 20. Not simulated.

## Caveats

- **The replay is not the live slate.** It has no weather. It uses the posted
  starters from the boxscore, and the 2025 priors are fixed by season.
- **Window A1 is the model's fit window,** so it flatters the model. It was the
  worst window anyway.
- **Fills are idealised.** One-contract taker fills at the quoted top of book.
  Depth is unknown, and the median volume on TB, RBI and HRR markets is under
  25 contracts, so real fills at size would be worse.
- **Only two decision times were tested,** and order and spend limits are not
  modelled.
- **About 0.05% of settlements disagree with the statsapi box score.** They are
  kept at Kalshi's value, because that is what would have been paid.

A cold run took 24.7 minutes and 5,588 Kalshi requests (two lanes, at least
250 ms between request starts). The candle cache (`kalshi-cache/candles-bat/`,
863 files) is not committed.
