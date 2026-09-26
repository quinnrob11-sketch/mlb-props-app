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
