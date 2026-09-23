# The paper record

Two things paper-trade on this machine, and they answer different questions.

| | what it records | where |
|---|---|---|
| `bot/run.mjs` | what the Kalshi bot would have ordered, one venue, with fills and fees | `bot/state/journal.ndjson`, read with `node bot/report.mjs` |
| `tools/track.mjs` | every row the BOARD priced, across all books, with closing prices and results | `bot/state/track/<date>.json`, read with `node tools/track.mjs report` |

The bot answers "would trading Kalshi have made money". Since the market
weights dropped to their measured values it plans zero orders, so on its own it
now records nothing but "nothing qualified".

The tracker answers the question that replaced it: **the board now calls a play
only where one book is out of line with the others — does that make money?**
Nobody has measured it, because the board's snapshots only ever went to one
browser's localStorage and did not record how many books priced a row.

## What it stores

Every priced row, not only the ones called as plays, and the inputs rather than
only the verdict: model probability, the de-vigged market consensus, both
sides' best prices, how many books, the book taken, and the closing price.

That last point is the important one. A rule change does not invalidate the
history — any later rule can be replayed over these files offline with no
further API calls. When the weights change again, or the two-book rule becomes
a three-book rule, the whole archive re-grades itself.

## Running it

    powershell -ExecutionPolicy Bypass -File bot\schedule-tracker.ps1

Four runs a day: morning, afternoon and two near first pitch. Each run
snapshots today's board (first write wins, so the entry price is the one the
board first showed), overwrites today's closing prices (the last run before
first pitch is the one that sticks) and grades yesterday against the box
scores. By hand:

    node tools/track.mjs daily
    node tools/track.mjs report --all

Closing prices have to be captured on the day. The schedule proxy returns
nothing for a date once it has passed, so a run that never happened before
first pitch cannot be recovered afterwards. Grading is not affected — it reads
box scores directly and can be re-run at any time.

## Reading it

`report` groups by market, book count, verdict and pitcher/batter, and gives
each category one of four reads:

- **EDGE** — the whole 95% ROI interval sits above zero.
- **AVOID** — the whole interval sits below zero.
- **no signal** — the interval spans zero. This is the correct answer for a
  long time, and it is not a missing feature.
- **N more** — fewer than 25 settled picks, so it cannot say anything yet.

A category needs 25 settled picks and an interval clearing zero; the history
needs 50 before any category is named a leader. The same rules drive the
RESULTS tab on the site, from the same module (`src/analysis/profitability.js`),
so the two cannot disagree.

## Replaying a rule that did not exist yet

    node tools/track.mjs replay [--books=3] [--min=1]

The archive stores the INPUTS — both sides' best prices, the de-vigged
consensus, the book counts — not only what the board decided. So a rule
invented next month can be scored on history recorded before it existed, with
no further API calls. Any row with a graded `actual` can be scored on either
side, because over wins exactly when the actual clears the line.

Today this replays the price-shopping rule, which is the one idea five studies
did not kill and the one with no measured track record at all. It shares
`src/analysis/shop.js` with the SHOP tab, so the replay and the live board run
the same code rather than two versions of it.

Verified against a synthetic day with known outcomes: three qualifying bets,
one excluded for having only two books, 2-1, +0.82 units.

## Seeing it in the app

    node tools/track.mjs export

writes `bot/state/track-export.json` in the envelope the RESULTS tab's IMPORT
JSON button reads, holding the rows the board actually called. The disk record
and the in-app breakdown are then the same history rather than two rival ones —
they already share the module that computes it.

## Checking the grading

    node tools/track.mjs selftest

Grades five props whose answers are known from a real box score (2026-09-20
PHI @ NYM: Lindor 0 hits, Tong 5 K and 14 outs) and asserts each result. It is
not part of `npm test` because it needs the network. It exists because a silent
mis-grade corrupts the record permanently, and because an early version of this
tool did exactly that — it matched results back to rows by a key that left out
the side, so an over and an under on the same line collided and both took the
second one's result. Run it after any change to the grading path.

## Cost

Every run reads the board through the production deployment, so it reuses that
CDN cache and the Odds API key in Vercel's environment rather than spending
fresh credits per run. Nothing here needs a key on this machine, and nothing
here places an order.
