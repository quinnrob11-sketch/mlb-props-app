// KXMLBOUTS only: is there a real edge, or is it noise?
//
//   node tools/outs-study.mjs --from 2026-07-16 --to 2026-09-21 \
//     --cache C:/Users/qrob1/mlbwork/bt-cache-outs \
//     --kcache C:/Users/qrob1/mlbwork/kcache-outs [--json out.json]
//
// The rule, the bar and every cut below were pre-registered in
// docs/OUTS-STUDY.md and committed BEFORE any profit number for this window was
// computed. Nothing here was chosen after seeing a result.
//
// This is a focused sibling of tools/backtest-kalshi.mjs. It shares that tool's
// plumbing (kalshi-common.mjs) and its lookahead-free model replay
// (backtest-pitchers.mjs), and adds the four things that study could not answer
// about the outs market:
//
//   1. The full live-tier history of the series in one window, with both
//      decision times and both fee rates from a single pass.
//   2. Cuts that need start-level context the generic tool does not carry:
//      home/away, and established starter vs opener/low-sample (the population
//      the v35.2 reliever leash was aimed at).
//   3. NAIVE RULES with no model input at all. If "always buy NO" earns what
//      the model's picks earn, the model is not the source of the edge. This is
//      bar item (D), and it is the one that decides whether any apparent edge
//      belongs to this codebase or merely to the market.
//   4. The sample size that would be needed to tell the observed effect from
//      zero at 95%, which is the answer to "how long must paper trading run".
//
// Kalshi PUBLIC endpoints only, no auth, no orders. Everything is cached.

import fs from 'node:fs';
import path from 'node:path';
import { buildStarts, schedule } from './backtest-pitchers.mjs';
import { projectPitcher } from '../src/model/pitcher.js';
import { planOrders, modelProbability } from '../bot/plan.mjs';
import { normalizeMarket, normalizeOrderbook } from '../src/lib/kalshi.js';
import { parseKalshiGameTicker } from '../src/data/teamMarkets.js';
import { buildSignal } from '../src/trade/signals.js';
import { MARKET_WEIGHT } from '../src/lib/constants.js';
import {
  kget, readJson, settledMarkets as settledMarketsIn, quoteAt, summarize as summarizeBoot,
  scoring, brierDiff as brierDiffBoot, calibrationBins, brierOptimalModelWeight, priceBucket,
  mulberry32, KALSHI,
} from './kalshi-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const FROM = arg('from', '2026-07-16');
const TO = arg('to', '2026-09-21');
const KCACHE = arg('kcache', path.resolve('.kalshi-cache'));
const JSON_OUT = arg('json', null);
const BOOT = Number(arg('boot', 20000));
const SERIES = 'KXMLBOUTS';

// ── pre-registered constants (docs/OUTS-STUDY.md) ───────────────────────────
const DECISION_TIMES = [120, 30];   // primary first
const HALF_SPLIT = '2026-08-19';    // H1 = FROM..08-18, H2 = 08-19..TO
const OOS_FROM = '2026-09-01';      // the only slice outside the model's fit window
const FEE_MAIN = 0.07;
const FEE_SENS = 0.035;             // series fee_multiplier 0.5
const PRICE_MIN = 25;               // config.example.json limits, v36.1
const PRICE_MAX = 90;
const ESTABLISHED_PRIOR_STARTS = 3; // >= this = established starter

fs.mkdirSync(path.join(KCACHE, 'candles'), { recursive: true });

const summarize = (t) => summarizeBoot(t, { boot: BOOT });
const brierDiff = (r, a, b) => brierDiffBoot(r, a, b, { boot: BOOT });

/** Scheduled first pitch (UTC ms) from the ET time in an event ticker. */
function tickerStartMs(eventTicker) {
  const p = parseKalshiGameTicker(eventTicker);
  if (!p) return null;
  const [y, mo, d] = p.date.split('-').map(Number);
  const h = Math.floor(p.etMinutes / 60);
  const mi = p.etMinutes % 60;
  let ms = Date.UTC(y, mo - 1, d, h + 4, mi);
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const etH = Number(et.find((x) => x.type === 'hour').value);
  if (etH !== h) ms += (h - etH) * 3600e3;
  return ms;
}

/** 1-minute candles for one game's markets, cached per game segment. */
async function gameCandles(gameKey, markets, endMs) {
  const file = path.join(KCACHE, 'candles', `${gameKey}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const out = {};
  const startTs = Math.floor(Math.min(...markets.map((m) => Date.parse(m.open_time))) / 1000);
  const endTs = Math.floor(endMs / 1000);
  const tickers = markets.map((m) => m.ticker);
  const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));
  const perRequest = Math.max(1, Math.floor(10000 / (Math.ceil((endTs - startTs) / 60) + 2)));
  for (let i = 0; i < tickers.length; i += perRequest) {
    const chunk = tickers.slice(i, i + perRequest);
    const body = await kget(`${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=1`);
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [c.end_period_ts, cents(c.yes_bid?.close_dollars), cents(c.yes_ask?.close_dollars)]);
    }
    for (const t of chunk) out[t] ||= [];
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
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

// ── trade construction ──────────────────────────────────────────────────────
/**
 * One flat 1-contract taker trade. `side`/`price` are given explicitly so the
 * naive rules, which have no signal object, build trades the same way the
 * model's do — same fee, same settlement, same fields for `summarize`.
 */
function tradeOf(r, side, priceCents, quote, extra = {}) {
  const yes = side === 'yes';
  const fee = (100 * FEE_MAIN * priceCents * (100 - priceCents)) / 10000;
  const payout = 100 * (yes ? r.settle : 1 - r.settle);
  const midSide = (q) => (q?.mid == null ? null : yes ? q.mid : 100 - q.mid);
  return {
    ticker: r.ticker, date: r.date, cluster: r.cluster, pitcherId: r.pitcherId,
    threshold: r.threshold, isHome: r.isHome, priorStarts: r.priorStarts,
    side, priceCents, feeCents: fee, pnlCents: payout - priceCents - fee,
    model: yes ? r.model : 1 - r.model,
    marketMid: quote?.mid == null ? null : (yes ? quote.mid : 100 - quote.mid) / 100,
    gapPts: quote?.mid == null ? null : 100 * (r.model - quote.mid / 100),
    y: r.settle,
    decisionMidSide: midSide(quote), closeMidSide: midSide(r.cq),
    expectedWinSide: priceCents / 100,
    won: payout === 100,
    ...extra,
  };
}

const inBounds = (c) => c >= PRICE_MIN && c <= PRICE_MAX;

/** One rung per start, chosen WITHOUT the model: the most lopsided mid. */
function collapseByPrice(rows, quoteOf) {
  const best = new Map();
  for (const r of rows) {
    const q = quoteOf(r);
    if (q?.mid == null) continue;
    const score = Math.abs(q.mid - 50);
    const prev = best.get(r.cluster);
    if (!prev || score > prev.score) best.set(r.cluster, { r, q, score });
  }
  return [...best.values()];
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const config = readJson(new URL('../bot/config.example.json', import.meta.url));

  const all = await settledMarketsIn(KCACHE, SERIES);
  const liveTierSpan = (() => {
    let first = null, last = null;
    for (const m of all) {
      const p = parseKalshiGameTicker(m.event_ticker);
      if (!p) continue;
      if (!first || p.date < first) first = p.date;
      if (!last || p.date > last) last = p.date;
    }
    return { first, last, n: all.length };
  })();
  const inWindow = all.filter((m) => {
    const p = parseKalshiGameTicker(m.event_ticker);
    return p && p.date >= FROM && p.date <= TO;
  });

  // Model inputs: the lookahead-free replay.
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
  const slates = new Map();
  const gamesInWindow = new Set();
  for (const d of schedule.dates) {
    for (const g of d.games) {
      if (g.status?.detailedState === 'Postponed' || g.status?.codedGameState === 'D') continue;
      const etDate = new Date(g.gameDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (etDate < FROM || etDate > TO) continue;
      gamesInWindow.add(g.gamePk);
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

  const byGame = new Map();
  for (const m of inWindow) {
    const seg = m.ticker.split('-')[1];
    if (!byGame.has(seg)) byGame.set(seg, []);
    byGame.get(seg).push(m);
  }

  const coverage = {
    liveTierSpan,
    marketsInWindow: inWindow.length,
    gameSegmentsInWindow: byGame.size,
    mlbGamesInWindow: gamesInWindow.size,
    replayedStartsInWindow: starts.filter((s) => s.date >= FROM && s.date <= TO).length,
    skip: {},
  };
  const bump = (r) => (coverage.skip[r] = (coverage.skip[r] || 0) + 1);

  const rows = [];
  let fetched = 0;
  for (const [seg, markets] of [...byGame].sort()) {
    const startMs = tickerStartMs(markets[0].event_ticker);
    const p = parseKalshiGameTicker(markets[0].event_ticker);
    const slate = slates.get(p.date) || { games: [] };
    const priced = markets.map((m) => ({ m, info: modelProbability(normalizeMarket(m), slate, config) }));
    const usable = priced.filter((x) => x.info.prob != null);
    for (const x of priced) if (x.info.prob == null) bump(`model: ${x.info.reason}`);
    if (!usable.length) continue;
    const candles = await gameCandles(seg, usable.map((x) => x.m), startMs);
    if (++fetched % 25 === 0) process.stderr.write(`  candles for ${fetched} games\r`);
    for (const { m, info } of usable) {
      const sv = Number(m.settlement_value_dollars);
      const start = info.person.start;
      rows.push({
        ticker: m.ticker,
        date: p.date,
        startMs,
        cluster: `${info.person.id}:${p.date}`,
        pitcherId: info.person.id,
        marketKey: info.marketKey,
        threshold: normalizeMarket(m).threshold,
        model: info.prob,
        isHome: start.isHome === true ? 'home' : start.isHome === false ? 'away' : 'unknown',
        priorStarts: (start.input.gameLog || []).length,
        q: Object.fromEntries(DECISION_TIMES.map((t) => [t, quoteAt(candles[m.ticker], startMs - t * 60e3)])),
        cq: quoteAt(candles[m.ticker], startMs),
        result: m.result,
        settle: Number.isFinite(sv) ? sv : m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null,
        actualOuts: start.actual.outs,
        raw: m,
        game: info.game,
      });
    }
  }
  process.stderr.write('\n');

  coverage.matchedMarkets = rows.length;
  coverage.matchedStarts = new Set(rows.map((r) => r.cluster)).size;
  coverage.rungsPerStart = +(rows.length / new Set(rows.map((r) => r.cluster)).size).toFixed(2);
  for (const t of DECISION_TIMES) {
    coverage[`twoSidedAtT-${t}`] = rows.filter((r) => r.q[t]?.bid != null && r.q[t]?.ask != null).length;
    // Kalshi emits a minute candle only when something changes, so the decision
    // quote can be much older than the decision time. How much older matters:
    // a quote from many hours before is a real book, but a stale one.
    const age = rows.filter((r) => r.q[t]?.ts).map((r) => Math.round((r.startMs - t * 60e3) / 1000 - r.q[t].ts) / 60).sort((a, b) => a - b);
    coverage[`decisionQuoteAgeMinutesT-${t}`] = age.length
      ? { median: age[Math.floor(age.length / 2)], p90: age[Math.floor(age.length * 0.9)], max: age[age.length - 1] }
      : null;
  }
  coverage.doubleheaderMarketsDroppedByTickerParse = all.filter((m) => /G[12]$/.test(m.event_ticker)).length;
  coverage.scalarSettlementsInSeries = all.filter((m) => m.result && m.result !== 'yes' && m.result !== 'no').length;
  coverage.nonBinarySettlement = rows.filter((r) => r.settle != null && r.settle !== 0 && r.settle !== 1).length;
  coverage.settleDisagreesWithBoxScore = rows
    .filter((r) => (r.settle === 0 || r.settle === 1) && (r.actualOuts >= r.threshold ? 1 : 0) !== r.settle)
    .map((r) => `${r.ticker} settle=${r.settle} outs=${r.actualOuts} line=${r.threshold}`);
  coverage.datesCovered = new Set(rows.map((r) => r.date)).size;
  coverage.marketsPerDate = Object.fromEntries(
    [...rows.reduce((mp, r) => mp.set(r.date, (mp.get(r.date) || 0) + 1), new Map())].sort(),
  );

  // ── decisions at each decision time ──────────────────────────────────────
  const book = (q) => ({ orderbook: { yes: [[q.bid, 1e6]], no: [[100 - q.ask, 1e6]] } });
  const account = { balanceDollars: 1e6, valueDollars: 1e6, dayStartValueDollars: 1e6, positions: [], restingTickers: [] };
  const botConfig = { ...config, screenOnly: true, limits: { ...config.limits, bankrollDollars: 1e6 } };

  const rowsByGame = new Map();
  for (const r of rows) {
    const k = r.ticker.split('-')[1];
    if (!rowsByGame.has(k)) rowsByGame.set(k, []);
    rowsByGame.get(k).push(r);
  }

  const runs = {};
  for (const T of DECISION_TIMES) {
    const quoteOf = (r) => r.q[T];
    const sets = { bot: [], every: [], botOnePerStart: [], botRuleLocal: [], botDepthBugFixed: [], everyDepthBugFixed: [], N1_alwaysNo: [], N2_alwaysYes: [], N3_favourite: [], N4_underdog: [], N5_botContractsPriceSide: [] };
    const signalOf = new Map();

    for (const [, gameRows] of rowsByGame) {
      const tradable = gameRows.filter((r) => quoteOf(r)?.bid != null && quoteOf(r)?.ask != null && r.settle != null);
      if (!tradable.length) continue;
      const decisionMs = gameRows[0].startMs - T * 60e3;

      // (i) every signal, no filters at all: buildSignal alone.
      for (const r of tradable) {
        const q = quoteOf(r);
        const sig = buildSignal({
          modelProb: r.model, book: normalizeOrderbook(r.ticker, book(q)), ticker: r.ticker,
          weight: MARKET_WEIGHT[r.marketKey] ?? 0.3, minEdge: config.minEdgeAfterFees,
        });
        signalOf.set(r.ticker, sig);
        if (sig?.tradeable) sets.every.push(tradeOf(r, sig.side, sig.priceCents, q, { edge: sig.edge, evPerDollar: sig.evPerDollar, blended: sig.blendedProb }));
        // BUG(src/trade/signals.js:177): for a NO buy the depth filter keeps
        // resting YES levels at or BELOW the NO price, when the levels that are
        // actually available are those at or ABOVE the best bid. On this
        // one-level synthetic book that makes `availableContracts` 0 whenever
        // the yes bid exceeds 50c, so `tradeable` is false and the bot can
        // never fade a favourite. The depth-fixed sets drop the depth term
        // (the book here is always deep enough for 1 contract) and keep every
        // other condition, to measure what the bug costs.
        if (sig && sig.edge >= sig.requiredEdge) {
          sets.everyDepthBugFixed.push(tradeOf(r, sig.side, sig.priceCents, q, { edge: sig.edge, evPerDollar: sig.evPerDollar, blended: sig.blendedProb }));
        }
      }

      // The bot's screen re-implemented locally, so the depth term can be
      // switched off. `botRuleLocal` must reproduce `bot` exactly; the printed
      // report asserts that, and a mismatch means this replica drifted.
      for (const depthFixed of [false, true]) {
        const cand = [];
        for (const r of tradable) {
          const sig = signalOf.get(r.ticker);
          const q = quoteOf(r);
          if (!sig) continue;
          if (Date.parse(r.game.gameDate) - decisionMs < (config.minMinutesBeforeStart ?? 10) * 60e3) continue;
          if (Math.abs(r.model - q.mid / 100) > 0.12) continue; // IMPLAUSIBLE.prop
          const ok = depthFixed ? sig.edge >= sig.requiredEdge : sig.tradeable;
          if (!ok) continue;
          if (!inBounds(sig.priceCents)) continue;
          cand.push({ r, sig, q });
        }
        // one rung per pitcher ladder, best EV per dollar
        const bestRung = new Map();
        for (const c of cand) {
          const prev = bestRung.get(c.r.cluster);
          if (!prev || c.sig.evPerDollar > prev.sig.evPerDollar) bestRung.set(c.r.cluster, c);
        }
        for (const { r, sig, q } of bestRung.values()) {
          (depthFixed ? sets.botDepthBugFixed : sets.botRuleLocal)
            .push(tradeOf(r, sig.side, sig.priceCents, q, { edge: sig.edge, evPerDollar: sig.evPerDollar, blended: sig.blendedProb }));
        }
      }

      // (ii) the bot's current rule: planOrders itself.
      const plan = planOrders({
        slate: { games: [gameRows[0].game] }, markets: tradable.map((r) => r.raw),
        books: new Map(tradable.map((r) => [r.ticker, book(quoteOf(r))])),
        account, state: {}, config: botConfig, now: new Date(decisionMs),
      });
      const byTicker = new Map(tradable.map((r) => [r.ticker, r]));
      const picked = (plan.screened || []).map((t) => byTicker.get(t)).filter(Boolean);
      const seen = new Set();
      for (const r of picked) {
        const sig = signalOf.get(r.ticker);
        const q = quoteOf(r);
        const t = tradeOf(r, sig.side, sig.priceCents, q, { edge: sig.edge, evPerDollar: sig.evPerDollar, blended: sig.blendedProb });
        sets.bot.push(t);
        // (v) N5: same contracts, but the side the PRICE favours.
        const priceSide = q.mid >= 50 ? 'yes' : 'no';
        const pricePrice = priceSide === 'yes' ? q.ask : 100 - q.bid;
        if (inBounds(pricePrice)) sets.N5_botContractsPriceSide.push(tradeOf(r, priceSide, pricePrice, q));
        // (iii) one bet per start (planOrders ranks by EV per dollar).
        if (!seen.has(r.cluster)) { seen.add(r.cluster); sets.botOnePerStart.push(t); }
      }
    }

    // (iv) naive rules: one rung per start chosen by price alone, no model anywhere.
    for (const { r, q } of collapseByPrice(rows.filter((x) => x.settle != null), quoteOf)) {
      if (q.bid == null || q.ask == null) continue;
      const yesPrice = q.ask;
      const noPrice = 100 - q.bid;
      const fav = q.mid >= 50 ? 'yes' : 'no';
      if (inBounds(noPrice)) sets.N1_alwaysNo.push(tradeOf(r, 'no', noPrice, q));
      if (inBounds(yesPrice)) sets.N2_alwaysYes.push(tradeOf(r, 'yes', yesPrice, q));
      const favPrice = fav === 'yes' ? yesPrice : noPrice;
      const dogPrice = fav === 'yes' ? noPrice : yesPrice;
      if (inBounds(favPrice)) sets.N3_favourite.push(tradeOf(r, fav, favPrice, q));
      if (inBounds(dogPrice)) sets.N4_underdog.push(tradeOf(r, fav === 'yes' ? 'no' : 'yes', dogPrice, q));
    }
    runs[T] = sets;
  }

  // ── cuts ────────────────────────────────────────────────────────────────
  const half = (d) => (d < HALF_SPLIT ? 'H1' : 'H2');
  const gapBucket = (g) => {
    const a = Math.abs(g);
    return a < 3 ? '0-3pts' : a < 6 ? '3-6pts' : a < 9 ? '6-9pts' : '9+pts';
  };
  const feeSens = (list) => summarize(list.map((t) => {
    const fee = (100 * FEE_SENS * t.priceCents * (100 - t.priceCents)) / 10000;
    return { ...t, feeCents: fee, pnlCents: t.pnlCents + t.feeCents - fee };
  }));
  const splits = (list) => {
    const out = { all: summarize(list), 'fee=0.035': feeSens(list) };
    const by = (label, fn) => {
      const groups = new Map();
      for (const t of list) {
        const k = fn(t);
        if (k == null) continue;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      }
      for (const [k, g] of [...groups].sort()) out[`${label}=${k}`] = summarize(g);
    };
    by('half', (t) => half(t.date));
    by('sep-oos', (t) => (t.date >= OOS_FROM ? 'Sep(out-of-fit)' : 'Jul-Aug(in-fit)'));
    by('side', (t) => t.side);
    by('price', (t) => priceBucket(t.priceCents));
    by('gap', (t) => (t.gapPts == null ? null : gapBucket(t.gapPts)));
    by('venue', (t) => t.isHome);
    by('starter', (t) => (t.priorStarts >= ESTABLISHED_PRIOR_STARTS ? `established(${ESTABLISHED_PRIOR_STARTS}+ prior starts)` : 'opener/low-sample'));
    by('line', (t) => `${t.threshold}+`);
    return out;
  };

  // ── forecast skill ──────────────────────────────────────────────────────
  const skillRows = (T) => rows
    .filter((r) => r.q[T]?.mid != null && (r.settle === 0 || r.settle === 1))
    .map((r) => ({
      y: r.settle, cluster: r.cluster, date: r.date, model: r.model, market: r.q[T].mid / 100,
      close: r.cq?.mid != null ? r.cq.mid / 100 : null,
    }));
  const skill = (list) => list.length ? {
    n: list.length,
    brierDiffModelMinusMarket: brierDiff(list, 'model', 'market'),
    brierOptimalModelWeight: brierOptimalModelWeight(list),
    model: scoring(list, 'model'),
    market: scoring(list, 'market'),
    modelCalibration: calibrationBins(list, 'model'),
    marketCalibration: calibrationBins(list, 'market'),
  } : { n: 0 };

  /** Paired Brier difference on the contracts a trade set actually bought. */
  const skillOnTraded = (trades) => {
    const list = trades.filter((t) => t.marketMid != null && (t.y === 0 || t.y === 1))
      .map((t) => ({ y: t.y, cluster: t.cluster, model: t.model, market: t.marketMid }));
    return skill(list);
  };

  // ── sample size ─────────────────────────────────────────────────────────
  /**
   * How many trades would be needed for a 95% interval on mean P&L to exclude
   * zero, at the observed mean and spread. The design effect is measured, not
   * assumed: it is the ratio of the cluster-bootstrap variance of the mean to
   * the iid variance, so correlated rungs of one start count as less than one
   * trade each.
   */
  const sampleSize = (trades, days) => {
    const n = trades.length;
    if (n < 2) return { n };
    const mean = trades.reduce((s, t) => s + t.pnlCents, 0) / n;
    const sd = Math.sqrt(trades.reduce((s, t) => s + (t.pnlCents - mean) ** 2, 0) / (n - 1));
    const clusters = new Map();
    for (const t of trades) {
      if (!clusters.has(t.cluster)) clusters.set(t.cluster, []);
      clusters.get(t.cluster).push(t.pnlCents);
    }
    const cl = [...clusters.values()];
    const rand = mulberry32(4242);
    const means = [];
    for (let b = 0; b < 4000; b++) {
      let s = 0, k = 0;
      for (let i = 0; i < cl.length; i++) {
        const c = cl[Math.floor(rand() * cl.length)];
        for (const v of c) { s += v; k++; }
      }
      means.push(s / k);
    }
    const mu = means.reduce((a, b) => a + b, 0) / means.length;
    const varCluster = means.reduce((a, b) => a + (b - mu) ** 2, 0) / (means.length - 1);
    const varIid = (sd * sd) / n;
    const deff = Math.max(1, varCluster / varIid);
    const needed = mean === 0 ? Infinity : Math.ceil(((1.96 * sd) / mean) ** 2 * deff);
    return {
      n, meanPnlCents: mean, sdPnlCents: sd, designEffect: +deff.toFixed(2),
      tradesNeededTotal: needed,
      additionalTradesNeeded: Number.isFinite(needed) ? Math.max(0, needed - n) : Infinity,
      tradesPerDay: +(n / days).toFixed(2),
      daysOfPaperTrading: Number.isFinite(needed) ? Math.ceil(Math.max(0, needed - n) / (n / days)) : Infinity,
      note: mean <= 0 ? 'mean P&L is not positive; no sample size makes a negative edge significant-positive' : null,
    };
  };

  /**
   * Paired: the same contracts, the model's side vs the price's side. This is
   * the cleanest "did the model add anything" test available, because contract
   * selection is held fixed and only the side differs. Cluster bootstrap of the
   * ROI difference over pitcher-start.
   */
  const pairedSideTest = (botTrades, naiveTrades) => {
    const byTicker = new Map(naiveTrades.map((t) => [t.ticker, t]));
    const pairs = botTrades.map((b) => ({ b, p: byTicker.get(b.ticker) })).filter((x) => x.p);
    if (!pairs.length) return { n: 0 };
    const sameSide = pairs.filter((x) => x.b.side === x.p.side).length;
    const clusters = new Map();
    for (const { b, p } of pairs) {
      if (!clusters.has(b.cluster)) clusters.set(b.cluster, { bp: 0, bc: 0, pp: 0, pc: 0 });
      const c = clusters.get(b.cluster);
      c.bp += b.pnlCents; c.bc += b.priceCents + b.feeCents;
      c.pp += p.pnlCents; c.pc += p.priceCents + p.feeCents;
    }
    const cl = [...clusters.values()];
    const roiOf = (list, a, b) => (100 * list.reduce((s, k) => s + k[a], 0)) / list.reduce((s, k) => s + k[b], 0);
    const point = roiOf(cl, 'bp', 'bc') - roiOf(cl, 'pp', 'pc');
    const rand = mulberry32(31337);
    const d = [];
    for (let i = 0; i < BOOT; i++) {
      const s = Array.from({ length: cl.length }, () => cl[Math.floor(rand() * cl.length)]);
      d.push(roiOf(s, 'bp', 'bc') - roiOf(s, 'pp', 'pc'));
    }
    d.sort((x, y) => x - y);
    return {
      n: pairs.length,
      sameSide,
      differentSide: pairs.length - sameSide,
      roiDiffPct: point,
      ci95: [d[Math.floor(0.025 * BOOT)], d[Math.floor(0.975 * BOOT)]],
    };
  };

  const days = coverage.datesCovered || 1;
  const primary = runs[DECISION_TIMES[0]].bot;
  const report = {
    window: { from: FROM, to: TO, halfSplit: HALF_SPLIT, decisionTimes: DECISION_TIMES, series: SERIES },
    coverage,
    runs: Object.fromEntries(DECISION_TIMES.map((T) => [
      `T-${T}`,
      Object.fromEntries(Object.entries(runs[T]).map(([k, v]) => [k, splits(v)])),
    ])),
    forecast: Object.fromEntries(DECISION_TIMES.map((T) => {
      const sr = skillRows(T);
      return [`T-${T}`, {
        allMatched: skill(sr),
        H1: skill(sr.filter((x) => half(x.date) === 'H1')),
        H2: skill(sr.filter((x) => half(x.date) === 'H2')),
        sepOutOfFit: skill(sr.filter((x) => x.date >= OOS_FROM)),
        onBotTradedContracts: skillOnTraded(runs[T].bot),
      }];
    })),
    sampleSize: Object.fromEntries(DECISION_TIMES.map((T) => [`T-${T}`, {
      bot: sampleSize(runs[T].bot, days),
      every: sampleSize(runs[T].every, days),
      // Planning number. The observed mean is the largest estimate consistent
      // with this sample and will regress; halving it is the cheapest honest
      // hedge, and it quadruples the sample required.
      botAtHalfTheObservedEdge: (() => {
        const s = sampleSize(runs[T].bot, days);
        if (!Number.isFinite(s.tradesNeededTotal)) return s;
        const needed = s.tradesNeededTotal * 4;
        return { tradesNeededTotal: needed, additionalTradesNeeded: needed - s.n, daysOfPaperTrading: Math.ceil((needed - s.n) / s.tradesPerDay) };
      })(),
    }])),
    modelVsPriceSide: Object.fromEntries(DECISION_TIMES.map((T) => [
      `T-${T}`, pairedSideTest(runs[T].bot, runs[T].N5_botContractsPriceSide),
    ])),
    replicaCheck: Object.fromEntries(DECISION_TIMES.map((T) => {
      const a = runs[T].bot.map((t) => `${t.ticker}/${t.side}@${t.priceCents}`).sort().join(',');
      const b = runs[T].botRuleLocal.map((t) => `${t.ticker}/${t.side}@${t.priceCents}`).sort().join(',');
      return [`T-${T}`, { identical: a === b, bot: runs[T].bot.length, local: runs[T].botRuleLocal.length }];
    })),
    // POST HOC, not part of the pre-registered bar: the single clearest
    // price-only pattern in the data, stated so it cannot be mistaken for a
    // pre-registered result.
    postHocNaive: Object.fromEntries(DECISION_TIMES.map((T) => {
      const yesAtFavPrice = runs[T].N2_alwaysYes.filter((t) => t.priceCents >= 60);
      return [`T-${T}`, { label: 'POST HOC: always buy YES at 60c+', ...summarize(yesAtFavPrice) }];
    })),
    // Bar (A)-(D) from docs/OUTS-STUDY.md, evaluated mechanically.
    bar: (() => {
      const s = summarize(primary);
      const h1 = summarize(primary.filter((t) => half(t.date) === 'H1'));
      const h2 = summarize(primary.filter((t) => half(t.date) === 'H2'));
      const traded = skillOnTraded(primary);
      const naive = Object.fromEntries(['N1_alwaysNo', 'N2_alwaysYes', 'N3_favourite', 'N4_underdog', 'N5_botContractsPriceSide']
        .map((k) => [k, summarize(runs[DECISION_TIMES[0]][k]).roiPct]));
      const bestNaive = Math.max(...Object.values(naive).filter(Number.isFinite));
      return {
        A_pooledCIAboveZero: s.n ? s.roiCI95[0] > 0 : false,
        A_value: s.n ? { roiPct: s.roiPct, ci: s.roiCI95, n: s.n } : null,
        B_positiveInBothHalves: (h1.n ? h1.roiPct > 0 : false) && (h2.n ? h2.roiPct > 0 : false),
        B_value: { H1: h1.n ? { n: h1.n, roiPct: h1.roiPct, ci: h1.roiCI95 } : null, H2: h2.n ? { n: h2.n, roiPct: h2.roiPct, ci: h2.roiCI95 } : null },
        C_modelBeatsMarketBrierOnTraded: traded.n ? traded.brierDiffModelMinusMarket.point < 0 : false,
        C_value: traded.n ? traded.brierDiffModelMinusMarket : null,
        D_beatsEveryNaiveRule: s.n ? s.roiPct > bestNaive : false,
        D_value: { modelRuleRoiPct: s.n ? s.roiPct : null, naive, bestNaiveRoiPct: bestNaive },
      };
    })(),
  };
  report.bar.passed = report.bar.A_pooledCIAboveZero && report.bar.B_positiveInBothHalves
    && report.bar.C_modelBeatsMarketBrierOnTraded && report.bar.D_beatsEveryNaiveRule;

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ report, runs }, null, 1));
  print(report);
}

function fmt(s) {
  if (!s || !s.n) return 'n=0';
  const f = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
  return `n=${String(s.n).padStart(4)} (${s.clusters} starts)  hit ${f(100 * s.hitRate)}% vs ${f(100 * s.breakEvenHit)}% priced  P&L ${s.pnlPerContractCents >= 0 ? '+' : ''}${f(s.pnlPerContractCents, 2)}c/ct  ROI ${s.roiPct >= 0 ? '+' : ''}${f(s.roiPct)}% [${f(s.roiCI95[0])}, ${f(s.roiCI95[1])}]  CLV mid ${f(s.clvMidCents, 2)}c vs paid ${f(s.clvVsPaidCents, 2)}c`;
}

function print(r) {
  console.log(`=== ${r.window.series}  ${r.window.from}..${r.window.to}  (H1 < ${r.window.halfSplit} <= H2) ===`);
  const { skip, settleDisagreesWithBoxScore, marketsPerDate, ...cov } = r.coverage;
  console.log('coverage:', JSON.stringify(cov));
  console.log('unmatched:', JSON.stringify(skip));
  console.log(`settlement vs box score disagreements: ${settleDisagreesWithBoxScore.length}`, settleDisagreesWithBoxScore.slice(0, 5));
  for (const [T, sets] of Object.entries(r.runs)) {
    for (const [name, sp] of Object.entries(sets)) {
      console.log(`\n--- ${T}  ${name} ---`);
      for (const [k, s] of Object.entries(sp)) console.log(`${k.padEnd(40)} ${fmt(s)}`);
    }
  }
  console.log('\n=== forecast skill (all matched, two-sided quote) ===');
  for (const [T, f] of Object.entries(r.forecast)) {
    for (const [k, s] of Object.entries(f)) {
      if (!s.n) { console.log(`${T} ${k}: n=0`); continue; }
      const g = (x) => `brier ${x.brier.toFixed(4)} ll ${x.logLoss.toFixed(4)}`;
      const dd = (x) => `${x.point.toFixed(4)} [${x.ci95[0].toFixed(4)}, ${x.ci95[1].toFixed(4)}]`;
      console.log(`${T} ${k.padEnd(24)} n=${s.n}  model ${g(s.model)} | market ${g(s.market)}  diff ${dd(s.brierDiffModelMinusMarket)}  best weight ${s.brierOptimalModelWeight.w}`);
      console.log(`${''.padEnd(30)} model calib: ${s.modelCalibration.join('  ')}`);
      console.log(`${''.padEnd(30)} market calib: ${s.marketCalibration.join('  ')}`);
    }
  }
  console.log('\n=== replica check (botRuleLocal must equal bot) ===', JSON.stringify(r.replicaCheck));
  console.log('\n=== model side vs price side, same contracts ===', JSON.stringify(r.modelVsPriceSide, null, 1));
  console.log('\n=== POST HOC price-only pattern (not pre-registered) ===');
  for (const [T, s] of Object.entries(r.postHocNaive)) console.log(`${T} ${s.label.padEnd(34)} ${fmt(s)}`);
  console.log('\n=== sample size ===', JSON.stringify(r.sampleSize, null, 1));
  console.log('\n=== PRE-REGISTERED BAR ===', JSON.stringify(r.bar, null, 1));
}

await main();
