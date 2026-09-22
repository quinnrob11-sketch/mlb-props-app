# KXMLBOUTS: is there an edge, or is it noise?

KXMLBOUTS (pitcher outs recorded) is the only Kalshi market that has come out
positive in more than one window, and never with enough trades to tell:
**+9.1% [−5.3, 23.4] on 154 trades** (Jul 10 – Sep 15 pooled, `docs/KALSHI-BACKTEST.md`)
and **+11.1% [−38.1, 57.4] on 15 bot trades** in the fresh Sep 16 – 21 week. Every
other market tested negative, and the exchange price beat the model's forecast
everywhere.

This study is the most complete test the available data allows. **Part 1 below was
written and committed before any profit number for this window was computed.**

---

## Part 1 — Pre-registration

Committed first, deliberately. The bar is fixed here and is not moved afterwards,
whichever way the numbers fall.

### Window

**2026-07-16 .. 2026-09-21**, the entire history the Kalshi live tier holds for
KXMLBOUTS (`GET /markets?series_ticker=KXMLBOUTS&status=settled` returns 1,661
markets, first event date 2026-07-16). `GET /historical/cutoff` is 2026-07-24, so
anything older lives only on `/historical/*`, which this study does not use.

Halves, fixed by the calendar and not by the data:

- **H1 = 2026-07-16 .. 2026-08-18** (34 days)
- **H2 = 2026-08-19 .. 2026-09-21** (34 days)

Note for honesty: `PITCHER_TUNING` was refit on 2026-09-16 (reliever leash,
home/away terms) using Jun 1 – Aug 31 2026 as the fit window. **The whole of H1 and
most of H2 therefore sit inside or overlap the model's own fit window.** This is a
biased-toward-the-model test, not an out-of-sample one, and any pass has to be read
in that light. Only 2026-09-01 .. 09-21 is genuinely out of sample, and that is
reported separately.

### Decision time

Primary: **T−120 min** before the scheduled first pitch parsed from the event
ticker's ET time. Secondary, reported but not part of the bar: **T−30 min**.

The quote is the close of the last 1-minute candlestick whose `end_period_ts ≤`
the decision time — never a later candle. A yes bid of 0 or a yes ask of 100
counts as no quote.

### Trade rule (primary, the one the bar applies to)

The bot's **current** rule, restricted to KXMLBOUTS: `planOrders` from
`bot/plan.mjs` run with `screenOnly: true`, `bot/config.example.json` as it stands
at master `b4aec45`, `now` = the decision time, and a one-level book built from the
decision quote. In force, therefore:

- `buildSignal` — blend the model toward the mid with `MARKET_WEIGHT.pitcher_outs`
  = 0.50, plus the relative-disagreement clamp (2.0x) and the absolute clamp (15 pts);
- edge must clear `feePerContractCents(price)/100 + minEdgeAfterFees` (0.02);
- the 12-point implausibility cap (`IMPLAUSIBLE.prop`);
- the **25–90c** price bounds (`minPriceCents` was raised to 25 in v36.1);
- one rung per pitcher ladder.

### Sizing

Flat **1 contract per signal**, taker at the ask. YES costs the yes ask; NO costs
100 − yes bid. Fee = `0.07 · P · (1 − P)` per contract, unrounded, the bot's own
`feePerContractCents`. P&L from Kalshi's `settlement_value_dollars`.
**ROI = P&L / (cost + fees).** Kelly sizing, order counts and daily spend limits
are not simulated.

### Statistics

95% intervals from a cluster bootstrap over **pitcher-start** (`pitcherId:date`),
20,000 resamples, fixed seed — rungs of one start are not independent. KXMLBOUTS
carries roughly one rung per starter, so the cluster correction is small here, but
it is applied anyway.

### The bar — what counts as evidence of an edge

All four must hold, on the **primary rule at T−120 over the full window**:

- **(A) Pooled ROI 95% CI lies entirely above zero.**
- **(B) Point ROI positive in each of H1 and H2.**
- **(C) On the contracts actually traded, the paired Brier difference
  (model − market) is negative** — i.e. the model forecast those specific
  contracts better than the decision mid did. Point estimate; the interval is
  reported but not required to exclude zero, because n is small by construction.
- **(D) The primary rule's pooled ROI exceeds every pre-specified naive rule's
  pooled ROI** (list below).

(D) is my addition to the suggested bar, and the reason is the sharper question in
the brief. (A)–(C) can all pass while the model contributes nothing: if KXMLBOUTS
is simply mispriced in a direction anyone could see — say every "N+ outs" contract
is systematically too cheap — then a rule with no model in it captures the same
money, the "edge" is a property of the market and not of this codebase, and it is
the first thing to disappear when someone else notices. If (D) fails, the verdict
is **"market mispricing, not model skill"**, even if (A)–(C) pass.

### Naive rules (no model input whatsoever)

Same window, same decision time, same 25–90c price bounds, same one-rung-per-start
collapse (highest |mid − 50| rung, so the choice never consults the model), same
flat 1 contract and same fee:

- **N1 always-NO** — buy NO on every KXMLBOUTS contract with a two-sided quote.
- **N2 always-YES** — buy YES on every such contract.
- **N3 favourite** — take the side the mid favours (YES if mid > 50c, else NO).
- **N4 underdog** — take the side the mid does not favour.
- **N5 bot's contracts, price's side** — on exactly the contracts the primary rule
  traded, take the side the *price* favours instead of the side the model chose.
  This isolates one thing: did the model pick the right side, given the contract?

### Pre-declared exploratory cuts

Reported because the brief asks for them, and because they are how a real edge gets
localised — but **exploratory**. A failed primary cannot be rescued by a cut that
looks good, and no cut is promoted to a rule on the strength of this study:

every signal with no filters (`buildSignal` alone); side (YES/NO); price bucket;
|model − market| gap size; home/away; established starter (≥3 prior 2026 starts at
that date) vs opener/low-sample (<3, the population the v35.2 reliever leash was
aimed at); T−30; fee rate 0.035 (both series report `fee_multiplier: 0.5`); one bet
per start; and H2-only / September-only as the least-contaminated slice.

### Sample size

Reported regardless of outcome: the number of additional trades needed for a 95%
interval to exclude zero at the *observed* mean and standard deviation of per-trade
P&L, `n = (1.96 · sd / mean)²`, inflated by the observed design effect, and
converted to calendar days at the observed trades-per-day rate. That is the answer
to "how long must paper trading run".

### Pre-registered stopping condition

One run of the tool at T−120 produces the primary number. It is not re-run with
different settings in search of a better one. The secondary and exploratory cuts
come out of the same run.

### Recommendation mapping, fixed in advance

- All four hold → **trade it**, at the sizing the risk limits already impose.
- (A)–(C) hold but (D) fails → **market mispricing, not model skill**; the naive
  rule is the honest description, and the model should not be credited.
- Any of (A)–(C) fails, point ROI still positive → **paper it** for the sample size
  computed above, rule frozen.
- Point ROI negative, or the model is measurably worse than the market → **drop it**.

---

## Part 2 — Results (measured)

Run on 2026-09-22 with `tools/outs-study.mjs`, one pass, at the settings above.

```
node tools/outs-study.mjs --from 2026-07-16 --to 2026-09-21 \
  --cache C:/Users/qrob1/mlbwork/bt-cache-outs \
  --kcache C:/Users/qrob1/mlbwork/kcache-outs --boot 20000 --json outs.json
```

### Verdict, stated first

**The pre-registered bar FAILED: A no, B no, C no, D yes.** The rule's pooled ROI
is **+3.8% on 145 trades, 95% CI [−11.9, +19.1]** — the interval contains zero, the
two halves have opposite signs, and the model does not forecast the traded
contracts better than the price does.

The naive comparison (D) is the one piece of good news, and it is real: **every
model-free rule lost money**, so whatever is happening is not a directional
mispricing anyone could see. But (D) on its own is not an edge.

### Coverage (measured)

| | |
|---|---|
| Live tier, KXMLBOUTS | **1,661** settled markets, event dates **2026-07-16 .. 2026-09-22**. `/historical/cutoff` = 2026-07-24. |
| Markets in window (07-16..09-21) | 1,659 across 878 game segments |
| MLB games in window / replayed starts | 898 / 1,796 |
| **Matched to a replayed start** | **1,615** — and 1,615 distinct starts, i.e. **1.00 rungs per start**. This series carries one contract per starter, which is why its samples are ~10x smaller than KXMLBKS at the same number of games. |
| Two-sided decision quote | 1,598 at T−120, 1,612 at T−30 |
| Decision quote age | median 2 min, p90 11 min, max 89 min before T−120. Not stale. |
| Settlement vs statsapi box score | **0 disagreements** on 1,615 markets |
| Non-binary settlement among matched | 0 (22 `scalar` settlements exist in the series — scratched pitchers — none matched) |

Unmatched, honestly: 22 "player missing" (a market on someone the replay has no
start for), 14 "game not on slate", 8 "doubleheader: cannot tell which game", plus
**20 markets dropped one step earlier** because the ticker parser rejects the
`G1`/`G2` suffix outright (see Bugs).

Two coverage facts worth stating plainly:

- **2026-09-21, the last day of the window, holds only 4 settled outs markets in
  the live tier** (2026-09-20 has 27). Whatever the reason, the final day is
  effectively absent, and re-running this a week later will change the last slice.
- The refreshed statsapi cache (`bt-cache-outs`) was fetched 2026-09-22, so every
  date in the window has complete game logs. Reusing the Sep-16 snapshot would
  have silently produced no starts after Sep 15.

### Continuity with the earlier numbers (measured)

This is **not an independent replication** — same market, overlapping dates. It is
a re-measurement with the v36.1 25c floor in force, a longer window and one rung
per start:

| slice | this run, T−120 bot | previously reported |
|---|---|---|
| 2026-09-16 .. 09-21 | n=15, **+11.1%** | +11.1% on 15 bot trades — exact match |
| 2026-07-16 .. 09-15 | n=130, +2.9% | +9.1% on 154 trades (Jul 10 – Sep 15) |
| full window | n=145, **+3.8% [−11.9, +19.1]** | — |

The Sep 16–21 week reproduces to the trade. The earlier +9.1% falls to +2.9% on
almost the same dates; the differences are the 25c price floor (v36.1), the Jul 16
rather than Jul 10 start, and the fresh statsapi cache.

### The pre-registered bar, item by item (measured)

| | test | result | verdict |
|---|---|---|---|
| **A** | pooled ROI CI above zero | +3.8% **[−11.9, +19.1]**, n=145 | FAIL |
| **B** | positive in both halves | H1 **+13.8%** [−9.8, 37.1] n=63; H2 **−3.7%** [−24.1, 16.0] n=82 | FAIL |
| **C** | model beats market Brier on traded contracts | **+0.0031** [−0.0136, +0.0200] (positive = model worse) | FAIL |
| **D** | beats every naive rule | +3.8% vs best naive **−3.0%** | PASS |

### Headline cuts, primary rule, T−120 (measured)

| cut | n | ROI [95% CI] |
|---|---|---|
| **all** | 145 | **+3.8% [−11.9, +19.1]** |
| fee 0.035 | 145 | +5.5% [−10.4, +21.1] |
| H1 (07-16..08-18) | 63 | +13.8% [−9.8, +37.1] |
| H2 (08-19..09-21) | 82 | −3.7% [−24.1, +16.0] |
| Sep only (outside the model's fit window) | 45 | −2.8% [−29.6, +24.4] |
| side = YES | 89 | +14.1% [−6.6, +35.0] |
| side = NO | 56 | −10.2% [−32.2, +11.7] |
| price 25–39c | 9 | +17.5% [−71, +111] |
| price 40–59c | 120 | −1.7% [−18.8, +15.7] |
| price 60–74c | 16 | +31.4% [+3.0, +52.2] |
| gap 6–9 pts | 19 | +16.4% [−19.3, +48.3] |
| gap 9+ pts | 126 | +1.8% [−14.9, +18.8] |
| home | 73 | +4.9% [−16.5, +27.0] |
| away | 72 | +2.8% [−18.8, +24.2] |
| established starter (3+ prior starts) | 142 | +2.0% [−13.7, +17.6] |
| opener / low-sample | 3 | (n=3, meaningless) |
| one bet per start | 145 | identical — this series has one rung per start |

`every` (no filters, `buildSignal` alone): n=400, **+2.3% [−6.7, +11.2]**
(H1 +5.0%, H2 −0.2%). More trades, smaller effect, same conclusion.

**T−30** trades more and looks better: bot n=163, **+12.0% [−2.7, +26.5]**, but
driven entirely by H1 (+28.7% [+7.7, +49.2], n=73) against H2 −1.1%. Same
instability, larger amplitude. `every` at T−30: n=425, +5.4% [−3.4, +14.4].

The `opener/low-sample` cut is **unanswerable here**: after the 12-pt cap and the
25–90c bounds, only 3 such starts are traded at T−120. The reliever leash (v35.2)
cannot be evaluated against prices on this series.

### Is the model adding anything, or is the market just mispriced? (measured)

Every model-free rule lost money over the same window and the same price bounds:

| naive rule, T−120 | n | ROI [95% CI] |
|---|---|---|
| N1 always buy NO | 1,595 | −7.3% [−11.9, −2.8] |
| N2 always buy YES | 1,598 | −3.0% [−7.6, +1.6] |
| N3 take the side the price favours | 1,595 | −5.3% [−9.5, −1.3] |
| N4 take the side the price does not favour | 1,598 | −4.9% [−10.1, +0.4] |
| N5 the bot's own 145 contracts, price's side | 145 | −9.6% [−23.7, +4.0] |
| model rule, for comparison | 145 | **+3.8% [−11.9, +19.1]** |

N5 is the like-for-like test: hold the contract selection fixed and change only
the side. The model and the price disagreed on **73 of 145** contracts, and the
paired difference is **+13.4 ROI points [−7.7, +34.6]** at T−120 and **+27.0
points [+7.1, +47.5]** at T−30 (86 of 163 differ) — the T−30 interval excludes
zero.

So the answer to the sharper question is: **no, this is not a mispricing anyone
could see.** A naive trader buying NO on every outs contract, or always backing the
favourite, would have lost 3–7% over the same 1,600 markets. The model's side
selection is where the positive number comes from.

**But that has to be set against the forecasting evidence, which points the other
way.** Over all 1,598 matched contracts with a two-sided quote:

| | n | model Brier | market Brier | model − market |
|---|---|---|---|---|
| all matched, T−120 | 1,598 | 0.2541 | **0.2428** | **+0.0113 [+0.0055, +0.0173]** |
| H1 | 783 | 0.2567 | 0.2440 | +0.0127 [+0.0043, +0.0214] |
| H2 | 815 | 0.2517 | 0.2417 | +0.0099 [+0.0019, +0.0182] |
| Sep, outside the fit window | 499 | 0.2503 | 0.2405 | +0.0098 [−0.0010, +0.0210] |
| the 145 traded contracts | 145 | 0.2616 | 0.2585 | +0.0031 [−0.0136, +0.0200] |

The market beats the model in every slice, and the interval excludes zero in three
of five. The in-sample Brier-optimal weight on (model − market) is **0.1** over all
matched contracts, against the **0.50** `MARKET_WEIGHT.pitcher_outs` the bot
actually uses. The model is decently calibrated but less sharp than the price.

**These two findings are not contradictory, and the honest reading is the
uncomfortable one.** A model can be a worse forecaster on average and still pick
profitable sides on the small subset where it disagrees most — that is what a
selection rule is for. It is also exactly what a lucky 145-trade sample looks like.
Nothing in this data distinguishes those two explanations, and the H1/H2 sign flip
is what you would expect from the second.

One post-hoc note, flagged so it cannot be mistaken for a result: the market's own
calibration has a single visible flaw — contracts the market prices near 63c
settled YES 71% of the time (n=132). **"Always buy YES at 60c or more" earns
+4.8% [−5.6, +15.0] on 184 trades** with no model at all. That was chosen after
seeing the data and is not part of bar (D); it is here because it is where the
bot's own 60–74c bucket (+31.4%, n=16) is drawing from, and the two should not be
mistaken for independent evidence.

### A bug that shapes the result (measured)

`src/trade/signals.js:177` computes available depth for a **NO** buy from the wrong
side of the book (see Bugs below). On this study's one-level book the consequence
is exact and checkable: **not one NO trade in any trade set, at either decision
time, is priced below 50c.** The bot structurally cannot fade a favourite.

Re-running with the depth term removed and every other condition untouched
(`botDepthBugFixed`; the replica of the bot's screen reproduces `bot`
trade-for-trade when the depth term is left in, which the tool asserts):

| | n | ROI [95% CI] | H1 | H2 |
|---|---|---|---|---|
| bot, T−120, as shipped | 145 | +3.8% [−11.9, +19.1] | +13.8% | −3.7% |
| bot, T−120, depth fixed | **196** | **+6.6% [−6.9, +20.1]** | +14.8% | +0.1% |
| every, T−120, as shipped | 400 | +2.3% [−6.7, +11.2] | +5.0% | −0.2% |
| every, T−120, depth fixed | **592** | **+3.1% [−4.7, +10.9]** | **+2.3%** | **+3.8%** |
| bot, T−30, depth fixed | 216 | +11.3% [−1.7, +24.3] | +24.9% | −0.1% |
| every, T−30, depth fixed | 621 | +4.4% [−3.4, +11.9] | +3.2% | +5.4% |

Fixing the bug adds 35–50% more trades, all of them NO on favourites, and they are
roughly break-even rather than losing. `everyDepthBugFixed` is the only cut in the
whole study that is positive in **both** halves on a sample over 500 — +3.1%
[−4.7, +10.9] — and its interval still contains zero. **This does not change the
verdict.** It is reported because the shipped rule was measured with half its NO
opportunity set amputated, and anyone re-testing after the fix will get a different
(slightly better, still inconclusive) trade population.

### How much more data would settle it? (measured)

At the observed per-trade mean and spread, with the design effect measured from the
cluster bootstrap (1.00 — one rung per start, so clustering costs nothing here):

| | mean P&L | sd | trades needed | more needed | at observed rate |
|---|---|---|---|---|---|
| bot, T−120 (primary) | +2.00c | 49.3c | **2,341** | 2,196 | 2.1/day, **~1,030 playing days, 5+ MLB seasons** |
| bot, T−120, at **half** the observed edge | — | — | 9,364 | 9,219 | ~4,300 days |
| every, T−120 | +1.23c | 49.0c | 6,057 | 5,657 | 5.9/day, ~960 days |
| bot, T−30 | +6.25c | 49.2c | 239 | 76 | 2.4/day, **~32 days** |
| bot, T−30, at half the observed edge | — | — | 956 | 793 | ~331 days |

Read the T−30 row with suspicion. It is short only because its observed mean is
three times the primary rule's, and that mean sits on 163 trades with an H1/H2 sign
flip. The planning number that survives contact with regression to the mean is the
half-edge row.

**The practical answer for the owner: at about 2 trades a day this market cannot
settle its own question in one season.** A binary contract with sd of about 49c per
trade needs thousands of trades to resolve a 2–6c edge. Paper trading KXMLBOUTS
alone for a month will produce another number with a ±25-point interval, which is
exactly where we are now.

### Recommendation

**Paper it, with the rule frozen, and do not size it up on this evidence.**

By the mapping fixed in Part 1: (A)–(C) failed and point ROI is still positive, so
the answer is "paper it". Concretely:

- Leave KXMLBOUTS in the bot **at the smallest size the risk limits allow**, or in
  a journal-only mode, and let it run.
- Fix the depth bug first (it is a production bug independent of this study) and
  record the post-fix trade population separately — the pre-fix and post-fix rules
  are different rules and their trades must not be pooled.
- Do not treat a month of paper trading as a decision point. The honest review date
  is one or two full seasons, or never, whichever comes first.
- Do not promote any of the exploratory cuts (YES side, 60–74c, T−30, gap 6–9 pts)
  to a rule. Every one of them is a sub-sample of about 150 trades chosen after the
  fact, and the market's own 63c calibration flaw explains the best of them without
  any model at all.

The one thing this study does establish, with 1,600 markets behind it, is
**negative and useful**: the model is a measurably worse forecaster of pitcher outs
than the Kalshi price (+0.0113 Brier, CI excludes zero), and the weight the data
supports on it is 0.1, not the 0.50 the bot uses. If anything gets changed on the
strength of this study, it should be `MARKET_WEIGHT.pitcher_outs` coming down, not
the size of the bets going up.

## Bugs found

1. **`src/trade/signals.js:177` — NO-side depth is read from the wrong end of the
   book.** (MEASURED, reproducible.)

   ```js
   const restingLevels = takeYes ? book.no : book.yes;
   const availableContracts = (restingLevels || [])
     .filter((level) => {
       const impliedYesCost = takeYes ? 100 - level.cents : level.cents;
       return impliedYesCost <= priceCents;   // wrong branch for NO
     })
   ```

   Buying NO costs `100 − bestYesBid`, and the resting YES orders actually
   available at that price are the ones at or **above** the best bid, not at or
   below it. The condition should be `level.cents >= 100 - priceCents`.
   Demonstration against the real `normalizeOrderbook`:

   - YES bids 65 (x100) / 64 (x500) / 63 (x900), NO bid 33, so NO costs 35c. 100
     contracts are genuinely available. The function returns
     `availableContracts: 0`, `tradeable: false`, `reason: 'no depth at the price'`.
   - YES bids 30 (x100) / 29 (x500) / 28 (x900), so NO costs 70c. 100 contracts are
     available. The function returns **1,500**.

   Two distinct consequences, both live:

   - **A silent blind spot.** Whenever `bestYesBid > 50`, every NO signal is killed
     as "no depth at the price". The bot has never bought NO below 50c — it cannot
     fade a favourite. Confirmed across this study: the minimum NO price is exactly
     50c in all six trade sets at both decision times, 0 of 443 NO trades below it.
   - **Oversizing.** Whenever `bestYesBid < 50`, depth is overstated (15x in the
     example above), and `sizeOrder` caps at `maxDepthShare * availableContracts`
     (`src/trade/risk.js:182`), so a real order can be sized well past the top level
     and fill worse than quoted.

   Not covered by the 202 tests.

2. **Doubleheader tickers are still dropped before pricing.** (MEASURED.) The regex
   at `src/data/teamMarkets.js:122` rejects the `G1`/`G2` suffix, so 20 of 1,661
   settled KXMLBOUTS markets never reach the model; a further 8 are refused by
   `bot/plan.mjs:39` as ambiguous. Already noted in `docs/KALSHI-BACKTEST.md`;
   restated because it is still open and costs about 1.7% of this series.

3. **`MARKET_WEIGHT.pitcher_outs = 0.50` is unsupported by the data.** (INFERRED
   from a measured diagnostic.) The Brier-optimal weight on (model − market) over
   1,598 matched contracts is 0.1, in both halves and out of the fit window. 0.50 is
   roughly five times what the evidence carries.

## Caveats

- **The window is mostly inside the model's own fit window.** `PITCHER_TUNING` was
  refit 2026-09-16 on Jun 1 – Aug 31 2026. Only 2026-09-01..09-21 (n=45 trades) is
  genuinely out of sample, and it is −2.8%.
- **Fills are idealised**: 1 contract, taker at the quoted top of book, depth
  assumed sufficient, no queue, no latency, no slippage. This favours the bot.
- **Only actual starters.** Markets on pitchers who were scratched are excluded; the
  live bot could have traded them, and they settle `scalar`.
- **The replay is not the live slate** — no posted lineups, platoon splits or
  weather.
- **Limits not simulated**: Kelly sizing, order counts, daily spend.
- **Two decision times only.** The live bot polls repeatedly and may trade at other
  clock times; T−120 and T−30 differ by 8 ROI points here, which is itself a warning
  about how sensitive this number is.
- **Many cuts, one window.** Roughly 40 slices are reported. At 95% confidence, two
  of them being "significant" by chance is the expectation, not a surprise.

## Reproduce

```
node tools/outs-study.mjs --from 2026-07-16 --to 2026-09-21 \
  --cache <statsapi cache> --kcache <kalshi cache> [--boot 20000] [--json out.json]
```

The statsapi cache must be fetched **after** the last date in the window — a
date-stamped snapshot taken on 2026-09-16 contains no game logs for Sep 16+ and will
silently match nothing after that date. Kalshi responses are cached under `--kcache`
(candles are per game segment and are shared with `tools/backtest-kalshi.mjs`);
requests go out serialised, 250 ms apart, with back-off on 429. Public endpoints
only, no auth, no orders.
