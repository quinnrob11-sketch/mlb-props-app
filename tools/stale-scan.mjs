// Family B of docs/MARKET-EDGE-SEARCH.md: does the price lag the box score?
//
// This is the one test that needs no forecast at all, only the news and the
// clock. Once a starter has recorded his s-th strikeout, "s+ strikeouts" is
// worth exactly 100c and nothing can change that. Once he has left the game
// with F strikeouts, every rung above F is worth exactly 0c. StatsAPI stamps
// both moments. The question is what Kalshi was quoting a minute later.
//
//   node tools/stale-scan.mjs --kcache ecache --split 2026-09-01 [--json out.json]
//
// Kalshi public API and the public MLB StatsAPI only. Everything is cached.

import fs from 'node:fs';
import path from 'node:path';
import { KALSHI, kget, parseEventTicker, startMsOf, mulberry32, readJson } from './kalshi-common.mjs';
import { arg } from './market-edge.mjs';

const KCACHE = arg('--kcache', 'ecache');
const SPLIT = arg('--split', '2026-09-01');
const FEE = (c) => (0.07 * c * (100 - c)) / 100;
const SHOW_CONFIRM = process.argv.includes('--confirm');

const cacheDir = (...p) => {
  const d = path.join(KCACHE, ...p);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  return d;
};

async function cachedJson(file, url, { statsapi = false } = {}) {
  if (fs.existsSync(file)) return readJson(file);
  const body = statsapi ? await statsGet(url) : await kget(url);
  fs.writeFileSync(file, JSON.stringify(body));
  return body;
}

let lastStats = 0;
async function statsGet(url) {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), lastStats + 150);
    lastStats = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
}

// ── the box score clock ─────────────────────────────────────────────────────
const PBP_FIELDS = 'allPlays,about,startTime,endTime,halfInning,inning,isComplete,result,event,eventType,matchup,pitcher,id,fullName';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();

/**
 * Per pitcher in one game:
 *   kTimes    the endTime of each strikeout he recorded, in order
 *   outMs     when the market could first have known he was gone: the start of
 *             the first play thrown by his replacement, or the end of the game.
 */
async function gamePitchers(pk) {
  const j = await cachedJson(cacheDir('mlb', `pbp_${pk}.json`), `https://statsapi.mlb.com/api/v1/game/${pk}/playByPlay?fields=${PBP_FIELDS}`, { statsapi: true });
  const plays = (j.allPlays || []).filter((p) => p.about?.isComplete && p.matchup?.pitcher?.id);
  const byP = new Map();
  for (const p of plays) {
    const id = p.matchup.pitcher.id;
    if (!byP.has(id)) byP.set(id, { id, name: p.matchup.pitcher.fullName, kTimes: [], lastMs: 0 });
    const e = byP.get(id);
    const end = Date.parse(p.about.endTime);
    if (p.result?.eventType === 'strikeout') e.kTimes.push(end);
    e.lastMs = Math.max(e.lastMs, end);
  }
  // Who replaced whom: walk the plays of each half-inning side in order.
  const sides = { top: [], bottom: [] };
  for (const p of plays) sides[p.about.halfInning === 'top' ? 'top' : 'bottom'].push(p);
  for (const side of Object.values(sides)) {
    for (let i = 1; i < side.length; i++) {
      const prev = side[i - 1].matchup.pitcher.id;
      const cur = side[i].matchup.pitcher.id;
      if (prev !== cur && byP.has(prev) && byP.get(prev).outMs == null) {
        byP.get(prev).outMs = Date.parse(side[i].about.startTime || side[i].about.endTime);
      }
    }
    if (side.length) {
      const last = side[side.length - 1].matchup.pitcher.id;
      const e = byP.get(last);
      if (e && e.outMs == null) e.outMs = Date.parse(plays[plays.length - 1].about.endTime);
    }
  }
  return [...byP.values()];
}

// ── prices, at one minute ───────────────────────────────────────────────────
const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));

async function minuteCandles(event, tickers, startTs, endTs) {
  const file = cacheDir('c1', `${event}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const out = {};
  const per = Math.max(1, Math.floor(10000 / (Math.ceil((endTs - startTs) / 60) + 2)));
  for (let i = 0; i < tickers.length; i += per) {
    const chunk = tickers.slice(i, i + per);
    const body = await kget(`${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=1`);
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [
        c.end_period_ts, cents(c.yes_bid?.close_dollars), cents(c.yes_ask?.close_dollars), Number(c.volume_fp || 0),
      ]);
    }
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Top of book at or before `ms`, from 1-minute candles. */
function quoteAtMin(c, ms) {
  const ts = ms / 1000;
  let q = null;
  for (const x of c || []) { if (x[0] > ts) break; q = x; }
  if (!q) return null;
  return { ts: q[0], bid: q[1] > 0 ? q[1] : null, ask: q[2] != null && q[2] < 100 ? q[2] : null };
}
/** Volume traded in (from, to]. */
const volumeIn = (c, fromMs, toMs) => (c || []).reduce((s, x) => (x[0] * 1000 > fromMs && x[0] * 1000 <= toMs ? s + x[3] : s), 0);

// ── the scan ────────────────────────────────────────────────────────────────
const HORIZONS = [1, 2, 5, 15, 30, 60];

function emptyB() {
  return { cases: 0, byHorizon: Object.fromEntries(HORIZONS.map((h) => [h, { quoted: 0, profitable: 0, edgeSum: 0, edge5: 0, volSum: 0 }])), examples: [] };
}

const markets = readJson(path.join(KCACHE, 'settled_KXMLBKS.json')).markets;
const byEvent = new Map();
for (const m of markets) {
  if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
  byEvent.get(m.event_ticker).push(m);
}

const MAXD = Number(arg('--max-dates', '999'));
const dates = [...new Set([...byEvent.keys()].map((e) => parseEventTicker(e)?.date).filter(Boolean))].sort().slice(0, MAXD);
const res = {
  split: SPLIT,
  B1: { discovery: emptyB(), confirm: emptyB() },
  B2: { discovery: emptyB(), confirm: emptyB() },
  coverage: { events: 0, matchedEvents: 0, pitchersMatched: 0, ambiguousNames: 0, contradictions: 0, checked: 0 },
};

for (const date of dates) {
  const sched = await cachedJson(cacheDir('mlb', `sched_${date}.json`), `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`, { statsapi: true });
  const games = (sched.dates?.[0]?.games || []).filter((g) => g.status?.codedGameState === 'F' || g.status?.detailedState === 'Final');
  // pitcher name -> game, for this date. Ambiguous names are dropped.
  const nameToGame = new Map();
  const pitchersOf = new Map();
  for (const g of games) {
    let ps;
    try { ps = await gamePitchers(g.gamePk); } catch { continue; }
    pitchersOf.set(g.gamePk, ps);
    for (const p of ps) {
      const k = norm(p.name);
      if (nameToGame.has(k)) { nameToGame.set(k, 'AMBIGUOUS'); continue; }
      nameToGame.set(k, g.gamePk);
    }
  }

  for (const [ev, ms] of byEvent) {
    const parsed = parseEventTicker(ev);
    if (parsed?.date !== date) continue;
    res.coverage.events++;
    const bucket = date <= SPLIT ? 'discovery' : 'confirm';
    // Group this event's rungs by the player named in the subtitle.
    const byPlayer = new Map();
    for (const m of ms) {
      const name = String(m.yes_sub_title || '').split(':')[0];
      const k = norm(name);
      if (!k || m.floor_strike == null) continue;
      if (!byPlayer.has(k)) byPlayer.set(k, []);
      byPlayer.get(k).push(m);
    }
    const work = [];
    for (const [k, rungs] of byPlayer) {
      const pk = nameToGame.get(k);
      if (pk === 'AMBIGUOUS') { res.coverage.ambiguousNames++; continue; }
      if (!pk) continue;
      const p = (pitchersOf.get(pk) || []).find((x) => norm(x.name) === k);
      if (!p) continue;
      work.push({ rungs, p });
    }
    if (!work.length) continue;
    res.coverage.matchedEvents++;
    res.coverage.pitchersMatched += work.length;

    const T = startMsOf(parsed);
    const tickers = work.flatMap((w) => w.rungs.map((m) => m.ticker));
    let candles;
    try {
      candles = await minuteCandles(ev, tickers, Math.round(T / 1000), Math.round(T / 1000) + 6 * 3600);
    } catch { continue; }

    for (const { rungs, p } of work) {
      const F = p.kTimes.length;
      for (const m of rungs) {
        const s = Math.ceil(m.floor_strike); // "s+"
        // Integrity check: StatsAPI's count and Kalshi's settlement must agree.
        // A disagreement means the name matched the wrong pitcher, and it is
        // counted rather than quietly dropped.
        if (m.result === 'yes' || m.result === 'no') {
          res.coverage.checked++;
          if ((s <= F) !== (m.result === 'yes')) res.coverage.contradictions++;
        }
        const c = candles[m.ticker];
        if (!c || !c.length) continue;
        // B1: the s-th strikeout has happened. YES is certain.
        if (s <= F && m.result === 'yes') {
          const t0 = p.kTimes[s - 1];
          const b = res.B1[bucket];
          b.cases++;
          for (const h of HORIZONS) {
            const q = quoteAtMin(c, t0 + h * 60e3);
            const cell = b.byHorizon[h];
            if (!q || q.ask == null) continue;
            cell.quoted++;
            const edge = 100 - q.ask - FEE(q.ask);
            if (edge > 0) cell.profitable++;
            cell.edgeSum += Math.max(0, edge);
            if (edge >= 5) cell.edge5++;
            cell.volSum += volumeIn(c, t0, t0 + h * 60e3);
            if (h === 5 && edge >= 5 && b.examples.length < 8) b.examples.push({ ticker: m.ticker, s, kAt: new Date(t0).toISOString(), ask: q.ask, edge: Number(edge.toFixed(2)) });
          }
        }
        // B2: he is gone and finished with F. Every rung above F is certain NO.
        if (s > F && p.outMs && m.result === 'no') {
          const t0 = p.outMs;
          const b = res.B2[bucket];
          b.cases++;
          for (const h of HORIZONS) {
            const q = quoteAtMin(c, t0 + h * 60e3);
            const cell = b.byHorizon[h];
            if (!q || q.bid == null) continue;
            cell.quoted++;
            const edge = q.bid - FEE(100 - q.bid);
            if (edge > 0) cell.profitable++;
            cell.edgeSum += Math.max(0, edge);
            if (edge >= 5) cell.edge5++;
            cell.volSum += volumeIn(c, t0, t0 + h * 60e3);
            if (h === 5 && edge >= 5 && b.examples.length < 8) b.examples.push({ ticker: m.ticker, s, outAt: new Date(t0).toISOString(), bid: q.bid, edge: Number(edge.toFixed(2)) });
          }
        }
      }
    }
  }
  process.stderr.write(`  ${date}: events=${res.coverage.events} matched=${res.coverage.matchedEvents} B1=${res.B1.discovery.cases + res.B1.confirm.cases} B2=${res.B2.discovery.cases + res.B2.confirm.cases}\r`);
}
process.stderr.write('\n');

const summary = (b) => ({
  cases: b.cases,
  byHorizon: Object.fromEntries(HORIZONS.map((h) => {
    const c = b.byHorizon[h];
    return [h, {
      quotedPct: b.cases ? Number((100 * c.quoted / b.cases).toFixed(1)) : null,
      profitablePct: c.quoted ? Number((100 * c.profitable / c.quoted).toFixed(1)) : null,
      atLeast5cPct: c.quoted ? Number((100 * c.edge5 / c.quoted).toFixed(1)) : null,
      meanEdgeCentsWhenQuoted: c.quoted ? Number((c.edgeSum / c.quoted).toFixed(2)) : null,
      meanVolumeSinceNews: c.quoted ? Number((c.volSum / c.quoted).toFixed(0)) : null,
    }];
  })),
  examples: b.examples,
});

const out = {
  split: SPLIT,
  coverage: res.coverage,
  B1: { discovery: summary(res.B1.discovery), confirm: SHOW_CONFIRM ? summary(res.B1.confirm) : 'hidden' },
  B2: { discovery: summary(res.B2.discovery), confirm: SHOW_CONFIRM ? summary(res.B2.confirm) : 'hidden' },
};
const f = arg('--json', null);
if (f) fs.writeFileSync(f, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
