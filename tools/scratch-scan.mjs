// docs/SCRATCH-SETTLEMENT-STUDY.md: is there an implementable trade in a
// scratched player's cancelled market?
//
// The rule tested here never conditions on the market having been cancelled.
// It conditions only on a fact the MLB StatsAPI had already published at the
// moment of the trade: the announced starting lineup does not contain the
// player this contract is about. Markets on players who were absent from the
// lineup and then pinch-hit settle yes/no like any other and their P&L is in
// here too.
//
//   node tools/scratch-scan.mjs --kcache ecache --split 2026-09-01 [--confirm]
//
// Kalshi public API and the public MLB StatsAPI only. No auth, no orders, and
// The Odds API is never called.

import fs from 'node:fs';
import path from 'node:path';
import { parseEventTicker, startMsOf, readJson, roiStats, benjaminiHochberg } from './kalshi-common.mjs';
import { arg } from './market-edge.mjs';

// Only act as a CLI when this file is the process entry point: the diagnostics
// import it, and importing it must not run the scan.
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const KCACHE = arg('--kcache', 'ecache');
const SPLIT = arg('--split', '2026-09-01');
const FEE_RATE = Number(arg('--fee-rate', '0.07'));
const SHOW_CONFIRM = process.argv.includes('--confirm');

// Player series only. The four game-level series never settle scalar.
export const PLAYER_SERIES = ['KXMLBKS', 'KXMLBOUTS', 'KXMLBHIT', 'KXMLBTB', 'KXMLBHR', 'KXMLBRBI', 'KXMLBHRR'];

// ── money (identical to tools/edge-scan.mjs; copied rather than imported
// because that file runs its whole analysis at import time). The statistics
// it used to copy too now live in kalshi-common.mjs. ───────────────────────
export const feeCents = (priceCents, rate = FEE_RATE) => (rate * priceCents * (100 - priceCents)) / 100;
const settleValue = (m) => Number(m.settlement_value_dollars);
const payoutCents = (m, side) => (side === 'yes' ? 100 * settleValue(m) : 100 * (1 - settleValue(m)));

function trade(m, side, priceCents, cluster, extra = {}) {
  const fee = feeCents(priceCents);
  return { cluster, cost: priceCents + fee, pnl: payoutCents(m, side) - priceCents - fee, priceCents, ...extra };
}

export { roiStats, benjaminiHochberg };

// ── names ───────────────────────────────────────────────────────────────────
export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// ── joins ───────────────────────────────────────────────────────────────────
const lineupFile = (pk) => path.join(KCACHE, 'lineup', `${pk}.json`);
const schedFile = (d) => path.join(KCACHE, 'sched2', `${d}.json`);

/** date -> Map('AWAYHOME' + optional game number -> lineup record). */
export function lineupIndex(dates) {
  const byDate = new Map();
  for (const d of dates) {
    if (!fs.existsSync(schedFile(d))) continue;
    const games = readJson(schedFile(d)).dates?.[0]?.games || [];
    const m = new Map();
    for (const g of games) {
      if (!fs.existsSync(lineupFile(g.gamePk))) continue;
      const lu = readJson(lineupFile(g.gamePk));
      if (!lu.away || !lu.home) continue;
      lu.gameNumber = g.gameNumber || 1;
      lu.gameDate = g.gameDate;
      // A postponed game is played the next day, so its feed archive - and
      // therefore the only lineup timestamp this study can prove - lands a day
      // after the scheduled first pitch. Kalshi cancels the props either way.
      lu.postponed = /postponed/i.test(g.status?.detailedState || '');
      const k = `${lu.away}${lu.home}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(lu);
    }
    byDate.set(d, m);
  }
  return byDate;
}

/** The ids StatsAPI had already announced as starting, at the first archived timecode. */
export function announcedStarters(lu) {
  const s = new Set([...(lu.announced.away.battingOrder || []), ...(lu.announced.home.battingOrder || [])]);
  for (const side of ['away', 'home']) {
    const p = lu.announcedProbables?.[side];
    if (p?.id) s.add(p.id);
  }
  return s;
}

/** Top of book at or before `ms`, from 1-minute candles. */
export function quoteAtMin(c, ms) {
  const ts = ms / 1000;
  let q = null;
  for (const x of c || []) { if (x[0] > ts) break; q = x; }
  if (!q) return null;
  return { ts: q[0], bid: q[1] > 0 ? q[1] : null, ask: q[2] != null && q[2] < 100 ? q[2] : null, last: q[4] };
}

// ── the universe, built without ever looking at how a market settled ────────
/**
 * Every listed player-prop market whose player was NOT in the starting lineup
 * StatsAPI had already published. `result` is attached for scoring afterwards
 * but is never used to decide membership.
 */
export function buildUniverse() {
  const markets = [];
  for (const s of PLAYER_SERIES) {
    const f = path.join(KCACHE, `settled_${s}.json`);
    if (!fs.existsSync(f)) continue;
    for (const m of readJson(f).markets) markets.push({ ...m, series: s });
  }
  const dates = [...new Set(markets.map((m) => parseEventTicker(m.event_ticker)?.date).filter(Boolean))].sort();
  const idx = lineupIndex(dates);
  const cov = { markets: markets.length, noEvent: 0, noGame: 0, noName: 0, ambiguous: 0, matched: 0, starters: 0, candidates: 0, noTimecode: 0 };
  const out = [];
  const lookupCache = new Map();
  for (const m of markets) {
    const p = parseEventTicker(m.event_ticker);
    if (!p) { cov.noEvent++; continue; }
    const games = idx.get(p.date)?.get(p.teams);
    if (!games || !games.length) { cov.noGame++; continue; }
    const lu = games.length === 1 ? games[0] : games.find((g) => g.gameNumber === (p.gameNumber || 1)) || null;
    if (!lu) { cov.noGame++; continue; }
    if (!lu.firstTimecodeMs) { cov.noTimecode++; continue; }
    // name -> id, per game, ambiguity counted rather than guessed
    let nameMap = lookupCache.get(lu.gamePk);
    if (!nameMap) {
      nameMap = new Map();
      for (const [id, full] of Object.entries(lu.names || {})) {
        const k = norm(full);
        if (nameMap.has(k)) nameMap.set(k, 'AMBIGUOUS');
        else nameMap.set(k, Number(id));
      }
      lookupCache.set(lu.gamePk, nameMap);
    }
    const nm = norm(String(m.yes_sub_title || '').split(':')[0]);
    const id = nameMap.get(nm);
    if (id === 'AMBIGUOUS') { cov.ambiguous++; continue; }
    if (id == null) { cov.noName++; continue; }
    cov.matched++;
    let starters = lu._starters;
    if (!starters) { starters = announcedStarters(lu); lu._starters = starters; }
    if (starters.has(id)) { cov.starters++; continue; }
    cov.candidates++;
    out.push({
      market: m, series: m.series, event: m.event_ticker, date: p.date,
      gamePk: lu.gamePk, playerId: id, name: String(m.yes_sub_title || '').split(':')[0],
      firstPitchMs: startMsOf(p),
      newsMs: lu.firstTimecodeMs,
      closeMs: Date.parse(m.close_time),
      cluster: `${lu.gamePk}|${id}`,
      postponed: !!lu.postponed,
    });
  }
  return { rows: out, coverage: cov, dates };
}

if (IS_MAIN && process.argv[2] === 'candidates') {
  const { rows, coverage } = buildUniverse();
  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event)) byEvent.set(r.event, { event: r.event, firstPitchMs: r.firstPitchMs, tickers: [] });
    byEvent.get(r.event).tickers.push(r.market.ticker);
  }
  const f = arg('--out', path.join(KCACHE, '_candidates.json'));
  fs.writeFileSync(f, JSON.stringify({ coverage, events: [...byEvent.values()] }));
  console.log(JSON.stringify({ coverage, events: byEvent.size, markets: rows.length }, null, 1));
}

// ── the pre-registered rules ────────────────────────────────────────────────
// Six entry times x two directions = twelve scored tests. `news` is the wall
// clock of the first archived StatsAPI timecode for that game, which is the
// earliest moment this study can PROVE the lineup was public; every other
// entry time is clamped to be no earlier than it, so no rule ever trades on
// information it cannot show was published.
export const ENTRIES = [
  ['news', null], ['fp-60', -60], ['fp-30', -30], ['fp+0', 0], ['fp+30', 30], ['fp+60', 60],
];
export const entryMs = (r, off) => (off == null ? r.newsMs : Math.max(r.newsMs, r.firstPitchMs + off * 60e3));

const pct = (a, b) => (b ? Number((100 * a / b).toFixed(1)) : null);
const quantiles = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => Number(s[Math.floor(p * (s.length - 1))].toFixed(1));
  return { n: s.length, min: q(0), p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: q(1), mean: Number((s.reduce((x, y) => x + y, 0) / s.length).toFixed(2)) };
};

export function run() {
  const { rows, coverage, dates } = buildUniverse();
  const candles = new Map();
  const getC = (event) => {
    if (!candles.has(event)) {
      const f = path.join(KCACHE, 'm1', `${event}.json`);
      candles.set(event, fs.existsSync(f) ? readJson(f) : {});
    }
    return candles.get(event);
  };

  const tests = {};
  for (const [name] of ENTRIES) tests[`${name}|yes`] = { discovery: [], confirm: [] };
  for (const [name] of ENTRIES) tests[`${name}|no`] = { discovery: [], confirm: [] };
  const quoted = Object.fromEntries(ENTRIES.map(([n]) => [n, { open: 0, twoSided: 0, askOnly: 0, bidOnly: 0, none: 0, spreads: [] }]));
  // Three POST-HOC arms, chosen after the discovery pass and labelled as such.
  // They are not among the twelve and they do not enter the correction; they
  // exist because the pre-registered rule's whole loss turned out to sit in a
  // tail of quotes that were hours old.
  const post = { S0: { discovery: [], confirm: [] }, S1: { discovery: [], confirm: [] }, S2: { discovery: [], confirm: [] } };
  const postCount = { ok: 0, postponed: 0 };

  // descriptive, not scored
  const desc = {
    newsToFirstPitchMin: [], newsToCloseMin: [], closeToFirstPitchMin: [],
    midBeforeNews: [], midAfterNews: [], settleMinusMidAtNews: [], settleMinusAskAtNews: [],
    settleMinusLastTwoSidedMid: [], settleMinusLastTwoSidedAsk: [], settleMinusLastTwoSidedBid: [],
    lastTwoSidedToCloseMin: [], volumeAfterNews: [],
  };
  const resultMix = {};

  for (const r of rows) {
    const w = r.date <= SPLIT ? 'discovery' : 'confirm';
    const c = getC(r.event)[r.market.ticker];
    resultMix[r.market.result] = (resultMix[r.market.result] || 0) + 1;
    desc.newsToFirstPitchMin.push((r.firstPitchMs - r.newsMs) / 60000);
    desc.newsToCloseMin.push((r.closeMs - r.newsMs) / 60000);
    desc.closeToFirstPitchMin.push((r.closeMs - r.firstPitchMs) / 60000);
    if (!c || !c.length) continue;

    // what the quote did across the news
    const before = quoteAtMin(c, r.newsMs - 60e3);
    const after = quoteAtMin(c, r.newsMs + 30 * 60e3);
    if (before?.bid != null && before?.ask != null) desc.midBeforeNews.push((before.bid + before.ask) / 2);
    if (after?.bid != null && after?.ask != null) desc.midAfterNews.push((after.bid + after.ask) / 2);
    const sv = 100 * Number(r.market.settlement_value_dollars);
    const atNews = quoteAtMin(c, r.newsMs);
    if (r.market.result === 'scalar' && atNews?.bid != null && atNews?.ask != null) {
      desc.settleMinusMidAtNews.push(sv - (atNews.bid + atNews.ask) / 2);
      desc.settleMinusAskAtNews.push(sv - atNews.ask);
    }
    // the LAST two-sided quote before the market closed
    let last = null;
    for (const x of c) {
      if (x[0] * 1000 > r.closeMs) break;
      if (x[1] > 0 && x[2] != null && x[2] < 100) last = x;
    }
    if (last && r.market.result === 'scalar') {
      desc.settleMinusLastTwoSidedMid.push(sv - (last[1] + last[2]) / 2);
      desc.settleMinusLastTwoSidedAsk.push(sv - last[2]);
      desc.settleMinusLastTwoSidedBid.push(sv - last[1]);
      desc.lastTwoSidedToCloseMin.push((r.closeMs - last[0] * 1000) / 60000);
    }
    let vol = 0;
    for (const x of c) if (x[0] * 1000 > r.newsMs && x[0] * 1000 <= r.closeMs) vol += x[3];
    desc.volumeAfterNews.push(vol);

    for (const [name, off] of ENTRIES) {
      const T = entryMs(r, off);
      if (T >= r.closeMs) continue;
      const cell = quoted[name];
      cell.open++;
      const q = quoteAtMin(c, T);
      if (!q) { cell.none++; continue; }
      if (q.bid != null && q.ask != null) { cell.twoSided++; cell.spreads.push(q.ask - q.bid); }
      else if (q.ask != null) { cell.askOnly++; continue; }
      else if (q.bid != null) { cell.bidOnly++; continue; }
      else { cell.none++; continue; }
      const extra = { series: r.series, ticker: r.market.ticker, date: r.date, spread: q.ask - q.bid, result: r.market.result };
      if (name === 'news') {
        const ageMin = (T - q.ts * 1000) / 60000;
        if (q.ask >= 1 && q.ask <= 99) {
          if (!r.postponed) post.S0[w].push(trade(r.market, 'yes', q.ask, r.cluster, extra));
          if (ageMin < 60) post.S1[w].push(trade(r.market, 'yes', q.ask, r.cluster, extra));
          if (ageMin < 60 && q.ask - q.bid <= 2) post.S2[w].push(trade(r.market, 'yes', q.ask, r.cluster, extra));
        }
        postCount[r.postponed ? 'postponed' : 'ok']++;
      }
      if (q.ask >= 1 && q.ask <= 99) tests[`${name}|yes`][w].push(trade(r.market, 'yes', q.ask, r.cluster, extra));
      const noPrice = 100 - q.bid;
      if (noPrice >= 1 && noPrice <= 99) tests[`${name}|no`][w].push(trade(r.market, 'no', noPrice, r.cluster, extra));
    }
  }

  const scored = [];
  for (const [name] of ENTRIES) {
    for (const side of ['yes', 'no']) {
      const t = tests[`${name}|${side}`];
      scored.push({
        id: `${name}|${side}`,
        label: `at ${name}, buy ${side.toUpperCase()} at the ask on every market whose player is not in the announced lineup`,
        discovery: roiStats(t.discovery),
        confirm: roiStats(t.confirm),
        trades: t,
      });
    }
  }
  const ps = scored.map((s) => s.discovery.p ?? 1);
  const bh = benjaminiHochberg(ps, 0.10);
  scored.forEach((s, i) => { s.survivesBH = bh.has(i); s.survivesBonferroni = (s.discovery.p ?? 1) <= 0.05 / scored.length; });

  const postHoc = [
    ['S0', 'POST-HOC: at news, buy YES at the ask, excluding postponed games'],
    ['S1', 'POST-HOC: at news, buy YES at the ask, quote less than 60 min old'],
    ['S2', 'POST-HOC: at news, buy YES at the ask, quote < 60 min old and spread <= 2c'],
  ].map(([id, label]) => ({ id, label, discovery: roiStats(post[id].discovery), confirm: roiStats(post[id].confirm), trades: post[id] }));

  return {
    split: SPLIT, feeRate: FEE_RATE, dates: dates.length,
    postponedCandidates: postCount,
    postHoc,
    coverage, resultMix,
    quoteAvailability: Object.fromEntries(ENTRIES.map(([n]) => {
      const c = quoted[n];
      return [n, { marketsStillOpen: c.open, twoSidedQuote: c.twoSided, twoSidedPct: pct(c.twoSided, c.open), askOnly: c.askOnly, bidOnly: c.bidOnly, noQuote: c.none, spreadCents: quantiles(c.spreads) }];
    })),
    descriptive: Object.fromEntries(Object.entries(desc).map(([k, v]) => [k, quantiles(v)])),
    multiplicity: { tests: scored.length, bhQ: 0.10, bonferroniAlpha: 0.05 / scored.length, survivors: scored.filter((s) => s.survivesBH).map((s) => s.id) },
    tests: scored,
  };
}

if (IS_MAIN && (!process.argv[2] || process.argv[2] === 'scan')) {
  const res = run();
  const fmt = (s) => (!s || !s.n ? 'n=0' : `n=${s.n} g=${s.games} roi=${s.roiPct.toFixed(2)}% [${s.ci95[0].toFixed(2)}, ${s.ci95[1].toFixed(2)}] p=${s.p.toFixed(4)} pnl/c=${s.pnlPerContract.toFixed(2)}c tot=${(s.totalPnlCents / 100).toFixed(2)}$`);
  const out = {
    ...res,
    tests: res.tests.map((t) => ({ id: t.id, d: fmt(t.discovery), c: SHOW_CONFIRM ? fmt(t.confirm) : 'hidden', bh: t.survivesBH, bonf: t.survivesBonferroni })),
    postHoc: res.postHoc.map((t) => ({ id: t.id, label: t.label, d: fmt(t.discovery), c: SHOW_CONFIRM ? fmt(t.confirm) : 'hidden' })),
  };
  const f = arg('--json', null);
  if (f) {
    const strip = (t) => { const { trades, ...rest } = t; return { ...rest, confirm: SHOW_CONFIRM ? t.confirm : 'hidden' }; };
    fs.writeFileSync(f, JSON.stringify({ ...res, tests: res.tests.map(strip), postHoc: res.postHoc.map(strip) }, null, 1));
  }
  console.log(JSON.stringify(out, null, 1));
}
