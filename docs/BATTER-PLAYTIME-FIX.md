# Playing time: the other half of the curve, and what the lineup-slot term actually does (2026-09-23)

`docs/BATTER-CALIBRATION-FIX.md` closed the bottom of the batter model's
playing-time curve — the thin-hitter ramp, which is exactly zero from 70 plate
appearances upward — and stopped, deliberately, in front of two things it had
measured but not fixed:

1. **Established hitters (200+ PA this season) read −1.0 on runs and −1.1 on
   H+R+RBI, mirrored by +0.5 in the 50–199 cell.** It needed a two-sided
   playing-time tilt; that branch had already spent its holdout on the thin
   work, so it wrote the finding down and left it.
2. **The within-hitter lineup-slot axis came out at −0.27**, pointing the wrong
   way: the model raises a hitter when he moves up the order and he does
   slightly worse.

This branch does (1) and settles (2). The short version:

- **(1) is half fixed, and the other half cannot be fixed by a playing-time
  term without moving the error somewhere else.** The plate-appearance half is
  real, structural and now corrected; the runs/RBI *rate* half is measured,
  reported and deliberately not shipped.
- **(2) was a misattribution.** The lineup-slot term is correctly signed and
  roughly correctly scaled (+0.80 on hits, +1.21 on runs). The −0.27 came from
  bundling the slot axis together with a second axis — the model's own season
  line drifting underneath the hitter — and *that* axis is the one pointing the
  wrong way, at −1.7 to −2.4.

Nothing here is fitted against a price. `MARKET_WEIGHT`, `PLAY_RULES`, the
trading hurdle and everything under `src/trade/` are untouched; the only file
changed under `src/` is `src/model/batter.js`. No Odds API call, no Kalshi
call: public MLB StatsAPI only, cached on disk.

---

## 0. The validation scheme, and why

**Scheme (a): fit on 2025 alone, test once on 2026 through 09-01.**

| window | dates | batter-games | used for |
|---|---|---|---|
| **FIT** | 2025 season | 43,776 | everything — solving the term, choosing its shape, cross-validation |
| **TEST** | 2026-03-20 .. 2026-09-01 | 37,530 | looked at once, at the end |
| holdout | 2026-09-02 .. 09-22 | 4,914 | **contaminated. Confirmatory only.** |

**The September holdout is spent.** `docs/BATTER-CALIBRATION-FIX.md` looked at
it, and a window that has been looked at is not a clean test of a curve fitted
on the rest, no matter how little of it was used. It is reported here because
leaving it out would be its own kind of dishonesty, but it is reported as
confirmation of a direction, never as evidence that anything generalises.

Why (a) rather than k-fold: a full season is enough to solve a four-parameter
monotone curve, and it leaves a **season-scale** untouched window, which is the
only kind that can catch a term that has quietly fitted the shape of one
year. One caveat stated precisely rather than glossed: 2026 is not virgin in an
absolute sense, because the predecessor's thin ramp was fitted on 2025 plus
2026 through 08-09. But that term is **identically zero above 70 plate
appearances**, so for the 50–199 and 200+ bands — which are the target here —
the 2026 window carries no fitted footprint at all.

Cross-validation is used too, but inside the fit season and for a different
job: **5-fold, grouped by hitter**, to check that the solved parameters are
stable and to compare candidate shapes without spending the test window. Folds
are by hitter-season and never by row or date, because the thing being fitted
is a property *of the hitter*; splitting rows at random would put his April in
the training fold and his May in the test fold.

---

## 1. The axis is plate appearances **per game**, not plate appearances

This is the whole finding, and it was not what the previous branch assumed.

Bucketing by plate appearances so far — the axis `thin` is indexed on — the
ratio of actual plate appearances to projected spans **four points**: 0.99
below 200 PA, 1.01–1.03 above. Bucketing by **this season's plate appearances
per game played**, it spans **fourteen**, monotonically, and replicates season
by season with no rescaling:

| PA per game | n (2025) | actual PA / projected, 2025 | 2026 through 09-01 |
|---|---|---|---|
| under 2.0 | 469 | **0.933** | **0.894** |
| 2.0–2.6 | 1,974 | 0.945 | 0.914 |
| 2.6–3.0 | 2,487 | 0.956 | 0.967 |
| 3.0–3.3 | 3,968 | 0.981 | 0.969 |
| 3.3–3.6 | 4,278 | 1.002 | 0.998 |
| 3.6–3.85 | 6,140 | 1.015 | 1.022 |
| 3.85–4.05 | 5,298 | 1.021 | 1.027 |
| 4.05–4.25 | 7,142 | 1.024 | 1.032 |
| 4.25–4.45 | 6,812 | 1.018 | 1.023 |
| 4.45+ | 2,679 | **1.024** | **1.026** |

**Why it is structural.** `paLossRate` (section 9 of the model) is a flat 10%
chance the starting hitter is lifted, applied to everyone in a posted lineup.
It is not flat in reality: the hitter who has averaged two trips a game is
precisely the one who gets pinch-hit for, platooned out or lifted for defence,
and the everyday regular is precisely the one who is not. The model already
knows which is which — it is in the line it reads — and was throwing it away.
(The section-9 bisection solves the trip mean to `pa` whatever `paLossRate` is,
so the correction has to move `pa` itself rather than the loss rate.)

**And it is a plate-appearance error, not a rate error.** Splitting the
residual into plate appearances and per-plate-appearance rates, the duty tilt
the fit season wants on the *rates* before the plate appearances are fixed is
+0.21 on runs, +0.10 on hits and **+0.07 on strikeouts** — all three the same
direction. Only a plate-appearance shortfall can pull hits and strikeouts the
same way. Correct the plate appearances and the leftover rate tilt is **+0.02
on hits and −0.01 on strikeouts**: gone. What survives is runs and RBI, and
section 4 is about that.

### The term

`BATTER_TUNING.duty`, in `src/model/batter.js` — one straight line, clamped at
both ends, crossing 1 at the pivot:

```
rate  = pivot + w * (clamp(PA this season / games this season, lo, hi) - pivot)
        where w = games / (games + priorGames)
plate appearances  x  (1 + duty.pa * (rate - pivot))

duty = { pa: 0.084, pivot: 3.44, lo: 2, hi: 3.7, priorGames: 10, scoring: 0 }
```

Combined with `thin`, this is **one monotone curve in playing time**: a
short-book hitter is discounted, the discount ends at 70 plate appearances, and
from there the duty line carries on upward to a +2.2% plateau for the everyday
regular. Nothing in `thin` changed.

The games-weighted shrink toward the pivot is what makes the term inert on an
unknown hitter instead of discontinuous: at zero games played the multiplier is
exactly 1, and it fades in over the first few weeks rather than switching on at
a threshold. It is also why `thin` and `duty` do not double-count April — in
the opening fortnight `duty` is still near 1 and `thin` is doing the work.

### How the parameters were chosen

`pa` and `pivot` are **solved, not gridded**, and solved on the plate
appearances alone — no outcome market was looked at while choosing them. The
term expands to

```
projected PA  +  s (projected PA x w x clamp)  -  s pivot (projected PA x w)
```

so regressing the residual (actual PA − projected PA) on those two columns with
no intercept returns the slope directly and the pivot as the ratio of the two
coefficients. A grid over the pair is **degenerate** — every slope reaches a
pooled plate-appearance gap of zero at some pivot, which is exactly what the
first attempt here found — so it has to be a solve. The slope comes out at
**0.083–0.086 across all five hitter-grouped folds**.

`lo`, `hi` and `priorGames` say where the line stops being a line and how fast
it fades in. Each candidate triple was solved separately and judged on the
worst remaining bucket error on the fit season:

| lo | hi | priorGames | slope | pivot | worst bucket | mean \|err\| |
|---|---|---|---|---|---|---|
| 2 | 3.7 | 10 | 0.0842 | 3.439 | **0.72%** | 0.318% |
| 2 | 3.7 | 20 | 0.0993 | 3.454 | 0.72% | 0.313% |
| 2 | 3.9 | 10 | 0.0706 | 3.547 | 0.73% | 0.357% |
| 2.5 | 3.7 | 0 | 0.0685 | 3.419 | 0.70% | 0.270% |
| 1.5 | 4.4 | 20 | 0.0560 | 3.696 | 1.73% | 0.891% |

and then cross-validated on the outcome markets inside 2025 (5-fold by hitter,
objective = summed absolute calibration gap over seven markets):

| setting | held out | in sample | optimism |
|---|---|---|---|
| master (duty off) | 0.02964 | 0.01994 | 0.0097 |
| lo 2, hi 3.7, priorGames 10 | 0.02477 | 0.01359 | 0.0112 |
| lo 2, hi 3.7, priorGames 20 | 0.02507 | 0.01394 | 0.0111 |
| lo 2.5, hi 3.7, priorGames 0 | **0.02399** | 0.01269 | 0.0113 |

**Every variant beats master out of sample by about the same amount, and they
are indistinguishable from each other** (0.0240–0.0251 against 0.0296). So the
choice among them was not made on the fourth decimal, which would be fitting
noise. It was made on two robustness properties: `priorGames > 0`, so the term
cannot switch on off a one-game sample in the opening week; and `lo = 2` rather
than 2.5, so the bottom clamp sits where the data thins out rather than where
truncation happens to flatter the residual.

---

## 2. Is the 200+ under-read fixed?

**Half of it.** Both seasons through 2026-09-01, sliced exactly as
`docs/ACCURACY.md` slices (gap in percentage points, + means the model quotes
too high):

| established (200+ PA), n=40,340 | ECE before → after | gap before → after |
|---|---|---|
| runs | 0.97 → **0.66** | **−0.96 → −0.66** |
| H+R+RBI | 1.08 → **0.66** | **−1.08 → −0.66** |
| hits | 0.80 → **0.49** | −0.71 → **−0.32** |
| total bases | 0.81 → **0.52** | −0.80 → **−0.43** |
| singles | 0.62 → **0.27** | −0.58 → **−0.23** |
| RBIs | 0.63 → **0.44** | −0.63 → **−0.44** |
| home runs | 0.53 → 0.44 | −0.52 → −0.43 |
| strikeouts | 0.42 → 0.38 | −0.19 → **+0.18** |
| stolen bases | 0.18 → 0.18 | +0.17 → +0.17 |

**And the mirror cell is not paying for it.** This is the thing the task warned
about and the reason the bands are reported separately:

| building (50–199 PA), n=31,073 | gap before → after |
|---|---|
| runs | +0.54 → **+0.47** |
| H+R+RBI | +0.35 → **+0.24** |
| hits | +0.08 → −0.01 |
| strikeouts | +0.58 → **+0.44** |
| total bases | +0.34 → +0.26 |
| RBIs | +0.21 → +0.16 |
| singles | −0.28 → −0.37 |

The 50–199 cell **improves on seven markets of nine**, is unchanged on stolen
bases and loses 0.09 on singles.
A flat `runLevel` lift — the lever the previous branch measured and rejected —
took 200+ to zero by pushing this cell from +0.5 to +1.1. This does not,
because it is a tilt on a variable the two cells genuinely differ on rather
than a constant.

**Where it does cost something: the thin cell**, which was left at zero by the
previous branch and is now pulled about a quarter of a point negative.

| thin (<50 PA), n=14,789 | gap before → after |
|---|---|
| hits | +0.14 → **−0.12** |
| runs | +0.06 → **−0.14** |
| H+R+RBI | +0.13 → −0.16 |
| singles | −0.12 → **−0.37** |
| strikeouts | +0.11 → −0.21 |
| RBIs | −0.06 → −0.18 |
| total bases | +0.56 → **+0.32** |
| home runs | +0.37 → +0.32 |

Five of nine move further from zero, by 0.1–0.25 points; three improve (hits,
total bases, home runs) and stolen bases are unchanged. Stated plainly:
**this is error moving, and it is the one place it does.** It is
accepted rather than hidden because the thin cell stays inside 0.4 points on
every market, the band it comes from was out at 1.0, and the trade is 14,789
batter-games against 40,340. It is not free and it is not pretended to be.

### Pooled, and out of sample

Pooled over all 81,288 batter-games through 2026-09-01:

| market | ECE before → after | gap before → after | corr before → after | MAE before → after |
|---|---|---|---|---|
| hits | 0.36 → **0.29** | −0.30 → −0.18 | 0.147 → **0.150** | 0.6847 → 0.6848 |
| total bases | 0.21 → **0.15** | −0.17 → −0.07 | 0.143 → **0.145** | 1.3324 → 1.3323 |
| H+R+RBI | 0.37 → **0.26** | −0.37 → −0.26 | 0.150 → **0.152** | 1.4968 → **1.4964** |
| runs | 0.61 → **0.58** | −0.25 → −0.16 | 0.140 → **0.142** | 0.5761 → **0.5758** |
| singles | 0.40 → **0.32** | −0.40 → −0.31 | 0.132 → **0.134** | 0.6201 → **0.6195** |
| RBIs | 0.25 → **0.23** | −0.24 → −0.18 | 0.104 → **0.106** | 0.6273 → 0.6275 |
| home runs | 0.18 → **0.14** | −0.17 → −0.13 | 0.136 → 0.136 | 0.2131 → 0.2134 |
| strikeouts | 0.28 → 0.29 | +0.13 → +0.20 | 0.259 → **0.262** | 0.6695 → 0.6696 |
| stolen bases | 0.16 → 0.16 | +0.08 → +0.08 | 0.209 → 0.209 | 0.1293 → 0.1293 |

**On the untouched test season alone** (2026 through 09-01, 37,530
batter-games, never seen while fitting), the fit season's result reproduces
almost exactly:

| gap, 2026 through 09-01 | runs | H+R+RBI | hits | strikeouts |
|---|---|---|---|---|
| established 200+ | −0.78 → **−0.48** | −0.93 → **−0.51** | −0.68 → −0.29 | −0.23 → +0.14 |
| building 50–199 | +0.32 → +0.24 | +0.34 → +0.22 | +0.24 → +0.13 | +0.71 → +0.55 |
| thin <50 | +0.01 → −0.18 | −0.24 → −0.52 | −0.10 → −0.36 | +0.40 → +0.08 |

Log loss over the nine markets, and the size of the gain, is the same in both
windows — which is the point of having fitted on one and tested on the other:

| log loss (9 markets) | master | with duty | gain |
|---|---|---|---|
| FIT (2025) | 9.18049 | 9.17749 | 0.0030 |
| **TEST (2026 through 09-01)** | 9.14675 | **9.14363** | **0.0031** |
| holdout (contaminated) | 9.10919 | 9.10226 | 0.0069 |

It improves in **every band of every window**, not only in aggregate.

And the residual curve, on the test season, flattened from a fourteen-point
span to four and a half:

| PA per game | actual/projected PA before | after |
|---|---|---|
| under 2.0 | 0.894 | 0.969 |
| 2.0–2.6 | 0.914 | 0.977 |
| 3.0–3.3 | 0.969 | 0.987 |
| 3.6–3.85 | 1.022 | 1.006 |
| 4.05–4.25 | 1.032 | 1.014 |
| 4.45+ | 1.026 | 1.009 |

### Correlation

**It went up, and it went down nowhere.** Pooled per-game correlation rises on
seven of nine markets and is unchanged on the other two (table above). On the
test season alone: hits 0.145 → 0.148, H+R+RBI 0.142 → 0.145, runs 0.129 →
0.132, total bases 0.140 → 0.141, RBIs 0.095 → 0.097, strikeouts 0.265 → 0.268.
On the contaminated holdout, where the effect is largest: hits 0.176 → 0.182,
H+R+RBI 0.174 → 0.180, runs 0.151 → 0.156.

This is the same reason the thin fix improved ranking: a systematically
mis-projected sub-population is a systematically mis-ordered one.

---

## 3. The lineup-slot term: the −0.27 was the wrong axis

`docs/BATTER-CALIBRATION-FIX.md` regressed the outcome on three axes — the
hitter, "lineup slot / side", and park + starter — and the middle one came out
at −0.27 on hits. That document said so itself, in passing: the middle axis is
"a within-hitter deviation that also mixes home/away and, now, the thin ramp."
It mixes one more thing, and that thing is much bigger than the slot.

**The middle axis is everything that moves within a hitter once park and the
starter are neutral. That is three separate things:** the lineup slot, the
home/away side, and **the model's own season line updating underneath him game
by game**. Separating them needs a third re-projection — the same row moved to
slot 5 at home — so that the slot/side contrast can be taken exactly, with the
hitter's line held fixed, and whatever is left over is the drift.

Done that way, on the fit season (2025, 43,776 batter-games):

| market | hitter | **slot / side** | season drift | park + starter |
|---|---|---|---|---|
| hits | 1.47 | **+0.80** | **−1.73** | 0.98 |
| total bases | 1.50 | **+0.80** | −2.11 | 0.87 |
| home runs | 1.57 | +0.79 | −2.74 | 0.74 |
| RBIs | 2.11 | +0.38 | −2.67 | 1.44 |
| H+R+RBI | 1.84 | +0.73 | −1.65 | 1.22 |
| runs | 1.77 | **+1.21** | **−2.40** | 1.39 |
| strikeouts | 1.14 | +0.93 | −1.60 | 0.87 |
| singles | 1.59 | +0.80 | −2.02 | 0.94 |

**The lineup-slot term is correctly signed on every market and roughly
correctly scaled.** It replicates on the test season (hits +0.75, runs +1.09,
strikeouts +1.14, home runs +1.31, total bases +0.95) and it is positive with
the thin ramp and the duty tilt switched off as well (hits +1.12, runs +1.57).
**It should be kept exactly as it is.** There is no case for deleting it and no
case for reversing it.

### Checked directly, without the regression

Within each hitter-season, comparing the games he batted above his own usual
slot with the games he batted below it — the model's slot arithmetic against
what actually happened:

| slots from his usual spot | n (2025) | actual PA | model PA | ratio |
|---|---|---|---|---|
| −3 (moved up) | 2,278 | 4.309 | 4.366 | 0.987 |
| −1 | 6,594 | 4.106 | 4.077 | 1.007 |
| 0 | 19,101 | 4.086 | 4.085 | 1.000 |
| +1 | 7,188 | 3.897 | 3.854 | 1.011 |
| +3 (moved down) | 2,065 | 3.813 | 3.775 | 1.010 |

**The slot → plate-appearance arithmetic is right to about 1% across a
half-trip swing**, and it replicates in 2026 (0.994 / 1.002 / 1.004 / 1.015 /
1.009). A manager moving a hitter up really does give him more trips, in very
close to the amount the table says.

### And the measurement is not lying — checked against a synthetic null

A negative coefficient on the drift axis is exactly what a *bad measurement*
would also produce. Controlling for a hitter's own season-average projection is
close to controlling for his realised season mean, and conditioning on a total
forces the stretches either side of it to offset — which would manufacture a
negative drift coefficient out of a model that is perfectly right.

So the same regression was run a second time with every outcome **replaced by a
draw from the model's own distribution for that row**. The model is then
correct by construction and every coefficient must come back at 1:

| market | hitter | slot / side | season drift | park + starter |
|---|---|---|---|---|
| hits, real | 1.47 | 0.80 | **−1.73** | 0.98 |
| hits, **null** | 1.06 | **0.99** | **1.12** | 0.94 |
| runs, real | 1.77 | 1.21 | **−2.40** | 1.39 |
| runs, **null** | 1.07 | **0.91** | **1.21** | 1.08 |
| strikeouts, real | 1.14 | 0.93 | **−1.60** | 0.87 |
| strikeouts, **null** | 1.02 | **0.96** | **1.05** | 0.99 |

The null returns 0.86–1.31 on every axis of every market. **The measurement is
unbiased, so the negative is real** — and it belongs to the drift axis, not the
slot.

### The finding that falls out of this, and is left alone

**The model's within-season updating of a hitter's own line is worse than
useless.** When the model raises a hitter above his own season-average estimate
on the strength of what he has done so far, he then does *worse* than that
average, not better. Hits −1.73, runs −2.40, home runs −2.74, where 1.00 is
right and the null confirms 1.00 is reachable.

Two things worth recording about it:

- **`thin` and `duty` have already removed more than half of it**, which is
  what they are: corrections to how the model reads a hitter's own season line.
  With both switched off, the same axis reads **−4.24 on hits and −5.44 on
  runs**; with them on, −1.73 and −2.40. Neither term was aimed at this.
- **It is not fixed here.** It is a third fitted term on windows that have now
  been used, aimed at a within-season updating rule that touches every hitter
  on the board, and it wants its own pre-registered window. Measured, stated,
  left — the same call `docs/BATTER-CALIBRATION-FIX.md` made about the tilt
  this branch went on to build.

---

## 4. The part that cannot be fixed without moving it

The 200+ under-read is **halved, not closed**: runs −0.96 → −0.66 pooled,
−0.78 → −0.48 on the test season. What remains is specific, and it is not
plate appearances.

Once the plate appearances are corrected, the duty tilt the fit season still
wants on the rates is **+0.02 on hits, −0.01 on strikeouts — and +0.13 on runs
and RBI.** It is not hitter quality: controlling for the model's own projected
run rate only takes it from 0.134 to 0.102, and quality's own coefficient is
0.025. It is real, and it replicates.

`BATTER_TUNING.duty.scoring` exists so this can be re-measured. **It ships at
0.** The case against shipping it, in order of weight:

1. **It pays for the established band out of the thin band.** On the test
   season, at its fit-season optimum: established runs −0.48 → **+0.08**, thin
   runs −0.18 → **−0.51**, established H+R+RBI −0.51 → −0.15, thin H+R+RBI
   −0.52 → **−0.75**. That is the definition of moving the error, and it is the
   same failure as the flat `runLevel` lift the previous branch rejected, with
   a different index on it.
2. **It buys nothing out of sample.** Test-window log loss over the nine
   markets: 9.14363 without it, **9.14367 with it** — very slightly worse. On
   the fit season it looked like a gain (9.17749 → 9.17679). That is the whole
   signature of a term that has fitted one season's shape.
3. **The data does not locate it.** The cross-validated log-loss basin inside
   2025 runs flat from 0.07 to 0.20 — a factor of three — and the best value,
   0.15, implies a **22% run-rate discount** for a hitter averaging two trips a
   game, stacking on top of `thin`'s 11% scoring cut for a hitter who is both
   thin and low-duty. Nobody has validated a 30% combined cut.
4. **It is the wrong shape for what it is.** Runs and RBI, and nothing else,
   depend on who bats around you. A hitter with high plate appearances per game
   bats near the top of a decent order, so more people reach base ahead of him
   and more are behind him to drive him in. That is **lineup context**, which
   the model has none of, reached through a playing-time proxy. The right fix
   is a lineup term; a duty-indexed constant standing in for one will hold
   exactly as long as the proxy does.

So, plainly: **the remaining −0.66 on runs and H+R+RBI at 200+ is not removable
by a playing-time term.** A playing-time term has taken out everything that was
playing time. What is left is a different defect wearing playing time's
clothes, and pretending otherwise would buy a prettier table at the cost of the
thin cell and of the next person's trust in this file.

**Reading the board today:** runs and H+R+RBI still want about two thirds of a
point added to the over for a hitter with a full season behind him — down from
a full point — and the everyday regular is no longer being shorted a trip to
the plate.

---

## 5. What changed

`src/model/batter.js` only:

- `BATTER_TUNING.duty` — new, with the measurement written where it is defined:
  `pa` 0.084, `pivot` 3.44, `lo` 2, `hi` 3.7, `priorGames` 10, `scoring` 0.
- The `paDuty` multiplier, computed once beside the existing `thin` ramp and
  applied to the posted-slot plate appearances in section 1.
- `scoringDuty`, wired to the run and RBI rates and **shipped at zero**, so the
  rejected leg in section 4 can be re-measured without re-deriving it.

Deliberately unchanged: `thin`, `thinPaCap`, `paLossRate`, `teamPaSd`,
`PA_BY_LINEUP_SLOT`, `priorStrength`, `hrPriorStrength`, `seasonPriorWeight`,
`parkStrength`, `pitcherInfluence`, `runLevel`, `rbiLevel`, `rateSpread`, and
the joint scoring model. `MARKET_WEIGHT`, `PLAY_RULES`, the trading hurdle and
`src/trade/calibration.js`: untouched.

Tooling, all in `tools/batter-thin-fit.mjs`, reusing its frozen rows:

- `--duty-table` — the playing-time curve on both candidate axes, split into
  plate appearances and rates.
- `--duty-fit` — the no-intercept solve for the slope and pivot, per candidate
  clamp triple, with per-fold slopes and the residual bucket error.
- `--cv K` — k-fold cross-validation inside the fit window, grouped by hitter,
  on `gap`, `logLoss` or `paGap`.
- `--slot-study` — the four-axis decomposition that separates the lineup slot
  from the season drift, **with the synthetic null beside it**.
- `--bands` — switches the report's groups to the three plate-appearance bands
  `docs/ACCURACY.md` slices on, so a fix that moves error between bands shows
  up as that.

Two bugs fixed in the existing tool while using it: `slotStudy` was
re-projecting its context-free columns with the *shipped* tuning rather than
the grid entry's, which made the park+starter column the difference between two
different models on any non-default grid row; and stolen bases printed `NaN`
for axes that have no spread instead of saying so.

### Tests

`npm test`: **258 pass, 0 fail** (253 on master plus five new). Five new tests
pin the properties that make the term safe — exact inertness on every missing
input (no season line, no games played, absent `gamesPlayed`, unknown slot),
monotonicity in duty with both clamps, that it moves plate appearances *only*
and fades in with games played, that `thin` and `duty` stack without either
swallowing the other, and that every distribution's mean still equals the
projection printed beside it.

**One existing test was changed, and it was not loosened.** `PA distribution is
a proper pmf whose mean is the lineup-slot PA, every slot` asserted
`p.pa === PA_BY_LINEUP_SLOT[slot-1] ± 0.08` exactly. That identity is precisely
what this branch set out to break — an everyday regular takes about 2% more
trips than the table says, and that is the defect. The assertion is now the
table **times the duty multiplier**, still an exact equality, and a second
exact assertion was added beside it that the original identity holds verbatim
with `duty.pa: 0`. The test pins more than it did before, not less.

---

## Reproduce

```
export PATH=/c/Users/qrob1/mlbwork/node:$PATH

# freeze the replay's rows once per season (StatsAPI only, everything cached)
node --max-old-space-size=12288 tools/batter-thin-fit.mjs --dump \
  --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .work/rows_2025.ndjson
node --max-old-space-size=12288 tools/batter-thin-fit.mjs --dump \
  --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .work/rows_2026.ndjson

ROWS="--rows .work/rows_2025.ndjson --rows .work/rows_2026.ndjson"
W="--fit-to 2026-01-01 --val 2026-01-01..2026-09-02"      # FIT = 2025, TEST = 2026 to 09-01

# 1. which axis carries the error, and is it plate appearances or rates
node --max-old-space-size=14336 tools/batter-thin-fit.mjs $ROWS $W --duty-table \
  --grid '[{"label":"master","duty":{"pa":0}},{"label":"new"}]'

# 2. solve the slope and the pivot on the plate appearances alone
node --max-old-space-size=14336 tools/batter-thin-fit.mjs $ROWS $W \
  --duty-fit '[{"lo":2,"hi":3.7,"priorGames":10},{"lo":2,"hi":3.9,"priorGames":10},
               {"lo":2.5,"hi":3.7,"priorGames":0},{"lo":2,"hi":3.7,"priorGames":20}]'

# 3. cross-validate the shape inside the fit season, folds grouped by hitter
node --max-old-space-size=14336 tools/batter-thin-fit.mjs $ROWS $W --cv 5 --objective gap \
  --grid '[{"label":"master","duty":{"pa":0}},{"label":"new"}]'

# 4. the one look at the test window, by plate-appearance band
node --max-old-space-size=14336 tools/batter-thin-fit.mjs $ROWS $W \
  --hold 2026-09-02..2026-09-23 --bands \
  --grid '[{"label":"master","duty":{"pa":0}},{"label":"new"},
           {"label":"rejected +scoring","duty":{"pa":0.084,"scoring":0.15,"pivot":3.44,"lo":2,"hi":3.7,"priorGames":10}}]'

# 5. the lineup-slot axis, separated, with the synthetic null
node --max-old-space-size=14336 tools/batter-thin-fit.mjs --rows .work/rows_2025.ndjson \
  --fit-to 2026-01-01 --val 2099-01-01..2099-01-02 --slot-study --markets hits \
  --grid '[{"label":"shipped"},{"label":"pre-thin, pre-duty","thinPaCap":0,"thin":{},"duty":{"pa":0}}]'

# the canonical report, before and after, on the same rows
for y in 2025 2026; do
  node --max-old-space-size=14336 tools/accuracy-extract.mjs --kind batters \
    --from $y-03-20 --to $( [ $y = 2025 ] && echo 2025-10-01 || echo 2026-09-22 ) \
    --cache .backtest-cache --out .backtest-cache/accnew_b_$y.ndjson
  node --max-old-space-size=14336 tools/accuracy-extract.mjs --kind batters \
    --from $y-03-20 --to $( [ $y = 2025 ] && echo 2025-10-01 || echo 2026-09-22 ) \
    --cache .backtest-cache --tuning '{"duty":{"pa":0}}' --out .backtest-cache/accold_b_$y.ndjson
done
node --max-old-space-size=14336 tools/accuracy-report.mjs .backtest-cache/accnew_b_*.ndjson \
  --bins --slices --holdout 2026-09-02
```

## Caveats

- **The September holdout is contaminated and is reported as confirmation of a
  direction only.** `docs/BATTER-CALIBRATION-FIX.md` spent it. Everything in
  this document that claims to be out of sample is the 2026 window through
  09-01, which nothing in this branch was fitted on.
- **2026 is untouched by this branch, not untouched absolutely.** The thin ramp
  was fitted partly on it. That term is identically zero above 70 plate
  appearances, so the 50–199 and 200+ bands carry no fitted footprint, but the
  thin band's 2026 numbers are not a clean out-of-sample read and are not
  presented as one.
- **The thin cell is 0.1–0.3 points worse than it was.** Section 2 says where
  and by how much. That band was left at zero by the previous branch and this
  branch spends a little of it.
- **The term is applied only to posted-slot plate appearances.** The
  unknown-slot branch already reads the hitter's own PA per game through a
  different and much stronger estimator, and the duty tilt was never measured
  there, so it is not applied there. `src/data/loadSlate.js` supplies a slot for
  every confirmed lineup.
- **`gamesPlayed` counts games he appeared in**, including as a pinch hitter,
  which is what makes PA per game a duty signal at all. It is read as-of, from
  games before the date being projected; nothing here has lookahead.
- **The synthetic null is one draw.** On 2025 (43,776 rows) it is stable at
  0.86–1.31; on the smaller 2026 window it is noisier and two of its cells
  wander, which is sampling and not a second finding.
- **No weather** in the replay, as in every batter study in this repo, and the
  starter is the boxscore starter rather than the listed probable.
- **Nothing here reads a price.** No Odds API call, no Kalshi call. Public MLB
  StatsAPI only, cached on disk under `.backtest-cache`.
