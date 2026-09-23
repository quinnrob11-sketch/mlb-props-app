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
| joined to a game and a player | 262,012 |
| no game matched (two dates whose lineups were not cached) | 8,794 |
| name not found on either roster | 2,108 |
| ambiguous name within one game | 0 |
| **player was in the announced lineup → not a candidate** | 257,958 |
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
