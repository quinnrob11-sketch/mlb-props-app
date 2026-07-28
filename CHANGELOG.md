# MLB Prop Engine — v20

Recovered, repaired and extended. v19's source was lost; this tree was
reconstructed from the deployed bundle, then fixed.

## Where this came from

Production ran v19 but no source for it existed — not on the Desktop, not in the
GitHub repo (which was three versions behind at v15), and the deploys carried no
git metadata. This tree was decoded from the minified production bundle and
every reconstructed function was **differential-tested against the original**
before anything was changed:

- 131 oracle checks on the probability/odds/park layer, exact equality
- 1,150 randomised inputs across `projectPitcher` / `projectBatter` / `projectNrfi`
- 68,000 randomised inputs across `evaluateEdge` / `bestQuote` / `attachLines`
- every user-visible string diffed byte-for-byte against the bundle

The production stylesheet was taken verbatim, so the UI is unchanged.

## Fixed — batter model

The batter board was the reported problem. It had several independent causes.

**Lineups were the big one.** Batter ids came only from `game.lineups`, with no
fallback. On a live 16-game slate that yielded **18 batters** — two posted cards
— and no warning, because the "lineups not posted" banner only fired when *every*
game was empty. `src/data/projectedLineup.js` now derives a probable lineup from
each team's recent batting orders (last game's order → modal order over the last
7 → active roster by PA), tagged `confirmed` / `projected` / `fallback` and
flagged `PROJ LINEUP` in the UI. Same slate now yields **288 batters** and
**2,039 props with lines**, up from 269.

**`Math.round(pa)` was flattening the lineup-slot table.** The 4.51→3.54 PA
curve collapsed onto `n = 4` for slots 2 through 8 — seven slots, identical
output — a ±3–5pp artefact that on its own cleared the LEAN and SOLID
thresholds. Replaced with a floor/ceil mixture, so `E[X] = pa · p` exactly and
every `proj*` now equals the mean of the distribution printed beside it.

**Runs, RBI and H+R+RBI got no context at all.** They were byte-identical at
Coors and Oracle Park — no park, no weather, no opposing pitcher — while hits,
HR, TB and K all got the full treatment. That's roughly a third of the batter
book, biased one direction. They now use the model's own run-environment
weights; Coors/Oracle ratio moved 1.000 → 1.067, ace vs. batting-practice
starter 1.000 → 1.334.

**H+R+RBI contradicted its own components.** `projHRR = projH + projR + projRBI`
but the tail was NB(k=2.2), whose mean didn't even match — the app could
recommend both sides of the same hitter. Now a convolution of the three
component distributions; implied mean matches `projHRR` to 8e-11.

**HR park and weather boosts were stealing from singles.** `nonHrHit = hit − hr`
meant a hitter-park HR bump mechanically drained projected singles — a fake
UNDER on `batter_singles` in exactly the parks where singles aren't suppressed.
At Great American that was −1.5% for no physical reason; now 0.0%.

**Park was applied twice**, because `spRates` were already park-adjusted. The
Coors K adjustment was running at ~1.6× its intended strength. Also removed the
circular path feeding a batter's own team aggregate back into his projection.

**Stolen bases skipped shrinkage entirely** — a 21-game / 7-SB part-timer priced
at 0.333 SB/game and 25% to steal. Now routed through `shrunkRate` like every
other rate: 0.333 → 0.161.

**Phantom hits removed.** The `max(0.03, hit − hr)` floor could push the
sum of singles+doubles+triples+HR **35.4% above** projected hits for
low-average/high-power profiles. Conservation is now an identity.

## Fixed — line attachment

- **Split-brain main line.** The *point* came from the base market alone, but
  *prices and book count* from base+alternates — so one stale quote outvoted four
  books agreeing. Observed: `8.5 +400/−600 nBooks 1 PASS` shown as the main line
  while the real consensus `5.5 −110/−102 nBooks 4 SOLID` was demoted to an alt
  row. Point and prices now come from one book-weighted pool with an explicit,
  order-independent tie-break.
- **`nBooks` meant two different things on the same row**, so a book quoting in
  both feeds counted twice — defeating the `nBooks < 2` demotion and
  double-weighting that book in the fair price. Book identity is now canonical.
- **Rows with `line: null` but real odds** could render. Pointless quotes are
  dropped before the vote.
- **`alt` was mislabelled** — it meant "not the modal point", so base-market
  outliers were tagged as alternates and a genuine alternate used as the main
  line went untagged. Added a `feed` provenance field; `alt` now means one thing.
- **Name matching was exact full-name equality.** Two players sharing a name
  (Will Smith, Luis Ortiz) had their quotes silently merged and both got
  identical wrong rows; any spelling divergence was indistinguishable from "no
  book priced him". Matching is now tiered and id/team-aware, and genuinely
  ambiguous names are **dropped and reported**, not guessed.

## Added — criteria filter

Inline chips for the common cuts, a modal for the full set, persisted to
`criteriaV1`. Four groups: edge & confidence (min edge, min EV, verdict tier,
min Kelly), odds & book (odds range, max vig, min books, specific book,
two-sided only), data quality (min sample, exclude SMALL SAMPLE, confirmed
lineup only, exclude bulk/opener and short-leash arms), slate & market (market
multi-select, pitcher/batter/NRFI, time window, teams, hide alternates).

When a filter empties the board it names the criterion doing the damage and how
many rows relaxing it would return — not a generic "no results".

## Added — profitability breakdown

RESULTS can now grade every saved date in one sweep (cached, so a second run
costs zero API calls) and break performance down across 11 dimensions: market,
kind, verdict tier, side, book, odds bucket, edge bucket, EV bucket, main vs
alt, lineup source, sample quality.

Ranked by **ROI in units at the price actually taken**, not hit rate — a 50%
hit rate at −110 loses money. Every cell carries a Wilson 95% interval, and
nothing is named a leader below 25 settled picks in the cell / 50 across the
history. Export and import the graded history as JSON.

## Fixed — API proxies

- `/api/odds` was **open, uncached and metered to your key**. Now: endpoint and
  market allowlisting, canonical cache keys (market order no longer fragments
  the cache), edge caching (`s-maxage` 60–120s), per-IP rate limiting, BYO-key
  responses never entering the shared cache, and upstream URLs never echoed in
  errors (they carry the key).
- `/api/mlb` is allowlisted per route with per-route TTLs — 30s boxscore,
  86,400s venues — and can no longer be used to reach an arbitrary host.
- Both now read params via WHATWG `URL` instead of `req.query`, clearing the
  `DEP0169 url.parse()` warnings filling your runtime logs.
- `vercel.json` drops two no-op rewrites and pins `maxDuration`.

## Still outstanding

- **Rotate the Odds API key.** `5cce14f3…db7f` is in the public git history of
  `quinnrob11-sketch/mlb-props-app` and served in plaintext by the live
  `mlb-slate` deployment. Delete that project too.
- `batter_strikeouts` returned 0 rows on the test slate — worth checking whether
  the core books price it at all.
- RBI uses NB(k=0.85) while runs uses Poisson — 6.8pp apart at the 0.5 line, a
  standing UNDER lean on RBI. Left alone deliberately: retuning a live market on
  judgement rather than backtest is how you get a worse model that looks better.
- `loadSlate` should pass the game roster into `parseEventOdds` and player
  ids into `attachLines` to switch the new identity layer fully on.

## Verify

```
npm install
npm run build      # clean
npm test           # 86 tests
node verify.mjs    # 131 oracle checks vs the original bundle
node test-api.mjs  # 16 proxy tests, incl. live MLB calls
```
