# How accurate are the projections? (2026-09-26, third edition)

**This does not ask whether the model beats a price. It asks whether the
numbers on the board are true.** `docs/AUDIT.md` closes the price question.
This grades the shipped projections against the box score, across two full
seasons, so the numbers can be used on their own — reading the board, playing
markets independently, working the DFS view.

The second edition was measured on the models at `9cb0f82`. Two things have
shipped since and both are in every number below: **home-field advantage across
eight of nine player markets** (`docs/HOMEFIELD.md`) and **first-five-innings
markets** (`docs/FIRST-FIVE.md`), which are new rows entirely. This is a
complete re-measurement on the shipped models at **`c6ee1d7`**, not an update:
every table below was regenerated from scratch.

**A correction to the brief this edition was commissioned under.** The long-rest
leash (`docs/REST-FIX.md`, merged at `f0b5909`) and the early-season league walk
curve (`docs/WALKS-FIX.md`, merged at `9cb0f82`) do **not** postdate the second
edition — both are ancestors of `8d01b22`, and the second edition already
measured them. Only the home-field work and first five innings are new. Both
older terms are nonetheless re-verified from their own counterfactuals below,
because two of their published numbers no longer hold.

Two full replays, no lookahead anywhere: **9,404 starts**, **86,220
batter-games** and **4,486 games**, 2025 and 2026 through 2026-09-22. The
**main window** — the figure in every table unless a holdout is named — is
**9,021 starts, 81,306 batter-games and 4,213 games**. The last three weeks
(**2026-09-02..09-22**, 383 starts, 4,914 batter-games, 273 games) are reported
beside it.

**The last three weeks are not a holdout and have not been one for some time.**
That window has now been read by the pitcher port, the opener fix, the pitcher
repair, the rest fix, the park fix, the batter port, the batter calibration
work, the home-field fit and the first-five work. It is reported below because
stability over time is worth seeing, and for no other reason. It cannot confirm
anything. Where it disagrees with the main window, the main window is the one
with 9,021 starts in it.

**There is one genuinely out-of-sample check in this edition.** 2026-09-23,
09-24 and 09-25 are three complete slates that postdate every fit, validate and
holdout window used by any of this work. They are graded in "The three fresh
slates" below. They are small, and the section says how small.

Nothing here reads The Odds API or Kalshi. Public MLB StatsAPI only.

---

## The trust table

"Calibration error" is the sample-weighted mean gap between a quoted
probability and how often that thing actually happened (ECE, in percentage
points), with the signed pooled gap and its cluster-bootstrap interval beside
it; **a negative gap means the model quotes too LOW.** The ECE interval is a
resampling ceiling, not a range — read the signed gap for significance. "Ranks
players" is the correlation between a player's mean projection and his mean
realised production across a season, against the highest correlation *any*
projection could score against a target measured that noisily.

| Market | Sample | Calibration error | Pooled gap | MAE vs naive | Ranks players | Verdict |
|---|---|---|---|---|---|---|
| **Pitcher strikeouts** | 9,021 starts | **0.35 pts** [0.30, 0.89] | +0.2 [−0.3, +0.8] | 1.747 vs 1.988 | **0.888 / 0.901 — 99%** | **Trustworthy, level and ordering, both sides of the ballpark** |
| **Pitcher outs recorded** | 9,021 | **0.73 pts** [0.48, 1.14] | −0.4 [−1.0, +0.2] | 2.687 vs 3.186 | **0.855 / 0.864 — 99%** | **Trustworthy across the whole ladder.** Weakest on a pitcher with ≤3 prior starts |
| **Pitcher hits allowed** | 9,021 | **0.56 pts** [0.39, 1.37] | −0.6 [−1.1, +0.0] | 1.690 vs 1.799 | 0.770 / 0.771 — 100% | **Trustworthy, and now trustworthy by side too** |
| **Pitcher walks** | 9,021 | 1.23 pts [0.87, 1.78] | −0.1 [−0.6, +0.5] | 1.005 vs 1.056 | 0.796 / 0.794 — 100% | Trustworthy on level; **the least even market in the model across slices** — 4 of 10 bins outside their interval |
| **Pitcher earned runs** | 9,021 | 1.07 pts [0.72, 1.60] | −0.3 [−1.0, +0.2] | 1.561 vs 1.614 | 0.637 / 0.672 — 95% | **Trustworthy, and the home/away split that dominated the last edition is closed** |
| **Batter hits** | 81,306 | **0.26 pts** [0.15, 0.52] | −0.2 [−0.5, +0.1] | 0.685 vs 0.688 | **0.825 / 0.797 — at the ceiling** | **Trustworthy** |
| **Batter total bases** | 81,306 | **0.14 pts** [0.09, 0.35] — **best-calibrated market in the model** | −0.1 [−0.3, +0.2] | 1.332 vs 1.364 | **0.828 / 0.792 — at the ceiling** | **Trustworthy** |
| **Batter home runs** | 81,306 | **0.14 pts** [0.08, 0.29] | −0.1 [−0.3, +0.0] | 0.213 vs 0.220 | 0.814 / 0.788 — at the ceiling | Trustworthy, but it only ever says 0–35%, so it rarely has a strong opinion. **The one player market with no side term** |
| **Batter RBIs** | 81,306 | **0.22 pts** [0.15, 0.41] | −0.2 [−0.4, +0.0] | 0.627 vs 0.638 | 0.761 / 0.724 — at the ceiling | Trustworthy. Still reads 1.1 points low for the middle of the order |
| **Batter hits+runs+RBIs** | 81,306 | **0.29 pts** [0.16, 0.55] | −0.3 [−0.6, +0.0] | 1.496 vs 1.522 | 0.822 / 0.799 — at the ceiling | **Trustworthy** |
| **Batter runs** | 81,306 | 0.59 pts [0.41, 0.79] | −0.2 [−0.5, +0.1] | 0.576 vs 0.587 | 0.790 / 0.762 — at the ceiling | Trustworthy pooled. Still the weakest batter market: **−1.5 for the top of the order** |
| **Batter strikeouts** | 81,306 | **0.30 pts** [0.21, 0.50] | +0.2 [−0.0, +0.4] | 0.670 vs 0.682 | 0.864 / 0.894 — 97% | **Trustworthy** |
| **Batter singles** | 81,306 | 0.31 pts [0.15, 0.58] | **−0.3 [−0.6, −0.1]** | 0.620 vs 0.631 | 0.786 / 0.776 — at the ceiling | Trustworthy, but the only player market whose pooled gap interval **excludes zero**. Reads low, and 0.39 away against 0.24 home |
| **Batter stolen bases** | 81,306 | **0.16 pts** [0.06, 0.34] | +0.1 [−0.1, +0.3] | 0.129 vs 0.134 | 0.868 / 0.888 — 98% | Calibrated, but it only ever says 1–31%. Use it to rank runners, not to price a line |
| **Moneyline** | 4,213 games | 0.62 pts [0.49, 2.54] pooled — **and that is two errors cancelling** | −0.2 [−1.7, +1.5] | — | — | **Do not use.** Spans 33–72% with an SD of 6.3 points, beats a coin flip by 1.8% of Brier, and is 3–5 points wrong at each end of its own total range |
| **Game total** | 4,213 | 0.77 pts [0.60, 2.06] | +0.4 [−0.7, +1.8] | 3.550 vs 3.602 | 0.194 per game | Trustworthy standalone as a probability |
| **Run line** | 4,213 | 1.31 pts [0.84, 2.47] | +0.4 [−0.8, +1.6] | 3.526 vs 3.603 | 0.157 per game | Trustworthy standalone |
| **First inning (NRFI)** | 3,822 | 1.22 pts [0.28, 2.96] | −0.3 [−1.9, +1.4] | — | — | **Too flat to use.** Spans 35–62% with an SD of 3.6 points and beats a coin flip by 1.0% of Brier |
| **F5 total (over)** | 4,213 | **0.63 pts** [0.53, 1.89] | −0.6 [−1.8, +0.6] | 2.555 vs 2.580 | 0.173 per game | **Trustworthy, and better calibrated than the full-game total.** Point projection essentially unbiased (−0.009 runs) |
| **F5 run line** | 4,213 | **0.65 pts** [0.46, 1.97] | −0.6 [−1.7, +0.5] | 2.517 vs 2.540 | 0.156 per game | **Trustworthy — half the full game's calibration error** |
| **F5 moneyline** | 3,552 | 1.00 pts [0.74, 2.74] | −0.7 [−2.3, +0.8] | — | — | **Do not use.** Same disease as the full-game moneyline, slightly worse: SD 6.4 points, 2.0% of Brier skill, and **−3.4 to +5.0 points wrong across its own total range** |
| **F5 level after five** | 4,213 | **0.40 pts** [0.04, 1.64] | −0.4 [−1.3, +0.8] | — | — | Calibrated on the league rate (15.3% quoted, 15.7% observed) and **not forecastable**: SD 1.5 points, 0.3% of Brier skill |

**The headline is that nothing broke and one thing closed.** Against the second
edition: pitcher strikeouts 0.40 → **0.35**, outs 0.77 → **0.73**, hits allowed
0.55 → **0.56**, walks 1.01 → **1.23**, earned runs 1.02 → **1.07**; the batter
markets moved by 0.03 points or less in every case. The pooled pitcher numbers
barely moved **because the home-field work was two opposite errors cancelling in
the pool** — which is exactly the thing this re-run was commissioned to check.
It is confirmed in full in the next section.

**The holdout says the same thing about direction and nothing about magnitude.**
On 383 starts every pitcher market reads 1.96–2.68 points of ECE — worse than
the main window on all five — with signs mixed (strikeouts +1.9, outs +0.6,
hits +1.2, walks +0.8, earned runs −1.5) and intervals three to six points wide.
September 2026 ran low. The batter markets hold: 0.22 to 1.00 points of ECE on
4,914 batter-games, no sign flip anywhere. The game and F5 markets' holdout is
273 games and means nothing on its own.

### The three conditions under which not to rely on these numbers

1. **The moneyline, the F5 moneyline, and the first inning — at all.** None has
   an opinion: 6.3, 6.4 and 3.6 points of SD, and 1.8%, 2.0% and 1.0% of Brier
   skill. Worse, the two moneylines' flat pooled calibration is two opposite
   errors. In games it projects at 8.0–8.5 runs the home team wins **5.0 points
   more often** than quoted; in games over 10 it wins **3.0 points less often**.
   The F5 moneyline inherits the same tilt and amplifies it: **−3.4 points at
   8.0–8.5 against +5.0 at 10.0+**. Both seasons, same direction. NRFI is
   **6.3 points wrong** in the 10.0+ band on 492 games. A market that says
   roughly 53% to everything and is five points wrong at each end of its own
   range cannot be leaned on. **This is unchanged from the last two editions and
   is the oldest open defect in the model.**

2. **A debut start, and a starter the model still expects to go short.** On the
   **464 starts** by a pitcher with no appearance yet this season, the model
   reads him **+2.5 points high on outs**, **+2.6 high on hits allowed** and
   **−2.4 low on walks** — it gives a debutant a fuller, cleaner outing than he
   has. On the **661 starts** where a pitcher the model classes as a *starter*
   is nonetheless projected under 4.5 innings, hits allowed reads **1.8 points
   low**. Genuine openers are fine (338 starts, 0.94–2.84 across the five
   markets, no cell over three points). These two are what is left.

3. **A pitcher with three or fewer prior starts, on outs — and walks almost
   everywhere.** The thin-starter outs cell is the single worst in the model
   (1.96 points, gap +1.4, on 2,394 starts). Walks is a subtler problem: its
   pooled gap is a clean −0.1, but **four of its ten calibration bins sit
   outside their own interval**, and **five of the eight worst cells on any
   2,000+ slice are walks cells**. The level is right; the shape is not.

The second edition's three conditions were the side of the ballpark, debuts and
short starts, and the moneyline. **The first is measured closed** and is
answered next. The second and third stand, restated above.

---

## Is the home/away split genuinely fixed? Yes, for the pitchers, and honestly.

This is the question the re-run existed to answer, and the answer is not
qualified. `docs/HOMEFIELD.md` claimed that away starters' earned runs went from
2.32 points of calibration error to 1.21, and that the clean pooled figures had
been hiding two opposite errors. **Both claims reproduce on an independent
replay, cell for cell.**

### Pitchers, by side (9,402 starts with a projection)

| market | side | n | ECE before (2nd ed.) | **ECE now** | gap before | **gap now** |
|---|---|---|---|---|---|---|
| strikeouts | home | 4,703 | 0.32 | **0.33** | +0.1 | **+0.2** |
| strikeouts | away | 4,699 | 0.68 | **0.65** | +0.4 | **+0.4** |
| outs | home | 4,703 | 1.53 | **0.75** | −1.5 | **−0.5** |
| outs | away | 4,699 | 1.17 | **0.94** | +0.7 | **−0.3** |
| hits allowed | home | 4,703 | 0.53 | **0.59** | +0.5 | **−0.5** |
| hits allowed | away | 4,699 | 1.46 | **0.63** | −1.5 | **−0.4** |
| walks | home | 4,703 | 1.30 | **1.44** | +0.6 | **−0.1** |
| walks | away | 4,699 | 1.11 | **1.14** | −0.7 | **+0.1** |
| **earned runs** | home | 4,703 | **1.32** | **1.20** | **+1.2** | **−0.3** |
| **earned runs** | away | 4,699 | **2.31** | **1.21** | **−2.0** | **−0.4** |

**The two sides now agree to within 0.06 points of ECE on earned runs, 0.19 on
outs, 0.04 on hits and 0.30 on walks.** Before the change, the earned-run cells
differed by 0.99 points of ECE and **3.2 points of signed gap** — the pooled
1.02 was the midpoint of +1.2 and −2.0, and it was fiction. **The pooled figures
in this edition are honest. You no longer have to take both sides equally for
them to mean anything.** That is a real change in what the trust table is worth,
not a cosmetic one.

### Batters, by side (86,202 batter-games)

Every after-cell reproduces `docs/HOMEFIELD.md` exactly.

| market | home ECE / gap | away ECE / gap | verdict |
|---|---|---|---|
| hits | 0.28 / −0.2 | 0.35 / −0.1 | even |
| total bases | 0.23 / −0.2 | 0.23 / +0.1 | even |
| **home runs** | **0.25 / −0.2** | **0.09 / −0.1** | **the one market with no side term, and the one with a visible residual split** |
| RBIs | 0.31 / −0.2 | 0.20 / −0.2 | even |
| hits+runs+RBIs | 0.36 / −0.3 | 0.27 / −0.2 | even |
| runs | 0.62 / −0.2 | 0.62 / −0.2 | even |
| strikeouts | 0.36 / +0.2 | 0.33 / +0.2 | even |
| **singles** | **0.24 / −0.2** | **0.39 / −0.4** | **the one cell the change made worse, and it admitted so** |
| stolen bases | 0.23 / +0.0 | 0.17 / +0.1 | even |

Two honest caveats the trust table should carry. `BATTER_TUNING.homeHr` was
deliberately set to zero, and the home-run market is correspondingly the one
player market that still reads differently by side — **0.25 home against 0.09
away**. The gaps are both small and both negative, so this is a sharpness
asymmetry rather than a lean, and it is not large enough to change a decision.
And away singles went **0.21 → 0.39** as the price of the fix; the gap there,
−0.4, is the only player-market gap in this document whose interval excludes
zero.

**Verdict: the split is genuinely fixed, not papered over.** Twelve of eighteen
batter cells improved, four were untouched by construction, two got slightly
worse; all ten pitcher cells are now within 0.3 points of their opposite number
on gap. The pooled numbers are no longer averaging a split.

---

## The worst remaining cell

On any slice with 2,000 or more records, ranked by calibration error:

| rank | cell | ECE | gap | n |
|---|---|---|---|---|
| **1** | **`p.sample` thin (≤3 prior starts) / outs recorded** | **1.96 pts** | **+1.4** | **2,394** |
| 2 | `p.sample` established (11+) / walks | 1.92 | +0.2 | 4,135 |
| 3 | `p.length` full (5.5+ IP) / walks | 1.76 | +0.9 | 3,513 |
| 4 | `g.season` 2025 / moneyline | 1.73 | −0.8 | 2,280 |
| 5 | `p.sample` thin (≤3) / walks | 1.72 | −1.2 | 2,394 |
| 6 | `g.season` 2025 / NRFI | 1.69 | −0.4 | 2,070 |
| 7 | `p.rest` long (6–7d) / walks | 1.67 | −0.7 | 5,000 |
| 8 | `p.layoff` six or seven / walks | 1.67 | −0.7 | 5,000 |

**The worst cell in the model is the outs projection for a starter with three or
fewer prior starts: 1.96 points, gap +1.4, on 2,394 starts.** It quotes the
over too high — it expects a pitcher it barely knows to go deeper than he does.
This confirms `docs/HOMEFIELD.md`'s claim exactly (it said 1.96 on 2,392).

**Two notes on the ranking.** `docs/HOMEFIELD.md` said "five of the eight worst
2,000+ cells are now walks", and by this ranking that is true — but ranks 7 and
8 are **the same 5,000 starts under two slice names**: `p.rest` "long (6–7d)"
and `p.layoff` "six or seven" are the same population cut two ways. There are
five walks *entries* and four distinct walks *populations* in the top eight. The
claim is not wrong but it double-counts, and the underlying point — that walks
is now the model's least even market — stands on its own without the padding.

At a 500-record floor the picture changes completely and the worst cells are all
game lines: `g.projtotal` 10.0+ moneyline at **5.66**, 8.0–8.5 moneyline at
**5.01**, 8.5–9.0 F5 moneyline at **4.97**. See condition 1.

---

## Confirming or refuting the shipped claims

Six of the numbers checked here were produced by the agent that also wrote the
change. Each was re-derived from an independent replay, and where possible from
the change's own counterfactual switch (`--fit '{"rest":null}'`,
`--fit '{"early":null}'`), so the before and after come from one run of one
harness rather than from two documents.

### `docs/HOMEFIELD.md` — confirmed in full

| claim | claimed | **measured here** | verdict |
|---|---|---|---|
| away starters' earned runs, ECE | 2.31 → 1.21 | **→ 1.21** | **confirmed** |
| away starters' earned runs, gap | −2.0 → −0.4 | **→ −0.4** | **confirmed** |
| home earned runs is "the same 1.21" | 1.32 → 1.21 | **→ 1.20** | **confirmed** |
| home outs / away outs, ECE | → 0.75 / 0.94 | **0.75 / 0.94** | **confirmed** |
| home hits / away hits, ECE | → 0.59 / 0.63 | **0.59 / 0.63** | **confirmed** |
| home walks / away walks, ECE | → 1.45 / 1.14 | **1.44 / 1.14** | **confirmed** |
| all nine batter markets, both sides | 17 cells | **all 17 reproduce to 0.01** | **confirmed** |
| pooled walks ECE rises | 1.01 → 1.23 | **→ 1.23** | **confirmed** |
| pooled earned runs ECE rises | 1.02 → 1.07 | **→ 1.07** | **confirmed** |
| new worst 2,000+ cell | thin/outs 1.96 on 2,392 | **1.96, gap +1.4, on 2,394** | **confirmed** |
| top four after "moved by less than 0.1" | 1.96 / 1.91 / 1.76 / 1.72 | **1.96 / 1.92 / 1.76 / 1.72** | **confirmed** |

This is the most thoroughly reproducible document of the four. It also
pre-declared its own two regressions (pooled walks and pooled earned runs) and
both landed exactly where it said. **Nothing in it needs correcting.**

My start counts run 7 higher than its (9,402 with a projection against 9,395),
which is ordinary StatsAPI back-correction over three days and moves no figure.

### `docs/FIRST-FIVE.md` — confirmed in full

| claim | claimed | **measured here** | verdict |
|---|---|---|---|
| F5 total: ECE / gap / skill / corr / bias | 0.63 / −0.6 / 8.4% / 0.173 / −0.009 | **identical on all five** | **confirmed** |
| F5 run line: ECE / gap / skill / corr / bias | 0.65 / −0.6 / 10.9% / 0.156 / +0.018 | **identical on all five** | **confirmed** |
| F5 moneyline: ECE / gap / skill, n=3,552 | 1.00 / −0.7 / 2.0% | **identical, n=3,552** | **confirmed** |
| F5 level after five: ECE / skill | 0.40 / 0.3% | **0.40 / 0.3%** | **confirmed** |
| "F5 is better calibrated on the total" | 0.63 vs 0.77 | **0.63 vs 0.77** | **confirmed** |
| "F5 run line's calibration is half the full game's" | 0.65 vs 1.31 | **0.65 vs 1.31** | **confirmed** |
| paired skill delta, total | +0.15 pts | **+0.15 [−0.72, +1.03]** | **confirmed** |
| paired skill delta, run line | +0.05 pts | **+0.05 [−0.58, +0.69]** | **confirmed** |
| paired skill delta, moneyline | −0.04 pts | **−0.04 [−0.77, +0.70]** | **confirmed** |
| the per-rung ladder, twelve rungs | 62.0→62.8 … 15.3→15.7 | **every rung identical** | **confirmed** |

Its headline negative result — that the model is **not** relatively better over
five innings than over nine — reproduces, intervals and all. **One thing it did
not check, and should have:** the F5 moneyline carries the full-game
moneyline's total-dependent tilt and carries it slightly worse (−3.4 points at
a projected 8.0–8.5 against +5.0 at 10.0+, against the full game's −5.0 and
+3.0). Its pooled 1.00 ECE looks healthy for the same reason the full game's
0.62 does, and for the same reason it should not be trusted. The trust table
above marks it **do not use**, which the F5 document does not.

### `docs/REST-FIX.md` — mechanism confirmed, two published figures no longer hold

Re-derived by running the shipped model against `--fit '{"rest":null}'` on the
same 956 long-rest starts in the main window.

| claim | claimed | **measured here** | verdict |
|---|---|---|---|
| 8d+ outs, ECE | 5.30 → **0.91** | 5.38 → **1.10** | **mechanism confirmed, after-value refuted** |
| 8d+ outs, gap | +5.2 → +0.1 | +5.2 → **+0.1** | **confirmed** |
| 8d+ strikeouts, ECE | 3.10 → 1.67 | 3.12 → **1.77** | close |
| 8d+ hits allowed, ECE | 2.37 → **0.50** | 2.39 → **0.99** | **after-value refuted** |
| 8d+ walks and earned runs unchanged | 1.99 / 1.39, both arms | **2.01 / 1.44, byte-identical both arms** | **confirmed** |
| the term costs pooled outs and hits | 0.65→0.77 and 0.41→0.55 | **0.59→0.73 and 0.41→0.56** | **confirmed** |

**The disagreement is real but benign, and it is not the document's fault.**
The leash works: without it the 8d+ outs cell is a 5.38-point, +5.2-gap
disaster, and with it the gap is +0.1. But the *after* values it published
(0.91 outs, 0.50 hits) were measured before the home-field terms landed, and
those terms moved the same cells. Measured on what is deployed today the cell is
**1.10, not 0.91**, and hits is **0.99, not 0.50** — roughly double. Anyone
quoting `docs/REST-FIX.md`'s after-column as a current figure will be wrong by a
factor of two on hits.

The trade-off it disclosed is confirmed and worth restating, because it is a
real cost the trust table pays: **the rest term makes pooled outs calibration
worse (0.59 → 0.73) and pooled hits worse (0.41 → 0.56)** in exchange for
closing a five-point hole in a 956-start cell. That is a defensible trade. It is
also the reason pitcher hits allowed sits at 0.56 rather than 0.41.

### `docs/WALKS-FIX.md` — April confirmed, the pooled claim refuted

Re-derived against `--fit '{"early":null}'`.

| claim | claimed | **measured here** | verdict |
|---|---|---|---|
| 2026-04 walks, ECE | 4.68 → **2.28** | 4.64 → **2.18** | **confirmed** |
| 2026-04 walks, gap | −4.4 → −1.1 | −4.4 → **−1.1** | **confirmed** |
| 2025-04 walks, ECE | 4.26 → 2.54 | 4.30 → **2.78** | close |
| 2025-04 walks, gap | −4.0 → −0.7 | −4.0 → **−0.7** | **confirmed** |
| 2026-03 walks, ECE / gap | 6.29 → 2.47 / −6.3 → −2.2 | 6.28 → **2.26** / −6.3 → **−2.2** | **confirmed** |
| 2025-03 walks, ECE / gap | 5.33 → 1.61 / −5.3 → −1.2 | 5.59 → **1.79** / −5.3 → **−1.2** | **confirmed** |
| every month outside 45 days unchanged | identical | **identical in both arms** | **confirmed** |
| **pooled walks ECE improves** | **1.10 → 1.01** | **1.13 → 1.23** | **REFUTED** |
| pooled walks gap | −0.8 → −0.1 | −0.8 → **−0.1** | **confirmed** |

**The one claim in the four documents whose direction does not reproduce.**
`docs/WALKS-FIX.md` reported that its curve improved the pooled walks
calibration error from 1.10 to 1.01. On the model as deployed today, turning the
same curve on moves pooled walks ECE from **1.13 to 1.23** — it makes the pooled
figure slightly *worse*, not better.

This is not a contradiction so much as a superseded measurement: the walks fix
was measured on a model without home-field terms, and `PITCHER_TUNING.homeBB`
landed afterwards on the same market. The two interact. Both documents are
individually honest and the composition of them is not what either predicted.
**What survives is the part that mattered**: the April and March gap, which was
−4.4 and −6.3 points, is now −1.1 and −2.2. The curve did the job it was built
for. It just no longer buys a pooled-ECE improvement, and the trust table's
walks row is **1.23, not the 1.01 the last edition published**.

**Net: of roughly forty numeric claims checked across the four documents,
thirty-seven reproduce. Three do not** — `REST-FIX`'s 8d+ outs and 8d+ hits
after-values, and `WALKS-FIX`'s pooled-ECE direction — **and all three fail for
the same reason: they were measured before the home-field work landed on the
same markets, and nobody re-measured the composition.** That is the structural
lesson, and it is why this document exists.

---

## The three fresh slates (2026-09-23, 09-24, 09-25)

**This is the only genuinely out-of-sample evidence in the document.** These
three dates postdate every fit, validate and holdout window used by the pitcher
port, the opener fix, the pitcher repair, the rest fix, the park fix, the batter
port, the batter calibration work, the home-field fit and the first-five work.
Nothing has read them.

They are also small: **90 starts, 810 batter-games and 45 games**, about 2,400
graded market-rows a day.

### What the noise floor is at this size

Pooling every player-prop probability-outcome pair and resampling whole games:

| window | pairs | games | pooled gap | 95% interval | bootstrap SD |
|---|---|---|---|---|---|
| all three slates | 23,940 | 45 | **+1.02 pts** | [−0.84, +2.89] | **0.95 pts** |
| 2026-09-23 | 8,512 | 16 | +2.52 | [+0.62, +4.25] | 0.94 |
| 2026-09-24 | 6,384 | 12 | +1.46 | [−2.77, +5.48] | 2.14 |
| 2026-09-25 | 9,044 | 17 | **−0.69** | [−3.86, +2.61] | **1.64** |

**Read the SD column, not the point estimates.** One slate of 12–17 games has a
noise floor of **1.0 to 2.1 points** on the pooled player-prop gap. Three slates
together still leave **±1.9 points** of 95% interval. **Nothing on this page can
be established by three slates**, and the day-to-day swing here — +2.5, +1.5,
−0.7 — is what pure noise looks like at this size.

### The board's own archive for 2026-09-25

The board's archive reads player props pooled at **−1.1 points** for 2026-09-25
against a claimed **1.0 point** noise floor. **My independent replay broadly
agrees on the number and disagrees on the floor.**

- **The number**: I measure **−0.69 points** on that slate, same sign, same
  order of magnitude. Given that the board grades against the lines a book
  actually hung and this replay grades against a fixed half-integer ladder, the
  two are not measuring quite the same contracts, and 0.4 points of difference
  between them is unremarkable.
- **The floor**: the claimed 1.0 point floor is **too tight for a single
  slate**. My cluster bootstrap over the 17 games of 2026-09-25 gives an SD of
  **1.64 points**. A 1.0-point floor would be roughly right for all three slates
  pooled (0.95), not for one.

**Either way the conclusion is the same, and it is the boring one: −1.1 is
inside the noise and is not evidence of anything.** It is 0.7 standard errors
from zero on the correct floor. It should not be actioned, and it should not be
read as a regression.

### Per-market, for completeness

Pitchers read high across the board on these three days (gaps +0.6 to +2.5 on
90 starts, every interval more than five points wide). Batters read high on the
counting markets (total bases +2.0, runs +2.1, H+R+RBI +1.6) and low on
strikeouts (−0.6) and singles (−1.1). **Every one of those intervals contains
zero except batter total bases, which is marginal.** The 45 games say nothing at
all about the game lines: the moneyline's gap interval alone spans 32 points.

One item is worth logging without acting on it: **fourteen level-after-five
games out of 45** where the model quoted 15.5% — 31.1% observed. That is 14
against an expected 7, the one cell in the fresh slates whose Wilson interval
excludes the quote. **It is one flag on one small sample and is almost certainly
noise** — the same market is calibrated to 0.4 points on 4,213 games. Re-check
it at a month, not now.

---

## Calibration, market by market

### Pitchers (main window: 9,021 starts with a projection; 2 had no prior line at all)

Quoted → observed at each rung. `*` marks a rung whose quote sits outside the
Wilson interval on the observed side.

```
P k      2.5: 81.6->81.0   3.5: 67.6->67.1   4.5: 51.5->51.0   5.5: 36.0->35.6
         6.5: 23.0->22.9   7.5: 13.6->13.7   8.5:  7.4-> 7.9
P outs  11.5: 87.3->86.6*  12.5: 78.6->79.2  13.5: 74.0->75.1* 14.5: 69.0->70.2*
        15.5: 49.9->50.3   16.5: 43.9->44.1  17.5: 37.2->37.8  18.5: 15.6->16.0
        19.5: 13.3->13.5   20.5: 10.8->11.2
P hits   2.5: 83.8->85.1*  3.5: 69.6->71.4*  4.5: 52.9->54.3*  5.5: 36.6->36.8
         6.5: 23.1->22.7   7.5: 13.4->12.3*
P bb     0.5: 81.6->82.2   1.5: 51.9->53.2*  2.5: 26.3->25.9   3.5: 11.0-> 9.7*
P er     0.5: 83.9->82.2*  1.5: 61.2->61.1   2.5: 40.3->41.3*  3.5: 24.7->26.1*
         4.5: 14.3->15.3*
```

Strikeouts is clean at every rung. Outs is a hair low at the bottom of the
ladder and right everywhere else. Hits allowed reads low on the three most
commonly hung rungs (2.5–4.5) by 1.3 to 1.8 points — **this is the residue of
the rest term's trade-off, and it is the largest systematic ladder lean left in
the pitcher model**. Earned runs is low at 0.5 and high from 2.5 up, which is a
shape error rather than a level one.

### Batters (main window: 81,306 batter-games with a projection; 18 had none)

Calibration errors of 0.14 to 0.59 points with pooled gaps between −0.3 and
+0.2. **Eight of nine gap intervals contain zero**; batter singles (−0.3,
[−0.6, −0.1]) is the exception. The ladders are unremarkable and are in the JSON
rather than reproduced here.

### Game lines (main window: 4,213 of the 4,486 games that clear the ten-games-played cut)

The total and the run line are honest as probabilities. The moneyline and NRFI
are not usable, for the reasons in condition 1, and the decomposition that shows
why is here:

| projected total | n | moneyline gap | NRFI gap | F5 moneyline gap |
|---|---|---|---|---|
| 7.5–8.0 | 413 | **−4.2** | −4.2 | −1.4 |
| 8.0–8.5 | 795 | **−5.0** | −1.3 | **−3.4** |
| 8.5–9.0 | 1,030 | +0.3 | +0.2 | −3.0 |
| 9.0–9.5 | 962 | +1.2 | −0.9 | +0.3 |
| 9.5–10.0 | 618 | **+3.2** | +0.5 | **+2.4** |
| 10.0+ | 530 | **+3.0** | **+6.3** | **+5.0** |

**That is a nine-point swing across the moneyline's own range on a market whose
pooled calibration error is 0.62 points.** The pooled figure is meaningless. The
same table is why NRFI should not be played in a high-total game and why the F5
moneyline inherits the warning.

### First five innings (main window: 4,213 games)

```
F5 tot   3.5: 62.0->62.8   4.5: 49.4->50.1   5.5: 38.0->38.2   6.5: 28.4->28.9
F5 mar  -0.5: 45.0->45.3  +0.5: 60.3->61.0  -1.5: 31.9->32.7  +1.5: 72.7->73.2
F5 ml   home leads: 53.1->53.8
F5 tie  level:      15.3->15.7
```

Every rung is inside a point of the truth and every one is low by a similar
small amount — a level error, not a shape error, and the same signature the full
game shows. Paired against the full game at each market's own coin-flip line, on
the same 4,213 games, the first five innings is worth **+0.15, +0.05 and −0.04
points of Brier skill**, and every interval straddles zero. **Five innings is
better calibrated than nine and no better at forecasting.**

---

## Ranking power

Across pitcher-seasons with 10+ starts and hitter-seasons with 20+ starts: the
correlation between a player's mean projection and his mean realised production,
against the highest correlation any projection could reach against a target
measured that noisily.

```
market                    entities  games   corr [95%]           ceiling  share
pitcher strikeouts          358    7769   0.888 [0.863, 0.911]   0.901    0.99
pitcher outs recorded       358    7769   0.855 [0.806, 0.898]   0.864    0.99
pitcher hits allowed        358    7769   0.770 [0.710, 0.821]   0.771    1.00
pitcher walks               358    7769   0.796 [0.753, 0.835]   0.794    1.00
pitcher earned runs         358    7769   0.637 [0.567, 0.701]   0.672    0.95
batter hits                 959   78413   0.825 [0.807, 0.842]   0.797    1.04
batter total bases          959   78413   0.828 [0.808, 0.847]   0.792    1.05
batter home runs            959   78431   0.814 [0.790, 0.836]   0.788    1.03
batter RBIs                 959   78413   0.761 [0.735, 0.786]   0.724    1.05
batter hits+runs+RBIs       959   78413   0.822 [0.803, 0.839]   0.799    1.03
batter runs                 959   78413   0.790 [0.767, 0.813]   0.762    1.04
batter strikeouts           959   78413   0.864 [0.845, 0.882]   0.894    0.97
batter singles              959   78413   0.786 [0.760, 0.812]   0.776    1.01
batter stolen bases         959   78413   0.868 [0.846, 0.889]   0.888    0.98
```

**Every market ranks at or within 5% of the measurable ceiling.** A share above
1.00 means the ceiling estimate is slightly conservative, not that the model
beat the truth. Read this instead of the MAE column: mean absolute error on a
count whose mass sits on zero and one is not minimised at the conditional mean,
so a projection can beat the honest one by leaning in a fixed direction.
`--scale` in the report reproduces that table.

---

## Where accuracy breaks down

The full slice output is in `.backtest-cache/accuracy.json`. The cells that
change a decision:

**Pitchers.** Thin starters (≤3 prior starts): outs **1.96 / +1.4** on 2,394 —
the worst cell in the model. Debuts (464): outs **+2.5**, hits **+2.6**, walks
**−2.4**. Starters projected under 4.5 innings (661): hits **1.85 / −1.8**.
Long layoffs are now handled — 8d+ outs is **1.24 / +0.4** on 1,006 against a
5.38 / +5.2 without the leash — but 15+ days still reads about a point high on
every market (**410 starts**, gaps +1.0 to +1.6), so the leash is slightly too
short at the far tail. March and April walks remain the worst months (2.18 to
2.78) despite the curve, and **2026-08 walks is 2.81 / −2.6 on 834 starts**,
which no shipped term addresses.

**Batters.** Top of the order, runs: **1.50 / −1.5** on 28,734 — unchanged from
the last edition and the largest batter cell. Middle of the order, RBIs:
**1.06 / −1.1** on 28,734. Established hitters (200+ PA) read consistently low
across every counting market (gaps −0.3 to −0.7); thin hitters no longer read
high, and that condition is closed. A hitter with no previous card (1,293) is
noticeably worse everywhere (0.63 to 2.34) — the cost of an unconfirmed lineup
— and a hitter whose slot moved off his projected card is about twice the ECE
of one who batted where expected (hits 0.49 against 0.18).

**Game lines.** Everything in condition 1, plus the 2025 moneyline at
**1.73 / −0.8** on 2,280 and 2025 NRFI at **1.69 / −0.4** on 2,070.

---

## Method

Three existing lookahead-free replays, unchanged, driven by one extractor so that
all are scored by one function. **No new replay was written for this edition**;
`tools/accuracy-extract.mjs` and `tools/accuracy-report.mjs` were reused as-is
and nothing under `src/` was touched.

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
node --max-old-space-size=12288 tools/accuracy-extract.mjs --kind batters --from 2025-03-20 --to 2025-10-01 --cache .backtest-cache --out .backtest-cache/accb_2025.ndjson
node --max-old-space-size=12288 tools/accuracy-extract.mjs --kind batters --from 2026-03-20 --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/accb_2026.ndjson
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --params .backtest-cache/params-core.json \
  --features .backtest-cache/features_2025.json --features .backtest-cache/features_2026.json \
  --out .backtest-cache/acc_g_all.ndjson

# report
node --max-old-space-size=14336 tools/accuracy-report.mjs \
  .backtest-cache/acc_p_2025.ndjson .backtest-cache/acc_p_2026.ndjson \
  .backtest-cache/accb_2025.ndjson .backtest-cache/accb_2026.ndjson \
  .backtest-cache/acc_g_all.ndjson \
  --bins --slices --rank --scale --carry --f5 --totals --holdout 2026-09-02 \
  --json .backtest-cache/accuracy.json
```

**The two counterfactuals in "Confirming or refuting the shipped claims".** Both
arms carry the home-field terms, which is the point — they measure each older
term *as composed with what shipped after it*, which is what a user of the board
actually gets:

```
# the long-rest leash, off
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --fit '{"rest":null}' --out .backtest-cache/cf_rest_25.ndjson
# the early-season walk curve, off
node tools/accuracy-extract.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --fit '{"early":null}' --out .backtest-cache/cf_early_25.ndjson
```

`docs/REST-FIX.md` cuts its slices to the main window, which
`tools/accuracy-report.mjs` does not do for `--slices`. To compare against its
numbers, filter the records to `d < 2026-09-02` first and pass
`--holdout 2099-01-01`; otherwise its 956-start 8d+ cell is read against 1,006
records and the numbers will not line up. `docs/WALKS-FIX.md` does not do this,
which is why the two documents report different n for the same slice.

**The three fresh slates** were built in a separate cache directory
(`.backtest-cache-fresh`) so that every StatsAPI response behind them was
fetched after those games finished. The main cache's season-long game logs were
written before 2026-09-25 completed and would have graded those slates against
an incomplete log:

```
node tools/accuracy-extract.mjs --kind pitchers --from 2026-09-23 --to 2026-09-25 \
  --cache .backtest-cache-fresh --out .backtest-cache-fresh/fresh_p.ndjson
node tools/accuracy-extract.mjs --kind batters  --from 2026-09-23 --to 2026-09-25 \
  --cache .backtest-cache-fresh --out .backtest-cache-fresh/fresh_b.ndjson
node tools/game-features.mjs --season 2026 --from 2026-09-23 --to 2026-09-25 \
  --cache .backtest-cache-fresh --out .backtest-cache-fresh/features_fresh.json
node tools/accuracy-extract.mjs --kind games --src --lineup posted --weather recorded \
  --params .backtest-cache/params-core.json \
  --features .backtest-cache-fresh/features_fresh.json \
  --out .backtest-cache-fresh/fresh_g.ndjson
node tools/accuracy-report.mjs .backtest-cache-fresh/fresh_*.ndjson --f5 --holdout 2030-01-01
```

`--from/--to` on `game-features.mjs` limits only which games get feature rows;
the home-park, travel and as-of aggregates are built from the whole season
regardless, so a three-day window is not a truncated one.

**Run the batter extract a whole season at a time.** A month at a time
concatenates to the same 86,220 rows and the same projections, but the
"previous card" a `b.card` slice reads is only ever looked for inside one
extract, so six monthly files manufacture six false "no previous card" cohorts
per season. This run produced **1,293** such rows, which is the correct figure.

Everything fetched is cached on disk under `.backtest-cache`, which is
gitignored; a re-run after the first costs no requests. `npm test` is 300 and
green at `c6ee1d7`.

### Caveats a reader should hold

- **The last three weeks are not a holdout.** Nine branches have read them. They
  are reported for stability, not for confirmation.
- **Three slates are not a holdout either — they are a noise measurement.** The
  fresh-slate section exists to say how big the noise is, not to confirm the
  main window. Its own numbers show a ±1.9 point interval on the pooled gap.
- **The ladder is the standard one, not the listed one.** Calibration is measured
  at fixed half-integer lines (strikeouts 2.5–8.5, outs 11.5–20.5, total bases
  0.5–4.5, totals 6.5–10.5, F5 totals 3.5–6.5 and so on), not at whatever a book
  happened to hang that night. The board's own archive grades against posted
  lines and will not match this document exactly for that reason.
- **The ECE bootstrap interval can sit above its own point estimate.** ECE is a
  sum of absolute values and is biased upward under resampling; where the true
  calibration error is near zero the interval is a ceiling, not a range. The gap
  interval, which is signed, is the one to read for significance.
- **The ranking ceiling is an estimate, not a known quantity.** A share above
  1.00 means the estimate is slightly conservative.
- **Buckets under 200 pairs are excluded from "worst bucket"**, and slice cells
  under 120 records are not printed at all.
- **The `p.layoff` and `p.rest` slices are cut on the same date gap the rest term
  reads**, so the long-rest rows describe the term rather than test it. The
  `--fit '{"rest":null}'` counterfactual above is the test.
- **The batter replay uses the card that took the field.** That is the right input
  for "how good is the projection for a man who starts", and it is why the cost of
  an unconfirmed lineup is reported as a `b.card` slice rather than folded into
  the calibration.
- **A Wrigley board loaded in the morning does not have the wind term.**
  `PARK_WIND` only fires when the slate carries a wind *direction*, which MLB
  publishes about an hour before first pitch. This replay uses first-pitch
  readings throughout, so the park numbers here are the ceiling, not the median.
- **No weather anywhere in the batter or pitcher replays**, and no platoon splits
  in the pitcher replay.
- **Two documents' published after-values are now stale**, for the reason set out
  above: `docs/REST-FIX.md`'s 8d+ outs (0.91) and hits (0.50), and
  `docs/WALKS-FIX.md`'s pooled walks ECE (1.01). They were correct when written.
  This document supersedes them.
