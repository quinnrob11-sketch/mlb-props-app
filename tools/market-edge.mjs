// Searching for an edge in the MARKET, not in the model (docs/MARKET-EDGE-SEARCH.md).
//
// Kalshi PUBLIC endpoints only, no auth, no orders. Everything is cached on
// disk under --kcache. Nothing here uses the bot's model: every rule tested is
// a function of prices, tickers, clocks and settlements alone.
//
//   node tools/market-edge.mjs fetch  --kcache ecache
//   node tools/market-edge.mjs scan   --kcache ecache [--json out.json]

import fs from 'node:fs';
import path from 'node:path';
import { settledMarkets, fetchCandles, parseEventTicker, startMsOf, quoteAt, mulberry32, readJson } from './kalshi-common.mjs';

export const SERIES = [
  'KXMLBKS', 'KXMLBOUTS', 'KXMLBHIT', 'KXMLBTB', 'KXMLBHR', 'KXMLBRBI',
  'KXMLBHRR', 'KXMLBSPREAD', 'KXMLBTOTAL', 'KXMLBRFI', 'KXMLBGAME',
];

// Only the fields any hypothesis below can use. Rules text, price ranges and
// the rest are dropped so the cache stays small enough to keep.
const KEEP = [
  'ticker', 'event_ticker', 'market_type', 'strike_type', 'floor_strike', 'cap_strike',
  'yes_sub_title', 'no_sub_title', 'result', 'settlement_value_dollars', 'expiration_value',
  'open_time', 'close_time', 'settlement_ts', 'created_time', 'expected_expiration_time',
  'volume_fp', 'open_interest_fp', 'last_price_dollars', 'custom_strike',
];

export const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/** The player a prop is on: Kalshi's own UUID, so no name matching anywhere. */
export const playerKey = (m) => m.custom_strike?.baseball_player || null;

export async function loadAll(kcache) {
  const out = {};
  for (const s of SERIES) {
    out[s] = await settledMarkets(kcache, s, { keep: KEEP });
    process.stderr.write(`${s}: ${out[s].length}\n`);
  }
  return out;
}

if (process.argv[2] === 'fetch') {
  const kcache = arg('--kcache', 'ecache');
  fs.mkdirSync(kcache, { recursive: true });
  const all = await loadAll(kcache);
  const dates = {};
  for (const [s, ms] of Object.entries(all)) {
    const ds = ms.map((m) => parseEventTicker(m.event_ticker)?.date).filter(Boolean).sort();
    dates[s] = { n: ms.length, first: ds[0], last: ds[ds.length - 1], unparsed: ms.length - ds.length };
  }
  console.log(JSON.stringify(dates, null, 2));
  fs.writeFileSync(path.join(kcache, 'coverage.json'), JSON.stringify(dates, null, 2));
}

// ── hourly book snapshots ───────────────────────────────────────────────────
// One file per (series, game date): ticker -> [[end_ts, yesBidCents, yesAskCents], ...].
// Hourly, not 1-minute: 294,589 settled markets cannot be pulled at 1-minute
// resolution politely. The close of an hourly candle is the top of book at that
// hour boundary, so two markets' candles for the same hour are simultaneous,
// which is what a cross-contract scan needs. An arbitrage visible at an hour
// boundary is real; ones that open and close inside the hour are invisible here,
// so every count below is a LOWER bound.
export const candleFile = (kcache, series, date) => path.join(kcache, 'c60', `${series}_${date}.json`);

export function marketsByDate(markets) {
  const out = new Map();
  for (const m of markets) {
    const p = parseEventTicker(m.event_ticker);
    if (!p) continue;
    if (!out.has(p.date)) out.set(p.date, []);
    out.get(p.date).push(m);
  }
  return out;
}

/** [08:00 ET on the game date, 07:00 ET the next day] — covers every first pitch and the game after it. */
function dayWindow(date) {
  const [y, mo, d] = date.split('-').map(Number);
  const at = (hh, dd) => {
    let ms = Date.UTC(y, mo - 1, dd, hh + 4, 0);
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const etH = Number(et.find((x) => x.type === 'hour').value);
    if (etH !== hh) ms += (hh - etH) * 3600e3;
    return Math.round(ms / 1000);
  };
  return [at(8, d), at(7, d + 1)];
}

export async function fetchDayCandles(kcache, series, date, markets) {
  const file = candleFile(kcache, series, date);
  if (fs.existsSync(file)) return readJson(file);
  const [s, e] = dayWindow(date);
  const out = await fetchCandles(markets.map((m) => m.ticker), s, e, 60, { maxTickers: 100 });
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

if (process.argv[2] === 'candles') {
  const kcache = arg('--kcache', 'ecache');
  const only = arg('--series', null);
  for (const s of SERIES) {
    if (only && s !== only) continue;
    const byDate = marketsByDate(await settledMarkets(kcache, s, { keep: KEEP }));
    const dates = [...byDate.keys()].sort();
    let i = 0;
    for (const d of dates) {
      await fetchDayCandles(kcache, s, d, byDate.get(d));
      process.stderr.write(`  ${s} ${d} (${++i}/${dates.length})\r`);
    }
    process.stderr.write(`\n${s}: ${dates.length} dates cached\n`);
  }
}
