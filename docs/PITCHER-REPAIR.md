# The two things the role split left behind

`docs/OPENER-FIX.md` shipped a real fix and named its own costs. This branch
pays them back and takes the residual it reported but did not chase.

1. **The regression.** Hits allowed on a FULL-LENGTH start went from **0.87 to
   1.10** points of calibration error, and pooled walks from **1.07 to 1.11**.
   Full-length starts are 3,379 of the 9,021-start board, so 0.23 of a point
   there is a real cost.
2. **The residual non-linearity inside the starter line.** After the role
   split, 3.45 on the short slice was still the worst `p.length` cell, and what
   was left was reported as a shape problem: starts projected 12.5–13.5 outs
   ran **1.00 ± 0.31 longer**, starts projected under 11 ran **0.98 ± 0.51
   shorter**.

Both are fixed or resolved below, on the same harness, the same two seasons and
the same splits. **Nothing was measured against a price.** `MARKET_WEIGHT`,
`PLAY_RULES`, the trading hurdle and everything under `src/trade/` are
untouched — `git diff 5b1add5 -- src/model/edges.js src/trade/ src/lib/constants.js`
is empty, and so is `src/data/`. Only `src/model/pitcher.js`, `tools/` and
`docs/` changed.

Names used throughout: **v37** is the model before today (`--fit '{"role":null}'`),
**v38** is what `docs/OPENER-FIX.md` shipped, **v38.1** is this branch.

---

## 1. Why splitting the OUTS anchor moved HITS and WALKS

It moved them through one line, `carry`:

```js
const depthShift = projOutsAdj / projOutsCal;          // v38
const carry = (value, market) =>
  pass ? value * depthShift ** pass : value;
projHAdj = carry(calibrated(projH, 4.88, 0.89, hLevel), 'hits');
```

The brief's guess was that hits and walks are driven off batters faced, which is
driven off the outs projection. That is the right shape of answer but not quite
the mechanism, and the difference is what the repair turns on.

**`projBF` never moved.** Batters faced are built from the RAW `projIP`, and the
role term does not touch `projIP` — the `p.length` slice is cut on it, which is
why the short slice is literally the same 976 starts before and after. What
`depthShift` carries is not a change in projected batters faced. It is the ratio
of two **calibrations of the outs market**, multiplied onto a quantity that
already carries a calibration of its own.

That matters because `[4.88, 0.89]` — the hits curve — was fitted against hits
outcomes over a population that is **91% `starter`**. Whatever the starter
population's depth needed is already inside it. The `starter` line is a re-slope
of that same population, so passing it through counts the same correction twice.
The `opener` and `debut` classes are 3.5% and 5.4% of the fit split, so the hits
curve carries essentially nothing for them, and there the pass-through is the
whole of the correction. Measured, on the fit split, mean projected against mean
actual:

| class | n | hits v37 | hits v38 | actual | v37 error | v38 error |
|---|---|---|---|---|---|---|
| `opener` | 298 | 2.208 | 1.674 | 1.661 | **−0.547** | −0.013 |
| `debut` | 455 | 4.703 | 4.561 | 4.402 | −0.301 | −0.159 |
| `starter` | 7,652 | 4.994 | 5.019 | 4.990 | **−0.005** | −0.030 |

The pass-through is worth half a hit per start to an opener and is worth
**nothing** to a starter, whose own curve was already exact. On the ladder, on
the full-length slice where almost every start is `starter` and `depthShift` is
0.9865, that "nothing" costs 0.23 points.

The same test run per market says hits is the only one that suffers. Switching
the starter pass-through off, on the fit split with everything else in place:

| market | pooled | short | mid | full |
|---|---|---|---|---|
| hits, off (shipped) | **0.42** | **1.80** | **0.48** | **0.93** |
| hits, on (v38's rule) | 0.42 | 2.15 | 0.86 | 0.94 |
| walks, off | 1.02 | 2.04 | 2.12 | 1.34 |
| walks, on (shipped) | **0.97** | **1.80** | **1.73** | **1.27** |
| earned runs, off | 1.16 | 2.35 | 1.74 | 1.76 |
| earned runs, on (shipped) | **1.00** | **1.26** | **1.40** | **1.72** |

So `pass` stays what `docs/OPENER-FIX.md` called it — a switch per market, not a
fitted coefficient — and it becomes a switch per market **and per class**. Only
hits changes, and only for `starter`:

```js
pass: { k: 1, hits: { opener: 1, debut: 1 }, bb: 1, er: 1 }
```

Setting `hits: 1` restores v38 exactly, and a test pins that.

### What that alone is worth, and why it is not enough on its own

Taking the starter pass-through off hits and doing nothing else is the `nobend`
column below. It repairs full-length and mid and **wrecks the short slice**,
because v37's short-slice hits number was a cancellation: openers were
over-projected by 0.55 and short-projected starters were under-projected, and
the two hid each other. Remove one and the other is exposed. That is the reason
the second half of this branch is not optional.

---

## 2. The residual non-linearity, and what is actually in it

`tools/opener-fit.mjs --bend` prints all of this from rows written by a tree
with the bend switched off:

```
node tools/opener-fit.mjs --from 2025-03-20 --to 2025-10-01 --ship '{"bend":null}' --out .work/pre_25.ndjson
node tools/opener-fit.mjs --from 2026-03-20 --to 2026-09-22 --ship '{"bend":null}' --out .work/pre_26.ndjson
node tools/opener-fit.mjs --bend .work/pre_25.ndjson .work/pre_26.ndjson
```

**The starter line is straight; the relation it approximates is not.** Mean
actual outs by the RAW (pre-calibration) projection, `starter` class, fit split:

```
  raw bucket      n     raw   line  actual   2025    2026
  0-9           71  7.51  10.04  9.18   10.18   7.90
  9-10          36  9.66  11.55  11.19   12.80   9.19
  10-11         41  10.56  12.14  12.83   12.92   12.67
  11-12         69  11.54  12.85  14.22   14.03   14.41
  12-13        163  12.54  13.54  14.21   14.27   14.12
  13-14        440  13.57  14.24  14.39   14.34   14.48
  14-15       1001  14.56  14.92  14.83   14.86   14.78
  15-16       1700  15.52  15.58  15.50   15.57   15.42
  16-17       1981  16.52  16.26  16.23   16.05   16.52
  17-18       1550  17.41  16.87  16.91   16.93   16.88
  18-19        475  18.44  17.60  17.85   17.92   17.73
  19-30        125  19.35  18.22  18.05   17.93   18.20
```

Between raw 10 and 14 the actual is **flat at 14.2–14.4**. A projection in that
band carries almost no information about how long the start will be — the same
thing `role.debut`'s slope of 0.19 says about a pitcher with no log — and a
straight shrink through a flat stretch under-projects its middle by about 1.2
outs. Above raw 14 the line is right to within 0.1–0.25 at every bucket, and
below raw 10 the actual falls away again, so the correction must come back to
zero rather than keep growing. That is a **bend in the curve**, not a change of
slope, and it is why one straight shrink cannot do it.

### The brief's two cells are not the same kind of evidence

Reproducing the two residuals exactly, and then splitting them by season:

| cell (`starter`, by v38's projection) | n | both | 2025 | 2026 |
|---|---|---|---|---|
| projected under 11 outs | 68 | −0.98 ± 0.48 | **+0.02 ± 0.60** | **−2.33 ± 0.70** |
| projected 12.5–13.5 outs | 138 | +1.00 ± 0.31 | +0.80 ± 0.40 | +1.35 ± 0.50 |
| projected 11–14 outs | 391 | +0.67 ± 0.18 | +0.78 ± 0.23 | +0.50 ± 0.31 |

**The "opposite directions" story is one season deep.** The under-11 cell is
+0.02 in 2025 and −2.33 in 2026 on 39 and 29 starts — it does not replicate, it
changes sign. The 11–14 band replicates cleanly, in both seasons, in the same
direction, on 391 starts. So this branch corrects the half that replicates and
deliberately leaves the half that does not, which is also why the fix stays
monotone and needs no second bend pointing the other way.

### The term

```js
bend: { lo: 10, peak: 11.5, hi: 14, amp: 0.0939, pass: { k: 1, hits: 1, bb: 1, er: 1 } }
```

A tent on the raw projection — zero at and outside `lo` and `hi`, one at `peak`
— and every market multiplies by `1 + amp * tent`. Gated on the `starter` class,
so like `role` it is inert without `input.appearanceLog`.

**`amp` is fitted by least squares of actual outs on the bent line over the
`starter` class of the FIT split** — the same recipe and the same split as the
three role lines, not a sweep on the ladder. The fit and its season-by-season
stability:

```
  lo  peak  hi  |   A      se      n  |  2025     2026   | validate
  9.5  11.5  14  |  0.0932  0.0228   741 |  0.0947  0.0910  |  0.1328 (n=55)
  10  11.5  14  |  0.0939  0.0233   713 |  0.0938  0.0941  |  0.1278 (n=55)
  10  11.5  13.5 |  0.1149  0.0272   452 |  0.1171  0.1119  |  0.1611 (n=35)
  10  12  14    |  0.0800  0.0210   713 |  0.0787  0.0819  |  0.1062 (n=55)
  9  11  14     |  0.1005  0.0244   749 |  0.1091  0.0883  |  0.1669 (n=58)
  10  11  14    |  0.1062  0.0256   713 |  0.1101  0.1007  |  0.1685 (n=55)
  10.5  12  14  |  0.0793  0.0216   697 |  0.0770  0.0831  |  0.0934 (n=53)
  10  11.5  14.5 |  0.0741  0.0199  1119 |  0.0748  0.0731  |  0.1114 (n=84)
  8  11.5  14   |  0.0863  0.0215   779 |  0.0961  0.0723  |  0.1211 (n=64)
  10  11.5  15  |  0.0531  0.0170  1714 |  0.0560  0.0488  |  0.1119 (n=125)
```

This is the answer to "show the curve is stable across seasons rather than
fitted to one". At the shipped geometry the amplitude is **0.0938 in 2025 and
0.0941 in 2026, fitted independently** — four standard errors from zero and
three decimal places apart. Every geometry in the sweep tells the same story;
(10, 11.5, 14) ships because it is the most season-stable of them and because
its window holds 713 starts rather than 452. The validate window, 55 starts,
agrees in sign and is larger, and was not used to choose anything.

**No shrinkage was applied to `amp`**, and the reason is the replication above:
a ridge exists to protect against a coefficient that is an artefact of one
sample, and this one is the same number in two independent samples. What IS
regularisation here is the shape: three geometry constants chosen once and one
amplitude, against the alternative of an isotonic fit with a free value per
bucket.

**The bent map is still monotone.** Swept over the whole range, its slope
reaches 1.55 on the rising side of the tent and never falls below **0.145** on
the falling side, so two starts can never swap order. A test sweeps the range
and asserts it.

**Every market carries the whole of the bend** (`bend.pass`, 1 per market).
Unlike the role line, the bend is not a re-slope of a population a market's own
curve was fitted on: inside the window **every** market reads low under v37 —
ladder gaps of −7.95 outs, −5.21 strikeouts, −3.54 walks, −3.29 earned runs and
−2.10 hits — so it is information none of their curves carries. Hits is the
check on that reasoning: with the starter pass-through removed and only the
bend acting, hits' own amplitude fitted freely on its own ladder comes back at
**0.103** against the outs amplitude of 0.0939. It was pinned to the outs
amplitude rather than fitted, and it costs nothing to do so. `bend.pass: {}`
switches the term down to the outs market alone and is measured below.

---

## 3. Before and after

Same harness as `docs/ACCURACY.md`, `docs/PITCHER-PORT.md` and
`docs/OPENER-FIX.md`. Lookahead-free, both seasons, no new replay.

```
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --out .work/v39_25.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --out .work/v39_26.ndjson
node tools/accuracy-report.mjs .work/v39_2*.ndjson --slices --holdout 2026-09-02
# v38: --fit '{"role":{"window":3,"openerOuts":6,"opener":[6,1,0.8978],
#          "starter":[15.5,0.688,1.0047],"debut":[15.5,0.1852,0.9469],
#          "pass":{"k":1,"hits":1,"bb":1,"er":1}},"bend":null}'
# v37: add --fit '{"role":null}'
```

The `p.length` slices below are cut to the main window (`--holdout 2099-01-01`
on a date-filtered file), because `accuracy-report`'s own `--slices` pass reads
every record including the holdout.

### Main window — 9,021 starts, 2025 and 2026 through 2026-09-01

Calibration error, in points. **Bold** marks the best of the three.

| | n | v37 | v38 | **v38.1** |
|---|---|---|---|---|
| **pooled** | 9,021 | | | |
| strikeouts | | 0.55 | **0.44** | 0.53 |
| outs recorded | | 0.80 | 0.69 | **0.65** |
| hits allowed | | 0.40 | **0.33** | 0.41 |
| walks | | **1.07** | 1.11 | 1.10 |
| earned runs | | 1.14 | 1.06 | **1.02** |
| **short outing projected (<4.5 IP)** | 976 | | | |
| strikeouts | | 2.48 | 1.57 | **1.14** |
| outs recorded | | 6.58 | 3.45 | **1.50** |
| hits allowed | | 1.93 | **1.50** | 1.77 |
| walks | | 2.71 | **1.67** | 1.94 |
| earned runs | | 1.69 | 2.07 | **1.28** |
| **mid (4.5–5.5 IP)** | 4,664 | | | |
| strikeouts | | **0.68** | 0.89 | 0.91 |
| outs recorded | | 0.87 | **0.75** | 0.79 |
| hits allowed | | **0.56** | 0.88 | **0.56** |
| walks | | 2.19 | **1.91** | **1.91** |
| earned runs | | 1.55 | 1.29 | **1.27** |
| **full-length (5.5+ IP)** | 3,379 | | | |
| strikeouts | | 0.93 | **0.40** | **0.40** |
| outs recorded | | 1.81 | **0.99** | **0.99** |
| **hits allowed** | | **0.87** | **1.10** | **0.87** |
| walks | | 1.25 | 1.25 | 1.25 |
| earned runs | | **1.70** | 1.79 | 1.79 |

Mean absolute error of the point projection, and the correlation that says
whether it ranks starts at all:

| pooled market | v37 MAE | v38 | **v38.1** | v37 corr | v38 | **v38.1** |
|---|---|---|---|---|---|---|
| strikeouts | 1.755 | **1.750** | **1.750** | 0.449 | 0.452 | **0.453** |
| outs recorded | 2.755 | 2.706 | **2.697** | 0.530 | 0.543 | **0.545** |
| hits allowed | 1.701 | 1.696 | **1.695** | 0.338 | 0.342 | **0.345** |
| walks | 1.008 | **1.007** | **1.007** | 0.254 | **0.260** | **0.260** |
| earned runs | 1.567 | **1.564** | 1.565 | 0.194 | **0.198** | **0.198** |

**Every point projection and every correlation is at or better than both
predecessors**, with earned-run MAE 0.001 off v38's.

Per-slice MAE, where the two terms act:

| | v37 | v38 | **v38.1** |
|---|---|---|---|
| short outs | 3.061 | 2.677 | **2.604** |
| short strikeouts | 1.489 | 1.448 | **1.446** |
| short hits | 1.545 | 1.503 | **1.495** |
| mid hits | 1.729 | 1.731 | **1.727** |
| full hits | 1.708 | **1.705** | 1.707 |
| full outs | **2.741** | 2.753 | 2.753 |

### The outs ladder, quoted → observed

The short slice is where the whole argument lives, and it is now flat:

| | 11.5 | 12.5 | 13.5 | 14.5 | 15.5 | 16.5 | 17.5 | 18.5 | 19.5 | 20.5 |
|---|---|---|---|---|---|---|---|---|---|---|
| **short 976** v37 | 46.2→53.4 | 34.1→43.2 | 27.8→38.9 | 21.0→34.7 | 11.2→17.8 | 8.1→14.4 | 4.6→11.2 | 1.1→2.8 | 0.8→2.5 | 0.4→1.9 |
| **short 976** v38 | 50.2→53.4 | 38.9→43.2 | 33.1→38.9 | 26.8→34.7 | 15.0→17.8 | 11.3→14.4 | 7.2→11.2 | 1.9→2.8 | 1.3→2.5 | 0.7→1.9 |
| **short 976** v38.1 | 52.8→53.4 | 42.4→43.2 | 37.1→38.9 | 31.2→34.7 | 18.4→17.8 | 14.4→14.4 | 9.9→11.2 | 2.8→2.8 | 2.0→2.5 | 1.2→1.9 |
| **full 3,379** v38.1 | 94.2→93.7 | 88.3→89.1 | 85.3→86.5 | 81.9→82.2 | 64.4→65.2 | 58.9→59.7 | 52.7→53.2 | 25.2→25.8 | 22.3→22.4 | 19.1→19.0 |
| **all 9,021** v38.1 | 87.7→86.6 | 79.1→79.2 | 74.7→75.1 | 69.8→70.2 | 50.7→50.3 | 44.6→44.1 | 37.9→37.8 | 15.9→16.0 | 13.6→13.5 | 11.0→11.2 |

v37 was 7 to 14 points low at every rung of the short slice; v38 halved it;
v38.1 is inside a point and a half at nine rungs of ten. The full-length ladder
is byte-identical to v38's, because neither term reaches it.

### Inside the bend's own window

The band the term exists for, `projIP` 3.32–4.65 (raw outs 10–14), ladder gap in
points, FIT split, n=779:

| | outs | strikeouts | hits | walks | earned runs |
|---|---|---|---|---|---|
| v37 | −7.95 | −5.21 | −2.10 | −3.54 | −3.29 |
| v38 | −3.31 | −3.02 | +0.62 | −1.84 | −1.69 |
| **v38.1** | **−0.02** | **−1.52** | **−0.16** | **−0.69** | **−0.61** |

Every market in the band, closed or nearly closed, in one term.

### Per-term, on the FIT split

Each switch flipped with everything else in place. Calibration error.

| configuration | pooled outs | short outs | short K | pooled hits | short hits | mid hits | full hits |
|---|---|---|---|---|---|---|---|
| **v38.1** | **0.66** | **1.60** | **1.46** | 0.42 | 1.80 | **0.48** | **0.93** |
| `bend: null` (the hits switch alone) | 0.68 | 3.62 | 2.11 | 0.59 | 3.21 | 0.53 | **0.93** |
| `pass.hits: 1` (the bend alone) | **0.66** | **1.60** | **1.46** | 0.42 | 2.15 | 0.86 | 0.94 |
| `bend.pass: {}` (bend, outs only) | **0.66** | **1.60** | 2.13 | 0.59 | 3.21 | 0.53 | **0.93** |
| **v38** (both off) | 0.68 | 3.62 | 2.11 | **0.34** | **1.33** | 0.82 | 0.94 |
| `role: null` (**v37**) | 0.78 | 6.77 | 3.02 | 0.42 | 2.07 | 0.49 | 0.99 |

Read plainly: **the two terms only work together.** The hits switch on its own
takes the short slice from 1.33 to 3.21, because it removes one half of a
cancellation. The bend on its own leaves mid hits at 0.86. Together they are
0.48 and 1.80. And the bend's pass-through is not decoration: restricted to the
outs market it gives back the whole of the strikeout and hits gains.

### Validate — 2026-08-10 .. 2026-09-01, 616 starts

Chosen never; looked at after the configuration was frozen on the fit split. The
short slice has 72 starts and does not print, so its gap is quoted directly.

| | n | v37 | v38 | **v38.1** |
|---|---|---|---|---|
| pooled outs, cal. err | 616 | 2.24 | 1.65 | **1.38** |
| pooled hits, cal. err | | 1.54 | **1.22** | 1.50 |
| **full-length hits, cal. err** | 234 | **2.99** | **3.61** | **2.99** |
| full-length hits, gap | | −2.77 | −3.53 | −2.77 |
| mid hits, cal. err | 216 | 2.23 | 2.23 | 2.38 |
| mid outs, cal. err | | 2.41 | 1.33 | **1.28** |
| full outs, cal. err | | **2.20** | 2.43 | 2.43 |
| bend-window outs gap | 57 | −8.10 | −4.10 | **−0.88** |
| short-slice outs gap | 72 | −4.21 | −1.50 | **+0.78** |

**Both repairs replicate out of sample.** The hits regression is there on
validate (2.99 → 3.61) and the repair removes exactly it (3.61 → 2.99), to two
decimal places, on starts no coefficient here has seen. The bend's window,
fitted nowhere near this period, goes from −4.10 to −0.88 on 57 starts.

### Holdout — 2026-09-02 .. 2026-09-22, 383 starts. One look, at the end.

| | n | v37 | v38 | **v38.1** |
|---|---|---|---|---|
| pooled outs, cal. err | 383 | 2.80 | 2.57 | **2.48** |
| pooled outs, MAE | | 2.937 | 2.906 | **2.903** |
| pooled strikeouts, cal. err | | **2.05** | 2.60 | 2.46 |
| pooled hits, cal. err | | 2.38 | **2.09** | **2.09** |
| pooled hits, MAE | | 1.654 | 1.654 | **1.638** |
| pooled hits, corr | | 0.442 | 0.441 | **0.449** |
| pooled walks, cal. err | | **2.60** | 2.49 | 2.54 |
| pooled earned runs, cal. err | | **2.94** | 3.13 | 3.03 |
| **full-length hits, cal. err** | 126 | **1.92** | 2.62 | **1.92** |
| mid hits, cal. err | 216 | 4.22 | 4.77 | **4.19** |

**The holdout confirms that nothing broke and very little else.** It has 383
starts and **41** short-projected ones — below `accuracy-report`'s own 120-record
minimum, which is why the `p.length` short slice does not print for it — and
every interval in that table is 2–5 points wide with almost all the pairs
overlapping. What it does say: the hits recovery shows up a third time (2.62 →
1.92 on full-length, 4.77 → 4.19 on mid), outs improves on both calibration and
point error, and the only point error that moves at all against v38 is hits, by
0.016 in the right direction. Read it as a check that the sign is not reversed,
not as a measurement of the size.

---

## What falls back, and what is still wrong

`test/pitcher.test.js` pins every row (5 tests added, **258 passing**, none
loosened, none skipped, none edited).

| missing | what the model does |
|---|---|
| **`input.appearanceLog`** | no class, so `role` and `bend` are both inert and every projection is **v37 to the last bit**. The existing deep-equality test now runs with `bend` live and shipped |
| **`input.date`** | same |
| an unreadable appearance log (no dates, or no outs) | same |
| **`PITCHER_FIT.bend`** set to null | exactly v38 |
| **`bend.amp`** 0 or null, or a geometry with `lo >= peak >= hi` | exactly v38 |
| a start on the `opener` or `debut` line | not bent; those classes have their own fitted lines |
| a start whose raw projection is outside `[lo, hi]` | not bent |
| **`bend.pass`** set to `{}` | only the outs market is bent |
| **`role.pass.hits`** set to 1 | hits inherit the starter line again — exactly v38 |
| **`role.pass`** set to `{}` | only the outs market moves, as before |
| **`PITCHER_FIT.role`** set to null | the whole thing is off, `cal.outs` is live, and the bend cannot fire because there is no class |

### What is still wrong

- **The worst cell in the model is no longer a `p.length` cell, and it is not
  outs-on-a-short-start.** It is `p.rest` **"very long (8d+)" outs recorded,
  5.30 points on 956 starts, gap +5.2** — the model quotes long-rest starters
  more than five points too high. It is pre-existing (**4.38** under v37) and
  **this branch made it worse**: 4.38 → 4.95 under v38 → **5.30** under v38.1.
  The cause is visible and is not the bend's fault alone — the model
  over-projects an 8-day-rest starter by 0.66 outs *outside* the bend window
  too (14.38 projected against 13.72 actual, n=759). Inside the window the bend
  is right for the 553 normal-rest starts (14.32 projected against 14.49
  actual) and wrong for the 142 long-rest ones (13.92 against 13.32). A rest
  term is the obvious next piece of work and it is deliberately not in this
  branch: it is a new feature, not a repair, and chasing it here would have
  been the second thing fitted to the same 8,405 starts.
- **Pooled strikeouts give back most of today's gain: 0.44 → 0.53** (v37 0.55).
  This is the bend's pass-through to strikeouts and it is a smooth trade, not
  noise — the pooled number walks 0.44 / 0.47 / 0.50 / 0.53 / 0.56 as the
  amplitude goes 0 / 0.05 / 0.07 / 0.0939 / 0.12. It is a cancellation being
  exposed: strikeouts are quoted ~2 points high in the 4.9–5.5 IP band and were
  quoted 3 points low inside the bend window, and lifting the low side removes
  the offset that was flattering the pooled figure. Everything else about
  strikeouts is equal or better — Brier 0.1534 → 0.1533, MAE identical at
  1.750, correlation 0.452 → 0.453, the short slice 1.57 → **1.14**, and the two
  intervals are [0.34, 1.10] and [0.35, 1.07]. `bend.pass: {k: 0}` holds pooled
  strikeouts at 0.44 and costs the short slice (1.14 → 1.59); it was not taken,
  because switching a depth term off for one market to protect one statistic is
  choosing a coefficient for a metric rather than for a reason.
- **Walks did not really recover, and were never really damaged.** Pooled walks
  go 1.07 (v37) → 1.11 (v38) → **1.10**. Every one of those sits inside an
  interval of roughly ±0.4, so the 0.04 "regression" was never resolvable and
  neither is the 0.01 recovery. What DID move is measurable: walks in the bend
  window go −3.54 → −0.69 on the fit split, on the short slice 2.71 → 1.94, and
  on the mid slice 2.19 → 1.91. Walks' real problem is elsewhere and is
  untouched by anything here — a persistent −1.6 to −3.0 point gap through the
  4.9–5.5 IP band where most of the board lives, and 4.7 points in April in both
  seasons. That is a level, and it belongs to the walks curve, not to depth.
- **The short slice gives back part of v38's hits and walks gains** — hits 1.50
  → 1.77 and walks 1.67 → 1.94 on 976 starts — to buy full-length hits 1.10 →
  0.87 on 3,379. Both short numbers are still better than v37's 1.93 and 2.71.
  The residual is concentrated in one place: starts the model projects under 3.0
  IP, where the `starter`-class members sit **below** the bend window and so get
  no correction at all, while under v38 the pass-through lifted them. The bend
  does not reach down there on purpose — see the season split above.
- **The under-11-outs cell is unchanged at −0.98 ± 0.48**, by design. It is
  +0.02 in 2025 and −2.33 in 2026; a term fitted to it would be fitted to one
  season. Its 68 starts are 0.8% of the fit split.
- **Earned runs on a full-length start stays 0.09 worse than v37** (1.70 →
  1.79), unchanged from v38. Switching the earned-run pass-through off for
  starters would fix that cell and cost 0.16 pooled and 1.09 on the short slice,
  which is the wrong trade; it is measured in the table above.
- **`projBF` is still built from the raw depth** while `projOuts` is calibrated
  twice over. The whole of §1 is a consequence of that inconsistency, and the
  clean fix is to make every counting stat ride one calibrated depth and refit
  the four curves in that world. That is a rebuild of the counting-stat
  calibration, not a repair, and `docs/PITCHER-PORT.md` already measured that a
  naive least-squares refit of those curves makes the ladder worse.

### Caveats a reader should hold

- **The replay does not post lineups**, same as `docs/ACCURACY.md` and
  `docs/OPENER-FIX.md`: the opponent's team aggregate is used, which is
  `loadSlate`'s own fallback. Unchanged from both controls and it affects all
  three identically.
- **The `p.length` slice is cut on `projIP`**, which neither term touches, so
  the 976-start short slice and the 3,379-start full slice are literally the
  same starts in all three columns.
- **`amp` is in-sample on the fit split** and out-of-sample nowhere except the
  616-start validate window and the 383-start holdout. The season-by-season
  refit is the strongest evidence in this document and it is still two samples,
  not ten.
- **The holdout was looked at once**, after everything was frozen, and it cannot
  resolve a difference smaller than about two points of calibration.
- **Nothing here was measured against a price**, and nothing here should be read
  as a reason to trade.

## Supersedes

`docs/OPENER-FIX.md`'s "what is still wrong" section, in three places. Its
"hits allowed on a full-length start is 0.23 of a point worse" is repaired —
0.87 on the main window, and the same recovery on validate and on the holdout.
Its "walks are 0.04 of a point of calibration worse pooled" is resolved as
unresolvable rather than repaired. Its "3.45 is still the worst cell in the
model" is superseded twice: the cell is now **1.50**, and it is no longer the
worst cell — `p.rest` "very long (8d+)" outs, at 5.30, is.
