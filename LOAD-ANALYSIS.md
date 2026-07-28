# LOAD-ANALYSIS — `loadSlate` / `gradeSlate`

Source: `/tmp/work/app.js` lines 942–1439 (`sh` = `loadSlate`, `ih` = `gradeSlate`).
Reconstruction: `/tmp/work/recon/src/data/loadSlate.js`, `/tmp/work/recon/src/data/gradeSlate.js`.
Consumer for the UI claims below: `/tmp/work/app.js` lines 1760–1832 (`ah` = `App`).

**Report only — nothing below has been fixed.**

---

## 1. The batter board when lineups are not posted

Batters are **dropped entirely**. There is no fallback roster, no "projected
lineup", no last-game-started heuristic. Trace, in load order:

**(a) Id collection — the only source of batter ids is the posted lineup.**

```js
for (const game of games)
  for (const side of ['away', 'home']) {
    const probable = game.teams[side].probablePitcher;
    if (probable) pitcherIds.push(probable.id);
    const lineupKey = side === 'away' ? 'awayPlayers' : 'homePlayers';
    for (const player of game.lineups?.[lineupKey] || [])
      batterIds.push(player.id);
  }
```

No lineup ⇒ `game.lineups?.[lineupKey]` is `undefined` ⇒ `|| []` ⇒ zero ids.
Nothing else ever adds a batter id — not the 40-man roster, not yesterday's
lineup, not the team's stats splits (those are team-level only, `teamEnv`).

**(b) The stats fetch still runs, with an empty list.**

```js
status(`Fetching batter stats (${batterIds.length} bats)…`);
const [batters26, batters25] = await Promise.all([
  fetchPlayerStats(batterIds, 'hitting', SEASON, false),
  fetchPlayerStats(batterIds, 'hitting', PRIOR_SEASON, false),
]);
```

`fetchPlayerStats` chunks `[...new Set(ids)].filter(Boolean)` by 35, so an empty
array produces zero HTTP calls and two empty Maps. The status line reads
literally `Fetching batter stats (0 bats)…` — the closest thing to a warning the
user gets, and it scrolls past.

**(c) NRFI silently degrades rather than failing.** `topOfOrderObp` reads the
same empty lineup:

```js
const obps = (game.lineups?.[lineupKey] || [])
  .slice(0, 3)
  .map((player) => player.id)
  .map((id) => parseFloat(pickSplit(batters26.get(id), 'hitting', SEASON)?.obp || ''))
  .filter((v) => !isNaN(v));
return obps.length ? obps.reduce((a, b) => a + b, 0) / obps.length : null;
```

It returns `null`, and `projectNrfi` (`Xp`, app.js:503) treats a null OBP as a
neutral lineup — `const c = f ? oe(f / 0.325, 0.8, 1.25) : 1`. So the NRFI card
**still renders a number**, computed as if both lineups were exactly league
average, with no flag distinguishing it from a real projection.

**(d) The batter loop is a no-op.**

```js
const lineup = game.lineups?.[lineupKey] || [];
...
lineup.forEach((player, index) => { ... row.batters.push({ ... }) });
```

`row.batters` stays `[]`. Slot is positional (`slot: index + 1`), so the whole
batter model — PA by slot, platoon split, opposing SP rates — has no input.

**(e) Nothing records that this happened.** The returned object carries only a
count: `lineupsPosted: out.filter((g) => g.batters.length).length`. There is no
per-game `lineupsPosted` flag on the row.

**Consequence in the UI (app.js:1827–1832):** the explanatory banner is
all-or-nothing —

```js
n && n.games.length > 0 && n.games.every((j) => j.batters.length === 0) &&
  "Lineups not posted yet — the batter board fills in automatically once lineups drop…"
```

On a typical staggered slate (early games posted, 7pm games not), `every(...)`
is false, **no banner shows**, and the missing teams are simply absent from the
BATTERS tab. The counter in the strip ("N lineup bats") is the only hint, and it
has no denominator to compare against.

---

## 2. Projection without a stats record (and vice versa)

**Projection without stats: yes, routinely, and it is invisible.**

```js
const b26 = pickSplit(batters26.get(player.id), 'hitting', SEASON);
const b25 = pickSplit(batters25.get(player.id), 'hitting', PRIOR_SEASON);
const proj = projectBatter({ season26: b26, season25: b25, ... });
...
season: b26 ? { avg: b26.avg, ... } : null,
```

`pickSplit` (`rr`, app.js:637) returns `null` whenever the people payload has no
`hitting`/`season` group **or the split's `season` string does not equal the
requested year**:

```js
const u = a.splits?.find((d) => String(d.season) === String(n)) || a.splits?.[0];
if (u && String(u.season) === String(n)) return u.stat;
return null;
```

`projectBatter` is called anyway with `season26: null, season25: null`. It merges
`{ ...LEAGUE_AVG, ...lg }` and projects from league priors, PA-by-slot, park and
weather — a complete, line-attachable projection. The row then carries
`season: null` while `proj`, `props` and `edge` look identical in shape to a
fully-backed row. The only tell is `SMALL SAMPLE` (`pa26 < 100 && pa25 < 250`,
app.js:475), which is also set for any legitimately young hitter, so the two
cases are indistinguishable downstream.

This is a live path, not a theoretical one: a September call-up with no MLB PA,
a player the chunked people lookup dropped, and a player whose only split is a
minor-league season all land here.

Same hazard on the pitcher side (`season: s26 ? {...} : null`), plus `person` is
used for handedness with two different defaults:

```js
sp[side] = { ..., hand: person?.pitchHand?.code || 'R' };   // used for batters' vsHand
row.pitchers.push({ ..., hand: person?.pitchHand?.code || '?' });  // shown on the card
```

An unknown-handed starter shows `?` on the pitcher card but drives every
opposing batter's platoon adjustment as a right-hander.

**Stats without a projection: not reachable for batters.** The id list and the
projection loop read the same `game.lineups[lineupKey]` array object on the same
`games` array, in the same function invocation, so the sets are identical by
construction. `fetchPlayerStats` dedupes, so duplicates are harmless. The only
"orphan" fetch is a *pitcher* id whose game later has `if (!probable) continue;`
— impossible for the same reason.

---

## 3. Odds-API credit cost of one full slate load

Calls made per load:

| Call | Count | Markets | Books/regions |
|---|---|---|---|
| `endpoint=events` | 1 | — | — |
| `endpoint=event-odds` | 1 per **matched** Preview game | `marketsParam(sharp)` | `sharp ? 'all' : 'core'` |

`marketsParam` (`eh`, app.js:772–773):

```js
qp = [...Object.keys(Eo), ...Object.keys(_o), "totals_1st_1_innings"],
eh = (e) => [...qp, ...(e ? Object.keys(id) : [])].join(",")
```

- `PITCHER_MARKETS` (`Eo`): 5 markets
- `BATTER_MARKETS` (`_o`): 9 markets
- `+ totals_1st_1_innings`: 1
- **base = 15 markets**
- `ALT_MARKETS` (`id`): 7 more when `sharp` ⇒ **22 markets**

Region multiplier, from the proxy (`/tmp/work/api/odds.js`): `books=core` pins
`bookmakers=` 5 books (≤10 books = 1 region-equivalent under Odds API billing);
`books=all` sets `regions=us,us2` = 2 regions. The Odds API charges
`markets × regions` for `/events/{id}/odds`, and the `/events` list is free.

**Per matched game:**
- `sharp = true` (the default): 22 × 2 = **44 credits**
- `sharp = false`: 15 × 1 = **15 credits**

**Per full load** (`G` = games that matched an odds event):
- sharp: `44 × G` — a 15-game slate ⇒ **660 credits**
- core: `15 × G` — a 15-game slate ⇒ **225 credits**

### Redundant spend

1. **Batter markets are bought for games with no posted lineup.** The 9 batter
   markets (+4 batter alternates in sharp mode) are requested unconditionally,
   but `attachLines(BATTER_MARKETS, ...)` is only ever called from inside
   `lineup.forEach(...)`. For a lineup-less game that is 13 of 22 markets —
   **26 of the 44 credits, provably unusable**, discarded inside
   `parseEventOdds`'s return value. Since the intended workflow is "hit REFRESH
   closer to game time", early loads pay this repeatedly.
2. **Doubleheaders can double-charge for the same event.** Matching is by team
   names first, then nearest `commence_time`:
   ```js
   const candidates = events.filter(
     (ev) => ev.home_team === homeTeam.name && ev.away_team === awayTeam.name,
   );
   if (!candidates.length) return;
   const event = candidates.reduce((best, ev) => ...nearest commence_time...);
   ```
   If the feed lists only one event for a two-game day, both `gamePk`s reduce to
   the **same `event.id`** and fire **two identical `event-odds` requests in
   parallel**. With a BYO key the proxy sets `private, no-store`, and the calls
   are concurrent regardless, so neither the CDN nor request coalescing helps —
   44 credits spent twice for one payload. The second write also just overwrites
   the first in `oddsByGame` under a different key, so the data is duplicated,
   not merged.
3. **`totals_1st_1_innings` is bought for every game** but only read inside
   `if (awaySp && homeSp)`. Games with a TBD starter pay for it and never use it.
4. **No caching across loads on the client.** Every REFRESH re-runs the full
   sequence; the only dedupe is the proxy's 60s CDN window, which is bypassed
   entirely when the user supplies their own key.

Also worth noting (not a credit issue, a reporting one): `remaining` is
last-writer-wins across the parallel per-game calls —

```js
oddsByGame.set(game.gamePk, parseEventOdds(res.body));
if (res.remaining) remaining = res.remaining;
```

Whichever response lands last sets the displayed "odds credits left", not the
minimum, so the number shown can be higher than the true remaining quota.

---

## 4. Swallowed failures that leave a silent empty/partial batter board

**(a) No lineup ⇒ no batters ⇒ no error object at all.** Covered in §1. This is
the largest one: it is not even a swallowed exception, it is a structurally
absent signal. `oddsError` stays `null`, `skipped` stays 0, and the only banner
is the `every(... === 0)` all-or-nothing one at app.js:1827.

**(b) Team-name mismatch in odds matching produces a silent early return.**

```js
if (!candidates.length) return;
```

Matching is exact string equality on `home_team` / `away_team`, with **no
`normalizeName` and no fallback** — everywhere else in this codebase player
names go through `normalizeName`, but team names do not. Any feed-side renaming
("Athletics" vs "Oakland Athletics", any punctuation drift) yields zero
candidates, the game gets `{}` odds, every prop row for both its lineups comes
back with `line: null` / `edge: null`, and `oddsError` is **never set** — so the
"Odds feed issue" banner does not fire. The batters exist but the whole game
vanishes from BEST BETS and from the "props w/ lines" count with no explanation.

**(c) Only the first per-game odds error survives.**

```js
} catch (err) {
  oddsError = oddsError || err.message;
}
```

If 12 of 15 games 429 or time out, the user sees one message and has no way to
tell which games are affected — the rows are present but line-less, identical in
appearance to case (b).

**(d) Weather failures are fully silent — two bare `catch {}`.**

```js
} catch {
  // per-venue forecast failure: no weather for this game
}
...
} catch {
  // venue lookup failure: the whole slate simply has no weather
}
```

The outer one wraps the `/api/v1/venues` call, so a single venue-lookup failure
drops weather for the **entire slate**. `wx` then falls to `null`, and
`weatherHrFactor` (`Gp`) returns `1` and the NRFI temp factor returns `1`. HR and
run projections quietly revert to neutral. Nothing on the row records that
weather was attempted and lost — `wx: null` is also what a dome-less game with a
missing forecast hour looks like, and `wx: { indoor: true }` is what a dome looks
like, so `null` is ambiguous.

Note also the hour match is exact-string:
`new Date(game.gameDate).toISOString().slice(0, 13) + ':00'` indexed into
`forecast.hourly.time`. A game more than ~3 days out (`forecast_days=3`) or any
timezone/format drift yields `idx === -1` and no weather, silently.

**(e) `pickSplit` returning `null` is never surfaced.** Covered in §2 — the
batter appears on the board with a fully league-average projection and priced
edges, distinguishable only by `season: null` in the raw row and a `SMALL SAMPLE`
flag that overloads two different conditions.

**(f) Dead branch: `isFinal` can never be true.** `games` is filtered to
`abstractGameState === 'Preview'` at the top, then inside the projection loop:

```js
const isFinal = game.status?.abstractGameState === 'Final';
```

Always `false` for every row `loadSlate` emits. Any UI that branches on
`row.isFinal` is unreachable code from this loader.

**(g) `blendedEra` guards `num` but not `den`.**

```js
const num = (isNaN(era26) ? 0 : era26 * ip26) + (isNaN(era25) ? 0 : era25 * ip25 * 0.6);
const den = ip26 + (isNaN(era25) ? 0 : ip25 * 0.6);
```

`ip26` is added to the denominator unconditionally, while its numerator term is
dropped when `era26` is `NaN`. A starter with innings logged but a missing/
non-numeric `era` string in the 2026 split gets an ERA biased toward zero, which
feeds `projectNrfi` directly. (2025 is guarded consistently; 2026 is not.)

**(h) `gradeSlate` — `NO DATA` conflates three causes.**

```js
const rec = actualsByPlayer.get(row.playerId);
const line = row.kind === 'pitcher' ? rec?.pitching : rec?.batting;
const actual = line ? line[row.distKey] : undefined;
if (actual === undefined) {
  graded.push({ ...row, actual: null, result: 'NO DATA' });
  continue;
}
```

`NO DATA` means any of: the game never went Final, the player was scratched, or
`row.distKey` is not a key this loader writes. It also swallows the boxscore's
own filter — a batter who appeared but recorded `plateAppearances === 0` (pinch
runner, defensive replacement) has **no `batting` record written at all**:

```js
if (batting && Object.keys(batting).length && (batting.plateAppearances || 0) > 0)
```

so their props grade as `NO DATA` rather than resolving. Boxscores are also
fetched **sequentially**, one round-trip per Final game, and any single
`mlbFetch` rejection throws out of the whole grade with no partial results —
unlike `loadSlate`, `gradeSlate` collects nothing.
