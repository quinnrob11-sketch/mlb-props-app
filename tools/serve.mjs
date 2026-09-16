// Serve dist/ with this branch's own /api/* handlers (see local-api.mjs).
//
//   npm run build && node tools/serve.mjs     -> http://localhost:4173
//
// Set ODDS_API_KEY in the environment to exercise the sportsbook feeds; without
// it the app shows exactly what production shows with a missing key.
// Pass --live to proxy /api/* to the production deployment instead.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiFetch } from './local-api.mjs';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const LIVE = process.argv.includes('--live');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    try {
      const headers = req.headers['x-odds-key'] ? { 'x-odds-key': req.headers['x-odds-key'] } : {};
      const r = LIVE
        ? await fetch('https://mlb-props-app.vercel.app' + req.url, { headers })
        : await apiFetch(req.url, { headers });
      const body = await r.text();
      res.writeHead(r.status, {
        'content-type': 'application/json',
        'x-requests-remaining': r.headers.get('x-requests-remaining') || '',
      });
      return res.end(body);
    } catch (e) {
      res.writeHead(502);
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  let f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fs.existsSync(f)) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(4173, () => console.log(`up on http://localhost:4173 (${LIVE ? 'live api' : 'local api'})`));
