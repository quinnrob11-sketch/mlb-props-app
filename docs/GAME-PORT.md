# Porting the improved game model, and measuring what survived the port

`docs/GAME-EDGE-SEARCH.md` rebuilt the game model's per-game inputs, measured
them once on an untouched holdout, and reported a **FAIL** against the price —
the model came level with the exchange, not in front of it. That verdict is
unchanged and nothing here reopens it.

What that study also found was a real, significant improvement over the model
the board actually ships: paired on identical markets, the new inputs forecast
better by **0.0025 of Brier pooled [−0.0045, −0.0005]**, 0.0036 on totals and
0.0052 on the first inning. It could not ship them, because three of the terms
need inputs `src/data/loadSlate.js` did not fetch and that file was out of
scope. This is that port, and the measurement of it.

**Two questions are answered here, and they have different answers.**

1. Does the ported `src/model/game.js` reproduce the study's number? **Yes,
   to the fourth decimal.**
2. Will the live board actually get that? **Most of it: −0.0021 [−0.0041,
   −0.0003] using only what was knowable at the decision time.** About a fifth
   of the headline gain was hindsight.

## What was ported

`GAME_INPUTS` in `src/model/game.js` is the `core` configuration of the study,
coefficient for coefficient, refitted here from scratch to check it:

```
node tools/game-features.mjs --season 2025 --cache .backtest-cache --out .backtest-cache/features_2025.json
node tools/game-features.mjs --season 2026 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/features_2026.json
node tools/fit-game-v2.mjs --config core --no-score \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/params-core.json
```

reproduced every fitted value the study reported — `parkExp` 1.5, `spKPriorBF`
10, `spHrPriorBF` 4000, `tempCoef` 0.004, `windCoef` 0.004, `top4Exp` 0,
`spFirstInningExp` 1.4, `offPriorSeasonGames` 30, and `explainedTeamSd` 0.1310.

| term | before | after |
|---|---|---|
| team offence | 25 games of league-average shrink | 70 games of league average **plus 30 games of last season**, at last season's own league level, exponent 0.9 |
| starting pitcher | one ERA/FIP lump shrunk by 60 innings | **K, BB+HBP and HR per batter faced regressed separately** (10 / 400 / 4,000 BF of prior) against a 60-innings ERA, plus **+2%/day of rest above five** |
| the posted card | nine, OPS^1.7, clamped ±10% | nine, OPS^1.7, clamped **±5%**; the **top four** carried separately for the first inning, at a fitted exponent of **0** |
| the first inning | an average inning with its own league mean | the starter's index raised to **1.4**, and a 1.03 level correction |
| park | factor damped to 0.7 | factor at **1.5** — the park wants to be stronger, not weaker |
| weather | temperature only, 2.5%/10°F | temperature at **4%/10°F**, and **wind signed by direction**, 0.4%/mph |

### Two things were deliberately NOT ported

- **`MARKET_WEIGHT` and `PLAY_RULES` are untouched.** The in-sample
  Brier-optimal weight on (model − market) rose from near zero to 0.55 pooled
  once the new inputs were in. Acting on that is exactly the overfitting this
  whole programme exists to prevent: the model is *level* with the price, and
  level is not a reason to bet into it. Game lines stay information only. With
  the ported model and the shipped weights, `planOrders` screened **0
  contracts** on all 273 holdout games, and the hand-written screen agreed with
  `planOrders` on 272 of 272 games with **0 disagreements** — exactly as
  before.
- **The four structural constants.** The study refitted `HOME_ADJUST`,
  `WALKOFF_EXACT` and the two sigmas on its FIT window alone, on purpose, so
  the holdout could not appear in them (0.984 / 0.65 / 0 / 0.27 against the
  shipped 0.988 / 0.50 / 0 / 0.24). For shipping, the whole-2026 fit is the
  better estimate for the season the board serves, and it is what
  `test/gameFit.test.js` pins to the measured league rates — the study's
  constants miss that test's tolerance on the run line (−0.0078 against a
  0.006 tolerance) and on one-run home wins. They stayed put.

  `EXPLAINED_TEAM_SD` **did** move, 0.12 → 0.131, because it is not a free
  constant: it is defined as the spread of the model's own projections, the
  new model spreads more, and leaving it would have integrated a tenth of the
  spread twice.

Everything below the inputs — the 31×31 convolution, walk-offs, the skipped
ninth, ghost-runner extras, the Gauss-Hermite mixture, the market readers — is
untouched, and `test/game.test.js` still checks it against the measured league
rates.

## What `loadSlate` now fetches, and what happens when it cannot

Three new inputs, and **not one new round trip** on the critical path:

| input | where it comes from | cost |
|---|---|---|
| last season's team offence | one more `teams/stats?season=PRIOR_SEASON&group=hitting` in the wave that already runs | one request, in parallel with three others |
| the posted card's **top four** | the cards already in hand | none |
| wind **direction** | `weather` added to the schedule hydrate that was already being requested | none |
| league starter rates per batter faced | the `sp` split payload already being fetched for the bullpen | none |
| the starter's days of rest | the game log already being fetched for his workload | none |

Degradation is per term, and every one of them falls back to **exactly what
v36 did**, never to a guess:

| missing | what the model does |
|---|---|
| last season's line, or last season's league rate | last season is treated as league average **carrying the same 30-game weight**, so the team is still regressed by the full 100 games rather than silently by 70 |
| the posted card | the lineup term is 1, as before. The app substitutes a projected card first (`projectedLineup.js`), which is what it already did |
| the top four | the nine's ratio, and the fitted exponent on it is 0 anyway |
| wind direction, or a wind across the field | **the wind term is 1.** An unsigned speed is not weak information, it is none: blowing in is worth the opposite of blowing out |
| temperature | no temperature term |
| `battersFaced` on a starter's line, or the league per-BF rates | the v36 whole-line ERA/FIP regression, `runsAllowedTalent` |
| the starter's last outing | rest is read as the neutral five |

`test/game.test.js` pins each of these ("every new input is optional…", "wind
only counts once it is signed…", "a missing prior season is league average,
not a free pass out of the shrink", "the component starter regression needs
batters faced…").

**The wind direction will usually be missing, and that is the honest number to
plan around.** MLB fills `weather` in about an hour before first pitch; on a
16-game board loaded at midday, 2 games had a direction and 14 did not.
Open-Meteo, which supplies the forecast for every game hours ahead, reports a
wind bearing but not the park's orientation, so its speed cannot be signed
without a stadium-orientation table this repo does not have and this branch
would have had to invent. Where MLB has a reading, all three of its numbers are
taken together — mixing a forecast temperature with an observed direction would
be neither measurement.

## The reproduction check (measured)

Holdout **2026-09-02 .. 2026-09-22**, the same window, the same replay, the
same real Kalshi prices at T−120, the same cluster bootstrap over games with
5,000 resamples. 273 games, 6,829 markets, 5,675 with a two-sided decision
quote. The control is the **frozen v36 model** (`tools/game-model-v1.mjs`) —
frozen because once the port landed, the study's control was calling the file
it had just changed and would have measured the new model against itself.

```
node tools/backtest-kalshi-games.mjs --v2 --src \
  --params .backtest-cache/params-core.json \
  --features .backtest-cache/features_2026.json --features .backtest-cache/features_2025.json \
  --from 2026-09-02 --to 2026-09-22 --cache .backtest-cache --kcache .kalshi-cache \
  --json .backtest-cache/port-srcposted.json
node tools/port-table.mjs .backtest-cache/port-*.json
```

### Leg 1: does the port reproduce the study?

Paired Brier, **ported model − frozen v36**, on identical markets. Negative
means the ported inputs forecast better.

| market | n | the study's candidate | **the ported `src/model/game.js`** | as published |
|---|---|---|---|---|
| **pooled** | 5,675 | −0.0026 [−0.0047, −0.0006] | **−0.0026 [−0.0047, −0.0005]** | −0.0025 [−0.0045, −0.0005] |
| `KXMLBGAME` | 544 | −0.0012 [−0.0039, +0.0015] | −0.0014 [−0.0039, +0.0012] | −0.0010 [−0.0037, +0.0017] |
| `KXMLBSPREAD` | 1,632 | −0.0004 [−0.0021, +0.0012] | −0.0004 [−0.0019, +0.0012] | −0.0002 [−0.0019, +0.0013] |
| `KXMLBTOTAL` | 2,991 | −0.0037 [−0.0069, −0.0006] | **−0.0036 [−0.0069, −0.0004]** | −0.0036 [−0.0068, −0.0005] |
| `KXMLBRFI` | 508 | −0.0048 [−0.0082, −0.0014] | **−0.0050 [−0.0085, −0.0014]** | −0.0052 [−0.0087, −0.0017] |

**The port reproduces the measured improvement.** Every point estimate is
within 0.0004 of the published one, and pooled, totals and the first inning all
still exclude zero. (The small differences against the published column are a
rebuilt feature table and 5,675 priced markets against 5,649, not a
disagreement: the study's own candidate, rerun here, moves by the same amount.)

Against the price, the ported model reads **−0.0001 [−0.0023, +0.0021]**
pooled, where the frozen v36 model reads +0.0025 [+0.0000, +0.0052]. Level,
exactly as the study concluded. **The FAIL stands.**

### Leg 2: what will the board actually get?

The study's feature table sees the card that **took the field** and the weather
**recorded at first pitch**. The live board sees whatever is posted at load
time — often a projected card — and a forecast with no direction. So the same
holdout was rerun through the same ported code with only decision-time
information: the team's most recent previously-posted card wherever tonight's
had not appeared, and an Open-Meteo hourly forecast for the first-pitch hour,
temperature and speed only (`tools/game-features-asof.mjs`; a previous card was
available for 548 of 548 sides and a forecast for 274 of 274 games).

Paired Brier against frozen v36, pooled and per market:

| inputs | pooled | `KXMLBGAME` | `KXMLBSPREAD` | `KXMLBTOTAL` | `KXMLBRFI` |
|---|---|---|---|---|---|
| posted card + recorded weather (the study) | **−0.0026 [−0.0047, −0.0005]** | −0.0014 | −0.0004 | **−0.0036 [−0.0069, −0.0004]** | **−0.0050 [−0.0085, −0.0014]** |
| **decision-time: projected card + forecast** | **−0.0021 [−0.0041, −0.0003]** | −0.0014 | −0.0003 | −0.0029 [−0.0060, +0.0000] | **−0.0045 [−0.0078, −0.0010]** |
| never tonight's card, forecast | −0.0020 [−0.0042, +0.0001] | −0.0013 | −0.0008 | −0.0024 [−0.0057, +0.0007] | **−0.0045 [−0.0078, −0.0010]** |
| no card at all, forecast | −0.0020 [−0.0043, +0.0003] | −0.0013 | −0.0005 | −0.0024 [−0.0059, +0.0010] | **−0.0045 [−0.0078, −0.0010]** |

**It does not collapse.** The decision-time gain is −0.0021 and its interval
still excludes zero; hindsight was worth about **0.0005 of Brier**, a fifth of
the headline. Read the rest of the table before deciding what the lineup and
weather fetches bought:

- **The first inning is entirely unaffected by either hindsight**: −0.0045 in
  every degraded row, against −0.0050 with the study's inputs, and the interval
  excludes zero in all of them. That is because the fitted exponent on the top
  four is **zero** — the first inning turned out to be about the arm, not the
  bats — so the card never mattered to `KXMLBRFI` at all.
- **Totals carry all of the loss.** −0.0036 with hindsight, −0.0029 at decision
  time, −0.0024 with no card at all, and the interval touches zero at each
  step. The lineup and weather terms are worth roughly 0.0012 of totals Brier,
  about half of it recoverable from a projected card.
- **The lineup fetch is worth about a third of what it looked worth**
  (−0.0029 against −0.0024 on totals is the projected card's contribution),
  and it costs no request at all. The top-four fetch is worth nothing at the
  fitted exponent and costs nothing; it is kept so the zero stays visible.
- **The weather fetch is the marginal one.** Wind direction reaches maybe an
  eighth of a midday board, and the difference between the row that never sees
  tonight's card (−0.0020) and the study row is mostly lineup, not weather.
  Temperature — which the board already had — is the large half of the weather
  term and is unaffected.

The `NRFI` spread is the single clearest change and it survives the
degradation: across the 255 holdout games with two probables, the model's NRFI
standard deviation is **3.52 points** (3.49 at decision time) against the
frozen v36 model's **2.91**, and the range widens from 43.1–60.2% to
37.5–58.0%. The shipped model barely had an opinion about the first inning; the
ported one does.

The counterfactual screens tell the same story they told before and are still
not evidence of anything: at w 0.6 with the 8-point cap the ported model's 110
trades return −1.0% [−18.6, +16.8], the study's 104 return −0.0% [−17.8,
+18.0], and the decision-time variant's 111 return −10.0% [−28.7, +8.7]. All
three intervals are about 35 points wide. **The bot placed none of them**, and
will not.

## League-aggregate calibration: nothing moved that should not have

`npm test` passes, 221 of 221 (213 before, 8 added for the port). The
calibration tests were not touched or loosened.

`test/game.test.js` and `test/gameFit.test.js` both check two league-average
teams against the measured 2026 rates, and both are **unaffected by this
change**: they build the scoring arrays directly from `AWAY_HALF_MEANS`,
`HOME_HALF_MEANS` and the four structural constants, none of which moved. Home
win 52.94% vs 52.88% actual, NRFI 50.12% vs 49.54%, home −1.5 36.04% vs 36.02%,
over 8.5 49.65% vs 49.10% — the same numbers as before the port, to the digit.

On the 273 holdout games — which is a harder test, because the model has to hit
the rates with real teams in real parks:

| | frozen v36 | ported | actual | who is closer |
|---|---|---|---|---|
| home win | 53.21% | 53.31% | 53.85% | ported, barely |
| NRFI | 51.10% | 48.92% | 45.49% | **ported, by 2.2 points** |
| over 8.5 | 47.36% | 50.27% | 54.21% | **ported, by 2.9 points** |
| home −1.5 | 35.99% | 36.48% | 35.53% | v36, by 0.5 points |

Three of the four move *toward* what happened, two of them by a lot. The run
line moves half a point away, and it is the market whose paired Brier gain is
smallest (−0.0004, interval spanning zero) — consistent with each other, and
consistent with keeping `WALKOFF_EXACT` at the shipped 0.50 rather than the
study's 0.65, which is the constant the run line is most sensitive to. The
window itself ran hot: five points more overs and four points fewer scoreless
first innings than either the model or the market expected, which is why both
models sit on the same side of the total and of NRFI.

## Caveats

- **The holdout is the same 21 days the study used.** It has been looked at
  twice now — once by the study, once by this port — so it is no longer a
  virgin window. Nothing here chose a parameter on it; the port is the
  study's own frozen configuration and the only decision taken after seeing
  holdout numbers was to keep the shipped structural constants, which was
  forced by a pre-existing test.
- **`EXPLAINED_TEAM_SD` is 0.131, measured on the FIT window.** On the holdout
  the ported model's own projection spread is 0.1239, and on a live September
  slate 0.115 — so the residual sigma is very slightly over-subtracted. The
  effect is fourth-decimal and the number was not retuned to the holdout on
  purpose.
- **The decision-time lineup is a stand-in, not a replay of the live
  projector.** It is the team's most recent previously-posted card with every
  batter's line as of the game date, which is the same idea as
  `src/data/projectedLineup.js` but not the same code. The real projector
  weights several recent orders; this takes the last one, so the decision-time
  row is, if anything, slightly pessimistic about the lineup term.
- **The decision-time weather is Open-Meteo's archived hourly value for the
  first-pitch hour**, not a forecast issued two hours out, so its temperature
  is slightly better than a real forecast's. Temperature error at two hours is
  a degree or two and the coefficient is 0.4%/°F, so this is small; the part
  that matters — no direction — is exact.
- **Everything about the price verdict is unchanged.** The model is level with
  the exchange, no market passed either leg of the pre-registered bar, and the
  bot still cannot place any of these bets. Shipping a better displayed number
  is not a licence to trade it.
