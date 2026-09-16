// Bot track record: dedupe, fees, CLV sign, settlement, pending, aggregation.
// Synthetic journals and a stubbed fetch — no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  tickerStart, decisionsFrom, liveFill, closingFromCandles, settlementOf, gradeDecision,
  createMarketData, gradeAll, summarize, aggregate, wilson, meanInterval, priceBucket, edgeBucket, main,
} from '../bot/report.mjs';
import { paperFields } from '../bot/plan.mjs';

const T = 'KXMLBKS-26SEP161845PHIWSH-PHIZWHEELER45-7'; // 18:45 ET = 22:45Z
const FP = Date.parse('2026-09-16T22:45:00Z');
const FP_SEC = FP / 1000;
const AFTER = FP + 6 * 3600e3;

const dry = (over = {}) => ({ ts: '2026-09-16T14:30:00Z', live: false, env: 'prod', type: 'dry-run', ticker: T, side: 'yes', priceCents: 50, count: 10, costDollars: 5, edgePts: 4.2, kind: 'prop', marketKey: 'pitcher_strikeouts', ...over });
const candle = (endSec, bid, ask, last) => ({
  end_period_ts: endSec,
  yes_bid: bid == null ? {} : { close_dollars: (bid / 100).toFixed(4) },
  yes_ask: ask == null ? {} : { close_dollars: (ask / 100).toFixed(4) },
  price: last == null ? {} : { close_dollars: (last / 100).toFixed(4) },
});
const settledMarket = (yesDollars, result) => ({ ticker: T, status: 'finalized', result, settlement_value_dollars: yesDollars });

// ── time ───────────────────────────────────────────────────────────────────

test('ticker start time is US Eastern, DST-aware', () => {
  assert.equal(tickerStart(T).ms, FP);
  assert.equal(tickerStart(T).date, '2026-09-16');
  assert.equal(new Date(tickerStart('KXMLBGAME-26NOV031905PHIWSH-PHI').ms).toISOString(), '2026-11-04T00:05:00.000Z'); // EST
});

// ── dedupe ─────────────────────────────────────────────────────────────────

test('the same ticker and side across several dry runs counts once, at the first price', () => {
  const entries = [
    dry({ ts: '2026-09-16T16:30:00Z', priceCents: 55 }),
    dry({ ts: '2026-09-16T14:30:00Z', priceCents: 50 }),
    dry({ ts: '2026-09-16T18:30:00Z', priceCents: 58 }),
    dry({ ts: '2026-09-16T18:30:00Z', side: 'no', priceCents: 44 }),
    { type: 'skip', ticker: T, skip: 'whatever' },
    dry({ ts: '2026-09-16T14:30:00Z', live: true, type: 'order', response: { fill_count: '2.00' } }),
  ];
  const ds = decisionsFrom(entries);
  const yes = ds.filter((d) => d.side === 'yes' && d.mode === 'dry-run');
  assert.equal(yes.length, 1);
  assert.equal(yes[0].entryCents, 50);
  assert.equal(yes[0].runs, 3);
  assert.equal(ds.filter((d) => d.side === 'no').length, 1, 'a flip to the other side is its own decision');
  assert.equal(ds.filter((d) => d.mode === 'live').length, 1, 'live and dry run are kept apart');
  assert.equal(ds.length, 3);
});

// ── fees and settlement ────────────────────────────────────────────────────

test('dry-run P&L is after the un-ceilinged Kalshi fee', () => {
  const [d] = decisionsFrom([dry()]);
  assert.equal(d.feeCents, 17.5); // 10 x 0.07 x 50 x 50 / 100
  const win = gradeDecision(d, { market: settledMarket('1.0000', 'yes') }, AFTER);
  assert.equal(win.status, 'settled');
  assert.equal(win.won, true);
  assert.equal(win.pnlCents, 10 * 50 - 17.5);
  assert.equal(win.stakeCents, 517.5);
  const loss = gradeDecision(d, { market: settledMarket('0.0000', 'no') }, AFTER);
  assert.equal(loss.won, false);
  assert.equal(loss.pnlCents, -517.5);
});

test('a NO bet wins when YES settles to 0, and a fair-value settlement pays the fraction', () => {
  const [d] = decisionsFrom([dry({ side: 'no', priceCents: 30, count: 4 })]);
  const g = gradeDecision(d, { market: settledMarket('0.0000', 'no') }, AFTER);
  assert.equal(g.payoutCents, 100);
  assert.equal(g.pnlCents, 4 * 70 - 4 * 0.07 * 30 * 70 / 100);
  const scratched = gradeDecision(d, { market: { status: 'finalized', result: '', settlement_value_dollars: '0.6200' } }, AFTER);
  assert.equal(scratched.status, 'settled');
  assert.equal(scratched.payoutCents, 38);
});

test('unsettled markets are pending, not dropped', () => {
  const [d] = decisionsFrom([dry()]);
  for (const market of [null, { status: 'active', result: '' }, { status: 'closed', result: '' }, { status: 'disputed', result: 'yes' }]) {
    const g = gradeDecision(d, { market }, AFTER);
    assert.equal(g.status, 'pending');
    assert.equal(g.pnlCents, undefined);
  }
  assert.equal(settlementOf({ status: 'determined', result: 'yes' }).yesPayoutCents, 100);
});

// ── closing price and CLV ──────────────────────────────────────────────────

test('the close is the last pre-first-pitch mid, carried forward; in-game candles are ignored', () => {
  const candles = [
    candle(FP_SEC - 3600, 40, 44, 42),
    candle(FP_SEC - 60, 54, null, 55), // only the bid printed this minute
    candle(FP_SEC, null, 58, null), // ends exactly at first pitch: included
    candle(FP_SEC + 60, 90, 92, 91), // in-game
  ];
  const c = closingFromCandles(candles, FP_SEC);
  assert.equal(c.yesBid, 54);
  assert.equal(c.yesAsk, 58);
  assert.equal(c.yesCents, 56);
  assert.equal(c.source, 'mid');
  const oneSided = closingFromCandles([candle(FP_SEC - 60, 0, 100, 61)], FP_SEC);
  assert.equal(oneSided.source, 'last');
  assert.equal(oneSided.yesCents, 61);
  assert.equal(closingFromCandles([candle(FP_SEC + 60, 50, 52, 51)], FP_SEC), null);
});

test('CLV sign: YES beats the close when YES rises; NO beats it when YES falls', () => {
  const [yes] = decisionsFrom([dry({ priceCents: 50 })]);
  const up = [candle(FP_SEC - 60, 54, 56, 55)];
  const gy = gradeDecision(yes, { candles: up }, AFTER);
  assert.equal(gy.clvCents, 5);
  assert.equal(gy.beatClose, true);

  const [no] = decisionsFrom([dry({ side: 'no', priceCents: 45 })]);
  const gnUp = gradeDecision(no, { candles: up }, AFTER); // NO close = 45
  assert.equal(gnUp.close.sideCents, 45);
  assert.equal(gnUp.clvCents, 0);
  assert.equal(gnUp.beatClose, false);
  const down = [candle(FP_SEC - 60, 48, 50, 49)]; // NO close = 51
  const gnDown = gradeDecision(no, { candles: down }, AFTER);
  assert.equal(gnDown.clvCents, 6);
  assert.equal(gnDown.beatClose, true);

  const before = gradeDecision(yes, { candles: up }, FP - 60e3);
  assert.equal(before.clvCents, null, 'no close before first pitch');
});

test('journal firstPitch wins over the ticker time (doubleheaders, reschedules)', () => {
  const [d] = decisionsFrom([dry({ firstPitch: '2026-09-16T23:10:00Z' })]);
  const late = Date.parse('2026-09-16T23:10:00Z') / 1000;
  const g = gradeDecision(d, { candles: [candle(FP_SEC - 60, 40, 42, 41), candle(late - 60, 60, 62, 61)] }, AFTER);
  assert.equal(g.close.yesCents, 61);
});

// ── live fills ─────────────────────────────────────────────────────────────

test('live orders grade on actual fills: count, YES-leg average price, fee paid', () => {
  const no = liveFill({ side: 'no', priceCents: 71, response: { fill_count: '4.00', average_fill_price: '0.3000', average_fee_paid: '0.0147' } });
  assert.equal(no.count, 4);
  assert.equal(no.entryCents, 70);
  assert.ok(Math.abs(no.feeCents - 5.88) < 1e-9);
  const yes = liveFill({ side: 'yes', priceCents: 42, response: { fill_count: '3.00', average_fill_price: '0.4100' } });
  assert.equal(yes.entryCents, 41);
  const [unfilled] = decisionsFrom([dry({ type: 'order', live: true, response: { fill_count: '0.00', remaining_count: '10.00' } })]);
  const g = gradeDecision(unfilled, { market: settledMarket('1.0000', 'yes') }, AFTER);
  assert.equal(g.status, 'unfilled');
  assert.equal(summarize([g]).count, 0);
  assert.equal(summarize([g]).unfilled, 1);
});

// ── aggregation ────────────────────────────────────────────────────────────

test('interval helpers', () => {
  const [lo, hi] = wilson(5, 10);
  assert.ok(Math.abs(lo - 0.2366) < 1e-3 && Math.abs(hi - 0.7634) < 1e-3);
  assert.equal(wilson(0, 0), null);
  const m = meanInterval([1, 2, 3, 4]);
  assert.equal(m.mean, 2.5);
  assert.ok(Math.abs(m.ci[1] - (2.5 + (1.96 * Math.sqrt(5 / 3)) / 2)) < 1e-9);
  assert.equal(meanInterval([7]).ci, null);
  assert.equal(priceBucket(24), '<25c');
  assert.equal(priceBucket(70), '70c+');
  assert.equal(edgeBucket(3), '3-5pts');
  assert.equal(edgeBucket(null), 'unknown');
});

test('aggregation: counts, win rate, units, ROI, CLV and groupings', () => {
  const T2 = T.replace('-7', '-8');
  const T3 = T.replace('-7', '-9');
  const ds = decisionsFrom([
    dry({ priceCents: 50, count: 10 }), // wins
    dry({ ticker: T2, side: 'no', priceCents: 40, count: 5, kind: 'prop', edgePts: 6 }), // loses
    dry({ ticker: T3, priceCents: 20, count: 1, kind: 'game', marketKey: 'game_ml' }), // pending
  ]);
  const data = {
    [T]: { market: settledMarket('1.0000', 'yes'), candles: [candle(FP_SEC - 60, 52, 54, 53)] }, // clv +3
    [T2]: { market: settledMarket('1.0000', 'yes'), candles: [candle(FP_SEC - 60, 58, 62, 60)] }, // NO close 40, clv 0
    [T3]: { market: { status: 'active' }, candles: null },
  };
  const graded = ds.map((d) => gradeDecision(d, data[d.ticker], AFTER));
  const s = summarize(graded);
  assert.equal(s.count, 3);
  assert.equal(s.settled, 2);
  assert.equal(s.pending, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.winRatePct, 50);
  const r1 = (500 - 17.5) / 517.5;
  const fee2 = 5 * 0.07 * 40 * 60 / 100;
  const r2 = -1;
  assert.equal(s.units, Math.round((r1 + r2) * 1000) / 1000);
  assert.equal(s.roiPct, Math.round(((r1 + r2) / 2) * 1000) / 10);
  assert.ok(s.roiCiPct[0] < s.roiPct && s.roiCiPct[1] > s.roiPct);
  assert.equal(s.pnlDollars, Math.round((500 - 17.5 - 200 - fee2)) / 100);
  assert.equal(s.withClose, 2);
  assert.equal(s.meanClvCents, 1.5);
  assert.equal(s.beatClosePct, 50);

  const { overall, groups } = aggregate(graded);
  assert.deepEqual(overall, s);
  assert.equal(groups.kind.prop.count, 2);
  assert.equal(groups.kind.game.pending, 1);
  assert.equal(groups.side.no.wins, 0);
  assert.equal(groups.mode['dry-run'].count, 3);
  assert.equal(groups.priceBucket['<25c'].count, 1);
  assert.equal(groups.edgeBucket['5-8pts'].settled, 1);
});

// ── fetching ───────────────────────────────────────────────────────────────

const LIVE_MARKET = new RegExp(`/trade-api/v2/markets/${T}$`);
const HIST_MARKET = new RegExp(`/trade-api/v2/historical/markets/${T}$`);
const LIVE_CANDLES = new RegExp(`/trade-api/v2/series/KXMLBKS/markets/${T}/candlesticks$`);
const HIST_CANDLES = new RegExp(`/trade-api/v2/historical/markets/${T}/candlesticks$`);

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [pattern, handler] of routes) {
      if (pattern.test(url.split('?')[0])) {
        const r = typeof handler === 'function' ? handler(url, calls) : handler;
        return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, headers: new Map(Object.entries(r.headers || {})), json: async () => r.body };
      }
    }
    return { status: 404, ok: false, headers: new Map(), json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('market data: backs off on 429, falls back to historical, caches only settled/closed data', async () => {
  let hits429 = 0;
  const { fetchImpl, calls } = stubFetch([
    [LIVE_CANDLES, () => ({ status: 404 })],
    [HIST_CANDLES, { body: { candlesticks: [candle(FP_SEC - 60, 54, 56, 55)] } }],
    [HIST_MARKET, { body: { market: settledMarket('1.0000', 'yes') } }],
    [LIVE_MARKET, () => (hits429++ < 1 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 404 })],
  ]);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botreport-'));
  const sleeps = [];
  const data = createMarketData({ fetchImpl, cacheDir, sleep: async (ms) => sleeps.push(ms), minGapMs: 0 });
  const [d] = decisionsFrom([dry()]);
  const [g] = await gradeAll([d], data, AFTER);
  assert.equal(g.status, 'settled');
  assert.equal(g.clvCents, 5);
  assert.ok(sleeps.includes(1000), 'honours Retry-After');
  assert.ok(calls.some((u) => u.startsWith('https://api.elections.kalshi.com/trade-api/v2/')));
  assert.ok(calls.every((u) => !/portfolio|orders/.test(u)), 'public endpoints only');

  // Second pass is served from the cache.
  const before = calls.length;
  const offline = createMarketData({ fetchImpl, cacheDir, offline: true });
  const [again] = await gradeAll([d], offline, AFTER);
  assert.equal(calls.length, before);
  assert.equal(again.status, 'settled');
  assert.equal(again.clvCents, 5);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('nothing is fetched for a close before first pitch; open markets are not cached', async () => {
  const { fetchImpl, calls } = stubFetch([[LIVE_MARKET, { body: { market: { ticker: T, status: 'active' } } }]]);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botreport-'));
  const data = createMarketData({ fetchImpl, cacheDir, minGapMs: 0 });
  const [d] = decisionsFrom([dry()]);
  const [g] = await gradeAll([d], data, FP - 3600e3);
  assert.equal(g.status, 'pending');
  assert.equal(calls.filter((u) => u.includes('candlesticks')).length, 0);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('CLI end to end: journals in, report.json and a self-contained report.html out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botreport-'));
  const lines = [dry(), dry({ ts: '2026-09-16T16:30:00Z', priceCents: 57 }), { type: 'skip', ticker: T, skip: 'x' }, { type: 'order-error', ticker: T, side: 'yes' }];
  fs.writeFileSync(path.join(dir, '2026-09-16.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"torn');
  const { fetchImpl } = stubFetch([
    [LIVE_CANDLES, { body: { candlesticks: [candle(FP_SEC - 60, 44, 46, 45)] } }],
    [LIVE_MARKET, { body: { market: settledMarket('0.0000', 'no') } }],
  ]);
  const log = console.log;
  console.log = () => {};
  let report;
  try {
    report = await main(['--dir', dir, '--no-cache'], { fetchImpl, nowMs: AFTER });
  } finally {
    console.log = log;
  }
  assert.equal(report.decisions.length, 1);
  assert.equal(report.orderErrors, 1);
  assert.equal(report.decisions[0].runs, 2);
  assert.equal(report.decisions[0].clvCents, -5);
  assert.equal(report.decisions[0].won, false);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(json.overall.settled, 1);
  const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<script|<link|src=|https?:\/\//, 'no external assets');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── journal additions ──────────────────────────────────────────────────────

test('orders carry what the grader needs: first pitch, series, player key, book', () => {
  const market = { ticker: T, series: 'KXMLBKS', eventTicker: 'KXMLBKS-26SEP161845PHIWSH', raw: { floor_strike: 6.5 } };
  const info = { game: { gamePk: 7, gameDate: '2026-09-16T22:45:00Z' }, person: { name: 'Zack Wheeler' }, line: 6.5 };
  const f = paperFields(market, info, { modelProb: 0.41234 }, { bestYesBid: 55, bestYesAsk: 57 });
  assert.deepEqual(f, {
    series: 'KXMLBKS', eventTicker: 'KXMLBKS-26SEP161845PHIWSH', gamePk: 7, firstPitch: '2026-09-16T22:45:00Z',
    playerKey: '26SEP161845PHIWSH:PHIZWHEELER45', player: 'Zack Wheeler', line: 6.5, modelSide: 0.412, yesBid: 55, yesAsk: 57,
  });
});
