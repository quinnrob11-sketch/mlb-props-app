// The 26 pre-registered tests of docs/MARKET-EDGE-SEARCH.md.
//
// Nothing here imports a model. Every rule is a function of quotes, tickers,
// clocks and Kalshi's own settlement values. Prices are taker prices: YES costs
// the yes ask, NO costs 100 - yes bid, and the fee is charged on every leg.
//
//   node tools/edge-scan.mjs --kcache ecache --split 2026-09-01 [--json out.json]
//
// --split is the last game date of the DISCOVERY window. The confirmation
// window is everything after it, and is reported separately so it can be
// ignored until the discovery pass is written down.

import fs from 'node:fs';
import path from 'node:path';
import { parseEventTicker, startMsOf, quoteAt, mulberry32, readJson } from './kalshi-common.mjs';
import { SERIES, arg, candleFile, marketsByDate, playerKey } from './market-edge.mjs';

const KCACHE = arg('--kcache', 'ecache');
const SPLIT = arg('--split', '2026-09-01');
const FEE_RATE = Number(arg('--fee-rate', '0.07'));
// The confirmation window is computed either way, but it is not printed unless
// it is asked for. The discovery pass gets written down first, and then this
// flag is turned on once.
const SHOW_CONFIRM = process.argv.includes('--confirm');

// ── money ───────────────────────────────────────────────────────────────────
/** src/trade/fees.js, unrounded: 0.07 * P * (1-P) per contract, in cents. */
export const feeCents = (priceCents, rate = FEE_RATE) => (rate * priceCents * (100 - priceCents)) / 100;

const settleValue = (m) => Number(m.settlement_value_dollars);
const payoutCents = (m, side) => (side === 'yes' ? 100 * settleValue(m) : 100 * (1 - settleValue(m)));

/** A taker buy of one contract, held to settlement. */
function trade(m, side, priceCents, extra = {}) {
  const fee = feeCents(priceCents);
  return {
    cluster: m.event_ticker,
    cost: priceCents + fee,
    pnl: payoutCents(m, side) - priceCents - fee,
    priceCents,
    ...extra,
  };
}

// ── statistics ──────────────────────────────────────────────────────────────
/**
 * ROI with a 95% cluster bootstrap over games, and the two-sided bootstrap
 * p-value the multiplicity correction consumes.
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
    for (let i = 0; i < cl.length; i++) {
      const k = cl[(rand() * cl.length) | 0];
      p += k[0]; c += k[1];
    }
    rois[b] = c ? p / c : 0;
  }
  const sorted = Array.from(rois).sort((a, b) => a - b);
  let le = 0, ge = 0;
  for (const r of sorted) { if (r <= 0) le++; if (r >= 0) ge++; }
  const p = Math.max(1 / boot, 2 * Math.min(le / boot, ge / boot));
  return {
    n,
    games: cl.length,
    pnlPerContract: pnl / n,
    roiPct: (100 * pnl) / cost,
    ci95: [100 * sorted[Math.floor(0.025 * boot)], 100 * sorted[Math.floor(0.975 * boot)]],
    p,
  };
}

/** Benjamini-Hochberg at q; returns the set of indices that survive. */
export function benjaminiHochberg(ps, q = 0.10) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let kMax = -1;
  for (let k = 0; k < order.length; k++) if (order[k][0] <= ((k + 1) / order.length) * q) kMax = k;
  return new Set(order.slice(0, kMax + 1).map((x) => x[1]));
}

// ── loading ─────────────────────────────────────────────────────────────────
const cache = new Map();
function loadSeries(series) {
  if (!cache.has(series)) {
    const f = path.join(KCACHE, `settled_${series}.json`);
    cache.set(series, readJson(f).markets);
  }
  return cache.get(series);
}
const loadCandles = (series, date) => {
  const f = candleFile(KCACHE, series, date);
  return fs.existsSync(f) ? readJson(f) : {};
};

const inDiscovery = (date) => date <= SPLIT;

/** Hour boundaries (unix seconds) from `from` to `to`. */
function hourGrid(fromMs, toMs) {
  const out = [];
  let t = Math.ceil(fromMs / 3600e3) * 3600e3;
  for (; t <= toMs; t += 3600e3) out.push(t);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Family A: internal consistency
// ═══════════════════════════════════════════════════════════════════════════
// YES(h) implies YES(l) with strike_h > strike_l. Buy YES(l) at its ask, sell
// YES(h) at its bid: the pair pays at least 100c and costs ask(l) + 100 - bid(h).
// Riskless profit iff bid(h) - ask(l) > fee(ask(l)) + fee(100 - bid(h)).
const LADDER_KEY = {
  KXMLBKS: playerKey, KXMLBHIT: playerKey, KXMLBTB: playerKey,
  KXMLBHRR: playerKey, KXMLBRBI: playerKey, KXMLBHR: playerKey,
  KXMLBTOTAL: () => 'game',
  KXMLBSPREAD: (m) => m.custom_strike?.baseball_team || null,
};

function ladderScan(series) {
  const keyOf = LADDER_KEY[series];
  const byDate = marketsByDate(loadSeries(series));
  const res = { discovery: emptyArb(), confirm: emptyArb() };
  for (const [date, markets] of byDate) {
    const bucket = inDiscovery(date) ? res.discovery : res.confirm;
    const candles = loadCandles(series, date);
    // group into ladders
    const ladders = new Map();
    for (const m of markets) {
      const k = keyOf(m);
      if (k == null || m.floor_strike == null || m.strike_type !== 'greater') continue;
      const id = `${m.event_ticker}|${k}`;
      if (!ladders.has(id)) ladders.set(id, []);
      ladders.get(id).push(m);
    }
    for (const [id, rungs] of ladders) {
      if (rungs.length < 2) continue;
      rungs.sort((a, b) => a.floor_strike - b.floor_strike);
      const p = parseEventTicker(rungs[0].event_ticker);
      const T = startMsOf(p);
      const openMs = Math.min(...rungs.map((m) => Date.parse(m.open_time)));
      for (const ts of hourGrid(Math.max(openMs, T - 12 * 3600e3), T)) {
        const q = rungs.map((m) => quoteAt(candles[m.ticker], ts));
        bucket.snapshots++;
        let best = null;
        for (let i = 0; i < rungs.length; i++) {
          for (let j = i + 1; j < rungs.length; j++) {
            const lo = q[i], hi = q[j];
            if (!lo?.ask || !hi?.bid) continue;
            bucket.pairs++;
            const gross = hi.bid - lo.ask;
            if (gross > bucket.maxGross) bucket.maxGross = gross;
            if (gross === 0) bucket.locked++;
            if (gross <= 0) continue;
            const net = gross - feeCents(lo.ask) - feeCents(100 - hi.bid);
            if (net <= 0) { bucket.grossOnly++; continue; }
            // "fresh" means both sides printed a candle inside the snapshot
            // hour. A carried-forward quote is the endpoint saying nothing
            // changed, which is usually true and occasionally just silence.
            const fresh = lo.ts * 1000 > ts - 3600e3 && hi.ts * 1000 > ts - 3600e3;
            if (!best || net > best.net) {
              best = { net, gross, ts, id, date, fresh, lo: rungs[i].ticker, hi: rungs[j].ticker, askLo: lo.ask, bidHi: hi.bid };
            }
          }
        }
        if (best) { bucket.violations.push(best); bucket.netTotal += best.net; }
      }
    }
  }
  return res;
}
const emptyArb = () => ({ snapshots: 0, pairs: 0, grossOnly: 0, locked: 0, maxGross: -99, violations: [], netTotal: 0 });

// A9: the two sides of one game must sum to 100.
function moneylineScan() {
  const byDate = marketsByDate(loadSeries('KXMLBGAME'));
  const res = { discovery: emptyArb(), confirm: emptyArb() };
  for (const [date, markets] of byDate) {
    const bucket = inDiscovery(date) ? res.discovery : res.confirm;
    const candles = loadCandles('KXMLBGAME', date);
    const byEvent = new Map();
    for (const m of markets) {
      if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
      byEvent.get(m.event_ticker).push(m);
    }
    for (const [ev, pair] of byEvent) {
      if (pair.length !== 2) continue;
      const T = startMsOf(parseEventTicker(ev));
      const openMs = Math.min(...pair.map((m) => Date.parse(m.open_time)));
      for (const ts of hourGrid(Math.max(openMs, T - 12 * 3600e3), T)) {
        const a = quoteAt(candles[pair[0].ticker], ts);
        const b = quoteAt(candles[pair[1].ticker], ts);
        bucket.snapshots++;
        if (!a || !b) continue;
        bucket.pairs++;
        if (a.ask != null && b.ask != null) {
          const net = 100 - a.ask - b.ask - feeCents(a.ask) - feeCents(b.ask);
          if (100 - a.ask - b.ask > 0) {
            if (net > 0) { bucket.violations.push({ net, ts, date, kind: 'buy-both', id: ev, askLo: a.ask, bidHi: b.ask }); bucket.netTotal += net; }
            else bucket.grossOnly++;
          }
        }
        if (a.bid != null && b.bid != null) {
          const net = a.bid + b.bid - 100 - feeCents(100 - a.bid) - feeCents(100 - b.bid);
          if (a.bid + b.bid - 100 > 0) {
            if (net > 0) { bucket.violations.push({ net, ts, date, kind: 'sell-both', id: ev, askLo: a.bid, bidHi: b.bid }); bucket.netTotal += net; }
            else bucket.grossOnly++;
          }
        }
      }
    }
  }
  return res;
}

// A10: "wins by over 0.5 runs" IS the moneyline (baseball has no ties), and
// "wins by over k" for k > 0.5 implies it. Both are cross-series pairs on the
// same team in the same game.
const TEAM_OF = (m) => m.custom_strike?.baseball_team || null;
function mlVsSpreadScan() {
  const spreadByDate = marketsByDate(loadSeries('KXMLBSPREAD'));
  const gameByDate = marketsByDate(loadSeries('KXMLBGAME'));
  const res = { discovery: emptyArb(), confirm: emptyArb() };
  for (const [date, gm] of gameByDate) {
    const bucket = inDiscovery(date) ? res.discovery : res.confirm;
    const sp = spreadByDate.get(date) || [];
    const gc = loadCandles('KXMLBGAME', date);
    const sc = loadCandles('KXMLBSPREAD', date);
    // Key on teams + doubleheader leg + team, so the two legs of a
    // doubleheader are never matched against each other.
    const gkey = (m, t) => { const p = parseEventTicker(m.event_ticker); return `${p.teams}|${p.gameNumber || ''}|${t}`; };
    const mlBy = new Map();
    for (const m of gm) { const t = TEAM_OF(m); if (t) mlBy.set(gkey(m, t), m); }
    const spBy = new Map();
    for (const m of sp) {
      const t = TEAM_OF(m);
      if (!t || m.floor_strike == null) continue;
      const k = gkey(m, t);
      if (!spBy.has(k)) spBy.set(k, []);
      spBy.get(k).push(m);
    }
    for (const [k, ml] of mlBy) {
      const rungs = (spBy.get(k) || []).sort((a, b) => a.floor_strike - b.floor_strike);
      if (!rungs.length) continue;
      const T = startMsOf(parseEventTicker(ml.event_ticker));
      for (const ts of hourGrid(T - 12 * 3600e3, T)) {
        const qml = quoteAt(gc[ml.ticker], ts);
        bucket.snapshots++;
        if (!qml) continue;
        for (const r of rungs) {
          const qs = quoteAt(sc[r.ticker], ts);
          if (!qs) continue;
          bucket.pairs++;
          // spread rung is the harder leg: sell it, buy the moneyline.
          if (qs.bid != null && qml.ask != null) {
            const gross = qs.bid - qml.ask;
            if (gross > 0) {
              const net = gross - feeCents(qml.ask) - feeCents(100 - qs.bid);
              if (net > 0) { bucket.violations.push({ net, gross, ts, date, id: k, lo: ml.ticker, hi: r.ticker, askLo: qml.ask, bidHi: qs.bid }); bucket.netTotal += net; }
              else bucket.grossOnly++;
            }
          }
          // at exactly 0.5 the two are the same event, so the other direction
          // is an arbitrage too.
          if (r.floor_strike === 0.5 && qml.bid != null && qs.ask != null) {
            const gross = qml.bid - qs.ask;
            if (gross > 0) {
              const net = gross - feeCents(qs.ask) - feeCents(100 - qml.bid);
              if (net > 0) { bucket.violations.push({ net, gross, ts, date, id: k, lo: r.ticker, hi: ml.ticker, askLo: qs.ask, bidHi: qml.bid }); bucket.netTotal += net; }
              else bucket.grossOnly++;
            }
          }
        }
      }
    }
  }
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// Families C, D, E: one pass over every market with a quote
// ═══════════════════════════════════════════════════════════════════════════
const BUCKETS = [
  ['C1', 1, 5, 'no'], ['C2', 6, 10, 'no'], ['C3', 11, 20, 'no'], ['C4', 21, 35, 'no'],
  ['C5', 36, 64, 'no'], ['C6', 65, 79, 'yes'], ['C7', 80, 89, 'yes'], ['C8', 90, 94, 'yes'],
  ['C9', 95, 99, 'yes'],
];
const bucketOf = (mid) => BUCKETS.find((b) => mid >= b[1] && mid <= b[2]);

function pricePass() {
  const out = {
    C: Object.fromEntries(BUCKETS.map((b) => [b[0], { discovery: [], confirm: [] }])),
    D1: { discovery: [], confirm: [] },
    D2: { discovery: [], confirm: [] },
    D3early: { discovery: [], confirm: [] },
    D3late: { discovery: [], confirm: [] },
    E2: { discovery: [], confirm: [] },
    E1rows: [],
    coverage: { markets: 0, quoted: 0 },
  };
  for (const series of SERIES) {
    const byDate = marketsByDate(loadSeries(series));
    for (const [date, markets] of byDate) {
      const w = inDiscovery(date) ? 'discovery' : 'confirm';
      const candles = loadCandles(series, date);
      for (const m of markets) {
        out.coverage.markets++;
        const p = parseEventTicker(m.event_ticker);
        const T = startMsOf(p);
        const c = candles[m.ticker];
        if (!c || !c.length) continue;
        const q1 = quoteAt(c, T - 3600e3);       // T-1h
        const q6 = quoteAt(c, T - 6 * 3600e3);   // T-6h
        const qT = quoteAt(c, T);                // first pitch

        // E1: scalar settlements (scratched starters). Recorded, not traded.
        if (m.result === 'scalar' && q1?.mid != null) {
          out.E1rows.push({ date, series, ticker: m.ticker, mid: q1.mid, bid: q1.bid, ask: q1.ask, sv: settleValue(m), w });
        }
        if (m.result !== 'yes' && m.result !== 'no') continue;

        if (q1 && q1.mid != null) {
          out.coverage.quoted++;
          const b = bucketOf(q1.mid);
          if (b) {
            const side = b[3];
            const price = side === 'yes' ? q1.ask : 100 - q1.bid;
            if (price >= 1 && price <= 99) {
              const t = trade(m, side, price, { series, date, mid: q1.mid });
              out.C[b[0]][w].push(t);
              // D3: listed more than 24h before first pitch, or not.
              const early = T - Date.parse(m.open_time) > 24 * 3600e3;
              out[early ? 'D3early' : 'D3late'][w].push(t);
              // E2: doubleheader legs only.
              if (p.gameNumber) out.E2[w].push(t);
            }
          }
        }

        // D1: buy yes at the ask at T-6h, sell at the bid at first pitch.
        if (q6?.ask != null && qT?.bid != null && q6.ask >= 1 && q6.ask <= 99) {
          const inFee = feeCents(q6.ask);
          const outFee = feeCents(qT.bid);
          out.D1[w].push({
            cluster: m.event_ticker,
            cost: q6.ask + inFee,
            pnl: qT.bid - q6.ask - inFee - outFee,
            priceCents: q6.ask,
            series, date,
          });
        }

        // D2: after an hourly mid move of >= 5c, fade it for one hour.
        for (let i = 2; i < c.length; i++) {
          const t2 = c[i][0] * 1000;
          if (t2 > T) break;
          const a = quoteAt(c, t2 - 2 * 3600e3);
          const b = quoteAt(c, t2 - 3600e3);
          const now = quoteAt(c, t2);
          const nxt = quoteAt(c, t2 + 3600e3);
          // The exit must be a quote that actually exists an hour later; a
          // carried-forward book would be an exit into our own entry.
          if (!a?.mid || !b?.mid || !now?.mid || !nxt || nxt.ts <= now.ts) continue;
          const move = now.mid - a.mid;
          if (Math.abs(move) < 5) continue;
          const side = move > 0 ? 'no' : 'yes';           // fade it
          const price = side === 'yes' ? now.ask : 100 - now.bid;
          const exitBid = side === 'yes' ? nxt.bid : 100 - nxt.ask;
          if (price == null || exitBid == null || price < 1 || price > 99) continue;
          const inFee = feeCents(price);
          const outFee = feeCents(exitBid);
          out.D2[w].push({
            cluster: m.event_ticker,
            cost: price + inFee,
            pnl: exitBid - price - inFee - outFee,
            priceCents: price,
            series, date,
          });
          break; // one fade per market, the first one
        }
      }
    }
    process.stderr.write(`  priced ${series}\r`);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
const results = { split: SPLIT, feeRate: FEE_RATE, tests: [], arb: {} };
const addTest = (id, label, tr) => {
  results.tests.push({ id, label, discovery: roiStats(tr.discovery), confirm: SHOW_CONFIRM ? roiStats(tr.confirm) : 'hidden' });
};

process.stderr.write('Family A: ladders\n');
const LADDERS = [
  ['A1', 'KXMLBKS'], ['A2', 'KXMLBHIT'], ['A3', 'KXMLBTB'], ['A4', 'KXMLBHRR'],
  ['A5', 'KXMLBRBI'], ['A6', 'KXMLBHR'], ['A7', 'KXMLBTOTAL'], ['A8', 'KXMLBSPREAD'],
];
for (const [id, s] of LADDERS) {
  const r = ladderScan(s);
  results.arb[id] = summarizeArb(s, r);
  process.stderr.write(`  ${id} ${s}: ${r.discovery.violations.length}+${r.confirm.violations.length} violations\n`);
}
results.arb.A9 = summarizeArb('KXMLBGAME moneyline sums to 100', moneylineScan());
results.arb.A10 = summarizeArb('moneyline vs run line', mlVsSpreadScan());

function summarizeArb(label, r) {
  const top = (v) => v.slice().sort((a, b) => b.net - a.net).slice(0, 5);
  const part = (b) => ({
    snapshots: b.snapshots, pairsQuoted: b.pairs,
    crossedButFeeEatsIt: b.grossOnly,
    lockedExactly: b.locked,
    maxGrossCents: b.maxGross,
    violations: b.violations.length,
    violationsFresh: b.violations.filter((v) => v.fresh).length,
    ladderHoursWithViolationPct: b.snapshots ? Number((100 * b.violations.length / b.snapshots).toFixed(3)) : null,
    netTotalCents: Number(b.netTotal.toFixed(1)),
    meanNetCents: b.violations.length ? Number((b.netTotal / b.violations.length).toFixed(2)) : null,
    top: top(b.violations).map((v) => ({ ...v, net: Number(v.net.toFixed(2)) })),
  });
  return { label, discovery: part(r.discovery), confirm: SHOW_CONFIRM ? part(r.confirm) : 'hidden' };
}

process.stderr.write('Families C, D, E\n');
const pp = pricePass();
results.coverage = pp.coverage;
for (const b of BUCKETS) addTest(b[0], `yes-mid ${b[1]}-${b[2]}c, buy ${b[3].toUpperCase()} at T-1h`, pp.C[b[0]]);
addTest('D1', 'buy yes at ask T-6h, sell at bid at first pitch', pp.D1);
addTest('D2', 'fade a >=5c hourly move for one hour', pp.D2);
addTest('D3', 'Family C rule, listed >24h before first pitch', pp.D3early);
addTest('D3b', 'Family C rule, listed same day (reference arm)', pp.D3late);
addTest('E2', 'Family C rule, doubleheader legs only', pp.E2);

// E1: scalar settlements. Not a traded rule yet - first, is the settlement
// value predictable from the last quote?
{
  const rows = pp.E1rows;
  const err = rows.map((r) => 100 * r.sv - r.mid);
  const mean = err.reduce((s, x) => s + x, 0) / (err.length || 1);
  const abs = err.map(Math.abs).sort((a, b) => a - b);
  results.E1 = {
    n: rows.length,
    meanSettleMinusMidCents: Number(mean.toFixed(2)),
    medianAbsCents: abs.length ? abs[Math.floor(abs.length / 2)] : null,
    p90AbsCents: abs.length ? abs[Math.floor(0.9 * abs.length)] : null,
    discoveryN: rows.filter((r) => r.w === 'discovery').length,
  };
  // The traded version: sell yes (buy NO) on every scalar market at T-1h.
  const tr = { discovery: [], confirm: [] };
  const index = new Map();
  for (const r of rows) {
    if (!index.has(r.series)) index.set(r.series, new Map(loadSeries(r.series).map((x) => [x.ticker, x])));
    const m = index.get(r.series).get(r.ticker);
    if (!m) continue;
    const price = 100 - r.bid;   // taker: a NO buy lifts 100 - yes bid
    if (price < 1 || price > 99) continue;
    tr[r.w].push(trade(m, 'no', price, { series: r.series }));
  }
  addTest('E1', 'buy NO at the ask on every market that settled scalar', tr);
}

// ── multiplicity ────────────────────────────────────────────────────────────
// 26 pre-registered tests. Fourteen of them (C1-C9, D1-D3, E1-E2) produce an
// ROI and therefore a bootstrap p-value. The ten Family A tests and the two
// Family B tests are judged by their own rule - an arbitrage does not have a
// p-value - so they enter Benjamini-Hochberg at p=1, which keeps the
// denominator at 26 and can only make the correction stricter for the rest.
// D3b is a reference arm for D3, not one of the 26, and is excluded.
const K = 26;
const scored = results.tests.filter((t) => t.id !== 'D3b');
const ps = [...scored.map((t) => t.discovery.p ?? 1), ...Array(K - scored.length).fill(1)];
const bh = benjaminiHochberg(ps, 0.10);
results.multiplicity = {
  preRegisteredTests: K,
  scoredWithPValues: scored.length,
  bonferroniAlpha: 0.05 / K,
  bhQ: 0.10,
  survivors: scored.filter((t, i) => bh.has(i)).map((t) => t.id),
};
for (let i = 0; i < scored.length; i++) {
  scored[i].survivesBH = bh.has(i);
  scored[i].survivesBonferroni = (scored[i].discovery.p ?? 1) <= 0.05 / K;
}

const outFile = arg('--json', null);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(JSON.stringify({ ...results, tests: results.tests.map((t) => ({ id: t.id, label: t.label, d: fmt(t.discovery), c: fmt(t.confirm), bh: t.survivesBH, bonf: t.survivesBonferroni })) }, null, 1));

function fmt(s) {
  if (s === 'hidden') return 'hidden';
  if (!s.n) return 'n=0';
  return `n=${s.n} g=${s.games} roi=${s.roiPct.toFixed(2)}% [${s.ci95[0].toFixed(2)}, ${s.ci95[1].toFixed(2)}] p=${s.p.toFixed(4)} pnl/c=${s.pnlPerContract.toFixed(2)}c`;
}
