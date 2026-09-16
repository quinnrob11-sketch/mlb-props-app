# Dev tools (not deployed)

- `serve.mjs` — serves `dist/` and proxies `/api/*` to the live deployment, so
  you can exercise a local build against real data without an API key.
- `e2e.mjs` / `e2e2.mjs` — headless smoke tests: load a slate, assert the stat
  strip and tab counts, exercise the filter chips and modal.

They need Playwright, which is deliberately NOT a dependency (it would add
~300MB to every Vercel build). Install it ad hoc:

    npm i -D playwright && node tools/e2e.mjs

- `backtest-pitchers.mjs` — lookahead-free replay of the pitcher model against
  box scores (statsapi, cached).
- `backtest-kalshi.mjs` — the same replay traded against real settled Kalshi
  KXMLBKS / KXMLBOUTS prices with the bot's own decision code. Results and
  method: `docs/KALSHI-BACKTEST.md`.
