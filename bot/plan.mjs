// Turn a projected slate + live Kalshi books + account state into orders.
//
// Pure: no network, no clock except `now` passed in, no filesystem. Everything
// that decides whether money moves lives here, so all of it is testable.

import { PITCHER_MARKETS, BATTER_MARKETS } from '../src/lib/markets.js';
import { MARKET_WEIGHT } from '../src/lib/constants.js';
import { KNOWN_SERIES, normalizeMarket, normalizeOrderbook, playerNameOf } from '../src/lib/kalshi.js';
import { matchName, normalizeName } from '../src/lib/names.js';
import { parseKalshiGameTicker } from '../src/data/teamMarkets.js';
import { calibrate } from '../src/trade/calibration.js';
import { buildSignal } from '../src/trade/signals.js';
import { sizeOrder } from '../src/trade/risk.js';

/** Kalshi series -> our market key, for every player-prop series we can price. */
export const PROP_SERIES = Object.fromEntries(
  Object.entries(KNOWN_SERIES).filter(([, market]) => market && (PITCHER_MARKETS[market] || BATTER_MARKETS[market])),
);
export const GAME_SERIES = { KXMLBGAME: 'game_ml', KXMLBSPREAD: 'game_spread', KXMLBTOTAL: 'game_total' };
export const ALL_SERIES = [...Object.keys(PROP_SERIES), ...Object.keys(GAME_SERIES)];

/**
 * Model and exchange this far apart means the model is missing something (a
 * scratch, an opener, a lineup change) — the same rule the board applies.
 */
const IMPLAUSIBLE = { prop: 0.12, game: 0.08 };

const eventTeams = (eventTicker) => parseKalshiGameTicker(eventTicker)?.teams || null;

/** Model probability that a Kalshi YES settles, for one market. */
export function modelProbability(market, slate, { requireConfirmedLineup = true } = {}) {
  const series = market.series;
  const parsed = parseKalshiGameTicker(market.eventTicker);
  if (!parsed) return { prob: null, reason: 'unparseable ticker' };
  let games = slate.games.filter(
    (g) => `${g.away.abbr}${g.home.abbr}` === parsed.teams && g.gameDate && sameDay(g, parsed.date),
  );
  if (games.length > 1 && parsed.gameNumber) games = games.filter((g) => (g.gameNumber ?? 1) === parsed.gameNumber);
  if (!games.length) return { prob: null, reason: 'game not on slate' };
  if (games.length > 1) return { prob: null, reason: 'doubleheader: cannot tell which game' };
  const game = games[0];

  if (GAME_SERIES[series]) {
    const m = game.game;
    if (!m?.total || !m?.spread) return { prob: null, reason: 'no game model' };
    const suffix = String(market.ticker).split('-').pop();
    const strike = Number(market.raw?.floor_strike);
    const home = game.home.abbr;
    let prob;
    if (series === 'KXMLBGAME') {
      if (suffix !== home && suffix !== game.away.abbr) return { prob: null, reason: 'unknown team' };
      prob = suffix === home ? m.pHome : m.pAway;
    } else if (series === 'KXMLBSPREAD') {
      const team = suffix.replace(/\d+$/, '');
      if (!Number.isFinite(strike) || strike % 1 === 0) return { prob: null, reason: 'unsupported strike' };
      prob = team === home ? m.spread(-strike).home : m.spread(strike).away;
    } else {
      if (!Number.isFinite(strike) || strike % 1 === 0) return { prob: null, reason: 'unsupported strike' };
      prob = m.total(strike).over;
    }
    return { prob, kind: 'game', marketKey: GAME_SERIES[series], game };
  }

  const marketKey = PROP_SERIES[series];
  if (!marketKey) return { prob: null, reason: 'series not priced' };
  if (market.threshold == null) return { prob: null, reason: 'no threshold' };
  const isPitcher = Boolean(PITCHER_MARKETS[marketKey]);
  // FIX(v36): Kalshi disambiguates same-named players with a team tag —
  // "Max Muncy (LAD): 2+" / "Max Muncy (ATH): 2+". Normalising that produced
  // "max muncy lad", which matched nobody, so 1,180 markets in the batter
  // backtest were never priced. The tag is removed from the name and used to
  // narrow the candidates to that team instead.
  const rawName = String(playerNameOf(market.raw || market) || market.player || '');
  const teamTag = /\(([A-Z]{2,3})\)/.exec(rawName)?.[1] || null;
  const cleanName = rawName.replace(/\([A-Z]{2,3}\)/, '').replace(/:.*$/, '').trim();
  let people = isPitcher ? game.pitchers : game.batters;
  if (teamTag) people = people.filter((p) => p.teamAbbr === teamTag);
  const byKey = new Map(people.map((p) => [normalizeName(p.name), p]));
  const match = matchName(normalizeName(cleanName) || market.playerKey, [...byKey.keys()]);
  if (match.status !== 'matched') return { prob: null, reason: `player ${match.status}` };
  const person = byKey.get(match.key);
  if (!isPitcher && requireConfirmedLineup && person.lineupSource !== 'confirmed') {
    return { prob: null, reason: 'lineup not confirmed' };
  }
  const spec = (isPitcher ? PITCHER_MARKETS : BATTER_MARKETS)[marketKey];
  const dist = person.proj?.dist?.[spec.distKey];
  if (typeof dist !== 'function') return { prob: null, reason: 'no distribution' };
  // Kalshi props are "N or more"; the model's P(X > N - 0.5) is the same event.
  const line = market.threshold - 0.5;
  const raw = dist(line);
  const cal = isPitcher ? { prob: raw } : calibrate(raw, marketKey, line);
  return { prob: cal.prob, kind: 'prop', marketKey, game, person, line };
}

function sameDay(game, date) {
  // Kalshi dates are US Eastern; the schedule's gameDate is UTC.
  const et = new Date(game.gameDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return et === date;
}

/**
 * The player a prop ticker settles on, as "<game>:<player>", or null for game
 * lines. Kalshi uses the same player segment in every series —
 * KXMLBHIT-26SEP161310CWSCLE-CWSRGRICHUK34-2 and
 * KXMLBTB-26SEP161310CWSCLE-CWSRGRICHUK34-2 are the same hitter — so this is
 * what ties a hits contract and a total-bases contract to one person.
 */
export function playerKeyOf(ticker) {
  const parts = String(ticker).split('-');
  return parts.length >= 4 ? `${parts[1]}:${parts[2]}` : null;
}

/**
 * What bot/report.mjs needs to grade a decision as a paper trade without
 * re-deriving it: the scheduled first pitch (the closing-price cutoff), the
 * series (the candlestick path), and the book the price was taken from.
 * Additive only: every existing journal field keeps its meaning. Note that
 * `model` is the YES probability while `blended` and `market` are on the
 * chosen side, so `modelSide` states the model on the chosen side explicitly.
 */
export function paperFields(market, info, signal, book) {
  return {
    series: market.series,
    eventTicker: market.eventTicker,
    gamePk: info.game?.gamePk ?? null,
    firstPitch: info.game?.gameDate ?? null,
    playerKey: playerKeyOf(market.ticker),
    player: info.person?.name ?? null,
    line: info.line ?? (Number.isFinite(Number(market.raw?.floor_strike)) ? Number(market.raw.floor_strike) : null),
    modelSide: signal.modelProb == null ? null : +signal.modelProb.toFixed(3),
    yesBid: book?.bestYesBid ?? null,
    yesAsk: book?.bestYesAsk ?? null,
  };
}

/** Correlated rungs (one player's ladder, one game's ladder) collapse to one bet. */
function groupKey(market, info) {
  if (info.kind === 'prop') return `${market.series}:${info.game.gamePk}:${info.person.id}`;
  return `${market.series}:${info.game.gamePk}`;
}

/**
 * @param {object} args
 * @param {object} args.slate         loadSlate result (with live `dist` / game model functions)
 * @param {object[]} args.markets     raw Kalshi markets for ALL_SERIES
 * @param {Map<string,object>} args.books  ticker -> raw orderbook payload
 * @param {object} args.account       { balanceDollars, positions:[{ticker, position, exposureDollars}], restingTickers:[], dayStartValueDollars, valueDollars }
 * @param {object} args.state         { ordersToday, spentTodayDollars, sentClientIds:[] }
 * @param {object} args.config        see bot/config.example.json
 * @param {Date}   args.now
 */
/**
 * A book built from a market listing's top of book, for pre-screening only.
 * Depth is unknown, so it is set large and must never size a real order —
 * run.mjs fetches the real book for anything that survives the screen.
 */
export function topOfBook(raw) {
  const m = normalizeMarket(raw);
  if (!m || m.yesBid == null || m.yesAsk == null || m.yesBid <= 0 || m.yesAsk >= 100) return null;
  return { orderbook: { yes: [[m.yesBid, 1e6]], no: [[100 - m.yesAsk, 1e6]] } };
}

export function planOrders({ slate, markets, books, account, state, config, now = new Date() }) {
  const considered = [];
  const note = (entry) => (considered.push(entry), entry);
  const L = config.limits;

  // ── account-level halts ──────────────────────────────────────────────────
  const halts = [];
  const lossToday = (account.dayStartValueDollars ?? account.valueDollars ?? 0) - (account.valueDollars ?? 0);
  if (lossToday >= L.maxDailyLossDollars) halts.push(`daily loss $${lossToday.toFixed(2)} >= $${L.maxDailyLossDollars}`);
  if ((state.ordersToday || 0) >= L.maxOrdersPerDay) halts.push(`orders today ${state.ordersToday} >= ${L.maxOrdersPerDay}`);
  const bankroll = Math.min(account.balanceDollars ?? 0, L.bankrollDollars);
  if (!(bankroll > 0)) halts.push('no bankroll available');
  if (halts.length) return { orders: [], considered, halts, bankroll };

  const held = new Set([
    ...(account.positions || []).filter((p) => Number(p.position) !== 0).map((p) => p.ticker),
    ...(account.restingTickers || []),
  ]);

  // ── price every market ───────────────────────────────────────────────────
  const best = new Map(); // groupKey -> candidate
  for (const raw of markets) {
    const market = normalizeMarket(raw);
    if (!market) continue;
    const kindAllowed = GAME_SERIES[market.series] ? config.markets.gameLines : config.markets.playerProps;
    if (!kindAllowed) continue;
    const info = modelProbability(market, slate, config);
    if (info.prob == null) {
      note({ ticker: market.ticker, skip: info.reason });
      continue;
    }
    const start = new Date(info.game.gameDate).getTime();
    if (start - now.getTime() < (config.minMinutesBeforeStart ?? 10) * 60e3) {
      note({ ticker: market.ticker, skip: 'too close to first pitch' });
      continue;
    }
    if (held.has(market.ticker)) {
      note({ ticker: market.ticker, skip: 'already holding or resting' });
      continue;
    }
    const rawBook = books.get(market.ticker);
    if (!rawBook) {
      note({ ticker: market.ticker, skip: 'no order book fetched' });
      continue;
    }
    const book = normalizeOrderbook(market.ticker, rawBook);
    if (book.bestYesBid == null || book.bestYesAsk == null) {
      note({ ticker: market.ticker, skip: 'one-sided book' });
      continue;
    }
    const mid = (book.bestYesBid + book.bestYesAsk) / 200;
    if (Math.abs(info.prob - mid) > IMPLAUSIBLE[info.kind]) {
      note({ ticker: market.ticker, skip: `model ${(100 * info.prob).toFixed(0)}% vs market ${(100 * mid).toFixed(0)}%: treated as model error` });
      continue;
    }
    const signal = buildSignal({
      modelProb: info.prob,
      book,
      ticker: market.ticker,
      weight: MARKET_WEIGHT[info.marketKey] ?? 0.3,
      minEdge: config.minEdgeAfterFees,
    });
    if (!signal?.tradeable) {
      note({ ticker: market.ticker, skip: signal?.reason || 'no signal' });
      continue;
    }
    if (signal.priceCents < L.minPriceCents || signal.priceCents > L.maxPriceCents) {
      note({ ticker: market.ticker, skip: `price ${signal.priceCents}c outside ${L.minPriceCents}-${L.maxPriceCents}c` });
      continue;
    }
    const key = groupKey(market, info);
    const candidate = { market, info, signal, book };
    const prev = best.get(key);
    if (!prev || signal.evPerDollar > prev.signal.evPerDollar) {
      if (prev) note({ ticker: prev.market.ticker, skip: 'a better rung of the same ladder was chosen' });
      best.set(key, candidate);
    } else {
      note({ ticker: market.ticker, skip: 'a better rung of the same ladder was chosen' });
    }
  }

  // ── size, best first, within every limit ────────────────────────────────
  const gameOf = (ticker) => String(ticker).split('-')[1] || ticker;
  const exposure = { total: 0, byGame: {}, byPlayer: {}, realisedToday: -Math.max(0, lossToday) };
  // FIX: player exposure. Hits, total bases, H+R+RBI and home runs on the same
  // hitter are close to one bet — a two-hit night wins all of them and an 0-for-4
  // loses all of them — but they are different series, so the one-rung-per-
  // ladder rule never saw them together. An earlier version also passed the
  // contract ticker as the "player", so the per-player cap never bound either.
  // Now every prop is keyed to its player, held positions and resting orders
  // count, and both a dollar cap and a bet count apply per player.
  const betsByPlayer = {};
  for (const p of account.positions || []) {
    const cost = Math.abs(Number(p.exposureDollars) || 0);
    exposure.total += cost;
    exposure.byGame[gameOf(p.ticker)] = (exposure.byGame[gameOf(p.ticker)] || 0) + cost;
    const pk = playerKeyOf(p.ticker);
    if (pk && Number(p.position) !== 0) {
      exposure.byPlayer[pk] = (exposure.byPlayer[pk] || 0) + cost;
      betsByPlayer[pk] = (betsByPlayer[pk] || 0) + 1;
    }
  }
  for (const ticker of account.restingTickers || []) {
    const pk = playerKeyOf(ticker);
    if (pk) betsByPlayer[pk] = (betsByPlayer[pk] || 0) + 1;
  }
  const maxBetsPerPlayer = L.maxBetsPerPlayer ?? 1;

  const riskLimits = {
    kellyFraction: L.kellyFraction,
    maxPositionFraction: L.maxOrderDollars / bankroll,
    maxTotalExposureFraction: L.maxOpenExposureDollars / bankroll,
    maxGameExposureFraction: L.maxGameExposureDollars / bankroll,
    maxPlayerExposureFraction: (L.maxPlayerExposureDollars ?? L.maxOrderDollars) / bankroll,
    dailyLossLimitFraction: L.maxDailyLossDollars / bankroll,
    maxDepthShare: 0.5,
    maxContractsPerOrder: L.maxContractsPerOrder,
    minContracts: 1,
    maxPriceCents: L.maxPriceCents,
  };

  const orders = [];
  let ordersLeft = Math.min(L.maxOrdersPerRun, L.maxOrdersPerDay - (state.ordersToday || 0));
  let spendLeft = L.maxDailySpendDollars - (state.spentTodayDollars || 0);
  const ranked = [...best.values()].sort((a, b) => b.signal.evPerDollar - a.signal.evPerDollar);
  if (config.screenOnly) {
    return { orders: [], considered, halts, bankroll, screened: ranked.map((c) => c.market.ticker) };
  }
  for (const { market, info, signal, book } of ranked) {
    const entry = { ticker: market.ticker, side: signal.side, priceCents: signal.priceCents, edgePts: +(100 * signal.edge).toFixed(1), evCents: +signal.evCents.toFixed(2), model: +info.prob.toFixed(3), blended: +signal.blendedProb.toFixed(3), market: +signal.marketProb.toFixed(3) };
    if (ordersLeft <= 0) {
      note({ ...entry, skip: 'order count limit reached' });
      continue;
    }
    const gameId = gameOf(market.ticker);
    const playerId = playerKeyOf(market.ticker);
    if (playerId && (betsByPlayer[playerId] || 0) >= maxBetsPerPlayer) {
      note({ ...entry, skip: `already ${betsByPlayer[playerId]} bet(s) on this player (limit ${maxBetsPerPlayer})` });
      continue;
    }
    const sizing = sizeOrder({ signal, bankroll, exposure, gameId, playerId, limits: riskLimits });
    const price = signal.priceCents / 100;
    const count = Math.floor(Math.min(sizing.costDollars, spendLeft) / price);
    if (count < 1) {
      note({ ...entry, skip: `sized to zero (${spendLeft <= 0 ? 'daily spend limit' : sizing.binding})` });
      continue;
    }
    const cost = count * price;
    orders.push({ ...entry, count, costDollars: +cost.toFixed(2), binding: sizing.binding, kind: info.kind, marketKey: info.marketKey, ...paperFields(market, info, signal, book) });
    exposure.total += cost;
    exposure.byGame[gameId] = (exposure.byGame[gameId] || 0) + cost;
    if (playerId) {
      exposure.byPlayer[playerId] = (exposure.byPlayer[playerId] || 0) + cost;
      betsByPlayer[playerId] = (betsByPlayer[playerId] || 0) + 1;
    }
    spendLeft -= cost;
    ordersLeft -= 1;
  }

  return { orders, considered, halts, bankroll };
}
