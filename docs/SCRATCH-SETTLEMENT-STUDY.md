# The scratched player's cancelled market: is there a trade in it?

`docs/MARKET-EDGE-SEARCH.md` closed with one door open. When a player does not
appear, Kalshi cancels his prop markets and settles them at a "fair market
price" rather than at 0 or 1. Across 3,073 of them that value landed **5.14c
above the last quoted mid**, and there were **4,506 such markets in 68 days** —
about twenty times the population of the only genuinely profitable rule that
study found. But the rule it pre-registered was not implementable: it selected
markets by the fact that they *had been cancelled*, which nobody knows at the
moment of the trade.

This document tests the implementable version. It asks three questions in order:

1. **When does the scratch become public, and how long does the market stay
   open after that?** If Kalshi cancels the moment the lineup posts there is no
   trade, and the answer is no.
2. **Inside that window, is the quote already right?**
3. **If it is not, which side pays, and does it survive the 0.07 fee?**

**Everything from here to the pass/fail rule was written and committed before
any profit-and-loss was computed.** The numbers in Data are counts, clocks and
join rates — the facts needed to pick a split and size the population — plus two
diagnostics about whether the MLB StatsAPI replay can be trusted at all. None of
them is a return.

**One disclosure.** While wiring the diagnostics a helper script imported the
scan module, which at that moment still ran its analysis at import time, and two
of the twelve discovery results scrolled past: the two `fp+60` arms, both
strongly negative. The module now refuses to run unless it is the process entry
point. The rule list below is unchanged from the one already written into
`tools/scratch-scan.mjs` before that happened, and `fp+60` stays in it — dropping
an arm because its result leaked would be the exact bias pre-registration
exists to prevent.

## Data (measured)

| | |
|---|---|
| Source | Kalshi public API, no auth, no order ever placed: `GET /markets?series_ticker=…&status=settled`, `GET /markets/candlesticks`. Plus the public MLB StatsAPI: `/api/v1/schedule`, `/api/v1.1/game/<pk>/feed/live/timestamps`, `/api/v1.1/game/<pk>/feed/live?timecode=…`. **The Odds API is not called.** |
| Cache | `ecache/` in this worktree (not committed). Requests go out one at a time, ≥250 ms apart for Kalshi and ≥120 ms for StatsAPI, with exponential back-off on 429/5xx. |
| Universe | The same **294,589 settled markets** over **68 game dates, 2026-07-17 .. 2026-09-22**, that `docs/MARKET-EDGE-SEARCH.md` used. **272,914** of them are player props (the seven series that can be cancelled); the four game-level series never settle `scalar`. |
| Cancelled | **4,506 markets settled `scalar`** — KXMLBHRR 1,265, KXMLBTB 1,063, KXMLBHIT 845, KXMLBRBI 556, KXMLBHR 504, KXMLBKS 250, KXMLBOUTS 23. That is **68.3 a day**, on about **4 scratched players a day**. |
| Prices | **1-minute** candles, not hourly, over first pitch −5h to +6h, for every market in the tested universe. The close of a 1-minute candle is the top of book at that minute; a yes bid of 0 or a yes ask of 100 counts as no quote. |

### The clock: when was the lineup provably public?

MLB's game feed can be replayed. `feed/live/timestamps` lists every timecode the
feed was written at, and `feed/live?timecode=<t>` returns the feed's state as of
that timecode. The **first** timecode is therefore the earliest moment this
study can *prove* the announced lineup was public — it may have been on a beat
writer's feed earlier, which only makes the window measured here a lower bound.

Two checks that the replay is real rather than backfilled, on the first 400
games cached:

- The announced batting order at the first timecode **differs from the final
  boxscore order in 320 of 400 games** (80%). A backfilled snapshot would match.
- All 400 games already had a complete 18-batter announced lineup at their first
  timecode, so the archive begins at or after the lineup is published, never
  before it.

Measured on those 400 games, the lineup was provably public a median of
**184 minutes before first pitch** (min 35, p10 118, p25 156, p75 209, p90 226,
max 282).

### The other end: when does Kalshi close the market?

Of the 4,506 cancelled markets, **not one closed before first pitch.**

| close time − first pitch | p5 | p25 | median | p75 | p95 |
|---|---|---|---|---|---|
| minutes | **+60** | +75 | **+100** | +145 | +310 |

So the market on a player everybody already knows is not playing stays listed
for at least an hour, and usually well over an hour, *after the game has
started*. The gap between the news and the cancellation is measured in hours,
not seconds. **Whatever kills this, it will not be latency.**

### The trigger, and whether it is honest

The trigger is: *the player named in this contract is not in the starting lineup
StatsAPI has already published for his game.* It never looks at how the market
settled.

Joining Kalshi's 272,914 player-prop markets to StatsAPI by (date, team pair,
doubleheader number) and then by normalised player name:

| | markets |
|---|---|
| player props in the window | 272,914 |
| joined to a game and a player | 270,760 (99.2%) |
| no game matched | 0 |
| name not found on either roster | 2,154 |
| ambiguous name within one game | 0 |
| **player was in the announced lineup → not a candidate** | 266,706 |
| **player absent from the announced lineup → candidate** | **4,054** |

And the fact that decides whether the look-ahead problem is real:

> **All 4,054 candidates settled `scalar`. Every one. Zero exceptions.**

Selecting on "absent from the announced lineup" and selecting on "was
cancelled" pick out the same set here, with no false positives, so the
implementable rule loses nothing to the look-ahead one. Going the other way, the
trigger catches **4,054 of 4,506 cancelled markets (90.0%)**; of the 452 it
misses, 403 are name-join failures and only **49** are players who *were* in the
announced lineup and were scratched later. Late scratches are 1.1% of the
population and this study does not chase them.

## The split, fixed before anything was computed

- **Discovery: game date ≤ 2026-09-01.**
- **Confirmation: 2026-09-02 .. 2026-09-22**, looked at **once**, after the
  discovery pass is written down.

## The rules

Twelve tests: six entry times × two directions. Stated once, in full:

> At time **T**, for every Kalshi player-prop market that is still open and whose
> player is **not** in the starting lineup the MLB StatsAPI had already
> published for his game, buy **one contract** at the then-quoted taker price
> and hold it to Kalshi's settlement.

The six entry times, each clamped so the rule can never trade before the news:

| id | T |
|---|---|
| `news` | the wall clock of the first archived StatsAPI timecode for that game — the earliest provably-public moment |
| `fp-60` | `max(news, first pitch − 60 min)` |
| `fp-30` | `max(news, first pitch − 30 min)` |
| `fp+0` | `max(news, first pitch)` |
| `fp+30` | `max(news, first pitch + 30 min)` |
| `fp+60` | `max(news, first pitch + 60 min)` |

The two directions:

- **`yes`** — buy YES at the yes ask. This is the side the 5.14c points at.
- **`no`** — buy NO at the no ask, i.e. `100 − yes bid`. The reference arm.
  `docs/MARKET-EDGE-SEARCH.md` learned the hard way that in a market with a
  spread both sides can lose, and that a significant loss on one side is not a
  discovery pointing the other way unless the other side is actually measured.

Both arms trade the same rows: a row counts only if the quote at T is two-sided
(`yes bid > 0` and `yes ask < 100`) and the market has not closed. Every trade is
a taker crossing the spread; no resting order is assumed, because
`docs/KALSHI-MAKER-STUDY.md` already priced that alternative.

Fees are `0.07·P·(1−P)` per contract, unrounded, charged on entry. There is no
exit leg: everything is held to settlement, so the fee is paid once. P&L per
contract is `payout − price − fee`, with `payout` taken from Kalshi's own
`settlement_value_dollars` — for a cancelled market that is the scalar value, and
for any market that resolved normally it is 100 or 0.

Intervals are **cluster bootstraps over the scratched player-game**
(`gamePk|playerId`), 5,000 resamples, fixed seed: the four or five rungs of one
scratched player are one bet, not five. p-values come from the same bootstrap,
two-sided, floored at 1/5000.

## Multiplicity

Twelve pre-registered tests, all scored. All twelve p-values go into
Benjamini–Hochberg at q = 0.10; the Bonferroni threshold (0.05/12 = 0.0042) is
reported next to it. Nothing that fails BH is called a finding, whatever its
point estimate.

## Pass/fail rule (fixed before any P&L was computed)

A rule is a **finding** only if all of these hold:

1. it survives Benjamini–Hochberg at q = 0.10 across all twelve tests;
2. its ROI is positive at the full 0.07 fee rate, after crossing the spread,
   with a 95% player-game-cluster interval excluding zero **on the discovery
   set**;
3. the same rule, frozen, is positive on the **confirmation** window
   2026-09-02 .. 2026-09-22 — one look, no re-tuning, no re-cut;
4. it fires at least **30 times** in the confirmation window.

And one bar that is not statistical. `docs/MARKET-EDGE-SEARCH.md` found a rule
worth **about $6 a day at twenty contracts**, in a sixty-second window. This
population is twenty times larger and its window is hours long, so if the answer
here is yes it should beat that comfortably. **A finding that clears the
interval but not $6 a day is reported as a finding that does not matter.**

Anything else is **no edge demonstrated**, and that is a result, not a failure.

## Reproduce

```
node tools/market-edge.mjs   fetch      --kcache ecache
node tools/scratch-fetch.mjs lineups    --kcache ecache
node tools/scratch-fetch.mjs mincandles --kcache ecache
node tools/scratch-scan.mjs  candidates --kcache ecache
node tools/scratch-fetch.mjs candcandles --kcache ecache
node tools/scratch-scan.mjs  --kcache ecache --split 2026-09-01 [--confirm] --json out.json
```

Without `--confirm` the scanner refuses to print the holdout.

---

# Discovery results (run 2026-09-23, game dates through 2026-09-01)

**Short answer: the settlement bias is real and the window is enormous, and it
is still not a business. Kalshi cancels these markets three to five hours after
the lineup that condemns them is public, and settles them about four cents above
the mid it was quoting at the time. Two of those four cents are the half-spread
you pay to get in and about one more is the fee. What is left is roughly one
cent a contract, on markets that more than half the time never trade a single
contract in their entire life.**

## The twelve pre-registered tests: all negative

| id | n | player-games | ROI [95%] | p | c/contract | total | BH |
|---|---|---|---|---|---|---|---|
| `news / yes` | 1,391 | 113 | **−1.33% [−3.98, +0.98]** | 0.305 | −0.44c | −$6.11 | — |
| `news / no` | 1,391 | 113 | −11.12% [−12.42, −9.97] | 0.0002 | −8.44c | −$117.43 | yes |
| `fp-60 / yes` | 1,421 | 134 | −4.84% [−7.23, −2.68] | 0.0002 | −1.73c | −$24.62 | yes |
| `fp-60 / no` | 1,421 | 134 | −16.35% [−17.73, −14.99] | 0.0002 | −12.89c | −$183.18 | yes |
| `fp-30 / yes` | 1,384 | 134 | −5.06% [−7.35, −2.98] | 0.0002 | −1.83c | −$25.27 | yes |
| `fp-30 / no` | 1,384 | 134 | −16.79% [−18.19, −15.42] | 0.0002 | −13.26c | −$183.55 | yes |
| `fp+0 / yes` | 1,243 | 134 | −10.29% [−12.94, −7.78] | 0.0002 | −4.03c | −$50.15 | yes |
| `fp+0 / no` | 1,243 | 134 | −20.26% [−22.01, −18.58] | 0.0002 | −16.47c | −$204.67 | yes |
| `fp+30 / yes` | 944 | 131 | −38.95% [−42.25, −35.26] | 0.0002 | −24.50c | −$231.26 | yes |
| `fp+30 / no` | 944 | 131 | −29.07% [−30.73, −27.52] | 0.0002 | −25.24c | −$238.31 | yes |
| `fp+60 / yes` | 916 | 127 | −38.67% [−42.11, −34.92] | 0.0002 | −24.03c | −$220.16 | yes |
| `fp+60 / no` | 916 | 127 | −28.83% [−30.54, −27.20] | 0.0002 | −25.07c | −$229.67 | yes |

Eleven of the twelve survive Benjamini–Hochberg at q = 0.10 and all eleven are
negative. **Not one rule has a positive point estimate, so under condition 2 of
the pass/fail test nothing is eligible to be confirmed.** The single arm whose
interval touches zero, `news / yes`, still points down.

Two things are visible in that table before any explanation.

**The earlier you trade the less you lose, and the gradient is steep.** Buying
YES costs 0.44c a contract at the news, 1.8c an hour before first pitch, 4.0c at
first pitch and 24c half an hour into the game. That is not an edge decaying; it
is the book emptying out.

(Quote availability is a property of the book rather than a return, so it is
counted over all 68 dates.)

| entry | markets still open | two-sided quote | median spread | p90 spread |
|---|---|---|---|---|
| `news` | 4,048 | 2,967 (**73.3%**) | **2c** | 13c |
| `fp-60` | 4,048 | 2,581 (63.8%) | 7c | 51c |
| `fp-30` | 4,048 | 2,484 (61.4%) | 8c | 52c |
| `fp+0` | 4,048 | 2,172 (53.7%) | 13c | 76c |
| `fp+30` | 4,048 | 1,459 (36.0%) | 57c | 95c |
| `fp+60` | 3,815 | 1,380 (36.2%) | 55c | 95c |

The market maker does not reprice the scratch, he withdraws from it. By half an
hour after first pitch the median spread on a doomed contract is 57 cents wide,
and "buy at the ask" means paying whatever is left on the screen.

**And both directions lose, at every clock.** `no` is worse than `yes` in all six
pairs. That is the lesson `docs/MARKET-EDGE-SEARCH.md` paid for in Family C: the
two sides of a quoted market do not sum to zero, they sum to minus the spread
and minus two fees, so a large loss on one side is not evidence for the other.
The reference arm is what lets this study say the `yes` side is the *right* side
rather than merely the less bad one.

## Where the loss actually is: 68 rained-out contracts

The `news / yes` arm loses $6.11 in total. Its worst twelve trades lose $8.22
between them, and every one of them looks like this:

```
2026-07-27 KXMLBRBI-...-CLEGARIAS13-2   bid=7  ask=95  settled=12   quote age 581 min
2026-07-17 KXMLBHIT-...-CLEAHEDGES27-2  bid=2  ask=93  settled=16   quote age 876 min
2026-07-21 KXMLBHIT-...-BALCTROMP38-2   bid=2  ask=93  settled=17   quote age 887 min
```

An ask of 93 against a bid of 2, on a print fourteen hours old. These are
**postponed games**. `status.detailedState` on the games involved reads
`Postponed`: the game was rained out and replayed the next day, so the feed
archive — and with it the only lineup timestamp this study can prove — lands a
day after the scheduled first pitch, long past the last quote anyone made.
Kalshi cancels the props either way, which is why they are in the population.

**68 of the 1,391 quoted discovery rows (4.9%) are postponed games — and all 68
of the window's postponed rows fall in discovery — and they are the entire
loss.** Removing them and nothing else turns `news / yes` from −1.33%
into **+2.65% [+1.77, +3.47]**.

## Three post-hoc arms, labelled as post-hoc

These were written after the discovery pass. They are **not** among the twelve,
they do not enter the multiplicity correction, and the evidence for them is
weaker than for a pre-registered rule by exactly that much.

| id | rule | n | games | ROI [95%] | c/contract | total |
|---|---|---|---|---|---|---|
| `S0` | `news / yes`, excluding postponed games | 1,323 | 102 | +2.65% [+1.77, +3.47] | +0.83c | $11.01 |
| `S1` | `news / yes`, quote less than 60 minutes old | 1,304 | 102 | +2.83% [+2.06, +3.59] | +0.89c | $11.55 |
| `S2` | `S1` and spread ≤ 2c | 904 | 97 | +3.95% [+3.19, +4.67] | +1.14c | $10.34 |

`S1` is the one worth taking seriously, because it is the least fitted of the
three and because it is barely a filter on the data at all: it says *the quote
has to be a live quote*. A candlestick carries the last print forward for ever,
so a market nobody has touched since yesterday still reports an "ask". Anything
reading the real order book gets this for free. It removes every postponed game
as a side effect, which is why `S0` and `S1` agree to within 0.2%.

That the number barely moves across every threshold is the reassuring part:

| variant | n | c/contract | ROI |
|---|---|---|---|
| spread ≤ 1c, age < 60 min | 688 | +1.21c | +4.36% |
| spread ≤ 2c, age < 60 min | 904 | +1.14c | +3.95% |
| spread ≤ 5c, age < 60 min | 1,097 | +1.04c | +3.49% |
| any spread, age < 60 min | 1,304 | +0.89c | +2.83% |
| spread ≤ 2c, age < 5 min | 524 | +1.00c | +3.56% |
| spread ≤ 2c, age < 120 min | 912 | +1.15c | +3.99% |

Eleven variants were looked at in all. Every one lands between +0.89c and
+1.21c a contract, which is a third of a cent of spread across the whole
sensitivity. This is not a threshold that was found; it is a constant.

## Why it is there, and why it is one cent

The mechanism is a single number, and it is the same one the previous study
found from a different clock.

| measured at the news, excluding postponed games | mean | median |
|---|---|---|
| settlement − **mid** | **+4.25c** | +3.5c |
| settlement − **ask** | **+2.02c** | +2.0c |
| fee on a 28c contract | −1.4c | |

**Kalshi's cancellation price sits about four cents above the mid it was quoting
when the lineup came out.** The prior study measured 5.14c above the mid at
T−1h; measured at the moment the news breaks it is 4.25c. Same effect, and it
is not an artifact of where trading stopped — it is there while the book is
still two-sided and two cents wide.

But two of those four cents are the half-spread you pay to cross, and the fee
takes most of what is left. The bias is real, the direction is real — **buy, do
not sell** — and after costs it is worth about one cent on a contract whose mean
ask is 28c.

And the market never reacts to the news at all:

| paired mid change, excluding postponed games | mean | median |
|---|---|---|
| hour before the lineup → the lineup | −0.87c | 0.0c |
| the lineup → an hour after | −2.09c | 0.0c |

The median quoted mid does not move one cent when the player is publicly ruled
out of the game. **Nobody is racing you.** That is the opposite of the Family B
strikeout trade, and it is why this window is hours rather than ninety seconds:
there is no information in the price to be first to, only a settlement
convention to be on the right side of.

## How big is it, honestly

Over the 47 discovery dates `S1` fires **1,304 times — about 28 a day — for
$11.55 at one contract, which is 25 cents a day.**

To beat the $6-a-day bar it would have to fill about 24 contracts every time. It
cannot:

| depth of the markets `S1` trades (n = 1,304) | |
|---|---|
| never traded a single contract in their whole life | **53.6%** |
| traded 20 or more contracts, ever | 33.9% |
| median volume in the minute of entry | **0** |
| median lifetime volume | **0** |

More than half of these contracts have no trade history whatsoever, and the
median one has no volume in the minute you would be lifting the offer. Candles
show volume, not the size resting at the top of book, so this is not proof that
the offer is one lot — but a market with no lifetime volume at all is not a
market where two dozen contracts are waiting at the touch.

There is a second problem with size, specific to this trade. Kalshi's settlement
here is a "fair market price", and **82% of these markets trade nothing at all
after the news**. If that price is derived from the book or from the last trade,
a large taker order is not collecting a mispricing, it is moving the very
quantity the payout is computed from. At one contract that is negligible. At
twenty it is the whole thesis.

---

# Confirmation (2026-09-02 .. 2026-09-22, read once)

No pre-registered rule reached condition 2 — none had a positive point estimate
— so under the pass/fail rule none was eligible. The holdout is used for what it
can still settle: whether the twelve stay negative, whether the settlement bias
is really there, and whether the one post-hoc variant survives out of sample.

## The twelve: still negative, every one

| id | discovery ROI | **confirmation ROI** | confirmation c/contract |
|---|---|---|---|
| `news / yes` | −1.33% [−3.98, +0.98] | **−1.10% [−3.59, +0.95]** | −0.34c |
| `news / no` | −11.12% | −9.82% [−10.59, −9.08] | −7.56c |
| `fp-60 / yes` | −4.84% | −16.57% [−20.89, −12.08] | −6.60c |
| `fp-60 / no` | −16.35% | −18.78% [−20.32, −17.35] | −15.44c |
| `fp-30 / yes` | −5.06% | −17.27% [−21.59, −12.90] | −6.95c |
| `fp-30 / no` | −16.79% | −19.04% [−20.62, −17.62] | −15.69c |
| `fp+0 / yes` | −10.29% | −32.87% [−37.37, −28.10] | −16.29c |
| `fp+0 / no` | −20.26% | −21.42% [−23.22, −19.76] | −18.19c |
| `fp+30 / yes` | −38.95% | −48.54% [−51.55, −45.44] | −35.90c |
| `fp+30 / no` | −29.07% | −31.12% [−33.67, −28.70] | −27.99c |
| `fp+60 / yes` | −38.67% | −48.26% [−51.48, −44.95] | −35.52c |
| `fp+60 / no` | −28.83% | −31.32% [−33.91, −28.68] | −28.24c |

Twenty-four numbers, all negative, in two independent windows. The shape
replicates too: `news` is much the least bad clock, `yes` beats `no` at all six
clocks, and the damage grows monotonically the longer you wait.

## The bias replicates; one of the three post-hoc arms does too

| measured at the news, live quote only | discovery | **confirmation** |
|---|---|---|
| settlement − mid | +4.25c | **+3.78c** |
| settlement − ask | +2.02c | **+1.09c** |
| median spread at the news | 1c | 3c |
| markets that never traded a contract in their life | 53.6% | 51.0% |

**The four-cent settlement bias is real and it replicates.** What does not
replicate is how much of it you get to keep, because the spread you have to
cross was wider in September.

| post-hoc arm | discovery | **confirmation** | verdict |
|---|---|---|---|
| `S0` excluding postponed games | +2.65% [+1.77, +3.47] | **−1.10% [−3.59, +0.95]** | fails — there were no postponed games in the holdout, so `S0` is just `news / yes` there |
| `S1` live quote only | +2.83% [+2.06, +3.59] | **−0.24% [−1.96, +1.15]**, p = 0.82 | **fails** |
| `S2` live quote and spread ≤ 2c | +3.95% [+3.19, +4.67] | **+2.42% [+1.64, +3.23]**, p = 0.0002 | **replicates** |

`S1` fails for a reason worth stating, because it is the whole economics of this
trade in one line. Split the same rows by spread:

| | discovery | confirmation |
|---|---|---|
| spread ≤ 2c | +1.14c/contract | **+0.78c/contract** |
| spread > 2c | +0.30c/contract | **−0.76c/contract** |

The settlement lands about four cents above the mid. If the book is one or two
cents wide you keep about a cent of that after the fee. If it is wider you pay
the difference away on entry and there is nothing left. That is not a filter
that was fitted to the data; it is arithmetic, and it is why the pre-registered
rule — which had no spread condition — was always going to be a coin flip around
zero.

## What `S2` is actually worth

| `S2` | discovery (44 dates) | confirmation (21 dates) |
|---|---|---|
| trades | 904 | 689 |
| trades per day | 20.5 | **32.8** |
| profit per contract after the 0.07 fee | +1.14c | **+0.78c** |
| total at one contract | $10.34 | **$5.34** |
| **dollars per day at one contract** | **$0.235** | **$0.254** |
| of those markets, never traded a contract in their life | 49.3% | 38.2% |
| of those markets, ever traded 20 contracts | 38.8% | 39.6% |

The per-day figure replicates to within two cents. It is **twenty-five cents a
day at one contract.** Reaching the $6-a-day bar the previous study set needs
about twenty-four contracts on every one of thirty-three trades a day, and fewer
than forty per cent of these markets have traded twenty contracts in their
entire lifetime. At twenty contracts, assuming every single order fills, it is
about **$5 a day** — and that assumption is the one the depth table says is
false.

# Verdict

**There is an implementable rule. It is not a look-ahead. Its direction is
right, its window is hours wide, it fires thirty times a day, and it is worth
twenty-five cents a day. The blocker is not the latency and it is not the
direction — it is that the edge per contract is one cent and the markets are too
thin to buy more than a few.**

## The rule, stated exactly

> Poll the MLB StatsAPI game feed. The moment it serves a starting lineup for a
> game, take every Kalshi player-prop market still open on a player who is not in
> that lineup. If the market has a live two-sided quote no more than two cents
> wide, buy YES at the ask. Hold to Kalshi's settlement.

- **Is it implementable?** Yes. Every input is published before the trade: the
  lineup is on a public endpoint, the quote is on the book. It never conditions
  on the cancellation. In this window it did not have to — **all 4,054 markets
  the trigger selects were cancelled, with no exceptions** — but that is a
  measured property of Kalshi's listings, not an assumption the rule relies on.
- **How often does it fire?** 20.5 times a day in discovery, **32.8 in
  confirmation**, on about four scratched players a day.
- **What does it pay?** **+0.78c a contract** after the 0.07 fee in the holdout
  (+1.14c in discovery), on a contract costing about 28c — a return on capital
  of **+2.42%**.
- **What is the interval?** **[+1.64%, +3.23%]** on the holdout, a 5,000-resample
  bootstrap clustered on the scratched player-game, p = 0.0002. In discovery it
  was [+3.19%, +4.67%].
- **What is the whole prize?** **$0.25 a day at one contract**, $5.34 across the
  21 confirmation days. At twenty contracts, if every order filled, about $5 a
  day — below the $6 a day the last study's strikeout rule was worth, on markets
  where half have never traded a single contract.

## What kills it, precisely

Three candidate blockers were named at the start. Here is which one it was.

**Not the latency.** This is the cleanest negative in the study. The lineup is
provably public a median of **184 minutes before first pitch**; the market does
not close until a median of **100 minutes after** it; and in between, the quoted
mid **does not move** — median change 0.0c in the hour before the lineup and
0.0c in the hour after. Nobody is racing you, because there is no information in
the price to be first to. The window is four to five hours wide. Family B's
strikeout trade lives for ninety seconds; this one lives for an afternoon, and
that difference bought nothing.

**Not the direction.** The 5.14c the previous study measured is real and it
replicates from a different clock: **+4.25c above the mid in discovery, +3.78c
in confirmation**, measured while the book is still two-sided and two cents
wide, so it is not an artifact of where trading stopped. The side that pays is
**buying**, exactly as the sign suggested, and the reference arm proves it —
selling loses 8 to 16 cents a contract at every clock tested.

**It is the population, in the specific sense of what you can get filled.** The
count is fine: 4,054 markets, 68 a day, twenty times Family B. What is not fine
is what sits inside one:

- the four-cent bias is only **one cent** after you cross a two-cent spread and
  pay a 1.4c fee, and it is **nothing at all** once the spread is wider than two
  cents, which is already the median by September;
- **51% to 54% of these markets never trade a single contract in their entire
  life**, and the median one has zero volume in the minute you would be lifting
  the offer;
- **82% trade nothing at all after the lineup is out** (measured on discovery),
  which means a large
  taker order is not collecting Kalshi's fair-value convention so much as
  becoming the quantity that convention is computed from.

An edge of one cent needs size, and this is the one place in the whole Kalshi MLB
book where size is least available.

## Where this leaves the two studies

| | Family B strikeout lag | this |
|---|---|---|
| opportunities a day | 3.5 | **20 to 33** |
| window | **60 to 90 seconds** | 4 to 5 hours |
| profit per contract | 7c to 18c | **0.8c to 1.1c** |
| at one contract | $0.31/day | $0.25/day |
| at twenty contracts | ~$6/day | ~$5/day |
| what stops it | latency | depth |

They are the same size and they fail for opposite reasons. The strikeout trade
has a real edge per contract and sixty seconds to get it. This one has all
afternoon and almost no edge to collect. Neither is a business at one lot, and
neither has been shown to have the depth for twenty.

## Caveats

- **The one rule that replicated is post-hoc.** `S2` was written after the
  discovery pass, its sibling `S1` failed the same holdout, and it does not
  enter the multiplicity correction. It replicating out of sample is real
  evidence and it is weaker evidence than a pre-registered result, and it is
  reported as such.
- **Eleven sensitivity variants were examined on discovery** before `S2` was
  frozen. Every one returned between +0.89c and +1.21c a contract, which is why
  the threshold is not believed to be fitted — but eleven looks are eleven looks.
- **The news clock is a bound, not the moment.** The first archived StatsAPI
  timecode proves the lineup was public by then; a beat writer may have had it
  earlier. That makes the measured window a lower bound and cannot inflate the
  P&L, because trading earlier than the timestamp is never simulated.
- **Depth is inferred from traded volume, never observed.** Candles do not show
  the size resting at the top of book. "Half these markets never traded a
  contract" is evidence about liquidity, not a measurement of the offer.
- **Late scratches are not tested.** 49 cancelled markets (1.1%) were on players
  who *were* in the announced lineup and were pulled afterwards. Catching those
  needs a timecode search per game and is the one part of this population the
  trigger does not reach.
- **2,154 markets (0.8%) failed the name join** and are absent from the
  denominator. The join is by normalised name within one game; zero were
  ambiguous.
- **68 days, one season, 21 days of holdout.** The live tier serves nothing
  before 2026-07-17.
- **Taker prices throughout, one leg, no exit.** Everything is held to
  settlement, so the fee is paid once. `docs/KALSHI-MAKER-STUDY.md` already
  priced the resting-order alternative.

## What this does not say

- It does not say the settlement convention will stay where it is. The whole
  trade is four cents of Kalshi's own arithmetic; a change to how they price a
  cancellation ends it with no warning.
- It does not say the offer is one lot. It says half of these markets have never
  traded, which is the closest public data comes to an answer.
- It does not reopen anything in `docs/AUDIT.md`. No model was used here, and
  none of this bears on whether the model is right.
