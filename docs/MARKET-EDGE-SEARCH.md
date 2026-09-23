# Is the price beatable? A search for an edge in the market, not in the model

Every study in this directory has asked the same question — *is our probability
better than Kalshi's price?* — and got the same answer: no, in seven categories,
with the interval excluding zero on the model's side every time
(`docs/AUDIT.md`). This document asks a different question, and one that does not
need the model to be right about anything:

> **When and where is the price itself beatable?**

Three kinds of answer would count. The price can be beatable because it is
*internally inconsistent* — two Kalshi contracts on the same game quoted so that
a pair of orders cannot lose. It can be beatable because it is *stale* — the box
score has already decided the contract and the quote has not caught up. Or it can
be beatable because it is *systematically biased* at some price level, on some
clock, or on some kind of listing. None of those requires a forecast.

**Everything in Data, Method, the hypothesis list and the pass/fail rule below
was written and committed before any profit-and-loss was computed.** The commit
that adds this section contains no results. The only numbers looked at first are
the market counts and date coverage in Data, which were needed to decide the
split, and the fee metadata, which is a property of the exchange.

## Data (measured)

| | |
|---|---|
| Source | Kalshi public API, no auth, no order ever placed: `GET /markets?series_ticker=…&status=settled` (paginated), `GET /markets/candlesticks`, `GET /series/<S>`. Plus the public MLB StatsAPI for play timestamps. The Odds API is not called. |
| Cache | `ecache/` in this worktree (not committed). Requests go out one at a time, at least 250 ms apart, with exponential back-off on 429/5xx. |
| Universe | **294,589 settled markets** across all eleven MLB series the exchange lists, every one of them parsed to a game date. |
| History | The live tier holds settled markets from **2026-07-17** to **2026-09-22**. Older data lives only on `/historical/*` and is not used, so 68 game dates is the whole record available. |

| series | settled markets | | series | settled markets |
|---|---|---|---|---|
| KXMLBHRR (hits+runs+RBIs) | 79,267 | | KXMLBKS (strikeouts) | 12,591 |
| KXMLBTB (total bases) | 63,374 | | KXMLBTOTAL (game total) | 11,117 |
| KXMLBHIT (hits) | 52,167 | | KXMLBSPREAD (run line) | 7,829 |
| KXMLBRBI (RBIs) | 33,071 | | KXMLBGAME (moneyline) | 1,822 |
| KXMLBHR (home runs) | 30,763 | | KXMLBOUTS (outs) | 1,681 |
| | | | KXMLBRFI (run in 1st) | 907 |

Fees, read from `GET /series/<S>` on 2026-09-23: all ten prop and line series are
`fee_type: quadratic`, `fee_multiplier: 0.5`; `KXMLBGAME` alone is
`quadratic_with_maker_fees`, also 0.5. Every result below is reported at the
bot's own rate, **0.07·P·(1−P) per contract**, and has to survive there; 0.035 is
shown as a sensitivity only.

### Price snapshots

Hourly, not 1-minute. 294,589 markets cannot be pulled at 1-minute resolution
politely, and the hour is enough for the questions here: the *close* of an hourly
candle is the top of book at that hour boundary, so candles for the same hour on
two different contracts are simultaneous, which is what a cross-contract scan
requires. One consequence matters and is repeated wherever it bites: **an
arbitrage that opens and closes inside one hour is invisible here, so every
violation count in Family A is a lower bound.** Family B, where the stakes are
highest, is re-run at 1-minute resolution on the markets it selects.

Snapshots are taken relative to the scheduled first pitch T, which comes from the
ET time in the event ticker: T−6h, T−3h, T−2h, T−1h and T. A quote is the last
candle ending at or before the snapshot, so it never reads the future. A yes bid
of 0 or a yes ask of 100 counts as no quote.

## The split, fixed before anything was computed

- **Discovery: game date ≤ 2026-09-01.** 47 dates.
- **Confirmation: 2026-09-02 .. 2026-09-22.** 21 dates, looked at **once**, after
  the discovery pass is finished and written down.

## The hypotheses

Twenty-six pre-registered tests in five families. They are all listed here,
before the fact, precisely so that the ones that fail stay on the record next to
the ones that do not. A number found after twenty tries is not a p-value.

### Family A — internal consistency (arbitrage)

No forecast is involved. A violation is an inequality between two quotes that
exist at the same instant, and the pair of orders it licenses cannot lose money.

For two contracts where YES on *h* implies YES on *l* (h is the harder event),
buying YES(l) at its ask and selling YES(h) at its bid pays at least 100c and
costs `ask(l) + 100 − bid(h)`. So the pair is riskless profit exactly when

```
bid(h) − ask(l) > fee(ask(l)) + fee(100 − bid(h))
```

- **A1** KXMLBKS strikeout ladders — same event, same Kalshi player UUID, strikes ordered.
- **A2** KXMLBHIT ladders. **A3** KXMLBTB ladders. **A4** KXMLBHRR ladders. **A5** KXMLBRBI ladders. **A6** KXMLBHR ladders.
- **A7** KXMLBTOTAL ladders (game total, strikes ordered).
- **A8** KXMLBSPREAD ladders (same event, same team, strikes ordered).
- **A9** KXMLBGAME moneyline coherence: the two sides of one game must sum to 100.
  Riskless if `ask(home) + ask(away) < 100 − fees` (buy both) or
  `bid(home) + bid(away) > 100 + fees` (sell both).
- **A10** Moneyline against run line: winning by 2+ implies winning, so
  `bid(spread −1.5) > ask(moneyline)` on the same team is riskless.

### Family B — deterministic resolution lag (the stale price)

The strongest form of "the price lags the news" that public data can settle
exactly, because here the news is the box score and StatsAPI timestamps every
play. Once a starter has recorded his *s*-th strikeout the contract "s+
strikeouts" is worth exactly 100c. Once he has left the game with *F* strikeouts,
every contract above *F* is worth exactly 0c.

- **B1** After the timestamp of the *s*-th strikeout, is "s+" still buyable below
  `100 − fee`? For how long, how often, and for how much?
- **B2** After the starter's last recorded pitch, is a contract above his final
  strikeout total still sellable above `0 + fee`? For how long, how often, how much?

Both are measured at 1-minute resolution on the markets they select, and both
report the delay between the play's StatsAPI timestamp and the first quote that
prices the certainty.

### Family C — systematic price-level bias

The classic longshot bias, tested model-free: at T−1h, cross the spread to bet
*against* the tail, hold to settlement.

- **C1**–**C5** yes-mid buckets 1–5c, 6–10c, 11–20c, 21–35c, 36–64c: buy NO at the ask.
- **C6**–**C9** yes-mid buckets 65–79c, 80–89c, 90–94c, 95–99c: buy YES at the ask.

Nine tests. Each is two-sided: a bucket that loses significantly is the same
discovery as one that wins, pointing the other way.

### Family D — price path

- **D1** Drift, traded: buy the yes side at the ask at T−6h, sell at the bid at T.
  Pays the spread twice and is a pure bet on where the close will be.
- **D2** Reversion: after an hourly mid move of at least 5c, trade the opposite
  way for one hour, at the ask in and the bid out.
- **D3** Early listings: the Family C rule restricted to markets opened more than
  24 hours before first pitch, against the same rule on same-day listings.

### Family E — mechanics

- **E1** Scalar settlements. A scratched starter's contract settles at a "fair
  market price" rather than 0 or 1. Is that value predictable from the last quote
  before the scratch, and is there a side of it that pays?
- **E2** Doubleheaders. The Family C rule restricted to `G1`/`G2` tickers.

Counting: A1–A10, B1–B2, C1–C9, D1–D3, E1–E2 = **26 pre-registered tests.**

## Method

1. **No model, anywhere.** Nothing in `src/` or `bot/` is imported for a
   probability. The only inputs are quotes, tickers, clocks, StatsAPI play
   timestamps and Kalshi's own settlement values. `src/`, `bot/` and `test/` are
   not modified.
2. **Execution is always taker.** Every trade crosses the spread: YES costs the
   yes ask, NO costs `100 − yes bid`. No resting order is assumed —
   `docs/KALSHI-MAKER-STUDY.md` already measured what resting is worth (2.66c a
   contract, and it fills on the wrong half of the decisions).
3. **Fees** are `0.07·P·(1−P)` per contract per leg, unrounded, charged on entry
   and on any exit. A result has to survive that rate. 0.035 is a sensitivity.
4. **Depth is one contract** and is *assumed*, not known: candles do not show
   size. For Family A this is the binding caveat, and the study reports the
   realised volume alongside every violation.
5. **P&L** per contract is `payout − price − fee`, payout from Kalshi's own
   `settlement_value_dollars`. ROI is P&L over money risked (price + fee).
6. **Intervals are cluster bootstraps over games** — the event segment of the
   ticker — 5,000 resamples, fixed seed. Rungs of one player-game move together
   and are not independent bets.
7. **p-values** come from the same game-cluster bootstrap, two-sided:
   `p = 2·min(Pr[ROI* ≤ 0], Pr[ROI* ≥ 0])`, floored at 1/5000.
8. **Multiplicity.** All 26 p-values from the discovery pass go into
   Benjamini–Hochberg at q = 0.10. The Bonferroni threshold (0.05/26 = 0.0019) is
   reported next to it. Nothing that fails BH is called a finding, whatever its
   point estimate.

## Pass/fail rule (fixed before any P&L was computed)

A hypothesis is a **finding** only if all of these hold:

1. it survives Benjamini–Hochberg at q = 0.10 across all 26 discovery tests;
2. its ROI is positive at the full 0.07 fee rate, after crossing the spread,
   with a 95% game-cluster interval excluding zero **on the discovery set**;
3. the same rule, frozen, is positive on the **confirmation** window
   2026-09-02 .. 2026-09-22 — one look, no re-tuning, no re-cut;
4. it fires often enough to matter: at least 30 trades in the confirmation window.

Family A is judged differently, because an arbitrage does not need a p-value: a
violation counts only if `bid(h) − ask(l)` exceeds both legs' fees, and the
family is a finding only if violations are **repeatable** — present in both
windows at a similar rate — and the same minute shows enough traded volume that
one contract on each side is credible.

Anything else is reported as **no edge demonstrated**, and that is a result, not
a failure.
