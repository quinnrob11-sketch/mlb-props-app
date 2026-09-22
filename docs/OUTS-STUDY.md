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
