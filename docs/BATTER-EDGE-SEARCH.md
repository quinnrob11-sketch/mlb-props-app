# Can a better batter model beat the Kalshi price?

`docs/KALSHI-BATTER-BACKTEST.md` measured the current batter model against real
Kalshi prices and found no edge: 609 replayed trades returned −3.4%, the price
beat the model's Brier score in every series with the interval excluding zero,
and the Brier-optimal weight on (model − market) was 0.10–0.15. The projections
were well calibrated; the price was simply sharper.

This study asks whether that is fixable. It rebuilds the batter model on a
larger sample and a wider set of inputs, then tests the rebuilt model against
the same prices on a window it never saw.

---

# Part 1 — Pre-registration

**This section was written and committed before any price was read, any P&L was
computed and any holdout number existed.** Nothing in it was changed afterwards.
The commit that introduces this file contains Part 1 and nothing else.

## 1. The split

| window | dates | what it is for |
|---|---|---|
| **FIT** | 2025 season (as prior lines) + every 2026 game through **2026-08-09** | choosing model structure and every constant, by outcome log loss. No prices. |
| **VALIDATE** | **2026-08-10 .. 2026-09-01** | comparing candidate configurations against the exchange price. Prices are read here. |
| **HOLDOUT** | **2026-09-02 .. 2026-09-22** | touched **once**, at the very end, for the single configuration already chosen. |

The current `BATTER_TUNING` was fitted on 2026-08-10..08-31, which sits inside
VALIDATE. The baseline it provides is therefore flattered on VALIDATE and clean
on HOLDOUT. That is stated wherever the baseline appears.

Kalshi's public live tier holds settled batter markets from 2026-07-10 onward,
so FIT has no price data at all. This is a feature, not a limitation: the model
is fitted to what happened on a field, and only then asked whether that helps
against a price.

If the HOLDOUT is touched more than once, the report says so explicitly and
every touch is listed.

## 2. What is being tested

Series with a Kalshi market, which are the ones the ROI bar applies to:

| series | market |
|---|---|
| KXMLBHIT | hits |
| KXMLBTB | total bases |
| KXMLBHR | home runs |
| KXMLBRBI | RBIs |
| KXMLBHRR | hits + runs + RBIs |
| KXMLBSB | stolen bases |

Runs and singles are named in the brief but **Kalshi lists no series for
either** (probed 2026-09-23: `KXMLBRUNS`, `KXMLBRUN`, `KXMLBRS`, `KXMLBR`,
`KXMLBSCORE`, `KXMLBRUNSCORED`, `KXMLBSINGLE`, `KXMLBSINGLES`, `KXMLB1B`,
`KXMLBSGL` all 404). They are reported against outcomes only, with no claim
about beating any price.

## 3. The success bar

Pre-registered, and not negotiable after the fact. The improved model beats the
price only if **both** of the following hold on HOLDOUT, at the primary decision
time T−120:

- **(A) Forecast.** The model's Brier score is better than the exchange's
  decision-mid price, with a cluster-bootstrap (by `gamePk`, 5,000 resamples,
  fixed seed) 95% interval on the paired difference that **excludes zero**.
- **(B) Money.** ROI after the **0.07** fee is **positive**, with its
  cluster-bootstrap 95% interval **excluding zero**.

Reported per series and pooled, always with n and the interval. A series passes
only on its own numbers. Anything less is a **FAIL** and is reported as one.

Secondary numbers reported but **not** part of the bar: fee 0.035, decision time
T−30, CLV, calibration, and the Brier-optimal weight on (model − market).

## 4. How a configuration is chosen

1. **FIT.** Candidate structural changes and every constant are chosen on FIT
   alone, by log loss of the model's own pmf at the observed count, and by the
   regression slope of actual on projected. No price is read.
2. **VALIDATE.** Each surviving candidate is scored against the exchange price
   on VALIDATE: paired Brier difference versus the decision mid, with the same
   cluster bootstrap. The single configuration with the best pooled
   model − market Brier on VALIDATE is carried forward.
3. **HOLDOUT.** That one configuration is run once.

## 5. What is being tried

Committed in advance so the list cannot grow to fit the answer. Each is tested
on FIT and kept only if it improves FIT log loss out of its own sub-sample:

1. **Shrinkage and season weighting re-derived.** The blend is currently
   `x26 + 0.6·x25 + strength·prior` over `pa26 + 0.6·pa25 + strength`, with
   hard-coded strengths (hits 60, doubles 80, HR 300, triples 120, runs 60,
   RBI 60). Both the 0.6 and every strength are re-fitted on FIT. The full-season
   replay already shows the regression slope of actual on projected below 1 for
   hits (0.80), singles (0.78), TB (0.87), RBI (0.71) and H+R+RBI (0.86), which
   is the signature of a model that believes player differences more than they
   hold up.
2. **Recency.** An exponential or windowed weighting of 2026 game logs, tested
   against the current flat season-to-date sum.
3. **Plate appearances from the actual game, not the league-average slot
   table.** Team plate appearances depend on the offence and on the opposing
   run environment; the model currently solves a team PA mean so that E[PA]
   equals a fixed per-slot constant. Including the chance of a 5th (and 6th)
   trip explicitly is the point of this market at the 0.5 lines.
4. **The bullpen behind the starter.** A batter faces the starter for roughly
   2.5 of his trips and relievers for the rest; the model applies one
   starter-derived multiplier to every plate appearance.
5. **Platoon splits with regression to the mean**, replacing the flat ±5% / ±9%.
6. **Park and weather specific to the batted-ball profile**, rather than one
   park column per statistic.
7. **Quality-of-contact inputs** if any are reachable from the public StatsAPI.
8. **One plate-appearance outcome distribution** driving hits, total bases,
   home runs, singles, runs, RBI and H+R+RBI jointly, instead of separate
   marginals with a variance-inflation constant bolted onto H+R+RBI. H+R+RBI is
   the worst market measured and the most compound, so this is where a
   structural win would show up first.
9. **The zero-inflation and dispersion constants in `BATTER_TUNING`** re-fitted
   on FIT rather than carried from the Aug 10–31 window.

## 6. Data and rules

- Public MLB StatsAPI and public Kalshi (`api.elections.kalshi.com`) only. No
  paid odds feed is called. Every response is cached to disk under
  `.backtest-cache/` in this worktree and reused.
- Replay is lookahead-free exactly as `tools/backtest-batters.mjs` already does
  it: posted starters from the boxscore, hitter and pitcher inputs summed from
  game-log entries dated strictly before the game, the league object built from
  team game logs before the date, and 2025 season lines from `/people`.
- Prices, quote timing, the bot's own `planOrders` screen, one-contract taker
  fills at the ask, Kalshi's `settlement_value_dollars`, the quadratic fee, and
  the cluster bootstrap are all reused unchanged from
  `tools/backtest-kalshi-batters.mjs` and `docs/KALSHI-BATTER-BACKTEST.md`
  Method 4–7. The only thing this study changes is the model.

## 7. What would make this a failure

A negative result is the expected outcome and is reported as a result, not as a
problem to be tuned away. Specifically, the study **fails** if the HOLDOUT does
not clear both (A) and (B) — including the case where the rebuilt model forecasts
better than the old one and still cannot beat the price.

## 8. Addendum, committed before any P&L was computed

The trading rule was under-specified in section 3 and has to be pinned down
before (B) can mean anything. Running the baseline through
`tools/backtest-kalshi-batters.mjs` produced **zero trades** in every window,
because `MARKET_WEIGHT` for batter markets was dropped to the measured 0–0.15
in v36.2: the model can then move a price by at most 1.5–2.25 points and the
smallest call needs 3. A rule that never trades cannot be tested.

So, fixed now, with no P&L of any kind yet computed or looked at:

- **The headline ROI rule is the one `docs/KALSHI-BATTER-BACKTEST.md` measured
  at −3.4%**: the bot's own `planOrders` screen at T−120, one bet per player
  across all series (`botOnePerPlayer`), with `MARKET_WEIGHT` at the values in
  force for that study — HIT 0.45, TB 0.45, HR 0.50, RBI 0.35, HRR 0.40, and
  0.40 for stolen bases, which that study did not cover. This keeps the new
  number directly comparable with the old one.
- **Secondary, reported alongside:** the same screen at `MARKET_WEIGHT` 1.0,
  i.e. the model against the price with no blending. This is the sharpest test
  of whether the model's disagreements carry information, and it produces the
  most trades.
- KXMLBSB is not mapped in `src/lib/kalshi.js`, so `planOrders` cannot see it.
  It is priced and scored in the tool by the same rules and reported in the
  `every` (every `buildSignal` trade) set. That is stated wherever it appears.

Nothing else in Part 1 changes.
