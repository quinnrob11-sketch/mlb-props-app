# The side of the ballpark (2026-09-23)

`docs/ACCURACY.md` named this the largest remaining error in the model: *"the
model prices no home-field advantage into a player"*, with away starters' earned
runs the worst cell on the board — 2.32 points of calibration error, gap −2.0,
on 4,699 starts. It also flagged the thing that had to be checked first:

> the pitcher replay uses the opposing team's aggregate rather than a posted
> card, built the same way for both sides, so part of what is attributed here to
> the side of the ballpark could be an asymmetry in how that aggregate is built.

**It is not a harness artefact. The asymmetry is real, it is the size of
baseball's actual home-field advantage, and the player models were pricing it in
one of their nine markets.** This document is the verification, the fit and the
before/after.

Public MLB StatsAPI only. Nothing here reads a price.

---

## Step one: is the harness handing both sides the same object?

**No.** Three checks, in order of how much they would have mattered.

### 1. The opponent aggregate is per side, in the replay and in production

`tools/backtest-pitchers.mjs` builds each start's opponent from the pitcher's
own game log:

```js
const t = teamRatesBefore(teamLogs.get(g.opponent.id) || [], g.date);
```

`g.opponent` on a StatsAPI pitching game-log split is the team he faced, and
`g.isHome` is whether his own team was at home. A home starter therefore gets
the away team's aggregate and an away starter gets the home team's, from
different `teamLogs` entries. `src/data/loadSlate.js` does the same thing at
line 943 onward — `const oppTeam = side === 'away' ? homeTeam : awayTeam`, then
`lineupOpponent({ ..., teamAgg: teamEnv.get(oppTeam.id) })`. Neither side is
handed its own team's numbers, and neither side is handed the same object as the
other.

`tools/backtest-batters.mjs` mirrors it: the opposing starter is priced against
`teamLogs.get(oppTeamId)` where `oppTeamId` is the *batter's* team, which is
that starter's opponent. Correct on both sides.

One real difference between that harness and production was found and is
harmless: `starterInput` in `tools/backtest-batters.mjs` does not pass `isHome`
to `projectPitcher`, while `loadSlate` does. It cannot matter, and will not
until someone changes what the batter model reads. The batter model is handed
`proj.rates.{kRate,hRate,hrRate}` — the RAW shrunk rates, which are park-free,
opponent-free and side-free by construction (`loadSlate.js`: "these three are
park-free, opponent-free and clamp-free"). No home/away coefficient, old or new,
touches them. It is left as it is rather than changed for tidiness, because
changing it would move nothing and would make this document's before/after
harder to reproduce.

### 2. The box score, with no model anywhere

`tools/homefield-probe.mjs` reads the cached StatsAPI game logs directly and
projects nothing. Every starting-pitcher appearance in both seasons, 4,844 in
2025 and 4,544 in 2026, split by side:

| per start | 2025 home | 2025 away | diff | 2026 home | 2026 away | diff |
|---|---|---|---|---|---|---|
| outs | 15.761 | 15.384 | **+0.377** (z 3.2) | 15.513 | 14.954 | **+0.559** (z 4.2) |
| earned runs | 2.333 | 2.515 | **−0.182** (z −3.2) | 2.343 | 2.434 | −0.091 (z −1.5) |
| strikeouts | 4.969 | 4.607 | **+0.362** (z 5.1) | 4.920 | 4.508 | **+0.413** (z 5.6) |
| hits | 4.850 | 4.946 | −0.096 (z −1.5) | 4.744 | 4.766 | −0.023 (z −0.3) |
| walks | 1.685 | 1.732 | −0.046 (z −1.3) | 1.764 | 1.806 | −0.042 (z −1.1) |

Per start is the wrong unit for a rate model, because a home start is longer.
Per batter faced, which is what `projectPitcher` actually predicts, the effect is
larger and it replicates almost exactly across the two seasons:

| starter rate | 2025 home/away | 2026 home/away |
|---|---|---|
| strikeouts per BF | **1.067** | **1.069** |
| walks per BF | 0.963 | 0.956 |
| hits per BF | 0.970 | 0.974 |
| home runs per BF | 0.973 | 0.972 |
| earned runs per 9 | **0.906** | **0.928** |
| outs per start | 1.025 | 1.037 |
| pitches per start | 1.013 | 1.023 |

The mirror image is on the hitting side. The same team, batting at home against
batting away, per plate appearance:

| team hitting | 2025 home/away | 2026 home/away |
|---|---|---|
| strikeouts per PA | 0.954 | 0.949 |
| walks per PA | 1.059 | 1.049 |
| batting average | 1.026 (.2485 / .2422) | 1.028 (.2475 / .2407) |
| hits per PA | 1.018 | 1.022 |
| total bases per PA | 1.020 | 1.030 |
| home runs per PA | 1.012 | 1.039 |
| **runs per PA** | **1.065** | **1.060** |
| RBI per PA | 1.064 | 1.058 |

This is the well-established home-field advantage, at the well-established size:
home teams scored 4.490 against 4.405 (2025) and 4.531 against 4.455 (2026) runs
per game — and they did it while batting fewer innings, since a home team that
leads after eight and a half does not bat again (home pitchers record 27.35 outs
per game against 25.83 for the away side). Per plate appearance the run
advantage is 6%.

**So the effect is real, and the residual the model leaves is the size of the
raw effect.** Pooled over both seasons, the model's own home-minus-away point
bias was **−0.170 earned runs** against a raw box-score advantage of **−0.137**
— that is, it was pricing essentially none of it — and **+0.272 outs** against a
raw **+0.468**, which is smaller than the raw figure precisely because `homeK`
and `homeBudget` were already pricing part of the length difference.

### 3. Which markets already had a term

| model | market | had a side term before today? |
|---|---|---|
| pitcher | strikeouts | **yes** — `PITCHER_TUNING.homeK` 0.03, added v35.2 |
| pitcher | outs | **partly** — `homeBudget` 1 pitch, and whatever `homeK` leaks |
| pitcher | hits allowed | no |
| pitcher | walks | no |
| pitcher | earned runs | no |
| batter | plate appearances | **yes**, but it is not a performance term: `isAway ? +0.08 : -0.08` trips, because the away team bats a guaranteed nine innings |
| batter | hits / total bases / singles | no |
| batter | home runs | no |
| batter | RBIs / runs / H+R+RBI | no |
| batter | strikeouts | no |
| batter | stolen bases | no |
| game | moneyline, total, run line | yes (`HOME_ADJUST`, `HOME_HALF_MEANS`, `FIRST_INNING_HOME_PMF`) |

So `docs/ACCURACY.md`'s sentence — "the player models apply no home-field
advantage" — was true of **eight of the nine player markets** and false of
strikeouts, which had had a fitted term for a month. The one place `isAway`
already reached the batter model is a scheduling fact about innings, not about
hitting, and it is left exactly as it was.

### Why the model missed it, mechanically

`opp` is the opposing team's season hitting aggregate **pooled over both sides of
its own ballpark**. A home starter faces a team that, on the road, strikes out
5% more and hits .241 instead of .247 — and he is handed the pooled number. The
same pooling is in production. Splitting the aggregate by venue would price the
same effect through the opponent term; a coefficient prices it directly, needs no
extra request, and works in April when a team has played nine road games.

---

## What changed

Eight new coefficients — two of which are measured and deliberately left at zero
— plus one existing one re-swept, under one sign convention:
`1 + side * coefficient`, side +1 at home, −1 away, and **0 when the caller does
not say which side**, so every one of them is exactly neutral without
`input.isHome` / `input.isAway` and a value of 0 restores the previous model bit
for bit. `test/game.test.js` and `test/batter.test.js` pin both properties.

| where | coefficient | before | after | what it scales |
|---|---|---|---|---|
| `PITCHER_TUNING` | `homeK` | 0.03 | **0.03** (re-swept, unchanged) | `adjK` |
| `PITCHER_TUNING` | `homeBudget` | 1 | **2** | pitch budget, in pitches |
| `PITCHER_TUNING` | `homeH` | — | **−0.02** | `adjH`, and through `outRatePerBF`, length |
| `PITCHER_TUNING` | `homeBB` | — | **−0.025** | `adjBB`, and through `outRatePerBF`, length |
| `PITCHER_TUNING` | `homeHR` | — | **0** | `adjHR` — see below |
| `PITCHER_TUNING` | `homeER` | — | **−0.05** | `projER`, after the blend |
| `BATTER_TUNING` | `homeHit` | — | **+0.01** | the non-HR hit rate: hits, total bases, singles |
| `BATTER_TUNING` | `homeHr` | — | **0** | the HR rate — see below |
| `BATTER_TUNING` | `homeK` | — | **−0.025** | `kPA` |
| `BATTER_TUNING` | `homeRun` | — | **+0.03** | `runContext`: runs, RBIs, H+R+RBI |

**Outs carry no coefficient of their own.** `adjH` and `adjBB` feed
`outRatePerBF`, so `homeH` and `homeBB` lengthen a home start by construction;
`homeBudget` is what is left after that, and it is why the budget was re-swept
rather than left at 1.

**`homeER` sits outside the three-way blend**, not on a rate, because only the
40% events leg of `projER` passes through `adjH`/`adjBB`/`adjHR` — the FIP and
ERA legs are the pitcher's own season line and know nothing about tonight's
ballpark.

**Two coefficients are deliberately zero.**

- `PITCHER_TUNING.homeHR`: there is no pitcher home-run market (`PITCHER_MARKETS`
  is strikeouts, outs, hits, earned runs, walks), so nothing on the board can
  select it. Its only path to a priced number is the events leg of `projER`, and
  `homeER` prices that directly. The box score says the honest value is about
  −0.014; setting it from a number no market can check is not a fit.
- `BATTER_TUNING.homeHr`: the home-run market is the one batter market with **no
  side asymmetry to correct** — its gap already read −0.20 home against −0.13
  away over 86,220 batter-games, and every non-zero value made the validation
  window worse (log loss 0.18703 at 0, 0.18705 at 0.01, 0.18710 at 0.03). The
  power leg is left alone; `homeHit` carries the contact leg, where the effect
  that is there lives.

---

## How they were fitted

`tools/homefield-fit.mjs`. It writes no new replay: it imports `buildStarts()`
from `tools/backtest-pitchers.mjs` and `buildRows()` from
`tools/backtest-batters.mjs` — the same lookahead-free replays every other study
on this repository uses — and re-projects their rows with a different `tuning`
object, scoring over the standard ladder `tools/accuracy-report.mjs` uses.

Windows, by date:

| window | dates | starts | batter-games |
|---|---|---|---|
| **fit** | 2025 entire + 2026 through 2026-08-09 | 8,403 | 75,744 |
| **validate** | 2026-08-10 .. 2026-09-01 | 616 | 5,544 |
| September | 2026-09-02 .. 2026-09-22 | 376 | 4,914 |

Every coefficient was selected on the **fit** window alone, by log loss on the
market it governs, with the calibration gap and the point bias on each side read
as a tie-break inside the flat region. The validate window was read once per
term, after selection, as a confirmation.

**The September window was used for a sign check and nothing else.** Eight
branches have read it today. It is reported below because it disagrees in
places, and a reader should know that.

Coordinate descent, in the order `homeH` → `homeBB` → `homeBudget` → `homeER`,
with one confirmation pass at the final point. The two most-moved sweeps, on the
fit window, both seasons pooled:

```
homeH, hits market                       homeER, earned runs market
  value   fit ll    gap H / A              value   fit ll    gap H / A
   0      0.51513   +0.54 / -1.60           0      0.55013   +1.24 / -1.89
  -0.01   0.51484   -0.13 / -0.94          -0.03   0.54959   +0.37 / -1.04
  -0.015  0.51480   -0.46 / -0.61          -0.045  0.54948   -0.07 / -0.62
  -0.02   0.51481   -0.49 / -0.58  <--     -0.05   0.54947   -0.22 / -0.48  <--
  -0.025  0.51483   -0.82 / -0.25          -0.055  0.54947   -0.37 / -0.34
  -0.03   0.51504   -1.46 / +0.38          -0.06   0.54948   -0.51 / -0.20
```

**Every fitted value landed within 0.01 of what the raw box score implies**,
which is the check that matters most: the ratio `(1+c)/(1−c)` solved against the
measured home/away ratio gives −0.014 for hits, −0.020 for walks, −0.043 for
earned runs, +0.033 for pitcher strikeouts, +0.010 for batter hits, −0.024 for
batter strikeouts and +0.031 for batter runs. The fit was done without reference
to those numbers and agrees with all seven.

`homeK` was re-swept on the same 9,397 starts and 0.03 is still its minimum
(0.47009 at 0.03 against 0.47012 at 0.025 and 0.035), so it is untouched.

---

## Before and after: pitchers

9,395 starts, both seasons, `tools/accuracy-report.mjs --slices`. ECE in
percentage points, gap signed (negative = the model quotes too LOW), bias =
actual minus projected.

| market | side | n | ECE before → after | gap before → after | bias before → after |
|---|---|---|---|---|---|
| strikeouts | home | 4,698 | 0.32 → **0.33** | +0.1 → +0.2 | +0.008 → +0.005 |
| strikeouts | away | 4,697 | 0.68 → **0.64** | +0.4 → +0.4 | −0.031 → −0.029 |
| outs | home | 4,698 | **1.53 → 0.75** | **−1.5 → −0.5** | +0.164 → +0.039 |
| outs | away | 4,697 | 1.17 → **0.94** | +0.7 → −0.3 | −0.108 → +0.012 |
| hits allowed | home | 4,698 | 0.53 → **0.59** | +0.5 → −0.5 | −0.082 → −0.006 |
| hits allowed | away | 4,697 | **1.46 → 0.63** | **−1.5 → −0.4** | +0.058 → −0.018 |
| walks | home | 4,698 | 1.30 → **1.45** | +0.6 → −0.1 | −0.047 → −0.013 |
| walks | away | 4,697 | 1.11 → **1.14** | −0.7 → +0.0 | +0.011 → −0.023 |
| **earned runs** | home | 4,698 | **1.32 → 1.21** | **+1.2 → −0.3** | −0.086 → +0.015 |
| **earned runs** | away | 4,697 | **2.31 → 1.21** | **−2.0 → −0.4** | +0.084 → −0.017 |

**The worst cell in the model is gone.** Away earned runs, 2.31 with a −2.0 gap,
is now 1.21 with a −0.4 gap, and home earned runs is the same 1.21. The
home-minus-away point bias in earned runs is down from 0.170 to 0.032, in outs
from 0.272 to 0.027, in hits from 0.140 to 0.012.

Log loss over the standard ladder, all terms off against all terms on:

| market | fit (8,403) before → after | validate (616) before → after |
|---|---|---|
| strikeouts | 0.47009 → 0.47011 | 0.43953 → **0.43962** |
| outs | 0.47553 → **0.47538** | 0.46622 → **0.46581** |
| hits | 0.51513 → **0.51481** | 0.52572 → **0.52475** |
| walks | 0.49301 → **0.49280** | 0.48028 → **0.48026** |
| earned runs | 0.55020 → **0.54946** | 0.54648 → **0.54474** |

Four of five improve out of sample; strikeouts costs 0.00009, which is the
`homeBudget` move from 1 to 2 leaking into the K distribution.

### What got worse, honestly

- **Home hits allowed ECE 0.53 → 0.59** and **home walks ECE 1.30 → 1.45**, while
  both of their *gaps* went to roughly zero (+0.5 → −0.5 and +0.6 → −0.1). Both
  new figures sit inside the old bootstrap intervals. What is happening is that
  the side term is a level shift and these two markets' residual error is
  bucket-shaped, not level-shaped: pitcher walks had "4 of 10 bins outside their
  interval" before the change and has 4 after. The pooled walks ECE moves 1.01 →
  1.23 on the same account, with Brier 0.1613 → 0.1612 and log loss improving.
  **The side of the ballpark is not the fix for pitcher walks' bucket shape**, and
  nothing here claims it is.
- Pooled earned-run ECE 1.02 → 1.07, with Brier 0.1846 → 0.1843 and the
  projection's correlation with the outcome up from 0.198 to 0.203. The pooled
  figure was never the problem; it was two errors cancelling, and taking the
  cancellation out lets the remaining bucket shape show.

### September (sign check only, 376 starts)

The September window **does not replicate the split**, and in two markets it
reverses it. Before the change, in that window, hits read −0.99 home against
+3.56 away and earned runs −2.31 home against −0.82 away, where the 8,403-start
fit window reads +0.54 / −1.60 and +1.29 / −1.95. After the change, September's
hits gap widens to −1.97 / +4.55 and its earned runs to −3.85 / +0.70.

Three weeks of baseball is 376 starts and that window has been read by eight
branches today. It is reported because stability over time is worth seeing, not
because it argues anything; where it disagrees with 8,403 starts across two
seasons and with the raw box score, the raw box score is the one to believe.

---

## Before and after: batters

86,202 batter-games, both seasons.

| market | side | n | ECE before → after | gap before → after |
|---|---|---|---|---|
| hits | home | 43,101 | **0.47 → 0.28** | −0.5 → −0.2 |
| hits | away | 43,101 | 0.28 → **0.34** | +0.1 → −0.1 |
| total bases | home | 43,101 | 0.37 → **0.23** | −0.4 → −0.2 |
| total bases | away | 43,101 | 0.29 → **0.22** | +0.3 → +0.1 |
| home runs | home | 43,110 | 0.25 → 0.25 | −0.2 → −0.2 |
| home runs | away | 43,110 | 0.09 → 0.09 | −0.1 → −0.1 |
| RBIs | home | 43,101 | **0.58 → 0.31** | −0.6 → −0.2 |
| RBIs | away | 43,101 | 0.25 → **0.20** | +0.2 → −0.2 |
| **H+R+RBI** | home | 43,101 | **0.90 → 0.36** | **−0.9 → −0.3** |
| **H+R+RBI** | away | 43,101 | 0.41 → **0.27** | +0.4 → −0.2 |
| runs | home | 43,101 | **0.83 → 0.62** | **−0.8 → −0.2** |
| runs | away | 43,101 | 0.66 → **0.61** | +0.5 → −0.2 |
| **strikeouts** | home | 43,101 | **0.93 → 0.36** | **+0.9 → +0.2** |
| **strikeouts** | away | 43,101 | **0.58 → 0.33** | −0.5 → +0.2 |
| singles | home | 43,101 | **0.50 → 0.24** | −0.5 → −0.2 |
| singles | away | 43,101 | 0.21 → **0.39** | −0.1 → −0.4 |
| stolen bases | either | 43,101 | unchanged | unchanged |

Of the eighteen cells — nine markets, two sides — **twelve improve**, four are
untouched by construction (home runs and stolen bases, both sides), and two get
slightly worse: away hits 0.28 → 0.34 and
away singles 0.21 → 0.39. Both are the side that was already fine, and both are
small. The singles one has a cause worth naming: singles' pooled gap is about
−0.3 and always was, so closing the *split* leaves both sides at −0.2 / −0.4
instead of −0.5 / −0.1. The spread narrowed; the level did not move, and this
change was not trying to move it.

Log loss over the standard ladder, all four terms off against all four on. This
is the only table on this page where **no market gets worse on either window**:

| market | fit (75,744) before → after | validate (5,544) before → after |
|---|---|---|
| hits | 0.45492 → 0.45490 | 0.45083 → 0.45069 |
| total bases | 0.49188 → 0.49186 | 0.48397 → 0.48388 |
| home runs | 0.19764 → 0.19764 | 0.18703 → 0.18703 |
| RBIs | 0.36291 → 0.36285 | 0.35912 → 0.35894 |
| H+R+RBI | 0.53390 → 0.53380 | 0.53002 → 0.52962 |
| runs | 0.46613 → 0.46601 | 0.46197 → 0.46168 |
| strikeouts | 0.44068 → 0.44048 | 0.43154 → 0.43122 |
| singles | 0.50820 → 0.50819 | 0.50657 → 0.50649 |

Pooled, the batter board is where it was, which is the point — these terms are
symmetric, so they move the split and not the level. Every pooled ECE moves by
0.03 points or less (hits 0.29 → 0.26, total bases 0.15 → 0.14, RBIs 0.23 →
0.22, H+R+RBI 0.26 → 0.29, runs 0.58 → 0.59, strikeouts 0.29 → 0.30, singles
0.32 → 0.31, home runs and stolen bases unchanged), every one inside its own
bootstrap interval, and every Brier is equal or better.

The batter slice table is otherwise undisturbed: the worst batter cell on 2,000+
batter-games was `2025-05 / singles` at 1.51 and is now 1.52, and
`top of the order / runs` was 1.49 and is now 1.50. Runs scored for a
top-of-the-order regular is still the batter model's largest error, and the side
of the ballpark was not what was wrong with it.

---

## Reproducing all of it

```
# the box score, no model
node tools/homefield-probe.mjs --cache .backtest-cache

# the sweep (one run per season; --report merges them)
node tools/homefield-fit.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
  --cache .backtest-cache --sweep '{"homeH":[0,-0.01,-0.015,-0.02,-0.025,-0.03]}' \
  --out .work/hf_p25.json
node tools/homefield-fit.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --sweep '{"homeH":[0,-0.01,-0.015,-0.02,-0.025,-0.03]}' \
  --out .work/hf_p26.json
node tools/homefield-fit.mjs --report .work/hf_p25.json .work/hf_p26.json --markets hits

# before/after (the `before` extract needs the coefficients switched off)
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache \
  --tuning '{"homeH":0,"homeBB":0,"homeHR":0,"homeER":0,"homeBudget":1}' \
  --out .backtest-cache/base_p_2026.ndjson
node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
  --cache .backtest-cache --out .backtest-cache/aft_p_2026.ndjson
node tools/accuracy-report.mjs .backtest-cache/base_p_2026.ndjson --slices
```

The batter extract wants `--max-old-space-size=14336` and a whole season at a
time (see the note in `docs/ACCURACY.md`).

---

## What is the worst cell now

On any pitcher slice with 2,000+ starts, ranked by calibration error:

| | before | after |
|---|---|---|
| 1 | **away / earned runs — 2.31, gap −2.0, n=4,697** | thin (≤3 prior starts) / outs — 1.96, gap +1.4, n=2,392 |
| 2 | thin (≤3 prior starts) / outs — 1.93, gap +1.4 | established (11+) / walks — 1.91, gap +0.2, n=4,134 |
| 3 | full (5.5+ IP) / earned runs — 1.82, gap +0.2 | full (5.5+ IP) / walks — 1.76, gap +0.9 |
| 4 | established (11+) / earned runs — 1.70, gap −0.9 | thin (≤3) / walks — 1.72, gap −1.2 |

The side of the ballpark is no longer on the table at all, and nothing that
replaced it is new — the top four after are all cells that were already there,
moved by less than 0.1 apiece. **The worst cell in the model is now the outs
projection for a starter with three or fewer prior starts** (1.96, gap +1.4, on
2,392 starts), which is the same population as the debut problem
`docs/ACCURACY.md` names, and after it a run of pitcher-walks cells whose error
is bucket-shaped rather than level-shaped.

Two candidates for whoever picks this up next, in order:

1. **Pitcher walks.** Five of the eight worst 2,000+ cells are now walks, the
   error is inside the buckets rather than in the level, and no term fitted today
   touches the shape. `docs/WALKS-FIX.md` fixed April; this is the rest of it.
2. **Splitting the opponent aggregate by venue.** These six coefficients price
   the league-average version of an effect that is really per team — a team with
   a big park split is mispriced in both directions. That needs no new request
   (the team hitting game log already carries `isHome`), and it would let the
   coefficients shrink toward whatever is left after the real split is taken out.
