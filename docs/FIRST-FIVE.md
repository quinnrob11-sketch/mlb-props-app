# First five innings

The board now prices the three first-five-innings markets — total, moneyline
and run line — beside the full-game lines they came from.

**The hypothesis this was built to test: the model should be relatively better
at F5 than at the whole game.** F5 is the part the STARTING PITCHER decides,
and the starter is the model's strongest component; it cuts out the bullpen,
which `docs/GAME-EDGE-SEARCH.md` measured as carrying no transferable signal
(bullpen availability fitted to zero — the median team already has 93.7% of its
relief innings in available arms).

**The answer, measured on 4,213 games: no.** Paired at the coin-flip line of
each market, on the same games, F5 is worth **+0.15, +0.05 and −0.04 points of
Brier skill** against the full game, and every interval straddles zero. The
starter really does decide the first five, but the model does not turn that
into a better forecast than it already makes over nine.

**What DID improve is calibration.** F5 is better calibrated than the full game
on the total (ECE 0.63 vs 0.77 points) and much better on the run line (0.65 vs
1.31), and its point projection is nearly unbiased (−0.009 runs against −0.053).
That is a cleaner number on the board, not a reason to bet — F5 rows are
information only under `PLAY_RULES.gameLinesInformationOnly`, exactly like the
full-game lines. `MARKET_WEIGHT`, `PLAY_RULES` and the hurdle are untouched.

---

## The model

Nothing new is fitted. `src/model/game.js` already computes the score
inning by inning: `AWAY_HALF_MEANS` and `HOME_HALF_MEANS` are per-half-inning
rates and `finalScoreGrid` convolves them. `firstFiveGrid` is the same
convolution stopped after five, and it is **simpler** than the full game,
because none of the awkward parts apply:

- both teams always bat five times, so there is no skipped home half;
- no walk-off, so no truncation at a one-run margin;
- no ghost-runner extras.

It runs through the same `uncertainScoreGrid` as the full game — the same
`SIGMA_TEAM` game-level uncertainty, the same nine grids — so the F5 numbers
can never contradict the full-game ones. It also costs less than the full game
does (ten half-innings against thirty-three).

### The tie, and the book convention

**A tie after five is a real outcome, not a push.** It happens in **15.5%** of
games (4,761 nine-inning games, 2025 and 2026 through 2026-09-22; the model
says 15.3% for two average teams). `firstFiveMarkets` returns `pHome`, `pAway`
and `pTie` explicitly and they sum to one — the tie is never silently folded
into a push.

What is handed to the pricing path is `{ home, away, push: tie }`, which
`noPush` reads as **P(home leads after five | the first five are not level)**.
That is the right comparison against either convention a book uses:

| convention | who posts it | why the same number is right |
|---|---|---|
| **three-way** (home / away / draw; a tie loses both sides) | DraftKings, FanDuel, Pinnacle | de-vigging the two TEAM prices against each other gives exactly `p_home / (p_home + p_away)` — the draw price drops out of the ratio, so market and model are both conditional on no tie |
| **draw-no-bet** (a tie refunds) | some books, and every exchange ladder | a tie IS a push, and the same two-sided de-vig is already correct |

`parseGameOdds` therefore reads the two team outcomes and deliberately ignores
a `Draw` outcome when the feed carries one.

**What this does not do is settle a three-way ticket.** On a three-way price a
tie loses, so the EV the edge engine computes off one is optimistic by the tie
probability. The tie is recorded on the row as `push` so it is visible, and it
is one more reason these rows are information only.

Settlement (`src/data/gradeSlate.js`) reads the first five entries of the
linescore: five complete innings settle, anything short of that voids, and a
level game pushes the F5 moneyline.

---

## What it costs

The game-lines call is one request for the whole slate, billed at
markets × region-equivalents. The pinned book set is 10 keys = one
region-equivalent, so it is **one credit per market**:

```
before   h2h,spreads,totals                                    3 credits
after    + h2h_1st_5_innings,spreads_1st_5_innings,
           totals_1st_5_innings                                6 credits
```

**Six credits per refresh, up from three.** The prop feed (roughly 20 credits
per game) is untouched, so this is a small addition to the daily burn, but it
is a doubling of the game-lines line item and the key is finite.

### If the feed does not serve these markets

**This could not be tested from the branch.** The allowlist in `api/odds.js`
rejects an unknown market before it reaches the upstream, so the three keys
cannot be exercised until the proxy change is deployed, and The Odds API is
metered and was not called.

The failure is designed to be silent and total:

- The Odds API omits a market a plan does not carry rather than erroring, so
  the response is the old three markets and the request still costs 6.
- `parseGameOdds` iterates the markets the response actually contains. No F5
  market means the `f5_*` buckets stay empty arrays.
- `priceTeamMarkets` skips a market with no quotes, so no F5 row is produced.
- `GamesBoard` renders a "no line" row for a market with no row, which is what
  it already does for a full-game line no book has posted.

So the board degrades to exactly what it shows today, with no error and no
broken row. The test `a feed that serves no F5 markets shows nothing rather
than erroring` in `test/firstFive.test.js` pins that path. Kalshi lists no F5
series at all, so those buckets are always empty and F5 is priced off
sportsbooks alone or not at all.

---

## Calibration against outcomes

Replay: `tools/backtest-games-v2.mjs --src` — the shipped `src/model/game.js`
fed from `tools/game-features.mjs`, posted card and recorded first-pitch
weather — extracted by `tools/accuracy-extract.mjs` and scored by
`tools/accuracy-report.mjs --f5`, exactly as `docs/ACCURACY.md` scores the full
game. Main window: **4,213 games**, 2025 and 2026 through 2026-09-01, holdout
2026-09-02..09-22 reported separately.

The F5 outcome is directly computable: the MLB linescore gives runs per inning,
so `tools/game-features.mjs` now records `f5Away` and `f5Home` for every game.
All 4,761 nine-inning games in the two seasons reached five innings.

### League level, two average teams in a neutral park

Nothing here is fitted — it is the full game's own fitted rates convolved five
times instead of nine.

| | model | actual |
|---|---|---|
| away runs in five | 2.383 | 2.385 |
| home runs in five | 2.599 | 2.623 |
| total in five | 4.982 | 5.007 |
| home leads after five | 44.98% | 45.33% |
| away leads after five | 39.72% | 39.15% |
| **level after five** | **15.30%** | **15.52%** |
| over 3.5 | 62.18% | 62.51% |
| over 4.5 | 49.35% | 49.91% |
| over 5.5 | 37.79% | 38.40% |
| over 6.5 | 28.03% | 28.92% |
| home −0.5 | 44.98% | 45.33% |
| home −1.5 | 31.85% | 32.81% |

The model runs about half a point low on every over and a point low on home
−1.5: the five-inning distribution is very slightly too narrow, which is the
same signature the full game carries (`HOME_ADJUST`'s note records a one-point
excess of level games after nine). `test/firstFive.test.js` pins all twelve
rows, the way `test/gameFit.test.js` pins the full-game ones.

### Per game

| market | ECE | gap | Brier skill | corr | bias (runs) | n |
|---|---|---|---|---|---|---|
| moneyline | 0.62 | −0.2 | 1.8% | — | — | 4,213 |
| run line | 1.31 | +0.4 | 9.5% | 0.157 | −0.004 | 8,426 |
| total | 0.77 | +0.4 | 8.0% | 0.194 | −0.053 | 21,065 |
| **F5 moneyline** | 1.00 | −0.7 | 2.0% | — | — | 3,552 |
| **F5 run line** | **0.65** | −0.6 | 10.9% | 0.156 | +0.018 | 16,852 |
| **F5 total** | **0.63** | −0.6 | 8.4% | 0.173 | **−0.009** | 16,852 |
| F5 level after five | 0.40 | −0.4 | 0.3% | — | — | 4,213 |

ECE and gap in probability points. The F5 moneyline is scored on the 3,552
games that were **not** level after five, which is how its number is defined
and how a push-settled ticket is graded; the tie is scored on its own row
rather than dropped.

At the lines books actually post:

```
F5 total   3.5: 62.0->62.8   4.5: 49.4->50.1   5.5: 38.0->38.2   6.5: 28.4->28.9
F5 line    -0.5: 45.0->45.3  +0.5: 60.3->61.0  -1.5: 31.9->32.7  +1.5: 72.7->73.2
F5 ML      home leads: 53.1->53.8
F5 tie     level: 15.3->15.7
```

Every rung is inside a point of the truth, and every one of them is low by the
same small amount — a level error, not a shape error.

### Is the model better at F5 than at the full game?

**No — it is indistinguishable, and the "better" numbers in the table above are
not a fair comparison.** Pooled Brier skill is computed against the pooled base
rate of a ladder, and the two ladders have different lengths and different base
rates; correlation is depressed by outcome noise, and five innings is a noisier
target than nine relative to its own mean (sd/mean 65.6% against 51.0%), which
is the whole reason the F5 correlation (0.173) sits below the full game's
(0.194) while the calibration is better.

The like-for-like test is one line per market per game, at the line each market
is actually hung at, on the same games, scored as skill against each market's
own base rate, with a cluster bootstrap over games on the difference:

| paired at | full game | first five | F5 minus full | 95% |
|---|---|---|---|---|
| total — over 8.5 / over 4.5 | 2.17% | 2.32% | **+0.15 pts** | [−0.75, +0.93] |
| run line — −1.5 / −0.5 | 1.26% | 1.31% | **+0.05 pts** | [−0.61, +0.79] |
| moneyline — home win / home leads | 1.99% | 1.95% | **−0.04 pts** | [−0.85, +0.69] |

(The bootstrap is unseeded, so a re-run moves each interval by a few
hundredths of a point. The point estimates are exact.)

Three near-zero differences, three intervals containing zero. On 4,213 games
the experiment can rule out anything larger than about a point of skill in
either direction, and there is no sign of the gain the bullpen argument
predicts.

What is real, and is not nothing:

- **The F5 total is nearly unbiased** (−0.009 runs against −0.053 for the full
  game) and better calibrated (ECE 0.63 against 0.77).
- **The F5 run line's calibration is half the full game's** (0.65 against 1.31
  points). The full-game run line has to get walk-offs and the skipped ninth
  right; the F5 run line has neither to get wrong.
- **The model separates F5 games relatively more than full games** — sd of the
  projected total is 11.8% of its mean over five innings against 10.0% over
  nine, with the slope of actual on projected at 0.97 and 0.98, so that extra
  separation is justified. It simply does not convert into more skill at the
  line the book hangs.
- **The tie is not forecastable.** P(level after five) has an sd of 1.5 points
  across a season and 0.3% of Brier skill. The model knows the league rate and
  essentially nothing else about it — which matters, because a three-way F5
  moneyline is priced on exactly that number.

### Holdout (273 games, 2026-09-02..09-22)

F5 total ECE 1.20 against the full total's 4.23; F5 run line 3.21 against 2.48;
F5 moneyline 4.17 against 6.10. The same seven branches that have read these
three weeks have read them again, and 273 games says very little either way —
it is reported for stability, not confirmation.

---

## Reproduce

```
node tools/game-features.mjs --season 2025 --cache .backtest-cache --out .backtest-cache/features_2025.json
node tools/game-features.mjs --season 2026 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/features_2026.json
node tools/fit-game-v2.mjs --config core --no-score \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/params-core.json
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --params .backtest-cache/params-core.json \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/acc_g_all.ndjson
node tools/accuracy-report.mjs .backtest-cache/acc_g_all.ndjson --f5 --holdout 2026-09-02
```

Public MLB Stats API only; The Odds API was never called.

## Caveats

- **The live feed is unverified.** See "If the feed does not serve these
  markets" above. Everything else here is measured; that one thing cannot be
  until the proxy is deployed.
- **The replay's lineup is the card that took the field and its weather is
  what was recorded at first pitch**, the same optimism `docs/ACCURACY.md`
  declares for the full game. `docs/ACCURACY.md` also measured the posted card
  as worth nothing to the game lines, so the F5 numbers are unlikely to move
  much on a projected card.
- **These rows are not bets.** The measurement says the model is no better at
  F5 than at the full game, and the full game is already information only
  because it is noisier than the market. Nothing here changes that, and nothing
  here touched `MARKET_WEIGHT`, `PLAY_RULES` or the hurdle.
