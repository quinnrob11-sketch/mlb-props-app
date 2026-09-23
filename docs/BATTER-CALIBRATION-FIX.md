# The thin hitter, and what the batter point projections are actually worth (2026-09-23)

`docs/ACCURACY.md` graded the shipped projections against two seasons of box
scores and found one cell that is materially wrong and one claim that reads
worse than it is:

1. **A hitter with fewer than 50 plate appearances this season reads about two
   points HIGH on hits, total bases and singles.** Every other batter cell sits
   between 0.3 and 0.8 points. It concentrates exactly where a user is most
   likely to be tempted — the unfamiliar name with a short, flattering line.
2. **The batter point projections look like they barely rank hitters**: every
   market within 0–4% of giving everyone the slate average, and projected hits
   equal to that baseline to three decimals.
3. **Runs and H+R+RBI read about a point low.**

This branch fixes (1), establishes what (2) really is, and reports where (3)
now lives. **Nothing here is fitted against a price.** `MARKET_WEIGHT`,
`PLAY_RULES`, the trading hurdle and everything under `src/trade/` are
untouched; the only file changed under `src/` is `src/model/batter.js`.

Two things in `docs/ACCURACY.md` were measured before the batter port landed on
master and no longer describe the shipped model, so the "before" column
everywhere below is **current master**, re-measured, not that document:

| | ACCURACY.md | current master |
|---|---|---|
| batter hits, calibration error | 0.70 pts | **0.27 pts** |
| batter runs, overall gap | −0.8 (reads low) | **+0.1** |
| batter H+R+RBI, overall gap | −0.7 (reads low) | **+0.1** |
| batter hits, thin cell gap | +2.1 | **+2.2** |
| batter runs, thin cell calibration error | 1.30 pts | **2.06 pts** |

The port already removed the pooled runs / H+R+RBI under-read. What is left of
it is a slice, and it is reported as one below.

---

## 1. The defect is two effects, not one, and neither is the prior

### What the shrinkage cannot see

Every rate in `projectBatter` shrinks toward a flat prior — 0.222 hits per
plate appearance, 0.12 runs, 0.115 RBI, 0.03 home runs — with this season's
plate appearances and 0.6 times last season's as interchangeable evidence in
the denominator. They are not interchangeable. A hitter who has barely batted
*this* season is either in the opening fortnight, when nobody is in form, or he
is not being played — and neither fact is anywhere in the line the shrinkage
reads.

Bucketing the fit window by plate appearances so far, as the ratio of what
those hitters actually did to what the model projected:

| PA so far | n | plate appearances | hits/PA | runs/PA | K/PA |
|---|---|---|---|---|---|
| 0–10 | 3,480 | **0.967** | **0.925** | **0.881** | **1.073** |
| 10–25 | 4,290 | 0.974 | 0.936 | 0.919 | 1.032 |
| 25–50 | 6,494 | 0.989 | 0.958 | 0.974 | 0.991 |
| 50–100 | 11,277 | 0.996 | 0.985 | 0.966 | 0.979 |
| 100–175 | 14,061 | 0.999 | 1.010 | 0.981 | 0.981 |
| 175–275 | 14,187 | 1.010 | 1.024 | 1.032 | 0.989 |
| 275–400 | 12,413 | 1.015 | 1.005 | 1.027 | 0.991 |
| 400+ | 9,542 | 1.017 | 1.004 | 1.056 | 1.006 |

It is monotone and it replicates season by season on its own (hits at 0–10 is
0.901 in 2025 and 0.951 in 2026; 0.93 and 0.94 at 10–25). It splits into two
effects that have to be modelled separately:

- **Plate appearances.** A short-book hitter takes 3% fewer trips than his
  lineup slot implies — he is the one who gets pinch-hit for, platooned out or
  lifted for defence, and `paLossRate` is a flat 10% for everybody. That is a
  third of the hits over-read on its own, and it is why the correction cannot
  be a rate factor: it changes the **shape** of every count distribution, not
  only its mean.
- **Rates.** On top of that, per plate appearance he gets 7.5% fewer hits and
  12% fewer runs — and **strikes out 7% more**. One shared factor cannot do
  both directions.

### Why not a lower prior

A book-size-indexed prior was the first thing tried, and it is the wrong shape.
The worst-read hitters in the cell are the ones with a *full prior season and
no current one* — a 2025 regular under 50 plate appearances in 2026 reads
0.915 — and for him the prior carries barely a third of the estimate, so moving
the prior moves him least where he is wrong most. Measured: a prior tilt on
book size (this season + 0.6 × last season) closed a third of the gap
(hits +2.17 → +1.46) and pushed the regulars from −0.37 to −0.45. It is not
what shipped. The error is indexed on **this season's** plate appearances,
because that is the variable that carries the information.

### The term

`BATTER_TUNING.thinPaCap` and `BATTER_TUNING.thin`, in `src/model/batter.js`:

```
short = max(0, 1 - PA this season / thinPaCap)     thinPaCap = 70
plate appearances                      x (1 - thin.pa       * short)   0.03
hit, single, double, triple, HR rates  x (1 - thin.offence  * short)   0.085
run, RBI rates                         x (1 - thin.scoring  * short)   0.11
strikeout rate                         x (1 + thin.k        * short)   0.04
```

A **ramp, not an exponential decay**: an exponential fits the table just as
well and never reaches zero, so it would move a 600-plate-appearance regular in
the eighth decimal. The ramp is exactly 1.000 for everyone at or above the cap,
which is the promise worth being able to make — *this term touches nobody with
a real book*, and the existing tests that assert a regular's plate appearances
equal the lineup-slot table exactly still pass unchanged.

`thin.k` exists only because the plate-appearance shade would otherwise leave
strikeouts reading 0.6 points **low** in the same cell: the thin hitter takes
fewer trips but strikes out more often in each of them, and the two nearly
cancel. That is also why strikeouts were the one thin-cell market that looked
clean before.

**Fallback when inputs are missing.** `hasBook` is `season26 != null ||
season25 != null`. A caller that supplies *neither* season line is not saying
the hitter is short of plate appearances — it is saying nothing at all, and the
undiscounted model is the right answer to nothing at all. All four multipliers
are then exactly 1 and the projection is bit-for-bit the pre-change one
(`src/data/loadSlate.js` reaches this for a debutant with no MLB history). A
hitter with a real line of zero plate appearances this season — a prior season
supplied, or an empty current one — is a *measurement*, not a missing input,
and is discounted. Four tests pin this: exact inertness at and above the cap,
exact inertness with no season line at all, each shade moving only its own
markets in the measured direction, and every distribution's mean still equal to
the projection printed beside it.

### How it was chosen

Pre-registered windows. **FIT** is 2025 plus 2026 through 08-09 (75,762
batter-games, 14,282 of them thin). **VALIDATE** is 2026-08-10..09-01 (5,544;
310 thin). **HOLDOUT** 2026-09-02..09-22 (4,914; 215 thin) was touched once, at
the end. The plate-appearance shade was fitted first, on the plate appearances
alone; the three rate shades and the cap were gridded over
cap 70/90/120 × offence 0.055/0.07/0.085 × scoring 0.08/0.11/0.14 × k 0/0.04.

Log loss over the nine markets is flat to the fifth decimal across the good
region (9.17168–9.17200 on FIT against 9.17491 shipped), so the settings were
taken from the **calibration gap**, which is what the defect is. A cap of 90 or
120 closes the thin cell no better and drags the regulars from −0.37 to −0.48
and −0.61; 70 is where the term stops.

**The thin cell is mostly, but not only, March and April.** 67% of it is the
first two months, and within each month thin hitters still hit far below
regulars (May: 0.199 against 0.226 hits/PA). Established hitters in the first
week of a season read 0.868 — genuinely suppressed — and by day 21 they read
0.983. One ramp on this season's plate appearances captures both, because a
hitter's book is short in the opening fortnight for the same reason it is short
in June for a bench bat: there is nothing behind it yet.

---

## 2. Is the thin over-read fixed?

**Yes.** Both seasons, all 86,220 batter-games, sliced as `docs/ACCURACY.md`
slices them (gap in percentage points, + means the model quotes too high):

| thin (<50 PA this season), n=14,789 | ECE before → after | gap before → after |
|---|---|---|
| hits | 2.23 → **0.44** | **+2.2 → +0.1** |
| total bases | 2.45 → **0.56** | **+2.5 → +0.6** |
| singles | 1.80 → **0.33** | **+1.8 → −0.1** |
| H+R+RBI | 2.63 → **0.33** | **+2.6 → +0.1** |
| runs | 2.06 → **0.74** | **+2.0 → +0.1** |
| RBIs | 1.18 → **0.11** | **+1.2 → −0.1** |
| home runs | 0.79 → **0.37** | +0.8 → +0.4 |
| strikeouts | 0.61 → 0.59 | −0.1 → +0.1 |
| stolen bases | 0.44 → 0.44 | −0.0 → −0.0 |

The two-point over-read is gone: every thin market now calibrates inside
0.6 points, and six of nine inside 0.2. The thin cell is no longer the outlier
— it is now better calibrated than the established cell.

**Out of sample.** On VALIDATE, which the search never saw (310 thin
batter-games):

| VALIDATE thin | before → after | | before → after |
|---|---|---|---|
| hits | +1.43 → **−0.35** | H+R+RBI | +2.33 → **+0.15** |
| total bases | +1.58 → **−0.06** | runs | +2.53 → **+0.83** |
| RBIs | +0.56 → −0.51 | singles | +0.70 → −0.95 |

**On the holdout, touched once** (215 thin batter-games, so read the direction,
not the decimal — the standard error on a single proportion there is about
3.4 points):

| HOLDOUT thin | before → after |
|---|---|
| hits | +5.91 → **+3.96** |
| total bases | +5.00 → **+3.20** |
| H+R+RBI | +6.54 → **+4.14** |
| runs | +6.42 → **+4.56** |
| singles | +6.72 → **+4.90** |
| RBIs | +1.38 → +0.21 |

The September thin cell is a harsher population than the season-wide one — it
is call-ups, not April regulars — and the correction removes about a third of a
gap that is three times larger there. The term is not calibrated to that
population and does not claim to be. It moves the right way on every market.

### What happened to the regulars

**Nothing, to two decimal places.** The ramp is exactly zero above 70 plate
appearances, so most of the board is bit-for-bit unchanged.

| established (200+ PA), n=40,340 | ECE before → after | gap before → after |
|---|---|---|
| hits | 0.80 → 0.80 | −0.7 → −0.7 |
| total bases | 0.81 → 0.81 | −0.8 → −0.8 |
| H+R+RBI | 1.08 → 1.08 | −1.1 → −1.1 |
| runs | 0.97 → 0.97 | −1.0 → −1.0 |

Ranking, per game, over the main window: established/regular correlation
0.140 → 0.141 on hits, 0.137 → 0.137 on runs, MAE/naive 1.0008 → 1.0009. On the
holdout, identical to three decimals on every market. The "building" cell
(50–199 PA) improves slightly (runs ECE 0.94 → 0.86, H+R+RBI 0.48 → 0.40).

### The one number that gets worse, and why

The **pooled** gap moves the other way: hits +0.11 → −0.30, H+R+RBI +0.11 →
−0.37, singles −0.03 → −0.40, and pooled ECE for those three rises from
0.19–0.27 to 0.36–0.40. That is arithmetic, not a regression:

```
before   0.19 x (+2.17, thin)  +  0.81 x (-0.37, regular)  =  +0.11
after    0.19 x (+0.09, thin)  +  0.81 x (-0.41, regular)  =  -0.30
```

**The shipped pooled figure was two errors cancelling.** The thin cell was two
points high, the regulars half a point low, and the weighted sum was zero.
Removing the thin error exposes the regular one, which was always there and is
unchanged. Runs and RBIs, where the thin error was largest, improve on the
pooled number too (runs ECE 0.70 → 0.61, RBI 0.35 → 0.25).

---

## 3. Why the point projections "barely rank hitters" — and what is actually true

The claim in `docs/ACCURACY.md` is right about the numbers and wrong about what
they mean. Two measurements settle it.

### The ordering is not broken. It is at the ceiling.

Collapse each hitter-season to his mean projection and his mean actual over the
games he started (935 hitter-seasons with 20+ starts, both seasons). Most of
the single-game noise averages out. What is left of it is removed explicitly:
the variance of a hitter's game-to-game outcome divided by his number of games
is subtracted from the observed variance of the means, which gives the variance
of true hitter ability — and the square root of the ratio is the **highest
correlation any projection could reach** against a mean measured that noisily.

| market | corr(model, actual) across hitters | ceiling | share of the ceiling | slope | sd(model) | sd(true) |
|---|---|---|---|---|---|---|
| hits | **0.810** | 0.792 | **1.02** | **1.44** | 0.101 | 0.142 |
| total bases | 0.819 | 0.789 | 1.04 | 1.44 | 0.198 | 0.274 |
| home runs | 0.817 | 0.787 | 1.04 | 1.48 | 0.037 | 0.053 |
| H+R+RBI | 0.807 | 0.795 | 1.01 | 1.59 | 0.199 | 0.312 |
| runs | 0.781 | 0.753 | 1.04 | **1.71** | 0.059 | 0.097 |
| RBIs | 0.753 | 0.723 | 1.04 | **1.81** | 0.062 | 0.108 |
| singles | 0.780 | 0.770 | 1.01 | 1.55 | 0.072 | 0.110 |
| strikeouts | 0.852 | 0.892 | 0.96 | **1.12** | 0.188 | 0.220 |
| stolen bases | 0.863 | 0.888 | 0.97 | **1.12** | 0.057 | 0.066 |

**The model orders hitters as well as this data can measure** — a correlation
of 0.81 on hits against a measurable ceiling of 0.79. What is wrong is not the
ordering but the **scale**: the slope of 1.44 says the spread of belief between
hitters is 1.44 times too narrow. The model spans 0.101 hits per game around
the mean where the truth spans 0.142.

And that is precisely why strikeouts and stolen bases are the two markets that
looked like exceptions in `docs/ACCURACY.md`: their compression is 1.12, not
1.44–1.81. There was never a difference in how well the model knows those
hitters; there is a difference in how much it is willing to say.

### "Better than the slate average on MAE" is not a ranking metric

Mean absolute error on a count whose mass sits on 0 and 1 is not minimised at
the conditional mean. Scaling **every** projection by a constant, both seasons,
all 81,288 batter-games:

| market | ×0.8 | ×0.9 | ×1.0 | ×1.05 | ×1.1 | ×1.2 | ×1.3 | slate average |
|---|---|---|---|---|---|---|---|---|
| hits | 0.7167 | 0.6974 | 0.6848 | **0.6835** | 0.6862 | 0.7030 | 0.7328 | 0.6880 |
| total bases | **1.2639** | 1.2943 | 1.3322 | 1.3525 | 1.3736 | 1.4197 | 1.4725 | 1.3633 |
| runs | **0.5549** | 0.5654 | 0.5759 | 0.5812 | 0.5864 | 0.5970 | 0.6075 | 0.5868 |
| H+R+RBI | **1.4624** | 1.4760 | 1.4966 | 1.5119 | 1.5309 | 1.5788 | 1.6379 | 1.5219 |

Deliberately projecting hits 5% **high** beats the honest projection on MAE.
Projecting total bases 20% **low** beats it by 5% and the slate average by 7%.
A metric that pays you to be wrong in a fixed direction cannot be used to say
whether a projection ranks.

### How much is available at all

An **oracle** (fit window, 75,762 batter-games) that knows each hitter's own full-season rate — lookahead, it can
never ship — and applies it to the model's own plate appearances:

| market | model MAE | oracle MAE | slate average | model gain | oracle gain (the ceiling) | model corr | oracle corr |
|---|---|---|---|---|---|---|---|
| hits | 0.6849 | 0.6776 | 0.6877 | 0.4% | **1.5%** | 0.147 | 0.195 |
| total bases | 1.3339 | 1.3204 | 1.3660 | 2.4% | **3.3%** | 0.144 | 0.194 |
| runs | 0.5760 | 0.5651 | 0.5871 | 1.9% | **3.7%** | 0.140 | 0.191 |
| H+R+RBI | 1.4974 | 1.4815 | 1.5228 | 1.7% | **2.7%** | 0.150 | 0.195 |
| strikeouts | 0.6703 | 0.6652 | 0.6818 | 1.7% | **2.4%** | 0.259 | 0.293 |

**The whole prize is 1.5–3.7%, and the model already has half to three quarters
of it.** "0% better than the slate average on batter hits" was never a
statement about the model; it is a statement about a market where perfect
knowledge of every hitter is worth one and a half percent of MAE. The right
reading of `docs/ACCURACY.md`'s last four columns is not "the batter point
projections are worth almost nothing", it is **"one batter-game is almost all
noise, and the projection captures most of what is not"**.

### Where the spread comes from

The projection for one batter-game splits exactly into three axes by
re-projecting the same row with the context terms neutral. Regressing the
outcome on all three at once; a coefficient of 1 means that axis is scaled
right, below 1 that it is spread too far, above 1 too narrowly:

| market | hitter axis | lineup slot / side | park + opposing starter |
|---|---|---|---|
| hits | **1.34** (sd 0.101) | **−0.27** (sd 0.059) | 1.07 (sd 0.051) |
| total bases | 1.35 (sd 0.206) | −0.53 (sd 0.102) | 1.02 (sd 0.092) |
| home runs | 1.42 (sd 0.041) | −1.93 (sd 0.013) | 0.83 (sd 0.015) |
| H+R+RBI | 1.49 (sd 0.202) | −0.31 (sd 0.119) | 1.30 (sd 0.106) |
| runs | 1.63 (sd 0.062) | −0.45 (sd 0.032) | 1.48 (sd 0.029) |
| RBIs | 1.69 (sd 0.065) | −1.47 (sd 0.033) | 1.50 (sd 0.027) |
| strikeouts | 1.13 (sd 0.193) | −0.10 (sd 0.057) | 0.92 (sd 0.093)  |
| singles | 1.47 (sd 0.074) | −0.53 (sd 0.040) | 0.95 (sd 0.034) |

Two things worth knowing. **The park and starter terms are correctly scaled**
(1.07 and 1.02 on hits and total bases) — the port's decision to raise
`parkStrength` to 1.25 holds up. And **the within-hitter lineup-slot axis
points the wrong way**: when the same hitter moves up the order and the model
raises him, he does slightly worse, not better. It carries about 0.059 of the
0.128 total spread on hits. This is *not* a statement about slot across hitters
(that is in the hitter axis and is fine); it is that a manager's decision to
move a particular hitter tonight carries information the model does not have,
and the plate-appearance arithmetic alone has the sign backwards. It is left
alone here — it is a separate piece of work, on a within-hitter deviation that
also mixes home/away and, now, the thin ramp.

### Is the compression fixable? Measured: no, not by relaxing shrinkage

The obvious hypothesis was over-shrinkage. It is wrong, and it is wrong in both
windows. Scaling **every** prior strength together:

| FIT | log loss (9 markets) | hits corr | hits slope | runs corr | runs slope | H+R+RBI corr |
|---|---|---|---|---|---|---|
| ×0.25 | 9.17721 | 0.144 | 0.86 | 0.133 | **0.96** | 0.147 |
| ×0.5 | 9.17272 | 0.145 | 0.92 | 0.137 | 1.10 | 0.149 |
| **×1 (shipped)** | **9.17168** | **0.147** | 1.01 | **0.140** | 1.27 | **0.150** |
| ×2 | 9.17511 | 0.147 | 1.10 | 0.142 | 1.46 | 0.150 |

| VALIDATE | log loss | hits corr | runs corr | H+R+RBI corr |
|---|---|---|---|---|
| ×0.25 | 9.07940 | 0.150 | 0.130 | 0.137 |
| ×0.5 | 9.07444 | 0.152 | 0.136 | 0.140 |
| **×1** | **9.07259** | **0.154** | **0.140** | **0.143** |
| ×2 | 9.07490 | 0.154 | 0.142 | 0.145 |

Relaxing the priors does move the regression slope to 1 — runs 1.27 → 0.96 at
×0.25 — and it makes the model **worse at ranking** while doing it: hits
correlation 0.147 → 0.144, runs 0.140 → 0.133, log loss worse in both windows.
The same holds when only the run and RBI strengths (the two most compressed,
slope 1.71 and 1.81) are moved: at ×0.25 the runs slope is a perfect 1.00 and
the correlation falls from 0.140 to 0.133 on FIT and 0.140 to 0.130 on
VALIDATE.

**So slope and correlation genuinely trade off here, and the current point is
the right one.** The extra spread you buy by shrinking less is not signal. The
compression is not the shrinkage being too strong; it is that a hitter's own
line, at the precision a season affords, simply does not carry a 1.4× wider
true spread that the model is throwing away. Nothing in the shrinkage was
changed.

The same ablation says the context terms earn their place: turning the opposing
starter off costs hits correlation 0.147 → 0.139 and log loss 9.17168 →
9.18221; turning the park off costs 0.147 → 0.141. Halving either is worse than
leaving it. Both replicate on VALIDATE.

### What the fix did to ranking

The thin correction was not aimed at ranking and it improves it anyway, because
a systematically over-projected sub-population is a systematically mis-ordered
one:

| across hitters | before | after |
|---|---|---|
| hits | 0.791 | **0.810** |
| total bases | 0.803 | **0.819** |
| H+R+RBI | 0.784 | **0.807** |
| runs | 0.760 | **0.781** |
| RBIs | 0.740 | **0.753** |
| singles | 0.769 | **0.780** |

Per game, main window: hits 0.143 → 0.147, total bases 0.139 → 0.143, H+R+RBI
0.146 → 0.150, runs 0.138 → 0.140, RBIs 0.102 → 0.104, singles 0.130 → 0.132;
strikeouts and stolen bases unchanged. Holdout: hits 0.174 → 0.176, H+R+RBI
0.172 → 0.174, runs 0.148 → 0.151.

Small, and in the right direction everywhere. Nobody should trade a single
batter-game off a correlation of 0.15; the point of the table above is that
0.15 is three quarters of what 0.195 would be with perfect knowledge.

---

## 4. Runs and H+R+RBI reading low

The pooled under-read `docs/ACCURACY.md` reported (−0.8 and −0.7) **is already
gone on master** — the batter port's joint plate-appearance model took the
pooled gaps to +0.13 and +0.11. What remains, and replicates, is a slice:

| established (200+ PA), both seasons, n=40,340 | gap | point bias |
|---|---|---|
| runs | **−1.0** | actual is 4.5% above projected |
| H+R+RBI | **−1.1** | actual is 3.7% above projected |
| hits | −0.7 | +2.7% |
| total bases | −0.8 | +3.7% |

and its mirror, the 50–199 PA cell, reads **+0.5 on runs** and +0.4 on H+R+RBI.
It is the same monotone playing-time pattern as the thin defect, continuing
past the point where the ramp stops: runs per plate appearance come in at 1.03
of projected at 175–275 PA and 1.06 at 400+.

**Two levers were measured and both cost more than they buy.**

- *Less shrinkage on the run and RBI priors*, which is the structurally honest
  version — those two are the most compressed axes in the model (slope 1.71 and
  1.81). At ×0.25 the slope is a perfect 1.00, the established gap barely
  moves (−0.36 → −0.39 on the fit window) and the correlation drops from 0.140
  to 0.133 on FIT and 0.130 on VALIDATE. It is not the problem.
- *A level lift* on `runLevel`. It would take the 200+ cell to zero and push the
  50–199 cell from +0.5 to +1.1, because the error is monotone in playing time
  and a level is flat. It is the same mistake the pitcher `kLevel` was.

What would work is extending the playing-time ramp upward into a two-sided
tilt — a lift for the biggest books to match the discount for the smallest.
**That is not shipped here.** The evidence for it is one monotone curve on two
seasons, the downward half of that curve is doing real work already, and a
second fitted term on the same window, aimed at the population whose
calibration is 1 point rather than 2, is the kind of thing that should be
pre-registered on its own window rather than bolted on at the end of a branch
that already spent its holdout. Measured, stated, left.

**Reading the board today:** runs and H+R+RBI still want about a point added to
the over for a hitter with a full season behind him, and no longer want
anything subtracted for one who does not.

---

## 5. What changed

`src/model/batter.js` only:

- `BATTER_TUNING.thinPaCap` (70) and `BATTER_TUNING.thin`
  (`pa` 0.03, `offence` 0.085, `scoring` 0.11, `k` 0.04) — new, with the
  measurement written where they are defined;
- the `short` ramp and its four multipliers, computed once from
  `season26`/`season25` before section 1 and applied to the plate appearances
  in section 1 and to the shrunk rates in section 2.

Deliberately unchanged: `priorStrength`, `hrPriorStrength`, `seasonPriorWeight`,
`parkStrength`, `pitcherInfluence`, `contactShare`, `powerShare`, `runLevel`,
`rbiLevel`, `hrLevel`, the joint scoring model of section 11b, the deleted
platoon term of section 3, `PA_BY_LINEUP_SLOT`, `teamPaSd`, `paLossRate`,
`rateSpread`. Every one of them was either measured at its optimum here or is
outside this branch's remit. `MARKET_WEIGHT`, `PLAY_RULES`, the trading hurdle
and `src/trade/calibration.js`: untouched.

Tooling:

- `tools/batter-thin-fit.mjs` — **new**, and it is not a new replay. `--dump`
  imports `buildRows` from `tools/backtest-batters.mjs` and freezes exactly
  what that replay built, so a sweep re-projects identical inputs in seconds
  instead of re-deriving them. It carries the book table, the ranking-power
  study, the three-axis decomposition and the oracle.
- `tools/backtest-common.mjs` — `MARKETS` moved here from
  `tools/backtest-batters.mjs` so a tool can read the market spec without
  importing a module whose top level fetches a season of boxscores.
  `backtest-batters.mjs` re-exports it unchanged; there is still one definition.

`npm test`: **246 pass, 0 fail** (242 on master plus the four new ones). No
existing test was touched, loosened or removed.

---

## Reproduce

```
export PATH=/c/Users/qrob1/mlbwork/node:$PATH

# the replay, unchanged, both seasons (StatsAPI only, everything cached)
node --max-old-space-size=12288 tools/accuracy-extract.mjs --kind batters \
  --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .backtest-cache/acc_b_2025.ndjson
node --max-old-space-size=12288 tools/accuracy-extract.mjs --kind batters \
  --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/acc_b_2026.ndjson
node --max-old-space-size=12288 tools/accuracy-report.mjs .backtest-cache/acc_b_*.ndjson \
  --bins --slices --holdout 2026-09-02

# before/after on the same rows: re-run the two extracts with
#   --tuning '{"thinPaCap":0,"thin":{}}'   (the pre-2026-09-23 model)

# the fitting and the studies (freeze the rows once, then sweep in seconds)
node --max-old-space-size=12288 tools/batter-thin-fit.mjs --dump \
  --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .work/rows_2025.ndjson
node --max-old-space-size=12288 tools/batter-thin-fit.mjs --dump \
  --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .work/rows_2026.ndjson

ROWS="--rows .work/rows_2025.ndjson --rows .work/rows_2026.ndjson"
W="--fit-to 2026-08-10 --val 2026-08-10..2026-09-02"

node --max-old-space-size=12288 tools/batter-thin-fit.mjs $ROWS $W --book-table
node --max-old-space-size=12288 tools/batter-thin-fit.mjs $ROWS $W --rank-study --oracle \
  --grid '[{"label":"fixed"},{"label":"before","thinPaCap":0,"thin":{}}]'
node --max-old-space-size=12288 tools/batter-thin-fit.mjs $ROWS $W \
  --grid '[{"label":"x0.5","priorStrength":{"hit":100,"single":300,"double":200,"triple":60,"run":200,"rbi":200,"k":30,"bb":30,"sb":15},"hrPriorStrength":100}]'
```

## Caveats

- **The holdout's thin cell is 215 batter-games.** It says the direction and
  nothing about the third decimal. VALIDATE's is 310. The weight of the thin
  evidence is in the fit window's 14,282, and the guard against having fitted
  noise is that the pattern replicates independently in 2025 and in 2026, not
  that a three-week holdout confirms it.
- **The thin cell is not one population.** It is April regulars and June bench
  bats and September call-ups, and the September version is three times worse
  than the average. One ramp is a compromise across them, and it under-corrects
  the September end.
- **The ranking ceiling is estimated, not known.** It comes from subtracting an
  estimate of sampling noise from the observed variance of hitters' means, and
  it is only as good as that subtraction; a share above 1.00 in the table means
  the estimate is slightly conservative, not that the model beat the truth.
- **The oracle is optimistic.** It uses each hitter's realised full-season rate,
  which includes the games being scored, so its correlation is an upper bound
  on an upper bound.
- **No weather** in the replay, as in every batter study in this repo, and the
  starter is the boxscore starter rather than the listed probable.
- **Nothing here reads a price.** No Odds API call, no Kalshi call. Public MLB
  StatsAPI only, cached on disk under `.backtest-cache`.
