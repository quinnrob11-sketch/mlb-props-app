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
- `venue-gap.mjs` — sportsbook consensus vs Kalshi cost (fee included) for the
  same contract, right now. Measures whether the two venues disagree enough to
  trade without needing the model to be right. First run (2026-09-17, 235
  contracts priced at both): median gap −2.0 pts, best +1.6, none over 3.
