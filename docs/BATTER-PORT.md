# Porting the rebuilt batter model into the board

`docs/BATTER-EDGE-SEARCH.md` rebuilt the batter model on a pre-registered
FIT / VALIDATE / HOLDOUT split and answered the question it asked: **the
rebuilt model does not beat the Kalshi price.** It failed both legs of the bar
in all six series, and that verdict is unchanged by anything here.

It also answered a second question in passing. The rebuilt model is a better
forecaster than the one that ships, out of sample, in every series — pooled by
0.0003 of Brier — and it left that improvement sitting in a JSON file that
nothing reads (`tools/batter-rebuilt.json`).

This commit moves it into `src/model/batter.js`, so the board shows the better
numbers. It changes **no** trading constant: `MARKET_WEIGHT`, `PLAY_RULES` and
the hurdle are untouched, because a model that still loses to the price is not
a reason to bet more, and `src/lib/constants.js` already says to raise
`MARKET_WEIGHT` only on closing-line value from graded results.

---

## What was ported

| # | change | where |
|---|---|---|
| **P1** | **The platoon multiplier is deleted.** Not set to zero — removed, with the measurement written where it used to be. | `batter.js` section 3, and its four call sites (HR, non-HR hits, strikeouts, runs/RBI) |
| **P2** | **Runs, RBI and H+R+RBI come from one plate-appearance outcome distribution** instead of three marginals glued together by a variance constant. | `jointScoring: true`, `scoreSpread: 0.6`, section 11b |
| **P3** | **Every prior strength re-fitted**, with the four levels that were fitted beside them. | `priorStrength`, `hrPriorStrength`, `powerShare`, `runLevel`, `rbiLevel`, `parkStrength` |

`BATTER_TUNING` now reads exactly `tools/batter-rebuilt.json`, except that
`platoonStrength` and `platoonHrAmp` no longer exist as knobs. Those two keys
are still in that JSON file, which is the record of the fitted configuration;
they are now inert, and the tuning files a search writes will not bring the
term back.

**P1 is a deletion on purpose.** The study measured the term directly, against
outcomes, over 31,986 posted-lineup batter-games:

| platoon term | n | hits 1+ pred/obs | TB 2+ pred/obs |
|---|---|---|---|
| 0.95 (same hand) | 12,127 | 58.8 / **61.5** | 33.3 / **35.2** |
| 1.02 (switch) | 3,437 | 60.6 / 59.8 | 34.6 / 33.6 |
| 1.05 (opposite hand) | 16,422 | 63.0 / **60.2** | 37.6 / **35.4** |

The model spread "one or more hits" over 4.2 points across its three groups.
Reality spreads 1.3 and points the other way, because a hitter's season line is
already a plate-appearance-weighted average over the matchups his manager gave
him, and the hitters who start against a same-handed pitcher are the ones who
can hit them. Per-hitter 2025 vs-L / vs-R splits, regressed to the mean, were
worse than no term at all at every strength tried. A knob at 0 invites someone
to turn it back on; a deleted term with the table above where it used to be
does not. `input.platoonOverride` went with it, because that hook existed for
the per-hitter splits that were built, measured and rejected.

`PLATOON+` / `PLATOON−` are gone from `proj.flags` and `proj.platoon` is no
longer returned. The pitcher-side platoon adjustment (`src/model/platoon.js`,
a pitcher's own measured split applied to the opposing card) is a different
object and is untouched.

**What did not move.** The 0.6 weight on the 2025 season was searched over
0 .. 1.3 and 0.6 is the FIT optimum exactly, so it stayed. `contactShare`,
`hrLevel`, `sbScale`, `rbiK`, `sbK`, `teamPaSd`, `paLossRate`, `rateSpread`,
`kRateSpread` and `pitcherInfluence` all stayed. `--xstat25 0.5` (moving the
2025 leg toward prior-season expected statistics) is **not** ported: it needs
an input `src/data/loadSlate.js` does not fetch, and the study measured it at
0.00005 of FIT log loss.

---

## The reproduction check

The point of this section is that an improvement is easy to lose in
translation, so the ported file was measured the same way the study measured
the configuration it came from: on the holdout it was never fitted to, against
the same prices, with the same tooling.

The pre-port model was frozen out of git so it could be scored on the same rows
in the same pass (no tuning setting can restore a deleted term, so
`tools/backtest-kalshi-batters.mjs` grew a `--reference FILE` flag that imports
`projectBatter` from another module):

```
git show d3c3a74:src/model/batter.js > src/model/batter-preport.mjs

node tools/backtest-kalshi-batters.mjs --from 2026-09-02 --to 2026-09-22 \
  --scheme edge --bar-window HOLD --weights pre362 \
  --reference src/model/batter-preport.mjs \
  --cache <statsapi cache> --kcache <kalshi cache>
```

Everything about the price side is `docs/KALSHI-BATTER-BACKTEST.md` Method 4–7
unchanged: the decision quote is the close of the last candle ending at or
before first pitch − 120 min, fills are one contract at the ask, settlement is
Kalshi's `settlement_value_dollars`, and every interval is a cluster bootstrap
over `gamePk` with 5,000 resamples and a fixed seed. Public Kalshi and public
MLB StatsAPI only; every response cached.

Coverage is identical to the study's holdout run: **80,568 matched settled
contracts over 273 games and 4,841 player-games, of which 56,105 have a
two-sided quote at T−120.**

### (1) Ported vs pre-port — the paired Brier improvement

Brier at T−120, paired on identical contracts, 95% cluster bootstrap over the
273 games. **Negative means the ported model forecast better.**

| series | n | price | ported | pre-port | **ported − pre-port** | study's measured value |
|---|---|---|---|---|---|---|
| **all** | 56,105 | 0.1579 | 0.1587 | 0.1590 | **−0.0003 [−0.0006, −0.0000]** | −0.0003 [−0.0006, −0.0000] |
| KXMLBHIT | 10,374 | 0.1611 | 0.1616 | 0.1622 | **−0.0006 [−0.0010, −0.0002]** | −0.0006 [−0.0010, −0.0002] |
| KXMLBTB | 14,525 | 0.1520 | 0.1528 | 0.1531 | −0.0002 [−0.0006, 0.0001] | −0.0002 [−0.0006, 0.0001] |
| KXMLBHR | 4,069 | 0.1011 | 0.1019 | 0.1021 | −0.0002 [−0.0004, 0.0000] | −0.0002 [−0.0004, 0.0001] |
| KXMLBRBI | 7,399 | 0.1503 | 0.1511 | 0.1511 | −0.0001 [−0.0004, 0.0002] | −0.0001 [−0.0004, 0.0002] |
| KXMLBHRR | 17,906 | 0.1833 | 0.1844 | 0.1847 | **−0.0004 [−0.0007, 0.0000]** | −0.0003 [−0.0007, 0.0001] |
| KXMLBSB | 1,832 | 0.0944 | 0.0961 | 0.0962 | −0.0001 [−0.0003, 0.0000] | −0.0001 [−0.0003, 0.0000] |

**The port reproduces the measured gain, to the fourth decimal, in every
series.** It is better than the model it replaces in all six, pooled by
−0.0003 with an interval that excludes zero, and the largest per-series gain is
hits at −0.0006 [−0.0010, −0.0002].

T−30, where every lineup is posted, says the same thing on 72,246 contracts:
pooled −0.0003 [−0.0005, −0.0001], hits −0.0006 [−0.0009, −0.0002].

The one difference from the study's table is KXMLBHRR, −0.0004 here against
−0.0003 there, because the study's holdout also carried `--xstat25 0.5` and
this port does not. It is inside the interval either way.

A second check, run before the reference flag existed: scoring the ported
defaults against outcomes on the holdout returns **the same numbers to five
decimals on all nine markets** as the pre-port model run with
`--tuning tools/batter-rebuilt.json`. The port is the rebuilt configuration,
not something near it.

### (2) The port does not beat the price, and nothing here says it should

Same run, the pre-registered bar of `docs/BATTER-EDGE-SEARCH.md` section 3,
applied to the ported model:

| series | (A) Brier beats price | passes |
|---|---|---|
| KXMLBHIT | no (+0.0005 [−0.0001, 0.0011]) | **no** |
| KXMLBTB | no (+0.0008 [0.0002, 0.0014]) | **no** |
| KXMLBHR | no (+0.0008 [0.0003, 0.0013]) | **no** |
| KXMLBRBI | no (+0.0007 [0.0001, 0.0013]) | **no** |
| KXMLBHRR | no (+0.0011 [0.0002, 0.0020]) | **no** |
| KXMLBSB | no (+0.0017 [0.0005, 0.0028]) | **no** |
| pooled | no (+0.0009 [0.0003, 0.0014]) | **no** |

The exchange price is still the better forecast in every series. The Brier-
optimal weight on (model − market) reads 0.10 pooled and 0.25 on hits, against
0.05 and 0.10 for the pre-port model on the same rows. **That is not
authorisation to raise `MARKET_WEIGHT`, and it was not raised.**

### (3) Money, reported and not leaned on

T−120, fee 0.07, at the section-8 pre-v36.2 weights, on the same 273 games.
Both models are run through the bot's own `planOrders` screen.

| trade set | pre-port | ported |
|---|---|---|
| `botOnePerPlayer` | n=174, −1.7% [−15.9, 12.9], CLV +0.25c | n=77, **+16.2% [−4.2, 37.4]**, CLV +0.00c |
| `bot` | n=223, −4.5% [−18.9, 10.7], CLV +0.18c | n=94, +12.1% [−9.5, 34.0], CLV +0.02c |
| `every` | n=576, +1.6% [−11.9, 15.3], CLV −0.08c | n=249, +7.5% [−14.7, 30.7], CLV −0.26c |
| `botOnePerPlayer` T−30 | n=268, +4.1% [−9.1, 17.2], CLV −0.07c | n=138, +13.2% [−7.2, 31.8], CLV −0.05c |

Every ROI point estimate improves and **every interval spans zero**, so this
table says nothing. Two things in it are worth stating plainly rather than
quietly dropping:

- the ported model trades **half as often**, because its projections sit closer
  to the price;
- **closing-line value does not improve on this window.** The +0.19c the study
  reported for the rebuilt model was its holdout against the shipped model's
  *VALIDATE* CLV of −0.14c, two different windows. Measured on the same 273
  games, CLV is +0.25c for the pre-port model and +0.00c for the ported one, on
  trade sets of 174 and 77. At that size CLV is noise — the forecast leg has
  56,105 contracts and the money leg has 77 — but the honest reading is that
  the same-window CLV comparison does not support the port and the Brier
  comparison does.

---

## What the port does to H+R+RBI

`docs/AUDIT.md` calls H+R+RBI the worst market this system has: 149 trades,
−14.6% [−30.8, +0.8], and the largest Brier gap to the price of any series.
The joint plate-appearance model (P2) is the structural fix aimed at it.

The old shape had the right mean and the wrong tail. It built runs as a
Poisson, RBI as a negative binomial and H+R+RBI as a negative binomial whose
variance was the sum of the three marginal variances times a measured constant
of 1.8, with a 10% structural zero mixed in. A shared variance constant cannot
know that one swing is +1 hit, +1 run and +1 RBI at the same instant.

The replacement draws each plate appearance from {out, walk, non-HR hit, home
run} and attaches to that draw — resolved at the same plate appearance —
whether the batter eventually scores and how many runs he drives in:

```
R   = 0.3164*(non-HR hits) + 0.2615*(walks+HBP) + 1.0205*(home runs)
RBI = 0.2674*(non-HR hits) + 1.5868*(home runs) + 0.0202*(outs)
```

Only the ratios are carried; the two scales are solved per hitter so `E[R]` is
exactly `projR` and `E[RBI]` exactly `projRBI`. The +3 a solo home run
contributes to all three legs at once is now mechanical. It also puts
`rates.bb` to work, which the model computed and nothing read.

**On the holdout, against outcomes** (4,914 batter-games, no prices),
predicted / observed at each line Kalshi lists:

| H+R+RBI line | pre-port | ported | observed |
|---|---|---|---|
| 0.5 | 67.5 | 67.6 | **67.2** |
| 1.5 | 44.8 | 45.6 | **45.6** |
| 2.5 | 27.8 | **29.2** | **29.7** |
| 3.5 | 16.5 | **17.2** | **17.5** |
| 4.5 | 9.5 | 9.6 | **9.5** |

The tail is where the market lives and the tail is what moved: the standing
under-read at 2.5 falls from 1.9 points to 0.5, and at 3.5 from 1.0 to 0.3.
Brier 0.17836 → 0.17803, log loss 1.79510 → 1.79112, and the regression slope
of actual on projected moves from 0.830 to 1.120 on the fit window. Against the Kalshi
price the same change is worth −0.0004 [−0.0007, 0.0000] of Brier on 17,906
contracts, the second-largest per-series gain in the port.

Its two neighbours move with it, which is the point of doing them as one
object: RBI at the 1.5 line goes 9.6 → 10.5 against 10.4 observed, and runs at
0.5 goes 36.5 → 38.1 against 38.1 observed.

**This does not make H+R+RBI playable.** The price still forecasts it better
(+0.0011 [0.0002, 0.0020]), it is still the widest gap of the six series, and
`docs/AUDIT.md`'s **AVOID** verdict stands — the weights did not move, so the
board cannot call it.

---

## Everything else the port moves, against outcomes

Holdout, 4,914 batter-games, Brier over the lines Kalshi lists (lower better):

| market | pre-port | ported |
|---|---|---|
| hits | 0.14978 | **0.14921** |
| total bases | 0.16092 | **0.16047** |
| home runs | 0.05375 | **0.05368** |
| RBI | 0.11088 | **0.11078** |
| H+R+RBI | 0.17836 | **0.17803** |
| runs | 0.15303 | **0.15290** |
| singles | 0.17165 | **0.17109** |
| strikeouts | 0.14348 | **0.14330** |
| stolen bases | 0.05773 | **0.05763** |

Better on all nine. Runs and singles have no Kalshi series, so they are scored
against outcomes only and nothing is claimed about any price for them.

## What the board will look like different

Over the same 4,914 rows, the change in the quoted probability (percentage
points, mean signed / mean absolute):

| group | n | hits@0.5 | TB@1.5 | HR@0.5 | H+R+RBI@2.5 | runs@0.5 |
|---|---|---|---|---|---|---|
| all | 4,914 | −0.0 / 2.0 | +0.0 / 1.9 | +0.2 / 0.8 | +1.4 / 1.7 | +1.6 / 1.8 |
| opposite hand | 2,557 | −1.7 / 1.9 | −1.6 / 1.7 | −0.6 / 0.6 | +0.4 / 1.0 | +1.2 / 1.6 |
| same hand | 1,797 | +2.5 / 2.5 | +2.5 / 2.6 | +1.4 / 1.4 | +2.9 / 2.9 | +2.2 / 2.3 |
| switch | 523 | −0.4 / 0.8 | −0.4 / 0.7 | −0.1 / 0.3 | +1.1 / 1.4 | +1.3 / 1.4 |

Rows move about two points, and the movement is concentrated exactly where the
deleted term used to be: a hitter facing a same-handed starter is no longer
marked down 5% for it. Runs and H+R+RBI rise across the board, which is the
re-fitted run/RBI priors (strength 60 → 400) and the joint model together.

## Verification

- `npm test`: **213 pass, 0 fail**, unchanged in count from before the port.
  The batter tests are the load-bearing ones and none of them was touched or
  loosened: every count distribution's mean still equals the projection printed
  beside it to 1e-6 (1e-4 for H+R+RBI, which now comes from section 11b rather
  than the negative binomial), the PA distribution is still a proper pmf whose
  mean is the lineup-slot PA in all nine slots, and `teamPaSd: 0,
  rateSpread: 0` still reproduces the old two-point binomial mixture to 1e-12.
- No calibration assertion moved, and no test was edited.
- `MARKET_WEIGHT`, `PLAY_RULES`, the hurdle and the bounds in
  `src/lib/constants.js`: **unchanged**, verified by `git diff`.

## Reproduce the whole thing

```
# 1. outcomes only, no prices (25 s on a warm cache)
node tools/batter-research.mjs --mode base \
  --from 2026-03-01 --to 2026-09-22 --cache <statsapi cache>

# 2. against the Kalshi price, ported vs the frozen pre-port model
git show d3c3a74:src/model/batter.js > src/model/batter-preport.mjs
node tools/backtest-kalshi-batters.mjs --from 2026-09-02 --to 2026-09-22 \
  --scheme edge --bar-window HOLD --weights pre362 \
  --reference src/model/batter-preport.mjs \
  --cache <statsapi cache> --kcache <kalshi cache>

# 3. the pre-port model on its own, for the trade sets above
#    (check out d3c3a74's src/model/batter.js, run without --reference)
```

`src/model/batter-preport.mjs` is a throwaway: it is not committed, and
`git show` regenerates it byte for byte.

## Caveats

- **The holdout was already used once**, by `docs/BATTER-EDGE-SEARCH.md`, to
  test the configuration this port carries. This run is not an independent test
  of that configuration and is not presented as one. It is a *translation*
  check: does the code in `src/model/batter.js` produce the numbers the study
  measured. It does.
- **The money leg has 77 trades.** It cannot resolve an edge of any plausible
  size and is reported only so the port does not look better than it is.
- **No weather** in the replay, as before.
- **The Kalshi settled-market and candle caches were topped up** to 2026-09-22
  for this run (public endpoints, no auth, no orders, every response cached).
- **`tools/batter-rebuilt.json` still lists `platoonStrength` and
  `platoonHrAmp`.** They are inert now. It is left intact as the record of what
  was fitted.
