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

`tools/batter-rebuilt.json` in the reproduction below is:

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
  --tuning tools/batter-rebuilt.json --xstat25 0.5 \
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

## HOLDOUT (2026-09-02 .. 2026-09-22) — touched once

```
node tools/backtest-kalshi-batters.mjs --from 2026-09-02 --to 2026-09-22 \
  --scheme edge --bar-window HOLD --weights pre362 \
  --tuning tools/batter-rebuilt.json --xstat25 0.5 \
  --cache <statsapi cache> --kcache <kalshi cache> --json hold.json
```

**The holdout was run exactly once**, with the configuration chosen on FIT and
carried through VALIDATE, and nothing was changed after seeing it. The run took
9.8 minutes and 1,179 Kalshi requests, and covers 80,568 matched settled
contracts over 273 games and 4,841 player-games, of which 56,105 have a
two-sided quote at T−120.

Because the shipped `BATTER_TUNING` is scored in the same pass as a reference,
this one run answers both questions: does the rebuilt model beat the price, and
is it better than what shipped.

### (A) Forecast — **FAIL**

Brier score at T−120, paired differences, 95% cluster bootstrap over 273 games.
A positive difference means the price was the better forecast.

| series | n | price | rebuilt | shipped | rebuilt − price | shipped − price | rebuilt − shipped |
|---|---|---|---|---|---|---|---|
| **all** | 56,105 | **0.1579** | 0.1587 | 0.1590 | **+0.0008 [0.0002, 0.0014]** | +0.0011 [0.0005, 0.0018] | −0.0003 [−0.0006, −0.0000] |
| KXMLBHIT | 10,374 | **0.1611** | 0.1615 | 0.1620 | +0.0004 [−0.0002, 0.0010] | +0.0010 [0.0001, 0.0018] | −0.0006 [−0.0010, −0.0002] |
| KXMLBTB | 14,525 | **0.1520** | 0.1528 | 0.1530 | +0.0007 [0.0001, 0.0014] | +0.0010 [0.0003, 0.0017] | −0.0002 [−0.0006, 0.0001] |
| KXMLBHR | 4,069 | **0.1011** | 0.1019 | 0.1021 | +0.0008 [0.0003, 0.0013] | +0.0010 [0.0005, 0.0015] | −0.0002 [−0.0004, 0.0001] |
| KXMLBRBI | 7,399 | **0.1503** | 0.1511 | 0.1511 | +0.0007 [0.0001, 0.0014] | +0.0008 [0.0001, 0.0015] | −0.0001 [−0.0004, 0.0002] |
| KXMLBHRR | 17,906 | **0.1833** | 0.1843 | 0.1846 | +0.0010 [0.0001, 0.0020] | +0.0014 [0.0004, 0.0024] | −0.0003 [−0.0007, 0.0001] |
| KXMLBSB | 1,832 | **0.0944** | 0.0961 | 0.0962 | +0.0016 [0.0005, 0.0028] | +0.0018 [0.0006, 0.0030] | −0.0001 [−0.0003, 0.0000] |

**No series clears (A).** The exchange price is the better forecast in every
one, and the interval excludes zero in five of six — hits is the only series
where the difference could be zero, at +0.0004 [−0.0002, 0.0010]. Pooled, the
price wins by +0.0008 [0.0002, 0.0014].

T−30, where every lineup is posted, says the same thing: pooled +0.0009
[0.0004, 0.0015].

**The rebuild did transfer.** The rebuilt model beats the shipped one on the
holdout in every series, pooled by −0.0003 [−0.0006, −0.0000] and on hits by
−0.0006 [−0.0010, −0.0002]. It closed about a quarter of the gap to the price.
The Brier-optimal weight on (model − market) rises to 0.15 pooled and 0.30 on
hits, against 0.10 and 0.10 measured in the previous study.

### (B) Money — **FAIL on the interval**

T−120, one bet per player across all series, at the section-8 weights. n is the
number of contracts; the interval is the same game cluster bootstrap.

| set | fee | n | hit vs priced | ROI | CLV mid |
|---|---|---|---|---|---|
| `botOnePerPlayer` | **0.07** | 74 (50 games) | 55.4% vs 42.9% | **+24.8% [−0.1, 49.5]** | +0.19c |
| `botOnePerPlayer` | 0.035 | 74 | 55.4% vs 42.9% | +27.0% [1.6, 52.2] | +0.19c |
| `bot` | 0.07 | 87 | 52.9% vs 44.2% | +15.4% [−9.1, 40.2] | +0.17c |
| `every` | 0.07 | 245 (76 games) | 38.4% vs 33.8% | +9.0% [−13.1, 33.5] | −0.20c |
| `botOnePerPlayer` T−30 | 0.07 | 139 | 51.1% vs 41.9% | +17.5% [−1.8, 37.3] | +0.05c |

The headline number is **+24.8%, with a 95% interval of [−0.1, 49.5] that does
not exclude zero**, so (B) fails as pre-registered. At the half fee the interval
would clear (+27.0% [1.6, 52.2]) — but 0.07 is the fee the bar names, and a
result that depends on which fee you charge is not an edge.

Per series at fee 0.07, `bot`: HIT n=33 +10.8% [−18.6, 41.3]; TB n=26 +33.5%
[−21.0, 91.8]; HR n=6 +24.5% [19.1, 28.7]; HRR n=22 +1.0% [−43.4, 47.1]; SB
n=15 −64.4% [−100.0, −3.4]; RBI n=0. Home runs is the only cell whose interval
excludes zero and it has **six trades**, all of which won.

### The pre-registered test

| series | (A) Brier beats price | (B) ROI positive, CI excludes 0, fee 0.07 | passes |
|---|---|---|---|
| KXMLBHIT | no (+0.0004 [−0.0002, 0.0010]) | no (+10.8% [−18.6, 41.3], n=33) | **no** |
| KXMLBTB | no (+0.0007 [0.0001, 0.0014]) | no (+33.5% [−21.0, 91.8], n=26) | **no** |
| KXMLBHR | no (+0.0008 [0.0003, 0.0013]) | yes (+24.5% [19.1, 28.7], n=6) | **no** |
| KXMLBRBI | no (+0.0007 [0.0001, 0.0014]) | no (n=0) | **no** |
| KXMLBHRR | no (+0.0010 [0.0001, 0.0020]) | no (+1.0% [−43.4, 47.1], n=22) | **no** |
| KXMLBSB | no (+0.0016 [0.0005, 0.0028]) | no (−64.4% [−100.0, −3.4], n=15) | **no** |
| pooled | no (+0.0008 [0.0002, 0.0014]) | no (+24.8% [−0.1, 49.5], n=74) | **no** |

---

# Part 4 — Verdict

**The improved batter model does not beat the exchange price. Nothing passes.**

- On the holdout, over 56,105 priced contracts and 273 games, Kalshi's own
  decision-mid price forecast the outcome better than the rebuilt model in
  **every one of the six series**, with the 95% interval excluding zero in five
  of them. Pooled, the price wins by 0.0008 of Brier [0.0002, 0.0014].
- The money looks good and does not survive its own interval: 74 trades
  returned **+24.8%, 95% CI [−0.1, 49.5]** after the 0.07 fee. The point
  estimate is the best batter number this repo has produced, and the interval
  contains zero, contains −0.1%, and contains +49.5%. Seventy-four trades over
  three weeks cannot resolve an edge of any plausible size.
- The rebuild was not wasted. The rebuilt model is a better forecaster than the
  shipped one out of sample in every series, on the holdout, pooled by 0.0003
  of Brier [0.0000, 0.0006] in its favour. It closed about a quarter of the
  distance to the price and no more.

## What this adds to `docs/AUDIT.md`

The batter row of that table should now read: the model has been rebuilt on a
fit window six times larger than the last refit (31,986 batter-games against
5,274), with one structural change and one outright bug removed, and the price
is still the better forecaster in every series, with the interval excluding
zero in five of six. The pooled prop line moves from "1,232 trades, −3.7%" to
"−3.7% before the rebuild, +24.8% on 74 trades after it, interval [−0.1, 49.5]"
— which is not a change of conclusion, it is the same conclusion with a wider
interval on a shorter window.

## Why it fails, as far as the data will say

The gap that remains is 0.0008 of Brier on a 0.158 base — half a percent.
Everything measured here says it is not the model's baseball that is wrong:

- The projections are calibrated and their regression slopes are now 1.
- The plate-appearance distribution was shown, with an in-sample oracle, not to
  matter at all.
- Team plate appearances are 96% unpredictable from as-of data.
- Recent form carries no signal.
- Per-hitter platoon splits carry no signal once usage is accounted for.
- The bullpen, the batting order as a talent signal and prior-season
  quality-of-contact are each worth between nothing and 0.0001 of Brier.

What is left is the information the price has and the replay does not: today's
weather, the hitter's health, whether he is playing through something, whether
he is being rested in the sixth inning of a decided game, and the flow of money
from people who know those things. The replay has no weather at all, and the
market's edge over the model is about the size you would expect from that list.

There is one number pointing the other way, and it is small: closing-line value
turned positive (+0.19c on the traded side, against −0.14c for the shipped
model on VALIDATE), and the Brier-optimal weight on (model − market) rose from
0.10 to 0.15, and to 0.30 on hits. That is the model's disagreements carrying
slightly more information than they used to. It is not an edge; it is the
direction an edge would come from.

## What was changed in the code, and what was not

**Changed** (`src/model/batter.js`, all off or identity by default, so the
shipped projection is unchanged until someone turns them on):

- every prior strength and the 0.6 weight on 2025 are tunable knobs;
- `platoonStrength`, `platoonHrAmp`, `parkStrength`, `pitcherInfluence`,
  `slotPower`, `slotContact`, `bullpenShare`;
- `input.paDist` and `input.platoonOverride` overrides;
- `jointScoring`: section 11b, runs / RBI / H+R+RBI from one plate-appearance
  outcome distribution.

> **Superseded on 2026-09-23, later the same day: the rebuild was ported into
> `src/model/batter.js` and is now what the board runs.** The platoon term was
> deleted outright rather than set to zero, `jointScoring` is on, and every
> prior strength moved. `MARKET_WEIGHT`, the hurdle and `PLAY_RULES` were still
> not touched. The port was re-measured on this same holdout and reproduces the
> paired Brier improvement below to the fourth decimal in every series —
> `docs/BATTER-PORT.md`. Everything in this section describes the state of the
> code when this study was written and is left as the record of it.

**Not changed:** `BATTER_TUNING`'s defaults, `MARKET_WEIGHT`, the hurdle, the
bounds, `PLAY_RULES`. The rebuilt configuration is a better forecaster and it
still loses to the price, so switching the board over to it buys nothing a
trader can use, and `src/lib/constants.js` already says to raise `MARKET_WEIGHT`
only on closing-line value from graded results, not on a backtest optimum.
Turning the rebuild on is a one-line change (`--tuning tools/batter-rebuilt.json`
shows exactly which settings), and the case for it is forecast quality, not
edge. That is a decision for whoever owns the board, not for this study.

## Caveats

- **Seventy-four trades.** The ROI criterion had almost no power on a
  three-week holdout. The forecast criterion, on 56,105 contracts, had plenty,
  and it is the one that answered.
- **The holdout is a high-scoring September.** Brier levels are higher there
  (0.1587 pooled against 0.1477 on VALIDATE) for both the model and the price.
- **No weather.** The replay omits it entirely, which costs the model something
  on home runs and runs that the price does not pay.
- **Fills are idealised**, one contract at the quoted top of book, exactly as
  in `docs/KALSHI-BATTER-BACKTEST.md`.
- **The holdout ran with two RBI share vectors that summed to 0.996 instead of
  1** (fixed in a later commit). That put a floor of at most 0.0002 under every
  RBI and H+R+RBI tail. Re-measured on FIT and VALIDATE, the fix leaves Brier
  unchanged to five decimals on RBI, H+R+RBI and runs, so it cannot move any
  number in this report.
- **Two independent searches, one hand-built and one a 19-knob coordinate
  descent, converged to the same configuration** (FIT traded log loss 6.12001
  against 6.11934, a difference of 0.01%), and to VALIDATE Brier equal to four
  decimals. The result does not hang on which one was carried forward.
- **Runs and singles have no Kalshi series**, so they are reported against
  outcomes only. Against outcomes the rebuilt model improves both (VALIDATE
  Brier 0.15137 → 0.15112 for runs, 0.16919 → 0.16885 for singles).
- **`KXMLBSB` is not mapped in `src/lib/kalshi.js`**, so `planOrders` cannot
  see it and the bot could not have traded it. It is priced here by the same
  rules in the tool; that is a finding, not a workaround.
