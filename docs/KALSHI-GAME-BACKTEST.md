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

_Filled in after the runs below; nothing above this line was edited afterwards._

## Reproduce

```
node tools/backtest-games.mjs --from 2026-07-14 --to 2026-09-16 \
  --cache C:/Users/qrob1/mlbwork/bt-cache --lineups

node tools/backtest-kalshi-games.mjs --from 2026-08-10 --to 2026-09-16 \
  --cache C:/Users/qrob1/mlbwork/bt-cache --kcache C:/Users/qrob1/mlbwork/kalshi-cache \
  --lineups [--decision-min 30] [--json out.json]
```
