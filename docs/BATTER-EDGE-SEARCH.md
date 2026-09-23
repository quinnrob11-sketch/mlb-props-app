# Can a better batter model beat the Kalshi price?

`docs/KALSHI-BATTER-BACKTEST.md` measured the current batter model against real
Kalshi prices and found no edge: 609 replayed trades returned −3.4%, the price
beat the model's Brier score in every series with the interval excluding zero,
and the Brier-optimal weight on (model − market) was 0.10–0.15. The projections
were well calibrated; the price was simply sharper.

This study asks whether that is fixable. It rebuilds the batter model on a
larger sample and a wider set of inputs, then tests the rebuilt model against
the same prices on a window it never saw.

---

# Part 1 — Pre-registration

**This section was written and committed before any price was read, any P&L was
computed and any holdout number existed.** Nothing in it was changed afterwards.
The commit that introduces this file contains Part 1 and nothing else.

## 1. The split

| window | dates | what it is for |
|---|---|---|
| **FIT** | 2025 season (as prior lines) + every 2026 game through **2026-08-09** | choosing model structure and every constant, by outcome log loss. No prices. |
| **VALIDATE** | **2026-08-10 .. 2026-09-01** | comparing candidate configurations against the exchange price. Prices are read here. |
| **HOLDOUT** | **2026-09-02 .. 2026-09-22** | touched **once**, at the very end, for the single configuration already chosen. |

The current `BATTER_TUNING` was fitted on 2026-08-10..08-31, which sits inside
VALIDATE. The baseline it provides is therefore flattered on VALIDATE and clean
on HOLDOUT. That is stated wherever the baseline appears.

Kalshi's public live tier holds settled batter markets from 2026-07-10 onward,
so FIT has no price data at all. This is a feature, not a limitation: the model
is fitted to what happened on a field, and only then asked whether that helps
against a price.

If the HOLDOUT is touched more than once, the report says so explicitly and
every touch is listed.

## 2. What is being tested

Series with a Kalshi market, which are the ones the ROI bar applies to:

| series | market |
|---|---|
| KXMLBHIT | hits |
| KXMLBTB | total bases |
| KXMLBHR | home runs |
| KXMLBRBI | RBIs |
| KXMLBHRR | hits + runs + RBIs |
| KXMLBSB | stolen bases |

Runs and singles are named in the brief but **Kalshi lists no series for
either** (probed 2026-09-23: `KXMLBRUNS`, `KXMLBRUN`, `KXMLBRS`, `KXMLBR`,
`KXMLBSCORE`, `KXMLBRUNSCORED`, `KXMLBSINGLE`, `KXMLBSINGLES`, `KXMLB1B`,
`KXMLBSGL` all 404). They are reported against outcomes only, with no claim
about beating any price.

## 3. The success bar

Pre-registered, and not negotiable after the fact. The improved model beats the
price only if **both** of the following hold on HOLDOUT, at the primary decision
time T−120:

- **(A) Forecast.** The model's Brier score is better than the exchange's
  decision-mid price, with a cluster-bootstrap (by `gamePk`, 5,000 resamples,
  fixed seed) 95% interval on the paired difference that **excludes zero**.
- **(B) Money.** ROI after the **0.07** fee is **positive**, with its
  cluster-bootstrap 95% interval **excluding zero**.

Reported per series and pooled, always with n and the interval. A series passes
only on its own numbers. Anything less is a **FAIL** and is reported as one.

Secondary numbers reported but **not** part of the bar: fee 0.035, decision time
T−30, CLV, calibration, and the Brier-optimal weight on (model − market).

## 4. How a configuration is chosen

1. **FIT.** Candidate structural changes and every constant are chosen on FIT
   alone, by log loss of the model's own pmf at the observed count, and by the
   regression slope of actual on projected. No price is read.
2. **VALIDATE.** Each surviving candidate is scored against the exchange price
   on VALIDATE: paired Brier difference versus the decision mid, with the same
   cluster bootstrap. The single configuration with the best pooled
   model − market Brier on VALIDATE is carried forward.
3. **HOLDOUT.** That one configuration is run once.

## 5. What is being tried

Committed in advance so the list cannot grow to fit the answer. Each is tested
on FIT and kept only if it improves FIT log loss out of its own sub-sample:

1. **Shrinkage and season weighting re-derived.** The blend is currently
   `x26 + 0.6·x25 + strength·prior` over `pa26 + 0.6·pa25 + strength`, with
   hard-coded strengths (hits 60, doubles 80, HR 300, triples 120, runs 60,
   RBI 60). Both the 0.6 and every strength are re-fitted on FIT. The full-season
   replay already shows the regression slope of actual on projected below 1 for
   hits (0.80), singles (0.78), TB (0.87), RBI (0.71) and H+R+RBI (0.86), which
   is the signature of a model that believes player differences more than they
   hold up.
2. **Recency.** An exponential or windowed weighting of 2026 game logs, tested
   against the current flat season-to-date sum.
3. **Plate appearances from the actual game, not the league-average slot
   table.** Team plate appearances depend on the offence and on the opposing
   run environment; the model currently solves a team PA mean so that E[PA]
   equals a fixed per-slot constant. Including the chance of a 5th (and 6th)
   trip explicitly is the point of this market at the 0.5 lines.
4. **The bullpen behind the starter.** A batter faces the starter for roughly
   2.5 of his trips and relievers for the rest; the model applies one
   starter-derived multiplier to every plate appearance.
5. **Platoon splits with regression to the mean**, replacing the flat ±5% / ±9%.
6. **Park and weather specific to the batted-ball profile**, rather than one
   park column per statistic.
7. **Quality-of-contact inputs** if any are reachable from the public StatsAPI.
8. **One plate-appearance outcome distribution** driving hits, total bases,
   home runs, singles, runs, RBI and H+R+RBI jointly, instead of separate
   marginals with a variance-inflation constant bolted onto H+R+RBI. H+R+RBI is
   the worst market measured and the most compound, so this is where a
   structural win would show up first.
9. **The zero-inflation and dispersion constants in `BATTER_TUNING`** re-fitted
   on FIT rather than carried from the Aug 10–31 window.

## 6. Data and rules

- Public MLB StatsAPI and public Kalshi (`api.elections.kalshi.com`) only. No
  paid odds feed is called. Every response is cached to disk under
  `.backtest-cache/` in this worktree and reused.
- Replay is lookahead-free exactly as `tools/backtest-batters.mjs` already does
  it: posted starters from the boxscore, hitter and pitcher inputs summed from
  game-log entries dated strictly before the game, the league object built from
  team game logs before the date, and 2025 season lines from `/people`.
- Prices, quote timing, the bot's own `planOrders` screen, one-contract taker
  fills at the ask, Kalshi's `settlement_value_dollars`, the quadratic fee, and
  the cluster bootstrap are all reused unchanged from
  `tools/backtest-kalshi-batters.mjs` and `docs/KALSHI-BATTER-BACKTEST.md`
  Method 4–7. The only thing this study changes is the model.

## 7. What would make this a failure

A negative result is the expected outcome and is reported as a result, not as a
problem to be tuned away. Specifically, the study **fails** if the HOLDOUT does
not clear both (A) and (B) — including the case where the rebuilt model forecasts
better than the old one and still cannot beat the price.

## 8. Addendum, committed before any P&L was computed

The trading rule was under-specified in section 3 and has to be pinned down
before (B) can mean anything. Running the baseline through
`tools/backtest-kalshi-batters.mjs` produced **zero trades** in every window,
because `MARKET_WEIGHT` for batter markets was dropped to the measured 0–0.15
in v36.2: the model can then move a price by at most 1.5–2.25 points and the
smallest call needs 3. A rule that never trades cannot be tested.

So, fixed now, with no P&L of any kind yet computed or looked at:

- **The headline ROI rule is the one `docs/KALSHI-BATTER-BACKTEST.md` measured
  at −3.4%**: the bot's own `planOrders` screen at T−120, one bet per player
  across all series (`botOnePerPlayer`), with `MARKET_WEIGHT` at the values in
  force for that study — HIT 0.45, TB 0.45, HR 0.50, RBI 0.35, HRR 0.40, and
  0.40 for stolen bases, which that study did not cover. This keeps the new
  number directly comparable with the old one.
- **Secondary, reported alongside:** the same screen at `MARKET_WEIGHT` 1.0,
  i.e. the model against the price with no blending. This is the sharpest test
  of whether the model's disagreements carry information, and it produces the
  most trades.
- KXMLBSB is not mapped in `src/lib/kalshi.js`, so `planOrders` cannot see it.
  It is priced and scored in the tool by the same rules and reported in the
  `every` (every `buildSignal` trade) set. That is stated wherever it appears.

Nothing else in Part 1 changes.

---

# Part 2 — What was tried, and what it did (FIT)

Everything in this part was chosen on **FIT** — every 2026 game through
2026-08-09, 31,986 posted-lineup batter-games, with 2025 as the prior season —
scored against outcomes. No price was read.

Reproduce:

```
node tools/batter-research.mjs --from 2026-03-01 --to 2026-09-22 \
  --cache <statsapi cache> --mode base|shrink|recency
```

`slope` below is the regression of the actual count on the projected one: 1.0
means the model believes player differences exactly as much as it should, and
below 1 means it believes them too much. `disp` is squared error over the
model's own variance, so above 1 means the distribution is too narrow.

## The one large finding: the platoon multiplier is noise

The model multiplies a hitter's rates by 1.05 with the platoon advantage, 0.95
without and 1.02 for a switch hitter, and amplifies that 1.8x for home runs.
Grouping FIT by that multiplier and comparing what the model said with what
happened:

| platoon term | n | hits 1+ pred/obs | TB 2+ pred/obs | HR 1+ pred/obs | H+R+RBI 2+ pred/obs |
|---|---|---|---|---|---|
| 0.95 (same hand) | 12,127 | 58.8 / **61.5** | 33.3 / **35.2** | 10.3 / **11.7** | 43.3 / **46.0** |
| 1.02 (switch) | 3,437 | 60.6 / 59.8 | 34.6 / 33.6 | 10.5 / 9.3 | 44.2 / 44.9 |
| 1.05 (opposite hand) | 16,422 | 63.0 / **60.2** | 37.6 / **35.4** | 12.2 / **11.9** | 46.4 / **45.0** |

The model spreads hits-1-or-more over a 4.2-point range across the three
groups. The observed range is **1.3 points, and it points the other way**. On
total bases the model spreads 4.3 points and reality spreads 0.2.

The reason is not that the platoon effect does not exist. It is that the model
applies it twice, to a selected population.

- A hitter's season line is already a plate-appearance-weighted average over
  **the matchups his manager actually gave him**. A left-handed platoon bat
  whose season is 80% against right-handers carries a rate that already *is*
  his vs-RHP rate. Multiplying it by another 1.05 counts the edge twice.
- The hitters who start against a same-handed pitcher are the ones who can hit
  them. Conditional on being in the posted lineup, the disadvantage largely
  disappears.

Both push the same way, and together they cancel the term.

Setting `platoonStrength` to 0 (and the home-run amplifier with it) is the
single largest improvement found anywhere in this study:

| platoonStrength | FIT traded log loss | FIT hits Brier | VALIDATE hits Brier |
|---|---|---|---|
| 1 (shipped) | 6.13274 | 0.14899 | 0.14819 |
| 0.5 | 6.12937 | 0.14874 | 0.14795 |
| **0** | **6.12797** | **0.14862** | **0.14785** |
| −0.25 | 6.12802 | 0.14861 | 0.14785 |

**Per-hitter platoon splits do not rescue it.** Each hitter's own 2025 vs-LHP
and vs-RHP OPS (`stats=statSplits&sitCodes=vl,vr` — a completed season, so no
lookahead), regressed to the mean and applied relative to the *mix he actually
played* rather than to 1.0, is worse than no platoon term at all at every
strength and every regression constant tried (511 hitters have both splits):

| strength, regression k | FIT traded LL | VALIDATE hits Brier |
|---|---|---|
| off | 6.12097 | 0.14780 |
| 1.0, k = 400 PA | 6.12129 | 0.14787 |
| 1.0, k = 150 PA | 6.12211 | 0.14797 |
| 0.5, k = 150 PA | 6.12130 | 0.14786 |
| 1.0, k = 40 PA | 6.12470 | 0.14821 |

## The second finding: runs, RBI and H+R+RBI belong to one object

The shipped model builds runs as a Poisson, RBI as a negative binomial, and
H+R+RBI as a negative binomial whose variance is the sum of the three marginal
variances times a measured constant (1.8), with a 10% structural zero mixed in.
The mean is right; the shape is not. On FIT the H+R+RBI tail reads 27.9% at 2.5
against 29.1% observed and 16.6% at 3.5 against 17.3%.

The replacement decomposes a plate appearance instead. Over the same 31,986
batter-games, no intercept:

```
R   = 0.3164*(non-HR hits) + 0.2615*(walks+HBP) + 1.0205*(home runs)
RBI = 0.2674*(non-HR hits) + 1.5868*(home runs) + 0.0202*(outs)
```

and, conditional on reaching, the counts themselves:

| | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| RBI on one non-HR hit | 78.4% | 19.6% | 2.0% | — |
| RBI on a home run | 55.2% | 29.2% | 12.9% | 2.5% |

with the batter scoring after 30.7% of his non-HR hits and 26.2% of his walks.

So each plate appearance is a draw from {out, walk, non-HR hit, home run}, and
attached to that draw — resolved at the same plate appearance — is whether the
batter eventually scores and how many runs he drives in. H+R+RBI is the sum of
n independent per-PA increments. The +3 that a solo home run contributes to all
three legs at once is now **mechanical** rather than a correlation constant.
Only the ratios above are carried; the two scales are solved per hitter so that
E[R] is exactly `projR` and E[RBI] exactly `projRBI`, which keeps every
distribution's mean equal to the projection printed beside it.

It also puts the walk rate to work: `rates.bb` was computed by the model and
read by nothing.

A game-level scoring latent (`scoreSpread`, the same three-point
mean-preserving mixture `rateSpread` already uses) sits on top, because a
batter's runs and RBI ride his team's night. Fitted at 0.6.

Effect on FIT, at otherwise identical settings:

| | RBI 1+ | RBI 2+ | RBI 3+ | H+R+RBI 2+ | H+R+RBI 3+ | H+R+RBI 4+ |
|---|---|---|---|---|---|---|
| marginals (shipped) | 29.7 | 9.7 | 3.3 | 44.7 | 27.7 | 16.4 |
| joint | 29.1 | 10.4 | 3.6 | 45.6 | 28.8 | 16.9 |
| **observed** | **29.4** | **10.6** | **3.6** | **45.4** | **29.1** | **17.3** |

## Everything else that was tried

### Shrinkage, and the weight on 2025 (pre-registration item 1)

The regression slope of actual on projected was 0.76 for hits, 0.74 for
singles, 0.68 for RBI, 0.83 for H+R+RBI and 0.81 for runs. Re-fitting the prior
strengths on FIT, one rate at a time, moves them toward 1:

| rate | shipped strength | FIT-optimal | slope, shipped → fitted | FIT log-loss gain |
|---|---|---|---|---|
| hits | 60 | 200 | 0.76 → 0.86 | 0.00047 |
| singles | 60 | 600 | 0.74 → 0.81 | 0.00029 |
| doubles | 80 | 400+ | flat | 0.00024 |
| triples | 120 | flat | flat | 0.00013 |
| runs | 60 | 400 | 0.81 → 1.21 | 0.00143 |
| RBI | 60 | 400 | 0.68 → 1.06 | 0.00117 |
| home runs | 300 | 200 | 1.09 → 0.98 | 0.00037 |
| strikeouts | 60 | 60 (unchanged) | 1.04 | — |
| stolen bases | 30 games | 15 games | 1.12 → 0.99 | 0.00067 |

**The 0.6 weight on the prior season is already right.** Searched over 0, 0.2,
0.4, 0.6, 0.8, 1.0 and 1.3, the FIT optimum is 0.6 exactly, and the whole curve
spans 0.002 of log loss. It is not worth moving.

### Recency (item 2)

No signal. Splitting FIT by how a hitter's last 14 days compared with his own
season rate, the model is equally right about the hot group and the cold group:

| last-14-day form | n | hits 1+ pred/obs | H+R+RBI 2+ pred/obs |
|---|---|---|---|
| cold (−4pp or worse) | 5,435 | 61.2 / 61.0 | 45.0 / 45.4 |
| middle | 16,793 | 61.7 / 61.5 | 45.6 / 46.4 |
| hot (+4pp or better) | 5,766 | 61.5 / 61.2 | 45.2 / 45.9 |

An exponential decay on the current-season game log, with the weights rescaled
so the denominator is preserved, was searched over half-lives of 18 to 240 days
against the flat season-to-date sum. Nothing beat flat.

### Plate appearances (item 3)

**A dead end, and it can be shown to be one.**

*Team plate appearances are not predictable.* Regressing a team's plate
appearances in a game on as-of inputs — its own PA per game, the opponent's
batters faced per game, the park's run factor, home/away — over 3,252
game-sides in FIT:

| model | R² | residual SD | predicted SD |
|---|---|---|---|
| home/away only | 0.028 | 4.650 | 0.78 |
| + own offence | 0.028 | 4.648 | 0.79 |
| + opponent pitching | 0.038 | 4.625 | 0.92 |
| + park | 0.042 | 4.614 | 0.97 |

Team plate appearances have an SD of 4.72 and everything as-of data can say
about them has an SD of 0.97 — a fifth of a plate appearance per batter.

*And the marginal does not matter anyway.* Replacing the model's whole
plate-appearance distribution with the **empirical per-(slot, side) pmf measured
on FIT itself** — an in-sample oracle for that marginal, which fixes a real
3.8-point miss at the "4 or more plate appearances" line — is worth almost
nothing on the markets:

| | FIT traded log loss | FIT hits Brier | VALIDATE traded log loss |
|---|---|---|---|
| model PA distribution | 6.13274 | 0.14899 | 6.08040 |
| empirical PA pmf (in-sample) | 6.13229 | 0.14899 | **6.08078** (worse) |

The plate-appearance distribution is not where the price beats the model.

### The bullpen behind the starter (item 4)

Blending the opposing starter's rates with the opposing team's season-to-date
pitching rates at a plate-appearance weight, before the existing
`PITCHER_INFLUENCE` pass-through, is worth 0.0003 of FIT log loss at a 20%
bullpen share and exactly nothing on VALIDATE. The starter term's own strength
is already at its FIT optimum: 0.6x and 1.4x are both worse than the shipped
1.0x.

### Park (item 6)

Mildly under-applied. Scaling the park weights by 1.25–1.5 improves FIT log
loss by 0.0006; the curve is nearly flat. 1.25 was kept. There is no
batted-ball profile in the data to make park specific to — `PARK_FACTORS` has
no doubles column. Weather is not in the replay at all and nothing is claimed
about it either way.

### Quality of contact (item 7)

**Reachable, and it helps a little.** `stats=expectedStatistics` on the public
StatsAPI returns xBA, xSLG and xwOBA. For the *current* season it is published
only as a season-to-date total and the game log carries none, so an as-of value
would be contaminated and is unusable. For the **prior** season it is a
completed, frozen number and is lookahead-free. Moving the 2025 leg of the
shrinkage from what a hitter actually did toward what he was expected to do
(523 of 636 hitters have it):

| λ | FIT traded LL | VALIDATE hits Brier |
|---|---|---|
| 0 | 6.12096 | 0.14780 |
| **0.5** | **6.12050** | 0.14774 |
| 1.0 | 6.12062 | 0.14770 |

FIT picks 0.5, so 0.5 is what was used. The effect is real and small.

### The batting order as a talent signal

Rejected. Home runs read 0.7–1.5 points low in slots 1–4 and 1.9 points high in
slot 9 after everything else, so the manager's card does carry power
information the season line misses — but a fitted log-linear slot multiplier
improves FIT home-run log loss by 0.0004 and makes VALIDATE **worse** (Brier
0.05109 → 0.05115). A contact version is worse on FIT as well.

### Playing time as a talent signal

Measured, not converted into a model change. Splitting FIT by a hitter's plate
appearances per team game, restricted to teams with 60+ games played so this is
not an April artefact:

| PA per team game | n | hits 1+ pred/obs | HR 1+ pred/obs |
|---|---|---|---|
| under 1.5 | 3,204 | 57.1 / 55.3 | 9.8 / 9.6 |
| 1.5 – 2.5 | 2,907 | 59.0 / 59.6 | 10.0 / 11.0 |
| 2.5 – 3.4 | 3,356 | 60.2 / 61.0 | 11.0 / 12.2 |
| 3.4 – 4.0 | 2,752 | 62.4 / 65.1 | 11.5 / 13.4 |
| 4.0+ | 3,567 | 64.6 / 65.5 | 13.3 / 15.2 |

Bench bats are over-projected and everyday bats under-projected by about two
points at each end — the same story as the slope, in a different coordinate.
The obvious fix is a prior that depends on playing time, but the model has no
input that carries it (`projectBatter` is given the hitter's own games and
plate appearances, not his team's), and the two carriers it does have — lineup
slot and the shrinkage strength — were both tested above. Re-fitting the
strengths recovers most of it. This is the one measured effect in the study
left on the table, and it is named here so the next person does not have to
find it again.

## The rebuilt model

`scratch/rebuilt.json` in the reproduction below is:

```json
{
 "platoonStrength": 0, "platoonHrAmp": 0,
 "jointScoring": true, "scoreSpread": 0.6,
 "hrPriorStrength": 200,
 "priorStrength": { "hit": 200, "single": 600, "double": 400, "triple": 120,
                    "run": 400, "rbi": 400, "k": 60, "bb": 60, "sb": 15 },
 "powerShare": 1.06, "runLevel": 0.98, "rbiLevel": 1.0, "parkStrength": 1.25
}
```

plus `--xstat25 0.5`. Against outcomes:

**FIT** (31,986 batter-games, in sample):

| market | slope, shipped → rebuilt | dispersion | Brier, shipped → rebuilt |
|---|---|---|---|
| hits | 0.763 → 1.030 | 1.017 → 1.010 | 0.14899 → 0.14850 |
| total bases | 0.856 → 1.027 | 1.029 → 1.006 | 0.16161 → 0.16121 |
| home runs | 1.086 → 1.009 | 1.051 → 1.018 | 0.05405 → 0.05398 |
| RBI | 0.681 → 1.065 | 1.013 → 0.964 | 0.11184 → 0.11161 |
| H+R+RBI | 0.830 → 1.120 | 0.973 → 0.991 | 0.17904 → 0.17858 |
| runs | 0.812 → 1.203 | 0.995 → 1.019 | 0.15316 → 0.15274 |
| singles | 0.744 → 1.058 | 1.015 → 1.016 | 0.16938 → 0.16889 |
| stolen bases | 1.118 → 0.990 | 0.964 → 0.966 | 0.05836 → 0.05828 |

**VALIDATE** (5,544 batter-games, out of the fitting sample — and note the
shipped `BATTER_TUNING` was itself fitted on 2026-08-10..08-31, which is inside
this window, so the baseline here is flattered):

| market | Brier, shipped → rebuilt | key line, pred/obs shipped → rebuilt |
|---|---|---|
| hits | 0.14812 → **0.14773** | 1+: 61.2/60.9 → 61.1/60.9 |
| total bases | 0.15839 → **0.15819** | 2+: 35.6/34.2 → 35.6/34.2 |
| home runs | 0.05102 → 0.05112 (worse) | 1+: 11.3/11.0 → 11.5/11.0 |
| RBI | 0.11018 → **0.11004** | 2+: 9.5/10.1 → 10.5/10.1 |
| H+R+RBI | 0.17743 → **0.17701** | 3+: 27.8/28.3 → 29.2/28.3 |
| runs | 0.15137 → **0.15112** | 1+: 36.4/36.9 → 38.1/36.9 |
| singles | 0.16919 → **0.16885** | 1+: 45.2/46.2 → 44.9/46.2 |
| stolen bases | 0.05510 → 0.05511 (flat) | 1+: 6.5/6.1 → 6.4/6.1 |

The rebuilt model is better than the shipped one on seven of eight markets, out
of sample, and the regression slopes are now at 1. That is a better baseball
model. Part 3 asks the only question that matters.

---

# Part 3 — Against the price

Reproduce (VALIDATE):

```
node tools/backtest-kalshi-batters.mjs --from 2026-07-10 --to 2026-09-01 \
  --scheme edge --bar-window VAL --weights pre362 \
  --tuning scratch/rebuilt.json --xstat25 0.5 \
  --cache <statsapi cache> --kcache <kalshi cache>
```

Everything about the price side is `docs/KALSHI-BATTER-BACKTEST.md` Method 4–7,
unchanged: the decision quote is the close of the last candle ending at or
before first pitch − 120 min, the bot's own `planOrders` screen makes the
decision, fills are one contract at the ask, settlement is Kalshi's
`settlement_value_dollars`, the fee is quadratic, and every interval is a
cluster bootstrap over `gamePk` with 5,000 resamples and a fixed seed.

## VALIDATE (2026-08-10 .. 2026-09-01)

Brier score at T−120, 64,016 priced contracts with a two-sided quote, over 186
games. Lower is better; the difference is paired and the interval is the game
cluster bootstrap. **A positive difference means the exchange price forecast
the outcome better than the model did.**

| series | n | market | shipped model | rebuilt model | shipped − market | rebuilt − market |
|---|---|---|---|---|---|---|
| all | 64,016 | **0.1477** | 0.1488 | 0.1485 | +0.0011 [0.0005, 0.0017] | +0.0008 [0.0002, 0.0014] |
| KXMLBHIT | 12,081 | **0.1486** | 0.1497 | 0.1492 | +0.0011 [0.0004, 0.0018] | +0.0006 [0.0000, 0.0012] |
| KXMLBTB | 15,599 | **0.1465** | 0.1475 | 0.1473 | +0.0010 [0.0003, 0.0017] | +0.0008 [0.0001, 0.0014] |
| KXMLBHR | 5,390 | 0.0764 | 0.0764 | 0.0765 | +0.0000 [−0.0003, 0.0004] | +0.0001 [−0.0003, 0.0005] |
| KXMLBRBI | 8,464 | **0.1441** | 0.1450 | 0.1448 | +0.0009 [0.0001, 0.0017] | +0.0007 [0.0000, 0.0014] |
| KXMLBHRR | 19,613 | **0.1809** | 0.1827 | 0.1822 | +0.0018 [0.0009, 0.0028] | +0.0013 [0.0003, 0.0022] |
| KXMLBSB | 2,869 | 0.0686 | 0.0682 | 0.0683 | −0.0004 [−0.0012, 0.0004] | −0.0003 [−0.0011, 0.0005] |

The rebuild closes about a third of the gap and closes none of it entirely. The
Brier-optimal weight on (model − market) rises from 0.05 to 0.15 pooled, and on
hits from 0.05 to 0.15 — the model's disagreements now carry a little more
information than they did — but the price is still the better forecast in every
series except stolen bases, where the two are indistinguishable.

Money on VALIDATE, T−120, fee 0.07, at the pre-v36.2 weights fixed in section 8:

| trade set | shipped | rebuilt |
|---|---|---|
| `every` | n=724, −3.5% [−17.3, 10.4], CLV −0.05c | n=353, **+3.4%** [−15.8, 25.1], CLV +0.17c |
| `bot` | n=228, −8.3% [−21.8, 5.1], CLV −0.12c | n=116, −6.8% [−29.4, 17.7], CLV +0.14c |
| `botOnePerPlayer` | n=178, −9.9% [−23.4, 3.3], CLV −0.14c | n=95, **+1.7%** [−21.6, 26.7], CLV +0.14c |

Every interval spans zero and the rebuilt model trades half as often, because
its projections sit closer to the price. Closing-line value turns from −0.14c
to +0.14c, which is the same story as the Brier: better, and not enough.

**The configuration carried to HOLDOUT is the rebuilt model**, on the
pre-registered rule of section 4: it has the better pooled model − market Brier
on VALIDATE (+0.0008 against +0.0011).
