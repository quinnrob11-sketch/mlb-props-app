# Dev tools (not deployed)

- `serve.mjs` — serves `dist/` and proxies `/api/*` to the live deployment, so
  you can exercise a local build against real data without an API key.
- `e2e.mjs` / `e2e2.mjs` — headless smoke tests: load a slate, assert the stat
  strip and tab counts, exercise the filter chips and modal.

They need Playwright, which is deliberately NOT a dependency (it would add
~300MB to every Vercel build). Install it ad hoc:

    npm i -D playwright && node tools/e2e.mjs
