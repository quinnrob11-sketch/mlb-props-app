// Kalshi MLB bot — one run.
//
//   node bot/run.mjs                 dry run: decides orders, places nothing
//   node bot/run.mjs --live          places orders ONLY if bot/config.json also
//                                    has "live": true and API keys are set
//   node bot/run.mjs --date 2026-09-17 --config path/to/config.json
//   node bot/run.mjs --state-dir path/to/dir   journal + state somewhere other than bot/state
//
// Safety, in the order it is checked:
//   1. bot/STOP exists            -> exit immediately, nothing fetched
//   2. another run holds the lock -> exit
//   3. account halts              -> daily loss, daily order count, no bankroll
//   4. per-order limits           -> see bot/plan.mjs and config "limits"
//   5. idempotency                -> a client_order_id already sent today is never resent
// Every decision (placed or skipped, and why) is appended to bot/state/<date>.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFetch } from '../tools/local-api.mjs';
import { createClient, clientOrderId } from './kalshiClient.mjs';
import { feePerContractCents } from '../src/trade/fees.js';
import { planOrders, modelProbability, topOfBook, ALL_SERIES } from './plan.mjs';
import { normalizeMarket } from '../src/lib/kalshi.js';
import { parseKalshiGameTicker } from '../src/data/teamMarkets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);

const STATE_DIR = path.resolve(opt('state-dir', path.join(HERE, 'state')));
const STOP_FILE = path.join(HERE, 'STOP');
const LOCK_FILE = path.join(STATE_DIR, 'run.lock');
const todayEt = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * Whether an order may use real money.
 *
 * v36: live trading is opt-in PER SERIES through `liveSeries` in the config.
 * Two lookahead-free backtests against real settled Kalshi prices (Jul 10 -
 * Sep 15 2026, docs/KALSHI-BACKTEST.md and docs/KALSHI-BATTER-BACKTEST.md)
 * found no edge in any of the seven prop series: the exchange price was the
 * better forecast in every one, and bot-rule returns were negative or not
 * distinguishable from zero. So the default list is empty, and a live run
 * PAPER-TRADES everything — decides, sizes and journals each order exactly as
 * it would place it, without sending it — so the track record keeps building
 * (npm run bot:report) until a series earns its place on the list.
 */
export function isLiveSeries(order, config) {
  const series = order.series || String(order.ticker).split('-')[0];
  return Array.isArray(config.liveSeries) && config.liveSeries.includes(series);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export async function main() {
  if (fs.existsSync(STOP_FILE)) {
    log('STOP file present — not running. Delete bot/STOP to resume.');
    return { stopped: true };
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Lock: one run at a time; a lock older than 30 minutes is a crashed run.
  if (fs.existsSync(LOCK_FILE) && Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 30 * 60e3) {
    log(`another run is in progress (${LOCK_FILE}) — exiting`);
    return { locked: true };
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));

  try {
    const configPath = opt('config', path.join(HERE, 'config.json'));
    if (!fs.existsSync(configPath)) throw new Error(`no config at ${configPath} — copy bot/config.example.json to bot/config.json`);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const date = opt('date', todayEt());
    const keyId = process.env.KALSHI_KEY_ID || config.keyId || '';
    const privateKeyPath = process.env.KALSHI_PRIVATE_KEY_PATH || config.privateKeyPath || '';

    const client = createClient({ env: config.env, keyId: keyId || undefined, privateKeyPath: privateKeyPath || undefined });
    const wantLive = flag('live');
    const live = wantLive && config.live === true && client.authed;
    if (wantLive && !live) {
      log(`--live requested but ${config.live !== true ? 'config "live" is not true' : 'no API key is configured'} — DRY RUN`);
    }
    log(`${live ? 'LIVE' : 'DRY RUN'} on Kalshi ${config.env} for ${date}`);

    const journalPath = path.join(STATE_DIR, `${date}.jsonl`);
    const journal = (entry) => fs.appendFileSync(journalPath, JSON.stringify({ ts: new Date().toISOString(), live, env: config.env, date, ...entry }) + '\n');
    const statePath = path.join(STATE_DIR, `${date}.json`);
    const state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : { ordersToday: 0, spentTodayDollars: 0, sentClientIds: [], dayStartValueDollars: null };
    const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // ── slate: projections only, no sportsbook credits ─────────────────────
    installFetch(config.siteUrl);
    const { loadSlate } = await import('../src/data/loadSlate.js');
    const slate = await loadSlate({ date, odds: false, onStatus: () => {} });
    log(`slate: ${slate.games.length} games`);

    // ── Kalshi markets for this date ───────────────────────────────────────
    const markets = [];
    for (const series of ALL_SERIES) {
      const list = await client.markets(series);
      markets.push(...list.filter((m) => parseKalshiGameTicker(m.event_ticker)?.date === date));
    }
    const priceable = markets.filter((m) => modelProbability(normalizeMarket(m), slate, config).prob != null);
    log(`kalshi: ${markets.length} open markets for ${date}, ${priceable.length} priceable`);

    // Screen on each listing's top of book first; only the survivors cost an
    // order-book request. Pulling a full book for all ~1,000 priceable
    // contracts gets rate-limited by Kalshi within seconds.
    const topBooks = new Map(priceable.map((m) => [m.ticker, topOfBook(m)]).filter(([, b]) => b));
    const screen = planOrders({
      slate, markets: priceable, books: topBooks, state, now: new Date(),
      account: { balanceDollars: config.limits.bankrollDollars, positions: [], restingTickers: [] },
      config: { ...config, screenOnly: true },
    });
    const toFetch = (screen.screened || []).slice(0, 60);
    log(`screen: ${toFetch.length} contracts worth a full order book`);

    const books = new Map();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (cursor < toFetch.length) {
          const m = { ticker: toFetch[cursor++] };
          try {
            books.set(m.ticker, await client.orderbook(m.ticker));
          } catch (err) {
            journal({ type: 'error', ticker: m.ticker, error: err.message });
          }
        }
      }),
    );

    // ── account ────────────────────────────────────────────────────────────
    let account;
    if (client.authed) {
      const [bal, positions, resting] = await Promise.all([client.balance(), client.positions(), client.restingOrders()]);
      const balanceDollars = Number(bal.balance) / 100;
      const valueDollars = balanceDollars + Number(bal.portfolio_value || 0) / 100;
      if (state.dayStartValueDollars == null) state.dayStartValueDollars = valueDollars;
      account = {
        balanceDollars,
        valueDollars,
        dayStartValueDollars: state.dayStartValueDollars,
        positions: positions.map((p) => ({ ticker: p.ticker, position: Number(p.position_fp ?? p.position ?? 0), exposureDollars: Number(p.market_exposure_dollars ?? 0) })),
        restingTickers: resting.map((o) => o.ticker),
      };
    } else {
      // No keys: plan against the configured bankroll as if the account were empty.
      account = { balanceDollars: config.limits.bankrollDollars, valueDollars: 0, dayStartValueDollars: 0, positions: [], restingTickers: [] };
      log('no API key: planning against the configured bankroll with an empty account');
    }

    const plan = planOrders({ slate, markets: priceable.filter((m) => books.has(m.ticker)), books, account, state, config, now: new Date() });
    if (plan.halts.length) log(`HALTED: ${plan.halts.join('; ')}`);
    for (const c of plan.considered) journal({ type: 'skip', ...c });

    let placed = 0;
    for (const order of plan.orders) {
      const id = clientOrderId(date, order.ticker, order.side);
      if (state.sentClientIds.includes(id)) {
        journal({ type: 'skip', ...order, skip: 'already sent today' });
        continue;
      }
      const line = `${order.side.toUpperCase()} ${order.count} x ${order.ticker} @ ${order.priceCents}c ($${order.costDollars}) edge ${order.edgePts}pts`;
      if (!live || !isLiveSeries(order, config)) {
        const why = live ? 'series not in liveSeries (paper trade)' : 'dry run';
        log(`would place (${why}): ${line}`);
        journal({ type: 'dry-run', ...order, clientOrderId: id, paperReason: why });
        continue;
      }
      try {
        const res = await client.placeOrder({ ticker: order.ticker, side: order.side, priceCents: order.priceCents, count: order.count, clientOrderId: id });
        state.sentClientIds.push(id);
        state.ordersToday += 1;
        const filled = Number(res.fill_count || 0);
        // Count what the fills can have cost: our limit price is the most a
        // taker fill pays, plus the fee. (Was price only — fees were left out.)
        state.spentTodayDollars += filled * ((order.priceCents + feePerContractCents(order.priceCents)) / 100);
        saveState();
        placed += 1;
        log(`PLACED ${line} -> filled ${filled}, remaining ${res.remaining_count}`);
        journal({ type: 'order', ...order, clientOrderId: id, response: res });
      } catch (err) {
        // A duplicate client id (409) means an earlier run already sent it.
        if (err.status === 409) state.sentClientIds.push(id);
        saveState();
        log(`order FAILED ${line}: ${err.message}`);
        journal({ type: 'order-error', ...order, clientOrderId: id, status: err.status, error: err.message });
      }
    }
    saveState();
    log(`done: ${plan.orders.length} order(s) planned, ${placed} placed, bankroll used for sizing $${plan.bankroll}`);
    return { live, plan, placed };
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(new Date().toISOString(), 'run failed:', err.stack || err.message);
    process.exitCode = 1;
  });
}
