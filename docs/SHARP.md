# Sharp action

`tools/sharp.mjs` — see and tail the closest thing to sharp action this data
supports. Rule in `src/analysis/sharp.js`, pinned by `test/sharp.test.js`.

    node tools/sharp.mjs [YYYY-MM-DD] [--min 1] [--all]   scan the live board
    node tools/sharp.mjs moves [--min 1] [--all]          open -> close, from the archive
    node tools/track.mjs replay --rule=both                score it against the shop rule

## First: what "sharp action" cannot mean here

The phrase normally means **handle**. Money percentage, ticket percentage, and
the reverse line movement you get when the two disagree — 70% of tickets on the
favourite while the line moves toward the dog, so the 30% must be carrying the
money.

**This project cannot compute any of that, at all.** Handle and ticket counts
are sold by services it does not subscribe to (Sports Insights, Action Network,
BetLabs and the rest). They appear in no endpoint it calls. The Odds API returns
prices; it does not return money. Without the two percentages, reverse line
movement is not approximated badly — it is not defined. Anything in this repo
claiming to show it would be fabricating it, and nothing here does.

Three other things are genuinely unavailable and worth naming so nobody goes
looking:

- **Limits.** Pinnacle's max bet would tell you how much it believes its own
  number. Not in the feed.
- **Steam.** Several books moving within seconds of each other is the classic
  tell. The feed gives one snapshot per request and drops the per-bookmaker
  `last_update` before it reaches any row here (`src/lib/markets.js` never reads
  it), so the tightest resolution available is the gap between two of our own
  snapshots.
- **Who moved first.** Same reason.

## What is left, and why it is not nothing

**Pinnacle.** Lowest margin, highest limits, no bettor limiting — it makes its
money on volume and corrects on money rather than on opinion, which is why the
rest of the market watches its number. The repo already treats it as the
reference: `src/lib/venues.js` carries it and `consensusFair` weights it 3x and
raises `sharp` when it contributes. **A soft book still sitting on a price
Pinnacle has already left is the most defensible "you are on the side the money
is on" signal these feeds support.** It is a claim about two prices, not about
anyone's handle, and that is exactly why it can be measured.

**Line movement.** `tools/track.mjs` writes the opening price on the first
snapshot of the day and overwrites the close on every later run, so every
archived row brackets the day. `sharp.mjs moves` reports it.

**Kalshi.** A real-money exchange with no vig to strip, so its midpoint is an
independent second opinion rather than a fourth sportsbook. It reaches rows
through `row.venues` and is in the price table like any other venue.

## The rule

For every row that carries a two-sided Pinnacle price:

1. De-vig Pinnacle's pair, and de-vig every other book's pair, independently.
   A book with a 9% hold must not read as disagreeing with one that holds 4%.
2. The lagging side is the one Pinnacle prices higher than that book does. The
   gap is symmetric, so exactly one side is implied per (row, book).
3. `GAP` is that difference in probability points, after the vig. `EV` is the
   same comparison taken to the soft book's *posted* price, treating Pinnacle's
   de-vigged number as true — the rule's assumption written as a number, not a
   claim that it holds.
4. Rank by gap.

**No projection is consulted anywhere**, exactly as in `src/analysis/shop.js`.
`test/sharp.test.js` pins this the same way `test/shop.test.js` does: two rows
with identical prices and opposite model opinions must produce identical output.

`HELD` is the only staleness this data can express. Since the feed's
`last_update` is discarded upstream, "how long has this book shown this price"
can only be answered against **our own** earlier snapshot of the same day: it
reads `bot/state/track/<date>.json` and reports minutes since `openedAt` when
the book's pair is byte-identical to the opening one. A `-` means it moved
since open, or that nothing was snapshotted yet. Two snapshots a day makes this
coarse; more snapshots makes it finer, and nothing else can.

## What it found on a real board

`node tools/sharp.mjs 2026-09-26 --all`, run late on 2026-09-25 ET (the 09-25
board is 16-of-17 final and returns nothing loadable, so 09-26 is the live one):

    2026-09-26: 13 games, 2288 rows priced | odds ok
    21 row(s) carry a two-sided PIN price — only those can be scanned at all.
    12 soft-book price(s) at least 1 de-vigged point(s) off PIN.

     GAP     EV     BOOK   PRICE     PIN   THIS BOOK  HELD  PLAY
     2.2pt  -0.9%  FD       106   48.1%      45.9%    2m  LAD @ SF — Over 7.5 runs
     1.9pt  -1.6%  FD       104   48.2%      46.3%    2m  NYM @ WSH — Over 8.5 runs
     1.8pt  -1.6%  FD       136   41.7%      39.9%    2m  CLE @ KC — Guardians -1.5
     1.6pt  -0.5%  FD      -122   54.7%      53.0%    2m  CLE @ KC — Guardians win
     1.5pt  -2.0%  FD       125   43.5%      42.1%    2m  STL @ MIL — Brewers -1.5
     1.4pt  -1.8%  FD      -110   51.4%      50.0%    2m  LAA @ SEA — Over 7.5 runs
     1.4pt  -2.4%  FD       100   48.8%      47.5%    2m  STL @ MIL — Under 7.5 runs
     1.2pt   1.4%  NVG     -117   54.7%      53.5%    2m  CLE @ KC — Guardians win
     1.1pt  -2.4%  FD       100   48.8%      47.7%    2m  COL @ CWS — White Sox -1.5
     1.1pt  -3.2%  MGM      115   45.0%      43.9%    2m  NYM @ WSH — Nationals win
     1.0pt  -4.0%  MGM      165   36.2%      35.2%    2m  LAA @ SEA — Angels win
     1.0pt  -3.5%  FD       136   40.9%      39.9%    2m  CIN @ TOR — Blue Jays -1.5

Three things in that output matter more than the twelve rows.

**Pinnacle quotes 21 of 2,288 rows, and all 21 are game lines.** Not one player
prop on the whole board carries a Pinnacle price — measured, not assumed: across
the 578 rows that list any venue at all, the venue tally is DraftKings, FanDuel,
Novig, PrizePicks, Pick6 and Kalshi, and Pinnacle appears zero times. So on this
feed the sharp rule is a **game-lines rule**. It is not a prop rule and there is
no honest way to make it one. If Pinnacle props ever appear, the scanner picks
them up with no change.

**Eleven of the twelve gaps are negative EV.** A 1-2 point lag does not cover a
soft book's 4-5% hold. Read plainly: the gaps are real and they are mostly too
small to bet. The one positive is Novig at +1.4%, which is an *exchange*, not a
soft book — there is no vig there to beat, which is most of why it clears. The
comparison set on game lines is whatever `parseGameOdds` admits, and that
includes Novig; a gap against an exchange means something different from a gap
against FanDuel and should not be read as the same signal.

**FanDuel is on nine of the twelve.** One book against one book, twelve times,
is not twelve independent observations.

## Line movement

`node tools/sharp.mjs moves` reads the archive and reports, per row, the change
in the de-vigged consensus from open to close and which side it favoured.
De-vigged on purpose: a book going -110/-110 to -105/-115 has moved, and a book
widening both sides has only raised its hold, and the raw price cannot tell
those apart.

**With three days of data this proves nothing, and the tool says so in its own
output.** Whether the closing line is where the truth ends up is a question that
needs months of graded rows. It is built now so that it is correct when there
is enough of it — the same reason the archive change below could not wait.

## The archive change, and what it costs

The archive stored only the best over/under price and a book count. Per-book
prices were thrown away, so **no Pinnacle-versus-a-soft-book rule could ever have
been replayed against it** — the same gap `nBooksTwoSided` had in September, and
it is closed the same way: before the history accumulates, not after.

`tools/track.mjs` now stores, per row, every venue's two-sided price at open and
again at close:

    "books":      { "FD": [116, -136], "DK": [110, -133], "PIN": [116, -128], "NVG": [120, -122] },
    "closeBooks": { "FD": [116, -136], "DK": [110, -133], "PIN": [116, -128], "NVG": [120, -122] }

Two integers per venue, no labels repeated, one-sided quotes and DFS
multipliers dropped because neither can be de-vigged.

Game lines needed one more thing: `priceTeamMarkets` keeps the best price and
the list of book *names* and discards the per-book prices, and that module is
out of scope to change. `gameLineBooks` in `tools/sharp.mjs` therefore re-reads
the single bulk game-odds response the slate load already fetched — same URL,
same CDN cache entry on the production deployment, no fresh API credits — and
parses it with the repo's own `parseGameOdds` rather than a second copy of it.
First-five markets are deliberately excluded: they come from a per-event
endpoint (one request each) and only two books quote them.

**Disk cost, measured on the 2026-09-26 board** (13 games, 641 priced rows, 511
stored book quotes at open and 511 at close):

| | bytes |
|---|---|
| day file without per-book prices | 470,751 |
| day file with them, open and close | 538,276 |
| **cost** | **+67,525 (+14.3%)** |

That is **about 66 bytes per stored book quote**, and the day file is written
with `JSON.stringify(day, null, 1)`, so most of those 66 bytes are indentation.
Scaling honestly: a fully covered board — 2,000 priced rows with five books each
— would store 10,000 quotes at open and again at close, about **1.3 MB a day**
on top of a file that would itself be near 3 MB. A full season of that is a few
hundred megabytes on a local disk, which is fine. If it ever stops being fine,
writing the day file compactly rather than indented roughly halves the whole
archive and needs no format change.

## What would falsify it

The shop rule (`src/analysis/shop.js`) and this one are cousins. They differ in
one line and one idea:

| | reference price | breadth |
|---|---|---|
| **shop** | de-vigged consensus of 3+ books at the line | wide: fires on any row with enough books |
| **sharp** | Pinnacle alone, de-vigged | narrow: fires only where Pinnacle quotes |

The honest question is whether "lagging Pinnacle" beats "out of line with the
consensus of three books", and the honest answer today is **nobody knows**.
Neither rule has a graded record. The point of the archive change is that the
question gets an answer rather than an argument.

**How the comparison will be made.** One command:

    node tools/track.mjs replay --rule=both

Both rules are replayed over exactly the same graded rows, held to **the same EV
threshold** (`--min`, EV percent, for both — gap points and EV percent are
different units and comparing "1" of each would compare two different
questions), and settled by exactly the same code. `--rule=shop` and
`--rule=sharp` run either alone.

**The rule that would be falsified, stated before the data exists:**

- **Sharp loses** if, on rows where both rules fire, sharp's ROI interval is not
  above shop's — i.e. Pinnacle adds nothing over the three-book consensus, which
  is the null and the most likely outcome.
- **Sharp is useless regardless of ROI** if it keeps firing on 21 rows out of
  2,288. A rule that cannot find bets is not a rule, and the coverage number
  above is the first thing to check each day.
- **Both lose** if neither ROI interval clears zero after `MIN_HISTORY` settled
  rows. That is the default expectation given `docs/AUDIT.md`, and it is the
  result this harness exists to be able to report.

**What counts as enough.** The same bar `src/analysis/profitability.js` already
enforces on everything else: 25 settled picks before a category says anything,
50 before any leader is named, and a 95% ROI interval clearing zero before the
word EDGE is used. At twelve candidate rows a day and a threshold that most of
them fail, the sharp rule will reach 25 settled bets slowly. That is a fact
about the signal, not a defect in the harness.

A bug found while wiring this up, worth recording because it would have made
the comparison meaningless: the replay settled every row against `row.line`,
but `src/data/gradeSlate.js` settles a game moneyline or run line against
`-row.line` (the home side covers when the margin exceeds `-line`). Every
non-zero game line would have graded backwards. Invisible while the only rule
being replayed fired on player props; not invisible at all now that the sharp
rule fires almost exclusively on game lines. `tools/track.mjs` now carries the
same `settleLine` as the grader.

## Related

- `docs/PAPER-RECORD.md` — what the archive is and how it is run.
- `docs/AUDIT.md` — why every rule here is model-free.
- `src/analysis/shop.js` — the cousin rule.
