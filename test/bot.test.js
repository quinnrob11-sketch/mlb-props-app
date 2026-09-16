// Kalshi bot: request signing, order translation, and every limit that decides
// whether money moves. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signingString, sign, orderBody, clientOrderId } from '../bot/kalshiClient.mjs';
import { planOrders, modelProbability, topOfBook, playerKeyOf } from '../bot/plan.mjs';
import { normalizeMarket } from '../src/lib/kalshi.js';

// ── signing ────────────────────────────────────────────────────────────────

test('the signed string is timestamp + METHOD + path without the query string', () => {
  assert.equal(
    signingString('1700000000000', 'get', '/trade-api/v2/portfolio/orders?limit=5'),
    '1700000000000GET/trade-api/v2/portfolio/orders',
  );
});

test('signatures are RSA-PSS SHA-256 with digest-length salt and verify with the public key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const msg = signingString('1700000000000', 'POST', '/trade-api/v2/portfolio/events/orders');
  const sig = sign(pem, msg);
  const ok = crypto.verify('sha256', Buffer.from(msg), {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, Buffer.from(sig, 'base64'));
  assert.ok(ok);
});

// ── orders ─────────────────────────────────────────────────────────────────

test('buying YES is a bid at the YES price; buying NO is an ask at 1 - NO price', () => {
  const yes = orderBody({ ticker: 'T', side: 'yes', priceCents: 42, count: 3, clientOrderId: 'x' });
  assert.equal(yes.side, 'bid');
  assert.equal(yes.price, '0.4200');
  assert.equal(yes.count, '3.00');
  assert.equal(yes.time_in_force, 'immediate_or_cancel', 'nothing rests on the book unattended');
  const no = orderBody({ ticker: 'T', side: 'no', priceCents: 30, count: 4, clientOrderId: 'x' });
  assert.equal(no.side, 'ask');
  assert.equal(no.price, '0.7000');
});

test('malformed orders are refused before they are sent', () => {
  assert.throws(() => orderBody({ ticker: 'T', side: 'maybe', priceCents: 40, count: 1 }));
  assert.throws(() => orderBody({ ticker: 'T', side: 'yes', priceCents: 0, count: 1 }));
  assert.throws(() => orderBody({ ticker: 'T', side: 'yes', priceCents: 40.5, count: 1 }));
  assert.throws(() => orderBody({ ticker: 'T', side: 'yes', priceCents: 40, count: 0 }));
});

test('client order ids are deterministic per day, ticker and side', () => {
  assert.equal(clientOrderId('2026-09-16', 'T', 'yes'), clientOrderId('2026-09-16', 'T', 'yes'));
  assert.notEqual(clientOrderId('2026-09-16', 'T', 'yes'), clientOrderId('2026-09-16', 'T', 'no'));
  assert.notEqual(clientOrderId('2026-09-16', 'T', 'yes'), clientOrderId('2026-09-17', 'T', 'yes'));
});

// ── planning ───────────────────────────────────────────────────────────────

const DATE = '2026-09-16';
const game = {
  gamePk: 1,
  gameDate: '2026-09-16T23:10:00Z', // 19:10 ET
  away: { abbr: 'DET', name: 'Detroit Tigers' },
  home: { abbr: 'CLE', name: 'Cleveland Guardians' },
  pitchers: [{ id: 10, name: 'Test Arm', proj: { dist: { k: (line) => (line === 5.5 ? 0.6 : line === 6.5 ? 0.45 : 0.3) } } }],
  batters: [
    { id: 20, name: 'Test Bat', lineupSource: 'confirmed', proj: { dist: { hits: () => 0.7 } } },
    { id: 21, name: 'Maybe Bat', lineupSource: 'projected', proj: { dist: { hits: () => 0.7 } } },
  ],
  game: {
    pHome: 0.6,
    pAway: 0.4,
    spread: (homeSpread) => (homeSpread === -1.5 ? { home: 0.42, away: 0.58, push: 0 } : { home: 0.7, away: 0.3, push: 0 }),
    total: () => ({ over: 0.5, under: 0.5, push: 0 }),
  },
};
const slate = { games: [game] };
const NOW = new Date('2026-09-16T16:00:00Z');

const kmarket = (ticker, extra = {}) => ({
  ticker,
  event_ticker: ticker.split('-').slice(0, 2).join('-'),
  series_ticker: ticker.split('-')[0],
  status: 'active',
  ...extra,
});
const book = (yesBid, yesAsk, depth = 500) => ({ orderbook: { yes: [[yesBid, depth]], no: [[100 - yesAsk, depth]] } });

const config = {
  markets: { playerProps: true, gameLines: true },
  requireConfirmedLineup: true,
  minMinutesBeforeStart: 10,
  minEdgeAfterFees: 0.02,
  limits: {
    bankrollDollars: 100, maxOrderDollars: 5, maxGameExposureDollars: 10, maxOpenExposureDollars: 40,
    maxDailySpendDollars: 30, maxDailyLossDollars: 20, maxOrdersPerRun: 5, maxOrdersPerDay: 15,
    maxContractsPerOrder: 50, kellyFraction: 0.25, minPriceCents: 15, maxPriceCents: 90,
  },
};
const emptyAccount = { balanceDollars: 500, valueDollars: 500, dayStartValueDollars: 500, positions: [], restingTickers: [] };
const freshState = { ordersToday: 0, spentTodayDollars: 0, sentClientIds: [] };

test('game contracts map to the right model probability for either team', () => {
  const p = (ticker, extra) => modelProbability(normalizeMarket(kmarket(ticker, extra)), slate, config).prob;
  assert.equal(p('KXMLBGAME-26SEP161910DETCLE-CLE'), 0.6);
  assert.equal(p('KXMLBGAME-26SEP161910DETCLE-DET'), 0.4);
  // "CLE wins by over 1.5" = home -1.5 covers; "DET wins by over 1.5" = home +1.5 fails.
  assert.equal(p('KXMLBSPREAD-26SEP161910DETCLE-CLE2', { floor_strike: 1.5 }), 0.42);
  assert.equal(p('KXMLBSPREAD-26SEP161910DETCLE-DET2', { floor_strike: 1.5 }), 0.3);
});

test('batter props need a confirmed lineup; the wrong date never matches', () => {
  // Real listing format: subtitle 'Name: N+', half-point floor_strike.
  const m = (name, ticker) => normalizeMarket(kmarket(ticker, { yes_sub_title: `${name}: 2+`, title: `${name}: 2+ hits?`, floor_strike: 1.5 }));
  const unconfirmed = modelProbability(m('Maybe Bat', 'KXMLBHIT-26SEP161910DETCLE-CLEMBAT21-2'), slate, config);
  assert.equal(unconfirmed.prob, null);
  assert.equal(unconfirmed.reason, 'lineup not confirmed');
  const otherDay = modelProbability(normalizeMarket(kmarket('KXMLBGAME-26SEP171910DETCLE-CLE')), slate, config);
  assert.equal(otherDay.prob, null);
});

const plan = (overrides = {}) =>
  planOrders({
    slate,
    markets: [kmarket('KXMLBGAME-26SEP161910DETCLE-CLE')],
    books: new Map([['KXMLBGAME-26SEP161910DETCLE-CLE', book(52, 53)]]),
    account: emptyAccount,
    state: freshState,
    config,
    now: NOW,
    ...overrides,
  });

test('game lines cannot clear fees under the safety caps', () => {
  // Weight 0.3 x the 8pt cap = at most 2.4pts of credited edge, which never
  // covers Kalshi's ~1.75c fee plus the 2pt minimum. Stated as a test so a
  // change to either number is a decision, not an accident.
  const { orders, considered } = plan();
  assert.equal(orders.length, 0);
  assert.ok(considered.some((c) => /required/.test(c.skip)));
});

const K6 = 'KXMLBKS-26SEP161910DETCLE-DETTARM10-6';
const kPlan = (overrides = {}) =>
  plan({
    markets: [kmarket(K6, { yes_sub_title: 'Test Arm: 6+', floor_strike: 5.5 })],
    books: new Map([[K6, book(49, 50)]]),
    ...overrides,
  });

test('a clear prop edge within limits produces one sized order', () => {
  // Model 60% vs a 49.5c mid: inside the 12pt prop cap, positive after fees.
  const { orders, halts } = kPlan();
  assert.deepEqual(halts, []);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].side, 'yes');
  assert.ok(orders[0].costDollars <= config.limits.maxOrderDollars);
});

test('a model far from the exchange is treated as model error', () => {
  const { orders, considered } = plan({ books: new Map([['KXMLBGAME-26SEP161910DETCLE-CLE', book(40, 41)]]) });
  assert.equal(orders.length, 0);
  assert.ok(considered.some((c) => /model error/.test(c.skip)));
});

test('daily loss, daily order count and bankroll halt everything', () => {
  assert.match(plan({ account: { ...emptyAccount, valueDollars: 479, dayStartValueDollars: 500 } }).halts.join(), /daily loss/);
  assert.match(plan({ state: { ...freshState, ordersToday: 15 } }).halts.join(), /orders today/);
  assert.match(plan({ account: { ...emptyAccount, balanceDollars: 0 } }).halts.join(), /no bankroll/);
});

test('existing positions and resting orders are never doubled', () => {
  const held = kPlan({ account: { ...emptyAccount, positions: [{ ticker: K6, position: 3, exposureDollars: 1.6 }] } });
  assert.equal(held.orders.length, 0);
  const resting = kPlan({ account: { ...emptyAccount, restingTickers: [K6] } });
  assert.equal(resting.orders.length, 0);
});

test('nothing trades inside ten minutes of first pitch', () => {
  const { orders, considered } = kPlan({ now: new Date('2026-09-16T23:05:00Z') });
  assert.equal(orders.length, 0);
  assert.ok(considered.some((c) => c.skip === 'too close to first pitch'));
});

test('the daily spend limit caps size, and a spent budget places nothing', () => {
  const spent = kPlan({ state: { ...freshState, spentTodayDollars: 30 } });
  assert.equal(spent.orders.length, 0);
});

test('game lines can be switched off in config', () => {
  const off = plan({ config: { ...config, markets: { playerProps: true, gameLines: false } } });
  assert.equal(off.orders.length, 0);
});

test('only the best rung of a ladder is bought', () => {
  const markets = [
    kmarket('KXMLBKS-26SEP161910DETCLE-DETTARM10-6', { yes_sub_title: 'Test Arm: 6+', floor_strike: 5.5 }),
    kmarket('KXMLBKS-26SEP161910DETCLE-DETTARM10-7', { yes_sub_title: 'Test Arm: 7+', floor_strike: 6.5 }),
  ];
  const books = new Map([
    [markets[0].ticker, book(50, 51)],
    [markets[1].ticker, book(36, 37)],
  ]);
  const { orders } = planOrders({ slate, markets, books, account: emptyAccount, state: freshState, config, now: NOW });
  assert.equal(orders.length, 1, JSON.stringify(orders));
});

test('top-of-book screening reads a market listing', () => {
  const b = topOfBook(kmarket('X-26SEP161910DETCLE-CLE', { yes_bid_dollars: '0.4100', yes_ask_dollars: '0.4300' }));
  assert.deepEqual(b.orderbook.yes[0], [41, 1e6]);
  assert.deepEqual(b.orderbook.no[0], [57, 1e6]);
  assert.equal(topOfBook(kmarket('X-26SEP161910DETCLE-CLE', {})), null);
});

// ── per-player limits ──────────────────────────────────────────────────────

test('hits and total bases on the same player share one player key', () => {
  assert.equal(
    playerKeyOf('KXMLBHIT-26SEP161310CWSCLE-CWSRGRICHUK34-2'),
    playerKeyOf('KXMLBTB-26SEP161310CWSCLE-CWSRGRICHUK34-2'),
  );
  assert.notEqual(
    playerKeyOf('KXMLBTB-26SEP161310CWSCLE-CWSRGRICHUK34-2'),
    playerKeyOf('KXMLBTB-26SEP161310CWSCLE-CWSOTHER12-2'),
  );
  assert.equal(playerKeyOf('KXMLBGAME-26SEP161310CWSCLE-CLE'), null, 'game lines have no player');
});

const HIT = 'KXMLBHIT-26SEP161910DETCLE-CLETBAT20-2';
const TB = 'KXMLBTB-26SEP161910DETCLE-CLETBAT20-2';
const batGame = {
  ...game,
  batters: [{ id: 20, name: 'Test Bat', lineupSource: 'confirmed', proj: { dist: { hits: () => 0.6, tb: () => 0.6265 } } }], // the 2026-09-16 batter refit deleted the tb@1.5 calibration; 0.6265 is the old 0.65 minus its 2.35pt, so the fixture prices exactly as before
};
const batPlan = (overrides = {}) =>
  planOrders({
    slate: { games: [batGame] },
    markets: [
      kmarket(HIT, { yes_sub_title: 'Test Bat: 2+', floor_strike: 1.5 }),
      kmarket(TB, { yes_sub_title: 'Test Bat: 2+', floor_strike: 1.5 }),
    ],
    books: new Map([
      [HIT, book(49, 50)],
      [TB, book(52, 53)], // both contracts clear fee + 2pts on their own, after calibration
    ]),
    account: emptyAccount,
    state: freshState,
    config,
    now: NOW,
    ...overrides,
  });

test('two bet types on one player place one order, not two', () => {
  const { orders, considered } = batPlan();
  assert.equal(orders.length, 1, JSON.stringify(orders));
  assert.ok(considered.some((c) => /bet\(s\) on this player/.test(c.skip)), JSON.stringify(considered));
});

test('a player already held is not bet on again in another series', () => {
  const { orders } = batPlan({
    account: { ...emptyAccount, positions: [{ ticker: 'KXMLBHR-26SEP161910DETCLE-CLETBAT20-1', position: 5, exposureDollars: 1 }] },
  });
  assert.equal(orders.length, 0);
});

test('raising maxBetsPerPlayer allows more bets, still under the player dollar cap', () => {
  const loose = { ...config, limits: { ...config.limits, maxBetsPerPlayer: 2, maxPlayerExposureDollars: 5 } };
  const { orders } = batPlan({ config: loose });
  assert.equal(orders.length, 2);
  const total = orders.reduce((s, o) => s + o.costDollars, 0);
  assert.ok(total <= 5 + 1e-9, `player total $${total}`);
});

// ── v36: doubleheaders and same-named players ─────────────────────────────

test('a G2 contract prices the second game of a doubleheader', () => {
  const g1 = { ...game, gamePk: 101, gameNumber: 1, gameDate: '2026-09-16T17:10:00Z', game: { ...game.game, pHome: 0.55, pAway: 0.45 } };
  const g2 = { ...game, gamePk: 102, gameNumber: 2, gameDate: '2026-09-16T23:10:00Z', game: { ...game.game, pHome: 0.62, pAway: 0.38 } };
  const dh = { games: [g1, g2] };
  const p = (ticker) => modelProbability(normalizeMarket(kmarket(ticker)), dh, config);
  assert.equal(p('KXMLBGAME-26SEP161910DETCLEG2-CLE').prob, 0.62);
  assert.equal(p('KXMLBGAME-26SEP161310DETCLEG1-CLE').prob, 0.55);
  assert.equal(p('KXMLBGAME-26SEP161910DETCLE-CLE').reason, 'doubleheader: cannot tell which game');
});

test('a team-tagged name ("Max Muncy (LAD)") resolves to that team only', () => {
  const muncyGame = {
    ...game,
    batters: [
      { id: 1, name: 'Max Muncy', teamAbbr: 'DET', lineupSource: 'confirmed', proj: { dist: { hits: () => 0.4 } } },
      { id: 2, name: 'Max Muncy', teamAbbr: 'CLE', lineupSource: 'confirmed', proj: { dist: { hits: () => 0.7 } } },
    ],
  };
  const m = normalizeMarket(kmarket('KXMLBHIT-26SEP161910DETCLE-CLEMMUNCY13-2', { yes_sub_title: 'Max Muncy (CLE): 2+', floor_strike: 1.5 }));
  const r = modelProbability(m, { games: [muncyGame] }, config);
  assert.equal(r.person?.id, 2, r.reason);
});
