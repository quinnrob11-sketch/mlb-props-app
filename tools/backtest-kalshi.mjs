// Would trading the pitcher model against REAL Kalshi prices have made money?
//
//   node tools/backtest-kalshi.mjs --from 2026-08-10 --to 2026-09-15 \
//     --cache C:/Users/qrob1/mlbwork/bt-cache --kcache C:/Users/qrob1/mlbwork/kalshi-cache \
//     [--decision-min 120] [--json out.json]
//
// For every SETTLED KXMLBKS (strikeouts) and KXMLBOUTS (outs recorded) market
// whose game falls in the window:
//
//   1. The model probability comes from the lookahead-free replay in
//      backtest-pitchers.mjs (inputs built from games strictly before that
//      date), priced through the bot's own `modelProbability` — the same name
//      match, doubleheader rule and "N+" -> P(X > N-0.5) conversion.
//   2. The decision quote is the Kalshi top of book (yes bid / yes ask) at a
//      fixed time before the scheduled first pitch in the ticker (default 120
//      minutes), read from 1-minute candlesticks: the LAST candle whose
//      end_period_ts <= decision time. Kalshi only emits a minute candle when
//      something changes, so that candle's close is the book at the decision
//      time. Never a later candle.
//   3. The closing quote is the same read at the scheduled first pitch.
//   4. The bot's decision rule is run exactly: `planOrders` (screenOnly) with
//      a one-level book built from the decision quote — buildSignal (blend with
//      MARKET_WEIGHT, fee + minEdge hurdle), the 12-pt implausibility cap, the
//      15-90c price bounds, and one rung per pitcher-series ladder.
//   5. Every trade is 1 contract, taker at the ask, fee = the bot's own
//      feePerContractCents, P&L from Kalshi's settlement value.
//
// Kalshi public endpoints only (no auth). Every response is cached under
// --kcache, requests are serialised with backoff on 429.

import fs from 'node:fs';
import path from 'node:path';
import { buildStarts, schedule } from './backtest-pitchers.mjs';
import { projectPitcher } from '../src/model/pitcher.js';
import { planOrders, modelProbability, playerKeyOf } from '../bot/plan.mjs';
import { normalizeMarket, normalizeOrderbook } from '../src/lib/kalshi.js';
import { parseKalshiGameTicker } from '../src/data/teamMarkets.js';
import { buildSignal, blendedProbability } from '../src/trade/signals.js';
import { MARKET_WEIGHT } from '../src/lib/constants.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const FROM = arg('from', '2026-08-10');
const TO = arg('to', '2026-09-15');
const KCACHE = arg('kcache', path.resolve('.kalshi-cache'));
const DECISION_MIN = Number(arg('decision-min', 120));
const JSON_OUT = arg('json', null);
const BOOT = Number(arg('boot', 5000));
const LIMIT_GAMES = Number(arg('limit-games', Infinity)); // debugging only
const SERIES = ['KXMLBKS', 'KXMLBOUTS'];
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
fs.mkdirSync(path.join(KCACHE, 'candles'), { recursive: true });

// ── Kalshi fetch: serialised, cached, polite ────────────────────────────────
let lastRequest = 0;
async function kget(url) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + 250 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
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

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const DROP = ['rules_primary', 'rules_secondary', 'price_ranges', 'custom_strike', 'early_close_condition'];

/** Every settled market in a series (live tier), cached as one file per series. */
async function settledMarkets(series) {
  const file = path.join(KCACHE, `settled_${series}.json`);
  if (fs.existsSync(file)) return readJson(file).markets;
  const markets = [];
  let cursor = '';
  do {
    const body = await kget(`${KALSHI}/markets?series_ticker=${series}&status=settled&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const m of body.markets || []) {
      for (const k of DROP) delete m[k];
      markets.push(m);
    }
    cursor = body.cursor || '';
    process.stderr.write(`  ${series}: ${markets.length} settled markets\r`);
  } while (cursor);
  process.stderr.write('\n');
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), markets }));
  return markets;
}

/** Scheduled first pitch (UTC ms) from the ET time in an event ticker. */
function tickerStartMs(eventTicker) {
  const p = parseKalshiGameTicker(eventTicker);
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

/**
 * 1-minute candles for one game's markets, compacted to
 * [end_ts, yesBidCents, yesAskCents] and cached per game.
 */
async function gameCandles(gameKey, markets, endMs) {
  const file = path.join(KCACHE, 'candles', `${gameKey}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const out = {};
  const startTs = Math.floor(Math.min(...markets.map((m) => Date.parse(m.open_time))) / 1000);
  const endTs = Math.floor(endMs / 1000);
  const tickers = markets.map((m) => m.ticker);
  const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));
  async function fetchChunk(chunk) {
    const body = await kget(`${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=1`);
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [c.end_period_ts, cents(c.yes_bid?.close_dollars), cents(c.yes_ask?.close_dollars)]);
    }
    for (const t of chunk) out[t] ||= [];
  }
  // The endpoint refuses a request whose tickers x minutes exceeds 10,000.
  const perRequest = Math.max(1, Math.floor(10000 / (Math.ceil((endTs - startTs) / 60) + 2)));
  for (let i = 0; i < tickers.length; i += perRequest) await fetchChunk(tickers.slice(i, i + perRequest));
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Top of book as of `ms`: the last candle ending at or before it. */
function quoteAt(candles, ms) {
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

// ── statsapi teams (abbreviations the live slate uses) ──────────────────────
async function teamAbbrs() {
  const file = path.join(KCACHE, 'statsapi_teams_2026.json');
  let body;
  if (fs.existsSync(file)) body = readJson(file);
  else {
    const res = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    body = await res.json();
    fs.writeFileSync(file, JSON.stringify(body));
  }
  return new Map(body.teams.map((t) => [t.id, t.abbreviation]));
}

// ── stats helpers ───────────────────────────────────────────────────────────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ROI and mean P&L with a cluster bootstrap over pitcher-starts (rungs of one start are not independent). */
function summarize(trades, { boot = BOOT } = {}) {
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
  // cluster bootstrap
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

function scoring(rows, key) {
  let brier = 0, ll = 0;
  for (const r of rows) {
    const p = Math.min(0.999, Math.max(0.001, r[key]));
    brier += (p - r.y) ** 2;
    ll += -(r.y ? Math.log(p) : Math.log(1 - p));
  }
  return { brier: brier / rows.length, logLoss: ll / rows.length };
}

/** Paired Brier difference a - b (negative = a better), 95% cluster-bootstrap interval over pitcher-starts. */
function brierDiff(rows, a, b) {
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
  for (let i = 0; i < BOOT; i++) {
    let x = 0, n = 0;
    for (let j = 0; j < cl.length; j++) {
      const k = cl[Math.floor(rand() * cl.length)];
      x += k[0]; n += k[1];
    }
    d.push(x / n);
  }
  d.sort((p, q) => p - q);
  return { point, ci95: [d[Math.floor(0.025 * BOOT)], d[Math.floor(0.975 * BOOT)]] };
}

function calibrationBins(rows, key) {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r[key] * 10))];
    b.p += r[key]; b.y += r.y; b.n++;
  }
  return bins.filter((b) => b.n).map((b) => `${(100 * b.p / b.n).toFixed(0)}->${(100 * b.y / b.n).toFixed(0)} (${b.n})`);
}

const priceBucket = (c) => (c < 25 ? '15-24' : c < 40 ? '25-39' : c < 60 ? '40-59' : c < 75 ? '60-74' : '75-90');

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const config = readJson(new URL('../bot/config.example.json', import.meta.url));
  const FEE_RATE_SENS = 0.035; // series fee_multiplier 0.5 (KXMLBKS/KXMLBOUTS since 2026-08-07), if it halves 0.07

  // Markets
  const all = [];
  for (const s of SERIES) all.push(...(await settledMarkets(s)));
  const seriesSpan = {};
  for (const m of all) {
    const p = parseKalshiGameTicker(m.event_ticker);
    if (!p) continue;
    const s = (seriesSpan[m.series_ticker || m.ticker.split('-')[0]] ||= { first: p.date, last: p.date, n: 0 });
    if (p.date < s.first) s.first = p.date;
    if (p.date > s.last) s.last = p.date;
    s.n++;
  }
  const inWindow = all.filter((m) => {
    const p = parseKalshiGameTicker(m.event_ticker);
    return p && p.date >= FROM && p.date <= TO;
  });

  // Model inputs
  const abbr = await teamAbbrs();
  const starts = buildStarts();
  const startsByGame = new Map();
  for (const s of starts) {
    if (!startsByGame.has(s.gamePk)) startsByGame.set(s.gamePk, []);
    startsByGame.get(s.gamePk).push(s);
  }
  const projCache = new Map();
  const proj = (s) => {
    const k = `${s.id}:${s.date}`;
    if (!projCache.has(k)) projCache.set(k, projectPitcher(s.input));
    return projCache.get(k);
  };
  // Slate per ET date, from the schedule: every game (so doubleheaders are seen), pitchers = replayed starts.
  const slates = new Map();
  for (const d of schedule.dates) {
    for (const g of d.games) {
      if (g.status?.detailedState === 'Postponed' || g.status?.codedGameState === 'D') continue;
      const etDate = new Date(g.gameDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (etDate < FROM || etDate > TO) continue;
      if (!slates.has(etDate)) slates.set(etDate, { games: [] });
      slates.get(etDate).games.push({
        gamePk: g.gamePk,
        gameDate: g.gameDate,
        away: { abbr: abbr.get(g.teams.away.team.id) },
        home: { abbr: abbr.get(g.teams.home.team.id) },
        pitchers: (startsByGame.get(g.gamePk) || []).map((s) => ({ id: s.id, name: s.name, proj: proj(s), start: s })),
        batters: [],
      });
    }
  }

  // Group markets by game (event segment is shared by both series)
  const byGame = new Map();
  for (const m of inWindow) {
    const seg = m.ticker.split('-')[1];
    if (!byGame.has(seg)) byGame.set(seg, []);
    byGame.get(seg).push(m);
  }

  const coverage = { marketsInWindow: inWindow.length, games: byGame.size, skip: {} };
  const bump = (r) => (coverage.skip[r] = (coverage.skip[r] || 0) + 1);
  const rows = []; // every matched market with a model probability
  let fetched = 0;
  for (const [seg, markets] of [...byGame].sort().slice(0, LIMIT_GAMES)) {
    const startMs = tickerStartMs(markets[0].event_ticker);
    const p = parseKalshiGameTicker(markets[0].event_ticker);
    const slate = slates.get(p.date) || { games: [] };
    // Only pull prices for games where the model can price something.
    const priced = markets.map((m) => ({ m, info: modelProbability(normalizeMarket(m), slate, config) }));
    const usable = priced.filter((x) => x.info.prob != null);
    for (const x of priced) if (x.info.prob == null) bump(`model: ${x.info.reason.replace(/player .*/, (r) => r)}`);
    if (!usable.length) continue;
    const candles = await gameCandles(seg, usable.map((x) => x.m), startMs);
    if (++fetched % 25 === 0) process.stderr.write(`  candles for ${fetched} games\r`);
    for (const { m, info } of usable) {
      const decisionMs = startMs - DECISION_MIN * 60e3;
      const dq = quoteAt(candles[m.ticker], decisionMs);
      const cq = quoteAt(candles[m.ticker], startMs);
      const sv = Number(m.settlement_value_dollars);
      rows.push({
        ticker: m.ticker,
        series: m.ticker.split('-')[0],
        marketKey: info.marketKey,
        date: p.date,
        startMs,
        schedStartMs: Date.parse(info.game.gameDate),
        cluster: `${info.person.id}:${p.date}`,
        pitcherId: info.person.id,
        threshold: normalizeMarket(m).threshold,
        model: info.prob,
        dq,
        cq,
        result: m.result,
        settle: Number.isFinite(sv) ? sv : m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null,
        actual: info.person.start.actual,
        raw: m,
        game: info.game,
      });
    }
  }
  process.stderr.write('\n');
  coverage.matchedMarkets = rows.length;
  coverage.matchedStarts = new Set(rows.map((r) => r.cluster)).size;
  coverage.withDecisionTwoSided = rows.filter((r) => r.dq?.bid != null && r.dq?.ask != null).length;
  coverage.nonBinarySettlement = rows.filter((r) => r.settle != null && r.settle !== 0 && r.settle !== 1).length;
  // Sanity: settlement vs our own box-score outcome.
  coverage.settleDisagreesWithBoxScore = rows.filter((r) => {
    if (r.settle !== 0 && r.settle !== 1) return false;
    const stat = r.series === 'KXMLBKS' ? r.actual.k : r.actual.outs;
    return (stat >= r.threshold ? 1 : 0) !== r.settle;
  }).map((r) => `${r.ticker} settle=${r.settle} actual=${r.series === 'KXMLBKS' ? r.actual.k : r.actual.outs}`);
  coverage.tickerVsScheduleStartMinutes = (() => {
    const d = rows.map((r) => Math.round((r.schedStartMs - r.startMs) / 60e3)).sort((a, b) => a - b);
    return d.length ? { min: d[0], median: d[Math.floor(d.length / 2)], max: d[d.length - 1] } : null;
  })();

  // ── the bot's decisions, one planOrders call per game at the decision time ──
  const book = (q) => ({ orderbook: { yes: [[q.bid, 1e6]], no: [[100 - q.ask, 1e6]] } });
  const trades = { every: [], bot: [], botOnePerPlayer: [] };
  const rowsByGame = new Map();
  for (const r of rows) {
    const k = r.ticker.split('-')[1];
    if (!rowsByGame.has(k)) rowsByGame.set(k, []);
    rowsByGame.get(k).push(r);
  }
  const account = { balanceDollars: 1e6, valueDollars: 1e6, dayStartValueDollars: 1e6, positions: [], restingTickers: [] };
  const botConfig = { ...config, screenOnly: true, limits: { ...config.limits, bankrollDollars: 1e6 } };
  const makeTrade = (r, signal, feeRate = 0.07) => {
    const yes = signal.side === 'yes';
    const price = signal.priceCents;
    const fee = (100 * feeRate * price * (100 - price)) / 10000 / 1; // cents per contract, unrounded (as feePerContractCents)
    const payout = 100 * (yes ? r.settle : 1 - r.settle);
    const midSide = (q) => (q?.mid == null ? null : yes ? q.mid : 100 - q.mid);
    return {
      ticker: r.ticker, series: r.series, date: r.date, cluster: r.cluster, pitcherId: r.pitcherId,
      side: signal.side, priceCents: price, feeCents: fee, pnlCents: payout - price - fee,
      edge: signal.edge, model: yes ? r.model : 1 - r.model, blended: signal.blendedProb,
      decisionMidSide: midSide(r.dq), closeMidSide: midSide(r.cq), expectedWinSide: price / 100,
      evPerDollar: signal.evPerDollar, won: payout === 100,
    };
  };
  for (const [seg, gameRows] of rowsByGame) {
    const tradable = gameRows.filter((r) => r.dq?.bid != null && r.dq?.ask != null && r.settle != null);
    if (!tradable.length) continue;
    const decisionMs = gameRows[0].startMs - DECISION_MIN * 60e3;
    // every signal: buildSignal alone
    for (const r of tradable) {
      const b = normalizeOrderbook(r.ticker, book(r.dq));
      const sig = buildSignal({ modelProb: r.model, book: b, ticker: r.ticker, weight: MARKET_WEIGHT[r.marketKey] ?? 0.3, minEdge: config.minEdgeAfterFees });
      r.signal = sig;
      if (sig?.tradeable) trades.every.push(makeTrade(r, sig));
    }
    // bot rules: planOrders itself
    const slate = { games: [gameRows[0].game] };
    const books = new Map(tradable.map((r) => [r.ticker, book(r.dq)]));
    const plan = planOrders({
      slate, markets: tradable.map((r) => r.raw), books, account, state: {}, config: botConfig, now: new Date(decisionMs),
    });
    const chosen = plan.screened || [];
    const byTicker = new Map(tradable.map((r) => [r.ticker, r]));
    const picked = chosen.map((t) => byTicker.get(t));
    for (const r of picked) trades.bot.push(makeTrade(r, r.signal));
    // + the sizing loop's one-bet-per-player rule (ranked by EV per dollar, as planOrders ranks)
    const seen = new Set();
    for (const r of picked) {
      const pk = playerKeyOf(r.ticker);
      if (seen.has(pk)) continue;
      seen.add(pk);
      trades.botOnePerPlayer.push(makeTrade(r, r.signal));
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
  const splits = (list) => {
    const out = { all: summarize(list) };
    const by = (label, fn) => {
      const groups = new Map();
      for (const t of list) {
        const k = fn(t);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      }
      for (const [k, g] of [...groups].sort()) out[`${label}=${k}`] = summarize(g);
    };
    by('series', (t) => t.series);
    by('side', (t) => t.side);
    by('price', (t) => priceBucket(t.priceCents));
    by('series×side', (t) => `${t.series}/${t.side}`);
    by('half', (t) => (t.date < '2026-09-01' ? 'pre-Sep' : 'Sep'));
    return out;
  };
  const feeSens = (list) => summarize(list.map((t) => {
    const fee = (100 * FEE_RATE_SENS * t.priceCents * (100 - t.priceCents)) / 10000;
    return { ...t, feeCents: fee, pnlCents: t.pnlCents + t.feeCents - fee };
  }));

  // Forecast skill on every matched market with a two-sided decision quote and binary settlement.
  const scored = rows
    .filter((r) => r.dq?.mid != null && (r.settle === 0 || r.settle === 1))
    .map((r) => ({
      series: r.series, y: r.settle, cluster: r.cluster, model: r.model, market: r.dq.mid / 100,
      close: r.cq?.mid != null ? r.cq.mid / 100 : null,
      blend: blendedProbability(r.model, r.dq.mid / 100, MARKET_WEIGHT[r.marketKey] ?? 0.3),
    }));
  const skill = (list) => ({
    n: list.length,
    brierDiffModelMinusMarket: brierDiff(list, 'model', 'market'),
    brierDiffBlendMinusMarket: brierDiff(list, 'blend', 'market'),
    // Diagnostic, not a tuning: the linear weight w on (model - market) that would
    // have minimised Brier on these same rows. ~0 means the model adds nothing the price lacks.
    brierOptimalModelWeight: (() => {
      let best = null;
      for (let w = 0; w <= 1.0001; w += 0.05) {
        const b = list.reduce((acc, x) => acc + (x.market + w * (x.model - x.market) - x.y) ** 2, 0) / list.length;
        if (!best || b < best.brier) best = { w: +w.toFixed(2), brier: b };
      }
      return best;
    })(),
    model: scoring(list, 'model'),
    market: scoring(list, 'market'),
    blend: scoring(list, 'blend'),
    closeOnSameRows: (() => {
      const w = list.filter((x) => x.close != null);
      return w.length ? { n: w.length, close: scoring(w, 'close'), market: scoring(w, 'market'), model: scoring(w, 'model') } : null;
    })(),
    modelCalibration: calibrationBins(list, 'model'),
    marketCalibration: calibrationBins(list, 'market'),
  });
  const mid10to90 = scored.filter((x) => x.market >= 0.1 && x.market <= 0.9);
  const forecast = {
    all: skill(scored),
    KXMLBKS: skill(scored.filter((x) => x.series === 'KXMLBKS')),
    KXMLBOUTS: skill(scored.filter((x) => x.series === 'KXMLBOUTS')),
    marketBetween10and90: skill(mid10to90),
  };
  const gap = scored.map((x) => Math.abs(x.model - x.market)).sort((a, b) => a - b);
  forecast.absModelMinusMarketPts = { median: 100 * gap[Math.floor(gap.length / 2)], p90: 100 * gap[Math.floor(gap.length * 0.9)] };

  const report = {
    window: { from: FROM, to: TO, decisionMinutesBeforeFirstPitch: DECISION_MIN },
    seriesSpanLiveTier: seriesSpan,
    coverage,
    trades: {
      every: splits(trades.every),
      bot: splits(trades.bot),
      botOnePerPlayer: splits(trades.botOnePerPlayer),
    },
    feeSensitivity035: { every: feeSens(trades.every), bot: feeSens(trades.bot), botOnePerPlayer: feeSens(trades.botOnePerPlayer) },
    forecast,
  };
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ report, trades }, null, 1));
  }
  print(report);
}

function fmt(s) {
  if (!s || !s.n) return 'n=0';
  const f = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
  return `n=${String(s.n).padStart(4)} (${s.clusters} starts)  hit ${f(100 * s.hitRate)}% vs ${f(100 * s.breakEvenHit)}% priced  P&L ${s.pnlPerContractCents >= 0 ? '+' : ''}${f(s.pnlPerContractCents, 2)}c/ct  ROI ${s.roiPct >= 0 ? '+' : ''}${f(s.roiPct)}% [${f(s.roiCI95[0])}, ${f(s.roiCI95[1])}]  CLV mid ${f(s.clvMidCents, 2)}c, vs paid ${f(s.clvVsPaidCents, 2)}c, close moved for/against ${f(100 * s.pctBeatCloseMid, 0)}/${f(100 * s.pctWorseThanCloseMid, 0)}%`;
}

function print(r) {
  console.log(`window ${r.window.from}..${r.window.to}, decision = first pitch - ${r.window.decisionMinutesBeforeFirstPitch} min`);
  console.log('live-tier settled markets by series:', JSON.stringify(r.seriesSpanLiveTier));
  const { skip, settleDisagreesWithBoxScore, ...cov } = r.coverage;
  console.log('coverage:', JSON.stringify(cov));
  console.log('unmatched:', JSON.stringify(skip));
  console.log(`settlement vs box score disagreements: ${settleDisagreesWithBoxScore.length}`, settleDisagreesWithBoxScore.slice(0, 10));
  for (const [name, sp] of Object.entries(r.trades)) {
    console.log(`\n=== trades: ${name} ===`);
    for (const [k, s] of Object.entries(sp)) console.log(`${k.padEnd(28)} ${fmt(s)}`);
    console.log(`${'fee 0.035 (sensitivity)'.padEnd(28)} ${fmt(r.feeSensitivity035[name])}`);
  }
  console.log('\n=== forecast skill (all matched markets, two-sided decision quote) ===');
  for (const [k, s] of Object.entries(r.forecast)) {
    if (k === 'absModelMinusMarketPts') { console.log(`|model - market| pts: ${JSON.stringify(s)}`); continue; }
    const g = (x) => `brier ${x.brier.toFixed(4)} ll ${x.logLoss.toFixed(4)}`;
    console.log(`${k.padEnd(22)} n=${s.n}  model ${g(s.model)} | market ${g(s.market)} | blend ${g(s.blend)}`);
    const dd = (x) => `${x.point.toFixed(4)} [${x.ci95[0].toFixed(4)}, ${x.ci95[1].toFixed(4)}]`;
    console.log(`${''.padEnd(22)} in-sample Brier-optimal weight on model: ${s.brierOptimalModelWeight.w}`);
    console.log(`${''.padEnd(22)} brier diff model-market ${dd(s.brierDiffModelMinusMarket)}  blend-market ${dd(s.brierDiffBlendMinusMarket)}`);
    if (s.closeOnSameRows) console.log(`${''.padEnd(22)} with close quote n=${s.closeOnSameRows.n}: close ${g(s.closeOnSameRows.close)} | decision ${g(s.closeOnSameRows.market)} | model ${g(s.closeOnSameRows.model)}`);
    console.log(`${''.padEnd(22)} model calib: ${s.modelCalibration.join('  ')}`);
    console.log(`${''.padEnd(22)} market calib: ${s.marketCalibration.join('  ')}`);
  }
}

await main();
