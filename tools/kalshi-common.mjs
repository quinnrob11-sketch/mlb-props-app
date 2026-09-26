// Shared plumbing for the Kalshi price backtests (tools/backtest-kalshi*.mjs).
//
// Kalshi PUBLIC endpoints only (no auth, no orders). Every response is cached
// on disk; requests are serialised with a minimum gap and back off on 429/5xx.
// Also: ticker parsing that understands doubleheader suffixes, top-of-book
// reads from candlesticks, and the statistics both studies report (cluster
// bootstrap ROI, paired Brier differences, calibration bins).

import fs from 'node:fs';
import path from 'node:path';

export const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ── fetch: serialised, cached, polite ───────────────────────────────────────
let lastRequest = 0;
let requestCount = 0;
export const kalshiRequestCount = () => requestCount;
export async function kget(url, { gapMs = 250 } = {}) {
  for (let attempt = 0; ; attempt++) {
    // Reserve the next start slot before waiting, so concurrent callers
    // (at most two lanes) still keep `gapMs` between request starts.
    const slot = Math.max(Date.now(), lastRequest + gapMs);
    lastRequest = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    requestCount++;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) throw new Error(`${res.status} after retries: ${url}`);
      await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

const DROP = ['rules_primary', 'rules_secondary', 'price_ranges', 'custom_strike', 'early_close_condition'];

/**
 * Every settled market in a series (live tier), cached as one file per series
 * (`settled_<SERIES>.json`). `keep`, when given, stores only those fields
 * (the batter series are ~10x the pitcher series).
 */
export async function settledMarkets(kcache, series, { keep = null } = {}) {
  const file = path.join(kcache, `settled_${series}.json`);
  if (fs.existsSync(file)) return readJson(file).markets;
  const markets = [];
  let cursor = '';
  do {
    const body = await kget(`${KALSHI}/markets?series_ticker=${series}&status=settled&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const m of body.markets || []) {
      if (keep) markets.push(Object.fromEntries(keep.filter((k) => k in m).map((k) => [k, m[k]])));
      else {
        for (const k of DROP) delete m[k];
        markets.push(m);
      }
    }
    cursor = body.cursor || '';
    process.stderr.write(`  ${series}: ${markets.length} settled markets\r`);
  } while (cursor);
  process.stderr.write('\n');
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), markets }));
  return markets;
}

// ── tickers ─────────────────────────────────────────────────────────────────
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/**
 * Like `parseKalshiGameTicker` (src/data/teamMarkets.js), but also accepts the
 * doubleheader suffix Kalshi appends (`KXMLBKS-26SEP041915DETCLEG2`):
 * -> { date, etMinutes, teams: 'DETCLE', gameNumber: 2 | null }.
 */
export function parseEventTicker(eventTicker) {
  const m = /^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+?)(?:G([12]))?$/.exec(String(eventTicker || ''));
  if (!m || MONTHS[m[2]] == null) return null;
  const month = String(MONTHS[m[2]] + 1).padStart(2, '0');
  return {
    date: `20${m[1]}-${month}-${m[3]}`,
    etMinutes: Number(m[4]) * 60 + Number(m[5]),
    teams: m[6],
    gameNumber: m[7] ? Number(m[7]) : null,
  };
}

/** Scheduled first pitch (UTC ms) from the ET time in a parsed event ticker. */
export function startMsOf(p) {
  if (!p) return null;
  const [y, mo, d] = p.date.split('-').map(Number);
  const h = Math.floor(p.etMinutes / 60);
  const mi = p.etMinutes % 60;
  // Guess EDT, then correct by whatever offset New York actually had.
  let ms = Date.UTC(y, mo - 1, d, h + 4, mi);
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const etH = Number(et.find((x) => x.type === 'hour').value);
  if (etH !== h) ms += (h - etH) * 3600e3;
  return ms;
}

// ── candles ─────────────────────────────────────────────────────────────────
const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));

/**
 * Batch candlesticks for `tickers` over [startTs, endTs] at `period` minutes,
 * compacted to ticker -> [[end_ts, yesBidCents, yesAskCents], ...]. The
 * endpoint refuses a request whose tickers x periods exceeds 10,000; requests
 * are also capped at `maxTickers` tickers to keep the URL short.
 */
export async function fetchCandles(tickers, startTs, endTs, period, { maxTickers = 100 } = {}) {
  const out = {};
  const perRequest = Math.max(1, Math.min(maxTickers, Math.floor(10000 / (Math.ceil((endTs - startTs) / (60 * period)) + 2))));
  for (let i = 0; i < tickers.length; i += perRequest) {
    const chunk = tickers.slice(i, i + perRequest);
    const body = await kget(`${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=${period}`);
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [c.end_period_ts, cents(c.yes_bid?.close_dollars), cents(c.yes_ask?.close_dollars)]);
    }
    for (const t of chunk) out[t] ||= [];
  }
  return out;
}

/** Top of book as of `ms`: the last candle ending at or before it. */
export function quoteAt(candles, ms) {
  const ts = ms / 1000;
  let q = null;
  for (const c of candles || []) {
    if (c[0] > ts) break;
    q = c;
  }
  if (!q) return null;
  const bid = q[1] > 0 ? q[1] : null;
  const ask = q[2] != null && q[2] < 100 ? q[2] : null;
  return { ts: q[0], bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : null };
}

// ── statistics ──────────────────────────────────────────────────────────────
export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * ROI with a 95% cluster bootstrap over games, and the two-sided bootstrap
 * p-value a multiplicity correction consumes. Trades carry `{cluster, cost, pnl}`
 * in cents. Shared by tools/edge-scan.mjs, tools/scratch-scan.mjs and
 * tools/steam-scan.mjs, which are analyses rather than modules (each runs at
 * import), so the statistics live here instead of in any one of them.
 */
export function roiStats(trades, { boot = 5000, seed = 20260923 } = {}) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const byCluster = new Map();
  for (const t of trades) {
    if (!byCluster.has(t.cluster)) byCluster.set(t.cluster, [0, 0]);
    const c = byCluster.get(t.cluster);
    c[0] += t.pnl; c[1] += t.cost;
  }
  const cl = [...byCluster.values()];
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const cost = trades.reduce((s, t) => s + t.cost, 0);
  const rand = mulberry32(seed);
  const rois = new Float64Array(boot);
  for (let b = 0; b < boot; b++) {
    let p = 0, c = 0;
    for (let i = 0; i < cl.length; i++) { const k = cl[(rand() * cl.length) | 0]; p += k[0]; c += k[1]; }
    rois[b] = c ? p / c : 0;
  }
  const sorted = Array.from(rois).sort((a, b) => a - b);
  let le = 0, ge = 0;
  for (const r of sorted) { if (r <= 0) le++; if (r >= 0) ge++; }
  return {
    n, games: cl.length,
    pnlPerContract: pnl / n,
    totalPnlCents: pnl,
    roiPct: (100 * pnl) / cost,
    ci95: [100 * sorted[Math.floor(0.025 * boot)], 100 * sorted[Math.floor(0.975 * boot)]],
    p: Math.max(1 / boot, 2 * Math.min(le / boot, ge / boot)),
  };
}

/** Benjamini-Hochberg at q; returns the set of indices that survive. */
export function benjaminiHochberg(ps, q = 0.10) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let kMax = -1;
  for (let k = 0; k < order.length; k++) if (order[k][0] <= ((k + 1) / order.length) * q) kMax = k;
  return new Set(order.slice(0, kMax + 1).map((x) => x[1]));
}

/** ROI and mean P&L with a cluster bootstrap over `t.cluster` (rungs of one player-game are not independent). */
export function summarize(trades, { boot = 5000 } = {}) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const cost = trades.reduce((s, t) => s + t.priceCents + t.feeCents, 0);
  const pnl = trades.reduce((s, t) => s + t.pnlCents, 0);
  const wins = trades.filter((t) => t.pnlCents > 0).length;
  const withClose = trades.filter((t) => t.closeMidSide != null);
  const clvMid = withClose.length ? withClose.reduce((s, t) => s + (t.closeMidSide - t.decisionMidSide), 0) / withClose.length : null;
  const clvPaid = withClose.length ? withClose.reduce((s, t) => s + (t.closeMidSide - t.priceCents), 0) / withClose.length : null;
  const beatClose = withClose.length ? withClose.filter((t) => t.closeMidSide > t.decisionMidSide).length / withClose.length : null;
  const worseClose = withClose.length ? withClose.filter((t) => t.closeMidSide < t.decisionMidSide).length / withClose.length : null;
  const beatClosePaid = withClose.length ? withClose.filter((t) => t.closeMidSide > t.priceCents).length / withClose.length : null;
  const expected = trades.reduce((s, t) => s + t.expectedWinSide, 0) / n; // average price-implied win prob (price/100)
  const clusters = new Map();
  for (const t of trades) {
    if (!clusters.has(t.cluster)) clusters.set(t.cluster, [0, 0]);
    const c = clusters.get(t.cluster);
    c[0] += t.pnlCents; c[1] += t.priceCents + t.feeCents;
  }
  const cl = [...clusters.values()];
  const rand = mulberry32(12345);
  const rois = [];
  for (let b = 0; b < boot; b++) {
    let p = 0, c = 0;
    for (let i = 0; i < cl.length; i++) {
      const k = cl[Math.floor(rand() * cl.length)];
      p += k[0]; c += k[1];
    }
    rois.push(p / c);
  }
  rois.sort((a, b) => a - b);
  return {
    n,
    clusters: cl.length,
    hitRate: wins / n,
    avgPriceCents: trades.reduce((s, t) => s + t.priceCents, 0) / n,
    breakEvenHit: expected,
    pnlPerContractCents: pnl / n,
    roiPct: (100 * pnl) / cost,
    roiCI95: [100 * rois[Math.floor(0.025 * boot)], 100 * rois[Math.floor(0.975 * boot)]],
    clvMidCents: clvMid,
    clvVsPaidCents: clvPaid,
    pctBeatCloseMid: beatClose,
    pctWorseThanCloseMid: worseClose,
    pctCloseAbovePaid: beatClosePaid,
  };
}

export function scoring(rows, key) {
  let brier = 0, ll = 0;
  for (const r of rows) {
    const p = Math.min(0.999, Math.max(0.001, r[key]));
    brier += (p - r.y) ** 2;
    ll += -(r.y ? Math.log(p) : Math.log(1 - p));
  }
  return { brier: brier / rows.length, logLoss: ll / rows.length };
}

/** Paired Brier difference a - b (negative = a better), 95% cluster-bootstrap interval over `r.cluster`. */
export function brierDiff(rows, a, b, { boot = 5000 } = {}) {
  const clusters = new Map();
  for (const r of rows) {
    if (!clusters.has(r.cluster)) clusters.set(r.cluster, [0, 0]);
    const k = clusters.get(r.cluster);
    k[0] += (r[a] - r.y) ** 2 - (r[b] - r.y) ** 2;
    k[1] += 1;
  }
  const cl = [...clusters.values()];
  const point = cl.reduce((s, k) => s + k[0], 0) / rows.length;
  const rand = mulberry32(777);
  const d = [];
  for (let i = 0; i < boot; i++) {
    let x = 0, n = 0;
    for (let j = 0; j < cl.length; j++) {
      const k = cl[Math.floor(rand() * cl.length)];
      x += k[0]; n += k[1];
    }
    d.push(x / n);
  }
  d.sort((p, q) => p - q);
  return { point, ci95: [d[Math.floor(0.025 * boot)], d[Math.floor(0.975 * boot)]] };
}

export function calibrationBins(rows, key) {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r[key] * 10))];
    b.p += r[key]; b.y += r.y; b.n++;
  }
  return bins.filter((b) => b.n).map((b) => `${(100 * b.p / b.n).toFixed(0)}->${(100 * b.y / b.n).toFixed(0)} (${b.n})`);
}

/**
 * Diagnostic, not a tuning: the linear weight w on (model - market) that would
 * have minimised Brier on these same rows. ~0 means the model adds nothing the
 * price lacks.
 */
export function brierOptimalModelWeight(list) {
  let best = null;
  for (let w = 0; w <= 1.0001; w += 0.05) {
    const b = list.reduce((acc, x) => acc + (x.market + w * (x.model - x.market) - x.y) ** 2, 0) / list.length;
    if (!best || b < best.brier) best = { w: +w.toFixed(2), brier: b };
  }
  return best;
}

export const priceBucket = (c) => (c < 25 ? '15-24' : c < 40 ? '25-39' : c < 60 ? '40-59' : c < 75 ? '60-74' : '75-90');
