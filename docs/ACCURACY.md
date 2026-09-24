# How accurate are the projections? (2026-09-23, second edition)

**This does not ask whether the model beats a price. It asks whether the
numbers on the board are true.** `docs/AUDIT.md` closes the price question.
This grades the shipped projections against the box score, across two full
seasons, so the numbers can be used on their own — reading the board, playing
markets independently, working the DFS view.

The first edition of this document was written before seven model changes
landed. Every headline number in it is now wrong, most of them in the model's
favour. This is a complete re-measurement on the shipped models at `9cb0f82`,
not an update: every table below was regenerated from scratch.

Two full replays, no lookahead anywhere: **9,404 starts**, **86,220
batter-games** and **4,486 games**, 2025 and 2026 through 2026-09-22. The
**main window** — the figure in every table unless a holdout is named — is
**9,021 starts, 81,306 batter-games and 4,213 games**. The last three weeks
(**2026-09-02..09-22**, 383 starts, 4,914 batter-games, 273 games) are reported
beside it.

**The last three weeks are no longer a holdout.** That window has been read by
the pitcher port, the opener fix, the pitcher repair, the rest fix, the park
fix, the batter port and the batter calibration work — in one day. It is
reported separately below because stability over time is worth seeing, and for
no other reason. It cannot confirm anything, and where it disagrees with the
main window the main window is the one with 9,021 starts in it.

Nothing here reads The Odds API or Kalshi. Public MLB StatsAPI only.

---

## The trust table

"Calibration error" is the sample-weighted mean gap between a quoted
probability and how often that thing actually happened (ECE, in percentage
points), with the signed pooled gap beside it; **a negative gap means the model
quotes too LOW.** "Ranks players" is the correlation between a player's mean
projection and his mean realised production across a season, against the
highest correlation *any* projection could score against a target measured that
noisily — see "Ranking power" below for why this replaced the MAE column the
first edition used.

| Market | Sample | Calibration error | Ranks players (corr / ceiling) | Verdict |
|---|---|---|---|---|
| **Pitcher strikeouts** | 9,021 starts | **0.40 pts**, gap +0.2 [−0.3, +0.8] | **0.888 / 0.901 — 99%** | **Trustworthy, level and ordering.** Was 2.7 pts with every over 2.6 low; the market-fitted trim is gone |
| **Pitcher outs recorded** | 9,021 | **0.77 pts**, gap −0.5 [−1.2, +0.2] | **0.854 / 0.864 — 99%** | **Trustworthy across the whole ladder, short starts included.** Was 2.0 pts and unusable under 14.5 |
| **Pitcher hits allowed** | 9,021 | **0.55 pts**, gap −0.6 [−1.3, +0.0] | 0.770 / 0.771 — 100% | **Trustworthy pooled.** Do not read it by side: +0.5 at home against −1.5 on the road |
| **Pitcher walks** | 9,021 | 1.01 pts, gap −0.1 [−0.7, +0.6] | 0.796 / 0.794 — 100% | **Trustworthy, April included.** Was 4+ points off in the first month of both seasons |
| **Pitcher earned runs** | 9,021 | 1.02 pts, gap −0.3 [−1.0, +0.4] | 0.638 / 0.672 — 95% | **Trustworthy pooled and nowhere else.** +1.2 at home against −2.0 away: the worst cell in the model |
| **Batter hits** | 81,306 | **0.28 pts**, gap −0.2 [−0.4, +0.0] | **0.826 / 0.797 — at the ceiling** | **Trustworthy.** Was 0.70 pts. Thin hitters are no longer two points high |
| **Batter total bases** | 81,306 | **0.15 pts — the best-calibrated market in the model** | **0.828 / 0.792 — at the ceiling** | **Trustworthy** |
| **Batter home runs** | 81,324 | **0.14 pts**, gap −0.1 | 0.813 / 0.788 — at the ceiling | Trustworthy, but it only ever says 0–35%, so it rarely has a strong opinion |
| **Batter RBIs** | 81,306 | **0.23 pts** | 0.760 / 0.724 — at the ceiling | Trustworthy. Reads 1.1 points low for the middle of the order |
| **Batter hits+runs+RBIs** | 81,306 | **0.25 pts**, gap −0.3 | 0.823 / 0.799 — at the ceiling | **Trustworthy.** Was 0.70 pts and consistently low; the rebuilt tail fixed it |
| **Batter runs** | 81,306 | 0.58 pts, gap −0.2 | 0.791 / 0.762 — at the ceiling | Trustworthy pooled. Still the weakest batter market: −1.5 for the top of the order |
| **Batter strikeouts** | 81,306 | **0.28 pts** | 0.865 / 0.894 — 97% | **Trustworthy** |
| **Batter singles** | 81,306 | 0.31 pts, gap −0.3 | 0.787 / 0.776 — at the ceiling | Trustworthy |
| **Batter stolen bases** | 81,306 | **0.17 pts** | 0.869 / 0.888 — 98% | Calibrated, but it only ever says 1–31%. Use it to rank runners, not to price a line |
| **Moneyline** | 4,213 games | 0.62 pts pooled — **and that is two errors cancelling** | — | **Do not use.** Spans 33–72% with an SD of 6.3 points, beats a coin flip by 1.8% of Brier, and is 4 points wrong at each end of its own total range |
| **Game total** | 4,213 | 0.77 pts, gap +0.4 | 0.194 per game | Trustworthy standalone as a probability |
| **Run line** | 4,213 | 1.31 pts, gap +0.4 | 0.157 per game | Trustworthy standalone |
| **First inning (NRFI)** | 3,822 | 1.22 pts | — | **Too flat to use.** Spans 35–62% with an SD of 3.6 points and beats a coin flip by 1.0% of Brier |

**Every pitcher market moved from "add points to the over" to "trustworthy",
and the batter markets roughly halved.** Against the first edition: strikeouts
2.66 → **0.40**, outs 1.95 → **0.77**, hits allowed 2.04 → **0.55**, walks 1.05
→ **1.01**, earned runs 1.14 → **1.02**; batter hits 0.70 → **0.28**, total
bases 0.42 → **0.15**, H+R+RBI 0.70 → **0.25**, runs 0.78 → **0.58**.

**The holdout says the same thing about direction and nothing about
magnitude.** On 383 starts every pitcher market reads 2.2–3.0 points of ECE —
worse than the main window on all five — and the signs are mixed (strikeouts
+1.9, outs +0.5, hits +1.2, walks +0.8, earned runs −1.5), with intervals three
to five points wide. September 2026 ran low: 4.59 actual strikeouts and 14.72
outs against 4.76 and 15.43 over two seasons, so a model centred on the
two-season level reads slightly high in it. The batter markets hold: 0.22 to
1.23 points of ECE on 4,914 batter-games, no sign flip anywhere. The game
markets' holdout is 273 games and means nothing on its own.

### The three conditions under which not to rely on these numbers

1. **Any pitcher market read by side of the ballpark.** The model prices no
   home-field advantage into a starter. Home starters go **0.16 outs longer**
   than projected and allow **0.09 fewer earned runs**; away starters do the
   mirror. As probabilities that is **earned runs +1.4 points at home against
   −2.0 away**, **outs −1.6 at home against +0.7 away**, **hits allowed +0.6
   against −1.7**. It replicates in both seasons in both directions. The pooled
   figures in the trust table are the average of the two and are honest only if
   you take both sides equally. See "The largest remaining error".

2. **A debut start, and a starter the model still expects to go short.** On the
   **464 starts** by a pitcher with no appearance yet this season, the model
   reads him **+2.5 points high on outs**, **+2.6 high on hits allowed** and
   **−2.4 low on walks** — it gives a debutant a fuller, cleaner outing than he
   has. And on the **652 starts** where a pitcher the model classes as a
   *starter* is nonetheless projected under 4.5 innings, hits allowed reads
   **2.3 points low**. Genuine openers are fine now (see below); these two are
   what is left.

3. **The moneyline and the first inning, at all.** Neither has an opinion — 6.3
   and 3.6 points of SD — and the moneyline's flat pooled calibration is two
   opposite errors: in games it projects under 8.75 runs the home team wins
   **3.5 to 5.0 points more often** than quoted, and in games over 8.75 it wins
   **1.7 to 4.1 points less often**. Both seasons, same direction. A market that
   says roughly 53% to everything and is four points wrong at each end of its
   own range cannot be leaned on.

The first edition's three conditions were pitcher overs, short starts and thin
hitters. **All three are measured closed**, and they are answered one by one
next.

---

## The five questions the first edition left open

### 1. Do pitcher overs still read low? No.

The `kLevel` 0.95 and `hLevel` 0.97 trims — fitted against market prices, not
outcomes — are gone. Measured on the same 9,021 starts, shipped against the
same replay with the trims put back (`--tuning '{"kLevel":0.95,"hLevel":0.97}'`):

| market | trims restored | **shipped today** |
|---|---|---|
| strikeouts, calibration error | 2.75 pts | **0.40 pts** |
| strikeouts, pooled gap | −2.8 [−3.3, −2.2] | **+0.2 [−0.3, +0.8]** |
| strikeouts, point bias | +5.1% (model low) | **−0.1%** |
| strikeouts, bins outside their interval | **10 of 10** | **0 of 10** |
| hits allowed, calibration error | 2.51 pts | **0.55 pts** |
| hits allowed, pooled gap | −2.5 [−3.1, −2.0] | **−0.6 [−1.3, +0.0]** |
| hits allowed, point bias | +3.0% | **−0.1%** |
| hits allowed, bins outside their interval | 9 of 10 | 2 of 10 |

The strikeout ladder now reads 2.5: 81.6→81.0 · 3.5: 67.6→67.1 · 4.5: 51.5→51.0
· 5.5: 36.0→35.6 · 6.5: 23.0→22.9 · 7.5: 13.5→13.7 · 8.5: 7.4→7.9. Not one rung
is outside its interval. The point projection is 4.761 against 4.756 actual.

Walks are the one place a level statement needs care. `docs/WALKS-FIX.md`
reported the pooled walk level moving from 0.9% under to 0.9% over, and that is
what is on the board: projected 1.764 against 1.748 actual, **−0.9%**. It is the
right trade and it is not a regression — see "Cancellations".

### 2. Are short and opener starts still unreliable? No, and the old diagnosis was wrong.

The first edition put 1,159 starts in one "projected under 4.5 IP" bucket and
found the outs probabilities 6.8 points low. `docs/OPENER-FIX.md` established
that two thirds of that bucket was real starters being wrongly shortened by one
shrink fitted through two populations. Split by the class the model itself now
assigns — read from his last three appearances, relief included, before first
pitch:

| slice | n | outs | strikeouts | hits allowed | walks | earned runs |
|---|---|---|---|---|---|---|
| **opener** (longest recent outing ≤ 2 innings) | 338 | ECE 2.05, gap −1.5 | 1.19, −0.2 | 1.86, −0.7 | 2.84, +2.2 | 2.66, +0.7 |
| **debut** (no appearance yet this season) | 464 | 2.86, **+2.5** | 2.06, −1.4 | 2.61, **+2.6** | 3.72, **−2.4** | 2.02, −0.0 |
| **starter** | 8,600 | 0.72, −0.5 | 0.45, +0.4 | 0.66, −0.6 | 1.28, +0.0 | 1.15, −0.4 |
| projected under 4.5 IP (the old cut) | 1,017 | **1.50, −1.1** | 1.13, −0.6 | 1.87, −1.8 | 1.87, +0.7 | 1.38, +0.1 |
| *of which* opener, projected short | 331 | 1.88, −1.8 | 0.99, −0.4 | 1.50, −1.4 | 2.58, +1.9 | 2.64, +0.3 |
| *of which* **starter, projected short** | 652 | 1.30, −0.9 | 1.37, −0.9 | **2.39, −2.3** | 2.16, −0.1 | 1.21, +0.2 |

**The old cell went from 6.8 points low to 1.1 points low.** An opener's outs
line is now the most trustworthy thing about him. What survives is narrower and
different: a *starter* the model shortens still has his hits allowed read 2.3
points low, and a debutant is read too long and too clean across the board.

### 3. Are thin hitters still two points high? No — if anything a shade low.

| slice | n | hits | total bases | singles | H+R+RBI | runs |
|---|---|---|---|---|---|---|
| **under 50 PA this season** | 14,780 | ECE 0.37, gap **−0.1** | 0.37, +0.3 | 0.39, −0.4 | 0.28, −0.2 | 0.64, −0.1 |
| *the same cell, first edition* | 14,780 | 2.15, **+2.1** | 2.26, **+2.3** | 2.02, +1.7 | 1.61, +1.6 | 1.30, — |
| 50–199 PA | 31,074 | 0.19, +0.0 | 0.30, +0.3 | 0.36, −0.4 | 0.33, +0.3 | 0.85, +0.5 |
| **200+ PA** | 40,348 | 0.49, −0.3 | 0.52, −0.4 | 0.26, −0.2 | **0.66, −0.7** | **0.67, −0.7** |

The thin cell is now the *best*-calibrated of the three. The residual is at the
other end: an established regular is still quoted about **0.7 points low** for a
run or an H+R+RBI. `docs/BATTER-PLAYTIME-FIX.md` halved that (H+R+RBI from −1.1
to −0.7) and states plainly that what is left is lineup context reached through
a playing-time proxy, and will not come out with another playing-time term. It
fitted the term that would close it (`duty.scoring`) and **shipped it at zero**,
because out of sample it bought nothing and paid for the established band out of
the thin band.

### 4. Long-rest starters — fixed, or moved? Fixed, and what is left is elsewhere.

Cut by the layoff the rest term itself reads — days since his previous *start*:

| days of rest | n | outs | strikeouts | hits allowed | earned runs |
|---|---|---|---|---|---|
| ≤ 5 | 2,667 | ECE 1.33, gap −1.0 | 0.57, −0.3 | 0.76, −0.3 | 1.19, +0.8 |
| 6–7 | 5,000 | 0.78, −0.6 | 0.82, +0.6 | 0.90, −0.9 | **1.55, −1.3** |
| 8–9 | 284 | 2.26, +1.4 | 2.22, −1.0 | 2.75, −2.5 | 2.37, −1.4 |
| 10–14 | 312 | 1.62, −1.2 | 1.70, +0.8 | 1.09, −0.3 | 2.92, +2.4 |
| **15 or more** | 410 | **1.41, +1.0** | 1.94, +1.6 | 1.67, +1.5 | 2.09, +1.2 |
| unknown (first start of the season) | 729 | 2.17, +2.0 | 1.50, −0.6 | 1.98, +1.4 | 2.13, +0.6 |

Pooled over every start of ten days or more, the outs gap is **−0.2 [−1.9,
+1.6]** on 684 starts. `docs/PITCHER-REPAIR.md` named this the worst cell in the
model at **+5.2 on 956 starts**; it is gone. The eight-or-nine-day band keeps a
small positive gap by design — the leash does not engage until ten days — and
the six-to-seven-day band, which is now the modal rest, carries a −1.3 point
earned-run gap on 5,000 starts. That is not a rest effect; it is the home/away
split showing through. Note also that this slice is cut on the same date gap the
rest term reads, so it is a description rather than an independent check.

### 5. The worst remaining cell, named honestly.

> **SUPERSEDED, same day, by `docs/HOMEFIELD.md`.** The asymmetry this section
> and the one headed "The largest remaining error" describe was verified as
> real — not a harness artefact — and fitted: `PITCHER_TUNING` gained `homeH`,
> `homeBB` and `homeER` and `BATTER_TUNING` gained `homeHit`, `homeK` and
> `homeRun`. Away starters' earned runs now reads **1.21 with a −0.4 gap**
> against home's 1.21 / −0.3, and the worst cell on any 2,000+ slice is now
> **outs for a starter with three or fewer prior starts, 1.96 on 2,392**. Every
> number below this line describes the model at `8d01b22`, before that change.

**Away starters' earned runs: calibration error 2.32 points, gap −2.0, on 4,699
starts.** On any slice with more than two thousand events in it, nothing else in
the model is close — the next four are pitcher cells at 1.92, 1.82, 1.70 and
1.65. It is one half of the home/away asymmetry two sections below.

Below that, on smaller but still real slices: `p.month` 2025-08 earned runs
(3.65 on 842), 2025-09 hits allowed (3.64 on 748), 2026-06 hits allowed (3.27 on
788), 2026-08 walks (2.92 on 834). None of those four replicates as a pattern
across seasons and they read as month-level noise.

On the batter side the worst large cell is **the top of the order's runs: 1.49
points, gap −1.5, on 28,734 batter-games** — the leadoff man scores more often
than the model says, which is the same lineup-context gap as the
established-regular residual in question 3.

On the game side the worst cells belong to markets already marked unusable: the
first inning in games projected over ten runs (6.30 on 492) and the moneyline in
games projected 8.0–8.5 (5.01 on 795).

---

## Cancellations: where a pooled number is two opposite errors

Three of today's seven changes reported a pooled figure getting *worse* while
every component improved, because a fix removed one side of an offsetting pair.
Those are recorded here so a reader does not mistake them for regressions — and
so are the ones still on the board.

**Still live, and the reason the trust table's pitcher verdicts carry a
caveat:**

| pooled figure | what it is made of |
|---|---|
| pitcher earned runs, gap **−0.3 [−1.0, +0.4]** | home **+1.4 [+0.4, +2.2]** · away **−2.0 [−2.9, −1.1]** |
| pitcher outs, gap **−0.5 [−1.0, +0.1]** | home **−1.6 [−2.3, −0.8]** · away **+0.7 [−0.2, +1.5]** |
| pitcher hits allowed, gap **−0.6 [−1.2, +0.0]** | home **+0.6 [−0.2, +1.5]** · away **−1.7 [−2.6, −0.7]** |
| pitcher walks, gap **−0.1 [−0.6, +0.5]** | first 45 days **−0.9 [−2.1, +0.2]** · day 45 on **+0.2 [−0.5, +0.8]** |
| batter strikeouts, gap **+0.2** | home **+0.9** · away **−0.5** |
| batter runs, gap **−0.2** | home **−0.8** · away **+0.5** |
| moneyline, gap **−0.2 [−1.9, +1.1]** | projected total under 8.25 **−3.5** · 8.25–8.75 **−5.0** · 8.75–9.25 **+4.1** · over 9.25 **+1.7** |

**Already recorded in the branch documents, and not regressions:**

- `docs/REST-FIX.md`: pooled outs calibration 0.65 → 0.77 and pooled hits 0.41 →
  0.55. The board's outs gap of +0.08 was **+6.97 on 684 long-rest starts
  against −0.49 on the other 8,337**; the branch took the first to −0.11 and
  left the second untouched, verified byte-for-byte.
- `docs/WALKS-FIX.md`: the pooled walk level went from 0.9% under to 0.9% over.
  The −0.8 pooled gap was **−4.06 on 2,017 early-season starts against +0.17 on
  the other 7,004**; the branch took the first to −0.88 and left the second
  exactly. Measured again here on the shipped model, the same split now reads
  **−0.9 and +0.2**.
- `docs/BATTER-CALIBRATION-FIX.md`: pooled hits gap +0.11 → −0.30. The
  arithmetic is in that document: `0.19 × (+2.17 thin) + 0.81 × (−0.37
  regular) = +0.11`. The shipped pooled figure was two errors cancelling.
- `docs/PITCHER-REPAIR.md`: pooled strikeout calibration 0.44 → 0.53, because
  lifting the projections inside the bend window removed the offset that had
  been flattering the pooled number.
- `docs/PARK-FIX.md`: the park-level mean is the wrong cut entirely — it
  averages a venue's wind states together, so Wrigley's +3.2 runs with the wind
  out and −1.0 with it in showed up as +0.56 overall.

---

## The largest remaining error: the model prices no home-field advantage into a player

This is the one structural defect the seven fixes uncovered rather than closed.
It was visible in the first edition as "the home/away asymmetry splits the two
markets in opposite directions" and was set aside as a curiosity because the
level errors sitting on top of it were three times larger. They are gone; it is
not.

Point bias is actual minus projected, so a positive number means the player did
more than the model said. Gap is in percentage points.

| | 2025 home | 2025 away | 2026 home | 2026 away |
|---|---|---|---|---|
| pitcher outs, gap / bias | −1.77 / **+0.195** | +0.41 / −0.034 | −1.33 / **+0.143** | +0.97 / −0.171 |
| pitcher earned runs | +1.70 / **−0.109** | −2.41 / +0.099 | +1.02 / −0.075 | −1.54 / +0.077 |
| pitcher hits allowed | +0.86 / −0.102 | −1.47 / +0.063 | +0.23 / −0.066 | −1.90 / +0.084 |
| pitcher walks | +1.04 / −0.067 | −0.30 / −0.006 | +0.34 / −0.029 | −1.45 / +0.043 |
| batter runs | −0.82 / **+0.019** | +0.53 / −0.008 | −0.84 / **+0.020** | +0.48 / −0.007 |
| batter H+R+RBI | −0.98 / +0.056 | +0.41 / −0.013 | −0.88 / +0.051 | +0.41 / −0.017 |
| batter strikeouts | +0.89 / −0.028 | −0.64 / +0.019 | +1.02 / −0.032 | −0.43 / +0.013 |

**Read it as one thing, because it is one thing.** The home team's starter goes
longer and allows less than the model says; the home team's hitters score more,
drive in more and strike out less. The away team's players do the mirror, in the
same sizes. It replicates in every cell across both seasons. The game model
handles it — the moneyline quotes 53.0% and the home team won 53.2% — so this is
not a missing fact about baseball, it is a term that exists in
`src/model/game.js` and has no counterpart in `src/model/pitcher.js` or
`src/model/batter.js`.

Sizes, per event: **0.17 outs and 0.09 earned runs** between the two sides of a
pitching line, **0.03 of an H+R+RBI** between the two sides of a hitter. As
probabilities, up to **3.4 points of swing on an earned-run line** and about
**1.3 points on a batter's run line**.

**This was reported, not fixed, by the branch that wrote this document — and it
is fixed now: see `docs/HOMEFIELD.md`, which did both checks below before
writing a term.** Nothing under `src/` was touched by this
branch. Two cautions for whoever picks it up. The effect is measured against the
boxscore starter rather than the listed probable. And the pitcher replay uses
the opposing team's aggregate rather than a posted card, built the same way for
both sides, so part of what is attributed here to the side of the ballpark could
be an asymmetry in how that aggregate is built. That is a one-day check and it
should be done before a term is fitted.

---

## Calibration, market by market

Every quoted probability across the standard ladder, bucketed by decile, against
the frequency the outcome actually occurred. The interval is Wilson on the
observed side; a starred rung sits outside it. The pooled gap carries a cluster
bootstrap over games, because several lines on one start are not independent
bets on independent events.

Full per-decile tables: `.backtest-cache/accuracy.txt` (regenerate below).
**A negative gap means the model quotes too LOW.**

### Pitchers (main window: 9,021 starts with a projection; 2 had no prior line at all)

| market | ECE | gap [95%] | bins outside | line ladder, quoted → observed |
|---|---|---|---|---|
| strikeouts | **0.40 [0.29, 0.79]** | +0.2 [−0.3, +0.8] | 0 of 10 | 3.5: 67.6→67.1 · 4.5: 51.5→51.0 · 5.5: 36.0→35.6 · 6.5: 23.0→22.9 · 7.5: 13.5→13.7 |
| outs | 0.77 [0.56, 1.25] | −0.5 [−1.2, +0.2] | 3 of 10 | 11.5: 87.4→86.6* · 14.5: 69.1→70.2* · 15.5: 49.9→50.3 · 18.5: 15.5→16.0 · 20.5: 10.8→11.2 |
| hits allowed | 0.55 [0.37, 1.20] | −0.6 [−1.3, +0.0] | 2 of 10 | 2.5: 83.8→85.1* · 3.5: 69.6→71.4* · 4.5: 52.9→54.3* · 5.5: 36.6→36.8 · 6.5: 23.1→22.7 |
| walks | 1.01 [0.72, 1.48] | −0.1 [−0.7, +0.6] | 4 of 10 | 0.5: 81.6→82.2 · 1.5: 51.9→53.2* · 2.5: 26.3→25.9 · 3.5: 11.0→9.7* |
| earned runs | 1.02 [0.77, 1.58] | −0.3 [−1.0, +0.4] | 5 of 10 | 0.5: 83.9→82.2* · 1.5: 61.2→61.1 · 2.5: 40.3→41.3 · 3.5: 24.7→26.1* · 4.5: 14.3→15.3* |

The first edition reported eight of ten strikeout bins and nine of ten
hits-allowed bins outside their intervals, all in the same direction. It is now
zero and two. The outs distribution's old shape error — too wide at both ends,
85.1% quoted at 11.5 against 86.6% observed and 16.0% at 20.5 against 11.2% — is
also gone: 87.4→86.6 and 10.8→11.2.

### Batters (main window: 81,306 batter-games with a projection; 18 had none)

| market | ECE | gap [95%] | line ladder, quoted → observed |
|---|---|---|---|
| hits | 0.28 [0.18, 0.52] | −0.2 [−0.4, +0.0] | 0.5: 60.9→61.0 · 1.5: 21.5→21.7 · 2.5: 4.5→4.7* |
| total bases | **0.15 [0.10, 0.42]** | −0.1 [−0.3, +0.2] | 0.5: 60.9→61.0 · 1.5: 35.4→35.3 · 2.5: 20.5→20.6 · 3.5: 14.4→14.4 · 4.5: 6.8→6.9 |
| home runs | **0.14 [0.07, 0.28]** | −0.1 [−0.3, −0.0] | 0.5: 11.5→11.6 · 1.5: 0.6→0.8* |
| RBIs | 0.23 [0.12, 0.40] | −0.2 [−0.4, +0.0] | 0.5: 29.1→29.6* · 1.5: 10.4→10.5 · 2.5: 3.6→3.6 |
| H+R+RBI | 0.25 [0.12, 0.54] | −0.3 [−0.6, +0.0] | 0.5: 67.4→67.6 · 1.5: 45.3→45.6 · 2.5: 29.0→29.2 · 3.5: 17.1→17.4 · 4.5: 9.6→9.8* |
| runs | 0.58 [0.39, 0.77] | −0.2 [−0.5, +0.2] | 0.5: 37.7→37.6 · 1.5: 7.8→8.1* |
| strikeouts | 0.28 [0.19, 0.49] | +0.2 [−0.0, +0.4] | 0.5: 61.7→61.5 · 1.5: 22.2→21.9 · 2.5: 4.6→4.6 |
| singles | 0.31 [0.14, 0.59] | −0.3 [−0.6, −0.1] | 0.5: 44.6→45.0* · 1.5: 10.4→10.7* |
| stolen bases | **0.17 [0.06, 0.34]** | +0.1 [−0.1, +0.3] | 0.5: 6.7→6.6 |

The H+R+RBI tail the batter port set out to fix is fixed: at 2.5 the model said
27.8% against 29.2% observed in the first edition and says 29.0% against 29.2%
now; at 3.5, 16.5 → 17.4 has become 17.1 → 17.4.

### Game lines (main window: 4,213 of the 4,486 games that clear the ten-games-played cut)

| market | ECE | gap [95%] | sharpness | Brier vs the base rate |
|---|---|---|---|---|
| moneyline | 0.62 [0.53, 2.37] | −0.2 [−1.9, +1.1] | SD 6.3 pts, range 33–72% | 0.2445 vs 0.2490 (**1.8%**) |
| total | 0.77 [0.49, 1.89] | +0.4 [−0.7, +1.7] | SD 14.3 pts, range 13–91% | 0.2300 vs 0.2499 (8.0%) |
| run line | 1.31 [0.75, 2.29] | +0.4 [−0.6, +1.7] | SD 15.4 pts, range 19–81% | 0.2261 vs 0.2500 (9.5%) |
| first inning | 1.22 [0.31, 3.27] | −0.3 [−1.9, +1.5] | **SD 3.6 pts, range 35–62%** | 0.2475 vs 0.2500 (**1.0%**) |

Totals: over 6.5 67.8→67.6, 7.5 57.0→56.1, 8.5 49.4→48.7, 9.5 39.6→39.4, 10.5
33.2→32.9. Run line: home −1.5 36.0→35.6, home +1.5 64.5→64.1. The Wrigley wind
term moved the total's correlation from 0.177 to 0.194 and its Brier skill from
7.7% to 8.0%, exactly as `docs/PARK-FIX.md` said, and moved no posted line by
more than a tenth of a point.

**The posted lineup is still worth nothing to the game lines.** Re-run with the
lineup term switched off entirely (`--lineup none`), the three game markets
score 1.8% / 7.9% / 9.5% of Brier skill against 1.8% / 8.0% / 9.5% with both
cards posted. Whatever the cards are worth, it is below measurement here.

---

## Ranking power, and the metric the first edition used by mistake

The first edition ranked every market by "MAE against projecting the slate
average for everyone" and concluded that the batter point projections were
"worth almost nothing as a ranking". **That conclusion was an artefact of the
metric.** Mean absolute error on a count whose mass sits on zero and one is not
minimised at the conditional mean, so the metric pays for a lean. Multiply every
projection by a constant and score it (`--scale`):

| market | ×0.80 | ×0.90 | ×1.00 | ×1.05 | ×1.10 | ×1.20 | slate average | best |
|---|---|---|---|---|---|---|---|---|
| batter hits | 0.7148 | 0.6958 | 0.6847 | **0.6846** | 0.6883 | 0.7064 | 0.6876 | ×1.05 |
| batter total bases | **1.2658** | 1.2953 | 1.3324 | 1.3528 | 1.3742 | 1.4214 | 1.3636 | ×0.80 |
| batter runs | **0.5548** | 0.5653 | 0.5758 | 0.5810 | 0.5863 | 0.5968 | 0.5870 | ×0.80 |
| batter H+R+RBI | **1.4602** | 1.4740 | 1.4963 | 1.5127 | 1.5325 | 1.5814 | 1.5219 | ×0.80 |
| pitcher strikeouts | 1.8716 | 1.7670 | **1.7469** | 1.7689 | 1.8114 | 1.9536 | 1.9878 | ×1.00 |
| pitcher outs | 4.0030 | 3.1121 | **2.6894** | 2.6991 | 2.8735 | 3.6577 | 3.1860 | ×1.00 |

**Projecting total bases 20% low beats the honest projection by 5% of MAE and
the slate average by 7%.** Eleven of the sixteen markets scored are beaten by a
constant distortion. A metric that pays you to be wrong in a fixed direction
cannot say whether a projection ranks anything. (Note the pitcher rows: the
metric is only badly behaved where the counts are small, which is why it
flattered the pitcher markets and libelled the batter ones.)

The metric that can: the correlation between a player's mean projection and his
mean realised production, across players, with the **ceiling** beside it. The
target is measured on finitely many games and carries sampling noise; subtract
the average of that noise from the observed variance of the means and the square
root of the ratio is the highest correlation any projection could reach against
it. The estimator is `rankStudy()` from `tools/batter-thin-fit.mjs`, lifted into
`tools/accuracy-report.mjs --rank` so pitchers and hitters are scored by the same
function.

Pitcher-seasons with 10+ starts (358 of them, 7,769 starts) and hitter-seasons
with 20+ starts (959, 78,413 games):

| market | corr [95%] | ceiling | share of it [95%] | slope | sd(model) | sd(true) |
|---|---|---|---|---|---|---|
| pitcher strikeouts | 0.888 [0.858, 0.911] | 0.901 | 0.99 [0.96, 1.01] | 1.24 | 0.816 | 1.030 |
| pitcher outs recorded | 0.854 [0.809, 0.897] | 0.864 | 0.99 [0.97, 1.02] | 1.20 | 1.139 | 1.386 |
| pitcher hits allowed | 0.770 [0.705, 0.826] | 0.771 | 1.00 [0.94, 1.07] | 0.96 | 0.599 | 0.579 |
| pitcher walks | 0.796 [0.750, 0.830] | 0.794 | 1.00 [0.96, 1.04] | 1.33 | 0.274 | 0.363 |
| pitcher earned runs | 0.638 [0.566, 0.702] | 0.672 | 0.95 [0.87, 1.07] | 1.42 | 0.270 | 0.403 |
| batter hits | 0.826 [0.807, 0.846] | 0.797 | 1.04 [1.01, 1.07] | 1.30 | 0.114 | 0.142 |
| batter total bases | 0.828 [0.809, 0.848] | 0.792 | 1.05 [1.02, 1.08] | 1.30 | 0.218 | 0.271 |
| batter home runs | 0.813 [0.789, 0.834] | 0.788 | 1.03 [1.00, 1.07] | 1.41 | 0.038 | 0.052 |
| batter RBIs | 0.760 [0.735, 0.783] | 0.724 | 1.05 [1.01, 1.10] | 1.64 | 0.068 | 0.106 |
| batter hits+runs+RBIs | 0.823 [0.804, 0.842] | 0.799 | 1.03 [1.01, 1.06] | 1.41 | 0.227 | 0.310 |
| batter runs | 0.791 [0.766, 0.815] | 0.762 | 1.04 [1.00, 1.07] | 1.56 | 0.065 | 0.097 |
| batter strikeouts | 0.865 [0.846, 0.882] | 0.894 | 0.97 [0.95, 0.98] | 1.14 | 0.186 | 0.219 |
| batter singles | 0.787 [0.760, 0.815] | 0.776 | 1.01 [0.98, 1.05] | 1.42 | 0.079 | 0.110 |
| batter stolen bases | 0.869 [0.846, 0.892] | 0.888 | 0.98 [0.96, 1.00] | 1.12 | 0.056 | 0.065 |

**Every market in the model orders players as well as two seasons of box scores
can measure.** `docs/BATTER-CALIBRATION-FIX.md` reported 0.810 against a 0.792
ceiling on hits after the thin fix; with the duty tilt on top it is **0.826
against 0.797**, and total bases is 0.828 against 0.792. The lowest share in the
table is earned runs at 0.95, and even that interval reaches 1.07.

A share at or above 1.00 does **not** mean the model beat the truth. The ceiling
is an estimate and a slightly conservative one, and it is the ceiling against a
target that is itself noisy rather than against ability. Read it as "there is no
measurable headroom left on this data", not as "the projection is perfect".

**What is genuinely narrow is the spread of belief, not the ordering.** The
slope column is the regression of realised on projected across players: at 1.30
on hits and 1.64 on RBIs, the model's spread between hitters is a third to two
thirds too narrow. `docs/BATTER-CALIBRATION-FIX.md` measured that this is not
fixable by relaxing shrinkage — at a quarter of the prior strength the runs slope
reaches 1.00 and the correlation *falls*.

### The point projections, for scale

MAE is kept here as a description of typical miss. **It is not a ranking metric;
use the table above for that.**

| market | projected | actual | bias | MAE | slate average | per-event corr |
|---|---|---|---|---|---|---|
| pitcher K | 4.761 | 4.756 | **−0.1%** | 1.747 | 1.988 | 0.455 |
| pitcher outs | 15.395 | 15.431 | +0.2% | 2.689 | 3.186 | 0.550 |
| pitcher hits | 4.845 | 4.839 | −0.1% | 1.692 | 1.799 | 0.348 |
| pitcher BB | 1.764 | 1.748 | −0.9% | 1.006 | 1.056 | 0.266 |
| pitcher ER | 2.410 | 2.408 | −0.1% | 1.565 | 1.614 | 0.198 |
| batter hits | 0.874 | 0.881 | +0.8% | 0.685 | 0.688 | 0.150 |
| batter TB | 1.441 | 1.451 | +0.7% | 1.332 | 1.364 | 0.145 |
| batter HR | 0.121 | 0.124 | +2.4% | 0.213 | 0.220 | 0.136 |
| batter RBI | 0.446 | 0.453 | +1.5% | 0.627 | 0.638 | 0.106 |
| batter H+R+RBI | 1.785 | 1.805 | +1.1% | 1.496 | 1.522 | 0.152 |
| batter runs | 0.465 | 0.471 | +1.2% | 0.576 | 0.587 | 0.142 |
| batter K | 0.891 | 0.884 | −0.8% | 0.670 | 0.682 | 0.261 |
| batter singles | 0.566 | 0.574 | +1.4% | 0.620 | 0.631 | 0.134 |
| batter SB | 0.074 | 0.072 | −2.4% | 0.129 | 0.134 | 0.209 |
| game total | 8.984 | 8.932 | −0.6% | 3.550 | 3.602 | 0.194 |
| game margin | 0.060 | 0.056 | — | 3.526 | 3.603 | 0.157 |

The first edition's five pitcher biases ran +1.0% to +4.3%, all in the same
direction. They now run −0.9% to +0.2%. The batter biases run 0.7% to 2.4% low
on the counting stats, which is the established-regular residual of question 3
showing up as a level.

The per-event correlations are small and always will be: **one batter-game is
almost all noise.** That column measures how much of a single night the
projection explains, which is a different question from whether it ranks
players, and the answer to that one is the ceiling table above.

---

## Where accuracy breaks down

Every slice below is something visible on the board before the decision.

### Pitchers

| slice | n | strikeouts | outs | hits allowed | walks | earned runs |
|---|---|---|---|---|---|---|
| **home** | 4,703 | ECE 0.33 | **1.53, gap −1.5** | 0.53, +0.5 | 1.29, +0.6 | **1.32, +1.2** |
| **away** | 4,699 | 0.68, +0.4 | 1.17, +0.7 | **1.46, −1.5** | 1.11, −0.7 | **2.32, −2.0** |
| **debut** | 464 | 2.06, −1.4 | **2.86, +2.5** | **2.61, +2.6** | **3.72, −2.4** | 2.02 |
| opener | 338 | 1.19 | 2.05, −1.5 | 1.86 | 2.84, +2.2 | 2.66, +0.7 |
| starter | 8,600 | 0.45 | 0.72 | 0.66 | 1.28 | 1.15 |
| projected < 4.5 IP | 1,017 | 1.13 | 1.50, −1.1 | 1.87, −1.8 | 1.87 | 1.38 |
| projected 4.5–5.5 IP | 4,880 | 0.85, +0.8 | 0.60 | 0.55 | 1.47 | 1.29 |
| projected 5.5+ IP | 3,505 | 0.39 | 1.29, −1.0 | 0.82 | 1.60, +1.1 | 1.82 |
| ≤3 prior starts | 2,394 | 1.11, +0.6 | **1.92, +1.4** | 0.85 | 1.50, −1.2 | 1.51 |
| 4–10 prior starts | 2,873 | 0.55 | 1.47, −1.4 | 1.21, −1.2 | 1.40 | 0.89 |
| 11+ prior starts | 4,135 | 0.52 | 0.99 | 0.57 | 1.65 | **1.70, −0.9** |
| March/April | 1,845 | 1.6–5.8 | 1.2–4.6 | 1.7–2.7 | 2.3–2.5 | 0.8–2.1 |
| June onward | 5,897 | 0.7–2.4 | 1.2–2.3 | 0.7–3.6 | 1.1–2.9 | 1.0–3.7 |

Four readable rules. **The side of the ballpark is now the biggest thing on this
table** and it points in opposite directions in different markets. **The
projected length of the outing barely matters any more** — 1.13 to 1.50 points
across every band, against 3.0 to 6.8 in the first edition. **A debut start is
the one population the model still misreads**, and it misreads it as a fuller,
cleaner outing than it gets. And **April walks are fixed**: 2.54 and 2.28 points
of ECE in the two Aprils with gaps of −0.7 and −1.1, against 4.26 and 4.68 with
gaps of −4.0 and −4.4 before `docs/WALKS-FIX.md`; the point bias is down from
+0.147 and +0.171 to −0.004 and +0.017.

Parks, by the residual left after the model's own park factor (bias = actual
minus projected, strikeouts): Angel Stadium **+0.41 K**, Citizens Bank Park
+0.39, Dodger Stadium +0.36 — against Kauffman **−0.45**, Steinbrenner Field
−0.37, Chase Field −0.35. Earned runs: Coors **+0.40**, Sutter Health Park +0.39
against Globe Life **−0.26**. The strikeout spread has narrowed from ±0.70 to
±0.45 now that the global level error is out of it, and what is left is roughly
the size of the noise on 310 starts.

### Batters

| slice | n | hits | total bases | H+R+RBI | runs | RBIs |
|---|---|---|---|---|---|---|
| under 50 PA this season | 14,780 | ECE 0.37 | 0.37 | 0.28 | 0.64 | 0.19 |
| 50–199 PA | 31,074 | 0.19 | 0.30 | 0.33 | 0.85, +0.5 | 0.28 |
| **200+ PA** | 40,348 | 0.49, −0.3 | 0.52, −0.4 | **0.66, −0.7** | **0.67, −0.7** | 0.44, −0.4 |
| **top of the order (1–3)** | 28,734 | 0.31 | 0.26 | 0.36 | **1.49, −1.5** | 0.35 |
| middle (4–6) | 28,734 | 0.41 | 0.41 | 0.64, −0.6 | 0.40 | **1.06, −1.1** |
| bottom (7–9) | 28,734 | 0.29 | 0.22 | 0.35, +0.3 | 0.72, +0.6 | 0.28 |
| **home** | 43,101 | 0.46, −0.4 | 0.36, −0.4 | **0.90, −0.9** | **0.83, −0.8** | 0.58, −0.6 |
| away | 43,101 | 0.28 | 0.30, +0.3 | 0.42, +0.4 | 0.66, +0.5 | 0.25 |
| slot as the previous card had it | 50,330 | 0.19 | 0.15 | 0.15 | 0.67 | 0.24 |
| slot moved from the previous card | 34,579 | 0.47, −0.5 | 0.33 | 0.41 | 0.48 | 0.34 |
| no previous card at all | 1,293 | 0.80 | 1.10 | **1.76, −0.7** | 1.58, −0.7 | **1.21, −1.2** |
| March (either season) | 2,520 | 0.9–1.2 | 1.4 | **1.9–2.3** | 1.8 | 1.4 |

The shrink is no longer too generous at the thin end — the thin cell is the best
of the three — and what remains is the **run leg for an established hitter**: low
for the top of the order, low at home and low for regulars, which are three views
of one thing. Runs scored depend on the eight men behind you and the model prices
the man at the plate.

The first edition reported "no previous card at all" as the worst batter cell, at
2.97 points on hits with a +2.8 gap. On the same 1,293 batter-games it is now
**0.80 with a +0.1 gap** — the thin-hitter ramp caught most of that population.
What is left there is the RBI leg, at 1.21 and −1.2.

**What an unconfirmed lineup actually costs, re-measured.** Over **9,540
consecutive team-game pairs and 85,860 player-slots**: **75.9%** of the nine who
started a team's last game start the next one, and **47.3%** start it in the same
slot. Conditional on his starting, the slot moving costs little (0.47 against
0.19 points of calibration error on hits). So a projected card is not a worse
projection — it is a **one-in-four chance of projecting a player who does not
play.** Both figures are unchanged from the first edition; they are properties of
managers, not of the model.

### Game lines

| slice | n | moneyline | total | run line | first inning |
|---|---|---|---|---|---|
| both probables known | 4,077 | ECE 0.89 | 0.62 | 1.32 | 1.26 |
| **a probable missing** | 409 | 0.60 | **2.72, gap −2.7** | 1.55 | — |
| both cards posted | 4,466 | 0.78 | 0.63 | 1.24 | 1.29 |
| lineup term switched off entirely | 4,213 | 1.12 (skill 1.8%) | 0.85 (skill 7.9%) | 1.05 (skill 9.5%) | 1.22 (skill 1.0%) |
| **projected total under 8.25** | 866 | **gap −3.5** | — | — | — |
| **projected total 8.25–8.75** | 885 | **gap −5.0** | — | — | — |
| projected total 8.75–9.25 | 983 | **gap +4.1** | — | — | — |
| projected total over 9.25 | 1,479 | **gap +1.7** | — | — | — |
| two strong starters (index < 0.88) | 290 | — | 3.63, +3.6 | — | — |
| two weak starters (index 1.12+) | 316 | — | 5.19, +5.2 | — | — |
| projected total over 10 | 492 | — | — | — | **6.30, +6.3** |

Parks, on the total (bias = actual minus projected): Coors **+0.91 runs**,
Nationals Park +0.63, Sutter Health Park +0.62 — against Busch **−0.79**, Angel
Stadium −0.74, Great American **−0.70**. `docs/PARK-FIX.md` fitted and rejected a
per-park level table for exactly these residuals: fitted on one season it is
worth nothing on the other, and the per-park bias correlation between the two
seasons is 0.03. Wrigley is the one park where the residual was explained, and it
was the wind rather than the park.

---

## Method

Three existing lookahead-free replays, unchanged, driven by one extractor so that
all three are scored by one function:

- `tools/backtest-pitchers.mjs` — every start rebuilt from games strictly before
  that date. Not replicated: posted lineups (the opposing team aggregate is used,
  which is `loadSlate`'s own fallback), platoon splits, weather.
- `tools/backtest-batters.mjs` — every posted batting-order starter, his as-of
  season line, the opposing starter run through the real `projectPitcher`, and
  `loadSlate`'s league object. Not replicated: weather (`weatherHrFactor` is 1),
  and the starter is the boxscore starter rather than the listed probable.
- `tools/backtest-games-v2.mjs --src` — the **shipped** `src/model/game.js` fed
  from `tools/game-features.mjs`, with the posted card and the recorded
  first-pitch weather.

- `tools/accuracy-extract.mjs` — runs a replay and writes one compact record per
  projection: the point projection, the actual, and P(X > line) at the standard
  ladder, plus the slice keys. `--tuning '{...}'` and `--fit '{...}'` override
  `PITCHER_TUNING` / `BATTER_TUNING` / `PITCHER_FIT` so a counterfactual can be
  measured rather than argued.
- `tools/accuracy-report.mjs` — calibration by decile with Wilson intervals, a
  cluster bootstrap over games on the pooled gap and on the ECE, Brier against
  the base rate, point-projection error, and the slices.

New in this edition, in `tools/` only:

- `accuracy-extract.mjs` now records **`role`** (`opener` / `debut` / `starter`,
  read exactly the way `PITCHER_FIT.role` reads it) and **`rd`** (days since his
  previous start, from the exported `restDaysFrom`). Both are slice keys; neither
  feeds a projection. The old `p.length` cut is kept, but it cuts on the model's
  own projected depth, which the role split *changed*, so a before-and-after on
  it is partly a different set of starts.
- `accuracy-report.mjs` gains `p.role`, `p.roleshort` and `p.layoff` slices, and
  three modes: **`--rank`** (correlation across player-seasons against the
  measurable ceiling, the estimator lifted from `tools/batter-thin-fit.mjs`),
  **`--scale`** (the constant-distortion table that shows MAE-against-the-slate-
  average is not a ranking metric), and **`--carry`** (the lineup carry-over
  rate).

```
# feature tables for the game model (both seasons)
node tools/game-features.mjs --season 2025 --cache .backtest-cache --out .backtest-cache/features_2025.json
node tools/game-features.mjs --season 2026 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/features_2026.json
node tools/fit-game-v2.mjs --config core --no-score \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/params-core.json

# extract
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .backtest-cache/acc_p_2025.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/acc_p_2026.ndjson
node --max-old-space-size=14336 tools/accuracy-extract.mjs --kind batters --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .backtest-cache/accb_2025.ndjson
node --max-old-space-size=14336 tools/accuracy-extract.mjs --kind batters --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/accb_2026.ndjson
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --params .backtest-cache/params-core.json \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/acc_g_all.ndjson

# report
node --max-old-space-size=14336 tools/accuracy-report.mjs \
  .backtest-cache/acc_p_2025.ndjson .backtest-cache/acc_p_2026.ndjson \
  .backtest-cache/accb_2025.ndjson .backtest-cache/accb_2026.ndjson \
  .backtest-cache/acc_g_all.ndjson \
  --bins --slices --rank --scale --carry --holdout 2026-09-02 --json .backtest-cache/accuracy.json

# the counterfactual in question 1: the market-fitted trims put back
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --tuning '{"kLevel":0.95,"hLevel":0.97}' \
  --out .backtest-cache/cf_trim_2025.ndjson
```

**Run the batter extract a whole season at a time.** A month at a time
concatenates to the same 86,220 rows and the same projections, but the
"previous card" a `b.card` slice reads is only ever looked for inside one
extract, so six monthly files manufacture six false "no previous card" cohorts
per season — 5,553 rows instead of 1,293. Every other table is unaffected.

Everything fetched is cached on disk under `.backtest-cache`, which is
gitignored; a re-run after the first costs no requests.

### Caveats a reader should hold

- **The last three weeks are not a holdout any more.** Seven branches read them
  today. They are reported for stability, not for confirmation.
- **The ladder is the standard one, not the listed one.** Calibration is measured
  at fixed half-integer lines (strikeouts 2.5–8.5, outs 11.5–20.5, total bases
  0.5–4.5, totals 6.5–10.5 and so on), not at whatever a book happened to hang
  that night.
- **The ECE bootstrap interval can sit above its own point estimate.** ECE is a
  sum of absolute values and is biased upward under resampling; where the true
  calibration error is near zero the interval is a ceiling, not a range. The gap
  interval, which is signed, is the one to read for significance. That bites
  harder in this edition than the last, because most of the ECEs are now near
  zero.
- **The ranking ceiling is an estimate, not a known quantity.** A share above
  1.00 means the estimate is slightly conservative, not that the model beat the
  truth.
- **Buckets under 200 pairs are excluded from "worst bucket"**, and slice cells
  under 120 records are not printed at all.
- **The `p.layoff` and `p.rest` slices are cut on the same date gap the rest term
  reads**, so the long-rest rows describe the term rather than test it.
- **The batter replay uses the card that took the field.** That is the right input
  for "how good is the projection for a man who starts", and it is why the cost of
  an unconfirmed lineup is reported separately as a carry-over rate rather than
  folded into the calibration.
- **A Wrigley board loaded in the morning does not have the wind term.**
  `PARK_WIND` only fires when the slate carries a wind *direction*, which MLB
  publishes about an hour before first pitch. This replay uses first-pitch
  readings throughout, so the park numbers here are the ceiling, not the median.
- **No weather anywhere in the batter or pitcher replays**, and no platoon splits
  in the pitcher replay.

`npm test` passes, 275 of 275. **No file under `src/` was modified by this
branch.** Every change is in `docs/` and `tools/`.
