// Run this repo's own /api/* serverless handlers in-process, so local tools
// exercise the code on this branch rather than whatever is deployed.
//
//   import { apiFetch, installFetch } from './local-api.mjs';
//   installFetch();              // relative '/api/...' fetches now hit api/*.js
//
// ODDS_API_KEY is read from the environment exactly as on Vercel. Without it
// the odds handler answers 500 "not configured" and the app degrades the same
// way it does in production with a dead key.
import mlb from '../api/mlb.js';
import odds from '../api/odds.js';
import kalshi from '../api/kalshi.js';

const HANDLERS = { '/api/mlb': mlb, '/api/odds': odds, '/api/kalshi': kalshi };
const realFetch = globalThis.fetch;

export async function apiFetch(url, init = {}) {
  const u = new URL(url, 'http://localhost');
  const handler = HANDLERS[u.pathname];
  if (!handler) return new Response(JSON.stringify({ error: 'no such api' }), { status: 404 });

  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
  const req = { method: init.method || 'GET', url: u.pathname + u.search, headers };

  return new Promise((resolve, reject) => {
    const out = new Headers();
    let status = 200;
    const res = {
      setHeader: (k, v) => { out.set(k, String(v)); return res; },
      status: (s) => { status = s; return res; },
      json: (body) => { out.set('content-type', 'application/json'); resolve(new Response(JSON.stringify(body), { status, headers: out })); return res; },
      send: (body) => { resolve(new Response(body, { status, headers: out })); return res; },
      end: (body) => {
        // A 308 is followed here, as a browser would.
        const location = out.get('location');
        if (status >= 300 && status < 400 && location) resolve(apiFetch(location, init));
        else resolve(new Response(body ?? null, { status, headers: out }));
        return res;
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/**
 * @param {string} [liveBase] e.g. 'https://mlb-props-app.vercel.app' — send
 *   '/api/...' to that deployment instead, so its server-side ODDS_API_KEY is
 *   used and no key ever has to exist locally.
 */
export function installFetch(liveBase) {
  globalThis.fetch = (url, init) => {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return realFetch(url, init);
    return liveBase ? realFetch(liveBase + url, init) : apiFetch(url, init);
  };
}
