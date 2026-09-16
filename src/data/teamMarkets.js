/**
 * Team markets: moneyline, run line, total.
 *
 * Two price sources, normalised into the same quote shape the prop board uses
 * (`{book, point, over, under, w}`), so the SAME consensus and edge engine
 * prices both:
 *
 *   Sportsbooks  The Odds API `/odds` endpoint, one request for the whole slate
 *                (h2h + spreads + totals = 3 credits, against roughly 20 per
 *                game for the prop feed).
 *   Kalshi       Public exchange markets — KXMLBGAME, KXMLBSPREAD, KXMLBTOTAL.
 *                Free, keyless, and liquid on game lines. The board still
 *                prices team markets when the Odds API key is missing or dead.
 *
 * Orientation: every quote is from the HOME / OVER side's point of view.
 *   moneyline  point 0, over = home price, under = away price
 *   run line   point = HOME handicap (-1.5 means home must win by 2+)
 *   total      point = total, over/under as named
 */

import { oddsFetch } from '../lib/api.js';
import { BOOK_LABEL, BOOK_WEIGHT } from '../lib/markets.js';
import { fetchKalshiMarkets } from '../lib/kalshi.js';
import { feePerContractCents } from '../trade/fees.js';
import { probToAmerican } from '../lib/odds.js';
import { bestQuote } from '../model/lines.js';
import { evaluateEdge } from '../model/edges.js';
import { noPush } from '../model/game.js';
import { MARKET_WEIGHT, PLAY_RULES } from '../lib/constants.js';

export const TEAM_MARKETS = {
  game_ml: { label: 'Moneyline', short: 'ML' },
  game_spread: { label: 'Run Line', short: 'RL' },
  game_total: { label: 'Total', short: 'TOT' },
};

/** Books whose game-line prices form the consensus. DFS apps carry none. */
const CONSENSUS_BOOKS = new Set(['draftkings', 'fanduel', 'betmgm', 'caesars', 'pinnacle', 'novig']);

const KALSHI_SERIES = {
  KXMLBGAME: 'game_ml',
  KXMLBSPREAD: 'game_spread',
  KXMLBTOTAL: 'game_total',
};

// ── sportsbooks ─────────────────────────────────────────────────────────────

/**
 * Match an Odds API event to a schedule game: exact full team names, nearest
 * start time for doubleheaders. Same rule the prop feed uses.
 */
export function matchOddsEvent(events, game) {
  const start = new Date(game.gameDate).getTime();
  // The /odds feed lists every upcoming game, not just this slate's. Mid-series
  // the same matchup appears on consecutive days, and before tomorrow's lines
  // post "nearest start time" would hand tomorrow's game today's prices — which
  // the append-only snapshot would then keep forever. A doubleheader's two games
  // are hours apart; consecutive days are at least ~18.
  const MAX_START_GAP_MS = 6 * 3600e3;
  const candidates = (events || []).filter(
    (ev) =>
      ev.home_team === game.teams.home.team.name &&
      ev.away_team === game.teams.away.team.name &&
      Math.abs(new Date(ev.commence_time).getTime() - start) < MAX_START_GAP_MS,
  );
  if (!candidates.length) return null;
  return candidates.reduce((best, ev) =>
    Math.abs(new Date(ev.commence_time) - start) < Math.abs(new Date(best.commence_time) - start)
      ? ev
      : best,
  );
}

/**
 * Sportsbook quotes for one event.
 *
 * @returns {{game_ml: Quote[], game_spread: Quote[], game_total: Quote[]}}
 */
export function parseGameOdds(event) {
  const out = { game_ml: [], game_spread: [], game_total: [] };
  if (!event) return out;
  const { home_team: home, away_team: away } = event;
  for (const bookmaker of event.bookmakers || []) {
    if (!CONSENSUS_BOOKS.has(bookmaker.key)) continue;
    const book = BOOK_LABEL[bookmaker.key] || bookmaker.key.toUpperCase();
    const w = BOOK_WEIGHT[book] || 1;
    for (const market of bookmaker.markets || []) {
      const find = (pred) => (market.outcomes || []).find(pred);
      if (market.key === 'h2h') {
        const h = find((o) => o.name === home);
        const a = find((o) => o.name === away);
        if (h && a) out.game_ml.push({ book, point: 0, over: h.price, under: a.price, w });
      } else if (market.key === 'spreads') {
        const h = find((o) => o.name === home);
        const a = find((o) => o.name === away);
        // Both sides must be the same handicap mirrored, or it is not one market.
        if (h && a && h.point != null && h.point === -a.point) {
          out.game_spread.push({ book, point: h.point, over: h.price, under: a.price, w });
        }
      } else if (market.key === 'totals') {
        const o = find((x) => x.name === 'Over');
        const u = find((x) => x.name === 'Under');
        if (o && u && o.point != null && o.point === u.point) {
          out.game_total.push({ book, point: o.point, over: o.price, under: u.price, w });
        }
      }
    }
  }
  return out;
}

// ── Kalshi ──────────────────────────────────────────────────────────────────

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/**
 * `KXMLBGAME-26SEP161310CWSCLE` -> { date: '2026-09-16', etMinutes: 790, teams: 'CWSCLE' }.
 * Kalshi writes the start in US Eastern time and the two MLB abbreviations,
 * away first.
 */
export function parseKalshiGameTicker(eventTicker) {
  const m = /^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$/.exec(String(eventTicker || ''));
  if (!m || MONTHS[m[2]] == null) return null;
  const month = String(MONTHS[m[2]] + 1).padStart(2, '0');
  return {
    date: `20${m[1]}-${month}-${m[3]}`,
    etMinutes: Number(m[4]) * 60 + Number(m[5]),
    teams: m[6],
  };
}

const etMinutesOf = (iso) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute');
};

/**
 * A Kalshi YES contract as a two-sided American quote, fees included.
 *
 * Buying YES costs the ask plus Kalshi's fee; buying the other side costs the
 * NO ask plus its fee. Those two fee-inclusive costs play exactly the role of a
 * sportsbook's two prices, including the "vig" (spread + fees), so they go
 * through the same de-vig as every book.
 */
export function kalshiQuote(market, point) {
  const cost = (cents) =>
    cents > 0 && cents < 100 ? probToAmerican(Math.min(0.99, (cents + feePerContractCents(cents)) / 100)) : null;
  const yes = cost(market.yesAsk);
  const no = cost(market.noAsk ?? (market.yesBid != null ? 100 - market.yesBid : null));
  if (yes == null || no == null) return null;
  return { book: 'KAL', point, over: yes, under: no, w: 1, ticker: market.ticker };
}

/**
 * Kalshi game-line quotes, keyed by gamePk.
 *
 * Kalshi's run-line and total contracts are one-directional ladders: "HOU wins
 * by over 1.5", "Over 8.5 runs". A YES on "home wins by over 1.5" is home -1.5;
 * its NO is away +1.5. A YES on "away wins by over 1.5" is home +1.5 from the
 * UNDER side, so it is stored flipped.
 */
export function kalshiGameQuotes(markets, games, date) {
  const byGame = new Map();
  for (const game of games) byGame.set(game.gamePk, { game_ml: [], game_spread: [], game_total: [] });

  for (const market of markets || []) {
    const series = market.series || String(market.ticker).split('-')[0];
    const key = KALSHI_SERIES[series];
    if (!key) continue;
    const parsed = parseKalshiGameTicker(market.eventTicker);
    if (!parsed || parsed.date !== date) continue;

    const candidates = games.filter(
      (g) => `${g.teams.away.team.abbreviation}${g.teams.home.team.abbreviation}` === parsed.teams,
    );
    if (!candidates.length) continue;
    const game = candidates.reduce((best, g) =>
      Math.abs(etMinutesOf(g.gameDate) - parsed.etMinutes) <
      Math.abs(etMinutesOf(best.gameDate) - parsed.etMinutes)
        ? g
        : best,
    );
    const home = game.teams.home.team.abbreviation;
    const suffix = String(market.ticker).split('-').pop();
    const bucket = byGame.get(game.gamePk);

    if (key === 'game_ml') {
      // One contract per team; the home contract is the moneyline.
      if (suffix !== home) continue;
      const q = kalshiQuote(market, 0);
      if (q) bucket.game_ml.push(q);
    } else if (key === 'game_total') {
      if (market.threshold == null && market.raw?.floor_strike == null) continue;
      const point = Number(market.raw?.floor_strike ?? market.threshold);
      if (!Number.isFinite(point) || point % 1 === 0) continue;
      const q = kalshiQuote(market, point);
      if (q) bucket.game_total.push(q);
    } else if (key === 'game_spread') {
      const strike = Number(market.raw?.floor_strike);
      if (!Number.isFinite(strike)) continue;
      const team = suffix.replace(/\d+$/, '');
      const q = kalshiQuote(market, team === home ? -strike : strike);
      if (!q) continue;
      // Away-team contract: YES is the away side, i.e. the home UNDER.
      bucket.game_spread.push(team === home ? q : { ...q, over: q.under, under: q.over });
    }
  }
  return byGame;
}

// ── pricing ─────────────────────────────────────────────────────────────────

/**
 * Pick the line for each market, price it against the model, and return the
 * rows the Games board and Best Bets render.
 *
 * Sportsbooks set the line when they have one. Kalshi posts a whole ladder of
 * totals and spreads, so on its own it cannot vote on "the" line — it joins
 * whichever point the books chose, and only when there are no books does its
 * most balanced rung (closest to 50c) stand in.
 */
export function priceTeamMarkets(model, books, kalshi) {
  if (!model) return [];
  const rows = [];
  for (const key of Object.keys(TEAM_MARKETS)) {
    const bookQuotes = books?.[key] || [];
    const kalQuotes = kalshi?.[key] || [];
    let point;
    const fromBooks = bestQuote(bookQuotes);
    if (fromBooks) point = fromBooks.point;
    else if (kalQuotes.length) {
      point = kalQuotes.reduce((best, q) =>
        Math.abs(impliedOver(q) - 0.5) < Math.abs(impliedOver(best) - 0.5) ? q : best,
      ).point;
    } else continue;

    const atPoint = [...bookQuotes, ...kalQuotes].filter((q) => q.point === point);
    const best = bestQuote(atPoint);
    if (!best) continue;

    const probs =
      key === 'game_ml'
        ? { home: model.pHome, away: model.pAway }
        : key === 'game_spread'
          ? model.spread(point)
          : model.total(point);
    const modelOver = noPush(probs);

    const edge = evaluateEdge(modelOver, point, best.over, best.under, {
      quotes: best.quotes,
      weight: MARKET_WEIGHT[key],
      implausibleEdge: IMPLAUSIBLE_TEAM_EDGE,
      informationOnly: PLAY_RULES.gameLinesInformationOnly ? GAME_LINES_INFO_ONLY : undefined,
    });

    rows.push({
      market: key,
      label: TEAM_MARKETS[key].label,
      line: point,
      push: probs.push || 0,
      modelOver,
      over: best.over,
      under: best.under,
      overBook: best.overBook,
      underBook: best.underBook,
      nBooks: best.nBooks,
      books: [...new Set(atPoint.map((q) => q.book))],
      edge,
    });
  }
  return rows;
}

const impliedOver = (q) => {
  const p = (american) => (american < 0 ? -american / (100 - american) : 100 / (american + 100));
  const o = p(q.over);
  const u = p(q.under);
  return o / (o + u);
};

/**
 * Team markets are the most efficient prices in baseball, so the bar for
 * believing a disagreement is lower than on props. See the measurement in
 * CHANGELOG (v35) for how this was set against live Kalshi prices.
 */
export const IMPLAUSIBLE_TEAM_EDGE = 0.08;

/** Reason shown on every game-line and NRFI row while PLAY_RULES keeps them off the board. */
export const GAME_LINES_INFO_ONLY = 'game lines are information only — model is noisier than the market';

/**
 * Fetch both price sources for a slate. Never rejects: each source reports its
 * own error and the other still prices the board.
 */
export async function fetchTeamMarketQuotes({ games, date, oddsKey }) {
  const [books, kalshi] = await Promise.all([
    oddsFetch({ endpoint: 'game-odds', books: 'wide' }, oddsKey).then(
      // An error payload or a changed schema must degrade to "no book lines",
      // never throw: this runs inside the slate load, and a throw here would
      // take the whole board down with it.
      (res) => ({
        events: Array.isArray(res.body) ? res.body : [],
        remaining: res.remaining,
        error: Array.isArray(res.body) ? null : 'Odds API: unexpected game-odds response',
      }),
      (err) => ({ events: [], remaining: null, error: err.message }),
    ),
    fetchKalshiMarkets({ seriesTickers: Object.keys(KALSHI_SERIES) }).then(
      (res) => ({ markets: Array.isArray(res.markets) ? res.markets : [], error: res.errors?.[0]?.error || null }),
      (err) => ({ markets: [], error: err.message }),
    ),
  ]);

  let kalshiByGame = new Map();
  try {
    kalshiByGame = kalshiGameQuotes(kalshi.markets, games, date);
  } catch (err) {
    kalshi.error = kalshi.error || `Kalshi: ${err.message}`;
  }
  const quotesByGame = new Map();
  for (const game of games) {
    quotesByGame.set(game.gamePk, {
      books: parseGameOdds(matchOddsEvent(books.events, game)),
      kalshi: kalshiByGame.get(game.gamePk),
    });
  }
  return {
    quotesByGame,
    remaining: books.remaining,
    booksError: books.error,
    kalshiError: kalshi.error,
  };
}
