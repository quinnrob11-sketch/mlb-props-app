# Can the pitcher model be made to beat the price?

`docs/KALSHI-BACKTEST.md` measured 623 replayed pitcher-prop trades at −4.0%,
strikeouts alone at −7.8% [−14.5, −1.0], and — the part that matters — the
exchange's own price forecasting outcomes better than the model in every slice,
with the Brier-optimal weight on (model − market) equal to 0 for strikeouts and
0.1 for outs. The projections are well calibrated; they are simply less sharp
than the price.

This study asks whether that is fixable: whether a pitcher model built properly
— two seasons, recency weighting, partial pooling, lineup handedness, catcher,
umpire, park and weather, and a batters-faced/rate decomposition instead of
independent counting stats — can beat the Kalshi decision-mid price on
strikeouts, outs recorded, hits allowed, earned runs and walks.

**Part 1 below was written and committed before any profit number, any Brier
comparison against a price, and any look at the validation or holdout windows.**

---

## Part 1 — Pre-registration

### The split, fixed before anything was measured

By calendar date, not by data:

| split | dates | what it may be used for |
|---|---|---|
| **FIT** | all of 2025 + 2026 through **2026-08-09** | fitting model parameters against **outcomes** (log loss / Brier vs what happened). No price data enters here. |
| **VALIDATE** | **2026-08-10 .. 2026-09-01** | choosing between candidate configurations, and choosing the one blend weight, against **prices**. |
| **HOLDOUT** | **2026-09-02 .. 2026-09-22** | touched **once**, for the single configuration already chosen. |

The model's parameters are fit on FIT only. Anything that requires seeing a
price — which candidate wins, what weight to put on the model against the market
— is decided on VALIDATE only. If the holdout is inspected more than once, the
report says so explicitly.

Note on price history: the Kalshi live tier holds settled markets for KXMLBKS
and KXMLBOUTS back to **2026-07-17**, and for KXMLBHA / KXMLBERA / KXMLBWA only
back to **2026-08-17**. So the three new series have no price data in FIT at all,
and their VALIDATE slice is 2026-08-17 .. 09-01. That is a coverage fact, not a
choice; FIT is an outcome-only window regardless.

### Markets

| series | market | thresholds seen |
|---|---|---|
| KXMLBKS | strikeouts | 1+ .. 13+ |
| KXMLBOUTS | outs recorded | 6+ .. 21+ |
| KXMLBHA | hits allowed | 1+ .. 8+ |
| KXMLBERA | earned runs | 1+ .. 7+ |
| KXMLBWA | walks allowed | 1+ .. 5+ |

An "N+" contract settles YES when the stat is at least N, so the model
probability is P(X > N − 0.5).

### Decision time and price

Primary **T−120 min** before the scheduled first pitch parsed from the ET time in
the event ticker; **T−30 min** reported as a secondary, not part of the bar. The
quote is the close of the last 1-minute candlestick whose `end_period_ts ≤` the
decision time — never a later candle. A yes bid of 0 or a yes ask of 100 counts
as no quote; both sides are required.

### Trade rule (pre-registered)

The bot's own `planOrders` only knows KXMLBKS and KXMLBOUTS, so this study uses
an explicit rule of its own, fixed here, applied identically to all five series:

1. Blended probability `p = mid + w · (model − mid)`, with **one** weight `w`
   chosen on VALIDATE (searched over 0, 0.1, … 1.0) and then frozen.
2. Buy YES at the ask when `p − ask/100 > fee + 0.02`; buy NO at `100 − bid` when
   `(1 − p) − (100 − bid)/100 > fee + 0.02`. Fee is the bot's own
   `0.07 · P · (1 − P)` per contract, unrounded.
3. Price bounds 15–90c.
4. Cap: no trade where |model − mid| exceeds 12 points (the bot's
   `IMPLAUSIBLE.prop` — a disagreement that large is a data problem, not an edge).
5. One contract per trade, taker at the quoted top of book, one rung per
   pitcher-start per series (the largest edge).
6. P&L from Kalshi's `settlement_value_dollars`. ROI = P&L / (cost + fees).

### Statistics

95% intervals from a cluster bootstrap over **pitcher-start** (`pitcherId:date`,
20,000 resamples, fixed seed), because rungs of one start are not independent.
Brier differences are paired and get the same cluster bootstrap.

### The bar — what counts as success

Both must hold on the **HOLDOUT**, at T−120, for the single chosen configuration:

- **(A)** The model's Brier beats the exchange decision-mid price, with the
  paired cluster-bootstrap 95% interval on (model − market) lying entirely
  **below zero**.
- **(B)** ROI after the 0.07 fee is **positive** with its 95% interval lying
  entirely **above zero**.

Anything less is a **FAIL** and is reported as one. Per-market results (K, outs,
hits allowed, ER, walks) and pooled are reported either way, always with n and
intervals. A negative result, clearly reported, is the successful outcome of this
exercise; tuning until the number looks good is the failure mode it exists to
avoid.

### Pre-declared secondary reporting (not part of the bar)

T−30; fee 0.035 (both series report `fee_multiplier: 0.5`); per-series and
per-side cuts; the Brier-optimal weight on (model − market) as a diagnostic; the
baseline (shipped `projectPitcher`) measured on the same rows, so the question
"did the new modelling work help at all" has an answer independent of the bar.

### Pre-registered stopping condition

One holdout run of the tool at T−120 produces the primary numbers. It is not
re-run with different settings in search of a better one.

---

## Part 2 — What was built, and what the fit window said

### The data

`tools/pitcher-data.mjs` builds **9,574 starts** (4,860 in 2025, 4,714 in 2026
through 09-22) from the public MLB Stats API, each carrying the pitcher's own
game log for both seasons, the opponent's, the **posted lineup** for that game
(every batter's id and hitting hand), the pitcher's **catcher**, the **home-plate
umpire**, the park and the final **weather**. Coverage of lineup, umpire,
catcher and temperature is 9,574 of 9,574 — the schedule endpoint hydrates all
four, so none of this needed a per-game fetch. Every aggregate a start reads is
rebuilt from games strictly before that start's date.

### The model (M2)

`tools/pitcher-fit.mjs` and `tools/pitcher-model2.mjs`. Against the shipped
`projectPitcher`:

1. **One recency-weighted, partially pooled estimate per rate, over both
   seasons.** The offseason is compressed to a fitted `offDays` so a September
   2025 start and an April 2026 start are not 179 days apart in the model's
   eyes. Fitted on FIT: **half-life parameter 400 days for the per-BF rates,
   20 days for depth**, offseason gap 60 days. The implied weight on a
   2025-07-01 start, seen from 2026-08-01, is **0.50** — near the 0.6 the
   shipped blend uses flat — but a 2026-06-01 start gets 0.86 and an April 2026
   start much less, which a flat blend cannot express.
2. **Pooling strengths, fitted, in batters faced:** strikeouts **150**, walks
   **80**, hits allowed **1,200**, home runs 200. That ordering is the whole
   point: a starter's strikeout rate is worth trusting after a couple of
   hundred batters, his hit rate essentially never is.
3. **The opponent is the nine men posted**, each with his own recency-weighted
   pooled rate, plus a fitted term on the share of the lineup holding the
   platoon advantage.
4. **Umpire and catcher** effects, each partially pooled over the starts they
   worked.
5. **Depth first, then everything else.** Predicted outs comes from a fitted
   linear model; the DISTRIBUTION of outs around it is the empirical
   distribution of fit-window starts at that predicted depth, kernel-smoothed.
   The spikes on multiples of three, the cliff after 18 outs and the left skew
   are therefore measured, not modelled, which is what the brief meant by
   respecting the hook.
6. **Each market's dispersion is fitted by log loss**, not assumed. Given depth,
   hits and walks are *under*dispersed (var/mean 0.85-0.86 — a start that lasted
   18 outs cannot have had twelve hits), earned runs *over*dispersed (1.25), and
   strikeouts close to Poisson. One number per market replaces four separately
   argued distribution choices.

### The one finding that changed the design

Conditioning hits, walks and earned runs on depth made them WORSE, and the
coefficients said why: fitted conditionally, the earned-run model came back with
a **negative** coefficient on the pitcher's own run-value rate. Realised depth
is a collider — among starts that reached 18 outs, the pitcher who "should" have
been hit was having a good night, so within that slice his rate predicts fewer
runs. It is a true statement about a conditional and a useless one for pricing,
because at the decision time depth is not known either.

So each market gets whichever route wins on the fit window: **strikeouts use
depth-conditioning** (K/outs is flat at 0.31 across depths — strikeouts really
are a share of the outs), **hits, walks and earned runs use a direct marginal**
with predicted depth as a covariate.

### Outcomes: M2 vs the shipped model

Coefficients fitted on 2025 + 2026 through 06-30 (7,262 starts), scored on the
fit tail 2026-07-01..08-09 (990 starts) that they never saw. Brier over the
lines Kalshi lists; lower is better. **No price data is involved in this table.**

| market | M2 | shipped `projectPitcher` |
|---|---|---|
| strikeouts | **0.1537** | 0.1581 |
| outs recorded | **0.1641** | 0.1680 |
| hits allowed | **0.1820** | 0.1842 |
| walks | **0.1562** | 0.1574 |
| earned runs | **0.1806** | 0.1817 |

M2 is better on all five. It is also better calibrated in level: on the fit
window the shipped model projects 4.53 strikeouts against an actual 4.77 and
15.26 outs against 15.43, while M2 matches both by construction.

### Ablation: what each idea was actually worth

Same 990 fit-tail starts, coefficients fitted on the 7,262 before them. Each row
zeroes one set of coefficients and leaves everything else alone. Total is mean
log loss across the five markets; larger is worse.

| | strikeouts | hits | walks | ER | total |
|---|---|---|---|---|---|
| full model | 0.4681 | 0.5423 | 0.4811 | 0.5420 | **0.50574** |
| no opponent at all | 0.4757 | 0.5427 | 0.4825 | 0.5416 | 0.50757 |
| no home/away | 0.4692 | 0.5426 | 0.4816 | 0.5423 | 0.50617 |
| no catcher | 0.4686 | 0.5428 | 0.4813 | 0.5413 | 0.50586 |
| no lineup handedness | 0.4682 | 0.5424 | 0.4816 | 0.5418 | 0.50585 |
| no home-plate umpire | 0.4681 | 0.5423 | 0.4811 | 0.5420 | 0.50575 |
| no temperature | 0.4679 | 0.5420 | 0.4810 | 0.5419 | **0.50563** |

Read plainly:

- **The opponent carries almost everything** — and it has to be the posted
  lineup; that one term is ten times the size of the next.
- **The home-plate umpire is worth nothing.** 0.00001 of log loss, which is
  zero. Its fitted coefficient also has the wrong sign. An umpire's own
  strikeout rate, however carefully pooled, is noise at this sample size.
- **The catcher is worth 0.0001**, and even that is suspect: a catcher's
  measured strikeout rate is mostly his own pitching staff's, which the model
  already has.
- **Lineup handedness is worth 0.0001**, all of it in walks. Composition alone,
  without per-batter platoon splits, does not carry a strikeout signal.
- **Temperature is worth less than nothing** — removing it improves the score.

(The ablation zeroes rate coefficients only, so the outs column is unchanged by
construction and is left out of the table.)

Pitch mix and velocity were not tested: the Stats API game log carries pitch
counts and strike counts but no pitch type or velocity, and the Statcast feed
that does is outside the two APIs this study is allowed to call.

## Part 3 — Validation (2026-08-10 .. 2026-09-01), against real prices

Run with `--stage validate` at T−120, fee 0.07.

### Coverage (measured)

| | |
|---|---|
| Settled pitcher-prop markets whose game is in the window | 9,701 |
| Matched to a replayed start | **9,485** (the 216 unmatched are markets on a pitcher who did not end up starting) |
| With a two-sided decision quote and binary settlement | **6,954** |
| Decision quote age | median 2 min, p90 24 min, max 230 min |

Two-sided quote coverage is not the same across series, and this turns out to
matter more than anything else in the study:

| series | matched rows | two-sided at T−120 | one side only | no candle at all |
|---|---|---|---|---|
| KXMLBKS | 4,140 | **4,115 (99%)** | 11 | 14 |
| KXMLBOUTS | 568 | **562 (99%)** | 0 | 6 |
| KXMLBHA | 1,944 | **720 (37%)** | 812 | 412 |
| KXMLBERA | 1,744 | **898 (51%)** | 562 | 284 |
| KXMLBWA | 1,089 | **659 (61%)** | 331 | 99 |

Strikeouts and outs are quoted on both sides essentially always. Hits allowed,
earned runs and walks — which Kalshi only opened on **2026-08-17** — are quoted
on one side or not at all most of the time.

**Settlement vs the box score: 5 disagreements in 9,485**, and all five are in
the new series (three earned runs, two hits allowed). Those are precisely the
two stats an official scorer can revise — hit or error, earned or unearned — so
the honest reading is that Kalshi settles the scorer's call on the night and the
Stats API serves the corrected line. P&L below uses Kalshi's settlement, which
is what a trader would have been paid.

### Forecast skill: does the model beat the decision mid?

Paired Brier difference (model − market); **negative means the model is
better**; cluster bootstrap over pitcher-start.

| slice | n | M2 | market | M2 − market | shipped − market |
|---|---|---|---|---|---|
| pooled | 6,954 | **0.1758** | 0.1794 | **−0.0035 [−0.0061, −0.0009]** | −0.0014 [−0.0045, +0.0018] |
| KXMLBKS strikeouts | 4,115 | 0.1513 | **0.1479** | +0.0035 [+0.0011, +0.0058] | +0.0042 [+0.0006, +0.0080] |
| KXMLBOUTS outs | 562 | 0.2514 | **0.2429** | +0.0085 [+0.0005, +0.0161] | +0.0150 [+0.0054, +0.0245] |
| KXMLBHA hits allowed | 720 | **0.2018** | 0.2132 | **−0.0114 [−0.0215, −0.0016]** | −0.0063 [−0.0168, +0.0044] |
| KXMLBERA earned runs | 898 | **0.2054** | 0.2338 | **−0.0284 [−0.0378, −0.0196]** | −0.0246 [−0.0346, −0.0150] |
| KXMLBWA walks | 659 | **0.1956** | 0.2107 | **−0.0151 [−0.0225, −0.0075]** | −0.0131 [−0.0213, −0.0049] |

Two things are true at once, and they pull in opposite directions:

- **On strikeouts and outs the price still wins**, exactly as
  `docs/KALSHI-BACKTEST.md` found. M2 narrows the gap on both (strikeouts
  +0.0042 → +0.0035, outs +0.0150 → +0.0085) but does not close it.
- **On the three new series the model wins, and so does the shipped model.**
  That is the tell. If M2's modelling work were doing this, the shipped model
  would not also beat the price on the same contracts. What is actually
  happening is that KXMLBHA / KXMLBERA / KXMLBWA are five weeks old and barely
  quoted, so the "decision mid" is the midpoint of a wide, thin spread — and a
  wide mid is easy to beat.

### Does beating the mid make money?

No. Same window, the pre-registered trade rule, one contract per signal, taker
at the ask, fee 0.07.

| weight w | trades | ROI [95% CI] |
|---|---|---|
| 0.0 – 0.2 | 0 | (nothing clears the hurdle) |
| 0.3 | 3 | −100% |
| 0.4 | 118 | +13.9% [−3.9, +31.9] |
| 0.5 | 271 | +0.4% [−12.2, +13.3] |
| 0.6 | 434 | −0.3% [−10.9, +9.8] |
| **0.7** | **563** | **+2.7% [−6.8, +12.1]** |
| 0.8 | 680 | +0.8% [−7.5, +8.9] |
| 0.9 | 772 | +0.4% [−7.0, +7.9] |
| 1.0 | 876 | −2.5% [−9.7, +4.6] |

The shipped model on the same contracts is negative at every weight, and
significantly so from w=0.7 up (−9.4% [−16.8, −2.4] at 0.7, −9.9% [−15.9, −3.8]
at 1.0). So the modelling work is worth roughly **10 ROI points** here — and
that still only gets to "not clearly losing".

Per market at w=1.0, where the sample is largest:

| | trades | ROI [95% CI] |
|---|---|---|
| KXMLBKS strikeouts | 401 | −2.4% [−13.8, +9.4] |
| KXMLBOUTS outs | 253 | +7.7% [−4.3, +19.8] |
| KXMLBHA hits allowed | 83 | −17.5% [−36.9, +2.4] |
| KXMLBERA earned runs | 48 | −8.7% [−33.8, +15.8] |
| KXMLBWA walks | 91 | −12.8% [−30.7, +5.0] |

**The three markets where the model beats the mid by the widest margin are the
three that lose the most money.** That is not a contradiction; it is the whole
lesson. The mid of a market quoted on one side 40-60% of the time is not a price
anyone can trade. You pay the ask, and in those series the ask is far enough from
the mid to eat an edge several times the size of the one the Brier score shows.

### The configuration chosen, and how

**w = 0.7**, chosen as the pooled Brier-optimal weight on VALIDATE. It is not
the best ROI on VALIDATE — that was w = 0.4, at +13.9% on 118 trades. Picking
0.4 would be choosing a number by looking at 118 noisy outcomes, which is the
exact failure mode this study was set up to avoid. Everything else in the rule
was fixed in Part 1 and is unchanged.

## Part 4 — Holdout (2026-09-02 .. 2026-09-22), one run

*(to follow)*

## Verdict

*(to follow)*
