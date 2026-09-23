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

---

# Discovery results (run 2026-09-23, game dates through 2026-09-01)

**Short answer: no. Nothing in the price is beatable by a rule you can write
down in advance, except for about ninety seconds at a time, a few times a day,
for a total of about $16 at one contract a go.**

Ten of the fourteen scored tests survive Benjamini-Hochberg. **Every single one
of them is negative.** The corrected survivors are not edges; they are the
spread, measured ten different ways, with enough data behind each that the
interval no longer touches zero. The one thing that is genuinely there — the
price lagging the box score — is real, riskless and small.

Coverage: **294,589 settled markets**, of which **245,179** had a two-sided
quote at T−1h.

## Family A — internal consistency: no violations at all

| test | series | ladder-hours | quoted pairs | widest `bid(h) − ask(l)` | locked | crossed, fee ate it | **violations** |
|---|---|---|---|---|---|---|---|
| A1 | KXMLBKS | 2,374 | 47,184 | −1c | 0 | 0 | **0** |
| A2 | KXMLBHIT | 43,822 | 126,672 | 0c | 1 | 0 | **0** |
| A3 | KXMLBTB | 43,809 | 270,744 | −1c | 0 | 0 | **0** |
| A4 | KXMLBHRR | 43,299 | 388,014 | 0c | 4 | 0 | **0** |
| A5 | KXMLBRBI | 10,153 | 11,943 | −7c | 0 | 0 | **0** |
| A6 | KXMLBHR | 9,421 | 1,446 | −7c | 0 | 0 | **0** |
| A7 | KXMLBTOTAL | 7,643 | 359,096 | −2c | 0 | 0 | **0** |
| A8 | KXMLBSPREAD | 15,286 | 39,327 | −4c | 0 | 0 | **0** |
| A9 | KXMLBGAME moneyline | 7,656 | 6,571 | — | 0 | 5 | **0** |
| A10 | moneyline vs run line | 15,264 | 39,287 | — | 0 | 0 | **0** |
| | **total** | **198,727** | **1,290,284** | | **5** | **5** | **0** |

Over 1.29 million simultaneous pairs of contracts whose outcomes are logically
nested, the book **never once crossed far enough to pay a fee**, and in eight of
the ten tests it never crossed at all. The strongest statement the data allows is
the "widest" column: on the strikeout ladder the best the book ever offered was
`bid(h) = ask(l) − 1c`, one cent the wrong side of free. Five pairs in 1.29
million were exactly locked, which pays nothing. The five near-misses are all on
the moneyline, where the two sides of a game summed to slightly less than 100c
and the two fees were larger than the gap.

This is what an actively quoted book looks like. Whoever makes these markets
quotes the whole ladder off one distribution, so the ladder cannot disagree with
itself. **Hypothesis 2 from the brief — free money inside the book — is dead, and
it is dead by a wide margin rather than a narrow one.**

The caveat that survives: these are hourly snapshots. An inconsistency that
opened and closed inside one hour is invisible here. But an edge that never once
persists to an hour boundary across 198,727 ladder-hours is not one that a
system reading the book every few minutes is going to collect.

## Family B — the price does lag the box score, for about a minute

This is the only thing in the whole search that is real. 904 strikeout events
matched to StatsAPI, 1,692 pitcher-games, 0 ambiguous name matches, and **19
contradictions in 12,152 checks (0.16%)** between StatsAPI's strikeout count and
Kalshi's own settlement — the match is essentially exact.

**B1 — after the pitcher's s-th strikeout, "s+" is certain YES.** 3,706 such
contracts.

| delay after the strikeout | still had a buyable ask | of those, printed *after* the news | mean free money per contract | mean volume traded since the news |
|---|---|---|---|---|
| +1 min | **145 (3.9%)** | 106 | **7.03c** (5.13c on the fresh ones) | 135 contracts |
| +2 min | 6 (0.2%) | 6 | 1.09c | 1,175 |
| +5 min and beyond | 0 | | | |

**B2 — after the starter is replaced, every rung above his final total is certain
NO.** 4,816 such contracts.

| delay after the replacement threw his first pitch | still had a positive bid | printed after the news | mean free money per contract |
|---|---|---|---|
| +1 min | **34 (0.7%)** | 17 | **15.76c** |
| +2 min | 21 (0.4%) | 16 | 11.01c |
| +5 min and beyond | 0 | | |

Every one of these is profitable by construction — the outcome is already
decided — so "100% profitable" is arithmetic, not evidence. What matters is the
size of the prize. Summed over the whole discovery window: **1,019c on B1 and
536c on B2, about $15.55 across 47 days at one contract per opportunity**, from
roughly 180 opportunities, about **3.8 a day**, each open for **less than two
minutes**. The mean B1 opportunity pays 7c on a contract costing about 93c; the
mean B2 opportunity pays 16c on one costing about 84c.

The market prices a certainty within about ninety seconds of the play. There is
real volume in that window — a mean of 135 contracts traded in the minute after
the strikeout — so this is not a one-lot curiosity. But it is a latency race
against whoever else is reading the same feed, for a prize of a few dollars a day
at twenty contracts a clip, and it needs a live play-by-play listener and an
order on the wire inside a minute.

## Family C — price-level bias: both sides lose

The classic longshot bias is not there. Worse, **both sides of every bucket lose**
— which is what a spread is.

| bucket | bet against the tail | n | ROI [95%] | bet on the tail (reference arm) | ROI [95%] |
|---|---|---|---|---|---|
| 1–5c | buy NO | 13,822 | **−0.85% [−1.16, −0.56]** | buy YES | −26.74% [−33.58, −19.69] |
| 6–10c | buy NO | 23,640 | **−2.06% [−2.46, −1.65]** | buy YES | −11.67% [−15.66, −7.68] |
| 11–20c | buy NO | 36,461 | **−2.72% [−3.24, −2.22]** | buy YES | −10.95% [−13.41, −8.41] |
| 21–35c | buy NO | 35,558 | **−3.50% [−4.24, −2.78]** | buy YES | −8.82% [−10.61, −6.90] |
| 36–64c | buy NO | 33,734 | **−5.45% [−6.75, −4.12]** | buy YES | −5.40% [−6.72, −4.13] |
| 65–79c | buy YES | 10,263 | **−2.81% [−4.16, −1.44]** | buy NO | −9.65% [−12.71, −6.59] |
| 80–89c | buy YES | 1,777 | −1.54% [−3.54, 0.50] | buy NO | −10.15% [−20.62, 0.28] |
| 90–94c | buy YES | 924 | −0.97% [−3.01, 0.94] | buy NO | −15.61% [−34.18, 4.53] |
| 95–99c | buy YES | 498 | −1.28% [−3.31, 0.54] | buy NO | −13.53% [−51.89, 29.05] |

C1 through C6 survive Bonferroni at p ≤ 0.0002, all on the losing side. The
pre-registration called each bucket "two-sided", meaning a significant loss would
be a discovery pointing the other way. **That was wrong, and the reference arm is
here to show why**: in a market with a bid and an ask the two sides do not sum to
zero, they sum to minus the spread and minus two fees, so both sides can lose and
here both sides do. The cheapest contracts are the clearest case — buying the
1–5c longshot loses 26.7% of stake while selling it loses 0.85%, and the gap
between those two numbers is the vig, not a bias.

## Family D — price path: paying the spread twice

| test | n | ROI [95%] | p |
|---|---|---|---|
| D1 buy at the ask 6h out, sell at the bid at first pitch | 43,526 | **−9.75% [−9.90, −9.61]** | 0.0002 |
| D2 fade a ≥5c hourly move for one hour | 3,562 | **−17.01% [−20.08, −13.86]** | 0.0002 |
| D3 Family C rule on markets listed >24h out | 10,043 | −2.14% [−3.68, −0.58] | 0.0080 |
| D3b same rule on same-day listings (reference) | 146,634 | −2.99% [−3.43, −2.56] | 0.0002 |

D1 is the sharpest number in the study and it is the answer to hypothesis 4 of
the brief. Round-tripping a contract from six hours out to first pitch, with no
view at all, costs **3.66c per contract**. That is the toll on any strategy that
tries to predict the close rather than the outcome: **you have to beat the
closing mid by nearly four cents before you break even**, and
`docs/KALSHI-BACKTEST.md` already measured the model's closing-line value at
about 0c. Predicting the price instead of the game does not make the problem
easier; it makes the hurdle explicit.

D2 answers hypothesis 5: prices do not over-react. Fading a 5c hourly move loses
9.94c a contract, which is the spread plus the fact that the move was mostly
information.

D3 against D3b answers the early-listing question: markets listed more than a day
ahead are neither better nor worse than same-day listings once the spread is paid
(−2.14% against −2.99%, intervals overlapping).

## Family E — mechanics

**E1, scalar settlements, is where the one unexplored door is.** 4,506 markets
across seven series settled `scalar` — a cancelled player — far more than the 271
the earlier pitcher study saw, because batter props get cancelled whenever the
player does not appear. Their settlement value lands **5.14c above the last mid**
on average (n = 3,073; median absolute error 4c, 90th percentile 17c). Selling
them is therefore expensive: buying NO at the ask on every market that settled
scalar returns **−14.85% [−16.00, −13.76]**.

Read the sign, and then read the caveat. The positive side would be *buying*
these contracts, and **the rule as pre-registered is not implementable**: it
conditions on the market having settled scalar, which is not knowable at T−1h. It
is a look-ahead rule, and it is reported here only because it was pre-registered.
The implementable version — detect the scratch from a posted lineup, then trade —
needs the lineup-posting timestamps this study did not collect. That is the
honest gap, and the verdict returns to it.

**E2, doubleheaders**: the Family C rule on doubleheader legs returns −0.92%
[−3.64, +1.77] on 1,662 trades over 94 games. No different from anything else.

## Multiplicity

26 pre-registered tests. Fourteen produce an ROI and a game-cluster bootstrap
p-value; the ten Family A tests and the two Family B tests are judged by their
own rules and enter Benjamini-Hochberg at p = 1, which keeps the denominator at
26 and makes the correction stricter for the rest, not looser.

- **Benjamini-Hochberg at q = 0.10 survivors: C1, C2, C3, C4, C5, C6, D1, D2, D3, E1.**
- **Bonferroni at 0.05/26 = 0.0019 survivors:** C1–C6, D1, D2, E1.
- **Survivors with a positive ROI: none.**

Every corrected survivor is a measurement of the cost of trading. Not one
pre-registered rule has a positive point estimate, so **no rule reaches condition
2 of the pass/fail test and nothing is eligible to be confirmed on the holdout.**
The holdout is used below for what it is still good for: checking that the two
things this window did say — that the book is never internally inconsistent, and
that a certainty stays mispriced for about a minute — say the same thing again.

---

# Confirmation (2026-09-02 .. 2026-09-22, read once)

No rule was eligible under condition 2 of the pass/fail test, because no rule had
a positive point estimate. The holdout is therefore used for the two questions it
can still answer: does the book stay internally consistent, and does the
box-score lag replicate?

## Family A — two violations in the whole holdout, worth about half a cent each

| | discovery | confirmation |
|---|---|---|
| ladder-hours | 198,727 | 156,562 |
| simultaneous nested pairs | 1,290,284 | 761,742 |
| exactly locked | 5 | 11 |
| crossed but the fee ate it | 5 | 0 |
| **riskless violations** | **0** | **5 snapshots / 2 distinct** |

The five confirmation-window snapshots are two mispricings, each standing for a
few hours, both on 2026-09-16, both on the deep end of a game-total ladder:

| game | buy | at | sell | at | gross | **net after both fees** | hours it stood |
|---|---|---|---|---|---|---|---|
| PHI@WSH | Over 1.5 runs | 96c | Over 2.5 runs | 97c | 1c | **+0.53c** | 3 |
| BOS@TEX | Over 1.5 runs | 95c | Over 2.5 runs | 96c | 1c | **+0.40c** | 2 |

That is the entire arbitrage yield of the exchange's MLB book over 68 days and
2,052,026 nested pairs: **two opportunities, about half a cent each on 99c of
capital, roughly 0.5% for a few hours of tied-up money.** Under the
pre-registered Family A rule the family fails: violations are not repeatable —
zero in the discovery window, two in the holdout — and they are not material.

One thing the holdout does settle in the method's favour: both violations
persisted for **two to three consecutive hourly snapshots**. The worry that an
hourly scan is blind to real inconsistencies is therefore weaker than it looked —
when one does happen, it sits there for hours. Sub-hour flickers remain invisible.

## Family B — the box-score lag replicates, at the same rate and the same size

| | discovery (47 days) | confirmation (21 days) |
|---|---|---|
| B1 certain-YES contracts | 3,706 | 1,630 |
| still buyable one minute after the strikeout | 145 (**3.9%**) | 54 (**3.3%**) |
| of those, book printed after the news | 106 | 38 |
| mean free money per contract | **7.03c** | **7.49c** |
| total at one contract | 1,019c | 405c |
| still buyable at two minutes | 6 | 1 |
| B2 certain-NO contracts | 4,816 | 1,981 |
| still sellable one minute after the change | 34 (**0.7%**) | 8 (**0.4%**) |
| mean free money per contract | **15.76c** | **18.37c** |
| total at one contract | 536c | 147c |

Both the hit rate and the size replicate. Over the full 68 days: **241
opportunities, about 3.5 a day, $21.07 total at one contract each.**

And the shape of it is the point. At one minute the edge is there; at two minutes
it is gone — 7 of 241 opportunities survive to the two-minute mark. **The whole
thing lives inside a window of about sixty to ninety seconds.**

# Verdict

**There is no rule here that makes money after costs, with one exception that is
real, riskless, replicated, and worth about $21 a season at one contract.**

What was tested and what it returned:

| | hypothesis | result |
|---|---|---|
| A1–A8 | ladder arbitrage, eight series | **dead.** 0 violations in 1.29M discovery pairs; 2 in the holdout worth 0.5c each |
| A9 | moneyline sums to 100 | **dead.** 5 near-misses in 9,357 pairs, fees larger than every gap |
| A10 | moneyline against run line | **dead.** 0 in 55,993 pairs |
| B1 | price lags a recorded strikeout | **REAL.** 3.9% / 3.3% of certainties buyable at +1 min, 7.0c / 7.5c each |
| B2 | price lags a pitching change | **REAL but thin.** 0.7% / 0.4% at +1 min, 15.8c / 18.4c each |
| C1–C9 | price-level bias, both sides | **dead.** Every bucket loses on both sides; six survive Bonferroni, all negative |
| D1 | beat the closing mid | **dead, and it raises the bar.** A 6-hour round trip costs 3.66c a contract |
| D2 | over-reaction and reversion | **dead.** −17.0% / −16.3% |
| D3 | early listings mispriced | **dead.** −2.1% against −3.0% for same-day, overlapping |
| E1 | scalar settlement predictable | **look-ahead, not implementable.** Settles 5.1c above the last mid |
| E2 | doubleheaders mispriced | **dead.** −0.9% / −1.4%, intervals spanning zero |

26 pre-registered tests, Benjamini-Hochberg at q = 0.10 over all of them. Ten
survived. **All ten are negative**, and every one of them is a measurement of the
spread and the fee rather than a property of anybody's forecast. Nothing reached
the confirmation stage on merit.

## The one rule, stated exactly

> Listen to the MLB StatsAPI play feed. When a starting pitcher records his *s*-th
> strikeout, buy YES on his "s+ strikeouts" contract at any ask below 100 within
> sixty seconds. When a reliever throws his first pitch, sell YES on every rung
> above the departing starter's final strikeout total, at any bid above 1c, within
> sixty seconds.

- **Does it make money after costs?** Yes, necessarily. The outcome is already
  determined when the order goes in, so there is no variance to interval: the only
  uncertainty is whether the order fills.
- **How large?** 7.0c a contract on B1 (discovery) and 7.5c (confirmation);
  15.8c and 18.4c on B2. As a return on the capital each trade ties up, that is
  about **7.5% on B1** (about 93c paid for a certain 100c) and about **19% on B2**.
- **How often?** 241 opportunities in 68 days — **about 3.5 a day**, and only
  0.7% to 3.9% of the moments when a contract becomes certain.
- **What is the interval?** There is no sampling interval on the profit of a
  single fill, because it is arithmetic. The interval that matters is on the rate:
  3.9% of certainties in the discovery window, 3.3% in the confirmation window,
  which agree.
- **What is the whole prize?** **$21.07 over 68 days at one contract.** Mean
  volume traded in the minute after a strikeout is 135 contracts, so size is not
  obviously capped at one; at twenty contracts a clip this is roughly **$6 a day**,
  and that figure assumes every opportunity is taken and every order fills.

## What would have to be true for this to be worth building

1. **Sub-minute reaction.** At two minutes the edge is gone: 7 opportunities out
   of 241 survive that long. This is a latency race, not a research problem.
2. **Depth that is really there.** Candles show volume, not the size resting at
   the top of book. The 7c on a 145-contract sample could be 7c on one lot.
3. **Markets that stay open.** 96% of certainties had no quoted ask a minute
   later at all, which mostly means Kalshi had already closed or fully repriced
   the market. The edge exists only in the 4% of cases where it had not.

None of that is a reason not to try it, and all of it is a reason not to size it.

## The one door left open

`E1` is the only pre-registered test whose sign points somewhere and whose
implementable version was not measured. Cancelled-player markets settle **5.14c
above the last quoted mid**, across 3,073 of them, with a median absolute error
of 4c. The side that pays is buying, and the trade needs to know the scratch
before the market does — which is a lineup-posting timestamp, not a price.
This study did not collect those timestamps. It is the same shape as Family B
(be first to a piece of public news), on a much larger population: **4,506
cancelled markets in 68 days against 241 stale-price moments**. That is where the
next hour of work should go, and it should be pre-registered the same way.

## What this does not say

- It does not say the model is right. `docs/AUDIT.md` still stands.
- It does not say Kalshi is efficient in general — only that on MLB, in this
  68-day window, at hourly resolution, its book is internally consistent and its
  price level carries no exploitable bias at the sizes and speeds tested here.
- It does not test the one thing `docs/AUDIT.md` names as still open: the spread
  between sportsbooks. That needs a multi-book archive, which does not exist yet.

## Caveats

- **68 days.** The live tier serves nothing before 2026-07-17, so this is one
  window in one season, with the confirmation arm only 21 days long.
- **Hourly snapshots in Family A.** Sub-hour inconsistencies are invisible. Both
  violations actually found lasted hours, which is reassuring but not proof.
- **Depth is assumed, never observed.** Every result is one contract at the
  quoted top of book.
- **Family B's clock is StatsAPI's, not the ballpark's.** The strikeout timestamp
  is when the play was recorded, and the pitching-change timestamp is the
  replacement's first pitch — both are later than the moment a person watching
  the game knew. The measured lag is therefore an underestimate of the real
  opportunity and the counts are a lower bound.
- **19 contradictions in 12,152 checks (0.16%)** between StatsAPI's strikeout
  count and Kalshi's settlement. They are excluded from Family B by the
  `result` filter; at that rate they cannot change anything.
- **Taker prices throughout.** `docs/KALSHI-MAKER-STUDY.md` measured what resting
  instead would be worth: 2.66c a contract, filling on the wrong half.

## Reproduce

```
node tools/market-edge.mjs fetch   --kcache ecache
node tools/market-edge.mjs candles --kcache ecache      # ~750 series-days, hourly
node tools/edge-scan.mjs  --kcache ecache --split 2026-09-01 [--confirm] --json out.json
node tools/stale-scan.mjs --kcache ecache --split 2026-09-01 [--confirm] --json b.json
```

Without `--confirm` both scanners refuse to print the holdout. The cache is about
280 MB and is not committed. A cold run takes a few hours, almost all of it
waiting on `GET /markets/candlesticks`.
