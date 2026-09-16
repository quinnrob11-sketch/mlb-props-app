// Authenticated Kalshi trade API client (Node only — never bundled into the site).
//
// Auth, per https://docs.kalshi.com/getting_started/api_keys:
//   KALSHI-ACCESS-KEY        the API key id
//   KALSHI-ACCESS-TIMESTAMP  milliseconds
//   KALSHI-ACCESS-SIGNATURE  base64 RSA-PSS(SHA-256, salt = digest length) over
//                            timestamp + METHOD + path, where path includes
//                            /trade-api/v2 and EXCLUDES the query string.
//
// Orders use the V2 endpoint, which quotes everything from the YES leg:
//   buy YES at p  -> side "bid", price p
//   buy NO  at q  -> side "ask", price 1 - q   (selling YES == buying NO)
// Prices are fixed-point dollar strings, counts fixed-point contract strings.

import crypto from 'node:crypto';
import fs from 'node:fs';

export const BASE_URLS = {
  demo: 'https://external-api.demo.kalshi.co',
  prod: 'https://external-api.kalshi.com',
};
const PREFIX = '/trade-api/v2';

/** The exact string Kalshi signs. Exported for tests. */
export function signingString(timestampMs, method, pathWithQuery) {
  const path = String(pathWithQuery).split('?')[0];
  return `${timestampMs}${method.toUpperCase()}${path}`;
}

export function sign(privateKeyPem, message) {
  return crypto
    .sign('sha256', Buffer.from(message), {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString('base64');
}

/**
 * The V2 order body for "buy `count` contracts of `side` at `priceCents`".
 * Exported so the YES/NO translation is tested, not trusted.
 */
export function orderBody({ ticker, side, priceCents, count, clientOrderId, timeInForce = 'immediate_or_cancel' }) {
  if (side !== 'yes' && side !== 'no') throw new Error(`side must be yes|no, got ${side}`);
  if (!(Number.isInteger(priceCents) && priceCents >= 1 && priceCents <= 99)) {
    throw new Error(`price must be 1-99 cents, got ${priceCents}`);
  }
  if (!(Number.isInteger(count) && count >= 1)) throw new Error(`count must be a positive integer, got ${count}`);
  const yesPriceCents = side === 'yes' ? priceCents : 100 - priceCents;
  return {
    ticker,
    client_order_id: clientOrderId,
    side: side === 'yes' ? 'bid' : 'ask',
    count: `${count}.00`,
    price: (yesPriceCents / 100).toFixed(4),
    // Taker-only by default: an order either fills now at our price or is
    // cancelled. Nothing is left resting on the book while nobody is watching.
    time_in_force: timeInForce,
    self_trade_prevention_type: 'taker_at_cross',
    post_only: false,
    reduce_only: false,
  };
}

/** Deterministic id: the same intended order on the same day is never sent twice. */
export function clientOrderId(date, ticker, side) {
  const h = crypto.createHash('sha256').update(`${date}|${ticker}|${side}`).digest('hex').slice(0, 20);
  return `mlbbot-${date.replace(/-/g, '')}-${h}`;
}

export function createClient({ env = 'demo', keyId, privateKeyPath, fetchImpl = globalThis.fetch }) {
  const base = BASE_URLS[env];
  if (!base) throw new Error(`env must be demo or prod, got ${env}`);
  const privateKey = keyId && privateKeyPath ? fs.readFileSync(privateKeyPath, 'utf8') : null;
  const authed = Boolean(privateKey);

  async function request(method, path, body, attempt = 0) {
    const full = PREFIX + path;
    const headers = { accept: 'application/json' };
    if (authed) {
      const ts = String(Date.now());
      headers['KALSHI-ACCESS-KEY'] = keyId;
      headers['KALSHI-ACCESS-TIMESTAMP'] = ts;
      headers['KALSHI-ACCESS-SIGNATURE'] = sign(privateKey, signingString(ts, method, full));
    }
    if (body) headers['content-type'] = 'application/json';
    const res = await fetchImpl(base + full, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    // Rate limited: back off and retry reads. Orders are NOT retried here — a
    // 429 on an order is surfaced, and the deterministic client_order_id makes
    // a later run's retry safe instead.
    if (res.status === 429 && method === 'GET' && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
      return request(method, path, body, attempt + 1);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Kalshi ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  const requireAuth = () => {
    if (!authed) throw new Error('no Kalshi API key configured (keyId + privateKeyPath)');
  };

  return {
    env,
    authed,
    /** Public: every open market in a series. Pages through the cursor. */
    async markets(seriesTicker) {
      const out = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const q = `?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const body = await request('GET', `/markets${q}`);
        out.push(...(body?.markets || []));
        cursor = body?.cursor;
        if (!cursor) break;
      }
      return out;
    },
    orderbook: (ticker) => request('GET', `/markets/${encodeURIComponent(ticker)}/orderbook`),
    async balance() {
      requireAuth();
      return request('GET', '/portfolio/balance');
    },
    async positions() {
      requireAuth();
      const out = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const body = await request('GET', `/portfolio/positions?limit=1000&count_filter=position${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        out.push(...(body?.market_positions || []));
        cursor = body?.cursor;
        if (!cursor) break;
      }
      return out;
    },
    async restingOrders() {
      requireAuth();
      const body = await request('GET', '/portfolio/orders?status=resting&limit=1000');
      return body?.orders || [];
    },
    async placeOrder(order) {
      requireAuth();
      return request('POST', '/portfolio/events/orders', orderBody(order));
    },
  };
}
