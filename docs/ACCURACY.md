# How accurate are the projections? (2026-09-23)

**This does not ask whether the model beats a price. It asks whether the
numbers on the board are true.** Every previous study in this repo graded the
model against a market and failed; `docs/AUDIT.md` closes that question. This
one grades the shipped projections against the box score, across two full
seasons, so the numbers can be used on their own — reading the board, playing
markets independently, working the DFS view.

Two full replays, no lookahead anywhere: **9,404 starts**, **86,220
batter-games** and **4,486 games**, 2025 and 2026 through 2026-09-22. The last
three weeks (**2026-09-02..09-22**) were held out and are reported separately
in every table, so stability over time is visible rather than assumed.

Nothing here reads The Odds API or Kalshi. Public MLB StatsAPI only.

The "sample" column below, and every table under it, is the **main window** —
9,019 starts, 81,288 batter-games and 4,213 games. The holdout adds 383 starts,
4,914 batter-games and 273 games and is reported beside each figure.

---

## The trust table

"Calibration error" is the sample-weighted mean gap between a quoted
probability and how often that thing actually happened (ECE, in percentage
points). "Typical miss" is the mean absolute error of the point projection,
against the MAE of simply projecting the market's own average for everyone —
the number to beat if the projection is to be worth anything as a ranking.

| Market | Sample | Calibration error | Typical miss (vs "everyone is average") | Verdict |
|---|---|---|---|---|
| **Pitcher strikeouts** | 9,019 starts | **2.7 pts, every over reads LOW** | 1.76 K vs 1.99 | **Trustworthy only after adding ~3 points to any "over".** Best ranking power in the whole model (corr 0.44) — the level is wrong, the ordering is right |
| **Pitcher outs recorded** | 9,019 | **2.0 pts, and the tails go both ways** | 2.80 outs vs 3.19 | **Trustworthy between 15.5 and 17.5 outs only.** From 12.5 to 14.5 it reads 5–6 points low; from 18.5 up it reads 2–3 points high |
| **Pitcher hits allowed** | 9,019 | **2.0 pts, every over reads LOW** | 1.70 hits vs 1.80 | **Trustworthy after adding ~2 points to any "over".** Weak ranking power (corr 0.34) |
| **Pitcher walks** | 9,019 | 1.1 pts | 1.01 BB vs 1.06 | Trustworthy standalone. Almost no ranking power (corr 0.25) — it is a league-average walk rate with a small tilt |
| **Pitcher earned runs** | 9,019 | 1.1 pts, centred | 1.57 ER vs 1.61 | Trustworthy as a probability; **useless as a ranking** (corr 0.19, 3% better than the slate average) |
| **Batter hits** | 81,288 games | **0.7 pts** | 0.688 vs 0.688 | **Trustworthy standalone as a probability. Adds nothing as a DFS ranking** — its MAE equals the slate average to three decimals |
| **Batter total bases** | 81,288 | **0.4 pts — the best-calibrated market in the model** | 1.337 vs 1.364 | **Trustworthy standalone.** 2% better than the slate average on the point number |
| **Batter home runs** | 81,306 | **0.3 pts** | 0.212 vs 0.220 | Trustworthy standalone, but it only ever says 0–34%, so it rarely has a strong opinion |
| **Batter RBIs** | 81,288 | 0.6 pts, reads slightly low | 0.625 vs 0.638 | Trustworthy standalone. Weakest ranking power of any market (corr 0.10) |
| **Batter hits+runs+RBIs** | 81,288 | 0.7 pts, **consistently reads low** (−0.7, and −0.7 again in the holdout) | 1.500 vs 1.522 | Trustworthy with ~1 point added to the overs at 1.5 and above |
| **Batter runs** | 81,288 | 0.8 pts, **consistently reads low** (−0.8, −0.9 in the holdout) | 0.573 vs 0.587 | Trustworthy with ~1 point added; worst-calibrated batter market, and it is still under a point |
| **Batter strikeouts** | 81,288 | **0.3 pts** | 0.669 vs 0.682 | **Trustworthy standalone**, and the most informative batter number (corr 0.26) |
| **Batter singles** | 81,288 | 0.8 pts | 0.620 vs 0.631 | Trustworthy standalone |
| **Batter stolen bases** | 81,288 | 0.6 pts | 0.131 vs 0.134 | Calibrated, but it only ever says 1–28%. Use it to rank runners, not to price a line |
| **Moneyline** | 4,213 games | 0.6 pts | — | **Calibrated and nearly opinionless.** It spans 33–72% with an SD of 6 points and beats a coin flip by 1.8% of Brier |
| **Game total** | 4,213 | 0.8 pts | 3.56 runs vs 3.60 | Trustworthy standalone as a probability. The run number itself is 1% better than projecting 8.97 for every game |
| **Run line** | 4,213 | 1.3 pts | 3.53 runs of margin vs 3.60 | Trustworthy standalone |
| **First inning (NRFI)** | 3,822 | 1.3 pts | — | **Too flat to use.** It spans 36–62% with an SD of 3.5 points and beats a coin flip by 0.9% of Brier |

**Everything above is the main window. The holdout says the same thing**: every
batter market stays between 0.3 and 1.1 points of calibration error, pitcher
strikeouts move from 2.7 to 2.1, and no market's sign flips. The game markets'
holdout intervals are wide (273 games) and mean little on their own.

### The three conditions under which not to rely on these numbers

1. **Any pitcher "over", as the model ships today.** Strikeouts, hits allowed
   and outs recorded are each deliberately trimmed by a level factor in
   `PITCHER_TUNING` that was fitted against market prices, not outcomes. The
   cost, measured: every strikeout over reads **2.6 points low** across the
   whole ladder and the point projection is **4.3% low** (4.56 projected
   against 4.76 actual). It replicates in both seasons. See "The one thing that
   is materially wrong" below — the fix is measured but belongs to the pitcher
   port, not to this branch.

2. **A starter the model expects to go under 4.5 innings** — an opener, a
   bulk-relief game, a rookie on a leash. On those 1,159 starts the outs
   probabilities read **6.8 points low** and the strikeout probabilities **4.6
   points low**, against 2.2 and 1.4 points respectively for a starter the
   model expects to go 5.5 innings or more. The model knows he is short and
   still does not shorten him enough.

3. **A hitter with fewer than 50 plate appearances this season, and any player
   on an unconfirmed lineup.** With a thin book the hits, total-bases and
   singles probabilities read **about 2 points HIGH** (the shrink toward league
   average is too generous). And an unconfirmed card is worse than it looks:
   across 9,540 consecutive team-game pairs, **only 75.9% of last night's nine
   start tonight, and only 47.3% start tonight in the same slot.** Given that
   he does play, the slot barely matters (0.80 points of calibration error when
   the slot moved against 0.63 when it held) — the risk is not the slot, it is
   that a quarter of the card is a different person.

---

## The one thing that is materially wrong, and it is not this branch's to fix

`src/model/pitcher.js` carries three level factors:

```js
export const PITCHER_TUNING = {
  kLevel: 0.95,     // strikeout projections multiplied DOWN by 5%
  bbLevel: 1.0,
  outsLevel: 0.98,
  hLevel: 0.97,
  ...
```

The comment block above them records exactly what they are: a level
calibration fitted, retired, and then reinstated on the grounds that
"outcomes and prices now agree". **Measured against outcomes over two full
seasons, they do not.** The same replay run with those three set to 1.0 and
nothing else changed:

| market | shipped | with `kLevel`/`hLevel`/`outsLevel` at 1.0 |
|---|---|---|
| strikeouts, calibration error | **2.66 pts** | **0.81 pts** |
| strikeouts, overall gap | **−2.6 [−3.2, −2.1]** | **+0.4 [−0.2, +0.9]** |
| strikeouts, point bias | **+4.3%** (model low) | **−0.9%** |
| hits allowed, calibration error | **2.04 pts** | **0.34 pts** |
| hits allowed, overall gap | **−2.0 [−2.7, −1.3]** | **−0.1** |
| outs, calibration error | **1.95 pts** | **1.41 pts** |
| outs, overall gap | **−1.8 [−2.4, −1.2]** | **+0.7 [+0.1, +1.4]** |

Strikeouts and hits allowed go from significantly miscalibrated to clean.
Reproduce with:

```
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --tuning '{"kLevel":1,"hLevel":1,"outsLevel":1}' \
  --out .backtest-cache/cf_p_2025.ndjson
```

**Nothing in `src/model/*.js` was changed here.** Two other branches are
porting rebuilt pitcher and batter models, and a level constant edited in
three places at once is how a measurement gets lost. This is the hand-off:

- `kLevel` 0.95 and `hLevel` 0.97 are the whole of the strikeout and
  hits-allowed miscalibration. Setting them to 1.0 removes it.
- `outsLevel` 0.98 is **not** the whole of the outs problem. Removing it
  re-centres the level but leaves a real **shape** error: the outs distribution
  is too wide at both ends. At 11.5 outs it says 85.1% and the answer is 86.6%;
  at 20.5 outs it says 16.0% and the answer is 11.2%. A narrower budget
  distribution, not another level factor, is what that needs.
- The batter model needs no level change. Its largest residual is runs and
  hits+runs+RBIs reading **0.7–0.9 points low**, in both the main window and
  the holdout, in the same direction — small, replicated, and worth one pass
  rather than a correction table.

`src/trade/calibration.js` is a no-op today: every entry in `CALIBRATION` is
zero and the pitcher entries were deleted in September. Nothing is patching
these gaps downstream, and the board shows the raw model number.

---

## Calibration, market by market

Every quoted probability across the standard ladder, bucketed by decile,
against the frequency the outcome actually occurred. The interval is Wilson on
the observed side; "MISCALIBRATED" marks a bucket whose quoted probability sits
outside it. The overall gap carries a cluster bootstrap over games, because
several lines on one start are not independent bets on independent events.

Full per-decile tables: `.backtest-cache/accuracy.txt` (regenerate below).
Signs throughout: **a negative gap means the model quotes too LOW** — the thing
happens more often than it says.

### Pitchers (main window: 9,019 starts with a projection; 2 had no prior line at all)

| market | ECE | gap [95%] | worst bucket | line ladder, quoted → observed |
|---|---|---|---|---|
| strikeouts | 2.66 [2.16, 3.18] | **−2.6 [−3.2, −2.1]** | −4.9 | 3.5: 64.8→67.1 · 4.5: 47.5→51.0 · 5.5: 31.8→35.6 · 6.5: 19.5→22.9 · 7.5: 11.0→13.7 |
| outs | 1.95 [1.50, 2.42] | **−1.8 [−2.4, −1.2]** | −4.2 | 11.5: 83.7→86.6 · 14.5: 64.1→70.2 · 15.5: 47.6→50.3 · 18.5: 18.0→16.0 · 20.5: 13.8→11.2 |
| hits allowed | 2.04 [1.44, 2.65] | **−2.0 [−2.7, −1.3]** | −2.9 | 3.5: 68.1→71.4 · 4.5: 50.9→54.3 · 5.5: 34.6→36.8 · 6.5: 21.5→22.7 |
| walks | 1.05 [0.75, 1.59] | −0.8 [−1.4, −0.1] | −2.3 | 0.5: 81.3→82.2 · 1.5: 51.0→53.2 · 2.5: 25.4→25.9 · 3.5: 10.4→9.7 |
| earned runs | 1.14 [0.82, 1.60] | −0.3 [−0.9, +0.3] | +2.1 | 0.5: 84.1→82.2 · 1.5: 61.3→61.1 · 2.5: 40.3→41.3 · 3.5: 24.6→26.1 |

Eight of ten strikeout buckets and nine of ten hits-allowed buckets sit outside
their interval, all in the same direction. That is a level error, not noise.

### Batters (main window: 81,288 batter-games with a projection; 18 had none)

| market | ECE | gap [95%] | line ladder, quoted → observed |
|---|---|---|---|
| hits | 0.70 [0.55, 0.88] | +0.1 [−0.1, +0.4] | 0.5: 61.2→61.0 · 1.5: 21.9→21.7 · 2.5: 4.6→4.7 |
| total bases | **0.42 [0.31, 0.62]** | +0.0 [−0.3, +0.3] | 0.5: 61.2→61.0 · 1.5: 35.6→35.3 · 2.5: 20.5→20.6 · 3.5: 14.3→14.4 · 4.5: 6.8→6.9 |
| home runs | **0.25 [0.15, 0.38]** | −0.2 [−0.4, −0.1] | 0.5: 11.3→11.6 · 1.5: 0.6→0.8 |
| RBIs | 0.58 [0.45, 0.70] | −0.4 [−0.6, −0.1] | 0.5: 29.6→29.6 · 1.5: 9.6→10.5 · 2.5: 3.3→3.6 |
| H+R+RBI | 0.70 [0.52, 1.07] | −0.7 [−1.0, −0.2] | 0.5: 67.5→67.6 · 1.5: 44.9→45.6 · 2.5: 27.8→29.2 · 3.5: 16.5→17.4 |
| runs | 0.78 [0.52, 1.19] | −0.8 [−1.1, −0.4] | 0.5: 36.3→37.6 · 1.5: 7.9→8.1 |
| strikeouts | **0.31 [0.20, 0.49]** | −0.1 [−0.3, +0.1] | 0.5: 61.3→61.5 · 1.5: 21.8→21.9 · 2.5: 4.5→4.6 |
| singles | 0.82 [0.59, 1.06] | +0.1 [−0.2, +0.4] | 0.5: 45.1→45.0 · 1.5: 10.8→10.7 |
| stolen bases | 0.58 [0.45, 0.75] | +0.2 [+0.0, +0.4] | 0.5: 6.8→6.6 |

This is the result `docs/BATTER-BACKTEST.md` reported on 3,618 batter-games,
holding on twenty-four times as many: **the batter projections land within a
point of the truth, everywhere.** The only systematic residuals are runs,
RBIs and H+R+RBI reading a little low, all three of which share the run leg.

### Game lines (main window: 4,213 of the 4,486 games that clear the ten-games-played cut)

| market | ECE | gap [95%] | sharpness | Brier vs the base rate |
|---|---|---|---|---|
| moneyline | 0.62 [0.57, 2.35] | −0.2 [−1.7, +1.3] | SD 6.3 pts, range 33–72% | 0.2445 vs 0.2490 (**1.8%**) |
| total | 0.76 [0.60, 1.93] | +0.4 [−0.9, +1.7] | SD 14.1 pts, range 13–90% | 0.2306 vs 0.2499 (7.7%) |
| run line | 1.25 [0.69, 2.30] | +0.4 [−0.9, +1.7] | SD 15.4 pts, range 19–81% | 0.2261 vs 0.2500 (9.5%) |
| first inning | 1.31 [0.34, 2.76] | −0.2 [−1.8, +1.3] | **SD 3.5 pts, range 36–62%** | 0.2478 vs 0.2500 (**0.9%**) |

Totals: 6.5 over 67.8→67.6, 7.5 56.9→56.1, 8.5 49.3→48.7, 9.5 39.5→39.4, 10.5
33.1→32.9. Run line: home −1.5 36.0→35.6, home +1.5 64.6→64.1.

The moneyline and the first inning are the two markets where calibration is
the wrong question. Both are honest and neither has an opinion: over 4,213
games the moneyline's spread of belief is 6.3 points, and the first inning's is
3.5. **A market where the model always says roughly 50% cannot be wrong and
cannot help.** `docs/GAME-PORT.md` widened the first inning from 2.91 to 3.52
points of SD, which is the improvement it claims and still not enough to trade
or to lean on.

**The posted lineup is worth nothing to the game lines.** Re-run with the
lineup term switched off entirely (`--lineup none`), the three game markets
score 1.8% / 7.6% / 9.5% of Brier skill against 1.8% / 7.7% / 9.5% with both
cards posted. Whatever the cards are worth, it is below measurement here.

---

## Sharpness and point error

A model can be perfectly calibrated and useless. These are the point
projections against the actual counts, with the MAE of "project the market
average for everyone" beside them, and the correlation that says whether the
projection ranks players at all.

| market | projected | actual | bias | MAE | naive MAE | improvement | corr | SD proj | SD actual |
|---|---|---|---|---|---|---|---|---|---|
| pitcher K | 4.557 | 4.756 | **+4.3%** | 1.756 | 1.988 | **12%** | **0.444** | 1.07 | 2.47 |
| pitcher outs | 15.260 | 15.431 | +1.1% | 2.798 | 3.186 | **12%** | **0.522** | 2.33 | 4.27 |
| pitcher hits | 4.743 | 4.839 | +2.0% | 1.698 | 1.799 | 6% | 0.337 | 0.84 | 2.25 |
| pitcher BB | 1.731 | 1.748 | +1.0% | 1.010 | 1.056 | 4% | 0.249 | 0.33 | 1.30 |
| pitcher ER | 2.409 | 2.408 | −0.1% | 1.568 | 1.614 | 3% | 0.189 | 0.39 | 1.99 |
| batter hits | 0.883 | 0.881 | −0.3% | 0.688 | 0.688 | **0%** | 0.131 | 0.15 | 0.88 |
| batter TB | 1.444 | 1.451 | +0.4% | 1.337 | 1.364 | 2% | 0.130 | 0.26 | 1.77 |
| batter HR | 0.119 | 0.124 | +4.4% | 0.212 | 0.220 | 4% | 0.131 | 0.04 | 0.36 |
| batter RBI | 0.443 | 0.453 | +2.1% | 0.625 | 0.638 | 2% | 0.097 | 0.11 | 0.84 |
| batter H+R+RBI | 1.782 | 1.805 | +1.2% | 1.500 | 1.522 | 1% | 0.137 | 0.30 | 1.94 |
| batter runs | 0.456 | 0.471 | +3.1% | 0.573 | 0.587 | 2% | 0.127 | 0.10 | 0.68 |
| batter K | 0.882 | 0.884 | +0.3% | 0.669 | 0.682 | 2% | **0.261** | 0.22 | 0.87 |
| batter singles | 0.575 | 0.574 | −0.3% | 0.620 | 0.631 | 2% | 0.120 | 0.11 | 0.73 |
| batter SB | 0.074 | 0.072 | −3.7% | 0.131 | 0.134 | 2% | 0.208 | 0.05 | 0.28 |
| game total | 8.970 | 8.932 | −0.4% | 3.561 | 3.602 | 1% | 0.177 | 0.84 | 4.55 |
| game margin | 0.060 | 0.056 | — | 3.526 | 3.603 | 2% | 0.156 | 0.68 | 4.62 |

**Read the last four columns before using any of this for DFS.** The pitcher
projections genuinely rank starts: 12% off the naive error and correlations of
0.44–0.52. The batter projections barely rank hitters at all — every one of
them is within 0–4% of what you would get by giving every hitter the slate
average, and batter hits is *exactly* the slate average to three decimals. The
model's SD of belief on batter hits is 0.15 against a real spread of 0.88.

That is not a bug and it is not fixable by a level constant. A single
batter-game is nearly all noise, and the honest reading is that **the batter
probabilities are worth trusting and the batter point projections are worth
almost nothing as a ranking** — with batter strikeouts (corr 0.26) and stolen
bases (0.21) the two mild exceptions.

---

## Where accuracy breaks down

Every slice below is something visible on the board before the decision.

### Pitchers

| slice | n | strikeouts | outs | hits allowed |
|---|---|---|---|---|
| **projected under 4.5 IP (openers, short starters)** | 1,159 | **ECE 4.56, gap −4.6** | **ECE 6.80, gap −6.8** | ECE 3.15, gap −3.1 |
| projected 4.5–5.5 IP | 4,645 | ECE 3.03, gap −3.0 | ECE 3.02, gap −2.5 | ECE 1.74 |
| projected 5.5+ IP | 3,598 | ECE 1.41, gap −1.3 | ECE 2.24, gap +1.1 | ECE 1.93 |
| home | 4,703 | ECE 2.73 | **ECE 2.67, gap −2.6** | ECE 0.95 |
| away | 4,699 | ECE 2.47 | ECE 1.30, gap −0.7 | **ECE 2.99, gap −3.0** |
| ≤3 prior starts | 2,394 | ECE 2.14 | ECE 1.69 | ECE 1.49 (**walks ECE 3.62, gap −3.4**) |
| 4–10 prior starts | 2,873 | ECE 3.00 | ECE 3.08 | ECE 2.45 |
| 11+ prior starts | 4,135 | ECE 2.60 | ECE 1.40 | ECE 2.04 |
| **March/April** | 1,845 | ECE 2.6–3.5 | ECE 3.5–4.6 | ECE 3.0–4.3 (**walks 4.2–4.9**) |
| June onward | 5,897 | ECE 1.3–3.2 | ECE 1.1–3.1 | ECE 1.4–4.7 |

Three readable rules. **The shorter the projected outing, the worse the
projection** — and the error is one-directional, so short-start overs are the
single least reliable cell in the model. **Walks in the first month are 4
points off** while the season line is still mostly last year. And the home/away
asymmetry splits the two markets in opposite directions: outs is worst at home,
hits allowed is worst on the road.

Parks, by the residual left after the model's own park factor (bias = actual
minus projected, strikeouts): Angel Stadium **+0.70 K**, Citizens Bank Park
+0.57, Daikin Park +0.55 — against Kauffman **−0.28**, Chase Field −0.20.
Earned runs: Coors **+0.44**, Sutter Health Park +0.41 against Globe Life
**−0.25**. Roughly half a strikeout of park residual is visible in a 310-start
sample, part of which is the global level error above.

### Batters

| slice | n | hits | total bases | H+R+RBI | runs |
|---|---|---|---|---|---|
| **under 50 PA this season** | 14,780 | **ECE 2.15, gap +2.1** | **ECE 2.26, gap +2.3** | ECE 1.61, gap +1.6 | ECE 1.30 (singles **2.02, +1.7**) |
| 50–199 PA | 31,074 | ECE 0.89 | ECE 0.48 | ECE 0.62 | ECE 0.52 |
| **200+ PA** | 40,348 | ECE 0.91, gap −0.6 | ECE 1.14, gap −1.0 | **ECE 1.70, gap −1.7** | **ECE 1.73, gap −1.7** |
| top of the order (1–3) | 28,734 | ECE 0.64 | ECE 0.69 | ECE 0.85 | **ECE 1.89, gap −1.9** |
| middle (4–6) | 28,734 | ECE 0.78 | ECE 0.86 | ECE 1.16, gap −1.2 | ECE 0.80 |
| bottom (7–9) | 28,734 | ECE 0.77 | ECE 0.65 | ECE 0.74 | ECE 0.94 |
| home | 43,101 | ECE 0.54 | ECE 0.50 | ECE 1.31, gap −1.3 | **ECE 1.46, gap −1.5** |
| away | 43,101 | ECE 0.85 | ECE 0.54 | ECE 0.40 | ECE 0.42 |
| slot as the previous card had it | 50,330 | ECE 0.63 | ECE 0.39 | ECE 0.69 | ECE 0.90 |
| slot moved from the previous card | 34,579 | ECE 0.80 | ECE 0.52 | ECE 0.83 | ECE 0.73 |
| no previous card at all | 1,293 | **ECE 2.97, gap +2.8** | ECE 2.18, gap +2.1 | ECE 2.01 | ECE 1.45 |

The shrink is too generous at the thin end and slightly too harsh at the thick
end: a hitter with under 50 plate appearances is quoted about **2 points high**
for a hit, and an established regular about **1 point low** for a run or an
H+R+RBI. Both replicate in the holdout. And **the run leg is where the whole
batter model is weakest** — it is low for the top of the order, low at home and
low for regulars, which is three views of the same thing: runs scored depend on
the eight men behind you, and the model prices the man at the plate.

**What an unconfirmed lineup actually costs.** Measured over 9,540 consecutive
team-game pairs: **75.9%** of the nine who started last night start tonight,
and **47.3%** start tonight in the same slot. Conditional on his starting, the
slot moving costs almost nothing (0.80 against 0.63 points of calibration error
on hits). So a projected card is not a worse projection — it is a **one-in-four
chance of projecting a player who does not play.**

### Game lines

| slice | n | moneyline | total | run line |
|---|---|---|---|---|
| both probables known | 4,077 | ECE 0.89 | ECE 0.64 | ECE 1.33 |
| **a probable missing** | 409 | ECE 0.60 | **ECE 2.71, gap −2.7** | ECE 1.76 |
| both cards posted | 4,466 | ECE 0.78 | ECE 0.64 | ECE 1.21 |
| lineup term switched off entirely | 4,213 | ECE 1.12 (skill 1.8%) | ECE 0.76 (skill 7.6%) | ECE 1.10 (skill 9.5%) |

Parks, on the total (bias = actual minus projected): Coors **+0.91 runs**,
Nationals Park +0.63, Sutter Health Park +0.62 — against Busch **−0.79**, Angel
Stadium −0.74, Great American **−0.70**. Roughly ±0.8 runs of park residual on
~150 games each, which is inside the noise for any one park and worth watching
across seasons.

---

## Method

Three existing lookahead-free replays, unchanged, driven by one new extractor
so that all three are scored by one function:

- `tools/backtest-pitchers.mjs` — every start rebuilt from games strictly
  before that date. Not replicated: posted lineups (the team aggregate is
  used, which is `loadSlate`'s own fallback), platoon splits, weather.
- `tools/backtest-batters.mjs` — every posted batting-order starter, his
  as-of season line, the opposing starter run through the real
  `projectPitcher`, and `loadSlate`'s league object. Not replicated: weather
  (`weatherHrFactor` is 1), and the starter is the boxscore starter rather
  than the listed probable.
- `tools/backtest-games-v2.mjs --src` — the **shipped** `src/model/game.js`
  fed from `tools/game-features.mjs`, with the posted card and the recorded
  first-pitch weather. `docs/GAME-PORT.md` measures what that optimism is
  worth against a price; here it is bounded directly by re-running with the
  lineup term off.

New in this branch, and nothing else:

- `tools/accuracy-extract.mjs` — runs a replay and writes one compact record
  per projection: the point projection, the actual, and P(X > line) at the
  standard ladder, plus the slice keys (slot, side, park, rest, prior starts,
  prior PA, projected innings, the previous card's slot). `--tuning '{...}'`
  overrides `PITCHER_TUNING`/`BATTER_TUNING` so a counterfactual can be
  measured rather than argued.
- `tools/accuracy-report.mjs` — calibration by decile with Wilson intervals, a
  cluster bootstrap over games on the pooled gap and on the ECE, Brier against
  the base rate, point-projection error against the naive slate average, and
  the slices.

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
node --max-old-space-size=12288 tools/accuracy-extract.mjs --kind batters --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .backtest-cache/acc_b_2025.ndjson
node --max-old-space-size=12288 tools/accuracy-extract.mjs --kind batters --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/acc_b_2026.ndjson
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --params .backtest-cache/params-core.json \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/acc_g_all.ndjson

# report
node --max-old-space-size=12288 tools/accuracy-report.mjs .backtest-cache/acc_*.ndjson \
  --bins --slices --holdout 2026-09-02 --json .backtest-cache/accuracy.json
```

Everything fetched is cached on disk under `.backtest-cache`, which is
gitignored; a re-run after the first costs no requests.

### Caveats a reader should hold

- **The ladder is the standard one, not the listed one.** Calibration is
  measured at fixed half-integer lines (strikeouts 2.5–8.5, outs 11.5–20.5,
  total bases 0.5–4.5, totals 6.5–10.5 and so on), not at whatever a book
  happened to hang that night. A gap at 4.5 strikeouts is a gap at 4.5
  strikeouts.
- **The ECE bootstrap interval can sit above its own point estimate.** ECE is a
  sum of absolute values and is biased upward under resampling; where the true
  calibration error is near zero the interval is a ceiling, not a range. The
  gap interval, which is signed, is the one to read for significance.
- **Buckets under 200 pairs are excluded from "worst bucket"** and should be
  ignored in the per-decile tables; an 80–100% bucket with n=30 is noise.
- **The batter replay uses the card that took the field.** That is the right
  input for "how good is the projection for a man who starts", and it is why
  the cost of an unconfirmed lineup is reported separately as a carry-over
  rate rather than folded into the calibration.
- **The holdout is three weeks of one season.** It confirms that nothing here
  is fitted; it does not independently establish anything the main window did
  not already say.

`npm test` passes, 221 of 221. No file under `src/` was modified.
