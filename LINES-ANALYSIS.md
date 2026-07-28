# Line attachment — how odds reach a player, and where that goes wrong

Scope: `parseEventOdds` (`lh`, app.js:793), `bestQuote` (`gl`, app.js:823),
`attachLines` (`ba`, app.js:855), plus the identity layer in `normalizeName`
(`Ri`, app.js:622). Reconstructed as `src/model/lines.js` and `src/lib/names.js`.

**Report only. Nothing below has been fixed.**

Every claim here was checked by running the *original* minified functions
extracted from `app.js`, not the reconstruction. The reconstruction was
separately differential-tested against the originals over 68,000 randomised
inputs (40k `evaluateEdge`, 20k `bestQuote`, 8k `attachLines`, including
`undefined` points, null prices and alternate ladders) — **0 mismatches**.

---

## 1. How an odds-feed name is matched to an MLB stats record

### The mechanism

There is no matching algorithm. There is a **string key**.

`parseEventOdds` files every outcome under `normalizeName(outcome.description)`:

```js
const playerKey =
  market.key === GAME_MARKET ? GAME_KEY : normalizeName(outcome.description);
const quotes = byPlayer[playerKey] || (byPlayer[playerKey] = []);
```

`loadSlate` then asks for a player's rows by the same function applied to the
MLB roster's `fullName` (app.js:1186 and app.js:1298):

```js
attachLines(PITCHER_MARKETS, normalizeName(probablePitcher.fullName), eventOdds, proj, smallSample)
attachLines(BATTER_MARKETS,  normalizeName(lineupPlayer.fullName),   eventOdds, proj, smallSample)
```

and `attachLines` does a plain property lookup:

```js
const base = odds[marketKey]?.[playerKey] || [];
```

So the join is **exact equality of two independently normalised full-name
strings**. Not surname, not fuzzy, not Levenshtein, not id-based. `normalizeName`
is the entire reconciliation layer:

```js
return (name || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")   // Peña -> Pena
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\.?$/g, "")  // Acuña Jr. -> acuna
  .replace(/[^a-z ]/g, "")                  // O'Neill -> oneill
  .replace(/\s+/g, " ").trim();
```

Verified output:

| input | key |
|---|---|
| `Will Smith` | `will smith` |
| `Ronald Acuña Jr.` | `ronald acuna` |
| `Michael A. Taylor` | `michael a taylor` |
| `Michael Taylor` | `michael taylor` |
| `W. Smith` | `w smith` |
| `Smith, Will` | `smith will` |

> **Glossary correction.** The glossary maps `Zp` to `nameMatches`. `Zp`
> (app.js:632) is a generic array chunker used to batch person-ids 35 at a time
> in `fetchPlayerStats`; it contains no name logic. It is reconstructed as
> `chunk`. **There is no `nameMatches` function anywhere in the bundle** — which
> is itself the finding: nothing beyond exact key equality exists.

### On collision

The premise of the question ("two players sharing a surname") does not fire,
because the key is the *full* name. Two players sharing a surname get distinct
keys (`aaron judge` vs `will judge`) and never interact.

What *does* fire is an **exact full-name collision**, which MLB has in every
season (two Will Smiths, two Luis Ortizes, two Logan Allens). The failure is
silent and total. Running the original `parseEventOdds` on an event where two
different "Will Smith" entries are priced:

```
parsed batter_hits keys: [ 'will smith' ]
quotes under "will smith": [
  {"book":"DK","point":0.5,"over":-180,"under":145,"w":1},
  {"book":"DK","point":1.5,"over":260,"under":-340,"w":1},
  {"book":"FD","point":1.5,"over":255,"under":-330,"w":1}]
```

The two players' quotes are **concatenated into one array**, and `attachLines`
returns the *same* rows for both:

```
rows for EITHER Will Smith:
  {"alt":false,"line":1.5,"over":260,"under":-330,"nBooks":2}
  {"alt":true, "line":0.5,"over":-180,"under":145,"nBooks":1}
```

Consequences:
- The catcher's projection is priced against a merged pool that includes the
  reliever's line, and vice versa. Both cards look plausible; both are wrong.
- The two players' points now compete in `bestQuote`'s modal vote, so the *line*
  shown can belong to the other player entirely.
- Nothing flags it. `nBooks` looks healthy (2), the verdict engine runs normally.

The same bucket also absorbs any outcome with **no `description`**, since
`normalizeName(undefined)` returns `""` and `""` is a perfectly good object key.
Two description-less outcomes from different books in the same market merge
under `""`. (No player can ever collide with the team-market sentinel
`__game__`, because `normalizeName` strips underscores — that one is safe.)

### On no match

A name the two feeds spell differently — middle initial on one side only
(`Luis L. Ortiz` vs `Luis Ortiz`), `Last, First` ordering, a nickname, a
transliteration difference, or a trailing-space suffix that defeats the
`$`-anchored suffix strip — produces **no error and no warning**. The lookup
yields `[]`, and `attachLines` emits a fully-null row anyway:

```
rows for "w smith": [{"market":"batter_hits","label":"Hits",…,
  "line":null,"book":null,"overBook":null,"underBook":null,
  "nBooks":0,"over":null,"under":null,"proj":1,"edge":null}]
```

An unmatched player is therefore indistinguishable from a player no book has
priced. Both render as a card full of empty market rows.

---

## 2. How the main line is chosen when books disagree

### The rule

```js
const primary = bestQuote(base.length ? base : all);          // decides the POINT
const main    = primary ? bestQuote(all.filter(q => q.point === primary.point)) : null;
const line    = main?.point ?? null;                          // decides the LINE
```

Two passes, and they read from different pools:

**Pass 1 — the point.** `bestQuote` over the *base market alone*, if the base
market has **any** quote at all. Only a completely empty base market lets the
alternate ladder choose the point. `bestQuote` picks the **modal point**:

```js
for (const q of quotes) countByPoint.set(q.point, (countByPoint.get(q.point) || 0) + 1);
let point = null, bestCount = -1;
for (const q of quotes) {
  const count = countByPoint.get(q.point);
  if (count > bestCount) { bestCount = count; point = q.point; }
}
```

It counts **quote entries**, i.e. `(book, point)` pairs — normally "how many
books post this line". Ties break by **iteration order** (the comparison is a
strict `>`, so first-seen keeps the win), and that order is `CORE_BOOKS` order:
`draftkings, fanduel, betmgm, caesars, pinnacle`, then each book's own outcome
order. **On a 2–2 split, DraftKings wins**, because `parseEventOdds` walks
`CORE_BOOKS` rather than the response's own bookmaker order. That ordering is
load-bearing and nothing in the code says so.

**Pass 2 — the prices.** `bestQuote` again, this time over `base ++ alt`
restricted to the winning point. Each side is shopped independently, comparing
in *decimal* space so `-105` beats `-110`:

```js
if (q.over != null && (over == null || americanToDecimal(q.over) > americanToDecimal(over)))
  { over = q.over; overBook = q.book; }
if (q.under != null && (under == null || americanToDecimal(q.under) > americanToDecimal(under)))
  { under = q.under; underBook = q.book; }
```

**Book selection for the row** is then "the best book for whichever side the
engine picked, falling back to the other side's book":

```js
const book = edge?.side === "under" ? main?.underBook || main?.overBook
                                    : main?.overBook || main?.underBook;
```

**`nBooks`** on the row is `new Set(atPoint.map(q => q.book)).size` — distinct
book labels at the chosen point.

### Can a market end up with a line but no odds?

**Yes.** A quote entry is created for every `(book, point)` pair regardless of
whether an `Over` or `Under` outcome ever attaches a price to it — the price
assignment is gated on `outcome.name === "Over"` / `"Under"` exactly. Any market
delivering differently-named outcomes (a Yes/No home-run market, a
`Under`/`Over` casing variation) yields price-less quotes that **still vote for
their point and still count toward `nBooks`**. Verified on the original:

```
### G. all prices null at the winning point
   {"line":5.5,"over":null,"under":null,"book":null,"nBooks":2,
    "edgeNBooks":0,"verdict":"PASS","side":null}
```

A row claiming a 5.5 line from 2 books, with no price on either side.

### Can the odds come from a different point than the line?

**Not directly** — pass 2 filters on `q.point === primary.point`, so prices are
always drawn from quotes at exactly the reported point. But three related
mismatches are real:

1. **The line can be `null` while the odds are real.** See §4 case (b).
2. **The point is chosen from one pool and priced from another.** The base
   market picks the point; base *and* alternate then set price, book and
   `nBooks`. So a row can read `nBooks: 4` when only one of those four books
   quoted the base market.
3. **`over` and `under` come from different books.** The row advertises a
   two-sided price no single book offers. That is deliberate line-shopping and
   fine for the side actually being bet, but it means `over`/`under` as
   displayed is a synthetic pair.

### The pathological case: one quote outvotes a consensus

Because pass 1 consults the base market alone, **a single stale base-market
quote outranks any depth of agreement in the alternate ladder.** Verified:

```
### F. single base quote (CZR 8.5) vs four books agreeing on 5.5 in the alt ladder
   {"alt":false,"line":8.5,"over":400,"under":-600,"nBooks":1,"verdict":"PASS"}
   {"alt":true, "line":5.5,"over":-110,"under":-102,"nBooks":4,"verdict":"SOLID"}
```

The main line is the outlier; the actual market consensus is relegated to the
"alternate" row.

### `nBooks` means two different things in the same row

`attachLines` passes `main.quotes` into `evaluateEdge`, which recomputes
`nBooks` via `consensusFair` — and *that* count is the number of **two-sided
quote entries**, not distinct books:

```js
if (a.twoSided && a.fairOver != null) { …; l++; }
…
return { fairOver: t / n, vig: r / l, twoSided: true, nBooks: l, sharp: s };
```

When a book posts the same point in both the base and alternate feeds, its
quote appears **twice** in `main.quotes`. Verified:

```
### D. DK quotes 5.5 in both pitcher_strikeouts and pitcher_strikeouts_alternate
   {"line":5.5,"over":-118,"under":102,"book":"DK","nBooks":1,"edgeNBooks":2,"verdict":"SOLID"}
```

`row.nBooks = 1`, `row.edge.nBooks = 2`, from the same data. This is not
cosmetic: `evaluateEdge`'s consensus demotion is

```js
if ((nBooks ?? 0) < 2 && verdict === "STRONG") verdict = "SOLID";
```

so **a single book quoting both feeds satisfies the "two independent books"
guard**, and its price is also double-weighted in the weighted-mean fair price.
The de-duplicated count that would have caught it is sitting on the same row.

---

## 3. Can alternates shadow or duplicate the main-line row?

**Duplicate — no.** The scan skips the main point explicitly:

```js
if (point === line || point == null) continue;
```

so no two rows for a market ever carry the same `line`. At most one alternate
row is emitted per market (the best non-PASS candidate by EV, `null` EV sorting
as `-99`).

**Shadow — yes, three ways.**

**(a) An alternate line presented as the main line, untagged.** When the base
market has no quotes, `bestQuote(base.length ? base : all)` falls through to the
combined pool, and the resulting row is pushed **without `alt: true`**:

```
### C. only pitcher_strikeouts_alternate is present
   {"alt":false,"line":5.5,"over":-125,"under":110,"nBooks":2,"verdict":"SOLID"}
   {"alt":true, "line":7.5,"over":180, "under":-220,"nBooks":1,"verdict":"LEAN"}
```

Both rows are alternate-market lines. The UI labels one of them as the main
line. There is no field on the row recording which market a price came from.

**(b) A row tagged `alt: true` that contains no alternate-market data at all.**
The scan iterates the *combined* pool, so any off-consensus point in the **base**
market becomes an "alternate":

```
### E. no alternate market exists; base has DK/FD at 5.5 and PIN at 4.5
   {"alt":false,"line":5.5,"over":-118,"under":100,"nBooks":2}
   {"alt":true, "line":4.5,"over":-260,"under":210,"nBooks":1}
```

Combined with (a), **`alt` does not mean "alternate market"** — it means "not
the modal point". The five markets with no alternate ladder at all
(`pitcher_outs`, `batter_runs_scored`, `batter_singles`, `batter_strikeouts`,
`batter_stolen_bases`) can still emit `alt: true` rows by this route.

**(c) The consensus demoted to an alternate.** Case F in §2 — the real market
line appears only as the `alt` row while an outlier occupies the main row.

One more asymmetry worth naming: the alternate scan skips `point == null`
(which catches `undefined`), but the main-line path does **not** — see §4(b).

---

## 4. Rows emitted with a null line, or a line on the wrong market

### (a) Every unpriced market, for every player

The row push happens **before** the `line != null` guard, unconditionally:

```js
rows.push({ market: marketKey, ...spec, line, book: book || null, … });
if (line == null || !all.length) continue;   // guard is AFTER the push
```

so a player with no odds at all still gets a full set of empty rows:

```
### A. player absent from the odds feed
   {"alt":false,"line":null,"over":null,"under":null,"book":null,"nBooks":0}
```

Every batter in every lineup produces 9 rows and every probable produces 5,
whether or not a single book has priced them. This is likely intentional (the
UI wants a stable row set) but it is also what makes an unmatched *name* (§1)
invisible.

### (b) A row with real odds and a null line

`bestQuote` never filters out quotes whose `point` is `undefined` — `undefined`
is a valid `Map` key, so it participates in and can win the modal vote. The row
then does `main?.point ?? null`, collapsing `undefined` to `null`, **while the
prices, book and `nBooks` survive**:

```
### B. quotes carrying no point
   {"alt":false,"line":null,"over":-115,"under":100,"book":"FD","nBooks":2}
```

A row with a best over of `-115`, a best under of `+100`, from 2 books, and no
line. `edge` is `null` because `evaluateEdge` bails on a null line, so the row is
unpriced but visually populated. The alternate scan never reaches this state
because it filters `point == null` first.

### (c) `book` set for a side that was never chosen

```js
const book = edge?.side === "under" ? … : main?.overBook || main?.underBook;
```

When `edge` is `null` (cases (a) and (b) above), `edge?.side` is `undefined`,
which is not `"under"`, so the expression silently takes the **over** branch.
Case B above shows `book: "FD"` on a row with no side and no edge.

### (d) Wrong market — not found

Both indices are exact:

```js
odds[marketKey]?.[playerKey]                 // base
odds[BASE_TO_ALT[marketKey]]?.[playerKey]    // alternate
```

`BASE_TO_ALT` is a clean inversion of a one-to-one `ALT_MARKETS` map, so no
market can pull another's quotes. The `distKey` collisions across the two market
tables (`pitcher_hits_allowed` and `batter_hits` both use `"hits"`) are harmless
— each is resolved against its own projection object. `attachLines` is called
with the same parsed-odds map for pitchers and batters, but `pitcher_*` and
`batter_*` keys are disjoint, so a two-way player appearing as both probable
pitcher and lineup batter causes no bleed.

**The cross-contamination in this system is on the player axis, not the market
axis** (§1), plus the base/alternate provenance being unrecorded (§3).

### (e) Adjacent: the NRFI line is dropped unless it is exactly 0.5

Outside `attachLines`, but the same family of failure (app.js:1250):

```js
const D = gl(eventOdds.totals_1st_1_innings?.__game__);
D && D.point === 0.5 && ((game.nrfiLine = {…}), (game.nrfiEdge = evaluateEdge(…)));
```

If the modal first-inning total is anything other than `0.5`, both `nrfiLine`
and `nrfiEdge` are left unset with no diagnostic — the NRFI section simply
vanishes from the card.

---

## Summary of findings (report only — nothing fixed)

| # | Finding | Where |
|---|---|---|
| 1 | Odds↔stats join is exact normalised-full-name string equality; no fallback, no id, no fuzzy match. The glossary's `nameMatches` (`Zp`) does not exist — `Zp` is an array chunker. | `names.js`, `lines.js` |
| 2 | Two players with the same full name have their quotes silently **merged**; both get identical, wrong rows. | `parseEventOdds` |
| 3 | A name-spelling mismatch is indistinguishable from "no book priced this player" — both render as null rows. | `attachLines` |
| 4 | Description-less outcomes all collapse into the `""` key. | `parseEventOdds` |
| 5 | The main **point** is chosen from the base market alone; a single stale base quote outvotes any depth of alternate-ladder consensus, which is then demoted to the `alt` row. | `attachLines` |
| 6 | The point is chosen from one pool and **priced** from another (base ++ alt), so `nBooks`/`book`/prices may come entirely from the alternate feed. | `attachLines` |
| 7 | Modal-point ties break on `CORE_BOOKS` iteration order — **DraftKings wins a 2–2 split** — which is undocumented and looks incidental. | `bestQuote` |
| 8 | `row.nBooks` (distinct books) and `row.edge.nBooks` (two-sided quote entries) disagree when a book quotes the same point in both feeds; the inflated one is what defeats the `nBooks < 2` STRONG demotion, and that book is also double-weighted in the fair price. | `bestQuote` / `consensusFair` |
| 9 | A row can carry a line with **no odds on either side** (outcomes not named exactly `Over`/`Under`). | `parseEventOdds` / `attachLines` |
| 10 | A row can carry **real odds with a null line** (quotes lacking `point`); `edge` is null but the row looks populated. The alternate scan filters this case; the main-line path does not. | `attachLines` |
| 11 | An alternate-market line is emitted as the **main line, untagged**, when the base market is empty. | `attachLines` |
| 12 | `alt: true` means "not the modal point", not "from the alternate market" — base-market outliers get tagged `alt`, including for the 5 markets with no alternate ladder. | `attachLines` |
| 13 | Rows are pushed before the `line != null` guard, so every player emits a full row set regardless of coverage. | `attachLines` |
| 14 | `book` falls through to the over book when no side was chosen (`edge?.side === "under"` is false for `undefined`). | `attachLines` |
| 15 | `books=all` (sharp mode) widens the upstream to `regions=us,us2`, but `parseEventOdds` reads only the 5 `CORE_BOOKS` — the extra credits buy nothing, and swapping `bookmakers=` for a US-region request may drop Pinnacle, the one book weighted 3×. Verify against a live response. | `api.js` / `parseEventOdds` |
| 16 | NRFI line/edge are silently dropped unless the modal first-inning total is exactly `0.5`. | `loadSlate` |

Findings on `evaluateEdge` itself (thresholds all preserved verbatim) are
recorded as `TODO(recon)` comments in `src/model/edges.js`: `sideEdge` returns
`-edge` when no side was selected; `kellyFraction` returning `null` becomes a
stake of `0` rather than "unknown" via `null * 0.25`; and `kelly` is computed
even on `PASS` rows.
