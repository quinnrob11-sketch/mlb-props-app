# CSS class names used by the React UI

Collected while reconstructing the bundle's `o.jsx` / `o.jsxs` calls, so the
stylesheet can be rebuilt. The app styles exclusively through these class
names — there are no inline styles in this region. Two exceptions exist in the
whole bundle, both preserved verbatim in the reconstruction:

* app.js:3619 — the METHOD footer sets `style={{ color: 'var(--faint)', fontSize: 12 }}`.
* app.js:3212 — the RESULTS date picker sets `style={{ width: 170 }}` on the
  `search`-classed `<input type="date">`.

Composite class strings are listed as their individual tokens; where a class is
only ever applied together with another it is noted.

## Region: app.js 1440–2157 (`format`, `VerdictChip`, `DistributionChart`, `App`, `BestBets`)

### Shell / layout

| Class | Element | Notes |
|---|---|---|
| `app` | root `<div>` | whole-page wrapper |
| `hdr` | `<header>` | top bar |
| `hdr-brand` | `<div>` | logo + title + subtitle group |
| `hdr-logo` | `<span>` | "MLB" |
| `hdr-title` | `<span>` | "PROP ENGINE" |
| `hdr-sub` | `<span>` | version/feature strapline |
| `hdr-spacer` | `<div>` | flex spacer pushing controls right |
| `statusline` | `<div role="status">` | one-line load status / error |
| `strip` | `<div>` | slate summary counters row |
| `cell` | `<div>` | one counter inside `strip` |
| `banner` | `<div>` | inline warnings (skipped games, odds error, no lineups) |
| `tabs` | `<nav>` | tab bar |
| `tab` | `<button>` | one tab |
| `on` | `<button>` | active-state modifier on `tab` and `chip` |
| `n` | `<span>` | count in parentheses inside a `tab` |
| `toolbar` | `<div>` | search + filter chips row |
| `search` | `<input>` | search box |
| `chip` | `<button>` | filter toggle (ALT lines, STRONG only, market chips) |
| `notice` | `<div>` | empty-state panel |
| `sub` | `<div>` | secondary line inside `notice` |
| `cards` | `<div>` | card grid for BEST BETS (and NRFI) |

### Buttons

| Class | Notes |
|---|---|
| `btn` | base button (Settings) |
| `btn-primary` | applied as `btn btn-primary` (LOAD / REFRESH SLATE) |
| `addbtn` | add-to-slip button |
| `in` | modifier on `addbtn` when the row is already in the slip |

### Status / semantic colours

| Class | Notes |
|---|---|
| `err` | error text in `statusline` (prefixed "✕ ") |
| `ok` | success/idle status text; the loading state uses `""` (no class) |
| `pos` | positive number (callable/strong counts, non-negative EV) |
| `neg` | negative number (negative EV) |
| `flag` | small player flag chip (e.g. injury/usage tags); PLATOON flags are filtered out |
| `book` | sportsbook code chip next to a line |
| `altb` | applied as `book altb` for the "ALT" marker on alternate lines |
| `strong` | modifier on `card` for a STRONG verdict |

### Verdict chip

| Class | Notes |
|---|---|
| `vchip` | base chip |
| `v-pass` | PASS / no side |
| `v-over` | playing the over |
| `v-under` | playing the under |
| `fill` | added to `v-over` / `v-under` for STRONG (solid instead of outline) |

### Distribution chart (SVG)

| Class | Element | Notes |
|---|---|---|
| `distwrap` | `<div>` | chart + caption wrapper |
| `distchart` | `<svg>` | 300 × 58 viewBox, `preserveAspectRatio="none"` |
| `over` | `<rect>` | bucket above the line |
| `under` | `<rect>` | bucket at or below the line |
| `mark` | `<line>` | vertical rule at the book line |
| `dist-caption` | `<div>` | caption under the chart |
| `u` | `<i>` | "■ under nn%" swatch — must match the `under` bar colour |
| `o` | `<i>` | "■ over nn%" swatch — must match the `over` bar colour |
| `side-over` | `<i>` | "playing the OVER" |
| `side-under` | `<i>` | "playing the UNDER" |

The two unlabelled `<text>` elements (axis end labels) and the "line n" label
have no class — they are styled via `.distchart text`.

### BEST BETS card

| Class | Element | Notes |
|---|---|---|
| `card` | `<div>` | one prop |
| `card-top` | `<div>` | title block + verdict chip |
| `card-title` | `<div>` | "Name — Prop OVER 5.5" |
| `card-sub` | `<div>` | matchup · time · opponent · weather · flags |
| `card-nums` | `<div>` | four-stat row |
| `stat` | `<div>` | one stat cell |
| `v` | `<span>` | stat value (also takes `pos` / `neg`) |
| `l` | `<span>` | stat label |
| `card-foot` | `<div>` | price/Kelly line + add-to-slip button |
| `psub` | `<span>` | small muted sub-text (also used in the table) |

## Region: app.js 2158–2439 (`PropTable`, the shared pitcher/batter table)

Observed while reading, listed here for stylesheet completeness — that
component is reconstructed elsewhere.

| Class | Element | Notes |
|---|---|---|
| `chips` | `<div>` | market filter chip group inside `toolbar` |
| `tblwrap` | `<div>` | horizontal scroll container around `<table>` |
| `num` | `<th>` / `<td>` | right-aligned numeric column |
| `num dim` | `<td>` | muted numeric column (best O/U pair) |
| `dim` | `<span>` / `<td>` | muted text (the "—" placeholder) |
| `mkt` | `<td>` | prop label column |
| `rowbtn` | `<tr>` | clickable row that expands the detail panel |
| `pname` | `<div>` | player name in the first column |
| `detail` | `<tr>` | expanded detail row |

It also reuses `toolbar`, `chip`, `on`, `notice`, `sub`, `psub`, `flag`,
`book`, `altb`, `pos`, `neg`, `addbtn`, `in` and the verdict chip classes.
`detail-grid` (app.js:2444) opens the pitcher/batter detail cards.

## Region: app.js 2440–3641 (detail cards, NRFI board, slip, RESULTS, settings, METHOD)

Reconstructed into `src/ui/PitcherCard.jsx`, `BatterCard.jsx`, `SlateView.jsx`,
`BetSlip.jsx`, `ResultsView.jsx`, `SettingsModal.jsx`, `MethodologyView.jsx`
and `snapshotStore.js`. `src/ui/PropTable.jsx` (app.js 2158–2439) was also
written from this side — see the 2158–2439 section above for its classes.

### Detail cards (`PitcherCard` 2440, `BatterCard` 2677)

| Class | Element | Notes |
|---|---|---|
| `detail-grid` | `<div>` | 4-column (pitcher) / 3-column (batter) panel inside the expanded `detail` row |
| `kv` | `<div>` | one key/value line: two `<span>`s, label left, value right |
| `psub` | `<div>` | muted fallback copy ("No 2026 starts yet…", "No 2026 batting data…") |

Column headings inside the grid are bare `<h4>` (no class). Emphasis inside a
`kv` uses bare `<b>` (projected IP/BF/pitches row, batter "Actual").

### NRFI board (`SlateView` 2845)

Reuses the BEST BETS card classes: `cards`, `card`, `card-top`, `card-title`,
`card-sub`, `card-nums`, `stat`, `v`, `l`, `psub`, plus `notice` / `sub` for
the empty state and the verdict chip. `v pos` is applied unconditionally to the
NRFI-probability stat (it is always styled green regardless of value).

### Bet slip (`BetSlip` 2985)

| Class | Element | Notes |
|---|---|---|
| `slip` | `<aside>` | the whole floating slip |
| `slip-row` | `<div>` | one leg: description `<span>` + remove button |
| `slip-tot` | `<div>` | a totals line (combined odds, parlay prob, parlay EV, fair price + Clear) |
| `x` | `<button>` | remove-leg "✕", `aria-label="remove"` |
| `dim` | `<span>` | the "(odds book · stake u)" parenthetical |
| `psub` | `<span>` | "Fair price: …" |
| `addbtn` | `<button>` | reused for the "Clear" button |
| `pos` / `neg` | `<b>` | parlay EV sign |

The heading is a bare `<h3>` ("🧾 SLIP (n legs)").

### RESULTS (`ResultsView` 3140)

| Class | Element | Notes |
|---|---|---|
| `tiles` | `<div>` | five-tile summary row |
| `tile` | `<div>` | one summary tile |
| `v` | `<div>` | tile value (takes `pos` / `neg` on the CLV tile only) |
| `l` | `<div>` | tile label |
| `search` | `<input type="date">` | reuses the search-box styling; also has `style={{ width: 170 }}` |
| `banner` | `<div>` | grading status / error line |

Reuses `toolbar`, `btn`, `btn-primary`, `psub`, `tblwrap`, `num`, `pname`,
`mkt`, `book`, `altb`, `dim`, `pos`, `neg`, `notice`, `sub` and the full
verdict-chip set (`vchip`, `v-pass`, `v-over`, `v-under`, `fill`). Win/loss
cells are bare `<b className="pos">✓ WIN</b>` / `<b className="neg">✕ LOSS</b>`;
PUSH renders as `<span className="dim">`.

### Settings modal (`SettingsModal` 3436)

| Class | Element | Notes |
|---|---|---|
| `modal-bg` | `<div>` | full-screen backdrop; click closes |
| `modal` | `<div>` | the dialog; click is stopPropagation'd |
| `check` | `<label>` | checkbox row (checkbox + `<span>` label) — sharp mode |
| `hint` | `<p>` | small explanatory paragraph under the odds-key field |
| `row` | `<div>` | button row at the bottom |
| `btn-ghost` | `<button>` | applied as `btn btn-ghost` (Cancel) |

Plain `<label>`, `<input>` and `<h3>` inside `modal` carry no class and are
styled by descendant selectors.

### METHOD (`MethodologyView` 3501)

| Class | Element | Notes |
|---|---|---|
| `doc` | `<div>` | long-form prose wrapper; styles its own `h3`, `p`, `code`, `b` |
| `hint` | `<p>` | the closing "For entertainment/research" line (also gets the inline style) |
