// Would trading the GAME model against REAL Kalshi prices have made money?
//
//   node tools/backtest-kalshi-games.mjs --from 2026-07-14 --to 2026-08-09 \
//     --cache C:/Users/qrob1/mlbwork/bt-cache --kcache C:/Users/qrob1/mlbwork/kalshi-cache \
//     [--decision-min 120] [--lineups] [--json out.json]
//
// The same study design as tools/backtest-kalshi.mjs (pitcher props) and
// tools/backtest-kalshi-batters.mjs, applied to the four markets the game model
// prices:
//
//   KXMLBGAME    "TEAM wins"                  -> pHome / pAway
//   KXMLBSPREAD  "TEAM wins by over X.5"      -> spread(+-X.5)
//   KXMLBTOTAL   "Over X.5 runs"              -> total(X.5).over
//   KXMLBRFI     "1st inning: Over 0.5 runs"  -> 1 - nrfi.nrfiProb
//
// KXMLBRFI is NOT in the bot's `GAME_SERIES`, so `planOrders` cannot price it.
// It is carried here as a clearly separated hypothetical, screened with the same
// rules written out by hand.
//
//   1. Model probability comes from the lookahead-free replay in
//      tools/backtest-games.mjs, priced through the bot's own `modelProbability`
//      (bot/plan.mjs) — same ticker parsing, same doubleheader rule, same
//      strike-to-side mapping.
//   2. The decision quote is the Kalshi top of book at a fixed time before the
//      scheduled first pitch in the ticker (default 120 min, secondary 30),
//      read from candlesticks: the LAST candle whose end_period_ts <= the
//      decision time. Never a later candle. Hourly candles from the market's
//      open cover quiet rungs; 1-minute candles cover the last five hours.
//   3. The closing quote is the same read at the scheduled first pitch.
//   4. The bot's decision rule is run exactly: `planOrders` (screenOnly) with a
//      one-level book built from the decision quote — `buildSignal` (blend with
//      MARKET_WEIGHT, fee + minEdge hurdle), the 8-pt game implausibility cap,
//      the 15-90c price bounds, and one rung per game-series ladder.
//   5. Every trade is 1 contract, taker at the ask, fee = the bot's own formula,
//      P&L from Kalshi's `settlement_value_dollars`.
//
// Kalshi PUBLIC endpoints only (no auth, no orders). Everything is cached under
// --kcache; requests are serialised and back off on 429.

import fs from 'node:fs';
import path from 'node:path';
import { buildGames, validate, USE_LINEUPS } from './backtest-games.mjs';
import { planOrders, modelProbability, GAME_SERIES } from '../bot/plan.mjs';
import { normalizeMarket, normalizeOrderbook } from '../src/lib/kalshi.js';
import { buildSignal, blendedProbability } from '../src/trade/signals.js';
import { MARKET_WEIGHT } from '../src/lib/constants.js';
import {
  readJson, settledMarkets as settledMarketsIn, parseEventTicker, startMsOf, fetchCandles,
  quoteAt, summarize as summarizeBoot, scoring, brierDiff as brierDiffBoot, calibrationBins,
  brierOptimalModelWeight, priceBucket,
} from './kalshi-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const FROM = arg('from', '2026-07-14');
const TO = arg('to', '2026-09-16');
const KCACHE = arg('kcache', path.resolve('.kalshi-cache'));
const DECISION_MIN = Number(arg('decision-min', 120));
const JSON_OUT = arg('json', null);
const BOOT = Number(arg('boot', 5000));
const LIMIT_GAMES = Number(arg('limit-games', Infinity)); // debugging only

/** The three series the bot prices, plus the first-inning market it does not. */
const BOT_SERIES = Object.keys(GAME_SERIES); // KXMLBGAME, KXMLBSPREAD, KXMLBTOTAL
const RFI_SERIES = 'KXMLBRFI';
const SERIES = [...BOT_SERIES, RFI_SERIES];
const CANDLE_DIR = path.join(KCACHE, 'candles-game');
fs.mkdirSync(CANDLE_DIR, { recursive: true });

const KEEP = ['ticker', 'event_ticker', 'series_ticker', 'status', 'title', 'yes_sub_title',
  'floor_strike', 'cap_strike', 'strike_type', 'result', 'settlement_value_dollars',
  'open_time', 'close_time', 'volume', 'open_interest'];

const summarize = (trades) => summarizeBoot(trades, { boot: BOOT });
const brierDiff = (rows, a, b) => brierDiffBoot(rows, a, b, { boot: BOOT });

/**
 * Hourly candles from the market's open plus 1-minute candles over the last five
 * hours, merged per ticker and sorted. The hourly pass keeps quiet rungs (a deep
 * spread that has not traded all day still has a resting book); the 1-minute pass
 * gives the decision and closing quotes their real resolution.
 */
async function gameCandles(seg, markets, endMs) {
  const file = path.join(CANDLE_DIR, `${seg}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const endTs = Math.floor(endMs / 1000);
  const openTs = Math.floor(Math.min(...markets.map((m) => Date.parse(m.open_time))) / 1000);
  const tickers = markets.map((m) => m.ticker);
  const coarse = await fetchCandles(tickers, Math.min(openTs, endTs - 3600), endTs, 60);
  const fine = await fetchCandles(tickers, Math.max(openTs, endTs - 300 * 60), endTs, 1);
  const out = {};
  for (const t of tickers) {
    out[t] = [...(coarse[t] || []), ...(fine[t] || [])].sort((a, b) => a[0] - b[0]);
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const config = readJson(new URL('../bot/config.example.json', import.meta.url));
  // KXMLBGAME/SPREAD/TOTAL/RFI all report fee_multiplier 0.5 (GET /series/<t>),
  // which would halve the bot's hard-coded 0.07. Reported as a sensitivity.
  const FEE_RATE_SENS = 0.035;

  // ── the replay ────────────────────────────────────────────────────────────
  const { games: replayed, skip: replaySkip } = buildGames();
  const inWindowGames = replayed.filter((g) => g.date >= FROM && g.date <= TO);
  const validation = validate(inWindowGames);

  // Slate per ET date, shaped like `loadSlate`'s output for `modelProbability`.
  const slates = new Map();
  const byPk = new Map();
  for (const g of replayed) {
    const etDate = new Date(g.gameDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (!slates.has(etDate)) slates.set(etDate, { games: [] });
    const row = {
      gamePk: g.gamePk,
      gameNumber: g.gameNumber,
      gameDate: g.gameDate,
      away: { abbr: g.awayAbbr },
      home: { abbr: g.homeAbbr },
      game: g.model,
      nrfi: g.bothStarters ? g.model.nrfi : null,
      pitchers: [],
      batters: [],
      replay: g,
    };
    slates.get(etDate).games.push(row);
    byPk.set(g.gamePk, row);
  }

  // ── markets ───────────────────────────────────────────────────────────────
  const all = [];
  for (const s of SERIES) all.push(...(await settledMarketsIn(KCACHE, s, { keep: KEEP })));
  const seriesSpan = {};
  for (const m of all) {
    const p = parseEventTicker(m.event_ticker);
    if (!p) continue;
    const s = (seriesSpan[m.series_ticker || m.ticker.split('-')[0]] ||= { first: p.date, last: p.date, n: 0 });
    if (p.date < s.first) s.first = p.date;
    if (p.date > s.last) s.last = p.date;
    s.n++;
  }
  const inWindow = all.filter((m) => {
    const p = parseEventTicker(m.event_ticker);
    return p && p.date >= FROM && p.date <= TO;
  });

  const byGame = new Map();
  for (const m of inWindow) {
    const seg = m.ticker.split('-')[1];
    if (!byGame.has(seg)) byGame.set(seg, []);
    byGame.get(seg).push(m);
  }

  const coverage = {
    replayedGamesInWindow: inWindowGames.length,
    replaySkip,
    marketsInWindow: inWindow.length,
    kalshiGames: byGame.size,
    skip: {},
  };
  const bump = (r) => (coverage.skip[r] = (coverage.skip[r] || 0) + 1);

  const rows = [];
  let fetched = 0;
  for (const [seg, markets] of [...byGame].sort().slice(0, LIMIT_GAMES)) {
    const p = parseEventTicker(markets[0].event_ticker);
    const startMs = startMsOf(p);
    const slate = slates.get(p.date) || { games: [] };
    const priced = markets.map((m) => {
      const market = normalizeMarket(m);
      if (market.series === RFI_SERIES) return { m, market, info: rfiProbability(market, slate) };
      return { m, market, info: modelProbability(market, slate, config) };
    });
    const usable = priced.filter((x) => x.info.prob != null);
    for (const x of priced) if (x.info.prob == null) bump(`model: ${x.info.reason}`);
    if (!usable.length) continue;
    const candles = await gameCandles(seg, usable.map((x) => x.m), startMs);
    if (++fetched % 25 === 0) process.stderr.write(`  candles for ${fetched} games\r`);
    for (const { m, market, info } of usable) {
      const decisionMs = startMs - DECISION_MIN * 60e3;
      const sv = Number(m.settlement_value_dollars);
      rows.push({
        ticker: m.ticker,
        series: market.series,
        marketKey: info.marketKey,
        date: p.date,
        startMs,
        schedStartMs: Date.parse(info.game.gameDate),
        cluster: `${p.date}:${info.game.gamePk}`,
        gamePk: info.game.gamePk,
        strike: Number(m.floor_strike),
        model: info.prob,
        dq: quoteAt(candles[m.ticker], decisionMs),
        cq: quoteAt(candles[m.ticker], startMs),
        decisionMs,
        result: m.result,
        settle: Number.isFinite(sv) ? sv : m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null,
        raw: m,
        game: info.game,
        replay: info.game.replay,
      });
    }
  }
  process.stderr.write('\n');

  coverage.matchedMarkets = rows.length;
  coverage.matchedGames = new Set(rows.map((r) => r.cluster)).size;
  coverage.withDecisionTwoSided = rows.filter((r) => r.dq?.bid != null && r.dq?.ask != null).length;
  coverage.noCandleAtDecision = rows.filter((r) => !r.dq).length;
  coverage.nonBinarySettlement = rows.filter((r) => r.settle != null && r.settle !== 0 && r.settle !== 1).length;
  coverage.bySeries = {};
  for (const r of rows) {
    const s = (coverage.bySeries[r.series] ||= { matched: 0, twoSided: 0 });
    s.matched++;
    if (r.dq?.bid != null && r.dq?.ask != null) s.twoSided++;
  }
  // Sanity: does Kalshi's settlement agree with the box score we replayed against?
  coverage.settleDisagreesWithBoxScore = rows
    .filter((r) => (r.settle === 0 || r.settle === 1) && boxScoreOutcome(r) != null && boxScoreOutcome(r) !== r.settle)
    .map((r) => `${r.ticker} settle=${r.settle} box=${boxScoreOutcome(r)}`);
  // How stale the decision quote is: a deep ladder rung can go hours without a
  // candle, and then the "market price" is an old book, not a live one.
  coverage.decisionQuoteAgeMinutes = (() => {
    const out = {};
    for (const s of SERIES) {
      const a = rows.filter((r) => r.series === s && r.dq).map((r) => (r.decisionMs - r.dq.ts * 1000) / 60e3).sort((x, y) => x - y);
      if (a.length) out[s] = { median: +a[Math.floor(a.length / 2)].toFixed(1), p90: +a[Math.floor(a.length * 0.9)].toFixed(1), pctUnder60min: +(100 * a.filter((x) => x <= 60).length / a.length).toFixed(1) };
    }
    return out;
  })();
  coverage.tickerVsScheduleStartMinutes = (() => {
    const d = rows.map((r) => Math.round((r.schedStartMs - r.startMs) / 60e3)).sort((a, b) => a - b);
    return d.length ? { min: d[0], median: d[Math.floor(d.length / 2)], max: d[d.length - 1] } : null;
  })();

  // ── the bot's decisions ───────────────────────────────────────────────────
  const book = (q) => ({ orderbook: { yes: [[q.bid, 1e6]], no: [[100 - q.ask, 1e6]] } });
  // At MARKET_WEIGHT 0.3 with the 8-pt cap the bot can never clear its own
  // hurdle on a game line (see the doc), so the same screen is also run at
  // higher model weights and with the cap released. These are counterfactuals,
  // not the bot: they are the only way to measure whether the model's
  // disagreements are worth money at all.
  const WEIGHTS = [0.3, 0.45, 0.6, 0.8, 1.0];
  const CAPS = [0.08, 1];
  const trades = { every: [], bot: [], botOnePerGame: [], rfi: [] };
  for (const w of WEIGHTS) for (const cap of CAPS) trades[`w${w}cap${cap}`] = [];
  const rowsByGame = new Map();
  for (const r of rows) {
    if (!rowsByGame.has(r.cluster)) rowsByGame.set(r.cluster, []);
    rowsByGame.get(r.cluster).push(r);
  }
  const account = { balanceDollars: 1e6, valueDollars: 1e6, dayStartValueDollars: 1e6, positions: [], restingTickers: [] };
  const botConfig = { ...config, screenOnly: true, limits: { ...config.limits, bankrollDollars: 1e6 } };
  const screenAgree = { ok: 0, differ: [] };

  const makeTrade = (r, signal, feeRate = 0.07) => {
    const yes = signal.side === 'yes';
    const price = signal.priceCents;
    const fee = (100 * feeRate * price * (100 - price)) / 10000; // cents/contract, unrounded
    const payout = 100 * (yes ? r.settle : 1 - r.settle);
    const midSide = (q) => (q?.mid == null ? null : yes ? q.mid : 100 - q.mid);
    return {
      ticker: r.ticker, series: r.series, date: r.date, cluster: r.cluster, gamePk: r.gamePk,
      strike: r.strike, side: signal.side, priceCents: price, feeCents: fee,
      pnlCents: payout - price - fee, edge: signal.edge,
      model: yes ? r.model : 1 - r.model, blended: signal.blendedProb,
      decisionMidSide: midSide(r.dq), closeMidSide: midSide(r.cq), expectedWinSide: price / 100,
      quoteAgeMin: (r.decisionMs - r.dq.ts * 1000) / 60e3,
      evPerDollar: signal.evPerDollar, won: payout === 100,
    };
  };

  for (const [, gameRows] of rowsByGame) {
    const tradable = gameRows.filter((r) => r.dq?.bid != null && r.dq?.ask != null && r.settle != null);
    if (!tradable.length) continue;
    const decisionMs = gameRows[0].startMs - DECISION_MIN * 60e3;
    for (const r of tradable) {
      const b = normalizeOrderbook(r.ticker, book(r.dq));
      const sig = buildSignal({
        modelProb: r.model, book: b, ticker: r.ticker,
        weight: MARKET_WEIGHT[r.marketKey] ?? 0.3, minEdge: config.minEdgeAfterFees,
      });
      r.signal = sig;
      if (!sig?.tradeable) continue;
      if (r.series === RFI_SERIES) continue; // reported separately
      trades.every.push(makeTrade(r, sig));
    }
    // The bot proper: planOrders on the three series it knows.
    const botRows = tradable.filter((r) => BOT_SERIES.includes(r.series));
    if (botRows.length) {
      const slate = { games: [gameRows[0].game] };
      const books = new Map(botRows.map((r) => [r.ticker, book(r.dq)]));
      const plan = planOrders({
        slate, markets: botRows.map((r) => r.raw), books, account, state: {},
        config: botConfig, now: new Date(decisionMs),
      });
      const byTicker = new Map(botRows.map((r) => [r.ticker, r]));
      const picked = (plan.screened || []).map((t) => byTicker.get(t)).filter(Boolean);
      for (const r of picked) trades.bot.push(makeTrade(r, r.signal));
      // The hand-written screen must reproduce planOrders at the bot's own settings.
      const mine = screen(botRows, MARKET_WEIGHT.game_ml, 0.08, config).map((x) => x.row.ticker).sort().join(',');
      if (mine === picked.map((r) => r.ticker).sort().join(',')) screenAgree.ok++;
      else screenAgree.differ.push({ planOrders: picked.map((r) => r.ticker), screen: mine });
      // One bet per GAME: planOrders' ladder rule is per series, so all three
      // markets on one game can be traded together. This keeps only the best.
      const bestOne = picked.reduce(
        (best, r) => (!best || r.signal.evPerDollar > best.signal.evPerDollar ? r : best),
        null,
      );
      if (bestOne) trades.botOnePerGame.push(makeTrade(bestOne, bestOne.signal));
    }
    // KXMLBRFI, screened by hand with the same rules the bot applies to game
    // lines (MARKET_WEIGHT.nrfi = 0.5, the 8-pt cap, the price bounds).
    for (const r of tradable) {
      if (r.series !== RFI_SERIES || !r.signal?.tradeable) continue;
      if (Math.abs(r.model - r.dq.mid / 100) > 0.08) continue;
      if (r.signal.priceCents < config.limits.minPriceCents || r.signal.priceCents > config.limits.maxPriceCents) continue;
      trades.rfi.push(makeTrade(r, r.signal));
    }
    // Counterfactual weights / caps, on the three bot series only.
    for (const w of WEIGHTS) {
      for (const cap of CAPS) {
        const picked = screen(botRows, w, cap, config);
        for (const { row, signal } of picked) trades[`w${w}cap${cap}`].push(makeTrade(row, signal));
      }
    }
  }

  coverage.screenMatchesPlanOrders = { games: screenAgree.ok, disagreements: screenAgree.differ.length, examples: screenAgree.differ.slice(0, 5) };

  // ── report ────────────────────────────────────────────────────────────────
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
    by('quoteAge', (t) => (t.quoteAgeMin <= 60 ? 'fresh<=60min' : 'stale>60min'));
    return out;
  };
  const feeSens = (list) => summarize(list.map((t) => {
    const fee = (100 * FEE_RATE_SENS * t.priceCents * (100 - t.priceCents)) / 10000;
    return { ...t, feeCents: fee, pnlCents: t.pnlCents + t.feeCents - fee };
  }));

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
    brierOptimalModelWeight: brierOptimalModelWeight(list),
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
  const forecast = { all: skill(scored) };
  for (const s of SERIES) {
    const list = scored.filter((x) => x.series === s);
    if (list.length) forecast[s] = skill(list);
  }
  forecast.marketBetween10and90 = skill(scored.filter((x) => x.market >= 0.1 && x.market <= 0.9));
  const gap = scored.map((x) => Math.abs(x.model - x.market)).sort((a, b) => a - b);
  forecast.absModelMinusMarketPts = gap.length
    ? { median: 100 * gap[Math.floor(gap.length / 2)], p90: 100 * gap[Math.floor(gap.length * 0.9)] }
    : null;

  const report = {
    window: { from: FROM, to: TO, decisionMinutesBeforeFirstPitch: DECISION_MIN, lineups: USE_LINEUPS },
    seriesSpanLiveTier: seriesSpan,
    replayValidation: validation,
    coverage,
    trades: {
      every: splits(trades.every),
      bot: splits(trades.bot),
      botOnePerGame: splits(trades.botOnePerGame),
      rfiNotTradeableByBot: splits(trades.rfi),
      ...Object.fromEntries(Object.entries(trades)
        .filter(([k]) => k.startsWith('w'))
        .map(([k, v]) => [k, splits(v)])),
    },
    feeSensitivity035: {
      every: feeSens(trades.every), bot: feeSens(trades.bot),
      botOnePerGame: feeSens(trades.botOnePerGame), rfiNotTradeableByBot: feeSens(trades.rfi),
      ...Object.fromEntries(Object.entries(trades)
        .filter(([k]) => k.startsWith('w'))
        .map(([k, v]) => [k, feeSens(v)])),
    },
    forecast,
  };
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ report, trades }, null, 1));
  print(report);
}

/**
 * `planOrders`' game-line screen, written out so the model weight and the
 * implausibility cap can be varied: the cap on |model - mid|, `buildSignal`,
 * the price bounds, then one rung per series ladder ranked by EV per dollar.
 * Checked against `planOrders` itself at the bot's own settings (see
 * `coverage.screenMatchesPlanOrders`).
 */
function screen(rows, weight, cap, config) {
  const best = new Map();
  for (const r of rows) {
    const mid = r.dq.mid / 100;
    if (mid == null || Math.abs(r.model - mid) > cap) continue;
    const b = normalizeOrderbook(r.ticker, { orderbook: { yes: [[r.dq.bid, 1e6]], no: [[100 - r.dq.ask, 1e6]] } });
    const signal = buildSignal({ modelProb: r.model, book: b, ticker: r.ticker, weight, minEdge: config.minEdgeAfterFees });
    if (!signal?.tradeable) continue;
    if (signal.priceCents < config.limits.minPriceCents || signal.priceCents > config.limits.maxPriceCents) continue;
    const key = r.series;
    const prev = best.get(key);
    if (!prev || signal.evPerDollar > prev.signal.evPerDollar) best.set(key, { row: r, signal });
  }
  return [...best.values()];
}

/**
 * KXMLBRFI: one market per game, YES = "over 0.5 runs in the 1st inning", which
 * is the model's YRFI. Mirrors `modelProbability`'s matching, including the
 * doubleheader rule, but the bot itself has no mapping for this series.
 */
function rfiProbability(market, slate) {
  const parsed = parseEventTicker(market.eventTicker);
  if (!parsed) return { prob: null, reason: 'unparseable ticker' };
  let games = slate.games.filter((g) => `${g.away.abbr}${g.home.abbr}` === parsed.teams);
  if (games.length > 1 && parsed.gameNumber) games = games.filter((g) => (g.gameNumber ?? 1) === parsed.gameNumber);
  if (!games.length) return { prob: null, reason: 'game not on slate' };
  if (games.length > 1) return { prob: null, reason: 'doubleheader: cannot tell which game' };
  const game = games[0];
  if (!game.nrfi) return { prob: null, reason: 'no nrfi (both starters required)' };
  return { prob: game.nrfi.yrfiProb, kind: 'game', marketKey: 'nrfi', game };
}

/** What the replayed box score says the contract should have settled at. */
function boxScoreOutcome(r) {
  const a = r.replay?.actual;
  if (!a) return null;
  if (r.series === 'KXMLBGAME') {
    const suffix = String(r.ticker).split('-').pop();
    if (suffix === r.game.home.abbr) return a.homeWin;
    if (suffix === r.game.away.abbr) return 1 - a.homeWin;
    return null;
  }
  if (r.series === 'KXMLBTOTAL') return a.total > r.strike ? 1 : 0;
  if (r.series === 'KXMLBSPREAD') {
    const team = String(r.ticker).split('-').pop().replace(/\d+$/, '');
    if (team === r.game.home.abbr) return a.margin > r.strike ? 1 : 0;
    if (team === r.game.away.abbr) return -a.margin > r.strike ? 1 : 0;
    return null;
  }
  if (r.series === RFI_SERIES) return a.firstInningRuns == null ? null : a.firstInningRuns > 0 ? 1 : 0;
  return null;
}

function fmt(s) {
  if (!s || !s.n) return 'n=0';
  const f = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
  return `n=${String(s.n).padStart(4)} (${s.clusters} games)  hit ${f(100 * s.hitRate)}% vs ${f(100 * s.breakEvenHit)}% priced  P&L ${s.pnlPerContractCents >= 0 ? '+' : ''}${f(s.pnlPerContractCents, 2)}c/ct  ROI ${s.roiPct >= 0 ? '+' : ''}${f(s.roiPct)}% [${f(s.roiCI95[0])}, ${f(s.roiCI95[1])}]  CLV mid ${f(s.clvMidCents, 2)}c, vs paid ${f(s.clvVsPaidCents, 2)}c, close moved for/against ${f(100 * s.pctBeatCloseMid, 0)}/${f(100 * s.pctWorseThanCloseMid, 0)}%`;
}

function print(r) {
  console.log(`window ${r.window.from}..${r.window.to}, decision = first pitch - ${r.window.decisionMinutesBeforeFirstPitch} min, lineups=${r.window.lineups}`);
  console.log('live-tier settled markets by series:', JSON.stringify(r.seriesSpanLiveTier));
  const v = r.replayValidation;
  console.log('\n=== replay validation (model vs what happened, same games) ===');
  const vrow = (label, o) => o && console.log(`${label.padEnd(16)} model ${(100 * o.pred).toFixed(2)}%  actual ${(100 * o.actual).toFixed(2)}%  (n=${o.n})`);
  vrow('home win', v.homeWin);
  vrow('NRFI', v.nrfi);
  for (const [k, o] of Object.entries(v.totals)) vrow(k, o);
  for (const [k, o] of Object.entries(v.spreads)) vrow(k, o);
  console.log(`games ${v.n}, both starters ${v.bothStarters}, with posted lineups ${v.withLineups}`);
  const { skip, settleDisagreesWithBoxScore, replaySkip, ...cov } = r.coverage;
  console.log('\ncoverage:', JSON.stringify(cov));
  console.log('replay skips:', JSON.stringify(replaySkip));
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
