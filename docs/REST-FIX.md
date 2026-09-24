# The layoff: what eight days off actually means

`docs/PITCHER-REPAIR.md` shipped two terms, named its own costs and handed
over the cell it had made worse:

> The worst cell in the model is `p.rest` **"very long (8d+)" outs recorded,
> 5.30 points on 956 starts, gap +5.2**. It is pre-existing (4.38 under v37)
> and this branch made it worse: 4.38 → 4.95 → 5.30.

This branch takes it. **It is 0.91 points now**, on the same 956 starts, with
the gap at +0.1. Nothing was measured against a price: `MARKET_WEIGHT`,
`PLAY_RULES`, the trading hurdle and everything under `src/trade/` are
untouched, and so is `src/data/`. Only `src/model/pitcher.js`, `tools/` and
`docs/` changed.

Names: **v38.1** is master (`c272f66`), **v38.2** is this branch. Both seasons,
lookahead-free, the existing replay, no new request.

---

## 1. The shape, across the whole range

Days of rest here is the DATE gap to his previous start, which is the cut
`tools/accuracy-report.mjs`'s `p.rest` slice already makes — so a gap of 5 is
the standard four days' rest. FIT split, 8,405 starts, 695 of which have no
previous start this season and so have no rest to read:

```
node tools/rest-fit.mjs --from 2025-03-20 --to 2025-10-01 --out .work/rest_25.ndjson
node tools/rest-fit.mjs --from 2026-03-20 --to 2026-09-22 --out .work/rest_26.ndjson
node tools/rest-fit.mjs --shape .work/rest_2*.ndjson
```

| gap | n | proj | actual | bias | ±se | projIP | ladder gap | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|
| ≤4 (short) | 25 | 7.80 | 6.32 | −1.48 | 0.78 | 2.54 | +5.27 | −0.90 | −1.71 |
| 5 (normal) | 2,367 | 15.96 | 16.14 | +0.17 | 0.07 | 5.33 | −1.22 | +0.15 | +0.20 |
| 6 (six-man) | 3,676 | 15.96 | 16.01 | +0.05 | 0.06 | 5.33 | −0.50 | +0.14 | −0.08 |
| 7 | 741 | 15.85 | 15.76 | −0.09 | 0.13 | 5.30 | +0.54 | −0.16 | +0.01 |
| 8–9 | 265 | 15.39 | 15.29 | −0.10 | 0.22 | 5.15 | +0.76 | −0.25 | +0.09 |
| 10–11 | 192 | 14.93 | 14.45 | −0.47 | 0.28 | 4.95 | +2.15 | −0.36 | −0.59 |
| 12–14 | 100 | 14.26 | 13.69 | −0.57 | 0.37 | 4.71 | +4.52 | −0.44 | −0.67 |
| 15–20 | 103 | 14.06 | 12.85 | −1.21 | 0.38 | 4.63 | +10.58 | −1.31 | −1.06 |
| 21+ | 241 | 12.75 | 11.54 | −1.21 | 0.21 | 4.19 | +9.64 | −1.62 | −0.71 |

**Nothing happens until ten days, and then it grows and levels off at about 1.2
outs.** That is the finding, and it is not the finding the "8d+" label implies.

**Short rest is not the mirror image, because it barely exists.** Twenty-five
starts on four days or fewer across two seasons, average projected length 2.54
innings — these are bullpen games the `role` line already reads, not aces going
on three days' rest. There is nothing there to fit and nothing here fits it.

**The 8–9 band is the All-Star break.** It is 54% July (see §3), and it is
unbiased: a whole rotation gets nine days off in the middle of July and nothing
is wrong with any of them. Lumping it in with a man coming off the injured list
is what made the 8+ bucket look like a smooth curve. It is not a curve, it is a
floor and then a ramp, and the ramp starts where a gap stops being a schedule.

**The model is not blind to this already** — projected IP falls from 5.33 to
4.19 across the table, because the workload term decays on a 20-day constant.
It moves about a third as far as it should.

## 2. Leash or effectiveness? Leash, with a small walk-and-run penalty

```
node tools/rest-fit.mjs --leash .work/rest_2*.ndjson
```

Ratio of actual to projected, per market, FIT split:

| band | n | outs | K | hits | walks | earned runs |
|---|---|---|---|---|---|---|
| 5 (normal) | 2,367 | 1.011 | 1.018 | 0.997 | 0.986 | 0.963 |
| 6 (six-man) | 3,676 | 1.003 | 0.983 | 1.005 | 1.028 | 1.028 |
| 7 | 741 | 0.994 | 1.027 | 1.000 | 0.962 | 1.014 |
| 8–9 | 265 | 0.994 | 1.013 | 1.026 | 0.940 | 1.027 |
| 10–11 | 192 | 0.968 | 0.956 | 0.958 | 0.996 | 0.923 |
| 12–14 | 100 | 0.960 | 0.900 | 1.001 | 0.959 | 0.981 |
| 15–20 | 103 | 0.914 | 0.882 | 0.914 | 1.003 | 1.071 |
| 21+ | 241 | 0.905 | 0.911 | 0.894 | 0.931 | 0.934 |
| **10+** | **636** | **0.936** | **0.919** | **0.935** | **0.968** | **0.961** |

Over the 10+ band the outing is 6.4% shorter than projected and **strikeouts
and hits fall with it almost exactly in proportion** — 8.1% and 6.5%, which as
an exponent on the outs ratio is 1.27 and 1.02. That is the leash: the same
pitcher, pitching the same way, for less of the game.

Walks and earned runs are the exception, and they say the effectiveness story
is real but small. They fall only 3.2% and 3.9%, exponents of 0.49 and 0.60,
because per out he is measurably worse:

| band | n | outs | K/out | H/out | BB/out | ER/out |
|---|---|---|---|---|---|---|
| 5 (normal) | 2,367 | 16.14 | 0.3118 | 0.3122 | 0.1084 | 0.1486 |
| 6 (six-man) | 3,676 | 16.01 | 0.3038 | 0.3145 | 0.1134 | 0.1585 |
| 10–11 | 192 | 14.45 | 0.2959 | 0.3146 | 0.1175 | 0.1517 |
| 12–14 | 100 | 13.69 | 0.2820 | 0.3324 | 0.1183 | 0.1644 |
| 15–20 | 103 | 12.85 | 0.2832 | 0.3263 | 0.1299 | 0.1941 |
| 21+ | 241 | 11.54 | 0.2970 | 0.3186 | 0.1233 | 0.1712 |

Strikeouts and hits per out sit where the model already puts them. **Walks per
out go 0.111 to 0.126 and earned runs per out 0.149 to 0.194.** A man back from
a fortnight off does not miss more bats and does not give up more hits — he is
wilder, and the walks turn into runs.

So the shorter outing and the worse rate point opposite ways in those two
markets and they roughly cancel. That is not an argument, it is the measurement
in §6: the pass-through is **on for strikeouts and hits, off for walks and
earned runs**, and switching it on for the other two costs pooled walks 0.97 →
1.07 and pooled earned runs 1.00 → 1.09.

## 3. Four things it could have been instead

```
node tools/rest-fit.mjs --confound .work/rest_2*.ndjson
```

### It is not the calendar

The bands do cluster, and the cluster is the All-Star break, not the season
edges:

| band | n | 03/04 | 05 | 06 | 07 | 08 | 09/10 |
|---|---|---|---|---|---|---|---|
| 5–6 | 6,043 | 21% | 21% | 20% | 15% | 14% | 9% |
| 7 | 741 | 20% | 17% | 21% | 16% | 15% | 11% |
| 8–9 | 265 | 8% | 10% | 12% | **54%** | 8% | 9% |
| 10–11 | 192 | 8% | 14% | 12% | **48%** | 10% | 8% |
| 12–14 | 100 | 11% | 17% | 16% | 38% | 8% | 10% |
| 15–20 | 103 | 7% | 25% | 24% | 25% | 8% | 11% |
| 21+ | 241 | 2% | 13% | 27% | 27% | 20% | 12% |

**The April hypothesis is structurally excluded.** A pitcher's first start of
the season has no previous start, so his rest is null, not large — those 695
starts are the slice's own "unknown" bucket and this term never touches them.
March and April are 2–11% of every long band.

The July cluster is real and it is why the 8–9 band is unbiased. Controlling
for it, outs bias by band within each month:

| month | 5–6 | 7 | 8–9 | 10–11 | 12+ |
|---|---|---|---|---|---|
| 03/04 | −0.08 (1236) | −0.22 (145) | −0.23 (20) | +0.53 (15) | −0.40 (22) |
| 05 | +0.24 (1307) | −0.20 (126) | +0.46 (27) | −0.14 (26) | −1.24 (75) |
| 06 | +0.07 (1190) | −0.02 (156) | −0.01 (32) | −0.53 (23) | −0.70 (105) |
| 07 | +0.13 (933) | +0.09 (121) | +0.08 (142) | −0.28 (93) | −1.14 (130) |
| 08 | +0.18 (833) | +0.62 (108) | −2.14 (21) | −1.77 (20) | −1.46 (63) |
| 09/10 | +0.03 (544) | −0.96 (85) | −0.03 (23) | −1.47 (15) | −1.17 (49) |

**The 12+ column is negative in all six months**, which is the answer: it
survives the calendar control. The 8–9 column does not survive it and does not
need to — it is centred on zero in five months of six.

### It is a starter effect, and the opener line is already right

| class | 5–6 | 7 | 8–9 | 10–11 | 12+ |
|---|---|---|---|---|---|
| starter | +0.09 (6013) | −0.09 (734) | −0.09 (255) | −0.43 (181) | **−1.26 (362)** |
| opener | +1.02 (30) | – (7) | −0.28 (10) | −1.13 (11) | −0.20 (82) |
| debut | – (0) | – (0) | – (0) | – (0) | – (0) |

Over all 93 long-rest relief starts the opener line is right to −0.31 ± 0.29
outs, so the term is gated on `starter`. Debuts cannot appear at all: a man
with no appearance this season has no previous start to measure from.

### It does not need to modulate the bend — it needs to sit beside it

`docs/PITCHER-REPAIR.md` reported that inside the bend window the correction
was right for normal-rest starts and wrong for long-rest ones, on an 8+ cut.
With the cut where the data actually puts it, that is not where the problem is:

| starter class | 5–6 | 7–9 | 10+ |
|---|---|---|---|
| inside the bend window (raw 10–14) | +0.16 (497) | −0.26 (83) | **−0.33 (108)** |
| outside it | +0.09 (5516) | −0.08 (906) | **−1.15 (435)** |

Inside the window the long-rest miss is −0.33 ± 0.38 on 108 starts — not
resolvable from zero. Outside it is −1.15 ± 0.18 on 435. **The layoff lives
almost entirely outside the bend's window**, so a rest term multiplying the
bend would be solving a problem that is not there. After this branch those two
cells read +0.27 and −0.08.

### The first start back is a different thing from a six-man rotation

Six-man rotation is a six-day gap, it is the single largest bucket on the board
(3,676 starts) and it is unbiased at +0.05. The layoff is not:

| 10+ days since his last start | n | proj | actual | bias | after |
|---|---|---|---|---|---|
| no appearance at all — a layoff | 328 | 15.47 | 14.48 | **−0.99** | +0.07 |
| relieved once in the gap | 136 | 14.99 | 14.55 | −0.44 | +0.26 |
| relieved 2+ times in the gap | 172 | 9.90 | 8.85 | −1.05 | −0.55 |

Measuring the gap to his last APPEARANCE of any kind rather than his last start
gives the same curve on a smaller sample (−0.45, −0.98, −1.02, −1.27 over the
same four bands). Both clocks agree, and the START clock ships because it keeps
more of the tail and is the one the slice already cuts on. The third row is
mostly openers, excluded by the class gate.

## 4. The term, and why it is a shrink and not a haircut

The obvious term is a flat percentage off projected depth. **It is measurably
the wrong shape.** Over the 10+ band, by the projection the model makes:

| projected IP | 4.0–4.5 | 4.5–5.0 | 5.0–5.5 | 5.5+ |
|---|---|---|---|---|
| n | 50 | 167 | 202 | 117 |
| outs bias | −0.41 | −0.79 | −1.03 | **−1.74** |

The miss grows with the projection far faster than a percentage does. A 6.4%
haircut is 0.9 outs at the bottom of that table and 1.1 at the top, against an
observed 0.4 and 1.7. What fits is the shape the intuition predicts and the
brief warned to check for: **the manager has planned a short assignment, and
how good the man is barely changes it.** So the term is the model's own
`shrinkToMean`, applied to the projection rather than to a rate — projected
depth is pulled toward `anchor` by a weight that grows with the layoff.

Side by side at the shipped geometry, on the same starts:

| projected IP | n | line | haircut says | shrink says | actual | bias, haircut | bias, shrink |
|---|---|---|---|---|---|---|---|
| 0–4.0 | 39 | 12.13 | 11.17 | 11.96 | 11.72 | +0.55 | −0.24 |
| 4.0–4.5 | 48 | 14.30 | 13.23 | 13.64 | 13.94 | +0.71 | +0.30 |
| 4.5–5.0 | 155 | 14.75 | 13.73 | 13.95 | 13.83 | +0.10 | −0.12 |
| 5.0–5.5 | 190 | 15.70 | 14.71 | 14.57 | 14.75 | +0.04 | +0.19 |
| 5.5+ | 111 | 16.79 | 15.87 | 15.42 | 15.16 | −0.71 | −0.26 |

The haircut leaves the deep end 0.71 outs long and the 4.0–4.5 band 0.71 short;
the shrink leaves them −0.26 and +0.30. It also takes 13% more out of the
squared error on the fit split (771 against 682, of a flat 98,766) and 43% more
on the validate window (99.5 against 69.4).

```js
rest: { knee: 9, cap: 16, anchor: 13, perDay: 0.0946, pass: { k: 1, hits: 1 } }
```

`knee` / `cap` are the ramp in days — zero at and below `knee`, one per day,
flat from `cap` up. `perDay` is the fraction of the distance to `anchor` closed
per day of it, so the deepest pull is 0.662 and the map never flattens.

**It is one-sided.** A start already projected at or below the anchor is left
exactly where it is, never lifted. Those starts come in 0.4 outs SHORT of their
projection after a layoff (the 0–4.0 row above), not long, so the symmetric
form would push them the wrong way. A test pins it.

### The fit, and how stable it is

```
node tools/rest-fit.mjs --fit .work/rest_2*.ndjson
```

`perDay` is fitted by least squares of actual outs on the shrunk line over the
`starter` class of the FIT split — the same recipe and the same split as the
three role lines and the bend, not a sweep on the ladder.

| knee | cap | anchor | perDay | se | t | 2025 | 2026 | ΔSSE | validate ΔSSE | deepest pull |
|---|---|---|---|---|---|---|---|---|---|---|
| 9 | 16 | 11.5 | 0.05896 | 0.00776 | 7.6 | 0.07035 | 0.04311 | 749 | 87.9 | 0.413 |
| 9 | 16 | 12 | 0.06776 | 0.00886 | 7.6 | 0.08065 | 0.04985 | 759 | 91.1 | 0.474 |
| **9** | **16** | **13** | **0.09457** | **0.01227** | **7.7** | **0.11123** | **0.07150** | **771** | **99.5** | **0.662** |
| 9 | 16 | 13.5 | 0.11556 | 0.01506 | 7.7 | 0.13438 | 0.08955 | 764 | 104.3 | 0.809 |
| 9 | 16 | 14 | 0.14379 | 0.01920 | 7.5 | 0.16382 | 0.11605 | 718 | 105.8 | 0.900* |
| 9 | 18 | 13 | 0.07892 | 0.01017 | 7.8 | 0.09291 | 0.05914 | 780 | 90.7 | 0.710 |
| 9 | 20 | 13 | 0.06843 | 0.00885 | 7.7 | 0.07997 | 0.05140 | 776 | 83.5 | 0.753 |
| 8 | 16 | 13 | 0.07915 | 0.01035 | 7.6 | 0.09203 | 0.06176 | 758 | 96.4 | 0.633 |
| 10 | 16 | 13 | 0.11322 | 0.01476 | 7.7 | 0.13310 | 0.08489 | 764 | 96.9 | 0.679 |
| 9 | 16 | 15 | 0.23242 | 0.03573 | 6.5 | 0.25508 | 0.20031 | 460 | 67.0 | 0.900* |

\* against the 0.9 safety clamp, which is why those rows fall over.

Over knee 8–10, cap 16–20 and anchor 11.5–13.5 the fit is flat to within about
4%, and `t` sits at 7.6–7.8 throughout. **(9, 16, 13) is inside that region and
at the edge of none of the three sweeps.** Nothing here was chosen on a ladder
or on a calibration number.

**Honest about the replication.** The bend's amplitude was 0.0938 in 2025 and
0.0941 in 2026, which is why `docs/PITCHER-REPAIR.md` shipped it without
shrinkage. **This one is not that good: 0.1112 against 0.0715.** Each season on
its own is about six standard errors from zero and they differ by roughly two
standard errors of their difference, so the two seasons agree on the sign and
the rough size and not on the second digit. The pooled estimate ships, and no
shrinkage was applied, because shrinking toward zero a coefficient both seasons
put six standard errors from zero would be choosing the prior over the data.
A reader who wants the conservative number should read the 2026 fit, which
would move the deepest pull from 0.66 to 0.50.

### Days of rest costs nothing to compute

`restDaysFrom(appearanceLog, date)` reads the last entry with `gs > 0` strictly
before tonight. `src/data/loadSlate.js` already builds `appearanceLog` with
`date` and `gs` on every row, for `PITCHER_FIT.role`. **loadSlate needs no new
request and is not touched by this branch** — `git diff master -- src/data/` is
empty.

## 5. Before and after

Same harness as `docs/ACCURACY.md`, `docs/PITCHER-PORT.md` and
`docs/PITCHER-REPAIR.md`.

```
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --out .work/v382_25.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --out .work/v382_26.ndjson
node tools/accuracy-report.mjs .work/v382_2*.ndjson --slices --holdout 2026-09-02
# v38.1: add --fit '{"rest":null}'
```

The slices below are cut to the main window (`--holdout 2099-01-01` on a
date-filtered file), because `accuracy-report`'s `--slices` pass reads every
record including the holdout.

### The cell this branch exists for — main window, 9,021 starts

Calibration error in points, and the gap in points.

| `p.rest` **very long (8d+)**, n=956 | v38.1 ECE | **v38.2** | v38.1 gap | **v38.2 gap** | v38.1 MAE | **v38.2** |
|---|---|---|---|---|---|---|
| **outs recorded** | **5.30** | **0.91** | +5.2 | **+0.1** | 2.773 | 2.697 |
| strikeouts | 3.10 | **1.67** | +3.0 | **+0.8** | 1.550 | **1.521** |
| hits allowed | 2.37 | **0.50** | +2.3 | **−0.3** | 1.620 | **1.594** |
| walks | 1.99 | 1.99 | +1.2 | +1.2 | 0.980 | 0.980 |
| earned runs | 1.39 | 1.39 | +0.7 | +0.7 | 1.520 | 1.520 |

Its outs ladder, quoted → observed:

| | 11.5 | 12.5 | 13.5 | 14.5 | 15.5 | 16.5 | 17.5 | 18.5 | 19.5 | 20.5 |
|---|---|---|---|---|---|---|---|---|---|---|
| v38.1 | 79.1→74.2 | 70.0→63.5 | 65.4→57.9 | 60.2→53.6 | 42.3→35.9 | 36.6→31.0 | 30.4→25.8 | 12.0→8.5 | 10.1→6.5 | 8.0→5.4 |
| **v38.2** | 75.9→74.2 | 65.0→63.5 | 59.3→57.9 | 53.1→53.6 | 35.3→35.9 | 29.7→31.0 | 23.5→25.8 | 8.7→8.5 | 7.2→6.5 | 5.5→5.4 |

Five to seven points too high at every rung, to within a point and a half at
nine rungs of ten.

### What happened to normal-rest starts: **nothing, to the decimal**

| `p.rest` | n | outs | K | hits | walks | earned runs |
|---|---|---|---|---|---|---|
| normal (5d) | 2,543 | 1.41 → **1.41** | 0.78 → 0.78 | 0.69 → 0.69 | 0.79 → 0.79 | 1.25 → 1.25 |
| long (6–7d) | 4,781 | 0.79 → **0.79** | 0.83 → 0.83 | 0.96 → 0.96 | 1.88 → 1.88 | 1.54 → 1.54 |
| unknown (no previous start) | 710 | 2.08 → **2.08** | 1.59 → 1.59 | 1.73 → 1.73 | 3.59 → 3.59 | 2.16 → 2.16 |

**8,337 of the 9,021 starts on the board are byte-identical before and after**,
which is every start whose gap is nine days or less plus every start with no
gap to read. The 684 this branch changes are all starts by a man who has not
started in ten days.

### Every pitcher market, pooled — main window

| | v38.1 | **v38.2** |
|---|---|---|
| strikeouts, cal. err | 0.53 [0.32, 1.02] | **0.38** [0.32, 0.81] |
| outs recorded, cal. err | **0.65** [0.55, 1.01] | 0.77 [0.52, 1.29] |
| hits allowed, cal. err | **0.41** [0.33, 0.95] | 0.55 [0.38, 1.15] |
| walks, cal. err | 1.10 | 1.10 |
| earned runs, cal. err | 1.02 | 1.02 |
| strikeouts MAE / corr | 1.750 / 0.453 | **1.747 / 0.455** |
| outs MAE / corr | 2.697 / 0.545 | **2.689 / 0.550** |
| hits MAE / corr | 1.695 / 0.345 | **1.692 / 0.348** |
| walks MAE / corr | 1.007 / 0.260 | 1.007 / 0.260 |
| earned runs MAE / corr | 1.565 / 0.198 | 1.565 / 0.198 |
| outs Brier | 0.1553 | **0.1544** |
| strikeouts Brier | 0.1533 | **0.1531** |
| hits Brier | 0.1712 | **0.1709** |

**Every point projection, every correlation and every Brier score is at or
better than v38.1.** Two pooled calibration numbers are worse and both are
explained in §7; their intervals overlap almost entirely.

### The other slices

| | n | v38.1 | **v38.2** |
|---|---|---|---|
| `p.length` short (<4.5 IP) outs | 976 | **1.50** | 1.63 |
| `p.length` short hits | 976 | **1.77** | 1.91 |
| `p.length` short strikeouts | 976 | 1.14 | 1.17 |
| `p.length` mid outs | 4,664 | 0.79 | **0.60** |
| `p.length` mid strikeouts | 4,664 | 0.91 | **0.77** |
| `p.length` full outs | 3,379 | **0.99** | 1.25 |
| `p.length` full hits | 3,379 | 0.87 | **0.86** |
| `p.sample` thin (≤3 starts) outs | 2,357 | 2.28 | **1.87** |
| `p.sample` building (4–10) outs | 2,813 | **0.97** | 1.50 |
| `p.sample` established (11+) outs | 3,849 | **0.67** | 0.98 |
| `p.sample` established strikeouts | 3,849 | 0.62 | **0.53** |

### Validate — 2026-08-10 .. 2026-09-01, 616 starts

Chosen never; looked at after the configuration was frozen on the fit split.
Its long-rest slice has 55 starts and does not print, so its numbers are quoted
from `tools/rest-fit.mjs --window`.

| | n | v38.1 | **v38.2** |
|---|---|---|---|
| **8+ rest, outs ladder gap** | 55 | **+8.91** | **+3.05** |
| **8+ rest, outs bias** | 55 | −1.33 | **−0.65** |
| 21+ rest, outs ladder gap | 31 | +9.21 | **+2.59** |
| pooled outs MAE / corr | 616 | 2.655 / 0.582 | **2.635 / 0.591** |
| pooled outs, cal. err | | **1.38** | 1.88 |
| pooled strikeouts, cal. err | | 3.08 | **2.95** |
| pooled strikeouts MAE | | 1.647 | **1.641** |
| pooled hits, cal. err | | **1.50** | 1.69 |
| pooled hits MAE / corr | | 1.710 / 0.363 | **1.706 / 0.367** |
| walks / earned runs | | unchanged | unchanged |

**The repair replicates out of sample.** The long-rest slice's ladder gap goes
+8.91 → +3.05 on starts no coefficient here has seen. The pooled calibration
numbers move the same way they do on the fit split and for the same reason
(§7); every point error moves in the right direction.

### Holdout — 2026-09-02 .. 2026-09-22, 383 starts

**This window has been read several times today and is CONTAMINATED.** It is
here as a sign check, nothing was selected on it, and it cannot resolve a
difference smaller than a couple of points.

| | n | v38.1 | **v38.2** |
|---|---|---|---|
| 8+ rest, outs ladder gap | 50 | +12.33 | **+6.40** |
| pooled outs, cal. err | 383 | 2.48 | **2.18** |
| pooled outs MAE / corr | | 2.903 / 0.612 | **2.884 / 0.625** |
| pooled strikeouts, cal. err | | 2.46 | **2.36** |
| pooled hits, cal. err | | **2.09** | 2.21 |
| pooled hits MAE / corr | | 1.638 / 0.449 | **1.630 / 0.454** |

The sign is the same in all three windows and the size is not readable here.

## 6. Per-term, on the FIT split

Each switch flipped with everything else in place. Calibration error in points.

| configuration | pool K | pool outs | pool hits | pool walks | pool ER | 8+ K | 8+ outs | 8+ hits | 8+ walks | 8+ ER | mid walks | mid ER |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **v38.2** | **0.43** | 0.74 | 0.56 | **0.97** | **1.00** | **1.67** | **0.94** | **0.72** | 1.95 | **1.57** | **1.73** | **1.40** |
| `pass` all four markets | **0.43** | 0.74 | 0.56 | 1.07 | 1.09 | **1.67** | **0.94** | **0.72** | **1.38** | 2.17 | 1.91 | 1.53 |
| `pass: {}` (outs only) | 0.47 | 0.74 | **0.42** | 0.98 | **1.00** | 3.01 | **0.94** | 2.13 | 1.95 | **1.57** | **1.73** | **1.40** |
| `rest: null` (**v38.1**) | 0.48 | **0.66** | **0.42** | **0.97** | **1.00** | 2.99 | 5.12 | 2.13 | 1.95 | **1.57** | **1.73** | **1.40** |

Read plainly: **turning the pass-through off for strikeouts and hits gives back
the whole of their gain** (1.67 → 3.01 and 0.72 → 2.13) and **turning it on for
walks and earned runs costs more than it buys** — it wins 0.57 points in one
cell, 8+ walks, and loses in pooled walks, pooled earned runs, 8+ earned runs,
mid walks and mid earned runs. That is the measurement behind §2's claim that
the leash and the effectiveness penalty cancel in those two markets.

## 7. What is still wrong

- **Pooled outs calibration goes 0.65 → 0.77 and pooled hits 0.41 → 0.55, and
  it is a cancellation being exposed, not damage.** The outs ladder gap on the
  whole board was +0.08 before this branch. That was **+6.97 on the 684
  long-rest starts against −0.49 on the other 8,337**. This branch takes the
  +6.97 to −0.11 and leaves the −0.49 exactly where it was — measured, on the
  same file, `rest <=9 or unknown: −0.49 → −0.49`. The pooled figure gets worse
  because it was being flattered. The same arithmetic explains every degraded
  cell in §5: `p.length` full outs, `p.sample` building and established outs,
  and the short slice. All of them moved 0.3 to 0.7 points in the negative
  direction and none of them changed a single projection that is not a layoff.
  **The residual −0.49 is the next piece of work and it is not a level**: it is
  −1.22 on five-day gaps, −0.50 on six-day ones and +0.54 on seven-day ones,
  and a shrink cannot fix it because the sign is wrong — it needs a lift, and
  the point bias it would be fitted to is +0.17 ± 0.07 outs. It was
  deliberately not chased here; chasing it would have been the second thing
  fitted to the same 8,405 starts.
- **The worst cell in the pitcher model is now a WALKS cell, and this branch
  does not touch walks at all.** With `accuracy-report`'s own n≥120 floor it is
  `p.month` 2026-03 walks, 6.29 points on 150 starts, gap −6.3. Restricted to
  cells with at least 500 records — the reading under which
  `docs/PITCHER-REPAIR.md` called the 8d+ outs cell the worst — it is
  **`p.month` 2026-04 walks, 4.68 points on 783 starts, gap −4.4**, with
  2025-04 walks at 4.26 on 782 behind it. This is exactly the residual
  `docs/PITCHER-REPAIR.md` already named: "4.7 points in April in both seasons
  … that is a level, and it belongs to the walks curve". It is identical before
  and after. The 8d+ outs cell is no longer in the top eight by either reading.
- **The 8–9 day band keeps its +0.76 ladder gap**, by design: the knee is at
  nine days and that band is the All-Star break and is unbiased in point terms
  (−0.10 ± 0.22). Moving the knee to eight buys the 8+ cell a little and costs
  the fit (ΔSSE 758 against 771) and the season stability.
- **The "unknown" rest slice is untouched and is its own problem.** 710 starts
  with no previous start this season, outs at 2.08 points and a +1.8 gap, and
  walks at 3.59. Those are debuts and season openers; they are the `role.debut`
  line's population, not this one's, and a term that read "days since his last
  2025 start" would be a different feature with a different fit.
- **A long-rest start the model already projects short is left alone and is
  still 0.4 outs long** (the 0–4.0 row of §4, n=39, ±0.74). The one-sided clamp
  is the reason and it is the right trade: the alternative form lifts those
  starts, which is the wrong direction.
- **Openers with 10+ days off are −0.31 ± 0.29** and are excluded by the class
  gate. The "relieved 2+ times in the gap" row of §3 is mostly them, and it
  keeps −0.55.
- **`amp`'s two seasons differ by 55%** — 0.1112 against 0.0715 — against the
  bend's three decimal places. §4 says what that does and does not license.
- **Both the bend and this term now act on the same starts in a small overlap**
  (108 of them), and inside the bend window the long-rest cell goes −0.33 →
  +0.27. That is a slight over-correction, well inside its own ±0.38, and
  modulating the bend by rest was measured and is not warranted — see §3.

### Caveats a reader should hold

- **The replay does not post lineups**, same as `docs/ACCURACY.md`,
  `docs/OPENER-FIX.md` and `docs/PITCHER-REPAIR.md`: the opponent's team
  aggregate is used, which is `loadSlate`'s own fallback. It affects both
  columns identically.
- **`perDay` is in-sample on the fit split** and out of sample only on the
  616-start validate window (55 long-rest starts) and the contaminated holdout.
  The season-by-season refit is the strongest evidence here and it is two
  samples, not ten.
- **The `p.rest` slice is cut on the same date gap the term reads**, so the
  headline cell is not an independent check of the feature — it is the cell the
  term was built to close. The validate window and the per-market behaviour in
  §2 and §6 are the parts that are not circular.
- **Nothing here was measured against a price**, and nothing here should be
  read as a reason to trade.

## What falls back

`test/pitcher.test.js` pins every row: 5 tests added, **265 passing**, none
loosened, none skipped, none edited.

| missing | what the model does |
|---|---|
| **`input.appearanceLog`** | no class, so `role`, `bend` and `rest` are all inert and every projection is **v37 to the last bit** |
| **`input.date`** | same |
| a log with no previous START in it — a season debut, a man who has only relieved | no rest to read, exactly v38.1 |
| an unreadable log (no dates, or no `gs`) | same |
| **a gap at or below `knee`** | exactly v38.1 — 8,337 of the 9,021 starts on the board |
| **`PITCHER_FIT.rest`** set to null | exactly v38.1 |
| **`rest.perDay`** 0 or null, **`rest.anchor`** null, or `cap <= knee` | exactly v38.1 |
| a start on the `opener` or `debut` line | not shrunk; those classes have their own fitted lines |
| a start already projected at or below `anchor` | not shrunk, and never lifted |
| **`rest.pass`** set to `{}` | only the outs market moves |
| **`rest.pass`** set to all four markets | walks and earned runs carry it too — measured in §6 |

## Supersedes

`docs/PITCHER-REPAIR.md`'s "what is still wrong", in one place. Its "the worst
cell in the model is `p.rest` very long (8d+) outs recorded, 5.30 points" is
repaired: **0.91 on the main window**, and the same recovery on validate and on
the contaminated holdout. Its reading that the bend is wrong specifically for
long-rest starts inside the bend window is superseded — on the cut the data
supports, the layoff lives outside that window and the two terms do not
interact. Its April walks residual is untouched and is now the worst cell in
the pitcher model.
