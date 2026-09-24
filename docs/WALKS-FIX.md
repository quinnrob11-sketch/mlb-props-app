# The league walks more in April, and no average over a window knows that

`docs/REST-FIX.md` shipped a real fix and named the cell it left behind:

> The worst cell in the pitcher model is now a WALKS cell, and this branch does
> not touch walks at all. […] `p.month` **2026-04 walks, 4.68 points on 783
> starts, gap −4.4**, with 2025-04 walks at 4.26 on 782 behind it.

This branch takes it. **2026-04 is 2.28 and 2025-04 is 2.54**, with the gaps at
−1.1 and −0.7, and neither is in the top eight cells any more. Nothing was
measured against a price: `MARKET_WEIGHT`, `PLAY_RULES`, the trading hurdle and
everything under `src/trade/` are untouched, and so is `src/data/` — `git diff
f0b5909 -- src/data/ src/model/batter.js src/model/game.js src/model/edges.js
src/trade/ src/lib/constants.js` is empty. Only `src/model/pitcher.js`,
`test/pitcher.test.js` and `tools/` changed.

Names: **v38.2** is the base (`f0b5909`), **v38.3** is this branch. Both
seasons, lookahead-free, the existing replay, no new request to any metered
service.

**The brief's diagnosis is wrong, and the way it is wrong is the finding.** It
proposed a stale prior-season blend that has not caught up with the current
league environment. That is a real effect, it is measurable, and it is the
smaller half — and fitted, it explains 2026's April and gets 2025's wrong,
because the year-over-year drift it keys on differs between the two seasons
while the April miss does not. §2 measures it and says why it was not taken.

---

## 1. What is actually wrong

Every rate in this model is an average over a window. `shrunkRate` builds the
per-batter walk rate from the pitcher's current season to date, plus 0.6 of his
whole prior season, plus 80 batters of the as-of league starter rate. In April
the first of those is nearly empty, so the projection is about 86% last season
and 14% this one.

**The league's walk rate is not flat within a season.** Every plate appearance
in the majors, by day of season, each season expressed against its own BB/PA so
a between-season difference in the level cannot enter:

```
node tools/walks-fit.mjs --league .work/bb_26.ndjson
```

| doy band | 2024 | 2025 | 2026 | pooled | PA/yr |
|---|---|---|---|---|---|
| 4–7 | – | 1.222 | 1.092 | 1.146 | 848 |
| 8–11 | 1.070 | 1.088 | 1.102 | 1.087 | 4,042 |
| 12–15 | 1.128 | 1.007 | 1.098 | 1.078 | 3,505 |
| 16–21 | 1.115 | 1.128 | 1.126 | **1.123** | 6,036 |
| 22–28 | 1.075 | 1.058 | 1.102 | 1.078 | 7,136 |
| 29–35 | 1.039 | 1.064 | 1.025 | 1.042 | 6,961 |
| 36–45 | 0.995 | 1.005 | 1.021 | 1.007 | 10,141 |
| 46–55 | 1.019 | 0.999 | 1.040 | 1.019 | 9,971 |
| 56–70 | 0.944 | 0.978 | 0.946 | 0.956 | 14,873 |
| 71–90 | 0.974 | 0.975 | 0.985 | 0.978 | 19,694 |
| 91–120 | 0.967 | 0.974 | 0.956 | 0.966 | 26,798 |
| 121–160 | 0.993 | 0.995 | 0.987 | 0.992 | 40,662 |
| 161–220 | 0.999 | 0.981 | 0.982 | 0.988 | 28,291 |

It is a plateau for the first four weeks, a ramp down through week six, and
flat after that. It is the same curve in three seasons — the 16–21 band reads
1.115 / 1.128 / 1.126 — and **2024 is in that table and is out of sample**: no
2024 game is an outcome this model is ever scored against, and no coefficient
in `src/model/pitcher.js` was fitted against one. (2024 is not invisible to the
model: it is the prior season a 2025 start's `season25` line comes from. It is
an input there, never a target.)

An average over a window cannot carry that shape. A pitcher's prior season is
the whole-year level, which is the plateau and the flat part mixed together;
his current season to date is the same thing truncated. Tonight is not the
average of either. So the model reads about 9% low in April and about 2% high
from mid-May on, **for everyone at once**.

Measured against what happened, over the 9,404 starts of both seasons. "league"
is total walks over total batters faced in the window; "model" is the same
pool of projections over the same realised batters, so depth cannot confound it:

```
node tools/walks-fit.mjs --which .work/bb_2*.ndjson
```

| window | n | BF | league BB/BF | model BB/BF | ratio |
|---|---|---|---|---|---|
| 0–7 | 68 | 1,432 | 0.08589 | 0.07517 | 1.143 |
| 8–14 | 344 | 7,364 | 0.08487 | 0.07949 | 1.068 |
| 15–21 | 370 | 8,055 | 0.09199 | 0.07962 | 1.155 |
| 22–30 | 495 | 10,911 | 0.08688 | 0.08139 | 1.068 |
| 31–45 | 796 | 17,549 | 0.08348 | 0.08081 | 1.033 |
| 46–60 | 800 | 17,691 | 0.07874 | 0.08085 | 0.974 |
| 61–90 | 1,559 | 34,072 | 0.07745 | 0.07898 | 0.981 |
| 91–120 | 1,431 | 31,019 | 0.07798 | 0.07820 | 0.997 |
| 121–200 | 3,541 | 76,285 | 0.07944 | 0.07865 | 1.010 |

**The model's residual is the league's own seasonal curve.** Not approximately:
band for band, the two tables are the same object.

### It is a level, not a shrinkage-timing problem

The brief asked to separate these, because they need different fixes. Bias in
walks per start, cut by how much CURRENT-season book the pitcher has — `w26` is
the weight the blend puts on this season, `bf26 / (bf26 + 0.6·bf25)`:

| window | w26 = 0 | 0–0.15 | 0.15–0.35 | 0.35–0.6 | 0.6–1 |
|---|---|---|---|---|---|
| 0–21d | +0.225 (307) | +0.200 (378) | +0.325 (59) | −0.758 (10) | +0.654 (28) |
| 22–45d | +0.403 (48) | +0.338 (212) | +0.077 (726) | −0.094 (162) | +0.081 (143) |
| 46–90d | +0.122 (45) | +0.186 (60) | −0.015 (589) | −0.067 (1062) | −0.026 (603) |
| 91–200d | +0.113 (66) | −0.138 (44) | +0.150 (207) | −0.021 (2019) | −0.039 (2636) |

**In the first three weeks the whole row moves together**, at every thickness of
book, which is a level. A shrinkage-timing story predicts the opposite — the
miss concentrated in the thin columns and decaying across the row — and that is
what the 22–45d row looks like, faintly, and the 46–90d row does not. Read the
columns instead of the rows and the thin column is positive everywhere, which
is a real and separate thing; it is the `p.sample` thin slice, and it is
discussed in §6.

### The clock is the calendar, not the pitcher

"Pitchers are not stretched out" is a clock that runs per pitcher: his Nth start
of the year, wherever it falls. A man making his second start in June — a
call-up, or a man off the injured list — separates the two. Actual walks over
projected:

```
node tools/walks-fit.mjs --why .work/bb_2*.ndjson
```

| doy | start 1 | starts 2–3 | starts 4–6 | starts 7–11 | starts 12+ |
|---|---|---|---|---|---|
| 0–21d | 1.162 (329) | 1.113 (451) | – | – | – |
| 22–45d | 1.132 (89) | 1.174 (223) | 1.042 (801) | 0.997 (178) | – |
| 46–90d | **0.906 (125)** | 1.015 (203) | 1.056 (258) | 0.975 (1151) | 0.962 (622) |
| 91–200d | 0.991 (188) | 0.983 (278) | 0.985 (382) | 0.964 (611) | 0.991 (3513) |

**A man making his first start of the season in June comes in at 0.91 of his
projection, not 1.16.** The lift belongs to the date, not to the pitcher's own
mileage. That also rules the effect out as a starter phenomenon on its own: the
league table in §1 is every plate appearance, relievers included, and it carries
the same curve.

### It is walks alone

```
node tools/walks-fit.mjs --markets .work/bb_2*.ndjson
```

Actual over projected, by window:

| window | n | walks | K | hits | ER | outs | BB+HBP | HBP/BF vs the model's constant |
|---|---|---|---|---|---|---|---|---|
| 0–7 | 68 | 1.174 | 1.124 | 1.051 | 1.044 | 1.045 | 1.127 | 0.825 |
| 8–14 | 344 | 1.093 | 1.067 | 0.979 | 0.978 | 1.025 | 1.058 | 0.790 |
| 15–21 | 370 | **1.162** | 0.980 | 0.976 | 0.935 | 0.986 | 1.137 | 0.937 |
| 22–30 | 495 | 1.088 | 0.997 | 1.015 | 1.024 | 0.996 | 1.068 | 0.900 |
| 31–45 | 796 | 1.048 | 0.966 | 1.047 | 1.004 | 0.986 | 1.010 | 0.730 |
| 46–60 | 800 | 0.983 | 1.001 | 0.991 | 0.981 | 1.011 | 0.982 | 0.966 |
| 61–90 | 1,559 | 0.980 | 1.001 | 1.015 | 1.009 | 1.002 | 0.987 | 1.041 |
| 91–120 | 1,431 | 0.985 | 1.017 | 0.991 | 1.005 | 0.999 | 0.975 | 0.911 |
| 121–200 | 3,541 | 0.988 | 0.988 | 0.984 | 1.002 | 1.004 | 0.976 | 0.910 |

**Hit batsmen do not join in.** League HBP per PA is −7.3% in April 2025 and
+1.0% in April 2026 — no shape at all — and the last column says the model's
`HBP_PER_BF` constant of 0.011 runs about 10% high in every window, which is a
level and not a season. The BB+HBP column is therefore the walks column shifted
down by that constant and carrying the same curve. **Strikeouts are not the
mirror image**: league K/PA is
−0.5% and −1.6% in the two Aprils, and the only strikeout lift here is the first
two weeks, which is 412 starts and dies before the walks lift does. Only walks
carry a seasonal shape, which is why only walks get a term.

## 2. The four things it could have been instead

### Not a stale prior-season blend — this is the brief's hypothesis, and it loses

The obvious fix, and the one the brief proposed: re-express the pitcher's book
in tonight's league environment. For each start,

```
envRatio = lgNow / (w26 · lgNow + (1 − w26) · lgPrev)
```

with `lgNow` the as-of league starter walk rate the model was actually handed
and `lgPrev` the prior season's true whole-season one — 0.07582 for 2024,
0.07790 for 2025 — which this tool fetches and the shipped model never sees.
It does track the miss:

| envRatio | n | proj | actual | ratio | predicted | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| 1.00–1.02 | 3,711 | 1.765 | 1.730 | 0.980 | 1.008 | 0.972 | 0.997 |
| 1.02–1.05 | 2,788 | 1.706 | 1.697 | 0.995 | 1.031 | 0.976 | 1.008 |
| 1.05–1.08 | 1,040 | 1.728 | 1.730 | 1.001 | 1.064 | 1.009 | 0.995 |
| 1.08–1.12 | 965 | 1.714 | 1.825 | 1.065 | 1.099 | 1.127 | 1.011 |
| 1.12–1.20 | 771 | 1.717 | 1.914 | 1.115 | 1.149 | 1.103 | 1.118 |
| 1.20+ | 105 | 1.675 | 1.781 | 1.064 | 1.406 | 1.058 | 1.076 |

And fitted as `projBB · envRatio^beta` on the FIT split it is real: beta 0.386 ±
0.105 at the 2025 reference, t = 3.7. **But it does not replicate.** With the
true prior-season rate, beta is **0.264 in 2025 against 0.465 in 2026** — the
two seasons disagree by a factor of nearly two. The calendar lift, on the same
two seasons and the same starts, is **1.080 and 1.097**.

The reason is arithmetic, it is measurable, and it is what tells the two
stories apart. Over the early window of each season:

| | prior weight in the blend | model BB/BF | realised BB/BF | ratio |
|---|---|---|---|---|
| 2025, doy < 45, n=992 | 0.263 | 0.07893 | 0.08352 | 1.075 |
| 2026, doy < 45, n=1,025 | 0.247 | 0.08176 | 0.08850 | 1.100 |

The league walked 6.0% more in the early window of 2026 than in 2025 (0.08850
against 0.08352). **The model's own projected rate rose 3.6% over the same pair
of windows** (0.08176 against 0.07893), because a quarter of the blend is the
as-of league prior and that prior knows. What is left unabsorbed is 2.4 points,
and the gap between the two seasons' misses is 2.4 points: 1.100 against 1.075.
**The environment story accounts for the whole of the between-season half of
the miss and for none of the 7.5% that is common to both seasons.** The curve in
§1 accounts for both, because the between-season part is already in the as-of
prior and only the within-season shape is missing.

It also could not ship as designed. `lgPrev` is not an input `projectPitcher`
has, and `src/data/` is out of scope for this branch, so a term needing it would
be inert on the live board — which is the reason the tool fetches it and the
model does not.

### Not temperature

```
node tools/walks-fit.mjs --weather .work/bb_2*.ndjson
```

First-pitch temperature from the Open-Meteo reanalysis archive, matched by the
first-pitch hour exactly the way `tools/game-features-asof.mjs` builds the game
model's weather. 9,399 of 9,404 starts have one. The raw gradient is strong:

| tempF | n | ratio | BB/BF | mean doy | share April |
|---|---|---|---|---|---|
| <45 | 202 | **1.220** | 0.09827 | 20 | 0.99 |
| 45–52 | 304 | 1.045 | 0.08505 | 29 | 0.86 |
| 52–60 | 578 | 1.054 | 0.08391 | 45 | 0.56 |
| 60–68 | 1,191 | 1.054 | 0.08370 | 71 | 0.37 |
| 68–75 | 1,699 | 1.011 | 0.08081 | 101 | 0.18 |
| 75–82 | 2,416 | 0.991 | 0.07938 | 108 | 0.16 |
| 82+ | 3,009 | 0.975 | 0.07711 | 116 | 0.05 |

and almost all of it is the calendar wearing a coat. Cross-cut:

| doy | <55F | 55–68F | 68–78F | 78F+ |
|---|---|---|---|---|
| 0–21d | 1.168 (308) | 1.129 (188) | 1.131 (142) | **1.068 (144)** |
| 22–45d | 1.139 (268) | 1.075 (458) | 1.040 (313) | 0.997 (248) |
| 46–90d | **0.880 (122)** | 1.016 (610) | 1.013 (734) | 0.944 (893) |
| 91–200d | – | 1.040 (321) | 0.986 (1443) | 0.982 (3207) |

**The calendar survives the temperature control in every temperature band** —
the 0–21d row is 1.07 to 1.17 whether it is 50 degrees or 85 — while cold
survives the calendar control only inside the early window, where it is
confounded with it, and reverses in the 46–90d row. There is something small
left in the 22–45d row (1.139 to 0.997 across the bands) and it is not
separable from "April is cold". A physical mechanism would beat a calendar term
if it fitted better, and this one does not. It is also unbuildable here:
`projectPitcher` has no weather input, and adding one means `src/data/`.

### Not the umpires, and not something this branch can see

A cold-weather strike zone is a perfectly good story for WHY the league walks
more in April, and this branch cannot test it — pitch-level called-strike data
is a different fetch and a different study. What the term encodes is the effect,
measured league-wide over three seasons, not the mechanism behind it.

### Not the drift term that already exists, and now we know why it failed

`PITCHER_FIT.progress` already carries the machinery for a per-market function
of the calendar, and its comment records that a walks drift was fitted
(−0.0545 per 100 days, replicated in both seasons) and **not shipped because it
made walks worse, 0.94 → 1.29**. §1 explains that: the shape is not a trend. It
is a plateau and a step. An exponential in days fitted through it has to trim
September to pay for April, and September does not want trimming — it is 0.988
of the season average and the model already reads it 2 points high. The new
term is exactly 1 from day 45 on and cannot do that.

## 3. The term

```js
early: { hold: 25, cap: 45, amp: { bb: 0.1134 } }
```

`1 + amp` through `hold` days from March 20, straight down to exactly 1 at
`cap`, and exactly 1 from there on — the same plateau-and-ramp shape
`PITCHER_FIT.rest` uses, pointing the other way. Applied in `calibrated()`
beside the existing `driftFor`, so it multiplies the walks projection and the
distribution priced from it identically, and `amp` is keyed by market so every
other market is untouched by construction.

**The amplitude is fitted on the league curve, not on any residual of this
model.** Weighted least squares of the daily rebased index on that shape,
weights = plate appearances, over 2024, 2025 and 2026:

| hold | cap | amp | se | t | 2024 | 2025 | 2026 | wSSE |
|---|---|---|---|---|---|---|---|---|
| 14 | 45 | 0.1356 | 0.0150 | 9.0 | 0.1330 | 0.1233 | 0.1496 | 6234 |
| 21 | 45 | 0.1213 | 0.0133 | 9.1 | 0.1176 | 0.1111 | 0.1342 | 6221 |
| **25** | **45** | **0.1134** | **0.0126** | **9.0** | **0.1102** | **0.1035** | **0.1256** | 6238 |
| 25 | 50 | 0.1099 | 0.0122 | 9.0 | 0.1063 | 0.1011 | 0.1215 | 6236 |
| 28 | 45 | 0.1082 | 0.0121 | 8.9 | 0.1047 | 0.0995 | 0.1196 | 6253 |
| 32 | 45 | 0.1019 | 0.0116 | 8.8 | 0.0976 | 0.0952 | 0.1122 | 6276 |
| 21 | 55 | 0.1133 | 0.0124 | 9.1 | 0.1093 | 0.1043 | 0.1255 | 6215 |
| 14 | 55 | 0.1256 | 0.0137 | 9.2 | 0.1221 | 0.1149 | 0.1388 | 6213 |

Over `hold` 14–32 and `cap` 40–55 the amplitude moves between 0.096 and 0.141
and `t` sits at 8.8–9.2 throughout. **The weighted residual is flat to within 1%
across the whole grid** — it is dominated by day-to-day noise and cannot choose
a geometry — so the geometry was chosen on the banded curve in §1 instead, which
plateaus through day 28 and is back to 1 by day 45:

| doy | observed | fitted at (25, 45) |
|---|---|---|
| 5.5 | 1.166 | 1.113 |
| 9.5 | 1.106 | 1.113 |
| 13.5 | 1.097 | 1.113 |
| 18.5 | 1.143 | 1.113 |
| 25 | 1.098 | 1.113 |
| 32 | 1.061 | 1.074 |
| 40.5 | 1.025 | 1.026 |
| 50.5 | 1.037 | 1.000 |
| 63 | 0.973 | 1.000 |
| 80.5 | 0.995 | 1.000 |

(25, 45) is interior to both sweeps. The exponential alternative,
`1 + amp·(e^(−d/τ) − e^(−cap/τ))/(1 − e^(−cap/τ))`, was fitted on the same data
and is measurably the wrong shape — its best weighted residual over the same
sweep is 6244 against the ramp's 6213, and at its central geometry (τ 20, cap
75, amp 0.2555) it puts 1.193 at day 5.5 and 1.098 at day 18.5 against an
observed curve that is flat between them.

**Everything is expressed against the level the curve settles at from day 75 on
(0.9825 of the season average), not against the season average**, because the
season average is itself pulled up by the early weeks and the model's baseline
is not. That choice is what makes the term exactly 1 outside the early window,
and §5 confirms that the model's late-season residual sits where that rebasing
says it should.

### The same shape, fitted the other way

```
node tools/walks-fit.mjs --fit .work/bb_2*.ndjson
```

Fitted instead by least squares of actual walks on `projBB · earlyMul(doy)` over
the FIT split — a different target, on different data, at the level of
individual starts rather than league plate appearances:

| hold | cap | amp | se | t | 2025 | 2026 |
|---|---|---|---|---|---|---|
| 21 | 45 | 0.1137 | 0.0209 | 5.4 | 0.0878 | 0.1378 |
| **25** | **45** | **0.1061** | **0.0197** | **5.4** | 0.0816 | 0.1290 |
| 28 | 45 | 0.1005 | 0.0189 | 5.3 | 0.0779 | 0.1217 |

**0.1061 ± 0.0197 against the league curve's 0.1134 ± 0.0126** — half a standard
error apart, from two sources that share no data. The shipped value is the
league one, because it is measured on 537,000 plate appearances over three
seasons rather than 8,405 starts over two, and because fitting a coefficient to
the residual of the model you are about to put it in is the thing this document
would otherwise have to apologise for.

### How a calendar term is tested out of sample, honestly

**VALIDATE (2026-08-10 .. 2026-09-01) contains no April and no March. Neither
does the holdout.** Both are byte-identical before and after — walks ECE 3.36
and 2.54 in the two windows, unchanged to the decimal — so neither can say
anything about this term, and no claim below rests on either. That is stated
plainly rather than dressed up: the usual out-of-sample window is silent here.

What can test it is the cross-season split, because 2025's April and 2026's
April are disjoint sets of starts:

| | early-window bias, before → after |
|---|---|
| amp fitted on **2025**'s residual (0.0816) → read **2026**'s early window, n=1,025 | +0.173 → **+0.068** |
| amp fitted on **2026**'s residual (0.1290) → read **2025**'s early window, n=992 | +0.129 → **−0.035** |
| amp from the **2024 league curve alone** (0.1102) → 2025 | +0.129 → **−0.011** |
| amp from the **2024 league curve alone** (0.1102) → 2026 | +0.173 → **+0.031** |
| the **shipped** amp (0.1134) → 2025 | +0.129 → **−0.015** |
| the **shipped** amp (0.1134) → 2026 | +0.173 → **+0.026** |

The third and fourth rows are the strongest thing in this document. **0.1102 is
the amplitude the 2024 league curve asks for on its own** — a number chosen with
no knowledge of any 2025 or 2026 outcome, and none of this model's existence —
and it closes both Aprils to within 0.03 walks a start.

## 4. Before and after

Same harness as `docs/ACCURACY.md`, `docs/PITCHER-REPAIR.md` and
`docs/REST-FIX.md`.

```
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --out .work/v383_25.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --out .work/v383_26.ndjson
node tools/accuracy-report.mjs .work/v383_2*.ndjson --slices --holdout 2026-09-02
# v38.2: add --fit '{"early":null}'
```

### Every pitcher market by month — main window, 9,021 starts

Calibration error in points, and the gap in points. **Four of the five markets
are byte-identical in every month**, so they are printed once: the term is one
multiplier on one market and `amp` has one key.

| month | n | walks v38.2 | **v38.3** | gap v38.2 | **gap v38.3** | bias v38.2 | **v38.3** | K | outs | hits | ER |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2025-03 | 130 | 5.33 | **1.61** | −5.3 | **−1.2** | +0.179 | **−0.006** | 2.16 | 4.63 | 1.39 | 1.70 |
| 2025-04 | 782 | 4.26 | **2.54** | −4.0 | **−0.7** | +0.147 | **−0.004** | 1.63 | 1.96 | 2.43 | 1.53 |
| 2025-05 | 822 | 1.94 | 1.96 | +1.0 | +1.1 | −0.057 | −0.059 | 1.02 | 1.78 | 0.98 | 2.18 |
| 2025-06 | 792 | 1.39 | 1.39 | −0.5 | −0.5 | +0.008 | +0.008 | 0.97 | 1.41 | 0.80 | 1.51 |
| 2025-07 | 738 | 1.10 | 1.10 | +0.5 | +0.5 | −0.037 | −0.037 | 1.20 | 1.23 | 1.37 | 1.17 |
| 2025-08 | 842 | 1.62 | 1.62 | +0.2 | +0.2 | −0.025 | −0.025 | 1.13 | 2.33 | 1.40 | 3.65 |
| 2025-09 | 748 | 2.90 | 2.90 | +2.0 | +2.0 | −0.112 | −0.112 | 1.37 | 1.79 | 3.64 | 1.67 |
| 2026-03 | 152 | 6.29 | **2.47** | −6.3 | **−2.2** | +0.249 | **+0.062** | 5.82 | 2.78 | 2.70 | 2.12 |
| 2026-04 | 783 | **4.68** | **2.28** | −4.4 | **−1.1** | +0.171 | **+0.017** | 1.87 | 1.23 | 1.74 | 0.79 |
| 2026-05 | 838 | 1.64 | 1.62 | −0.2 | −0.2 | −0.010 | −0.012 | 1.86 | 1.38 | 1.44 | 2.20 |
| 2026-06 | 788 | 1.71 | 1.71 | +1.0 | +1.0 | −0.057 | −0.057 | 1.03 | 1.48 | 3.27 | 2.27 |
| 2026-07 | 742 | 1.77 | 1.77 | +0.5 | +0.5 | −0.028 | −0.028 | 0.71 | 1.78 | 0.66 | 1.01 |
| 2026-08 | 834 | 2.92 | 2.92 | −2.6 | −2.6 | +0.100 | +0.100 | 2.21 | 1.71 | 1.33 | 1.50 |
| 2026-09 | 413 | 2.44 | 2.44 | +0.7 | +0.7 | −0.056 | −0.056 | 2.39 | 1.76 | 2.04 | 2.89 |

**The rest of the calendar does not move.** June through September is identical
to the digit in both seasons; May moves by 0.02 of a point in each, because the
ramp reaches the first three days of May and a handful of starts sit on it.
**7,004 of the 9,021 starts on the board are byte-identical**; the 2,017 that
move are every start inside 45 days of March 20.

### The two April ladders, quoted → observed

| 2026-04, n=783 | BB > 0.5 | > 1.5 | > 2.5 | > 3.5 |
|---|---|---|---|---|
| v38.2 | 81.5 → 86.0 | 51.7 → 58.1 | 26.2 → 30.9 | 10.9 → 12.9 |
| **v38.3** | 83.9 → 86.0 | 56.0 → 58.1 | 30.2 → 30.9 | 13.5 → 12.9 |

| 2025-04, n=782 | BB > 0.5 | > 1.5 | > 2.5 | > 3.5 |
|---|---|---|---|---|
| v38.2 | 81.2 → 83.0 | 50.9 → 57.5 | 25.2 → 30.8 | 10.3 → 12.1 |
| **v38.3** | 83.6 → 83.0 | 55.2 → 57.5 | 29.2 → 30.8 | 12.7 → 12.1 |

Four to six points low at three rungs of four, in both seasons, to within about
two points afterwards.

### Every pitcher market, pooled — main window

| | v38.2 | **v38.3** |
|---|---|---|
| **walks, cal. err** | **1.10** [0.73, 1.58] | **1.01** [0.76, 1.44] |
| walks, gap | −0.8 | **−0.1** |
| walks MAE / corr | 1.007 / 0.260 | **1.006 / 0.266** |
| walks Brier | 0.1618 | **0.1613** |
| walks bias | +0.016 (+0.9%) | −0.016 (−0.9%) |
| strikeouts, cal. err | 0.40 | 0.40 |
| outs recorded, cal. err | 0.77 | 0.77 |
| hits allowed, cal. err | 0.55 | 0.55 |
| earned runs, cal. err | 1.02 | 1.02 |
| every other market's MAE, corr and Brier | | unchanged to the digit |

**Every walks number improves and nothing else changes at all.** The pooled walk
level goes from 0.9% under to 0.9% over, which is the cancellation in §6.

### Every other slice — only walks cells moved, and these are all of them

`diff` of the two `--slices` passes, in full:

| slice | n | v38.2 | **v38.3** | gap v38.2 | **gap v38.3** |
|---|---|---|---|---|---|
| `p.sample` **thin (≤3 prior starts)** | 2,394 | 3.59 | **1.50** | −3.4 | **−1.2** |
| `p.rest` **unknown (no previous start)** | 729 | 3.45 | **2.33** | −3.0 | **−0.9** |
| `p.length` **mid (4.5–5.5 IP)** | 4,880 | 1.86 | **1.47** | −1.8 | **−0.9** |
| `p.side` away | 4,699 | 1.56 | **1.11** | −1.4 | **−0.7** |
| `p.rest` long (6–7d) | 5,000 | 1.86 | **1.60** | −1.3 | **−0.7** |
| `p.season` 2026 | 4,548 | 1.82 | **1.67** | −1.2 | **−0.4** |
| `p.length` short (<4.5 IP) | 1,017 | 1.88 | **1.87** | −0.0 | +0.7 |
| `p.sample` building (4–10) | 2,873 | **1.35** | 1.40 | +0.2 | +0.6 |
| `p.season` 2025 | 4,854 | **0.81** | 0.99 | −0.3 | +0.4 |
| `p.side` home | 4,703 | **1.06** | 1.29 | −0.0 | +0.6 |
| `p.rest` very long (8d+) | 1,006 | **1.97** | 2.12 | +1.3 | +1.4 |
| `p.length` full (5.5+ IP) | 3,505 | **1.23** | 1.60 | +0.6 | +1.1 |
| `p.rest` normal (5d) | 2,637 | **0.87** | 1.33 | +0.2 | +0.8 |

Six cells better, seven worse, and the split is not arbitrary: every cell that
improves is one where early-season starts are over-represented, and every cell
that degrades does so by 0.05 to 0.46 of a point because the pooled level moved
0.9% up — §6.

## 5. The 4.9–5.5 innings band: the same defect, from another angle

`docs/PITCHER-REPAIR.md` reported "a persistent −1.6 to −3.0 point gap through
the 4.9–5.5 IP band where most of the board lives" and listed it beside the
April error as a second thing wrong with walks. It is not a second thing.

```
node tools/walks-fit.mjs --band .work/bb_2*.ndjson
```

| projIP | n | proj | actual | ratio | gap | mean doy | share ≤45d |
|---|---|---|---|---|---|---|---|
| 0–4.0 | 475 | 0.943 | 0.901 | 0.955 | +1.0 | 99 | 0.179 |
| 4.0–4.5 | 121 | 1.765 | 1.628 | 0.923 | +2.5 | 120 | 0.074 |
| 4.5–4.9 | 1,302 | 1.848 | 1.829 | 0.989 | −0.2 | 108 | 0.147 |
| **4.9–5.2** | **2,244** | 1.806 | 1.892 | **1.048** | **−2.5** | 91 | **0.311** |
| 5.2–5.5 | 2,705 | 1.777 | 1.791 | 1.008 | −0.7 | 102 | 0.180 |
| 5.5–5.8 | 2,010 | 1.726 | 1.717 | 0.995 | −0.1 | 90 | 0.215 |
| 5.8+ | 547 | 1.626 | 1.581 | 0.973 | +0.9 | 77 | 0.311 |

**The band is 31% early-season against 15–18% for the bands on either side of
it.** In April a rotation is on a shorter leash and the depth model puts more of
it at 4.9–5.2 innings than at any other time of year, so that band collects the
April starts. Cut both ways at once, ladder gap in points:

| doy | IP 0–4.5 | IP 4.5–4.9 | IP 4.9–5.5 | IP 5.5+ |
|---|---|---|---|---|
| 0–21d | – (31) | −2.4 (85) | **−7.2 (525)** | +0.1 (141) |
| 22–45d | +0.4 (63) | −2.5 (107) | −3.9 (659) | −2.5 (462) |
| 46–90d | +0.2 (158) | +0.7 (290) | **−0.7 (1078)** | +1.7 (833) |
| 91–200d | +3.7 (344) | −0.1 (820) | **−0.1 (2687)** | −0.0 (1121) |

**Outside the early window the 4.9–5.5 band reads −0.7 and −0.1 on 3,765
starts.** There is nothing there. The band error is the April error, seen
through a cut that happens to concentrate April. After the term:

| doy | IP 0–4.5 | IP 4.5–4.9 | IP 4.9–5.5 | IP 5.5+ |
|---|---|---|---|---|
| 0–21d | – (31) | +1.9 (85) | **−3.0 (525)** | +4.4 (141) |
| 22–45d | +1.9 (63) | +0.1 (107) | −1.3 (659) | −0.2 (462) |
| 46–90d | +0.2 (158) | +0.7 (290) | −0.7 (1078) | +1.7 (833) |
| 91–200d | +3.7 (344) | −0.1 (820) | −0.1 (2687) | −0.0 (1121) |

and the `p.length` mid slice goes 1.86 → 1.47 with its gap halved, without a
depth term of any kind.

## 6. What is still wrong

- **The pooled walk level goes from 0.9% under to 0.9% over, and it is a
  cancellation being exposed rather than damage.** The board's walk gap was −0.8
  points before this branch. That was **−4.06 points on the 2,017 early-season
  starts against +0.17 on the other 7,004**. This branch takes the −4.06 to
  −0.88 and leaves the +0.17 exactly where it is — measured, on the same file,
  `rest doy>=45: 0.17 -> 0.17`. The
  pooled figure was being flattered by the two offsetting. The pooled
  calibration error still improves (1.10 → 1.01) and so does the pooled gap
  (−0.8 → −0.1), because calibration is not the same statistic as the level —
  but every slice in §4 that degrades, degrades for this reason and for no
  other.
- **The +0.17 residual on the rest of the season was deliberately not chased, and
  it is not a level.** It is −2.6% in 2025 and −0.6% in 2026 over the same
  window — the model over-projects walks after mid-May in one season and not the
  other — and the league curve's own mid-season dip (0.956 at days 56–70, 0.966
  at 91–120) says a trim is warranted while the model's residual does not
  replicate well enough to size one. Applying the full season-normalised curve
  instead of the rebased one would trim June and July by 3–4% and is the obvious
  next question; it was not taken here because it would be a second thing fitted
  in the same branch, and because the one month it would help least is August,
  which is the month the model is already worst in.
- **The first three weeks are still short.** Actual over projected, by day band,
  before → after: 1.174 → 1.054 (0–7d), 1.093 → 0.982 (8–14d), 1.162 → 1.043
  (15–21d), 1.088 → 0.986 (22–30d), 1.048 → 1.009 (31–45d). The plateau is one
  height and the observed curve is a little above it in the first week, where
  the as-of league rate the model is handed is built from three days of games.
  A higher plateau for the first week is one more constant fitted to 412 starts
  and it was not taken.
- **Inside the early window the lift is uniform and the need is not.** The
  after-table in §5 shows the 5.5+ cell at 0–21 days going +0.1 → +4.4 on 141
  starts and the 4.5–4.9 cell −2.4 → +1.9 on 85, while the 525-start cell
  between them goes −7.2 → −3.0. A league-wide environment factor applies to
  everyone by construction; a depth-dependent version would be a second term on
  the same 2,017 starts and both of those cells are inside their own noise.
- **`p.rest` "unknown" and `p.sample` "thin" are better but not fixed** — 3.45 →
  2.33 and 3.59 → 1.50. Reading the columns of the `--which` table rather than
  the rows, a pitcher with almost no current-season book is under-projected in
  every window, not only in April: +0.12 and +0.19 at 46–90 days on 45 and 60
  starts. That is a thin-sample problem, it is separate from this one, and it is
  too small a sample here to fit.
- **August 2026 is untouched and is now the worst walks cell** — 2.92 points on
  834 starts, gap −2.6, the model 5.7% under. `PITCHER_FIT.progress`'s own
  comment already named it ("2026's walk rate jumped in August against the
  trend"), the league table in §1 agrees (2026-08 is +1.1% of its season against
  2026-07's −4.6%), and one month in one season is not something to fit.
- **2026-03 is still 2.47** on 150 starts, against 2025-03's 1.61. March is the
  first ten days, it is the noisiest part of the curve in every season of the
  league table, and it is below the 500-record reading in any case.
- **The amplitude's third season is the weakest of the three.** 0.1102 / 0.1035
  / 0.1256 for 2024 / 2025 / 2026 — 2026 is 21% above 2025. That is a better
  replication than `PITCHER_FIT.rest`'s (0.1112 against 0.0715) and a worse one
  than `bend`'s (0.0938 against 0.0941), and the pooled value ships.

### Caveats a reader should hold

- **VALIDATE and the contaminated holdout are silent on this term.** Neither
  window contains a start inside 45 days of March 20, both are byte-identical
  before and after, and nothing here is supported by either. The out-of-sample
  evidence is the cross-season test in §3 and the 2024 league season.
- **The replay does not post lineups**, same as `docs/ACCURACY.md`,
  `docs/PITCHER-REPAIR.md` and `docs/REST-FIX.md`: the opponent's team aggregate
  is used, which is `loadSlate`'s own fallback. It affects both columns
  identically.
- **The league curve and the model residual are not independent for 2025 and
  2026.** They are different measurements of overlapping baseball — 537,000
  plate appearances against 9,404 starts — and their agreement (0.1134 against
  0.1061) is evidence about the shape and the size, not two independent samples.
  2024 is the independent one.
- **`SP_TO_LEAGUE_BB` is assumed constant across the season.** The league table
  is all-pitcher BB/PA; starters and relievers could in principle have different
  seasonal shapes. Measured on the starts in this replay — 9,404 of them
  against the league's 537,000 plate appearances, so with a much larger error —
  the STARTER walk rate against its own season reads 1.062 / 1.055 / 1.143 /
  1.080 / 1.039 over the 0–7, 8–14, 15–21, 22–30 and 31–45 day bands, and 0.979
  / 0.963 / 0.970 / 0.991 after them. That is the same curve, at the same
  height, as the all-pitcher one in §1.
- **Nothing here was measured against a price**, and nothing here should be read
  as a reason to trade.

## What falls back

`test/pitcher.test.js` pins every row: 5 tests added, **270 passing**, none
loosened, none skipped, none edited.

| missing | what the model does |
|---|---|
| **`input.date`** | no clock, so the term is inert and every projection is **v38.2 to the last bit** — the same gate `progress` already uses |
| **a start at or after `cap`** | exactly v38.2, which is 7,004 of the 9,021 starts on the board |
| **`PITCHER_FIT.early`** set to null, or to `{}` | exactly v38.2 |
| **`early.amp`** empty, or `{bb: 0}`, or `{bb: null}` | exactly v38.2 |
| **a geometry with `cap <= hold`, or `cap` 0** | exactly v38.2 |
| a market with no key in `early.amp` | not touched — strikeouts, outs, hits and earned runs, always |
| a game played BEFORE March 20 — a Tokyo or Seoul opener | day zero, not a negative day, so the ramp can never run backwards |
| **`PITCHER_FIT.progress`** set to null | `early` still fires; the two share `input.date` and nothing else |
| adding a second market | one object: `amp: {bb: 0.1134, k: …}`, and a test pins it |

## Supersedes

`docs/REST-FIX.md`'s "what is still wrong", in one place. Its "the worst cell in
the pitcher model is now a WALKS cell … `p.month` 2026-04 walks, 4.68 points on
783 starts" is repaired: **2.28**, with 2025-04 at 2.54, and neither is in the
top eight by either reading.

`docs/PITCHER-REPAIR.md`'s reading that walks have two problems — "a persistent
−1.6 to −3.0 point gap through the 4.9–5.5 IP band … and 4.7 points in April in
both seasons" — is superseded: they are one problem. The band is 31%
early-season against 15–18% either side of it, and outside the early window it
reads −0.7 and −0.1 on 3,765 starts.

**The worst cell in the pitcher model is now `p.month` 2025-08 earned runs, 3.65
points on 842 starts, gap −3.6**, with 2025-09 hits at 3.64 on 748 behind it.
Under `accuracy-report`'s own n≥120 floor it is `p.month` 2026-03 strikeouts,
5.82 on 150, gap −5.8 — a cell this branch does not touch and which the league
table in §1 says is not a walks-shaped problem. The worst walks cell is 2026-08
at 2.92.
