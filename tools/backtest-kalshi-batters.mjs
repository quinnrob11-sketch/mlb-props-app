// Would trading the BATTER model against real Kalshi prices have made money?
//
//   node tools/backtest-kalshi-batters.mjs --from 2026-07-10 --to 2026-09-15 \
//     --cache C:/Users/qrob1/mlbwork/bt-cache-batter --kcache C:/Users/qrob1/mlbwork/kalshi-cache \
//     [--json out.json] [--boot 5000] [--limit-games N]
//
// Method (fixed before any P&L was seen): docs/KALSHI-BATTER-BACKTEST.md.
// In short, for every settled KXMLBHIT / KXMLBTB / KXMLBHR / KXMLBRBI / KXMLBHRR
// market whose game is in the window:
//   1. model probability = the bot's own `modelProbability` on a one-game slate
//      built from the lookahead-free batter replay (tools/backtest-batters.mjs):
//      posted starters, inputs from games before the date, projectBatter;
//   2. decision quote = last candle ending at or before first pitch - 120 min
//      (and - 30 min), close = at first pitch;
//   3. the bot's decision = `planOrders` (screenOnly) with a one-level book;
//   4. 1 contract, taker at the ask, settled at Kalshi's settlement value, fee
//      0.07 (bot) and 0.035 (series fee_multiplier 0.5).
//
// Kalshi public endpoints only (no auth, no orders), every response cached
// under --kcache, at most two request lanes with a shared minimum gap.

import fs from 'node:fs';
import path from 'node:path';
import { buildRows, schedule, boxes } from './backtest-batters.mjs';
import { BATTER_MARKETS } from '../src/lib/markets.js';
import { matchName, normalizeName } from '../src/lib/names.js';
import { playerNameOf } from '../src/lib/kalshi.js';
import { pool } from './backtest-common.mjs';
import { projectBatter } from '../src/model/batter.js';
import { planOrders, modelProbability, playerKeyOf } from '../bot/plan.mjs';
import { normalizeMarket, normalizeOrderbook } from '../src/lib/kalshi.js';
import { buildSignal, blendedProbability } from '../src/trade/signals.js';
import { MARKET_WEIGHT } from '../src/lib/constants.js';
import {
  readJson, settledMarkets, parseEventTicker, startMsOf, fetchCandles, quoteAt, summarize, scoring,
  brierDiff, calibrationBins, brierOptimalModelWeight, kalshiRequestCount,
} from './kalshi-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const FROM = arg('from', '2026-07-10');
const TO = arg('to', '2026-09-15');
const KCACHE = arg('kcache', path.resolve('.kalshi-cache'));
const JSON_OUT = arg('json', null);
const BOOT = Number(arg('boot', 5000));
const LIMIT_GAMES = Number(arg('limit-games', Infinity)); // debugging only
// KXMLBSB is priced below rather than through `modelProbability`, because
// src/lib/kalshi.js has no mapping for it (see Findings). Everything else about
// it -- name match, P(X > N - 0.5), quote, fee, bootstrap -- is unchanged.
const SERIES = arg('series', 'KXMLBHIT,KXMLBTB,KXMLBHR,KXMLBRBI,KXMLBHRR,KXMLBSB').split(',');
const SB_SERIES = 'KXMLBSB';
const BATTER_DIST = { KXMLBHIT: 'hits', KXMLBTB: 'tb', KXMLBHR: 'hr', KXMLBRBI: 'rbi', KXMLBHRR: 'hrr', KXMLBSB: 'sb' };
/** The model variant under test. `--tuning FILE` overrides BATTER_TUNING. */
const TUNING = arg('tuning', null) ? readJson(arg('tuning', null)) : null;
/**
 * Window scheme. `orig` is docs/KALSHI-BATTER-BACKTEST.md (A/B/A1/A2/OOS);
 * `edge` is the docs/BATTER-EDGE-SEARCH.md pre-registration (FIT/VAL/HOLD).
 */
const SCHEME = arg('scheme', 'orig');
/**
 * `MARKET_WEIGHT` for the batter markets under test. `--weights` takes either a
 * single number applied to every batter market, or a JSON file. The default
 * keeps `src/lib/constants.js`. docs/BATTER-EDGE-SEARCH.md section 8 fixes the
 * two values this study reports: the pre-v36.2 weights the -3.4% was measured
 * under, and 1.0.
 */
const BATTER_WEIGHTS = {
  batter_hits: 0.45, batter_total_bases: 0.45, batter_home_runs: 0.5,
  batter_rbis: 0.35, batter_hits_runs_rbis: 0.4, batter_stolen_bases: 0.4,
};
const WEIGHTS = (() => {
  const w = arg('weights', null);
  if (!w) return MARKET_WEIGHT;
  if (w === 'pre362') return { ...MARKET_WEIGHT, ...BATTER_WEIGHTS };
  if (Number.isFinite(Number(w))) {
    return { ...MARKET_WEIGHT, ...Object.fromEntries(Object.keys(BATTER_WEIGHTS).map((k) => [k, Number(w)])) };
  }
  return { ...MARKET_WEIGHT, ...readJson(w) };
})();
const DECISIONS = [120, 30];
const FEES = [0.07, 0.035];
const KEEP = ['ticker', 'event_ticker', 'floor_strike', 'yes_sub_title', 'title', 'open_time', 'close_time', 'created_time', 'result', 'settlement_value_dollars', 'status', 'market_type', 'strike_type', 'volume_fp', 'open_interest_fp'];
const CANDLE_DIR = path.join(KCACHE, 'candles-bat');
fs.mkdirSync(CANDLE_DIR, { recursive: true });

// Windows (see the doc): B fully out of sample; A1 = BATTER_TUNING fit; A2 = holdout.
const windowOf = SCHEME === 'edge'
  ? (date) => (date < '2026-08-10' ? 'FIT' : date < '2026-09-02' ? 'VAL' : 'HOLD')
  : (date) => (date < '2026-08-10' ? 'B' : date < '2026-09-01' ? 'A1' : 'A2');
const WINDOW_SETS = SCHEME === 'edge'
  ? { all: () => true, FIT: (w) => w === 'FIT', VAL: (w) => w === 'VAL', HOLD: (w) => w === 'HOLD' }
  : {
    'A+B': () => true,
    A: (w) => w !== 'B',
    B: (w) => w === 'B',
    A1: (w) => w === 'A1',
    A2: (w) => w === 'A2',
    OOS: (w) => w !== 'A1',
  };
const POOLED = SCHEME === 'edge' ? 'all' : 'A+B';
const priceBucket = (c) => (c < 15 ? '01-14' : c < 25 ? '15-24' : c < 40 ? '25-39' : c < 60 ? '40-59' : c < 75 ? '60-74' : c <= 90 ? '75-90' : '91-99');

/**
 * Candles for one game: hourly up to E (the hour boundary at or before T-120),
 * 1-minute from E-60 to T, merged so hourly covers <= E and minute covers > E.
 * Same top of book as pure 1-minute candles at any time >= T-120 (verified on
 * the pitcher cache), for about a tenth of the requests.
 */
async function gameCandles(seg, markets, startMs) {
  const file = path.join(CANDLE_DIR, `${seg}.json`);
  // A cache written for a narrower series list is topped up rather than
  // discarded: only the tickers it is missing are fetched.
  const cached = fs.existsSync(file) ? readJson(file).candles : null;
  const want = cached ? markets.filter((m) => !(m.ticker in cached)) : markets;
  if (cached && !want.length) return cached;
  const T = Math.floor(startMs / 1000);
  const E = Math.floor((T - 120 * 60) / 3600) * 3600;
  const opens = want.map((m) => Math.floor(Date.parse(m.open_time) / 1000));
  const early = want.filter((m, i) => opens[i] <= E).map((m) => m.ticker);
  const h = early.length ? await fetchCandles(early, Math.min(...opens), E, 60) : {};
  const m = await fetchCandles(want.map((x) => x.ticker), Math.max(E - 60, Math.min(...opens)), T, 1);
  const candles = { ...(cached || {}) };
  for (const x of want) {
    candles[x.ticker] = [...(h[x.ticker] || []).filter((c) => c[0] <= E), ...(m[x.ticker] || []).filter((c) => c[0] > E)];
  }
  fs.writeFileSync(file, JSON.stringify({ E, T, candles }));
  return candles;
}

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


/**
 * KXMLBSB is not in `KNOWN_SERIES`, so `modelProbability` refuses it. This does
 * exactly what that function would: the same name match (including Kalshi's
 * "(TEAM)" disambiguation), the same confirmed-lineup rule, and the same
 * P(X > N - 0.5) off the model's own stolen-base distribution.
 */
function sbProbability(market, sg) {
  if (market.threshold == null) return { prob: null, reason: 'no threshold' };
  const rawName = String(playerNameOf(market.raw || market) || market.player || '');
  const teamTag = /\(([A-Z]{2,3})\)/.exec(rawName)?.[1] || null;
  const cleanName = rawName.replace(/\([A-Z]{2,3}\)/, '').replace(/:.*$/, '').trim();
  let people = sg.batters;
  if (teamTag) people = people.filter((p) => p.teamAbbr === teamTag);
  const byKey = new Map(people.map((p) => [normalizeName(p.name), p]));
  const match = matchName(normalizeName(cleanName) || market.playerKey, [...byKey.keys()]);
  if (match.status !== 'matched') return { prob: null, reason: `player ${match.status}` };
  const person = byKey.get(match.key);
  if (person.lineupSource !== 'confirmed') return { prob: null, reason: 'lineup not confirmed' };
  const dist = person.proj?.dist?.[BATTER_MARKETS.batter_stolen_bases.distKey];
  if (typeof dist !== 'function') return { prob: null, reason: 'no distribution' };
  const line = market.threshold - 0.5;
  return { prob: dist(line), kind: 'prop', marketKey: 'batter_stolen_bases', game: sg, person, line };
}

async function main() {
  const config = readJson(new URL('../bot/config.example.json', import.meta.url));
  Object.assign(MARKET_WEIGHT, WEIGHTS);
  const t0 = Date.now();

  // ── markets ───────────────────────────────────────────────────────────────
  const all = [];
  for (const s of SERIES) {
    for (const m of await settledMarkets(KCACHE, s, { keep: KEEP })) all.push({ ...m, series: s });
  }
  const coverage = { seriesSpan: {}, byWindow: {}, skip: {}, skipBySeries: {} };
  const inWindow = [];
  for (const m of all) {
    const p = parseEventTicker(m.event_ticker);
    if (!p) { coverage.skip['unparseable ticker'] = (coverage.skip['unparseable ticker'] || 0) + 1; continue; }
    const s = (coverage.seriesSpan[m.series] ||= { first: p.date, last: p.date, n: 0, doubleheaderSuffix: 0, scalar: 0 });
    if (p.date < s.first) s.first = p.date;
    if (p.date > s.last) s.last = p.date;
    s.n++;
    if (p.gameNumber) s.doubleheaderSuffix++;
    if (m.result === 'scalar') s.scalar++;
    if (p.date >= FROM && p.date <= TO) inWindow.push({ m, p });
  }

  // ── model: replay rows -> one-game slates ─────────────────────────────────
  const abbr = await teamAbbrs();
  const rows = buildRows();
  const rowsByGame = new Map();
  for (const r of rows) {
    if (!rowsByGame.has(r.gamePk)) rowsByGame.set(r.gamePk, []);
    rowsByGame.get(r.gamePk).push(r);
  }
  const gamesByDateTeams = new Map(); // `${etDate}:${AWAYHOME}` -> [game]
  for (const d of schedule.dates) {
    for (const g of d.games) {
      if (g.status?.detailedState === 'Postponed' || g.status?.codedGameState === 'D') continue;
      const etDate = new Date(g.gameDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (etDate < FROM || etDate > TO) continue;
      const teams = `${abbr.get(g.teams.away.team.id)}${abbr.get(g.teams.home.team.id)}`;
      const k = `${etDate}:${teams}`;
      if (!gamesByDateTeams.has(k)) gamesByDateTeams.set(k, []);
      gamesByDateTeams.get(k).push(g);
    }
  }
  const slateGames = new Map(); // gamePk -> slate game (built lazily)
  const slateGameOf = (g) => {
    if (slateGames.has(g.gamePk)) return slateGames.get(g.gamePk);
    const box = boxes.get(g.gamePk);
    const batters = (rowsByGame.get(g.gamePk) || []).map((r) => {
      const side = box.teams[r.side];
      return {
        id: r.id,
        name: side.players[`ID${r.id}`]?.person?.fullName,
        slot: r.slot,
        lineupSource: 'confirmed',
        proj: projectBatter(TUNING ? { ...r.input, tuning: TUNING } : r.input),
        // Reference model, scored beside the one under test so a single pass
        // over the holdout answers both "does it beat the price" and "is it
        // better than what shipped". Same inputs; only `tuning` differs.
        proj2: TUNING ? projectBatter(r.input) : null,
        actual: r.actual,
      };
    });
    const sg = {
      gamePk: g.gamePk,
      gameDate: g.gameDate,
      gameNumber: g.gameNumber,
      away: { abbr: abbr.get(g.teams.away.team.id) },
      home: { abbr: abbr.get(g.teams.home.team.id) },
      pitchers: [],
      batters,
      replayed: rowsByGame.has(g.gamePk),
    };
    slateGames.set(g.gamePk, sg);
    return sg;
  };

  const bump = (reason, series) => {
    coverage.skip[reason] = (coverage.skip[reason] || 0) + 1;
    const s = (coverage.skipBySeries[series] ||= {});
    s[reason] = (s[reason] || 0) + 1;
  };

  // Group by game segment (includes the G1/G2 suffix, so doubleheader games stay apart).
  const byGame = new Map();
  for (const x of inWindow) {
    const seg = x.m.ticker.split('-')[1];
    if (!byGame.has(seg)) byGame.set(seg, []);
    byGame.get(seg).push(x);
  }

  // Price every market (no network), then fetch candles for games with anything priced.
  const pricedGames = [];
  for (const [seg, list] of [...byGame].sort().slice(0, LIMIT_GAMES)) {
    const p = list[0].p;
    const candidates = gamesByDateTeams.get(`${p.date}:${p.teams}`) || [];
    let g = null;
    if (p.gameNumber) g = candidates.find((c) => c.gameNumber === p.gameNumber) || null;
    else if (candidates.length === 1) g = candidates[0];
    const priced = [];
    for (const { m } of list) {
      const w = windowOf(p.date);
      coverage.byWindow[w] ||= { markets: 0, matched: 0 };
      coverage.byWindow[w].markets++;
      if (!g) { bump(candidates.length > 1 ? 'doubleheader without suffix' : 'game not on schedule (postponed?)', m.series); continue; }
      const sg = slateGameOf(g);
      if (!sg.replayed) { bump('game not in replay (not final)', m.series); continue; }
      // The bot's parser rejects the G1/G2 suffix (see doc); strip it for this
      // one-game slate, where the doubleheader is already resolved.
      const raw = p.gameNumber ? { ...m, event_ticker: m.event_ticker.replace(/G[12]$/, '') } : m;
      const info = m.series === SB_SERIES
        ? sbProbability(normalizeMarket(raw), sg)
        : modelProbability(normalizeMarket(raw), { games: [sg] }, config);
      if (info.prob != null && info.person?.proj2) {
        const d = info.person.proj2.dist[BATTER_DIST[m.series]];
        if (typeof d === 'function') info.prob2 = d(info.line);
      }
      if (info.prob == null) {
        bump(`model: ${info.reason}${info.reason.startsWith('player') ? (m.result === 'scalar' ? ' (settled scalar)' : ' (settled 0/1)') : ''}`, m.series);
        continue;
      }
      coverage.byWindow[w].matched++;
      priced.push({ m, raw, info });
    }
    if (priced.length) pricedGames.push({ seg, p, g: slateGameOf(g), priced, startMs: startMsOf(p) });
  }

  let done = 0;
  await pool(pricedGames, 2, async (pg) => {
    pg.candles = await gameCandles(pg.seg, pg.priced.map((x) => x.m), pg.startMs);
    if (++done % 25 === 0) process.stderr.write(`  candles for ${done}/${pricedGames.length} games (${kalshiRequestCount()} requests, ${((Date.now() - t0) / 60e3).toFixed(1)} min)\r`);
  });
  process.stderr.write('\n');

  // ── rows: one per priced market ───────────────────────────────────────────
  const marketRows = [];
  for (const pg of pricedGames) {
    for (const { m, raw, info } of pg.priced) {
      const sv = Number(m.settlement_value_dollars);
      const c = pg.candles[m.ticker];
      marketRows.push({
        ticker: m.ticker,
        series: m.series,
        marketKey: info.marketKey,
        date: pg.p.date,
        window: windowOf(pg.p.date),
        seg: pg.seg,
        gamePk: pg.g.gamePk,
        doubleheader: Boolean(pg.p.gameNumber),
        startMs: pg.startMs,
        cluster: pg.g.gamePk,
        personId: info.person.id,
        threshold: normalizeMarket(raw).threshold,
        model: info.prob,
        model2: info.prob2 ?? null,
        q: Object.fromEntries(DECISIONS.map((d) => [d, quoteAt(c, pg.startMs - d * 60e3)])),
        cq: quoteAt(c, pg.startMs),
        result: m.result,
        settle: Number.isFinite(sv) ? sv : null,
        actual: info.person.actual,
        raw,
        game: pg.g,
      });
    }
  }
  const STAT = { KXMLBHIT: 'hits', KXMLBTB: 'tb', KXMLBHR: 'hr', KXMLBRBI: 'rbi', KXMLBHRR: 'hrr', KXMLBSB: 'sb' };
  coverage.matchedMarkets = marketRows.length;
  coverage.matchedGames = pricedGames.length;
  coverage.matchedPlayerGames = new Set(marketRows.map((r) => `${r.gamePk}:${r.personId}`)).size;
  coverage.doubleheaderMarketsMatched = marketRows.filter((r) => r.doubleheader).length;
  coverage.scalarSettledMatched = marketRows.filter((r) => r.settle != null && r.settle !== 0 && r.settle !== 1).length;
  coverage.settleDisagreesWithBoxScore = marketRows
    .filter((r) => (r.settle === 0 || r.settle === 1) && (r.actual[STAT[r.series]] >= r.threshold ? 1 : 0) !== r.settle)
    .map((r) => `${r.ticker} settle=${r.settle} actual=${r.actual[STAT[r.series]]} pa=${r.actual.pa}`);
  coverage.twoSidedAt = Object.fromEntries(DECISIONS.map((d) => [d, marketRows.filter((r) => r.q[d]?.mid != null).length]));
  coverage.anyQuoteAt = Object.fromEntries(DECISIONS.map((d) => [d, marketRows.filter((r) => r.q[d] != null).length]));
  coverage.bySeries = Object.fromEntries(SERIES.map((s) => {
    const rs = marketRows.filter((r) => r.series === s);
    return [s, { matched: rs.length, ...Object.fromEntries(DECISIONS.map((d) => [`twoSidedT-${d}`, rs.filter((r) => r.q[d]?.mid != null).length])) }];
  }));

  // ── decisions ─────────────────────────────────────────────────────────────
  const book = (q) => ({ orderbook: { yes: [[q.bid, 1e6]], no: [[100 - q.ask, 1e6]] } });
  const account = { balanceDollars: 1e6, valueDollars: 1e6, dayStartValueDollars: 1e6, positions: [], restingTickers: [] };
  const botConfig = { ...config, screenOnly: true, limits: { ...config.limits, bankrollDollars: 1e6 } };
  const makeTrade = (r, signal, d) => {
    const yes = signal.side === 'yes';
    const price = signal.priceCents;
    const payout = 100 * (yes ? r.settle : 1 - r.settle);
    const midSide = (q) => (q?.mid == null ? null : yes ? q.mid : 100 - q.mid);
    const fees = Object.fromEntries(FEES.map((f) => [f, (100 * f * price * (100 - price)) / 10000]));
    return {
      ticker: r.ticker, series: r.series, date: r.date, window: r.window, cluster: r.cluster, personId: r.personId,
      doubleheader: r.doubleheader, scalar: r.settle !== 0 && r.settle !== 1,
      side: signal.side, priceCents: price, payoutCents: payout, fees,
      edge: signal.edge, model: yes ? r.model : 1 - r.model, blended: signal.blendedProb,
      decisionMidSide: midSide(r.q[d]), closeMidSide: midSide(r.cq), expectedWinSide: price / 100,
      evPerDollar: signal.evPerDollar,
    };
  };
  const trades = {};
  const rowsBySeg = new Map();
  for (const r of marketRows) {
    if (!rowsBySeg.has(r.seg)) rowsBySeg.set(r.seg, []);
    rowsBySeg.get(r.seg).push(r);
  }
  for (const d of DECISIONS) {
    const T = (trades[d] = { every: [], bot: [], botOnePerPlayer: [] });
    for (const [, gameRows] of rowsBySeg) {
      const tradable = gameRows.filter((r) => r.q[d]?.bid != null && r.q[d]?.ask != null && r.settle != null);
      if (!tradable.length) continue;
      const decisionMs = gameRows[0].startMs - d * 60e3;
      const signals = new Map();
      for (const r of tradable) {
        const sig = buildSignal({ modelProb: r.model, book: normalizeOrderbook(r.ticker, book(r.q[d])), ticker: r.ticker, weight: WEIGHTS[r.marketKey] ?? 0.3, minEdge: config.minEdgeAfterFees });
        signals.set(r.ticker, sig);
        if (sig?.tradeable) T.every.push(makeTrade(r, sig, d));
      }
      const plan = planOrders({
        slate: { games: [gameRows[0].game] },
        markets: tradable.filter((r) => r.series !== SB_SERIES).map((r) => r.raw),
        books: new Map(tradable.map((r) => [r.ticker, book(r.q[d])])),
        account, state: {}, config: botConfig, now: new Date(decisionMs),
      });
      const byTicker = new Map(tradable.map((r) => [r.ticker, r]));
      const seen = new Set();
      for (const ticker of plan.screened || []) {
        const r = byTicker.get(ticker);
        const sig = signals.get(ticker);
        T.bot.push(makeTrade(r, sig, d));
        const pk = playerKeyOf(ticker);
        if (seen.has(pk)) continue;
        seen.add(pk);
        T.botOnePerPlayer.push(makeTrade(r, sig, d));
      }
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const withFee = (list, f) => list.map((t) => ({ ...t, feeCents: t.fees[f], pnlCents: t.payoutCents - t.priceCents - t.fees[f] }));
  const summ = (list) => summarize(list, { boot: BOOT });
  const groupBy = (list, fn) => {
    const g = new Map();
    for (const t of list) {
      const k = fn(t);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(t);
    }
    return [...g].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  const tradeReport = {};
  for (const d of DECISIONS) {
    tradeReport[d] = {};
    for (const [set, list] of Object.entries(trades[d])) {
      tradeReport[d][set] = {};
      for (const f of FEES) {
        const L = withFee(list, f);
        const out = (tradeReport[d][set][f] = {});
        for (const [wname, wfn] of Object.entries(WINDOW_SETS)) {
          const W = L.filter((t) => wfn(t.window));
          const o = (out[wname] = { all: summ(W) });
          for (const [k, g] of groupBy(W, (t) => t.series)) o[`series=${k}`] = summ(g);
          // Finer slices only where they are read (0.07 and 0.035 share the trade set).
          if ([POOLED, 'A', 'B', 'VAL', 'HOLD'].includes(wname)) {
            for (const [k, g] of groupBy(W, (t) => t.side)) o[`side=${k}`] = summ(g);
            for (const [k, g] of groupBy(W, (t) => priceBucket(t.priceCents))) o[`price=${k}`] = summ(g);
            for (const [k, g] of groupBy(W, (t) => `${t.series}/${t.side}`)) o[`series×side=${k}`] = summ(g);
            if (wname === POOLED) {
              for (const [k, g] of groupBy(W, (t) => `${t.series}/${priceBucket(t.priceCents)}`)) o[`series×price=${k}`] = summ(g);
              o['excluding doubleheaders'] = summ(W.filter((t) => !t.doubleheader));
              o.scalarTrades = W.filter((t) => t.scalar).length;
            }
          }
        }
      }
    }
  }

  // Forecast skill.
  const forecast = {};
  for (const d of DECISIONS) {
    const scored = marketRows
      .filter((r) => r.q[d]?.mid != null && (r.settle === 0 || r.settle === 1))
      .map((r) => ({
        series: r.series, window: r.window, y: r.settle, cluster: r.cluster, model: r.model, model2: r.model2,
        market: r.q[d].mid / 100,
        spread: r.q[d].ask - r.q[d].bid,
        close: r.cq?.mid != null ? r.cq.mid / 100 : null,
        blend: blendedProbability(r.model, r.q[d].mid / 100, WEIGHTS[r.marketKey] ?? 0.3),
      }));
    const skill = (list, full) => {
      if (!list.length) return { n: 0 };
      const out = {
        n: list.length,
        clusters: new Set(list.map((x) => x.cluster)).size,
        model: scoring(list, 'model'),
        market: scoring(list, 'market'),
        blend: scoring(list, 'blend'),
        modelMinusMarket: brierDiff(list, 'model', 'market', { boot: BOOT }),
        ...(list[0]?.model2 != null ? {
          reference: scoring(list.filter((x) => x.model2 != null), 'model2'),
          referenceMinusMarket: brierDiff(list.filter((x) => x.model2 != null), 'model2', 'market', { boot: BOOT }),
          modelMinusReference: brierDiff(list.filter((x) => x.model2 != null), 'model', 'model2', { boot: BOOT }),
        } : {}),
        blendMinusMarket: brierDiff(list, 'blend', 'market', { boot: BOOT }),
        bestModelWeight: brierOptimalModelWeight(list),
      };
      if (full) {
        const w = list.filter((x) => x.close != null);
        out.closeOnSameRows = w.length ? { n: w.length, close: scoring(w, 'close'), decision: scoring(w, 'market') } : null;
        out.modelCalibration = calibrationBins(list, 'model');
        out.marketCalibration = calibrationBins(list, 'market');
        const gap = list.map((x) => Math.abs(x.model - x.market)).sort((a, b) => a - b);
        out.absGapPts = { median: 100 * gap[Math.floor(gap.length / 2)], p90: 100 * gap[Math.floor(gap.length * 0.9)] };
        const sp = list.map((x) => x.spread).sort((a, b) => a - b);
        out.spreadCents = { median: sp[Math.floor(sp.length / 2)], p90: sp[Math.floor(sp.length * 0.9)] };
      }
      return out;
    };
    forecast[d] = {};
    for (const [label, filt] of [['all quotes', () => true], ['spread<=5c', (x) => x.spread <= 5]]) {
      const F = (forecast[d][label] = {});
      for (const wname of Object.keys(WINDOW_SETS)) {
        const W = scored.filter((x) => filt(x) && WINDOW_SETS[wname](x.window));
        F[wname] = { all: skill(W, label === 'all quotes' && wname === 'A+B') };
        for (const s of SERIES) F[wname][s] = skill(W.filter((x) => x.series === s), label === 'all quotes' && wname === 'A+B');
      }
    }
  }

  // Pre-registered edge test.
  //   orig  docs/KALSHI-BATTER-BACKTEST.md Method 9: bot, T-120, fee 0.035.
  //   edge  docs/BATTER-EDGE-SEARCH.md section 3, on `--bar-window`: the model
  //         beats the decision mid on Brier AND ROI after the 0.07 fee is
  //         positive, both with a game-cluster 95% interval excluding zero.
  const brierAll = forecast[120]['all quotes'];
  const edgeTest = {};
  if (SCHEME === 'edge') {
    const WIN = arg('bar-window', 'VAL');
    const cells = [...SERIES.map((x) => [x, x === SB_SERIES ? 'every' : 'bot', `series=${x}`]),
      ['pooled botOnePerPlayer', 'botOnePerPlayer', 'all']];
    for (const [label, set, key] of cells) {
      const R = tradeReport[120][set][0.07][WIN]?.[key];
      const bd = (label.startsWith('pooled') ? brierAll[WIN]?.all : brierAll[WIN]?.[label])?.modelMinusMarket;
      const e = {
        n: R?.n ?? 0,
        A_brierBeatsPrice: Boolean(bd && bd.point < 0 && bd.ci95[1] < 0),
        brier: bd ? `${bd.point.toFixed(4)} [${bd.ci95[0].toFixed(4)}, ${bd.ci95[1].toFixed(4)}]` : null,
        B_roiPositive: Boolean(R?.n && R.roiPct > 0 && R.roiCI95[0] > 0),
        roi: R?.n ? `${R.roiPct.toFixed(1)}% [${R.roiCI95[0].toFixed(1)}, ${R.roiCI95[1].toFixed(1)}]` : null,
      };
      e.passes = e.A_brierBeatsPrice && e.B_roiPositive;
      edgeTest[`${WIN} ${label}`] = e;
    }
  } else {
    for (const [label, set, key] of [...SERIES.map((x) => [x, 'bot', `series=${x}`]), ['pooled botOnePerPlayer', 'botOnePerPlayer', 'all']]) {
      const R = tradeReport[120][set][0.035];
      const ab = R['A+B'][key], a = R.A[key], b = R.B[key];
      const brier = (w) => (label.startsWith('pooled') ? brierAll[w].all : brierAll[w][label])?.modelMinusMarket?.point;
      edgeTest[label] = {
        a_pooledCiLowerAbove0: ab?.n ? ab.roiCI95[0] > 0 : false,
        b_positiveInBothWindows: Boolean(a?.n && b?.n && a.roiPct > 0 && b.roiPct > 0),
        c_modelBeatsMarketBrierBothWindows: brier('A') < 0 && brier('B') < 0,
      };
      edgeTest[label].qualifies = Object.values(edgeTest[label]).every(Boolean);
    }
  }

  const report = { window: { from: FROM, to: TO }, coverage, trades: tradeReport, forecast, edgeTest, runtimeMin: (Date.now() - t0) / 60e3, kalshiRequests: kalshiRequestCount() };
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ report, trades }, null, 1));
  print(report);
}

function fmt(s) {
  if (!s || !s.n) return 'n=0';
  const f = (x, dd = 1) => (x == null ? '—' : x.toFixed(dd));
  return `n=${String(s.n).padStart(5)} (${String(s.clusters).padStart(4)} g)  hit ${f(100 * s.hitRate)}% vs ${f(100 * s.breakEvenHit)}%  P&L ${s.pnlPerContractCents >= 0 ? '+' : ''}${f(s.pnlPerContractCents, 2)}c  ROI ${s.roiPct >= 0 ? '+' : ''}${f(s.roiPct)}% [${f(s.roiCI95[0])}, ${f(s.roiCI95[1])}]  CLV mid ${f(s.clvMidCents, 2)}c paid ${f(s.clvVsPaidCents, 2)}c for/against ${f(100 * s.pctBeatCloseMid, 0)}/${f(100 * s.pctWorseThanCloseMid, 0)}%`;
}

function print(r) {
  console.log(`window ${r.window.from}..${r.window.to}; runtime ${r.runtimeMin.toFixed(1)} min; ${r.kalshiRequests} Kalshi requests`);
  const { skip, skipBySeries, settleDisagreesWithBoxScore, ...cov } = r.coverage;
  console.log('coverage:', JSON.stringify(cov));
  console.log('unmatched:', JSON.stringify(skip));
  console.log('unmatched by series:', JSON.stringify(skipBySeries));
  console.log(`settlement vs box score disagreements: ${settleDisagreesWithBoxScore.length}`, settleDisagreesWithBoxScore.slice(0, 10));
  for (const [d, sets] of Object.entries(r.trades).sort((x, y) => y[0] - x[0])) {
    for (const [set, fees] of Object.entries(sets)) {
      for (const [f, wins] of Object.entries(fees)) {
        console.log(`\n=== T-${d}  ${set}  fee ${f} ===`);
        for (const [w, splits] of Object.entries(wins)) {
          for (const [k, s] of Object.entries(splits)) {
            if (typeof s === 'number') { console.log(`${w.padEnd(4)} ${k.padEnd(30)} ${s}`); continue; }
            if (k.startsWith('series×price') && f !== '0.07') continue;
            console.log(`${w.padEnd(4)} ${k.padEnd(30)} ${fmt(s)}`);
          }
        }
      }
    }
  }
  for (const [d, views] of Object.entries(r.forecast).sort((x, y) => y[0] - x[0])) {
    for (const [label, wins] of Object.entries(views)) {
      console.log(`\n=== forecast skill T-${d} (${label}) — Brier model | market | blend; model-market [CI]; blend-market [CI]; best w ===`);
      for (const [w, bySeries] of Object.entries(wins)) {
        for (const [s, x] of Object.entries(bySeries)) {
          if (!x.n) { console.log(`${w.padEnd(4)} ${s.padEnd(9)} n=0`); continue; }
          const dd = (z) => `${z.point >= 0 ? '+' : ''}${z.point.toFixed(4)} [${z.ci95[0].toFixed(4)}, ${z.ci95[1].toFixed(4)}]`;
          console.log(`${w.padEnd(4)} ${s.padEnd(9)} n=${String(x.n).padStart(6)}  ${x.model.brier.toFixed(4)} | ${x.market.brier.toFixed(4)} | ${x.blend.brier.toFixed(4)}  m-mkt ${dd(x.modelMinusMarket)}  b-mkt ${dd(x.blendMinusMarket)}  w=${x.bestModelWeight.w}`);
          if (x.reference) console.log(`${''.padEnd(15)}reference ${x.reference.brier.toFixed(4)}  ref-mkt ${dd(x.referenceMinusMarket)}  model-ref ${dd(x.modelMinusReference)}`);
          if (x.modelCalibration) {
            console.log(`${''.padEnd(15)}model calib: ${x.modelCalibration.join('  ')}`);
            console.log(`${''.padEnd(15)}market calib: ${x.marketCalibration.join('  ')}`);
            console.log(`${''.padEnd(15)}|model-market| pts ${JSON.stringify(x.absGapPts)}  spread c ${JSON.stringify(x.spreadCents)}  close vs decision ${x.closeOnSameRows ? `${x.closeOnSameRows.close.brier.toFixed(4)} vs ${x.closeOnSameRows.decision.brier.toFixed(4)} (n=${x.closeOnSameRows.n})` : '—'}`);
          }
        }
      }
    }
  }
  console.log('\n=== pre-registered edge test (T-120) ===');
  for (const [k, v] of Object.entries(r.edgeTest)) console.log(`${k.padEnd(24)} ${JSON.stringify(v)}`);
}

await main();
