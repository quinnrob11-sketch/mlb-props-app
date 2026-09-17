# Game model vs real Kalshi prices: backtest

Run on 2026-09-17 with `tools/backtest-games.mjs` (the lookahead-free replay) and
`tools/backtest-kalshi-games.mjs` (the price study). The question: would trading
the GAME model — moneyline, run line, total and the first inning — on Kalshi,
using the bot's own rules, have made money?

This is the third study of its kind. `docs/KALSHI-BACKTEST.md` (pitcher props)
and `docs/KALSHI-BATTER-BACKTEST.md` (batter props) both found no edge and a
model that forecast worse than the price in every slice. The game model is newer
and better grounded, so this was a genuinely open question.

**Everything in the Data, Method and Pass/fail sections below was written and
committed BEFORE any window's profit and loss was computed.** A 40-game debug
run was looked at while building the tool, exactly as the pitcher study looked at
a 6-game run; nothing was changed because of it, and it is disclosed in Caveats.

## Data (measured)

| | |
|---|---|
| Source | Kalshi public API, no auth: `GET /markets?series_ticker=…&status=settled` (paginated) and `GET /markets/candlesticks` (batch) |
| Series | `KXMLBGAME` (moneyline, 2 contracts per game), `KXMLBSPREAD` ("TEAM wins by over X.5", a two-sided ladder), `KXMLBTOTAL` ("Over X.5 runs", a ladder), `KXMLBRFI` ("1st inning: Over 0.5 runs", one contract per game) |
| History available | The live tier holds settled game markets back to **2026-07-14** — four days later than the pitcher and batter series. Window A is therefore Jul 14 – Aug 9 in practice. |
| Series size | 1,690 / 7,275 / 10,315 / 846 settled markets, 845–846 game events each, 2026-07-14 .. 2026-09-17. |
| Price history | Hourly candles from each market's open plus 1-minute candles over the last five hours before first pitch, merged. A candle is emitted only when something changes, so a deep ladder rung's quote can be hours old; the age of every decision quote is measured and reported. |
| Settlement | `result` and `settlement_value_dollars`, cross-checked against the replayed box score (final score, margin, first-inning runs) on every matched market. |

`KXMLBRFI` is a clean mapping for the model's `nrfi`: one market per game, YES =
"over 0.5 runs in the 1st inning", which is exactly `nrfi.yrfiProb`. The other
first-inning-ish series Kalshi lists are not: `KXMLBINNINGTOTAL` and
`KXMLBINNINGWIN` are per-inning markets with no fixed inning in the series, and
`KXMLBF3`/`KXMLBF5`/`KXMLBF5TOTAL`/`KXMLBF5SPREAD` are 3- and 5-inning markets
the model does not produce (it exposes the first inning and the full game, not a
partial-game score distribution).

## The replay (measured)

`tools/backtest-games.mjs` rebuilds, for every completed regular-season game,
from games played strictly BEFORE that date:

- each team's season hitting line (runs, games, OPS) from its game log;
- each team's **starter** and **reliever** split lines. `loadSlate` gets these
  live from `/teams/stats?stats=statSplits&sitCodes=sp,rp`, which has no usable
  date range (it silently returns the whole season), so they are rebuilt from
  every pitcher's game log: appearances with `gamesStarted > 0` go to the sp
  bucket, the rest to rp;
- the league baselines `loadSlate` derives from those two payloads — runs per
  team-game and `leagueRunPrevention` (the FIP constant, `spRa9`, `rpRa9`,
  `allRa9`);
- both starters' as-of season lines, prior-season lines and `projIP`, from the
  same `backtest-pitchers.mjs` replay the pitcher study uses. The season line is
  rebuilt here rather than reused because `backtest-common`'s version drops
  `hitByPitch`, which the FIP numerator needs;
- the venue, and each team's own home venue (the park term is two-sided: a
  team's own lines are neutralised by its home park before tonight's is applied);
- the posted batting orders and their as-of OPS, centred across the slate exactly
  as `loadSlate` centres them (`--lineups`).

Not replicated: **weather** (`projectGame` gets no `wx`, so `weatherFactor()` is
1 — there is no free historical forecast archive in this repo), and the starter
is whoever actually started rather than whoever was the listed probable.

### Replay validation, before any Kalshi work

2026-07-14 .. 2026-09-16, 847 games, run with posted lineups:

| | model | actual |
|---|---|---|
| home win | 52.98% | 53.84% |
| no run in the 1st (832 games with both starters) | 50.97% | 51.08% |
| over 6.5 | 66.55% | 68.24% |
| over 7.5 | 55.50% | 56.08% |
| over 8.5 | 47.88% | 48.17% |
| over 9.5 | 38.09% | 39.32% |
| over 10.5 | 31.69% | 32.94% |
| home −1.5 covers | 35.84% | 35.66% |
| home +1.5 covers | 64.67% | 65.88% |
| runs per game | 8.803 | 8.883 |

The model sits within 0.9 points of the observed rate on every line and within
0.08 runs per game. The league reference rates the model was fitted to (home win
52.9%, over 8.5 49.1%, NRFI 49.5%) are full-season 2026 figures; this window ran
slightly more home wins and slightly fewer overs, and the replay tracks the
window, not the season. Posted lineups move nothing material: without them the
same run gives home win 53.07%, NRFI 50.97%, over 8.5 47.84%.

Coverage: 847/847 games replayed, 832 with both starters (the other 15 are
openers or starters who were never a listed probable), 846 with posted lineups.

## Method

1. **Model probability.** The replay's `projectGame` output is priced through the
   bot's own `modelProbability` (`bot/plan.mjs`) for the three series the bot
   knows — the same ticker parsing, the same doubleheader rule, the same
   strike-to-side mapping. `KXMLBRFI` is not in the bot's `GAME_SERIES`, so it is
   priced by a local function that mirrors the same matching and is reported in
   its own row, never mixed into the bot's numbers.
2. **Decision time.** The scheduled first pitch comes from the ET time in the
   ticker. The primary decision time is **T−120 min**, the secondary **T−30**.
   The quote is the close of the last candle whose `end_period_ts ≤` the decision
   time, so it is never a later candle. A bid of 0 or an ask of 100 counts as no
   quote. The closing quote is read the same way at T.
3. **Bot rules.** `planOrders` itself runs with `screenOnly: true`, the
   `config.example.json` settings, `now` set to the decision time and a one-level
   book built from the quote. That applies `buildSignal` (blend toward the mid
   with `MARKET_WEIGHT`, edge must clear fee + 2 pts), the **8-pt** game
   implausibility cap, the 15–90c price bounds and one rung per game-series
   ladder. Reported sets:
   - `bot` — the `planOrders` screen;
   - `botOnePerGame` — `bot`, then only the best EV-per-dollar market on each
     game (`planOrders`' ladder rule is per series, so it can take all three);
   - `every` — every market `buildSignal` alone would trade, no cap, no bounds;
   - `w<weight>cap<cap>` — the same screen as `bot` at other model weights and
     with the cap released, written out by hand. This hand-written screen is
     checked against `planOrders` at the bot's own settings on every game and the
     count of disagreements is reported.
   - `rfiNotTradeableByBot` — `KXMLBRFI` at `MARKET_WEIGHT.nrfi` (0.5) with the
     8-pt cap and the price bounds. **The bot cannot place this trade today.**
4. **Execution.** One contract per trade, taker at the ask. YES costs the yes
   ask, NO costs 100 − yes bid. The fee is the bot's own formula,
   0.07·P·(1−P) per contract, unrounded, with 0.035 reported as a sensitivity
   (all four series report `fee_multiplier: 0.5`). Depth is not known from
   candles and is assumed to be at least 1 contract. P&L uses
   `settlement_value_dollars`.
5. **Statistics.** Identical to the two earlier studies. ROI is P&L over
   (cost + fees). 95% intervals come from a cluster bootstrap over **games**
   (5,000 resamples, fixed seed), because the rungs of one game — and the
   moneyline, run line and total of one game — are not independent. CLV compares
   the closing mid with the decision mid on the traded side, and with the price
   paid. Forecast skill is Brier and log loss on every matched market with a
   two-sided decision quote, with the paired model-minus-market difference given
   the same cluster bootstrap, plus the in-sample Brier-minimising weight on
   (model − market) as a diagnostic.
6. **Windows.** A: 2026-07-10 – 2026-08-09 (data from Jul 14). B: 2026-08-10 –
   2026-09-16. **Both windows are partly in-sample for the model**: the game
   model's four fitted constants (`HOME_ADJUST`, `WALKOFF_EXACT`,
   `SIGMA_SHARED`, `SIGMA_TEAM_TOTAL`) were fitted by `tools/fit-game-model.mjs`
   on 2,271 completed 2026 games — the whole season to date — so neither window
   is a clean holdout. Neither is `EXPLAINED_TEAM_SD`, which was measured on
   September slates. What the split still buys is a check on stability.

## Pass/fail rule (fixed before any P&L was computed)

A market type shows an edge only if **all** of these hold:

1. ROI is positive and its 95% cluster-bootstrap interval excludes zero, **in
   both windows separately**, under the same rule set and the same decision time;
2. the model's Brier score is no worse than the decision mid's on the same rows
   (point estimate) in **both** windows;
3. it survives at the bot's own 0.07 fee rate, not only at 0.035.

Anything else is **no edge demonstrated**. A positive point estimate whose
interval spans zero is not an edge, and neither is one window out of two.

For the weight question: the data support raising `MARKET_WEIGHT` for a game
market only if the Brier-minimising weight on (model − market) is at or above the
current 0.3 in **both** windows on that market's rows.

## Results (measured)

### Coverage

Pooled window (2026-07-10 .. 2026-09-16, T−120):

| | |
|---|---|
| Kalshi game events in window | 844 |
| markets in window / matched to a replayed game | 20,040 / **19,908** |
| games matched | 837 |
| two-sided decision quote | 16,714 (84%) — `KXMLBGAME` 1,670/1,670, `KXMLBRFI` 820/820, `KXMLBTOTAL` 9,202/10,214, `KXMLBSPREAD` 5,022/7,204 |
| non-binary settlement | 0 |
| settlement vs replayed box score | 1 disagreement in 19,908 (`KXMLBTOTAL-26JUL242215LAASF-14`: Kalshi settled over 13.5 YES and over 14.5 NO, i.e. a total of 14; statsapi has LAA 6 – SF 7 = 13) |

Unmatched: 92 markets on doubleheader dates where the ticker carries no `G1`/`G2`
suffix, so `modelProbability` returns "doubleheader: cannot tell which game"
(`bot/plan.mjs:39`); 25 whose game is not on the replayed slate; 15 `KXMLBRFI`
markets where one starter was not a listed probable, so the model has no NRFI.

**The decision quotes are fresh, not stale.** The age of the quote used at T−120
has a median of 0–1 minutes and a 90th percentile of 0–7 minutes by series, and
**100% of quotes are under 60 minutes old**. Splitting P&L by quote age changes
nothing. The hourly-candle fallback was not, in the end, load-bearing.

### The bot places no game-line bets at all — by arithmetic, not by luck

`bot` and `botOnePerGame` are **empty in every run**: both windows, both decision
times, 837 games, 19,908 markets. This is not a small sample, it is a closed
inequality:

- `bot/plan.mjs:206` drops any market where `|model − mid| > 0.08`.
- `blendedProbability` therefore moves the traded probability at most
  `0.3 × 0.08 = 0.024` off the mid (`MARKET_WEIGHT.game_* = 0.3`,
  `src/lib/constants.js:69`).
- The price paid is the ask, at least 0.5c above the mid, so the edge is at most
  `0.024 − 0.005 = 0.019`.
- The hurdle is `breakEvenEdge(price) + 0.02 = 0.07·p·(1−p) + 0.02`, whose
  minimum over the permitted 15–90c band is `0.0263` (at 90c).

`0.019 < 0.0263` always. Releasing the spread entirely still gives 0.024 < 0.0263.
**No game-line signal can ever clear the bot's own hurdle**, at any price, on any
game, for any model output. The break-even model weight is about **0.40**.

`KXMLBRFI` is also empty, for a different reason: at `MARKET_WEIGHT.nrfi = 0.5`
the arithmetic does permit a trade, but the model's first-inning probability
almost never moves — over 820 markets it spans 47–52% (calibration bins
`47→49 (521)`, `52→50 (298)`), so it never disagrees with the price by 8 points.

Everything below is therefore a **counterfactual**: the same screen at model
weights the bot does not use, and with the cap released. It answers "is there an
edge to be had", not "did the bot make money" — the bot could not have.

### P&L, counterfactual weights, 1 contract per signal, T−120

`cap0.08` keeps the bot's 8-pt implausibility cap; `cap1` releases it (the
`MAX_DISAGREEMENT` clamp of 0.15 inside `blendedProbability` still applies).

| screen | A: Jul 14 – Aug 9 | B: Aug 10 – Sep 16 | pooled |
|---|---|---|---|
| `bot` (w 0.3, cap .08) | n=0 | n=0 | n=0 |
| `every` (w 0.3, no cap/bounds) | n=67, −7.3% [−40.7, 25.3] | n=45, +12.9% [−27.0, 55.4] | n=112, **−0.2% [−26.5, 25.5]** |
| w 0.45, cap .08 | n=3, −15.3% | n=2, +97.8% | n=5, +36.9% [−35.1, 156.2] |
| w 0.6, cap .08 | n=172, +3.4% [−11.5, 18.1] | n=223, −7.3% [−20.6, 6.0] | n=395, −2.4% [−12.8, 7.9] |
| w 0.8, cap .08 | n=326, +2.3% [−10.6, 14.8] | n=450, −7.2% [−18.0, 3.8] | n=776, −3.0% [−11.4, 5.4] |
| w 1.0, cap .08 | n=443, +3.0% [−8.8, 14.2] | n=632, **−10.2% [−19.6, −0.1]** | n=1,075, −4.4% [−12.1, 3.0] |
| w 1.0, cap released | n=517, +0.3% [−11.1, 11.7] | n=727, **−11.5% [−21.8, −0.6]** | n=1,244, −6.2% [−14.0, 1.7] |

**Every sign flips between the windows.** Window A is mildly positive at every
weight; window B is negative at every weight, and significantly so at weight 1.
Pooled, everything is negative but nothing excludes zero. At a 0.035 fee rate ROI
improves by 1.5–2 points in each row and the pattern is unchanged (pooled
w 1.0 cap .08: −2.8% [−10.6, 4.8]).

By market type, at w 1.0 / cap .08 (the largest sample):

| | A | B | pooled |
|---|---|---|---|
| `KXMLBGAME` | n=89, +10.1% [−11.6, 31.4] | n=128, −8.8% [−27.5, 9.9] | n=217, −0.8% [−14.6, 13.4] |
| `KXMLBSPREAD` | n=173, +7.7% [−11.0, 27.1] | n=244, −15.5% [−30.9, 1.0] | n=417, −5.9% [−18.1, 6.6] |
| `KXMLBTOTAL` | n=181, −3.1% [−16.6, 10.8] | n=260, −7.1% [−19.7, 5.7] | n=441, −5.2% [−14.2, 4.1] |
| `KXMLBRFI` | n=0 | n=0 | n=0 |

At T−30 the picture is the same (A w1cap.08 +3.6% [−8.2, 16.1], B −10.4%
[−20.1, −0.5]).

**No market type passes the pass/fail rule.** None is positive with an interval
excluding zero in even one window, let alone both. Moneyline and run line are
positive in A and negative in B; totals are negative in both.

### CLV (measured)

Mean closing-line movement on the traded side is **+0.2c** pooled (between −0.3c
and +0.5c across the rows above) and −0.3c measured against the price actually
paid, which is roughly half the spread. The close moved toward the trade slightly
more often than against it. Consistent with that, the closing quote scores almost
identically to the T−120 quote (pooled Brier 0.1907 vs 0.1909): **game-line
prices barely move in the last two hours, and the model's disagreements carry
almost no information the market later prices in.**

### Forecast skill: model vs market vs blend (measured)

Brier score, lower is better; the difference is paired with a 95% cluster
bootstrap over games. Every matched market with a two-sided decision quote.

Pooled, T−120:

| | n | model | market | blend (w 0.3) | model − market | blend − market | Brier-optimal w |
|---|---|---|---|---|---|---|---|
| all | 16,714 | 0.1929 | **0.1908** | 0.1910 | **+0.0021 [0.0005, 0.0037]** | +0.0001 [−0.0003, 0.0006] | 0.05 |
| `KXMLBGAME` | 1,670 | 0.2434 | **0.2399** | 0.2403 | +0.0035 [−0.0002, 0.0070] | +0.0004 [−0.0007, 0.0014] | 0 |
| `KXMLBSPREAD` | 5,022 | 0.1872 | **0.1858** | 0.1858 | +0.0014 [−0.0005, 0.0033] | +0.0000 [−0.0005, 0.0006] | 0.1 |
| `KXMLBTOTAL` | 9,202 | 0.1820 | **0.1797** | 0.1798 | **+0.0023 [0.0001, 0.0046]** | +0.0002 [−0.0005, 0.0008] | 0.05 |
| `KXMLBRFI` | 820 | 0.2485 | **0.2476** | 0.2478 | +0.0009 [−0.0012, 0.0030] | +0.0002 [−0.0009, 0.0012] | 0.05 |

Per window:

| | A model − market | A opt w | B model − market | B opt w |
|---|---|---|---|---|
| all | +0.0019 [−0.0008, 0.0047] | 0.15 | +0.0022 [0.0003, 0.0040] | 0 |
| `KXMLBGAME` | +0.0009 [−0.0051, 0.0068] | 0.35 | +0.0051 [0.0007, 0.0095] | 0 |
| `KXMLBSPREAD` | +0.0006 [−0.0028, 0.0039] | 0.35 | +0.0020 [−0.0004, 0.0043] | 0 |
| `KXMLBTOTAL` | +0.0028 [−0.0013, 0.0070] | 0.1 | +0.0020 [−0.0005, 0.0044] | 0.05 |
| `KXMLBRFI` | +0.0027 [−0.0008, 0.0066] | 0 | −0.0003 [−0.0029, 0.0022] | 0.7 |

- **The market wins every row**, in both windows, at both decision times. The
  sign is the same in all 20 window-by-series cells but one (`KXMLBRFI` in B, by
  0.0003).
- **But the gap is small.** +0.0021 pooled is a quarter of the pitcher study's
  +0.0090 and a fifth of the batter study's. The game model is close to the
  price; it is just never in front of it.
- **The blend at 0.3 is harmless.** `blend − market` is +0.0001 [−0.0003,
  0.0006] pooled and its interval spans zero in every row. That is genuinely
  different from the prop models, where blending made the forecast significantly
  worse.
- **The Brier-minimising weight never reaches 0.3 in both windows.** It is
  0.15 / 0 overall, 0.35 / 0 on moneyline, 0.35 / 0 on run line, 0.1 / 0.05 on
  totals, 0 / 0.7 on RFI. The two windows disagree wildly on the per-series
  optimum — which is itself the finding: there is no stable weight to fit.
- **The model is well calibrated, just not sharp.** Pooled bins:
  `16→19, 25→25, 35→35, 45→45, 54→55, 65→66, 75→75, 86→86, 95→94`.
- **Model and market are close.** Median |model − market| is **2.7 pts**, 90th
  percentile 8.0 pts. (Props: 4.3 and 13.7.) The 8-pt cap therefore bites at
  about the 90th percentile of disagreements.

## Interpretation (inferred)

- **The game model has no measurable edge against Kalshi.** It fails the
  pass/fail rule on all four markets. The ROI sign flips between windows on every
  market type, which is the signature of noise, and the model's forecast is worse
  than the price in essentially every slice.
- **It is, however, a much better model than the prop models.** Its Brier gap to
  the market is a quarter of theirs, it is well calibrated across the whole
  probability range, and blending it in at 0.3 does not damage the forecast. The
  honest reading is "as good as the market to within measurement error, and never
  better", not "noise".
- **`MARKET_WEIGHT` 0.3 for game lines is not supported as a trading weight, and
  0 is what the data prefer.** Pooled, the Brier-optimal weight is 0.05. Window A
  likes 0.35 on moneyline and run line, window B likes 0; nothing survives both.
  As a *display* weight 0.3 costs nothing measurable (blend − market ≈ 0), so
  there is no reason to change it for the board — but raising it to make the bot
  able to trade would be fitting to window A.
- **Raising the weight to unlock trades would have lost money.** Weight 0.4+ is
  what it takes to make any game-line trade possible; at weight 1.0 with the cap,
  window B lost 10.2% [−19.6, −0.1] on 632 trades. The current configuration's
  inability to trade is, on this evidence, worth money.
- **NRFI is untested rather than disproven.** The model's first-inning
  probability spans only 47–52%, so it never disagrees with Kalshi enough to
  trade under any of the bot's rules. Its Brier is indistinguishable from the
  price's (+0.0009 [−0.0012, 0.0030] on 820 markets). It is a fair forecast with
  no opinion.
- **Window A being the better window is not out-of-sample evidence**: both
  windows are inside the game model's fit. If anything the direction is the
  opposite — the later window, closer to where `EXPLAINED_TEAM_SD` was measured,
  is the worse one.

## Findings in the bot and model code

1. **The bot cannot trade a game line, and nothing says so (measured +
   derived).** The combination of `MARKET_WEIGHT.game_* = 0.3`
   (`src/lib/constants.js:69-71`), `IMPLAUSIBLE.game = 0.08`
   (`bot/plan.mjs:25`), `minEdgeAfterFees: 0.02` (`bot/config.example.json`) and
   `FEE_RATE = 0.07` (`src/trade/fees.js:38`) makes the maximum achievable edge
   0.019 against a minimum hurdle of 0.0263. Evidence: 0 trades across 19,908
   markets and 837 games, plus the closed inequality above.
   `config.markets.gameLines: true` is therefore dead config. This study says the
   dead config is *helping*, so the fix is to say so, not to loosen it.
2. **The board and the bot disagree about game lines (measured).**
   `PLAY_RULES.gameLinesInformationOnly` is `true` (`src/lib/constants.js:47`)
   and the board stamps every game-line row "information only"
   (`src/data/teamMarkets.js:263`). `bot/plan.mjs` never reads `PLAY_RULES`; it
   gates only on `config.markets.gameLines`, which the example config sets to
   `true`. The two are consistent only by the accident of finding 1.
3. **Doubleheaders lose 92 markets in this window (measured).** Kalshi does not
   always add the `G1`/`G2` suffix, and `bot/plan.mjs:39` refuses any same-day
   pair of the same teams outright. `parseKalshiGameTicker` now handles the
   suffix (v36); the remaining loss is the unsuffixed case. It fails safe.
4. **The maker fee is wrong for three of these four series (inferred).**
   `src/trade/fees.js:30` states "Maker and taker pay the same".
   `GET /series/…` reports `fee_type: "quadratic"` with `fee_multiplier: 0.5` for
   `KXMLBSPREAD`, `KXMLBTOTAL` and `KXMLBRFI`, and `quadratic_with_maker_fees`
   with `fee_multiplier: 0.5` for `KXMLBGAME`. On a plain `quadratic` series
   makers are not charged at all, so `makerAlternative()`
   (`src/trade/signals.js`) understates a resting order's EV by the full taker
   fee on the run line, the total and RFI. Not verified against a real fill.
5. **`KXMLBRFI` is not mapped anywhere (measured).** The model produces
   `nrfi`/`yrfi` for every game with two probables, Kalshi lists exactly that
   market one-per-game, and it appears in neither `KNOWN_SERIES`
   (`src/lib/kalshi.js:88`) nor `GAME_SERIES` (`bot/plan.mjs:20`), so the bot
   cannot see it. On this evidence there is nothing to gain from adding it, but
   the gap is real.
6. **`bot/plan.mjs`'s ladder rule is per series, not per game (measured).**
   `groupKey()` returns `${market.series}:${gamePk}`, so the moneyline, the run
   line and the total of the same game are three separate "ladders" and can all
   be taken. They are close to one bet. Only `maxGameExposureDollars` ($10
   against `maxOrderDollars` $5) limits it, and only in dollars. The
   `botOnePerGame` set in this study exists to measure that, and is empty for the
   same reason as `bot`.
7. **`tools/backtest-common.mjs:44` drops `hitByPitch` from the pitcher season
   aggregation.** Harmless for `projectPitcher`, which never reads it, but the
   game model's FIP numerator does (`3 × (BB + HBP)`), so
   `tools/backtest-games.mjs` rebuilds the starter's season line itself. Worth a
   comment there if that helper grows another consumer.

## Caveats

- **Both windows are in-sample for the model.** `HOME_ADJUST`, `WALKOFF_EXACT`,
  `SIGMA_SHARED` and `SIGMA_TEAM_TOTAL` were fitted on the whole 2026 season to
  date, and `EXPLAINED_TEAM_SD` was measured on September slates. Neither window
  is a holdout, so the split tests stability, not generalisation.
- **A 40-game debug run was looked at while the tool was being written**, before
  the Method and Pass/fail sections were committed. It showed `bot` empty and a
  handful of `every` trades. Nothing was changed because of it; the
  counterfactual weight grid was added because `bot` was empty, which is a fact
  about the arithmetic, not about the P&L.
- **No weather.** `projectGame` is run with `wx: null`, so `weatherFactor()` is
  1. The live board feeds it a forecast.
- **Posted lineups are the cards that actually took the field.** statsapi reports
  them after the fact, so a lineup posted after T−120 is visible to the replay
  and would not have been to the bot. They change almost nothing (home win
  52.98% with, 53.07% without), so this is a small optimism.
- **Only actual starters.** 832 of 847 games have both starters replayed; the
  other 15 fall back to a league-average starter, and `KXMLBRFI` is skipped
  entirely for them.
- **Fills are idealised.** 1-contract taker fills at the quoted top of book;
  depth, queue position and latency are ignored, which favours the model.
- **Two decision times only**, T−120 and T−30. The live bot runs at fixed clock
  times and re-checks.
- **Order-count, daily-spend and Kelly sizing limits are not simulated.**
- **One settlement disagreement** out of 19,908 markets is unexplained (see
  Coverage). It is too small to matter here, but it is not zero, unlike the
  pitcher study.

## Reproduce

```
node tools/backtest-games.mjs --from 2026-07-14 --to 2026-09-16 \
  --cache C:/Users/qrob1/mlbwork/bt-cache --lineups

node tools/backtest-kalshi-games.mjs --from 2026-08-10 --to 2026-09-16 \
  --cache C:/Users/qrob1/mlbwork/bt-cache --kcache C:/Users/qrob1/mlbwork/kalshi-cache \
  --lineups [--decision-min 30] [--json out.json]
```
