# First five innings — the starter's half of the game, measured

The board now prices the three F5 markets — total, moneyline and run line —
beside the full-game lines. `docs/FIRST-FIVE.md` has the whole measurement.

**It is a derivation, not a new model.** `firstFiveGrid` is the existing
inning-by-inning convolution stopped after five, through the same
`uncertainScoreGrid` uncertainty. Nothing was fitted. Two league-average teams
give 4.982 runs in five against 5.007 measured on 4,761 games, home leading
44.98% against 45.33%, level 15.30% against 15.52%.

**A tie after five is a real outcome (15.5% of games), not a push.**
`firstFiveMarkets` returns `pHome`, `pAway` and `pTie` explicitly. The board
compares P(home leads | not level) against the two team prices de-vigged
against each other, which is correct for a three-way book (the draw drops out
of the ratio) and for a draw-no-bet one (the tie is a push) alike; a `Draw`
outcome in the feed is ignored on purpose. The tie is carried on the row as
`push`, and settlement reads the first five innings of the linescore.

**The hypothesis failed.** F5 is the part the starter decides, and the starter
is the model's strongest component, so it should have been relatively better
there. Paired at the coin-flip line of each market on 4,213 games, F5 is worth
**+0.15, +0.05 and −0.04 points of Brier skill** against the full game, every
interval containing zero. What did improve is calibration: ECE 0.63 against
0.77 on the total, 0.65 against 1.31 on the run line, and a point projection
biased −0.009 runs against −0.053.

**Costs 6 odds credits per refresh, up from 3** — the game-lines call is billed
markets × region-equivalents and three markets became six. The prop feed is
untouched.

**Not changed:** `MARKET_WEIGHT`, `PLAY_RULES`, the hurdle. F5 rows are
information only for the same reason the full-game lines are, and the
measurement gives no reason to change that. `MARKET_WEIGHT` gets no F5 entry
either — F5 borrows the game lines' weight rather than inventing a number.

---

# v37 — the improved game model, shipped and re-measured

`docs/GAME-EDGE-SEARCH.md` rebuilt the game model's per-game inputs and found
they forecast significantly better than the shipped ones while still only
drawing level with the exchange price. It could not ship them: three terms need
inputs `src/data/loadSlate.js` did not fetch. This ships them and measures what
survived the port.

**The port reproduces the study**, on the same holdout (2026-09-02..09-22, 273
games, 5,675 priced Kalshi markets), paired against a frozen copy of the v36
model:

| paired Brier, ported − v36 | pooled | `KXMLBTOTAL` | `KXMLBRFI` |
|---|---|---|---|
| the study, as published | −0.0025 [−0.0045, −0.0005] | −0.0036 [−0.0068, −0.0005] | −0.0052 [−0.0087, −0.0017] |
| **the ported `src/model/game.js`** | **−0.0026 [−0.0047, −0.0005]** | −0.0036 [−0.0069, −0.0004] | −0.0050 [−0.0085, −0.0014] |
| **decision-time inputs only** | **−0.0021 [−0.0041, −0.0003]** | −0.0029 [−0.0060, +0.0000] | −0.0045 [−0.0078, −0.0010] |

The last row is the one that predicts what the board gets: the study's lineup
term saw the card that took the field and its weather term saw the conditions
recorded at first pitch, and neither is available at T−120. Hindsight is worth
about 0.0005 of the 0.0026. The first-inning gain contains none of it, because
the fitted exponent on the top of the order is zero — the first inning is about
the arm.

**Changed:** team offence now carries 30 games of last season at last season's
own league level; the starter is regressed component by component (10 batters
faced of prior on strikeouts, 4,000 on home runs); the park factor is applied
at 1.5 rather than damped to 0.7; temperature is 4%/10°F; **wind is used when
MLB publishes a direction**; the first inning raises the starter's index to
1.4. `EXPLAINED_TEAM_SD` 0.12 → 0.131, measured from the new model's own
spread. `loadSlate` fetches last season's team hitting (one request, in a wave
that already ran), the top four of each card and `weather` on the schedule
hydrate (no new requests).

**Not changed, deliberately:** `MARKET_WEIGHT` and `PLAY_RULES`. The in-sample
optimal weight on (model − market) rose to 0.55 pooled once the new inputs were
in; acting on that is the overfitting this programme exists to prevent. The
model is level with the price, not ahead of it. Game lines stay information
only and the bot screened **0 contracts** on all 273 holdout games, as before.
The four structural constants also stay at their whole-2026 fit, which is what
`test/gameFit.test.js` pins to the measured league rates.

**League-aggregate calibration** is unchanged where it is pinned (two
league-average teams still give home win 52.94%, NRFI 50.12%, over 8.5 49.65%,
home −1.5 36.04%) and better where it is measured on real holdout games: NRFI
51.10% → 48.92% against 45.49% actual, over 8.5 47.36% → 50.27% against 54.21%.
The run line moves half a point the wrong way. 221 tests pass, 8 of them new
and all of them about what happens when an input is missing. Details:
`docs/GAME-PORT.md`.

---

# v36.1 — fresh out-of-sample week, cheap-contract floor raised

`bot/state` now carries a real paper record, and the week after every model fit
(Sep 16–21) was replayed against real Kalshi prices as a clean out-of-sample
test. It agrees with the July–September studies.

| Sep 16–21 (135 starts, 1,068 markets) | result |
|---|---|
| bot rules, all | −5.7% [−27.5, 14.3] on 48 trades |
| strikeouts | −12.7% [−38.3, 11.2] |
| outs | +11.1% [−38.1, 57.4] on 15 trades |
| forecast skill | model Brier 0.1864 vs market 0.1837 — market better again |

**Change:** `minPriceCents` 15 → 25. Contracts priced 15–24c returned −45%
[−74, −12] across Jul–Sep and −72% [−100, −4] in the fresh week — the only
slice significantly negative in two independent windows. Everything else is
unchanged: `liveSeries` stays empty, so the bot still paper-trades everything.

**Paper record so far** (9 settled): −$0.41, closing-line value −1.5c
[−2.82, −0.18], beating the close 22% of the time. The CLV interval excludes
zero, which is the earliest sign that these entries are on the wrong side of
where the market lands.

---

# v36 — backtests against real Kalshi prices, model refits, paper-trading tracker

## The answer to "does it make money?" (measured)
Two lookahead-free backtests traded the model against **real settled Kalshi
prices** from Jul 10 to Sep 15 2026, using the bot's own decision code:

| | trades (bot rules) | ROI | model vs market Brier |
|---|---|---|---|
| Pitcher strikeouts + outs | 623 | −4.0% [−10.1, +2.3]; strikeouts −7.8% [−14.5, −1.0] | market better in every slice |
| Batter hits / TB / HR / RBI / H+R+RBI | 609 | −3.4% [−11.0, +4.4] | market better in all five series |

After v36's pitcher improvements, the pitcher replay is still −10.1% in Aug 10–Sep 15,
and the market still has the better Brier score in both windows. No series met the
edge rule, which was written down before any profit and loss was computed. Details:
`docs/KALSHI-BACKTEST.md`, `docs/KALSHI-BATTER-BACKTEST.md`.

## Bot: real money is opt-in per series
- New `liveSeries` setting, empty by default. Even a `--live` run paper-trades every
  series not on the list: each order is decided, sized and journaled exactly, but never sent.
- `npm run bot:report` (`bot/report.mjs`) grades every journaled decision against
  Kalshi's price at first pitch (CLV) and the settlement. It reports P&L after fees
  with 95% intervals, split by market, side, price and edge, and also writes
  `report.json` and `report.html`.
- Doubleheaders (G1/G2 tickers) and team-tagged duplicate names like
  "Max Muncy (LAD)" are now priced. Before, 4,285 markets were silently skipped.
- Daily spend now includes fees.

## Model
- **Batter** (`BATTER_TUNING`; replay of 8,892 batter-games):
  - Plate-appearance and hit-rate spread widened to match reality.
  - HR shrinkage raised from 100 to 300.
  - Holdout log loss improved in every Kalshi-listed batter market.
  - All three batter calibration patches were absorbed or rejected.
- **Pitcher:**
  - Openers and bullpen games had been projected as full starts. They now get a
    reliever-sized leash.
  - Home/away strikeout and leash terms added.
  - Holdout log loss: strikeouts 2.1897 → 2.1595, outs 2.4927 → 2.4411.
  - Correlation with the actual result: strikeouts 0.46 → 0.50, outs 0.53 → 0.59.

## Open decision
The backtests put the best model weight at 0–0.25 in every prop series. The engine
uses 0.35–0.55, so the board's EVs and verdicts still trust the model more than the
evidence does. Lowering the weights to that range would remove nearly every play
from both the board and the bot. That choice is left to the owner.

---

# v35.1 — board policy and pitcher refit

## Board policy (`PLAY_RULES`, src/lib/constants.js)
Measured against live sportsbook prices on 2026-09-16. The sportsbook consensus
and Kalshi agreed with each other to a median 0.3 points; the model was 3.2–3.7
points off on game lines and 7–9 points off on pitcher props.
- Game lines and NRFI are **information only**. Model numbers are shown, but a
  play is never called.
- Pitcher props need **2+ sportsbooks** and a price **no longer than +150**.

## Pitcher model refit (`PITCHER_TUNING`, src/model/pitcher.js)
New tools: `tools/backtest-pitchers.mjs` replays 988 real starts (Aug 10–Sep 15)
without lookahead, and `tools/tune-pitchers.mjs` fits the tuning settings on
August and checks them on September.

| Sep holdout   | bias           | spread ratio | log loss        |
|---------------|----------------|--------------|-----------------|
| strikeouts    | −5.1% → +0.3%  | 1.20 → 1.12  | 2.2040 → 2.1897 |
| outs          | −5.2% → −3.0%  | 1.40 → 0.98  | 2.5606 → 2.4927 |
| hits allowed  | −3.9% → −0.6%  | 0.95 → 0.97  | 2.1764 → 2.1704 |

Median gap to live sportsbook prices on 2026-09-16 moved from 7.1 to 5.3 points
on outs and from 9.1 to 6.3 on hits allowed. Strikeouts stayed near 7.5, but the
model's lean flipped from +1.5 to −2.9, so it now prices strikeouts below the
market. Outcomes over 988 starts back the lower level; one slate of prices does
not. Watch strikeout unders in Results before trusting them. Outs remain about
3% high in September.

---

# MLB Edge Board — v35

Game lines, a projection audit, and a clearer app.

## Added — moneyline, run line, total

`src/model/game.js` plays each game out inning by inning and returns the full
distribution of final scores, so every team market reads off one picture. It
simulates the skipped bottom of the ninth, walk-offs, and extra innings with a
runner on second. Each half-inning is driven by the batting team's
park-neutral offense, adjusted for tonight's lineup. The pitching side is the
starter for his projected innings, then the bullpen (ERA/FIP blends shrunk to
league average), with park and temperature on top. Scoring distributions are
measured from 2,271 completed 2026 games, and four constants are fitted jointly
(`tools/fit-game-model.mjs`):

|                   | model  | actual |
|-------------------|--------|--------|
| home win          | 52.9%  | 52.9%  |
| home −1.5 covers  | 36.0%  | 36.0%  |
| over 8.5          | 49.7%  | 49.1%  |
| NRFI              | 50.1%  | 49.5%  |
| extra innings     | 9.8%   | 8.7%   |

Prices come from two sources through the same consensus and edge engine. The
Odds API provides DK, FD, MGM, CZR and PIN in one 3-credit call per slate.
**Kalshi** provides KXMLBGAME, KXMLBSPREAD and KXMLBTOTAL, fees included. Kalshi
is free and needs no key, so game lines still price when the Odds API key is
dead.

**How good is it:** on 2026-09-16 the model sat a median 3.1 points from Kalshi
on moneylines and 3.2 on totals, with no directional lean (signed mean −0.2 and
−0.3). That's close to the market but not sharper than it. Game lines carry a
0.3 market weight, and anything more than 8 points off the market is a PASS.

## Fixed — projections

- **NRFI leaned NRFI by 3–4 points on every game.** The old model was centred on
  54% NRFI and a .325 top-of-order OBP; the 2026 figures are 49.5% and .341.
  NRFI now comes from the game model's first inning, which uses measured
  first-inning run distributions per side. The bottom of the first scores 32%
  more than the top.
- **The pitcher platoon adjustment never ran.** `/api/v1/people/{id}/stats` was
  not allowlisted in `api/mlb.js`, so every split request got a 400 that was
  swallowed. The route is added, and the adjustment is applied only against a
  posted lineup. Against projected lineups it moved strikeouts up and walks down
  for nearly every starter, because projected cards ignore how managers stack
  opposite-handed bats.
- **Dodger Stadium had no park factors all season.** The 2026 schedule calls it
  "UNIQLO Field at Dodger Stadium". An alias is added.
- **ERA and FIP were used raw.** A 20-IP call-up with a 7.20 ERA leaned +10.6
  points OVER on earned runs. Both now carry a 15-IP league prior, and a
  non-numeric ERA can no longer turn projER into NaN.
- **Doubleheaders were graded against the wrong game,** and game-2 props were
  never snapshotted. Actuals and snapshot keys now carry the gamePk.
- **Six bullpens were missing.** The team pitching-splits endpoint pages at 50
  rows, and there are 60.

## Changed — the app

- **Games** is the landing tab: one card per game with starters, projected
  score, win chance, and moneyline / run line / total / first inning. Each line
  shows the side in plain words, model % vs market %, the gap, the best price
  and the call.
- A **data sources** panel replaces the raw error banner. It shows which feeds
  worked, and when the odds key is dead it says what that costs and how to fix it.
- Game lines and NRFI are ordinary rows, so they appear in Best Bets, the slip,
  Results grading (settled off the linescore) and the profit breakdown.
- Picks read as words ("Blue Jays −1.5", "Under 8.5 runs", "NRFI") rather than
  OVER/UNDER.
- The "unproven" warning sits above Best Bets instead of below every card.
- Tabs are renamed and reordered. DFS and Kalshi Props are grouped as secondary.
  NRFI lives on the game cards.
- Prop boards show projections when no lines exist, instead of an empty table.

## Open

- The Odds API key in production is deactivated. Player props and sportsbook
  game lines are empty until `ODDS_API_KEY` is replaced in Vercel.
- Nothing has been shown to beat closing prices yet. Grade in Results.

---

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
