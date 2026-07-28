# `projectBatter` — reconstruction audit

Source: `/tmp/work/app.js` lines 362–502 (`Qp`, `Gp`, `Yp`).
Reconstruction: `/tmp/work/recon/src/model/batter.js`.

**Diagnosis only — nothing below has been fixed.**

## 0. Fidelity of the reconstruction

Before auditing, the reconstruction was differentially tested against the
original minified functions loaded verbatim out of `app.js`: 400 random pitcher
inputs, 400 random batter inputs and 300 random NRFI inputs, comparing every
returned scalar, every flag array, and every `dist.*` tail at 15 lines each.

```
ALL MATCH (1150 random cases, projections + every dist tail + flags)
```

So every number quoted below is a property of the shipped model, not of the
reconstruction.

---

## 1. Which projections receive which adjustment

Three "context" adjustments exist: opposing-starter quality (`spRates` →
`spK`/`spHit`/`spHr`), park factor, and weather (`weatherHrFactor`).
Platoon is listed too since it is the only adjustment applied everywhere.

| Projected stat | Pitcher quality | Park | Weather | Platoon | `0.975` haircut |
|---|---|---|---|---|---|
| `projH` (hits) | **yes** `spHit` (0.48 pass-through) | **yes** `hits` @0.7 | no | yes, ×`y` | **yes** |
| `projHR` | **yes** `spHr` (0.48) | **yes** `hr` @0.7 | **yes** ×`weatherHrFactor` | yes, ×`(y−1)·1.8+1` | no |
| `projK` | **yes** `spK` (0.60) | **yes** `so` @0.5 | no | yes, ×`(2−y)` | no |
| `proj1B` (singles) | indirect only | indirect only | indirect only | indirect only | inherited |
| `projTB` | indirect only | indirect only | indirect only | indirect only | inherited |
| `projR` (runs) | **NO** | **NO** | **NO** | yes, ×`(y·0.4+0.6)` | no |
| `projRBI` | **NO** | **NO** | **NO** | yes, ×`(y·0.4+0.6)` | **yes** |
| `projHRR` (H+R+RBI) | partial (hits leg only) | partial (hits leg only) | no | mixed | partial |
| `projSB` | **NO** | **NO** | **NO** | **NO** | no |

"indirect only" means the stat is derived from `hitPA`/`hrPA` and therefore
inherits their adjustments, but the *hit-type mix* itself is never adjusted
(see §3).

### 1a. Runs / RBI / H+R+RBI are park- and weather-blind — the biggest issue

```js
const projR   = pa * rates.run * (platoon * 0.4 + 0.6);
const projRBI = pa * rates.rbi * (platoon * 0.4 + 0.6) * 0.975;
const projHRR = projH + projR + projRBI;
```

`rates.run` and `rates.rbi` are the batter's raw shrunk season rates. Nothing
about the opposing starter, the ballpark or the temperature touches them.
Same hitter, three venues, 95 °F:

```
Coors Field : projH=1.083 projHR=0.1705 projR=0.5696 projRBI=0.5389 projHRR=2.191
Oracle Park : projH=0.991 projHR=0.1523 projR=0.5696 projRBI=0.5389 projHRR=2.100
(neutral)   : projH=1.005 projHR=0.1626 projR=0.5696 projRBI=0.5389 projHRR=2.114
```

`projR` and `projRBI` are byte-identical across a park with a 112 runs factor
and one with a 96 runs factor. The market is not blind to this. The
consequence is directional and repeats every single slate:

* at hitters' parks / hot weather the model **under**-projects runs and RBIs
  relative to a market that has priced the environment in → the engine
  manufactures **UNDER** edges at Coors, GABP, Yankee Stadium;
* at pitchers' parks it manufactures **OVER** edges at Oracle, T-Mobile, Petco.

`batter_runs_scored` and `batter_rbis` both carry `MARKET_WEIGHT` 0.35 and
`batter_hits_runs_rbis` 0.40, so roughly a third of the batter markets in the
app are affected. These are not real edges; they are the model failing to
model the run environment.

`projHRR` is worse than either component because it is a *mixture*: its hits
leg is fully park-adjusted and its runs/RBI legs are not, so the bias is
diluted and harder to spot but still one-directional.

### 1b. Weather only reaches home runs

`weatherHrFactor` is multiplied into `parkHrWeather` and nowhere else. Hits,
strikeouts, runs and RBIs are temperature-invariant. Two further notes:

* `wx` carries `windMph` (collected from open-meteo in `loadSlate`) and the
  model never reads it. Wind is the largest single weather effect on HR at
  several parks.
* The app contains **two different weather models**. `weatherHrFactor` uses
  `1 + 0.006·(T−72)` clamped `[0.88, 1.12]`; `projectNrfi` uses
  `1 + 0.003·(T−72)` clamped `[0.94, 1.06]`. On a 95 °F day that is a 1.12×
  HR bump alongside a 1.06× first-inning run bump. They cannot both be right,
  and nothing reconciles them.

### 1c. `projSB` receives nothing at all

```js
const sbPerGame = (() => {
  const games = (s26.gamesPlayed || 0) + 0.6 * (s25.gamesPlayed || 0);
  const sb    = (s26.stolenBases || 0) + 0.6 * (s25.stolenBases || 0);
  return games > 20 ? sb / games : 0.04;
})();
...
const projSB = sbPerGame;   // per game, NOT scaled by PA
```

This is the only rate in the whole model that skips `shrunkRate`. Above the
20-weighted-game threshold it is the raw observed ratio with **zero**
regression; below it, a flat 0.04 for everyone including catchers. No
opposing catcher, no pitcher hold time, no lineup slot, no park.

```
 g26=21  sb26=7  -> projSB=0.3333  P(SB>0.5)=0.2500
 g26=145 sb26=8  -> projSB=0.0552  P(SB>0.5)=0.0523
 g26=22  sb26=0  -> projSB=0.0000  P(SB>0.5)=0.0099
```

A part-time player with 21 games and 7 steals is projected at 0.33 SB/game and
priced at 25 % to steal — an enormous, unregressed number that will look like a
screaming OVER against any book. Symmetrically, a genuine base-stealer with 22
games and a cold start is priced at 0.99 %. This market should be treated as
unusable until the rate is shrunk.

### 1d. Double-counted park and opponent (a real but subtler error)

`spRates` is `{adjK, adjH, adjHR}` taken from `projectPitcher` — and those are
the pitcher's **already adjusted** rates, which in `projectPitcher` were
multiplied by `parkFactor(park, …)` for the *same* park:

```js
// pitcher.js
const adjH = clamp(hRate * (1 + 0.35*(oppAvg/lg.avg - 1)) * parkFactor(park,'hits',0.7), 0.12, 0.34);
// batter.js — same park, second time
const spHit   = 1 + 0.6 * 0.8 * (spRates.adjH / lg.hRate - 1);
const parkHits = parkFactor(park, 'hits', 0.7);
const hitPA = clamp(rates.hit * platoon * spHit * parkHits * 0.975, 0.05, 0.42);
```

Measured at Coors (hits PF 111 → factor 1.077):

```
pitcher adjH neutral=0.22160  at Coors=0.23866  (park factor applied = 1.07700)
batter hitPA: neutral=0.23197  Coors(park only)=0.24983  Coors(full pipeline)=0.25908
  intended park uplift = 1.07700   actual uplift = 1.11686
```

The park is applied at ~1.48× its intended strength for hits and HR (the 0.48
pass-through counts it a second time), and at ~1.60× for strikeouts (0.60
pass-through):

```
kPA neutral=0.22762  park-only=0.23331 (x1.0250)  full=0.23680 (x1.0404)
```

The **same mechanism double-counts the batter's own team.** In `loadSlate`,
the opposing starter's `opp` argument is the *batter's own team's* aggregate
rates, and that adjustment is baked into `adjK`/`adjH`. So a batter's
individual projection is pushed by his own team's aggregate tendencies — of
which his own plate appearances are a component:

```
batter's OWN team kRate=0.25 : pitcher adjK=0.23166 -> batter kPA +3.14%
batter's OWN team kRate=0.19 : pitcher adjK=0.20775 -> batter kPA −3.36%
```

A high-strikeout team's hitters each get an extra ~3 % strikeout bump on top of
their own already-measured strikeout rate. This is circular and will
systematically produce OVER edges on `batter_strikeouts` for hitters on
high-K teams and UNDER edges for hitters on contact teams.

### 1e. The `lg` override reaches almost nothing

`loadSlate` computes live slate-wide `kRate`, `bbRate`, `avg` and passes them
as `lg`. But `projectBatter` uses **hard-coded** priors for the seven offensive
rates and only reads `lg` for K and BB:

```js
hit:    shrunkRate(..., 0.222, 60),   // not lg.hRate
hr:     shrunkRate(..., 0.03,  100),  // not lg.hrRate
k:      shrunkRate(..., lg.kRate,  60),
bb:     shrunkRate(..., lg.bbRate, 60),
```

Additionally `lg.hRate` / `lg.hrRate` are *never* live-computed anywhere
(`loadSlate` sets only `kRate`, `bbRate`, `avg`), yet they are the denominators
of `spHit` and `spHr`. Demonstrated:

```
hitPA  0.23167 -> 0.23167   (passing lg.hRate=0.26 changes nothing here)
kPA    0.22817 -> 0.23055
```

Result: the strikeout adjustment is centred on the current run environment
while the hits and HR adjustments are centred on frozen 2024-era constants. If
the real league hit rate drifts from 0.221 or HR rate from 0.031, every
`spHit`/`spHr` multiplier is biased in the same direction for every batter on
the slate.

### 1f. `rates.bb` is computed and never used

`shrunkRate(s26.baseOnBalls, …)` is evaluated and then discarded — there is no
walk market and no on-base term consuming it. Harmless, but it means the walk
rate never feeds runs, RBI or the hit-type mix, which is part of why runs are
so context-insensitive.

---

## 2. Distribution families and dispersion constants

| Market | Family | Trials / dispersion | Uses `pa` as… |
|---|---|---|---|
| `hits` | Binomial | `n = round(pa)`, `p = hitPA` | **integer** |
| `hr` | Binomial | `n = round(pa)`, `p = hrPA` | **integer** |
| `singles` | Binomial | `n = round(pa)`, `p = singlePA` | **integer** |
| `k` | Binomial | `n = round(pa)`, `p = kPA` | **integer** |
| `tb` | Exact multinomial convolution | `round(pa)` draws from {0,1,2,3,4} | **integer** |
| `runs` | Poisson | `λ = projR` | fractional |
| `rbi` | Negative binomial | `k = 0.85` | fractional |
| `hrr` | Negative binomial | `k = 2.2` | fractional |
| `sb` | Negative binomial | `k = 1` (geometric) | fractional |

The family choice is **not** consistent, and the inconsistency is not
principled.

### 2a. `round(pa)` vs fractional `pa` — an artefact large enough to trip the verdict thresholds

Every binomial market uses `paTrials = Math.max(1, Math.round(pa))` while the
matching displayed projection uses the fractional `pa`:

```js
const projH = pa * hitPA;                                   // fractional
hits: (line) => binomTailOver(line, paTrials, hitPA),       // integer
```

`PA_BY_LINEUP_SLOT` spans 4.51 → 3.54, ±0.08. Rounding collapses the whole
table onto `n = 4` except two corners:

```
AWAY  1:pa=4.59/n=5  2:4.44/n=4 ... 9:3.62/n=4
HOME  1:pa=4.43/n=4  2:4.28/n=4 ... 9:3.46/n=3
```

So the model's *distribution* claims the away leadoff hitter gets 5 PA (+8.9 %
vs his own projection) and the home nine-hole hitter gets 3 (−13.3 %), while
the card next to it displays `projH` computed from 4.59 and 3.46. The edge
engine consumes only the distribution.

Comparing `dist.hits(0.5)` against the correct fractional-PA probability
`1 − (1 − hitPA)^pa` for a .250 hitter:

```
slot side   pa    n  dist.hits(0.5)  correct   artefact
 1   away  4.59  5      0.7322       0.7017    +3.06pp
 9   away  3.62  4      0.6515       0.6148    +3.67pp
 8   home  3.58  4      0.6515       0.6107    +4.08pp
 9   home  3.46  3      0.5464       0.5982    −5.18pp
 1   home  4.43  4      0.6515       0.6888    −3.73pp
 2   away  4.44  4      0.6515       0.6897    −3.82pp
```

`evaluateEdge` grades `LEAN` at `sideEdge ≥ 0.03`, `SOLID` at `≥ 0.05` and
`STRONG` at `≥ 0.07`. A 3–5 pp artefact is therefore, by itself, enough to
produce LEAN and SOLID verdicts **every day, on the same lineup slots, in the
same direction**: OVER on the away leadoff and the bottom-of-order away
hitters, UNDER on the home leadoff and the home nine-hole. Additionally note
that slots 2–8 all collapse to `n = 4`, so the model returns literally the
identical `0.6515` for seven different lineup slots — the entire PA table is
inert for those markets.

### 2b. The dispersion constants are not defensible as a set

At a common mean, the four families give materially different answers for the
same projected total:

```
mean  Poisson  NB(k=0.85)[rbi]  NB(k=2.2)[hrr]  NB(k=1)[sb]  binom(n=4)
0.50  0.3935      0.3251           0.3627         0.3333       0.4138
1.00  0.6321      0.4837           0.5615         0.5000       0.6836
```

* **Runs (Poisson) vs RBI (NB k=0.85).** Runs scored and RBI have almost
  identical marginal distributions in real baseball (season totals are within
  a few percent for most hitters, and both are bounded by PA). The model
  prices them with families that differ by **6.8 percentage points** at the
  0.5 line for a 0.5 mean. There is no baseball reason for runs to be
  equidispersed and RBI to have `Var = μ + μ²/0.85` — the latter implies a
  variance of 0.79 on a mean of 0.5, i.e. wildly overdispersed for an event
  capped at ~5 per game. The practical effect is a **standing UNDER lean on
  every `batter_rbis` 0.5 line** and a standing OVER lean on high RBI lines.
* **`hrr` with k=2.2** is internally inconsistent with the model's own
  components. `projHRR` is defined as `projH + projR + projRBI`, so the
  self-consistent distribution is the convolution of `dist.hits`, `dist.runs`
  and `dist.rbi`. It is not close:

```
projHRR=2.1139   (convolution of the model's own marginals: mean 2.0351)
 line 0.5: NB(2.2)=0.7727  own-marginals=0.8701   −9.74pp
 line 1.5: NB(2.2)=0.5276  own-marginals=0.5966   −6.90pp
 line 2.5: NB(2.2)=0.3355  own-marginals=0.3240   +1.15pp
 line 3.5: NB(2.2)=0.2037  own-marginals=0.1473   +5.64pp
```

  The model prices H+R+RBI *and its three components* simultaneously, and its
  own numbers disagree by up to ~10 pp. Whichever is right, one of the two is
  generating fake edges, and because `batter_hits_runs_rbis` (weight 0.40) and
  `batter_hits` (0.45) are both live, the app can and will recommend
  contradictory sides on the same hitter. Note also the mean itself is off:
  the convolution mean 2.0351 ≠ `projHRR` 2.1139, because `dist.hits` uses
  `round(pa)` while `projH` uses fractional `pa` (§2a).
* **`sb` with k=1** is the geometric distribution. At the model's tiny SB
  means this barely differs from Poisson, so the choice is inconsequential —
  it is the unregressed *mean* (§1c) that breaks this market, not the family.
* **`tb`** is the one that is done well: an exact multinomial convolution over
  {out, 1B, 2B, 3B, HR} rather than a fitted parametric form. It is
  self-consistent with the per-PA rates, its only flaw being the shared
  `round(pa)` trial count.

One defence of overdispersion is generally that the *rate* is uncertain, not
just the outcome. But that argument applies equally to every market, and here
it has been applied to three markets with three unrelated constants (0.85,
2.2, 1.0) while four other markets get a pure binomial with no rate
uncertainty at all — except `dist.k` on the **pitcher** side, which does model
BF uncertainty explicitly with a 3-point mixture. The batter side has no
equivalent. The constants read as hand-tuned to individual markets rather than
derived.

---

## 3. Does the singles / doubles / triples decomposition conserve total hits?

**Almost always yes, by construction — but for a fragile reason, and it breaks
in a rare, identifiable class of hitter.**

```js
const nonHrHitPA = Math.max(0.03, hitPA - hrPA);

const hitTypeTotal = Math.max(0.001, rates.single + rates.double + rates.triple);
const singleShare  = rates.single / hitTypeTotal;

const singlePA = nonHrHitPA * singleShare;
const doublePA = nonHrHitPA * (rates.double / hitTypeTotal);
const triplePA = Math.max(5e-4, nonHrHitPA - singlePA - doublePA);
```

The three shares use the *same* denominator, so they sum to exactly 1 and
`singlePA + doublePA + triplePA = nonHrHitPA` identically. Adding `hrPA` back
recovers `hitPA`. Verified across the sweep:

```
hitPA=0.23167 hrPA=0.03345  1B+2B+3B+HR=0.23167  diff=0.000e+0
hitPA=0.24951 hrPA=0.03508  1B+2B+3B+HR=0.24951  diff=0.000e+0
hitPA=0.19224 hrPA=0.10000  1B+2B+3B+HR=0.19224  diff=0.000e+0
```

Two ways it fails:

1. **The `Math.max(0.03, …)` floor.** `hitPA` and `hrPA` are clamped
   *independently* (`[0.05, 0.42]` and `[0.002, 0.10]`), and they are driven
   by different multiplier stacks whose ranges differ by ~3×: `hitPA`'s stack
   can go as low as ~0.68 while `hrPA`'s can reach ~2.1. So `hitPA − hrPA`
   can drop below 0.03 and the floor silently injects extra hits. Sweeping
   300 000 *realistic* hitters (PA ≥ 80, HR ≤ 40 % of hits, in-range
   `spRates`, real parks, 35–100 °F):

   ```
   38 / 300000 break conservation (0.013%); max excess = 1.365e-2
   worst: 601 PA, 78 H, 30 HR → hitPA=0.10629 hrPA=0.08994
          1B+2B+3B+HR = 0.11994  (12.8% more hits than hitPA claims)
          projTB=1.5667 vs 1.5130 implied by hitPA
   ```

   Rare, but it is exactly the profile the app will show you often: a
   low-average, high-power hitter in a bandbox against a homer-prone starter.
   `projTB` and `dist.tb` inherit the inflation.

2. **The mix itself is never adjusted.** The shares come from the raw,
   unadjusted `rates.single/double/triple`. Nothing — not the park's doubles
   dimensions, not the pitcher's groundball tendency — changes the *type* of
   hit; adjustments only scale the total. `PARK_FACTORS` has no doubles column
   to use, so this is a data limitation as much as a code one, but it produces
   a counter-intuitive artefact: because `nonHrHitPA = hitPA − hrPA`, any HR
   adjustment **converts singles into home runs one-for-one** rather than
   adding offence:

   ```
   park                     hitPA    hrPA    singlePA  proj1B   projTB
   (neutral)                0.22920 0.03250 0.14628   0.6348   1.6563
   Great American (hr 112)  0.22920 0.03946 0.14110   0.6124   1.7385
   Yankee Stadium (hr 110)  0.22439 0.03477 0.14101   0.6120   1.6565
   Oracle Park (hr 91)      0.22600 0.03045 0.14541   0.6311   1.6143
   ```

   At Great American the hits factor is 100, so `hitPA` is unchanged, yet
   `proj1B` drops 3.5 % purely because `hrPA` rose. The model therefore emits a
   systematic **UNDER** lean on `batter_singles` in home-run parks and in hot
   weather, which is not a real effect — HR parks do not suppress singles, and
   certainly not one-for-one.

---

## 4. Other things that will make batter projections systematically wrong

### 4.1 The card and the edge disagree

`attachLines` prices with `proj.dist[distKey](line)` but displays
`proj[projKey]`. Because of §2a these are derived from different PA counts, so
the displayed projection and the probability driving the verdict are
inconsistent by up to ±9 %/−13 %. Any manual sanity check against the displayed
number will pass while the underlying edge is wrong.

### 4.2 The `0.975` haircuts are asymmetric and unexplained

`0.975` is applied to `hitPA` and to `projRBI`, and to nothing else — not HR,
not runs, not strikeouts, not the hit-type shares.

```
projH   = 0.9947  (without haircut 1.0203, +2.56%)
projRBI = 0.5334  (without haircut 0.5471)
projHRR carries both haircuts, on two of its three legs
```

A 2.5 % shade is roughly half a `LEAN` threshold, applied permanently and in
one direction, to two of the nine batter markets. Whatever it was calibrating
for, it now reads as a standing UNDER bias on hits and RBIs that is not
present on the correlated HR and runs markets.

### 4.3 The platoon terms use three different functional forms

```
y=1.05: hits ×1.05   HR ×1.0900   K ×0.9500 (1/y = 0.9524)   R/RBI ×1.0200
y=0.95: hits ×0.95   HR ×0.9100   K ×1.0500 (1/y = 1.0526)   R/RBI ×0.9800
y=1.02: hits ×1.02   HR ×1.0360   K ×0.9800                  R/RBI ×1.0080
```

* HR amplification `(y−1)·1.8 + 1` is a defensible modelling claim (HR is more
  platoon-sensitive than AVG) — 1.8× is arbitrary but the direction is right.
* K inversion uses `2 − y` (a reflection) rather than `1/y`. The two differ by
  only ~0.03 % here, so this is cosmetic, but it is a third form for no reason.
* R/RBI damping `y·0.4 + 0.6` passes through 40 % of the platoon edge. Fine in
  isolation — but note this is the **only** context adjustment runs and RBI
  receive at all (§1a), so the model believes handedness matters for runs
  while Coors does not.
* Switch hitters get `y = 1.02 > 1`, so they **always** carry the `PLATOON+`
  flag regardless of matchup. The flag is decorative here, but it is wrong.

### 4.4 Flag semantics

```js
if (pa26 < 100 && pa25 < 250) flags.push('SMALL SAMPLE');
```

The `&&` means a rookie with 90 PA this year and 260 PA last year is *not*
flagged, while a veteran with 99 PA this year and 240 last year is. Since
`attachLines` multiplies `MARKET_WEIGHT` by 0.6 on this flag and `evaluateEdge`
caps flagged plays at `LEAN`, the threshold decides real bet sizing off a
conjunction that does not track sample size monotonically. There is no flag at
all for a batter with *zero* 2026 data — that case falls through to pure
league priors and is presented like any other projection. (The UI has a
"No 2026 batting data" banner at `app.js:2723`, but it is not a model flag and
does not damp the weight.)

### 4.5 No correlation anywhere

Every market is priced from an independent marginal. `batter_hits`,
`batter_total_bases`, `batter_singles`, `batter_home_runs` and
`batter_hits_runs_rbis` are all functions of the same underlying PA sequence
and are strongly positively correlated; the app will happily recommend an
OVER on hits and an UNDER on total bases for the same hitter. Only `tb` is
built from a joint model, and it is not shared with anything else.

### 4.6 `pa` is a point estimate

Lineup slot is taken as certain and PA as deterministic. A hitter who is
lifted for a pinch-hitter, or whose team bats around, or who is scratched
after the lineup posts, has a PA distribution with meaningful spread. The
pitcher model explicitly handles the analogous uncertainty (`dist.k` mixes
over BF−3/BF/BF+3); the batter model does not, which understates every tail —
compounding, rather than offsetting, the `round(pa)` problem in §2a.

---

## 5. Severity ranking

| # | Finding | § | Effect |
|---|---|---|---|
| 1 | `round(pa)` in every binomial market; slots 2–8 collapse to `n=4` | 2a | 3–5 pp fake edges daily, fixed by lineup slot |
| 2 | Runs / RBI / HRR receive no park, weather or pitcher adjustment | 1a | Standing UNDER at hitters' parks, OVER at pitchers' parks |
| 3 | `projSB` unregressed, no context, flat 0.04 default | 1c | Market unusable; extreme fake overs on small samples |
| 4 | `hrr` NB(k=2.2) contradicts the convolution of the model's own H/R/RBI | 2b | Up to 9.7 pp; app can recommend both sides of one hitter |
| 5 | RBI NB(k=0.85) vs runs Poisson for near-identical real distributions | 2b | ~6.8 pp standing UNDER lean on RBI 0.5 |
| 6 | Park counted ~1.48× (hits/HR) and ~1.6× (K) via `spRates` | 1d | Over-adjusts every extreme park |
| 7 | Batter's own team's rates fed back through the opposing pitcher | 1d | ±3 % circular bias on `batter_strikeouts` |
| 8 | HR adjustments convert singles into HR one-for-one | 3 | Fake UNDER on `batter_singles` in HR parks / heat |
| 9 | `lg` override reaches only K/BB; `hRate`/`hrRate` frozen constants | 1e | Slate-wide one-directional bias in `spHit`/`spHr` |
| 10 | Unexplained `0.975` on hits and RBI only | 4.2 | Permanent ~2.5 % one-directional shade |
| 11 | `Math.max(0.03, …)` floor breaks hit conservation | 3 | 0.013 % of hitters, up to +12.8 % phantom hits |
| 12 | `SMALL SAMPLE` uses `&&`; no zero-2026-data flag | 4.4 | Weight damping misfires at the boundary |
| 13 | Wind collected but unused; two contradictory weather models | 1b | Missing largest weather effect; NRFI/HR disagree |
| 14 | No cross-market correlation; `pa` treated as certain | 4.5, 4.6 | Contradictory recommendations, understated tails |
| 15 | `rates.bb` computed and discarded | 1f | Dead code; walks never reach runs/RBI |
