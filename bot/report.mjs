// Track record: grades every bot decision (dry run AND live) against Kalshi's
// closing price and the settlement result.
//
//   node bot/report.mjs                      grade bot/state/*.jsonl
//   node bot/report.mjs --dir path/to/state  another journal directory
//   node bot/report.mjs --out path/to/dir    write report.json / report.html elsewhere (default: --dir)
//   node bot/report.mjs --no-fetch           grade from the cache only (no network)
//
// Reads Kalshi PUBLIC market data only — no keys, no orders, nothing signed.
//
// Definitions (the same text is written into report.json under `definitions`):
//
//   DECISION   A journal entry of type "dry-run" (would have bought) or "order"
//              (sent live). Skips, errors and order-errors are not decisions.
//   DEDUPE     The scheduler runs the bot several times a day and a dry run
//              re-decides the same contract every time. Decisions are keyed by
//              mode (live/dry-run) + env + slate date + ticker + side; the
//              FIRST decision of the day for a key is the entry (its price,
//              size and edge). Later repeats only bump `runs`. A later flip to
//              the other side is a separate decision. Live orders that share a
//              key (only possible if a client id was reused) are combined into
//              one position at the fill-weighted average price.
//   ENTRY      Dry run: the journal's `priceCents` x `count` (the ask it would
//              have taken). Live: the order response's `fill_count` and
//              `average_fill_price` (quoted on the YES leg, so a NO fill costs
//              100 - that); a live order that filled nothing is "unfilled" and
//              is listed but never graded.
//   FEE        Kalshi taker fee 0.07 x P x (1 - P) per contract, un-ceilinged
//              (src/trade/fees.js feePerContractCents) x contracts. For live
//              fills the response's `average_fee_paid` is used when present.
//   FIRST PITCH  The journal's `firstPitch` (the schedule's gameDate), else the
//              start time embedded in the event ticker (US Eastern, e.g.
//              26SEP161845 = 2026-09-16 18:45 ET). Scheduled, not actual: a
//              rain delay does not move it.
//   CLOSE      From 1-minute candlesticks for the window [first pitch - 6h,
//              first pitch] (with include_latest_before_start, so a quiet
//              market still has its standing quote): the YES bid and YES ask as
//              of the last candle ending at or before first pitch, carried
//              forward through candles where a side did not print. Closing YES
//              price = the bid/ask midpoint when both sides exist (bid > 0 and
//              ask < 100); otherwise the last traded price as of that candle.
//              Kalshi MLB markets keep trading in-game (their close_time is
//              after the final out), so the market's own last price is NOT the
//              close. The close on the traded side is the YES close for YES and
//              100 - YES close for NO. Not available until first pitch passes.
//   CLV        close on the traded side - entry price, in cents per contract.
//              Positive = the market moved toward the bet = beat the close.
//   SETTLED    Market status determined/amended/finalized/settled with a
//              settlement value. YES pays settlement_value_dollars (1 or 0, or a
//              fair-value fraction when a player is scratched); NO pays 1 minus
//              that. Anything else is PENDING and still listed.
//   P&L        contracts x (payout on the traded side - entry) - fee.
//   STAKE      contracts x entry + fee.
//   UNITS      flat staking: every decision risks 1 unit, so units = sum of
//              P&L / stake. ROI % = mean of P&L / stake (flat), with a 95%
//              normal interval; dollar ROI % = total P&L / total stake at the
//              bot's actual sizes.
//   INTERVALS  95%: Wilson for win rate and % beating close; mean +/- 1.96 x
//              sd / sqrt(n) for ROI and CLV. Fewer than 2 observations: none.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feePerContractCents } from '../src/trade/fees.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PUBLIC_BASE = {
  prod: 'https://api.elections.kalshi.com/trade-api/v2',
  demo: 'https://external-api.demo.kalshi.co/trade-api/v2',
};
const CLOSE_WINDOW_SEC = 6 * 3600;
const SETTLED_STATUSES = new Set(['determined', 'amended', 'finalized', 'settled']);
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const dollarsToCents = (x) => (num(x) == null ? null : Math.round(Number(x) * 10000) / 100);
const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// ── time ──────────────────────────────────────────────────────────────────

/** UTC ms for a wall-clock time in America/New_York (DST-aware). */
export function easternToUtcMs(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms; // local - utc
  };
  let utc = guess - offsetAt(guess);
  utc = guess - offsetAt(utc); // second pass settles DST boundaries
  return utc;
}

/** Scheduled start embedded in a Kalshi MLB ticker, e.g. KXMLBKS-26SEP161845PHIWSH-… */
export function tickerStart(ticker) {
  const m = /^[A-Z0-9]+-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})[A-Z]+/.exec(String(ticker || ''));
  if (!m || !MONTHS[m[2]]) return null;
  const y = 2000 + Number(m[1]);
  const mo = MONTHS[m[2]];
  return {
    date: `${y}-${String(mo).padStart(2, '0')}-${m[3]}`,
    ms: easternToUtcMs(y, mo, Number(m[3]), Number(m[4]), Number(m[5])),
  };
}

export function firstPitchMs(decision) {
  const j = decision.firstPitch ? Date.parse(decision.firstPitch) : NaN;
  if (Number.isFinite(j)) return j;
  return tickerStart(decision.ticker)?.ms ?? null;
}

// ── journals ──────────────────────────────────────────────────────────────

export function readJournals(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        out.push({ ...JSON.parse(line), _file: name, _line: i + 1 });
      } catch {
        // A torn last line from a killed run is not fatal.
      }
    });
  }
  return out;
}

/** Live fill: {count, entryCents, feeCents} from a V2 order response. */
export function liveFill(entry) {
  const res = entry.response || {};
  const count = num(res.fill_count) ?? num(res.fill_count_fp) ?? 0;
  if (!(count > 0)) return { count: 0, entryCents: null, feeCents: 0 };
  const limit = num(entry.priceCents);
  const avg = dollarsToCents(res.average_fill_price);
  let entryCents = limit;
  if (avg != null) {
    if (entry.side === 'yes') entryCents = avg;
    else {
      // V2 quotes the YES leg (a NO buy is a YES ask at 100 - q). If that reading
      // would be worse than our own limit — impossible for an IOC fill — the
      // value is already on the NO leg.
      const yesLeg = 100 - avg;
      entryCents = limit == null || yesLeg <= limit + 1e-9 ? yesLeg : avg;
    }
  }
  const feePer = dollarsToCents(res.average_fee_paid);
  const feeCents = feePer != null ? feePer * count : feePerContractCents(entryCents) * count;
  return { count, entryCents, feeCents };
}

/**
 * Journal entries -> one decision per (mode, env, date, ticker, side); the first
 * of the day is the entry. See DEDUPE above.
 */
export function decisionsFrom(entries) {
  const byKey = new Map();
  const sorted = entries
    .filter((e) => (e.type === 'dry-run' || e.type === 'order') && e.ticker && e.side)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const e of sorted) {
    const mode = e.type === 'order' ? 'live' : 'dry-run';
    const date = e.date || (e._file ? e._file.slice(0, 10) : null) || tickerStart(e.ticker)?.date || null;
    const env = e.env || 'prod';
    const key = `${mode}|${env}|${date}|${e.ticker}|${e.side}`;
    const prev = byKey.get(key);
    if (prev && mode === 'dry-run') {
      prev.runs += 1;
      prev.lastSeenTs = e.ts;
      continue;
    }
    let count;
    let entryCents;
    let feeCents;
    if (mode === 'live') {
      ({ count, entryCents, feeCents } = liveFill(e));
    } else {
      count = num(e.count) ?? 0;
      entryCents = num(e.priceCents);
      feeCents = entryCents == null ? 0 : feePerContractCents(entryCents) * count;
    }
    if (prev) {
      // Live, same key: merge fills.
      const total = prev.count + count;
      if (count > 0) {
        prev.entryCents = total > 0 ? (prev.entryCents * prev.count + entryCents * count) / total : prev.entryCents;
        prev.count = total;
        prev.feeCents += feeCents;
      }
      prev.runs += 1;
      prev.lastSeenTs = e.ts;
      continue;
    }
    byKey.set(key, {
      key,
      mode,
      env,
      date,
      ts: e.ts,
      lastSeenTs: e.ts,
      runs: 1,
      ticker: e.ticker,
      side: e.side,
      series: e.series || String(e.ticker).split('-')[0],
      eventTicker: e.eventTicker || String(e.ticker).split('-').slice(0, 2).join('-'),
      kind: e.kind || (/^KXMLB(GAME|SPREAD|TOTAL)$/.test(String(e.ticker).split('-')[0]) ? 'game' : 'prop'),
      marketKey: e.marketKey || null,
      playerKey: e.playerKey || null,
      player: e.player || null,
      firstPitch: e.firstPitch || null,
      limitCents: num(e.priceCents),
      entryCents,
      count,
      feeCents,
      edgePts: num(e.edgePts),
      model: num(e.model),
      blended: num(e.blended),
      market: num(e.market),
      clientOrderId: e.clientOrderId || null,
    });
  }
  return [...byKey.values()];
}

// ── market data -> close and settlement ───────────────────────────────────

/** Closing YES quote as of `cutoffSec` from 1-minute candlesticks. See CLOSE. */
export function closingFromCandles(candles, cutoffSec) {
  const rows = (candles || [])
    .filter((c) => num(c.end_period_ts) != null && c.end_period_ts <= cutoffSec)
    .sort((a, b) => a.end_period_ts - b.end_period_ts);
  if (!rows.length) return null;
  let bid = null;
  let ask = null;
  let last = null;
  for (const c of rows) {
    bid = dollarsToCents(c.yes_bid?.close_dollars) ?? bid;
    ask = dollarsToCents(c.yes_ask?.close_dollars) ?? ask;
    last = dollarsToCents(c.price?.close_dollars) ?? dollarsToCents(c.price?.previous_dollars) ?? last;
  }
  const at = rows[rows.length - 1].end_period_ts;
  const twoSided = bid != null && ask != null && bid > 0 && ask < 100 && ask >= bid;
  if (twoSided) return { yesCents: (bid + ask) / 2, yesBid: bid, yesAsk: ask, last, source: 'mid', atSec: at };
  if (last != null) return { yesCents: last, yesBid: bid, yesAsk: ask, last, source: 'last', atSec: at };
  return null;
}

/** Settlement from a market payload. See SETTLED. */
export function settlementOf(market) {
  if (!market) return { settled: false, status: null };
  const status = market.status || null;
  let yesPayoutCents = dollarsToCents(market.settlement_value_dollars);
  if (yesPayoutCents == null && num(market.settlement_value) != null) yesPayoutCents = Number(market.settlement_value);
  if (yesPayoutCents == null && market.result === 'yes') yesPayoutCents = 100;
  if (yesPayoutCents == null && market.result === 'no') yesPayoutCents = 0;
  const settled = SETTLED_STATUSES.has(status) && yesPayoutCents != null;
  return { settled, status, result: market.result ?? null, yesPayoutCents: settled ? yesPayoutCents : null };
}

/** Grade one decision given fetched market data. Pure. */
export function gradeDecision(d, { market = null, candles = null } = {}, nowMs = Date.now()) {
  const fp = firstPitchMs(d);
  const g = { ...d, firstPitchMs: fp, status: 'pending', close: null, clvCents: null, beatClose: null, settlement: null };
  if (d.mode === 'live' && !(d.count > 0)) {
    g.status = 'unfilled';
    return g;
  }
  g.stakeCents = d.count * d.entryCents + d.feeCents;
  if (candles && fp != null && nowMs >= fp) {
    const c = closingFromCandles(candles, Math.floor(fp / 1000));
    if (c) {
      const sideCents = d.side === 'yes' ? c.yesCents : 100 - c.yesCents;
      g.close = { ...c, sideCents };
      g.clvCents = round(sideCents - d.entryCents, 2);
      g.beatClose = g.clvCents > 0;
    }
  }
  const s = settlementOf(market);
  g.settlement = { status: s.status, result: s.result ?? null, yesPayoutCents: s.yesPayoutCents ?? null };
  if (s.settled) {
    const payout = d.side === 'yes' ? s.yesPayoutCents : 100 - s.yesPayoutCents;
    g.status = 'settled';
    g.payoutCents = payout;
    g.won = payout > d.entryCents;
    g.pnlCents = round(d.count * (payout - d.entryCents) - d.feeCents, 4);
    g.returnOnStake = g.stakeCents > 0 ? g.pnlCents / g.stakeCents : null;
  }
  return g;
}

// ── fetching ──────────────────────────────────────────────────────────────

/**
 * Public Kalshi reads with a disk cache, at most `concurrency` requests at a
 * time, and exponential backoff on 429 (honouring Retry-After).
 */
export function createMarketData({ fetchImpl = globalThis.fetch, cacheDir = null, offline = false, concurrency = 2, minGapMs = 150, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let active = 0;
  const waiters = [];
  let lastStart = 0;
  const acquire = async () => {
    if (active >= concurrency) await new Promise((r) => waiters.push(r));
    active += 1;
    const gap = lastStart + minGapMs - Date.now();
    lastStart = Math.max(Date.now(), lastStart + minGapMs);
    if (gap > 0) await sleep(gap);
  };
  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };

  async function get(env, pathQ) {
    const base = PUBLIC_BASE[env] || PUBLIC_BASE.prod;
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let res;
      try {
        res = await fetchImpl(base + pathQ, { headers: { accept: 'application/json' } });
      } finally {
        release();
      }
      if (res.status === 429 && attempt < 6) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
        log(`429 on ${pathQ}; waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Kalshi GET ${pathQ} -> ${res.status}`);
      return res.json();
    }
  }

  const cachePath = (name) => (cacheDir ? path.join(cacheDir, name.replace(/[^A-Za-z0-9._-]/g, '_') + '.json') : null);
  const readCache = (name) => {
    const p = cachePath(name);
    if (!p || !fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const writeCache = (name, value) => {
    const p = cachePath(name);
    if (!p) return;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value));
  };

  return {
    /** Market payload; falls back to the historical endpoint for archived markets. Cached once settled. */
    async market(env, ticker) {
      const name = `market-${env}-${ticker}`;
      const hit = readCache(name);
      if (hit !== undefined) return hit;
      if (offline) return null;
      const t = encodeURIComponent(ticker);
      const body = (await get(env, `/markets/${t}`)) ?? (await get(env, `/historical/markets/${t}`));
      const market = body?.market ?? null;
      if (market && settlementOf(market).settled) writeCache(name, market);
      return market;
    },
    /** 1-minute candles for [firstPitch - 6h, firstPitch]; cached once first pitch is 10+ minutes past. */
    async candles(env, series, ticker, firstPitchMsValue, nowMs = Date.now()) {
      if (firstPitchMsValue == null || nowMs < firstPitchMsValue) return null;
      const name = `candles-${env}-${ticker}-${firstPitchMsValue}`;
      const hit = readCache(name);
      if (hit !== undefined) return hit;
      if (offline) return null;
      const end = Math.floor(firstPitchMsValue / 1000);
      const q = `?start_ts=${end - CLOSE_WINDOW_SEC}&end_ts=${end}&period_interval=1&include_latest_before_start=true`;
      const t = encodeURIComponent(ticker);
      const body =
        (await get(env, `/series/${encodeURIComponent(series)}/markets/${t}/candlesticks${q}`)) ??
        (await get(env, `/historical/markets/${t}/candlesticks${q}`));
      const candles = body?.candlesticks ?? null;
      if (candles && nowMs - firstPitchMsValue > 10 * 60e3) writeCache(name, candles);
      return candles;
    },
  };
}

export async function gradeAll(decisions, data, nowMs = Date.now()) {
  const out = new Array(decisions.length);
  await Promise.all(
    decisions.map(async (d, i) => {
      if (d.mode === 'live' && !(d.count > 0)) {
        out[i] = gradeDecision(d, {}, nowMs);
        return;
      }
      const fp = firstPitchMs(d);
      let market = null;
      let candles = null;
      let fetchError = null;
      try {
        [market, candles] = await Promise.all([data.market(d.env, d.ticker), data.candles(d.env, d.series, d.ticker, fp, nowMs)]);
      } catch (err) {
        fetchError = err.message;
      }
      out[i] = { ...gradeDecision(d, { market, candles }, nowMs), ...(fetchError ? { fetchError } : {}) };
    }),
  );
  return out;
}

// ── statistics ────────────────────────────────────────────────────────────

const Z = 1.96;

export function wilson(successes, n) {
  if (!(n > 0)) return null;
  const p = successes / n;
  const denom = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function meanInterval(xs) {
  const n = xs.length;
  if (!n) return { mean: null, ci: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { mean, ci: null };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const half = (Z * sd) / Math.sqrt(n);
  return { mean, ci: [mean - half, mean + half] };
}

export function priceBucket(cents) {
  if (cents == null) return 'unknown';
  if (cents < 25) return '<25c';
  if (cents < 40) return '25-39c';
  if (cents < 55) return '40-54c';
  if (cents < 70) return '55-69c';
  return '70c+';
}

export function edgeBucket(pts) {
  if (pts == null) return 'unknown';
  if (pts < 3) return '<3pts';
  if (pts < 5) return '3-5pts';
  if (pts < 8) return '5-8pts';
  return '8+pts';
}

export function summarize(graded) {
  const bets = graded.filter((g) => g.status !== 'unfilled');
  const settled = bets.filter((g) => g.status === 'settled');
  const wins = settled.filter((g) => g.won).length;
  const returns = settled.filter((g) => g.returnOnStake != null).map((g) => g.returnOnStake);
  const roi = meanInterval(returns);
  const stake = settled.reduce((s, g) => s + g.stakeCents, 0);
  const pnl = settled.reduce((s, g) => s + g.pnlCents, 0);
  const withClose = bets.filter((g) => g.clvCents != null);
  const clv = meanInterval(withClose.map((g) => g.clvCents));
  const beat = withClose.filter((g) => g.beatClose).length;
  const pct = (x) => (x == null ? null : round(100 * x, 1));
  return {
    count: bets.length,
    unfilled: graded.length - bets.length,
    settled: settled.length,
    pending: bets.length - settled.length,
    wins,
    winRatePct: settled.length ? pct(wins / settled.length) : null,
    winRateCiPct: wilson(wins, settled.length)?.map(pct) ?? null,
    stakeDollars: round(stake / 100),
    pnlDollars: round(pnl / 100),
    units: round(returns.reduce((s, r) => s + r, 0), 3),
    roiPct: pct(roi.mean),
    roiCiPct: roi.ci ? roi.ci.map(pct) : null,
    dollarRoiPct: stake > 0 ? pct(pnl / stake) : null,
    withClose: withClose.length,
    meanClvCents: round(clv.mean),
    clvCiCents: clv.ci ? clv.ci.map((x) => round(x)) : null,
    beatClosePct: withClose.length ? pct(beat / withClose.length) : null,
    beatCloseCiPct: wilson(beat, withClose.length)?.map(pct) ?? null,
    meanEdgePts: round(meanInterval(bets.filter((g) => g.edgePts != null).map((g) => g.edgePts)).mean, 2),
  };
}

export const GROUPINGS = {
  mode: (g) => g.mode,
  kind: (g) => g.kind || 'unknown',
  marketKey: (g) => g.marketKey || 'unknown',
  side: (g) => g.side,
  priceBucket: (g) => priceBucket(g.entryCents),
  edgeBucket: (g) => edgeBucket(g.edgePts),
};

export function aggregate(graded) {
  const groups = {};
  for (const [name, keyOf] of Object.entries(GROUPINGS)) {
    const buckets = new Map();
    for (const g of graded) {
      const k = keyOf(g);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(g);
    }
    groups[name] = Object.fromEntries([...buckets.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [k, summarize(v)]));
  }
  return { overall: summarize(graded), groups };
}

export const DEFINITIONS = {
  decision: 'journal entries of type dry-run or order; skips and errors are ignored',
  dedupe: 'one decision per mode+env+slate date+ticker+side; the first decision of the day is the entry, later runs only increment `runs`',
  entry: 'dry run: journal priceCents x count; live: response fill_count at average_fill_price (YES leg, so NO = 100 - it); zero fills = unfilled, not graded',
  fee: '0.07 x P x (1-P) per contract, un-ceilinged (src/trade/fees.js); live uses average_fee_paid when present',
  firstPitch: 'journal firstPitch (schedule gameDate), else the ET start time in the ticker; scheduled, not actual',
  close: 'YES bid/ask midpoint as of the last 1-minute candle ending at or before first pitch (window first pitch - 6h, carried forward); last trade if one-sided; traded-side close = YES close for yes, 100 - it for no',
  clv: 'close on traded side - entry price, cents per contract; > 0 = beat the close',
  settled: 'status determined/amended/finalized/settled with a settlement value; YES pays settlement_value_dollars, NO pays 1 - it',
  pnl: 'contracts x (payout - entry) - fee; stake = contracts x entry + fee',
  units: 'flat 1 unit per decision: units = sum(pnl/stake); roiPct = mean(pnl/stake); dollarRoiPct = sum(pnl)/sum(stake)',
  intervals: '95%: Wilson for win rate and beat-close; mean +/- 1.96 sd/sqrt(n) for ROI and CLV; none below n = 2',
};

export function buildReport(graded, { dir = null, nowMs = Date.now(), entriesRead = 0, orderErrors = 0 } = {}) {
  const { overall, groups } = aggregate(graded);
  const decisions = [...graded]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.ts).localeCompare(String(b.ts)))
    .map((g) => ({
      date: g.date, mode: g.mode, env: g.env, ts: g.ts, runs: g.runs, ticker: g.ticker, side: g.side, kind: g.kind, marketKey: g.marketKey,
      player: g.player, firstPitch: g.firstPitchMs != null ? new Date(g.firstPitchMs).toISOString() : null,
      count: g.count, entryCents: round(g.entryCents), feeCents: round(g.feeCents), edgePts: g.edgePts, model: g.model, blended: g.blended, market: g.market,
      status: g.status, closeSideCents: g.close ? round(g.close.sideCents) : null, closeSource: g.close?.source ?? null, clvCents: g.clvCents, beatClose: g.beatClose,
      settlementStatus: g.settlement?.status ?? null, result: g.settlement?.result ?? null, payoutCents: g.payoutCents ?? null, won: g.won ?? null,
      pnlDollars: g.pnlCents != null ? round(g.pnlCents / 100, 4) : null, stakeDollars: g.stakeCents != null ? round(g.stakeCents / 100, 4) : null,
      ...(g.fetchError ? { fetchError: g.fetchError } : {}),
    }));
  return { generatedAt: new Date(nowMs).toISOString(), dir, entriesRead, orderErrors, definitions: DEFINITIONS, overall, groups, decisions };
}

// ── rendering ─────────────────────────────────────────────────────────────

const ci = (arr, unit = '') => (arr ? `[${arr[0]}${unit}, ${arr[1]}${unit}]` : '');
const show = (x, unit = '') => (x == null ? '-' : `${x}${unit}`);

export function summaryRow(label, s) {
  return [
    label, s.count, s.settled, s.pending,
    s.winRatePct == null ? '-' : `${s.winRatePct}% ${ci(s.winRateCiPct)}`,
    show(s.units), s.roiPct == null ? '-' : `${s.roiPct}% ${ci(s.roiCiPct)}`,
    show(s.pnlDollars == null ? null : `$${s.pnlDollars}`),
    s.meanClvCents == null ? '-' : `${s.meanClvCents}c ${ci(s.clvCiCents)}`,
    s.beatClosePct == null ? '-' : `${s.beatClosePct}% ${ci(s.beatCloseCiPct)}`,
  ];
}
export const SUMMARY_HEAD = ['group', 'n', 'settled', 'pending', 'win % [95%]', 'units', 'ROI % [95%]', 'P&L', 'CLV [95%]', 'beat close % [95%]'];

function textTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ')).join('\n');
}

export function renderText(report) {
  const out = [];
  out.push(`Track record — ${report.decisions.length} decision(s) from ${report.entriesRead} journal line(s), generated ${report.generatedAt}`);
  out.push('');
  const rows = [SUMMARY_HEAD, summaryRow('OVERALL', report.overall)];
  for (const [name, buckets] of Object.entries(report.groups)) {
    for (const [k, s] of Object.entries(buckets)) rows.push(summaryRow(`${name}=${k}`, s));
  }
  out.push(textTable(rows));
  out.push('');
  const drows = [['date', 'mode', 'ticker', 'side', 'n', 'entry', 'edge', 'status', 'close', 'CLV', 'result', 'P&L']];
  for (const d of report.decisions) {
    drows.push([d.date, d.mode, d.ticker, d.side, d.count, show(d.entryCents, 'c'), show(d.edgePts), d.status + (d.runs > 1 ? ` (x${d.runs})` : ''), show(d.closeSideCents, 'c'), show(d.clvCents, 'c'), show(d.result), d.pnlDollars == null ? '-' : `$${d.pnlDollars}`]);
  }
  out.push(textTable(drows));
  return out.join('\n');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderHtml(report) {
  const table = (head, rows, cls = '') =>
    `<div class="scroll"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
  const o = report.overall;
  const tiles = [
    ['Decisions', o.count, `${o.settled} settled · ${o.pending} pending`],
    ['Units', show(o.units), `ROI ${show(o.roiPct, '%')} ${ci(o.roiCiPct, '%')}`],
    ['P&L', o.pnlDollars == null ? '-' : `$${o.pnlDollars}`, `on $${o.stakeDollars ?? 0} staked`],
    ['Mean CLV', show(o.meanClvCents, 'c'), `${ci(o.clvCiCents, 'c')} · n=${o.withClose}`],
    ['Beat close', show(o.beatClosePct, '%'), ci(o.beatCloseCiPct, '%')],
  ];
  const groupSections = Object.entries(report.groups)
    .map(([name, buckets]) => `<h3>By ${esc(name)}</h3>${table(SUMMARY_HEAD, Object.entries(buckets).map(([k, s]) => summaryRow(k, s)))}`)
    .join('');
  const dHead = ['date', 'mode', 'ticker', 'player', 'side', 'n', 'entry', 'edge', 'runs', 'status', 'close', 'CLV', 'result', 'P&L'];
  const dRows = report.decisions.map((d) => [d.date, d.mode, d.ticker, d.player || '', d.side, d.count, show(d.entryCents, 'c'), show(d.edgePts), d.runs, d.status, show(d.closeSideCents, 'c'), show(d.clvCents, 'c'), show(d.result), d.pnlDollars == null ? '-' : `$${d.pnlDollars}`]);
  const defs = Object.entries(report.definitions).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot Track Record</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2de;--tile:#fff;--accent:#2f6f4f}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a09f99;--line:#33332f;--tile:#1f1f1d;--accent:#7cc39c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}h3{font-size:14px;margin:20px 0 6px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);margin:0 0 20px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.tile{background:var(--tile);border:1px solid var(--line);border-radius:8px;padding:12px}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span,.tile small{color:var(--muted)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px}dt{font-weight:600}dd{margin:0;color:var(--muted)}.note{border-left:3px solid var(--accent);padding:6px 10px;color:var(--muted)}
</style></head><body><main>
<h1>Bot track record</h1>
<p class="sub">Generated ${esc(report.generatedAt)} · ${report.decisions.length} decision(s) from ${report.entriesRead} journal line(s)</p>
<p class="note">Intervals are 95%. With a handful of settled bets they are wide on purpose: a small sample proves nothing either way.</p>
<div class="tiles">${tiles.map(([h, v, s]) => `<div class="tile"><span>${esc(h)}</span><b>${esc(v)}</b><small>${esc(s)}</small></div>`).join('')}</div>
<h2>Breakdown</h2>${groupSections}
<h2>Decisions</h2>${table(dHead, dRows)}
<h2>Definitions</h2><dl>${defs}</dl>
</main></body></html>
`;
}

// ── CLI ───────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
  const dir = path.resolve(opt('dir', path.join(HERE, 'state')));
  const outDir = path.resolve(opt('out', dir));
  const entries = readJournals(dir);
  const decisions = decisionsFrom(entries);
  const data = createMarketData({
    fetchImpl,
    cacheDir: argv.includes('--no-cache') ? null : path.join(outDir, 'report-cache'),
    offline: argv.includes('--no-fetch'),
    log: (m) => console.error(m),
  });
  const graded = await gradeAll(decisions, data, nowMs);
  const report = buildReport(graded, { dir, nowMs, entriesRead: entries.length, orderErrors: entries.filter((e) => e.type === 'order-error').length });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.html'), renderHtml(report));
  console.log(renderText(report));
  console.log(`\nwrote ${path.join(outDir, 'report.json')} and report.html`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('report failed:', err.stack || err.message);
    process.exitCode = 1;
  });
}
