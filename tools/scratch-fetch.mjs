// Cache 1-minute candles for every market that settled `scalar` (a cancelled
// player), plus the MLB StatsAPI lineup state for every game in the window.
// Kalshi public endpoints and the public MLB StatsAPI only. No orders, no auth,
// and The Odds API is never called.
//
//   node tools/scratch-fetch.mjs mincandles --kcache ecache
//   node tools/scratch-fetch.mjs lineups --kcache ecache
import fs from 'node:fs';
import path from 'node:path';
import { KALSHI, kget, parseEventTicker, startMsOf, readJson } from './kalshi-common.mjs';
import { SERIES, arg } from './market-edge.mjs';

const KCACHE = arg('--kcache', 'ecache');
const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));

let lastStats = 0;
export async function statsGet(url) {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), lastStats + 120);
    lastStats = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(60000) }); }
    catch (e) { if (attempt >= 5) throw e; await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
}

export function cachePath(...p) {
  const f = path.join(KCACHE, ...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return f;
}

export async function cachedJson(file, url, statsapi = false) {
  if (fs.existsSync(file)) return readJson(file);
  const body = statsapi ? await statsGet(url) : await kget(url);
  fs.writeFileSync(file, JSON.stringify(body));
  return body;
}

/** Every market that settled `scalar`, with its parsed event. */
export function scalarMarkets() {
  const out = [];
  for (const s of SERIES) {
    const f = path.join(KCACHE, `settled_${s}.json`);
    if (!fs.existsSync(f)) continue;
    for (const m of readJson(f).markets) if (m.result === 'scalar') out.push({ ...m, series: s });
  }
  return out;
}

/** Every market in a series for one event (used for the no-look-ahead universe). */
export function allMarkets() {
  const out = [];
  for (const s of SERIES) {
    const f = path.join(KCACHE, `settled_${s}.json`);
    if (!fs.existsSync(f)) continue;
    for (const m of readJson(f).markets) out.push({ ...m, series: s });
  }
  return out;
}

// ── 1-minute candles, keyed by event ────────────────────────────────────────
export const minuteFile = (event) => path.join(KCACHE, 'm1', `${event}.json`);

export async function fetchMinuteCandles(event, tickers, startTs, endTs) {
  const file = minuteFile(event);
  // Resumable and additive: an event first cached for its cancelled markets
  // alone is topped up when the wider candidate universe asks for more of its
  // tickers, rather than silently returning the narrower set.
  const out = fs.existsSync(file) ? readJson(file) : {};
  const missing = tickers.filter((t) => !(t in out));
  if (!missing.length) return out;
  const span = Math.ceil((endTs - startTs) / 60) + 2;
  const per = Math.max(1, Math.floor(10000 / span));
  for (let i = 0; i < missing.length; i += per) {
    const chunk = missing.slice(i, i + per);
    const body = await kget(`${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=1`);
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [
        c.end_period_ts, cents(c.yes_bid?.close_dollars), cents(c.yes_ask?.close_dollars),
        Number(c.volume_fp || 0), cents(c.price?.close_dollars),
      ]);
    }
    for (const t of chunk) out[t] ||= [];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

if (process.argv[2] === 'mincandles') {
  const byEvent = new Map();
  for (const m of scalarMarkets()) {
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
    byEvent.get(m.event_ticker).push(m);
  }
  const events = [...byEvent.keys()].sort();
  let i = 0;
  for (const ev of events) {
    const ms = byEvent.get(ev);
    const T = startMsOf(parseEventTicker(ev));
    // T-5h covers every listing (median open is T-15h but the book is dead
    // that early) through T+6h, past the latest observed close (T+310 at p95).
    const s = Math.round(T / 1000) - 5 * 3600;
    const e = Math.round(T / 1000) + 6 * 3600;
    try { await fetchMinuteCandles(ev, ms.map((m) => m.ticker), s, e); }
    catch (err) { process.stderr.write(`\n  ${ev}: ${err.message}\n`); }
    process.stderr.write(`  ${++i}/${events.length} ${ev}\r`);
  }
  process.stderr.write('\n');
}

// ── lineups, with the wall clock at which StatsAPI first served them ────────
// `GET /api/v1.1/game/<pk>/feed/live/timestamps` lists every timecode the feed
// was written at; `feed/live?timecode=<t>` replays the feed's state as of that
// timecode. The first timecode is therefore the earliest moment this study can
// prove the lineup was public, and `feed/live?timecode=<first>` is the
// announced starting lineup (it differs from the final boxscore order whenever
// anyone was substituted, which is the check that the replay is real).
const FEED_FIELDS = 'fields=metaData,timeStamp,gameData,teams,away,home,abbreviation,probablePitchers,id,fullName,players,liveData,boxscore,battingOrder,batters,pitchers,bench,bullpen';
const tcMs = (t) => Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`);

export async function gameLineup(pk) {
  const file = cachePath('lineup', `${pk}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const ts = await statsGet(`https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live/timestamps`);
  const first = Array.isArray(ts) && ts.length ? ts[0] : null;
  const at = async (tc) => statsGet(`https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live?${FEED_FIELDS}${tc ? `&timecode=${tc}` : ''}`);
  const j0 = first ? await at(first) : await at(null);
  const jf = await at(null);
  const side = (j, s) => {
    const t = j.liveData?.boxscore?.teams?.[s] || {};
    return { battingOrder: t.battingOrder || [], batters: t.batters || [], pitchers: t.pitchers || [], bench: t.bench || [] };
  };
  const names = {};
  for (const [k, p] of Object.entries(jf.gameData?.players || {})) names[p.id ?? k.replace('ID', '')] = p.fullName;
  const out = {
    gamePk: pk,
    firstTimecode: first,
    firstTimecodeMs: first ? tcMs(first) : null,
    nTimecodes: Array.isArray(ts) ? ts.length : 0,
    away: jf.gameData?.teams?.away?.abbreviation || null,
    home: jf.gameData?.teams?.home?.abbreviation || null,
    announced: { away: side(j0, 'away'), home: side(j0, 'home') },
    final: { away: side(jf, 'away'), home: side(jf, 'home') },
    probables: jf.gameData?.probablePitchers || {},
    announcedProbables: j0.gameData?.probablePitchers || {},
    names,
  };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

export async function dateGames(date) {
  const j = await cachedJson(cachePath('sched2', `${date}.json`),
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&fields=dates,games,gamePk,gameDate,gameNumber,status,codedGameState,detailedState,teams,away,home,team,id`, true);
  return (j.dates?.[0]?.games || []);
}

if (process.argv[2] === 'lineups') {
  // Every date the player series cover, not only the dates that happen to
  // contain a cancelled market: the study's denominator is all listed markets.
  const dates = [...new Set(allMarkets().map((m) => parseEventTicker(m.event_ticker)?.date).filter(Boolean))].sort();
  let i = 0;
  for (const d of dates) {
    const games = await dateGames(d);
    for (const g of games) {
      try { await gameLineup(g.gamePk); } catch (e) { process.stderr.write(`\n  ${g.gamePk}: ${e.message}\n`); }
    }
    process.stderr.write(`  ${++i}/${dates.length} ${d} (${games.length} games)\r`);
  }
  process.stderr.write('\n');
}

// Minute candles for the candidate universe (`scratch-scan.mjs candidates`),
// which includes markets that did NOT settle scalar.
if (process.argv[2] === 'candcandles') {
  const f = arg('--candidates', path.join(KCACHE, '_candidates.json'));
  const { events } = readJson(f);
  let i = 0;
  for (const ev of events) {
    const s = Math.round(ev.firstPitchMs / 1000) - 5 * 3600;
    const e = Math.round(ev.firstPitchMs / 1000) + 6 * 3600;
    try { await fetchMinuteCandles(ev.event, ev.tickers, s, e); }
    catch (err) { process.stderr.write(`\n  ${ev.event}: ${err.message}\n`); }
    process.stderr.write(`  ${++i}/${events.length} ${ev.event}\r`);
  }
  process.stderr.write('\n');
}
