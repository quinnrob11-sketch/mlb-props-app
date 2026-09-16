# Batter model backtest and refit (2026-09-16)

## Method

`tools/backtest-batters.mjs` replays every final regular-season game from
Aug 10 to Sep 15 2026 (494 games, 8,892 batter-games) with no lookahead:

- **Who and where**: from each boxscore, the nine players who started in the
  batting order (`battingOrder` "<slot>00"), their slot and side, the opposing
  starting pitcher (first pitcher listed), and the venue from the schedule.
  The boxscore's `battingOrder` array is the final card, with substitutes in
  it, so it is not used to pick starters.
- **Hitter inputs**: the 2026 season line summed from his hitting game log over
  games dated before the game; the 2025 season line and handedness from
  `/people` (the combined split for traded players, which is what `pickSplit`
  returns).
- **Starter inputs**: his as-of 2026 line and start log plus his 2025 line, run
  through the real `projectPitcher`. The batter gets `proj.rates.{kRate, hRate,
  hrRate}`, as in `loadSlate`. Hand defaults to 'R' like `loadSlate`.
- **League**: `loadSlate`'s `lg` object (kRate, bbRate, avg, sbPerGame, starter
  baselines), built from the 30 team hitting game logs before the date.
- **Outcome**: the starter's own boxscore line, including games where he was
  lifted early. Kalshi settles on what the player actually did, so those games
  count.
- **Not replicated**: weather (`wx` is omitted, so `weatherHrFactor` is 1;
  it only nudges HR and runs), projected lineups (every row uses the posted
  card, and the bot only trades confirmed lineups), and late scratches or
  openers (the boxscore starter stands in for the listed probable).

Metrics per market: bias (actual vs projected mean), slope of actual on
projected, dispersion ratio (squared error divided by the model's own variance;
above 1 means the model is too narrow), log loss of the full pmf at the actual
count, Brier over the listed lines, and predicted vs observed rate at each
line. Fit window: Aug 10–31 (5,274). Holdout: Sep 1–15 (3,618).

`tools/tune-batters.mjs` searches `BATTER_TUNING` on the fit window by log loss
and prints the holdout for each stage. A setting shipped only if it also
improved holdout log loss.

All statsapi responses are cached (`--cache DIR`), so a re-run takes seconds:

    node tools/backtest-batters.mjs --from 2026-08-10 --to 2026-09-15 --split 2026-09-01 --cache DIR [--diag]
    node tools/tune-batters.mjs     --from 2026-08-10 --to 2026-09-15 --split 2026-09-01 --cache DIR [--stage pa,rate,...] [--base JSON] [--apply JSON]

## What was wrong

- **Per-PA rates were already right.** Over the whole replay, observed ÷
  projected per actual PA was 0.997 for hits, 0.990 for K and 1.013 for HR. Mean
  PA by slot matched `PA_BY_LINEUP_SLOT` to about 0.06.
- **The distributions were too narrow.** Real PA counts had an SD of 0.65–0.87
  by slot. The floor/ceil two-point mixture allows at most 0.5 and gives zero
  probability to 2-PA and 6-PA games, which were 1–14% of games depending on
  slot. On top of that, hits within a game are more clustered than independent
  PAs. As a result, hits and TB put too much mass on "1 or more": hits@0.5
  (which equals TB@0.5) read +1.6pp high in the fit window and +1.5pp high in
  the holdout. That is the gap `calibration.js` was patching at +2.0pp.
- **HR talent differences were over-believed.** Projected-HR slope was 0.81 in
  the fit window and 0.87 in the holdout.
- **The September holdout is a hot scoring window.** League R/G was 4.36 in the
  fit window and 4.76 in the holdout (HR/PA .0288 vs .0321). No as-of input can
  see that coming. The runs, RBI and HR level gaps that remain in the holdout
  come from this.

## What changed (`src/model/batter.js`, `BATTER_TUNING`)

| setting | was | now | evidence (holdout log loss) |
|---|---|---|---|
| `teamPaSd`, `paLossRate` | two-point mixture | team PA ~ N(mu, 5.5), slot bats floor((T−s)/9)+1, 10% chance of losing a trip; mu solved so E[PA] = table | PA 4.2489 → 1.1651 (per-slot empirical floor 1.1547); hits+TB+1B+HR 4.2050 → 4.1990 |
| `rateSpread` | 0 | 0.30 (hit probabilities ×0.7/1/1.3, weights ¼/½/¼, mean-preserving) | hits+TB+1B+HR 4.1990 → 4.1964 |
| `hrPriorStrength` | 100 | 300 | HR+TB 2.0180 → 2.0169; HR slope 0.81 → 1.00 (fit) |
| `runLevel` | 0.933 | 0.95 | runs 0.9057 → 0.9050 |
| `rbiLevel` | 0.963 | 0.98 | RBI 0.9149 → 0.9146 |
| `hrrVarianceInflation`, `hrrStructuralZero` | 1.947, 0.0815 | 1.8, 0.10 | HRR 1.8192 → 1.8177 |
| `sbK` | 1 | 1.5 | SB 0.2335 → 0.2331 |

All count distributions still have a mean exactly equal to the displayed
projection (`test/batter.test.js`). `teamPaSd: 0, rateSpread: 0` reproduces the
old model exactly.

These were rejected because the holdout got worse: `hrLevel` 0.945 → 0.91
(HR+TB 2.0169 → 2.0178), `rbiK` 0.85 → 0.70 (0.9146 → 0.9156), `sbScale` 0.969
→ 0.90 (0.2331 → 0.2332). The fit window kept `kRateSpread` at 0 and
`contactShare` at 0.989.

## Holdout (Sep 1–15, 3,618 batter-games), before → after

| market | bias | dispersion | log loss | Brier | key lines, predicted (before → after) vs observed |
|---|---|---|---|---|---|
| hits (KXMLBHIT) | +0.7% → +0.7% | 1.106 → 1.037 | 1.1999 → 1.1944 | .1502 → .1501 | 0.5: 62.2→61.0 vs 60.8 · 1.5: 21.4→21.7 vs 22.0 · 2.5: 3.9→4.6 vs 5.1 |
| total bases (KXMLBTB) | +2.1% → +2.2% | 1.082 → 1.038 | 1.6297 → 1.6279 | .1639 → .1638 | 0.5: 62.2→61.0 vs 60.8 · 1.5: 35.6→35.4 vs 35.9 · 2.5: 20.2→20.4 vs 21.2 · 3.5: 14.1→14.3 vs 15.7 |
| home runs (KXMLBHR) | +7.6% → +8.1% | 1.054 → 1.047 | 0.3894 → 0.3890 | .0561 → .0560 | 0.5: 11.4→11.3 vs 12.3 |
| RBIs (KXMLBRBI) | +8.2% → +6.3% | 1.051 → 1.026 | 0.9149 → 0.9146 | .1144 → .1143 | 0.5: 29.3→29.6 vs 31.0 · 1.5: 9.4→9.6 vs 10.9 |
| H+R+RBI (KXMLBHRR) | +4.9% → +3.9% | 0.974 → 0.990 | 1.8190 → 1.8177 | .1818 → .1817 | 0.5: 67.1→67.5 vs 67.7 · 1.5: 44.0→44.9 vs 46.7 · 2.5: 27.2→27.8 vs 30.8 · 3.5: 16.3→16.5 vs 18.6 |
| runs | +9.7% → +7.7% | 1.013 → 0.994 | 0.9057 → 0.9050 | .1580 → .1578 | 0.5: 36.0→36.5 vs 39.6 |
| strikeouts | −1.7% → −1.7% | 1.004 → 0.976 | 1.14699 → 1.14701 | .14260 → .14257 | 0.5: 61.6→61.2 vs 60.4 |
| singles | +0.3% → +0.2% | 1.097 → 1.054 | 0.9860 → 0.9838 | .1709 → .1707 | 0.5: 45.7→45.0 vs 44.3 |
| stolen bases | −2.9% → −2.9% | 0.903 → 0.934 | 0.2335 → 0.2331 | .0573 → .0573 | 0.5: 6.3→6.4 vs 6.4 |

Bias is actual vs projected, so a positive number means the model was too low.

Fit window, for completeness (before → after log loss): hits 1.1841 → 1.1820,
TB 1.6090 → 1.6079, HR 0.3635 → 0.3629, RBI 0.8778 → 0.8777, HRR 1.7875 →
1.7873, runs 0.8759 → 0.8759, K 1.13908 → 1.13922, singles 0.9735 → 0.9737, SB
0.2309 → 0.2308.

**Worse, but not materially:** strikeout log loss moved up by 0.00002 in the
holdout and 0.00014 in the fit window. The wider PA distribution makes K
slightly too wide (dispersion 0.976), while its Brier improved. Singles fit
log loss moved up by 0.0002 while its holdout improved by 0.0022.

## calibration.js

Re-derived against the refit with the file's rule (≥0.5pp in both windows,
same sign, mean of the two). No batter line qualifies, so all three old entries
are deleted:

- hits@0.5 +0.020: absorbed by the PA and rate spreads. Now +0.4 / +0.3.
- TB@1.5 +0.0235: the windows disagree (+1.6 / −0.5).
- HRR@2.5 −0.008: the fit window is clean (−0.2). The holdout's −3.0 is the
  September scoring jump.

The commonly traded Kalshi lines are listed at 0, so the board shows them as
measured and clean rather than "n/m". `calibrate()` ignores values under
`MIN_CORRECTION`, so trading is unaffected. The RBI, HRR and runs lines read
low in the holdout. If a later window shows the same gap in its fit period as
well, they become entries.
