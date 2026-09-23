# Dev tools (not deployed)

- `serve.mjs` — serves `dist/` and proxies `/api/*` to the live deployment, so
  you can exercise a local build against real data without an API key.
- `e2e.mjs` / `e2e2.mjs` — headless smoke tests: load a slate, assert the stat
  strip and tab counts, exercise the filter chips and modal.

They need Playwright, which is deliberately NOT a dependency (it would add
~300MB to every Vercel build). Install it ad hoc:

    npm i -D playwright && node tools/e2e.mjs

## Backtests (read-only; statsapi and public Kalshi data only)

- `backtest-pitchers.mjs` / `tune-pitchers.mjs` — lookahead-free starter replay
  and PITCHER_TUNING search.
- `backtest-batters.mjs` / `tune-batters.mjs` — the same for posted-lineup
  starters and BATTER_TUNING; see `docs/BATTER-BACKTEST.md`. Shared plumbing
  (cache, pool, as-of aggregation, league object) lives in
  `backtest-common.mjs`.
- `backtest-kalshi.mjs` — the same replay traded against real settled Kalshi
  KXMLBKS / KXMLBOUTS prices with the bot's own decision code. Results and
  method: `docs/KALSHI-BACKTEST.md`.
- `backtest-kalshi-batters.mjs` — the batter replay (extended to Jul 10)
  traded against settled KXMLBHIT / TB / HR / RBI / HRR prices, same rules.
  Method and results: `docs/KALSHI-BATTER-BACKTEST.md`. Kalshi plumbing shared
  by both Kalshi tools (cached public fetches, doubleheader-aware ticker parse,
  candle quotes, bootstrap statistics) lives in `kalshi-common.mjs`.
- `backtest-games.mjs` — lookahead-free GAME model replay: team hitting, team
  starter/reliever pitching splits (rebuilt from player game logs, because the
  statSplits endpoint has no date range), both starters, the park and the posted
  lineups, all as of the morning of the game. Validates `projectGame` against the
  observed home-win, total, run-line and NRFI rates.
- `backtest-kalshi-games.mjs` — that replay traded against settled KXMLBGAME /
  KXMLBSPREAD / KXMLBTOTAL / KXMLBRFI prices, same rules. Method and results:
  `docs/KALSHI-GAME-BACKTEST.md`.
- `pitcher-data.mjs` / `pitcher-model2.mjs` / `pitcher-fit.mjs` /
  `pitcher-edge.mjs` — the pitcher edge search: a two-season (9,574 start)
  lookahead-free dataset with posted lineups, home-plate umpire, catcher, park
  and weather; a candidate pitcher model fitted on it; and that model priced
  against settled KXMLBKS / KXMLBOUTS / KXMLBHA / KXMLBERA / KXMLBWA contracts.
  Pre-registration, method and verdict: `docs/PITCHER-EDGE-SEARCH.md`. Three
  stages, in order:

      node tools/pitcher-edge.mjs --stage fit      --cache DIR --out model.json
      node tools/pitcher-edge.mjs --stage ablate   --cache DIR --model model.json
      node tools/pitcher-edge.mjs --stage validate --cache DIR --kcache DIR --model model.json
      node tools/pitcher-edge.mjs --stage holdout  --cache DIR --kcache DIR --model model.json --weight W

  `fit` and `ablate` never touch a price. `holdout` requires the weight already
  chosen on `validate`, and is meant to be run once.

- `venue-gap.mjs` — sportsbook consensus vs Kalshi cost (fee included) for the
  same contract, right now. Measures whether the two venues disagree enough to
  trade without needing the model to be right. First run (2026-09-17, 235
  contracts priced at both): median gap −2.0 pts, best +1.6, none over 3.
