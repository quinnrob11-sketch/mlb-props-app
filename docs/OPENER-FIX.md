# The short start: what was actually wrong, and the fix

`docs/ACCURACY.md` and `docs/PITCHER-PORT.md` both measured the same thing and
both handed it over unfixed: **on a start the model expects to run under 4.5
innings, the outs probabilities read about 6.4 points low and the strikeout
probabilities about 4.6 points low**, against 2.2 and 1.4 for a full-length
start. The last person to look at it wrote that "the model still does not know
a bullpen game is a bullpen game" and proposed replacing the hook-hazard
distribution wholesale.

**That diagnosis is wrong, and the replacement would not have fixed it.**
Measured on the fit split, the model knows perfectly well what a bullpen game
is — starts where the pitcher's last three appearances had all been one- or
two-inning relief outings carry a calibration gap of **−0.7 points**, which is
better than the board average. And the hook distribution is the right width:
inside buckets of the model's own projection its spread is 3.2–3.7 outs against
a realised 3.5–4.3, everywhere from 6 outs to 18.

What is wrong is one line doing the work of two.

---

## The defect

`PITCHER_FIT.cal.outs` shrinks every start's projected depth toward a single
anchor of 15.5 outs, with a slope of 0.876 fitted by least squares over every
start in the fit window. Starts do not come from one population. They come from
at least three, and the regression that fits that one slope is fitted through
all of them at once:

```
node tools/opener-fit.mjs --report .work/orf_25.ndjson .work/orf_26.ndjson
```

```
the two populations, read off his own last three appearances:
  opener      n= 298  raw  6.06  v37  7.20  actual  5.44  bias -1.76
  starter     n=7652  raw 15.94  v37 15.80  actual 15.88  bias +0.08
  debut       n= 455  raw 15.07  v37 15.26  actual 14.60  bias -0.66

the shrink each one wants, fitted on RAW (actual ~ raw, least squares):
  all together (what v37 has)  [15.5, 0.8788, 0.9936]
  opener                       [6,    1.0084, 0.8970]
  starter                      [15.5, 0.6880, 1.0047]
  debut                        [15.5, 0.1852, 0.9469]
```

298 starts of 8,405 were made by a pitcher who had not thrown more than two
innings in any of his last three appearances. They averaged **5.44 outs**. The
other 8,107 averaged 15.8. Fitting one line through both drags the starter
shrink from **0.688 to 0.879** — and that flattened shrink is then applied to
the 8,107 real starters, who are consequently under-shrunk at both ends of
their own range:

```
v37, by the projection it makes — one line through two populations:
  v37 says  0- 8 outs  n= 262  raw  5.28  v37  6.51  actual  4.81  bias -1.71
  v37 says  8-11 outs  n= 149  raw  8.72  v37  9.52  actual 10.38  bias +0.86
  v37 says 11-13 outs  n= 214  raw 11.89  v37 12.27  actual 13.77  bias +1.50
  v37 says 13-14 outs  n= 462  raw 13.42  v37 13.60  actual 14.16  bias +0.56
  v37 says 14-15 outs  n=1261  raw 14.55  v37 14.58  actual 14.74  bias +0.16
  v37 says 15-16 outs  n=2155  raw 15.62  v37 15.52  actual 15.45  bias -0.07
  v37 says 16-17 outs  n=2396  raw 16.75  v37 16.51  actual 16.50  bias -0.01
  v37 says 17-30 outs  n=1506  raw 17.98  v37 17.63  actual 17.29  bias -0.34
```

Read the bias column. It is not noise and it is not one-directional: the model
is **1.7 outs too generous below 8** and **1.5 outs too stingy between 11 and
13**, and flat in the middle where 80% of the board lives. That is the
signature of two straight lines being approximated by one.

And it explains why the "short outing projected" slice looked like a bullpen-game
problem and was not. Split that slice — 904 starts on the fit split, `p.length`'s
own cut — by what the pitcher had actually been doing:

| the short slice, by his last three appearances | n | share | outs gap |
|---|---|---|---|
| longest outing ≤ 6 outs — **a genuine relief start** | 292 | 32% | **−0.7** |
| longest 7–11 outs | 163 | 18% | −5.9 |
| longest 12+ outs, or no appearance at all | 449 | 50% | **−11.0** |

**Two thirds of the worst cell in the model is real starters being wrongly
shortened, not openers being wrongly lengthened.** The openers in it were
already fine — that was the v35.2 `reliefBudget` work, and it did its job.

---

## The fix

`PITCHER_FIT.role`. The same shrink-to-mean the model already uses, fitted once
per population instead of once for all of them, with the population read off
the pitcher's own recent appearances.

**The read.** The longest outing among his last three appearances, **relief
outings included**. At 6 outs or fewer he is not currently a starter. Above
that he is. An empty log — no appearance this season at all — is a third class.

That input costs nothing. `src/data/loadSlate.js` already fetches the pitcher's
whole season pitching game log and throws the relief rows away to build
`gameLog`; it now keeps a copy in `appearanceLog`. **No new request, in the app
or in the replay.** Dropping those rows is exactly why the model could not see
this: a pitcher whose last three appearances were all one-inning relief outings
has an empty or stale *start* log, and to the workload term he looks like a
starter with no recent form.

**The three lines**, all fitted on the FIT split (2025 entire plus 2026 through
2026-08-09) by least squares of actual outs on the raw, pre-calibration
projection, and none of them touched afterwards:

| class | fires on | `[anchor, slope, level]` |
|---|---|---|
| `opener` | longest of the last 3 appearances ≤ 6 outs | `[6, 1, 0.8978]` |
| `starter` | anything longer | `[15.5, 0.688, 1.0047]` |
| `debut` | no appearance at all this season | `[15.5, 0.1852, 0.9469]` |

The opener line is held at slope 1 and fitted as a level only: 298 starts
support a level, not a slope, and fitted freely the slope comes back at 1.008
anyway. The debut line's **slope of 0.19** is the finding there — for a pitcher
with no 2026 appearance the projection is built entirely from last season and a
league prior, and against what actually happened that carries almost no
information. Left on the starter line he is over-projected by 0.85 outs.

**And the counting stats ride it.** Strikeouts, hits, walks and earned runs are
each `projBF × a rate`. The role read moved the depth, not the rate, so a start
now projected 15% deeper is projected 15% more of each: `pass` is 1 per market,
and it is a switch rather than a coefficient. The per-market effect is measured
below.

### How often it fires

| | n | `opener` | `starter` | `debut` |
|---|---|---|---|---|
| fit (2025 + 2026 < 08-10) | 8,405 | 298 (3.5%) | 7,652 (91.0%) | 455 (5.4%) |
| validate (08-10 .. 09-01) | 616 | 24 (3.9%) | 585 (95.0%) | 7 (1.1%) |
| holdout (09-02 .. 09-22) | 383 | 16 (4.2%) | 363 (94.8%) | 4 (1.0%) |

Over both seasons: 338 `opener` starts averaging **5.36** actual outs, 466
`debut` averaging 14.53, 8,600 `starter` averaging 15.84. The `opener` share
runs 0.7–1% in March, when nobody has a log yet, and 3–6% from May on; it is
highest in June 2026 (6.2%), not in September. The September clustering the
brief expected is not in these two seasons.

### The detector's settings barely matter; having the split does

Swept on the fit split, the starter class's own fitted slope against the window
and threshold used to define the relief class:

```
  w=1  3: n=282 slope 0.762   5: n=390 slope 0.701   6: n=507 slope 0.645   9: n=831 slope 0.623
  w=2  3: n=160 slope 0.810   5: n=252 slope 0.734   6: n=335 slope 0.661   9: n=479 slope 0.619
  w=3  3: n=115 slope 0.843   5: n=206 slope 0.770   6: n=298 slope 0.688   9: n=432 slope 0.633
  w=6  3: n= 69 slope 0.872   5: n=156 slope 0.817   6: n=269 slope 0.717   9: n=401 slope 0.649
```

Four whole configurations were refitted and run end to end through the ladder on
the fit split. The short slice's outs calibration error lands at 3.37 (w=2,
th=8), 3.62 (w=3, th=6), 3.74 (w=3, th=9), 3.77 (w=4, th=6) and 4.00 (w=1,
th=5), against 6.82 for v37 — and the pooled figure at 0.60–0.72 against 0.78.
**Every one of them recovers most of the error and the ordering between them is
inside the noise on a 900-start slice.** (w=3, th=6) ships because it is the
a-priori rule — a *pattern* of relief outings, not one short night — and because
it is second best on both the target and the pooled number. Nothing was chosen
on validate or on the holdout.

---

## Before and after

Same harness as `docs/ACCURACY.md` and `docs/PITCHER-PORT.md`:
`tools/accuracy-extract.mjs` driving the lookahead-free replay in
`tools/backtest-pitchers.mjs`, scored by `tools/accuracy-report.mjs`. The
control is the shipped model with `--fit '{"role":null}'`, which is
**byte-identical to master over all 9,404 starts** — verified, record for
record.

```
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --out .work/v38_25.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --out .work/v38_26.ndjson
node tools/accuracy-report.mjs .work/v38_2*.ndjson --slices --holdout 2026-09-02
# the v37 control: add --fit '{"role":null}' to each extract
```

### Main window — 9,021 starts, 2025 and 2026 through 2026-09-01

The slice is `accuracy-report`'s own `p.length`, and it is **the same 976 starts
for both models**: it is cut on `projIP`, which the role term does not touch.

| | n | v37 (master) | **v38** |
|---|---|---|---|
| **short outing projected (<4.5 IP)** | | | |
| outs, calibration error | 976 | **6.58** | **3.45** |
| outs, gap | | **−6.6** | **−3.4** |
| outs, mean abs. error | | 3.061 | **2.677** |
| strikeouts, calibration error | | **2.48** | **1.57** |
| strikeouts, gap | | −2.5 | −1.6 |
| strikeouts, mean abs. error | | 1.489 | **1.448** |
| hits allowed, calibration error | | 1.93 | **1.50** |
| walks, calibration error | | 2.71 | **1.67** |
| earned runs, calibration error | | 1.69 | 2.07 |
| **full-length projected (5.5+ IP)** | | | |
| outs, calibration error | 3,379 | 1.81 | **0.99** |
| outs, gap | | +1.5 | **−0.4** |
| outs, mean abs. error | | **2.741** | 2.753 |
| strikeouts, calibration error | | 0.93 | **0.40** |
| strikeouts, gap | | +0.9 | **+0.0** |
| hits allowed, calibration error | | **0.87** | 1.10 |
| walks / earned runs | | 1.25 / 1.70 | 1.25 / 1.79 |
| **mid (4.5–5.5 IP)** | | | |
| outs, calibration error | 4,664 | 0.87 | **0.75** |
| outs, mean abs. error | | 2.700 | **2.677** |
| strikeouts, calibration error | | **0.68** | 0.89 |
| hits allowed | | **0.56** | 0.88 |
| walks / earned runs | | 2.19 / 1.55 | **1.91 / 1.29** |

**Pooled over all 9,021 starts**, which is the number that says whether the
board as a whole got better:

| market | v37 cal. err | **v38** | v37 MAE | **v38** | v37 corr | **v38** |
|---|---|---|---|---|---|---|
| outs recorded | 0.80 | **0.69** | 2.755 | **2.706** | 0.530 | **0.543** |
| strikeouts | 0.55 | **0.44** | 1.755 | **1.750** | 0.449 | **0.452** |
| hits allowed | 0.40 | **0.33** | 1.701 | **1.696** | 0.338 | **0.342** |
| walks | 1.07 | 1.11 | 1.008 | **1.007** | 0.254 | **0.260** |
| earned runs | 1.14 | **1.06** | 1.567 | **1.564** | 0.194 | **0.198** |

**Every point projection gets better and every correlation gets better.** Four
of five calibration errors get better; walks is 0.04 of a point worse, which is
inside its own interval. Nothing on the board is damaged to pay for the short
slice.

The outs ladder is the clearest single picture, because it shows the two ends
moving together. Quoted → observed:

| | 11.5 | 12.5 | 13.5 | 14.5 | 15.5 | 16.5 | 17.5 | 18.5 | 19.5 | 20.5 |
|---|---|---|---|---|---|---|---|---|---|---|
| **all 9,021** v37 | 86.8→86.6 | 78.0→79.2\* | 73.4→75.1\* | 68.4→70.2\* | 50.0→50.3 | 44.1→44.1 | 37.7→37.8 | 16.3→16.0 | 14.1→13.5 | 11.7→11.2 |
| **all 9,021** v38 | 87.4→86.6\* | 78.7→79.2 | 74.2→75.1 | 69.3→70.2 | 50.3→50.3 | 44.2→44.1 | 37.6→37.8 | 15.8→16.0 | 13.5→13.5 | 11.0→11.2 |
| **short 976** v37 | 46.1→53.5 | 34.0→43.4 | 27.8→39.1 | 20.9→34.9 | 11.1→17.9 | 8.0→14.5 | 4.6→11.2 | 1.1→2.9 | 0.8→2.5 | 0.4→1.9 |
| **short 976** v38 | 50.1→53.5 | 38.9→43.4 | 33.1→39.1 | 26.7→34.9 | 15.0→17.9 | 11.3→14.5 | 7.2→11.2 | 1.9→2.9 | 1.3→2.5 | 0.7→1.9 |
| **full 3,379** v37 | 94.6→93.7 | 89.2→89.1 | 86.5→86.5 | 83.4→82.2 | 66.7→65.2 | 61.5→59.7 | 55.6→53.2 | 27.7→25.8 | 24.8→22.4 | 21.5→19.0 |
| **full 3,379** v38 | 94.2→93.7 | 88.3→89.1 | 85.3→86.5 | 81.9→82.2 | 64.4→65.2 | 58.9→59.7 | 52.7→53.2 | 25.2→25.8 | 22.3→22.4 | 19.1→19.0 |

(`*` marks a rung whose quoted probability sits outside the Wilson interval on
the observed side.) The three rungs v37 got wrong on the whole board — 12.5,
13.5 and 14.5 — are now inside their intervals. On the full-length slice, where
v37 quoted 2–3 points high at every rung from 14.5 up, v38 is within a point at
all ten. **The full-length start did not pay for this; it also improved.**

### Validate — 2026-08-10 .. 2026-09-01, 616 starts

Chosen never; looked at once, after the configuration was frozen on the fit
split.

| | n | v37 | **v38** |
|---|---|---|---|
| short, outs cal. err | 72 | 3.12 | **2.53** |
| short, outs gap | | **−4.2** | **−1.5** |
| short, outs MAE | | 3.140 | **2.967** |
| short, strikeouts MAE | | 1.369 | **1.330** |
| full, outs cal. err | 234 | **2.20** | 2.40 |
| full, outs gap | | +0.1 | −1.5 |
| pooled, outs cal. err | 616 | 2.24 | **1.65** |
| pooled, outs gap | | −1.7 | **−1.3** |
| pooled, outs MAE | | 2.686 | **2.660** |
| pooled, strikeouts MAE | | 1.656 | **1.646** |
| pooled, hits cal. err | | 1.54 | **1.22** |

The sign and the direction replicate on the short slice and on the pooled
number. 72 short starts is not enough to resolve the size of the effect, and
the full-length regression (+0.1 → −1.5 on 234 starts) is not enough to resolve
either. Nothing here changed the configuration.

### Holdout — 2026-09-02 .. 2026-09-22, 383 starts. One look, at the end.

| | n | v37 | **v38** |
|---|---|---|---|
| outs, cal. err | 383 | 2.80 | **2.57** |
| outs, gap | | +0.8 | +1.2 |
| outs, MAE | | 2.937 | **2.906** |
| outs, corr | | **0.614** | 0.612 |
| strikeouts, cal. err | | **2.05** | 2.60 |
| strikeouts, MAE | | 1.712 | **1.699** |
| hits, cal. err | | 2.38 | **2.09** |
| walks, cal. err | | 2.60 | **2.49** |
| earned runs, cal. err | | **2.94** | 3.13 |

**The holdout cannot settle this and does not claim to.** It contains **41**
short-projected starts — below `accuracy-report`'s own 120-record minimum, which
is why the `p.length` slice does not print for it. Every calibration interval in
the table is 2–5 points wide and every pair overlaps almost entirely. September
2026 ran short again (14.72 outs and 4.59 strikeouts a start against two-season
means of 15.43 and 4.76), so every model looks high on it, exactly as
`docs/PITCHER-PORT.md` reported from the other side.

What the holdout does say is that nothing broke: the point error falls on outs
(2.937 → 2.906) and strikeouts (1.712 → 1.699), and three of five calibration
errors fall. For completeness, on those 41 short starts — a number to read as a
sign and not as a measurement — the outs gap goes −1.2 → +1.1 and the outs mean
absolute error 2.612 → **2.274**, strikeouts 1.390 → **1.260**.

---

## Per-term, on the fit split

Each switch off, everything else in place, banded on the control's projection so
the same starts are compared. Calibration error / gap / mean absolute error.

| configuration | short outs | full outs | pooled outs | short K |
|---|---|---|---|---|
| **v38** | **3.62 / −3.6 / 2.654** | 1.01 / −0.4 / 2.758 | **0.68 / −0.1 / 2.709** | **2.10 / −2.1 / 1.458** |
| `pass: {}` (outs only) | 3.62 / −3.6 / 2.654 | 1.01 / −0.4 / 2.758 | 0.68 / −0.1 / 2.709 | 2.82 / −2.9 / 1.499 |
| `pass: {k: 1}` | 3.62 / −3.6 / 2.654 | 1.01 / −0.4 / 2.758 | 0.68 / −0.1 / 2.709 | 2.10 / −2.1 / 1.458 |
| `debut: null` | 3.81 / −3.8 / 2.659 | 1.03 / −0.1 / 2.761 | 0.77 / +0.2 / 2.713 | 2.19 / −2.2 / 1.458 |
| `role: null` (**v37, the control**) | 6.82 / −6.8 / 3.055 | 1.91 / +1.6 / 2.748 | 0.78 / −0.3 / 2.760 | 2.95 / −3.0 / 1.499 |

Read plainly: **the three fitted lines do the whole of the outs fix, and the
depth pass-through does the whole of the strikeout fix.** The `debut` class is
worth 0.19 of a point on the short slice and 0.09 pooled — small, but it is the
term that keeps the pooled gap centred (+0.2 without it, −0.1 with it).

On the remaining three markets, on the fit split, pooled: hits 0.42 → **0.34**,
walks 0.92 → 0.98, earned runs 1.12 → **1.05**. On the short slice: hits 2.04 →
**1.32**, walks 2.58 → **1.45**, earned runs 1.72 → 2.00. Every one of those is
the `pass` term, since nothing else touches them.

---

## What falls back, and what is still wrong

`test/pitcher.test.js` pins every row of this table (7 tests added, 249 passing,
none loosened, none skipped, none edited).

| missing | what the model does |
|---|---|
| **`input.appearanceLog`** | `role` is null, `depthShift` is exactly 1, and every projection is **v37 to the last bit**. The test asserts deep equality on all five point projections, `projIP`, `projBF` and thirty ladder probabilities against `fit: { role: null }` |
| **`input.date`** | same — the model will not age a log against a date it was not given |
| an appearance log with **no dates on any entry** | unreadable is treated as missing: `cal.outs` as today |
| an appearance log with **no outs on any entry** | same |
| entries dated **on or after** the slate date | invisible. A log made only of them reads as "has not pitched this season", not as tonight's evidence |
| an **empty** appearance log | the `debut` line. This is not a missing input — it says he has not pitched this season, which is real information |
| **`PITCHER_FIT.role.debut`** set to null | debuts go on the starter line |
| **`PITCHER_FIT.role.pass`** set to `{}` | only the outs market moves; strikeouts, hits, walks and earned runs are exactly v37 |
| **`PITCHER_FIT.role`** set to null | the whole term is off and `cal.outs` is live again, unchanged |

`src/data/loadSlate.js` gains one derived array and **no new request** — the
response it is built from is the one `gameLog` is already built from.
`MARKET_WEIGHT`, `PLAY_RULES`, the trading hurdle and everything under
`src/trade/` are **untouched** (`git diff master -- src/model/edges.js
src/trade/ src/lib/constants.js` is empty). Nothing here was measured against a
price, and nothing here should be read as a reason to trade.

### What is still wrong

- **The short slice is halved, not cured.** 6.58 → 3.45 points of calibration
  error, and 3.45 is still the worst cell in the pitcher model. The residual is
  no longer where it was: after the split, the `opener` class carries a bias of
  **+0.03** outs and the `starter` class **+0.05**, and what is left is a
  non-linearity inside the starter line — starts it projects at 12.5–13.5 outs
  still go 1.00 ± 0.31 outs longer, and starts it projects under 11 go 0.98 ±
  0.51 shorter. That is 206 starts of 7,652, the two residuals point in opposite
  directions, and a third free parameter fitted to them on the fit window is how
  a model gets overfitted. It is reported rather than chased.
- **Walks are 0.04 of a point of calibration worse pooled** and 1.1 points
  better on the short slice. Both are inside their intervals. The pass-through
  is kept at 1 across all four markets because 1 is the physically correct value
  and the alternative is four free coefficients.
- **Hits allowed on a full-length start is 0.23 of a point worse** (0.87 →
  1.10), the one place the fix costs something visible on the majority of the
  board. It is the depth pass-through doing what it is supposed to: the model's
  depth on those starts came down by a quarter of an out, and hits came with it.
  The pooled hits number improves (0.40 → 0.33), as does its MAE and its
  correlation.
- **The holdout has 41 short starts and cannot measure this.** The effect this
  branch fixes is 10% of a slate. Establishing it on three weeks of data would
  need about ten times the window, which is what the fit split is.
- **Nothing here touches earned runs as a ranking.** Its correlation moves 0.194
  → 0.198. `docs/PITCHER-PORT.md`'s verdict on that market stands.
- **The team's own bullpen-game pattern was not used.** The brief suggested it,
  and it is a real signal, but it needs every pitcher's log rather than every
  probable's, which is a new fetch for the app. Given that the pitcher's own
  usage already drives the `opener` class's residual bias down to +0.03 outs,
  there is nothing visible left for a team term to explain. That is the reason
  not to buy the fetch, and it is a measured reason rather than a guess.
- **September is not when these cluster.** The brief expected the roster
  expansion to be where bullpen games live. In these two seasons the `opener`
  share peaks in June 2026 (6.2%) and reads 3.1% and 4.8% in the two Septembers.
  No seasonal term was added, because there is no seasonal pattern to add.

### Caveats a reader should hold

- **The replay does not post lineups**, same as `docs/ACCURACY.md`: the
  opponent's team aggregate is used, which is `loadSlate`'s own fallback. That
  is unchanged from the control and affects both sides identically.
- **The `p.length` slice is cut on `projIP`, which the role term does not
  touch**, so the 976-start short slice is literally the same 976 starts before
  and after. This is not the usual trap where a fix moves starts out of the
  slice it is being graded on.
- **The three lines were fitted by least squares on the raw projection**, not
  swept on the ladder. The ladder was used to choose between whole detector
  configurations, and only on the fit split.
- **The fit split's calibration numbers are in-sample for the three lines** and
  out-of-sample for nothing. The validate window is the out-of-sample read and
  it is 616 starts.

## Superseded

`docs/ACCURACY.md`'s condition 2 — "a starter the model expects to go under 4.5
innings … the outs probabilities read 6.8 points low and the strikeout
probabilities 4.6 points low" — is the thing this branch fixed. Those figures
are v36.1's; against master they were 6.6 and 2.5, and against this branch they
are **3.4 and 1.6**. `docs/PITCHER-PORT.md`'s "what is still wrong" section is
superseded in the same place, and its explanation of it — "the model does not
know a bullpen game is a bullpen game" — is superseded by the measurement above:
it knew. It did not know that the other two thirds of that slice were not
bullpen games.
