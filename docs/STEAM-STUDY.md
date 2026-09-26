# Does following a price move pay?

"Tail the sharp money" is not testable on public data, because handle and ticket
counts are not public. What *is* testable is the thing sharp money is supposed to
leave behind: **the move itself**. Money hits a price, the price moves, and the
tail is betting the side it moved toward before it finishes moving. Kalshi is a
real-money exchange, its 1-minute candlesticks are public, and every contract
settles against a box score, so the whole question can be answered for free.

`docs/MARKET-EDGE-SEARCH.md` already tested the *opposite* rule. **D2 — fade a
5c hourly move for one hour — returned −17.0%.** That is suggestive and it is
not an answer. A market with a bid and an ask does not pay the two sides of a
trade symmetrically: both sides can lose, and in that study's Family C both
sides did, in all nine price buckets. Losing 17% by fading a move says nothing
about whether following one wins; you pay the spread either way, and the
question is whether continuation is worth more than the toll.

**Everything above the horizontal rule — data, method, the 26 hypotheses, the
pass/fail bar — was written and committed before a single profit-and-loss number
was computed.** The only figures looked at first are market counts, date
coverage and quote availability, which were needed to choose the clocks, and the
fee metadata, which is a property of the exchange.

## Data (measured)

| | |
|---|---|
| Source | Kalshi's public 1-minute candlestick archive, already on disk from `tools/backtest-kalshi-batters.mjs`, `tools/backtest-kalshi-games.mjs` and `tools/backtest-kalshi.mjs`. **This study makes no network request at all** — not to Kalshi, not to StatsAPI, and certainly not to The Odds API. |
| Cache | `kalshi-cache/`, read only, never written by this study. |
| Window | Game dates **2026-07-10 .. 2026-09-16**. The live tier serves nothing earlier; the archive was built through 16 September. |
| Universe | Every settled MLB market in the archive that resolved `yes` or `no`, across all eleven series. |

Three contract classes, matching the three candle directories and the three
resolutions they were fetched at:

| class | series | 1-minute coverage |
|---|---|---|
| **GAME** | KXMLBGAME, KXMLBSPREAD, KXMLBTOTAL, KXMLBRFI | last 5 hours before first pitch |
| **PITCH** | KXMLBKS, KXMLBOUTS | from listing to first pitch |
| **BAT** | KXMLBHIT, KXMLBTB, KXMLBHR, KXMLBRBI, KXMLBHRR | last 2–3 hours before first pitch |

Coverage counted before any rule was run: **19,908 GAME, 13,182 PITCH and
240,571 BAT markets** have candles, and of those **16,710 / 13,101 / 217,370**
have a two-sided quote at both ends of the fast window below.

**Every candle in the archive ends at the scheduled first pitch.** That is not a
convenience, it is the study's main defence, and the trap section below says why.

Fees: all ten prop and line series are `fee_type: quadratic, fee_multiplier:
0.5`; `KXMLBGAME` is `quadratic_with_maker_fees`, also 0.5
(`docs/MARKET-EDGE-SEARCH.md`, read from `GET /series/<S>` on 2026-09-23). Every
number below is at the bot's own rate, **0.07·P·(1−P) per contract per leg**.

## The rule

Let **T** be the scheduled first pitch, from the ET time in the event ticker.
The mid is `(yes bid + yes ask) / 2`; a quote counts only if both sides exist
(yes bid > 0 and yes ask < 100).

Two pre-registered windows, both ending at the same decision clock so that only
the *speed* of the move differs:

- **F (fast)** — Δ = mid(T−30) − mid(T−40). A ten-minute move.
- **S (slow)** — Δ = mid(T−30) − mid(T−90). An hour-long move.

**Entry at T−30, always crossing the spread**, on the side the price moved
toward: Δ > 0 buys YES at the yes ask; Δ < 0 buys NO at `100 − yes bid`. No
resting order is assumed anywhere — `docs/KALSHI-MAKER-STUDY.md` already priced
that alternative at 2.66c a contract, filling on the wrong half of the decisions.

**Two exits, because the brief's two questions are not the same question:**

- **HOLD** — carry to settlement. One fee. This is what a tail needs: it asks
  whether the contract actually *settles* the way the price moved.
- **FLIP** — sell at first pitch, YES at the bid and NO at `100 − ask`. Two
  fees. This asks whether the price *keeps moving*, and it is only tradeable if
  you can get out.

**Move-size buckets** on |Δ|, fixed in advance: **B1 3–4c, B2 5–7c, B3 8–12c,
B4 13c+**. Moves under 1c are dropped as rounding. The 1–2c bucket is kept as a
*noise arm* and is reported, but it is not one of the 26 tests.

## The 26 pre-registered tests

| ids | arm |
|---|---|
| **H1–H4** | HOLD, fast window, buckets B1–B4 |
| **H5–H8** | HOLD, slow window, buckets B1–B4 |
| **F1–F4** | FLIP, fast window, buckets B1–B4 |
| **F5–F8** | FLIP, slow window, buckets B1–B4 |
| **C1–C3** | HOLD, fast window, \|Δ\| ≥ 5c, split by class GAME / PITCH / BAT |
| **C4–C6** | HOLD, slow window, \|Δ\| ≥ 5c, split by class GAME / PITCH / BAT |
| **L1–L2** | HOLD, fast window, \|Δ\| ≥ 5c, decision spread ≤ 2c vs ≥ 3c |
| **L3–L4** | FLIP, fast window, \|Δ\| ≥ 5c, decision spread ≤ 2c vs ≥ 3c |

That is **two windows and four size buckets — eight (speed, size) cells — and
nothing else was tried.** The count matters and it is the whole count: 26 tests,
all listed here before the fact, so the ones that fail stay on the record beside
any that do not.

Six **reference arms** are reported and are *not* among the 26, are not
corrected, and cannot be findings. They exist so the sign of the 26 can be read:

- **R0f, R0s** — the 1–2c noise bucket, HOLD, each window.
- **RFADEf, RFADEs** — the *opposite* side of the same trades, HOLD, |Δ| ≥ 5c.
  If the tail and the fade both lose, the loss is the spread, not a bias, and
  `docs/MARKET-EDGE-SEARCH.md` Family C shows what that looks like.
- **RLATEh, RLATEf** — a third window, Δ over T−15 → T−5 entering at T−5, held
  and flipped. Declared here so the window count is honest: three were computed,
  two are tested.

Alongside every arm, two cost-free descriptives: **fwd**, the mean signed mid
change from the decision clock to first pitch (does the price keep moving?), and
**win**, how often the tailed side settled outright (does the contract go that
way?).

## Pass/fail bar (fixed before any P&L was computed)

A hypothesis is a **finding** only if all four hold:

1. it survives Benjamini–Hochberg at q = 0.10 across all 26 discovery tests
   (Bonferroni at 0.05/26 = 0.0019 reported beside it);
2. its ROI is positive at the full 0.07 fee, after crossing the spread, with a
   95% game-cluster bootstrap interval excluding zero **on the discovery set**;
3. the same rule, frozen, is positive on the **confirmation window** — one look,
   no re-tuning, no re-cut;
4. it fires at least **30 times** in the confirmation window.

Anything else is **no edge demonstrated**, and that is a result.

## The split

- **Discovery: game date ≤ 2026-09-01.** 
- **Confirmation: 2026-09-02 .. 2026-09-16**, read **once**, after the discovery
  pass is written down. `tools/steam-scan.mjs` refuses to print it without
  `--confirm`.

On contamination: the September window has been read by other branches for other
questions — the model's edge, scratched players, the box-score lag. Nothing in
any of them was fitted to a *price path*, and this study's only free parameters
(two clocks, four bucket edges) were chosen from the shape of the candle archive
— which resolutions exist where — not from any outcome. The specific risk of a
contaminated holdout is that a rule was tuned on it; no tuning of this rule has
happened anywhere, on either window. The generic risk, that 68 days of one
season is one sample, is real and the caveats own it.

## The trap, and how it is avoided

The brief names it exactly: a price that moved because the news already broke is
not sharp money. It is the box-score lag `docs/MARKET-EDGE-SEARCH.md` Family B
already found, already priced at about $21 over 68 days, and already knows
lives inside a ninety-second window. Rediscovering it and calling it steam would
be the obvious way to get a false positive here. Four defences, all structural:

1. **No in-game price exists in the data.** Every candle in all three archives
   stops at the scheduled first pitch, because that is where the three studies
   that built them stopped fetching. There is no strikeout to lag, no pitcher to
   pull, no run to score. Family B cannot appear in this study even in
   principle — not filtered out, *absent*.
2. **Both windows sit after the lineup.** `docs/SCRATCH-SETTLEMENT-STUDY.md`
   measured, on 400 games with a replayable MLB feed, that the starting lineup
   was provably public a median of **184 minutes before first pitch** (p10 118,
   min 35). The slow window opens 90 minutes out and the fast one 40 minutes
   out, so in at least 90% of games both windows are entirely downstream of the
   lineup posting, and the fast window is later than every posting but the
   extreme tail.
3. **Cancelled markets are dropped.** A market that settles `scalar` is a
   scratched player — the scratch *is* the resolved news event, and it has no
   binary outcome to tail. Those markets never enter the sample.
4. **The late reference arm.** RLATEh / RLATEf measure a move ending five
   minutes before first pitch, by which point even a late scratch is public.
   If the headline arms and the late arm disagree, residual pre-game news is
   doing the work and the study says so.

What remains uncontrolled and is not pretended otherwise: weather, a bullpen
note, or a beat-writer report inside the window is news that a person could have
had before the price did. This study cannot separate that from money with an
opinion. It does not need to — the question asked is whether *following the
price* pays, whatever moved it.

## Method

1. **No model anywhere.** Nothing in `src/` or `bot/` is imported. The inputs
   are quotes, event tickers, the clock and Kalshi's own settlement values.
   `src/`, `bot/` and `test/` are untouched.
2. **Taker prices on every leg.** YES costs the ask, NO costs `100 − bid`.
3. **Fees** `0.07·P·(1−P)` per contract per leg, unrounded, on entry and on any
   exit. A result has to survive that rate.
4. **Depth is one contract and is assumed, not observed.** Candles do not show
   resting size. Liquidity is proxied by the decision-time spread (which is what
   the trade actually pays) and reported alongside traded volume where Kalshi
   serves it.
5. **P&L** per contract is `payout − price − fees`, payout from Kalshi's own
   `settlement_value_dollars`.
6. **Intervals are cluster bootstraps over games** (`event_ticker`), 5,000
   resamples, fixed seed. Every rung of one game moves together.
7. **p-values** from the same bootstrap, two-sided, floored at 1/5000.
8. **Multiplicity**: all 26 discovery p-values into Benjamini–Hochberg at
   q = 0.10; Bonferroni reported beside it. Nothing failing BH is a finding.

## Reproduce

```
node tools/steam-scan.mjs --kcache <kalshi-cache> --split 2026-09-01 [--confirm] --json out.json
```

No network access is required or attempted; the scanner reads the candle
archive and nothing else. Without `--confirm` it refuses to print the holdout.

---

# Discovery results (run 2026-09-25, game dates through 2026-09-01)

**Short answer: no. Following a move loses, every way it was cut. Seventeen of
the twenty-six tests survive the multiplicity correction and all seventeen are
negative. And the deeper problem is upstream of the P&L — at this clock the
price almost never moves at all.**

Coverage: **705,153 observations** (one per market per window) over 2,544 event
files. 64 markets settled `scalar` and were dropped. Market-observations with a
two-sided quote at both ends of a window: **244,449 fast, 212,173 slow.**

| class | events | markets | quoted at both ends of the fast window |
|---|---|---|---|
| GAME | 837 | 19,908 | 16,706 |
| PITCH | 844 | 13,182 | 13,074 |
| BAT | 863 | 240,571 | 214,669 |

## First: there is almost nothing to tail

Before any rule can pay, a move has to happen. It mostly does not.

| window | quoted | \|Δ\| ≥ 3c | \|Δ\| ≥ 5c |
|---|---|---|---|
| **fast** (10 min, ending T−30) | 244,449 | 1,313 (**0.54%**) | 747 (**0.31%**) |
| **slow** (60 min, ending T−30) | 212,173 | 2,826 (**1.33%**) | 1,279 (**0.60%**) |

And the rate collapses across the window. Fast window, moves of 5c or more:

| | July | August | September |
|---|---|---|---|
| GAME | 29 / 4,072 (0.71%) | 5 / 8,330 (0.06%) | **0 / 4,304** |
| PITCH | 15 / 3,640 (0.41%) | 5 / 6,430 (0.08%) | 3 / 3,004 (0.10%) |
| BAT | 586 / 57,629 (1.02%) | 86 / 107,324 (0.08%) | 18 / 49,716 (0.04%) |

**84% of every fast 5-cent move in the whole archive happened in July.** In
September, across 4,304 quoted game-line observations, the mid did not move five
cents in ten minutes **even once**. This is not a property of the rule; it is a
property of the book. Something about how these markets are quoted changed
between July and August, and after it changed the raw material for a tail
mostly stopped being produced.

The consequence is structural and it is fatal to the fast arms on its own: a
rule that fires 0.04% of the time on the most recent data cannot clear
condition 4 of the bar, whatever its sign.

## Where there is liquidity

Restricted to markets with a two-sided quote 30 minutes before first pitch:

| class | median spread | spread ≤ 2c | never traded | median volume |
|---|---|---|---|---|
| GAME | 1c | 99.9% | — (Kalshi does not serve volume on these series) | — |
| PITCH | 1c | 93.3% | 0.04% | 3,409 |
| BAT | 1c | 81.0% | 18.7% | 44 |

`docs/SCRATCH-SETTLEMENT-STUDY.md` found 51–54% of settled markets never trade.
That is over *all* markets, including the deep rungs nobody quotes. Conditioned
on having a live two-sided quote half an hour before first pitch — which is what
a tail needs — the dead fraction falls to 19% on batter props and to nothing on
the pitcher and game markets. **Liquidity is not the binding constraint. The
absence of movement is.**

## The 26 tests

`px` is the mean taker price paid, `sprd` the mean quoted spread at the decision
clock, `fwd` the mean signed mid change from the decision clock to first pitch
(positive = the price kept going), and `win` how often the tailed side settled
outright.

### HOLD to settlement — the tail

| id | window, bucket | n | games | ROI [95%] | p | c/contract | px | sprd | fwd | win |
|---|---|---|---|---|---|---|---|---|---|---|
| H1 | fast, 3–4c | 500 | 203 | −5.71% [−16.19, 4.68] | 0.2684 | −2.21c | 37.6 | 4.82 | −0.00c | 36.6% |
| **H2** | fast, 5–7c | 345 | 124 | **−16.77% [−29.26, −3.90]** | 0.0108 | −6.42c | 36.9 | 4.50 | −0.55c | 31.9% |
| **H3** | fast, 8–12c | 206 | 75 | **−25.92% [−41.12, −12.05]** | 0.0002 | −13.25c | 49.7 | 5.98 | −0.63c | 37.9% |
| H4 | fast, 13c+ | 176 | 56 | −3.02% [−13.67, 7.85] | 0.5764 | −2.23c | 72.6 | 9.85 | −0.19c | 71.6% |
| **H5** | slow, 3–4c | 1,309 | 544 | **−9.22% [−15.79, −2.28]** | 0.0040 | −3.76c | 39.5 | 2.58 | +0.02c | 37.0% |
| H6 | slow, 5–7c | 576 | 175 | −0.06% [−12.66, 12.07] | 0.9784 | −0.02c | 35.0 | 3.02 | +0.35c | 36.3% |
| H7 | slow, 8–12c | 304 | 91 | −3.92% [−17.52, 9.14] | 0.5192 | −1.84c | 45.5 | 4.31 | +0.58c | 45.1% |
| **H8** | slow, 13c+ | 272 | 76 | −10.03% [−20.42, 0.07] | 0.0524 | −6.97c | 68.1 | 7.79 | −2.82c | 62.5% |

### FLIP out at first pitch — the tradeable momentum bet

| id | window, bucket | n | games | ROI [95%] | p | c/contract |
|---|---|---|---|---|---|---|
| **F1** | fast, 3–4c | 500 | 203 | **−20.67% [−22.78, −18.69]** | 0.0002 | −8.02c |
| **F2** | fast, 5–7c | 345 | 124 | **−21.78% [−24.99, −18.86]** | 0.0002 | −8.34c |
| **F3** | fast, 8–12c | 206 | 75 | **−19.82% [−24.32, −16.16]** | 0.0002 | −10.13c |
| **F4** | fast, 13c+ | 176 | 56 | **−17.38% [−22.99, −13.34]** | 0.0002 | −12.83c |
| **F5** | slow, 3–4c | 1,309 | 544 | **−14.55% [−15.61, −13.49]** | 0.0002 | −5.93c |
| **F6** | slow, 5–7c | 576 | 175 | **−17.05% [−19.64, −14.55]** | 0.0002 | −6.19c |
| **F7** | slow, 8–12c | 304 | 91 | **−15.81% [−19.01, −13.00]** | 0.0002 | −7.42c |
| **F8** | slow, 13c+ | 272 | 76 | **−19.96% [−25.15, −15.61]** | 0.0002 | −13.87c |

All eight FLIP arms lose, all eight at p = 0.0002, all eight surviving
Bonferroni. This is the answer to the first half of the brief's question one and
it is unambiguous: **the price does not keep moving.** `fwd` is within 0.6c of
zero in seven of the eight cells, so there is nothing for a round trip to
capture, and the round trip itself costs a spread and two fees.

### By class and by liquidity

| id | arm | n | games | ROI [95%] | p |
|---|---|---|---|---|---|
| C1 | HOLD, fast, ≥5c, GAME | 34 | 7 | −35.38% [−85.71, 14.25] | 0.1660 |
| C2 | HOLD, fast, ≥5c, PITCH | 20 | 13 | +0.76% [−42.53, 33.52] | 0.9620 |
| **C3** | HOLD, fast, ≥5c, BAT | 673 | 132 | **−13.78% [−21.86, −6.06]** | 0.0004 |
| C4 | HOLD, slow, ≥5c, GAME | 44 | 8 | +8.16% [−22.36, 50.12] | 0.6272 |
| C5 | HOLD, slow, ≥5c, PITCH | 45 | 38 | −14.91% [−40.09, 10.73] | 0.2500 |
| C6 | HOLD, slow, ≥5c, BAT | 1,063 | 171 | −4.74% [−14.61, 5.06] | 0.3128 |
| **L1** | HOLD, fast, ≥5c, spread ≤ 2c | 197 | 74 | **−19.44% [−37.07, −1.69]** | 0.0304 |
| **L2** | HOLD, fast, ≥5c, spread ≥ 3c | 530 | 125 | **−13.01% [−21.21, −5.08]** | 0.0008 |
| **L3** | FLIP, fast, ≥5c, spread ≤ 2c | 197 | 74 | **−13.42% [−19.50, −8.31]** | 0.0002 |
| **L4** | FLIP, fast, ≥5c, spread ≥ 3c | 530 | 125 | **−21.60% [−25.54, −18.36]** | 0.0002 |

Only two of the twenty-six have a positive point estimate — C2 (n = 20) and C4
(n = 44) — and both have intervals four times wider than the estimate. The two
classes where a "move" is most likely to be a genuine repricing rather than a
quote flicker, GAME and PITCH, are exactly the two that almost never move: 54
fast ≥5c observations between them across 65 days.

**L1 is the cut that kills the cheapest excuse.** Restricted to markets quoting
two cents wide or tighter — where the mid is a real mid and a 5c move is a real
move — tailing still loses 19.4%, and the interval excludes zero.

## Reference arms (not corrected, not findings)

| id | arm | n | ROI [95%] | c/contract |
|---|---|---|---|---|
| R0f | HOLD, fast, \|Δ\| 1–2c (noise) | 8,250 | −4.38% [−6.43, −2.37] | −2.26c |
| R0s | HOLD, slow, \|Δ\| 1–2c (noise) | 25,711 | −5.16% [−6.35, −3.98] | −2.64c |
| RPOOLf | HOLD, fast, ≥5c, pooled | 727 | −14.53% [−22.35, −6.99] | −7.34c |
| RPOOLs | HOLD, slow, ≥5c, pooled | 1,152 | −4.57% [−14.01, 4.44] | −2.14c |
| RFADEf | the other side at the *same* price, fast, ≥5c | 727 | +8.84% [1.71, 15.97] | +4.62c |
| RFADEs | the other side at the *same* price, slow, ≥5c | 1,152 | −0.95% [−8.64, 6.93] | −0.53c |
| RTFADEf | the other side at **its own taker price**, fast, ≥5c | 727 | −2.75% [−9.58, 3.85] | −1.61c |
| RTFADEs | the other side at **its own taker price**, slow, ≥5c | 1,152 | −8.34% [−15.36, −1.04] | −5.02c |
| RLATEh | HOLD, T−15 → T−5, ≥5c | 461 | −16.95% [−24.10, −10.41] | −11.60c |
| RLATEf | FLIP, T−15 → T−5, ≥5c | 461 | −27.07% [−31.41, −23.55] | −18.52c |

These rows are the whole interpretation, so read them together.

**R0f/R0s set the toll.** Crossing the spread at T−30 with no view at all and
holding to settlement costs **2.26c to 2.64c a contract.** That is the number
any signal has to beat, and it sits below the 3.66c `docs/MARKET-EDGE-SEARCH.md`
D1 measured for a six-hour *round* trip, as a one-legged version of the same
toll should.

**RPOOLf says the fast move is worse than no view at all.** Tailing a ≥5c
ten-minute move loses 7.34c against the 2.26c a coin flip loses. About 1.9c of
the 5.1c gap is the wider spread in the cells where moves happen; the remaining
~3.2c is direction. The move predicts **against itself.**

**RFADEf makes that explicit and RTFADEf takes it away again.** At the tail's
own price, the other side of these trades returns +8.84% with an interval
excluding zero — the reversal is real. At the price you would actually have to
pay for it, 6.21c of spread further away, it returns **−2.75% [−9.58, 3.85]**.
This is `docs/MARKET-EDGE-SEARCH.md` Family C exactly: both sides of a spread
can lose, and here both sides do. There is a signal in the fast move and it is
smaller than the cost of acting on it, in either direction.

**RLATEh/RLATEf, the third window, agree with the two that were tested** —
−17.0% held and −27.1% flipped. Five minutes before first pitch the mean spread
on a market that just moved is 14.6c, and nothing survives paying half of that.
No arm anywhere in the study points the other way, so the choice of clock is not
what produced the answer.

## Post-hoc (added after scoring, corrected for nothing)

The activity census forces one question the pre-registration did not ask: the
fast rule fires overwhelmingly in July, so is its sign a July artefact?

| | n | ROI [95%] | c/contract |
|---|---|---|---|
| HOLD fast ≥5c, July | 630 | −15.83% [−23.95, −8.35] | −7.97c |
| HOLD fast ≥5c, August | 96 | −4.98% [−34.34, 19.15] | −2.57c |
| HOLD slow ≥5c, July | 1,029 | −2.69% [−12.61, 6.94] | −1.25c |
| HOLD slow ≥5c, August | 122 | −18.73% [−37.04, −0.49] | −9.26c |

Partly, yes. The fast arm's loss is mostly a July number, because the fast arm
is mostly a July sample; August alone cannot resolve −5% from zero on 96 trades.
Nothing here is positive and nothing here is a finding, but the honest reading
is that the *strength* of the fast anti-signal rests on one month.

**One disclosure.** This post-hoc table was first computed without the holdout
gate, so its September rows (n = 21, −11.9%; n = 128, −0.5%) were seen before
the formal confirmation read below. The gate was then added and the table above
is discovery-only. It changed no decision: no rule was eligible for confirmation
under condition 2 either before or after, and both leaked numbers were negative,
like everything else.

## Two corrections to the pre-registration

Both are recorded rather than quietly fixed.

1. **The coverage counts in Data are slightly high.** They were taken from a
   probe that required a two-sided quote at the two ends of the fast window;
   the scanner also requires one at first pitch (the FLIP arm needs an exit) and
   drops `scalar` settlements. The real figures are 16,706 / 13,074 / 214,669,
   against 16,710 / 13,101 / 217,370 as written. Nothing depends on the
   difference.
2. **Four reference arms were added after the discovery pass was scored**, and
   are marked as such above: RPOOLf and RPOOLs, which only pool cells already
   reported, and RTFADEf and RTFADEs, the fade at its own taker price. RTFADE
   exists because RFADE came back positive and a reader would immediately and
   correctly ask whether the reversal is tradeable. It is not. None of the four
   is among the 26, none is corrected, and none can be a finding.

## Multiplicity

26 pre-registered tests, all scored, all with bootstrap p-values.

- **Benjamini–Hochberg at q = 0.10 survivors (17):** H2, H3, H5, H8, F1–F8, C3,
  L1, L2, L3, L4.
- **Bonferroni at 0.05/26 = 0.0019 survivors (12):** H3, F1–F8, C3, L2, L3, L4.
- **Survivors with a positive ROI: none.**
- **Tests with a positive point estimate at all: two** (C2, n = 20; C4, n = 44),
  neither within a factor of four of significance.

**No rule reaches condition 2 of the pass/fail bar, so nothing is eligible to be
confirmed on the holdout.** The holdout is used below only for what it can still
answer: does the collapse in movement continue, and does the sign stay negative.

---

# Confirmation (2026-09-02 .. 2026-09-16, read once)

No rule was eligible under condition 2 — not one of the 26 had a positive
discovery ROI with an interval excluding zero — so nothing was carried forward
to be confirmed. The holdout is used for the two questions it can still answer:
**does the collapse in movement continue, and does the sign stay negative?**

## The collapse continues, and it decides the fast arms on its own

| | discovery (51 dates) | confirmation (15 dates) |
|---|---|---|
| fast \|Δ\| ≥ 5c, all classes | 727 (**14 a day**) | **20 (1.3 a day)** |
| slow \|Δ\| ≥ 5c, all classes | 1,152 (23 a day) | 127 (8.5 a day) |
| fast \|Δ\| ≥ 5c on a game line | 34 | **0** |
| mean spread where a fast ≥5c move happened | 6.21c | **12.00c** |

Condition 4 of the bar asks for 30 trades in the confirmation window. **Fifteen
of the twenty-six tests fire fewer than 30 times; four fire zero times** (C1, C4,
L1, L3). The fast rule is not merely unprofitable in September — it is
essentially not a rule any more, and the handful of markets that do jump ten
cents in ten minutes are quoting twelve cents wide when they do it.

## The sign stays negative

| id | arm | n | ROI [95%] | verdict |
|---|---|---|---|---|
| H1 | HOLD, fast, 3–4c | 66 | +0.50% [−16.90, 21.07] | zero |
| H5 | HOLD, slow, 3–4c | 238 | −2.86% [−16.22, 10.94] | zero |
| H6 | HOLD, slow, 5–7c | 88 | +5.76% [−22.41, 38.07] | zero |
| C6 | HOLD, slow, ≥5c, BAT | 111 | −0.28% [−43.56, 57.74] | zero |
| **F1** | FLIP, fast, 3–4c | 66 | **−15.70% [−17.97, −13.06]** | replicates |
| **F5** | FLIP, slow, 3–4c | 238 | **−12.70% [−14.41, −11.11]** | replicates |
| **F6** | FLIP, slow, 5–7c | 88 | **−20.61% [−24.71, −16.34]** | replicates |
| R0f | noise arm, fast | 3,218 | −6.79% [−9.80, −3.68] | the toll |
| R0s | noise arm, slow | 9,467 | −3.53% [−5.38, −1.71] | the toll |
| RTFADEf | tradeable fade, fast | 20 | −18.62% [−57.03, 7.73] | still negative |
| RTFADEs | tradeable fade, slow | 127 | −18.51% [−38.25, 0.85] | still negative |

Those are the only arms with enough trades to mean anything, and they say the
same three things the discovery pass said. **Holding the tail is worth zero.
Flipping it out loses a round trip, every cell, p = 0.0002 in all eight.
Crossing the spread with no view at all costs 1.8c to 3.4c a contract, and both
directions lose after that.**

**Two positive-looking cells are worth naming precisely because they are not
findings.** H4 returns +16.51% with a bootstrap p of 0.0002 — on **three trades
across two games**, all three of which won. A cluster bootstrap over two
clusters cannot produce a meaningful interval and the p-value here is an
artefact of resampling two things; it is reported unedited because the
pre-registration said every cell would be. H7 returns +77% on 22 trades in 8
games. Neither was eligible, neither fires 30 times, and neither survives a
glance. This is exactly the shape of result the four-condition bar exists to
throw away.

# Verdict

**Following a price move does not pay. The blocker is not one thing, it is
three, in this order: there is no signal, the cost is larger than the small
anti-signal that does exist, and at the clock where a tail would have to fire
the price has almost stopped moving at all.**

Answering the brief's questions one at a time.

**1. Does a move predict continuation?** No, in both senses, and they come apart
in an informative way.

- *Does the price keep moving?* No. The mean forward mid change from the
  decision clock to first pitch is within 0.6c of zero in seven of the eight
  pre-registered cells, and negative in five. Trading that — the FLIP arms —
  loses 14.6% to 21.8% on discovery and 12.7% to 58.6% on confirmation, at
  p = 0.0002 in all sixteen cells. There is nothing there to capture and the
  round trip costs a spread plus two fees.
- *Does the contract settle that way?* No — worse than no. Tailing a ≥5c
  ten-minute move and holding to settlement loses **7.34c a contract** where a
  coin flip at the same clock loses 2.26c. Roughly 1.9c of that gap is the wider
  spread in the cells where moves happen; the rest, about **3.2c, is the move
  pointing the wrong way.** The other side of those same trades, at their own
  price, returns **+8.84% [1.71, 15.97]**.

**2. Where does continuation beat the 2.66c round trip?** Nowhere. Not in any
size bucket, either speed, either exit. The closest any cell comes to positive
with a real sample is H6 (slow, 5–7c) at −0.06% on discovery and +5.76% on
confirmation, both intervals straddling zero by more than 20 points. The
measured toll in this study is **2.26c–3.38c for the one-legged hold** and
5.9c–13.9c a contract for the round trip, and the largest directional signal
found anywhere is the 4.6c reversal in RFADEf — which is worth less than the
6.21c spread you would pay to take it. **The reversal is real and it is not
tradeable**, which is the same sentence `docs/MARKET-EDGE-SEARCH.md` Family C
wrote about the longshot bias.

**3. Which contracts?** Liquidity is *not* the binding constraint, which was the
surprise. Conditioned on a live two-sided quote 30 minutes before first pitch,
batter props have a 1c median spread and 81% trade; pitcher and game markets are
essentially all live. The constraint is that **game lines and pitcher props,
the two classes where a move is most likely to be somebody's opinion rather than
a quote flicker, are the two that never move**: 54 fast ≥5c observations between
them over 65 days, and zero on a game line in the whole confirmation window.
Almost the entire sample is batter props, where a five-cent mid move on a
44-contract median volume is not obviously money at all.

**4. The trap.** It was avoided structurally, not statistically. Every quote in
this study is from before the scheduled first pitch, because that is where all
three candle archives stop — so the box-score lag `docs/MARKET-EDGE-SEARCH.md`
Family B found is not filtered out of this sample, it is absent from it. Both
windows sit after the median lineup posting (184 minutes before first pitch,
p10 118, per `docs/SCRATCH-SETTLEMENT-STUDY.md`), cancelled-player markets are
dropped, and the late reference arm ending five minutes before first pitch
agrees with the two that were tested. The reassuring evidence that this worked
is the sign itself: if resolved news were driving these moves, tailing them
would have *won*. It lost.

## What would change this answer

- **A different clock.** Everything here is anchored 30 minutes before first
  pitch, because that is where all three archives have 1-minute resolution.
  Pitcher strikeout props have 1-minute candles from listing, and the money in a
  pregame market may well move six or twelve hours out, on the lineup or the
  weather, not in the last half hour. That window is fetchable for KXMLBKS
  today and was not tested here.
- **Trades, not quotes.** A mid move is not a trade. Kalshi serves per-minute
  volume in the candle payload, which this archive discarded; a move with 200
  contracts behind it is a different object from a move with none, and this
  study cannot tell them apart.
- **In-game.** All of the price action in a baseball contract is after first
  pitch, and none of it is in this archive. That is also where the box-score lag
  lives, so any in-game momentum study has to do real work to separate the two —
  work this study got for free by never looking.

## Caveats

- **68 days, one season, and a regime change inside it.** The fast rule fires
  fourteen times a day in July and 1.3 times a day in September. Whatever
  changed in how these markets are quoted between July and August, this study
  straddles it, and the discovery window is disproportionately the old regime.
- **The fast anti-signal rests on one month.** 630 of the 727 fast ≥5c discovery
  trades are July. August alone (n = 96) cannot resolve −5% from zero.
- **A mid is not a price and a move in a wide book may be one side flickering.**
  The L1 cut (spread ≤ 2c, still −19.4%) is the defence against this, on 197
  trades.
- **Depth is one contract and is assumed, never observed.** Candles show no
  resting size.
- **Taker prices throughout.** `docs/KALSHI-MAKER-STUDY.md` priced the resting
  alternative at 2.66c a contract, filling disproportionately when the market is
  moving against you — which is precisely the adverse selection a momentum rule
  would walk into.
- **Scheduled first pitch, not actual.** T comes from the ET time in the event
  ticker. A rain delay moves the real first pitch and not this clock; the
  archive stops at T either way, so nothing in-game leaks in, but a delayed
  game's "T−30" is not thirty minutes before anything in particular.
- **The confirmation window is 15 dates**, not the 21 the earlier studies had,
  because the candle archive was built through 16 September. Extending it means
  refetching, and nothing in the result is close enough to zero for six more
  days to matter.

## What this does not say

- It does not say the market is efficient. It says that at this clock, in this
  window, at these sizes, the price mostly does not move, and when it does, the
  information in the move is smaller than the spread.
- It does not touch the model. `docs/AUDIT.md` stands unchanged; no model was
  imported here.
- It does not test sportsbook line movement, which is what "steam" usually
  means. That needs a multi-book historical archive this repo does not have,
  and `docs/AUDIT.md` still names it as the open question.
