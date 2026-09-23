// The pitcher edge search: fit M2 on FIT, choose one configuration on
// VALIDATE against real Kalshi prices, touch HOLDOUT once.
//
//   node tools/pitcher-edge.mjs --stage fit      --cache DIR [--out model.json]
//   node tools/pitcher-edge.mjs --stage validate --cache DIR --kcache DIR --model model.json
//   node tools/pitcher-edge.mjs --stage holdout  --cache DIR --kcache DIR --model model.json --weight W
//
// Public MLB Stats API and public Kalshi only; every response is cached on
// disk. Pre-registration, method and results: docs/PITCHER-EDGE-SEARCH.md.

import fs from 'node:fs';
import path from 'node:path';
import { loadRaw, buildStarts, argOf } from './pitcher-data.mjs';
import {
  buildFeatures, fitModel, predictM2, baselineProject, DEFAULT_PARAMS,
  RATE_TERMS, OUTS_TERMS, COND_TERMS, COND_TERMS_ER,
} from './pitcher-fit.mjs';
import {
  kget, readJson, settledMarkets, parseEventTicker, startMsOf, quoteAt,
  summarize, brierDiff, calibrationBins, brierOptimalModelWeight, priceBucket, KALSHI,
} from './kalshi-common.mjs';

export const SPLIT = { FIT_END: '2026-08-09', VAL_START: '2026-08-10', VAL_END: '2026-09-01', HOLD_START: '2026-09-02', HOLD_END: '2026-09-22' };
/** The internal split inside FIT, used to choose hyperparameters. */
export const INNER = { A_END: '2026-06-30' };

export const splitOf = (s) =>
  s.season < 2026 || s.date <= SPLIT.FIT_END ? 'fit'
    : s.date <= SPLIT.VAL_END ? 'val'
      : s.date <= SPLIT.HOLD_END ? 'hold' : 'after';

/** Kalshi pitcher series, and the box-score field each settles on. */
export const SERIES = {
  KXMLBKS: { market: 'k', stat: 'k', label: 'strikeouts' },
  KXMLBOUTS: { market: 'outs', stat: 'outs', label: 'outs recorded' },
  KXMLBHA: { market: 'hits', stat: 'hits', label: 'hits allowed' },
  KXMLBERA: { market: 'er', stat: 'er', label: 'earned runs' },
  KXMLBWA: { market: 'bb', stat: 'bb', label: 'walks' },
};

/** Lines used for outcome-only scoring, roughly the thresholds Kalshi lists. */
export const SCORE_LINES = {
  k: [3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
  outs: [11.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 20.5],
  hits: [2.5, 3.5, 4.5, 5.5, 6.5],
  bb: [0.5, 1.5, 2.5, 3.5],
  er: [0.5, 1.5, 2.5, 3.5, 4.5],
};
const ACTUAL_OF = { k: 'k', outs: 'outs', hits: 'hits', bb: 'bb', er: 'er' };

// ── outcome-only scoring ────────────────────────────────────────────────────
export function scoreOutcomes(starts, indices, project) {
  const out = {};
  for (const m of Object.keys(SCORE_LINES)) out[m] = { n: 0, brier: 0, ll: 0, pred: 0, obs: 0, projSum: 0, actSum: 0, starts: 0 };
  for (const i of indices) {
    const s = starts[i];
    const p = project(i);
    if (!p) continue;
    const projOf = { k: p.projK, outs: p.projOuts, hits: p.projH, bb: p.projBB, er: p.projER };
    for (const m of Object.keys(SCORE_LINES)) {
      const a = s.actual[ACTUAL_OF[m]];
      const r = out[m];
      r.starts++; r.projSum += projOf[m]; r.actSum += a;
      for (const line of SCORE_LINES[m]) {
        const q = Math.min(0.999, Math.max(0.001, p.dist[m](line)));
        const y = a > line ? 1 : 0;
        r.n++; r.brier += (q - y) ** 2; r.ll += -(y ? Math.log(q) : Math.log(1 - q));
        r.pred += q; r.obs += y;
      }
    }
  }
  for (const m of Object.keys(SCORE_LINES)) {
    const r = out[m];
    r.brier /= r.n; r.ll /= r.n; r.pred /= r.n; r.obs /= r.n;
    r.projMean = r.projSum / r.starts; r.actMean = r.actSum / r.starts;
  }
  out.total = Object.keys(SCORE_LINES).reduce((s, m) => s + out[m].ll, 0) / 5;
  return out;
}

// ── dispersion, fitted to the scoring rule rather than to the moments ───────
/**
 * The variance-to-mean ratio of each counting market, chosen on FIT by log
 * loss over the lines Kalshi actually lists. Moment matching gets the centre
 * right and the tails wrong (it has no way to know that the conditional mean
 * itself is uncertain), and the tails are what a 20c contract is.
 */
export function tunePhi(starts, indices, feats, M) {
  const keys = { k: 'phiK', hits: 'phiH', bb: 'phiBB', er: 'phiER' };
  for (const [m, key] of Object.entries(keys)) {
    // Whichever route this market uses is the one whose dispersion matters.
    const bucket = M.route[m] === 'direct' ? 'direct' : 'cond';
    let best = null;
    for (let phi = 0.55; phi <= 2.5001; phi += 0.05) {
      const trial = { ...M, [bucket]: { ...M[bucket], [key]: phi } };
      let ll = 0, n = 0;
      for (const i of indices) {
        const p = predictM2(feats[i], trial);
        const a = starts[i].actual[ACTUAL_OF[m]];
        for (const line of SCORE_LINES[m]) {
          const q = Math.min(0.999, Math.max(0.001, p.dist[m](line)));
          ll += -(a > line ? Math.log(q) : Math.log(1 - q)); n++;
        }
      }
      if (!best || ll / n < best.ll) best = { phi: +phi.toFixed(2), ll: ll / n };
    }
    M[M.route[m] === 'direct' ? 'direct' : 'cond'][key] = best.phi;
  }
  return M;
}

// ── main ────────────────────────────────────────────────────────────────────
const STAGE = argOf('stage', 'fit');
const CACHE = argOf('cache', path.resolve('.work/cache'));
const KCACHE = argOf('kcache', path.resolve('.work/kcache'));
const MODEL_OUT = argOf('out', path.resolve('.work/model.json'));
const MODEL_IN = argOf('model', path.resolve('.work/model.json'));
const DECISION_MIN = Number(argOf('decision-min', 120));
const BOOT = Number(argOf('boot', 20000));
const FEE_RATE = Number(argOf('fee', 0.07));
const JSON_OUT = argOf('json', null);

async function loadAll() {
  const raw = await loadRaw({ cacheDir: CACHE, seasons: [2025, 2026], through: SPLIT.HOLD_END });
  const starts = buildStarts(raw);
  return { raw, starts };
}

// ── stage: fit ──────────────────────────────────────────────────────────────
async function stageFit() {
  const { raw, starts } = await loadAll();
  const all = starts.map((_, i) => i);
  const isFit = (i) => splitOf(starts[i]) === 'fit';
  const innerA = (i) => isFit(i) && (starts[i].season < 2026 || starts[i].date <= INNER.A_END);
  const innerB = (i) => isFit(i) && starts[i].season === 2026 && starts[i].date > INNER.A_END;

  let ROUTE = { k: 'cond', hits: 'cond', bb: 'cond', er: 'direct' };
  const evaluate = (P, route = ROUTE) => {
    const feats = buildFeatures(raw, starts, P);
    const a = all.filter((i) => feats[i] && innerA(i));
    const b = all.filter((i) => feats[i] && innerB(i));
    const M = fitModel(a.map((i) => feats[i]), { route });
    const sc = scoreOutcomes(starts, b, (i) => predictM2(feats[i], M));
    return { ll: sc.total, sc, feats, M, nA: a.length, nB: b.length };
  };

  // Each hyperparameter is scored on the market it actually governs. Scoring
  // everything on one pooled number let a shrinkage strength that wrecked hits
  // buy a tiny gain elsewhere — which is how the first pass drove the
  // hits-allowed pooling to 1,600 BF and flattened that projection to a third
  // of the spread the outcomes carry.
  const GRID = {
    tauRate: [[80, 150, 250, 400, 800], 'total'],
    tauWork: [[20, 35, 55, 90, 160], 'outs'],
    tauOpp: [[100, 200, 400, 800], 'total'],
    tauCtx: [[200, 400, 900], 'total'],
    offDays: [[20, 60, 120, 179], 'total'],
    sK: [[80, 150, 250, 400, 700, 1200], 'k'],
    sBB: [[80, 150, 250, 400, 700, 1200], 'bb'],
    sH: [[80, 150, 250, 400, 700, 1200], 'hits'],
    sHR: [[200, 500, 1000, 2000], 'er'],
    sER: [[200, 500, 1000, 2000], 'er'],
    sHBP: [[300, 600, 1200], 'total'],
    sBat: [[60, 120, 240, 480, 960], 'total'],
    sUmp: [[1000, 3000, 8000, 25000], 'total'],
    sCat: [[1000, 3000, 8000, 25000], 'total'],
  };
  const costOf = (sc, target) => (target === 'total' ? sc.total : sc[target].ll);
  let P = { ...DEFAULT_PARAMS };
  let cur = evaluate(P);
  console.log(`start ll ${cur.ll.toFixed(5)} (fit-A ${cur.nA} starts, fit-B ${cur.nB})`);
  for (let pass = 0; pass < 3; pass++) {
    for (const [key, [values, target]] of Object.entries(GRID)) {
      let bestV = P[key];
      let bestC = costOf(cur.sc, target);
      for (const v of values) {
        if (v === P[key]) continue;
        const r = evaluate({ ...P, [key]: v });
        const c = costOf(r.sc, target);
        if (c < bestC - 1e-7) { bestC = c; bestV = v; }
      }
      if (bestV !== P[key]) { P = { ...P, [key]: bestV }; cur = evaluate(P); }
    }
    console.log(`pass ${pass + 1}: ll ${cur.ll.toFixed(5)}  ${JSON.stringify(P)}`);
  }

  // Depth-conditional or direct, market by market, decided on the inner split.
  for (const m of ['k', 'hits', 'bb', 'er']) {
    const scores = {};
    for (const r of ['cond', 'direct']) scores[r] = evaluate(P, { ...ROUTE, [m]: r }).sc[m].ll;
    ROUTE = { ...ROUTE, [m]: scores.cond <= scores.direct ? 'cond' : 'direct' };
    console.log(`route ${m}: cond ${scores.cond.toFixed(5)} direct ${scores.direct.toFixed(5)} -> ${ROUTE[m]}`);
  }

  // Refit every coefficient on the whole of FIT with the chosen hyperparameters.
  const feats = buildFeatures(raw, starts, P);
  const fitIdx = all.filter((i) => feats[i] && isFit(i));
  let M = fitModel(fitIdx.map((i) => feats[i]), { route: ROUTE });
  M = tunePhi(starts, fitIdx, feats, M);
  M.params = P;

  const base = new Map();
  const report = {};
  for (const [label, pick] of [['FIT', isFit], ['inner-B', innerB]]) {
    const idx = all.filter((i) => feats[i] && pick(i));
    report[label] = {
      n: idx.length,
      m2: scoreOutcomes(starts, idx, (i) => predictM2(feats[i], M)),
      baseline: scoreOutcomes(starts, idx, (i) => baselineProject(raw, starts[i], base)),
    };
  }
  fs.mkdirSync(path.dirname(MODEL_OUT), { recursive: true });
  fs.writeFileSync(MODEL_OUT, JSON.stringify({ params: P, model: M, fitReport: report }, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
  console.log(`\nwrote ${MODEL_OUT}`);
  printCoefs(M);
  for (const [label, r] of Object.entries(report)) printOutcome(label, r);
}

function printCoefs(M) {
  const row = (name, terms, b) => console.log(`${name.padEnd(9)} ${terms.map((t, i) => `${t}=${b[i].toFixed(3)}`).join(' ')}`);
  row('rate K', RATE_TERMS, M.betaK);
  row('rate BB', RATE_TERMS, M.betaBB);
  row('rate H', RATE_TERMS, M.betaH);
  row('outs', OUTS_TERMS, M.betaOuts);
  row('cond K', COND_TERMS, M.cond.k);
  row('cond H', COND_TERMS, M.cond.h);
  row('cond ER', COND_TERMS_ER, M.cond.er);
  const ph = (m, key) => (M.route[m] === 'direct' ? M.direct[key] : M.cond[key]);
  console.log(`gamma ${M.gamma.toFixed(4)}  routes ${JSON.stringify(M.route)}`);
  console.log(`phi k=${ph('k', 'phiK')} hits=${ph('hits', 'phiH')} bb=${ph('bb', 'phiBB')} er=${ph('er', 'phiER')}  cal ${JSON.stringify(M.cal)}`);
}

function printOutcome(label, r) {
  console.log(`\n=== outcomes, ${label} (${r.n} starts) ===`);
  for (const m of Object.keys(SCORE_LINES)) {
    const a = r.m2[m], b = r.baseline[m];
    console.log(
      `${m.padEnd(5)} M2 brier ${a.brier.toFixed(4)} ll ${a.ll.toFixed(4)} mean ${a.projMean.toFixed(2)} vs ${a.actMean.toFixed(2)}` +
      `   shipped brier ${b.brier.toFixed(4)} ll ${b.ll.toFixed(4)} mean ${b.projMean.toFixed(2)}`,
    );
  }
}


// ── Kalshi: matching markets to replayed starts ─────────────────────────────
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
export const normName = (s) => stripAccents(String(s || ''))
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
  .replace(/[^a-z]/g, '');

async function teamAbbrs(season) {
  const file = path.join(CACHE, `teams_${season}.json`);
  let body;
  if (fs.existsSync(file)) body = readJson(file);
  else {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${season}`);
    body = await res.json();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body));
  }
  return new Map(body.teams.map((t) => [t.id, t.abbreviation]));
}

/**
 * 1-minute candles for every pitcher-prop market of one game, over a window
 * that brackets the decision times. The full market lifetime is not needed and
 * costs ~20x the requests (the endpoint caps tickers x minutes at 10,000).
 */
async function gameCandles(seg, tickers, startMs, lookbackMin) {
  const file = path.join(KCACHE, 'candles', `${seg}_${lookbackMin}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const startTs = Math.floor((startMs - lookbackMin * 60e3) / 1000);
  const endTs = Math.floor((startMs + 5 * 60e3) / 1000);
  const perRequest = Math.max(1, Math.floor(10000 / (Math.ceil((endTs - startTs) / 60) + 2)));
  const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));
  const out = {};
  for (let i = 0; i < tickers.length; i += perRequest) {
    const chunk = tickers.slice(i, i + perRequest);
    const body = await kget(`${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=1`);
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [c.end_period_ts, cents(c.yes_bid?.close_dollars), cents(c.yes_ask?.close_dollars)]);
    }
    for (const t of chunk) out[t] ||= [];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/**
 * Every settled pitcher-prop market whose game falls in [from, to], joined to
 * the replayed start it prices and to the decision-time top of book.
 */
export async function priceRows({ raw, starts, from, to, project, lookbackMin = 360 }) {
  const abbr = new Map([...(await teamAbbrs(2026))]);
  for (const [k, v] of await teamAbbrs(2025)) if (!abbr.has(k)) abbr.set(k, v);

  // date -> [{game, key}] so a ticker's "AWYHOM" can be resolved.
  const byDate = new Map();
  for (const g of raw.games.values()) {
    if (g.date < from || g.date > to) continue;
    if (!byDate.has(g.date)) byDate.set(g.date, []);
    byDate.get(g.date).push({ ...g, key: `${abbr.get(g.awayId) || ''}${abbr.get(g.homeId) || ''}` });
  }
  const startsByGame = new Map();
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (!startsByGame.has(s.gamePk)) startsByGame.set(s.gamePk, []);
    startsByGame.get(s.gamePk).push(i);
  }

  const coverage = { marketsInWindow: 0, matched: 0, skip: {}, settleDisagrees: [], quoteAgeMin: [] };
  const bump = (r) => (coverage.skip[r] = (coverage.skip[r] || 0) + 1);
  const bySeg = new Map();
  for (const series of Object.keys(SERIES)) {
    for (const m of await settledMarkets(KCACHE, series)) {
      const p = parseEventTicker(m.event_ticker);
      if (!p || p.date < from || p.date > to) continue;
      coverage.marketsInWindow++;
      const games = (byDate.get(p.date) || []).filter((g) => g.key === p.teams);
      let game = null;
      if (games.length === 1) game = games[0];
      else if (games.length > 1) game = games.find((g) => g.gameNumber === (p.gameNumber || 1)) || null;
      if (!game) { bump(games.length ? 'doubleheader: cannot tell which game' : 'game not on slate'); continue; }
      const idx = (startsByGame.get(game.gamePk) || [])
        .find((i) => normName(starts[i].name) === normName(String(m.title || '').split(':')[0]));
      if (idx == null) { bump('pitcher did not start'); continue; }
      const seg = m.ticker.split('-')[1];
      if (!bySeg.has(seg)) bySeg.set(seg, { p, game, markets: [] });
      bySeg.get(seg).markets.push({ m, series, idx });
    }
  }

  const rows = [];
  let done = 0;
  for (const [seg, g] of [...bySeg].sort()) {
    const startMs = startMsOf(g.p);
    const candles = await gameCandles(seg, g.markets.map((x) => x.m.ticker), startMs, lookbackMin);
    if (++done % 25 === 0) process.stderr.write(`  candles for ${done}/${bySeg.size} games\r`);
    for (const { m, series, idx } of g.markets) {
      const spec = SERIES[series];
      const threshold = Number(m.ticker.split('-').pop());
      if (!Number.isFinite(threshold)) { bump('unparseable threshold'); continue; }
      const sv = Number(m.settlement_value_dollars);
      const settle = Number.isFinite(sv) ? sv : m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null;
      const s = starts[idx];
      if (settle === 0 || settle === 1) {
        const y = s.actual[spec.stat] >= threshold ? 1 : 0;
        if (y !== settle) coverage.settleDisagrees.push(`${m.ticker} settle=${settle} actual=${s.actual[spec.stat]}`);
      }
      const proj = project(idx);
      if (!proj) { bump('no projection'); continue; }
      const model = proj.dist[spec.market](threshold - 0.5);
      const row = { ticker: m.ticker, series, market: spec.market, date: g.p.date, startMs, threshold, model, settle, startIdx: idx, cluster: `${s.id}:${g.p.date}`, candles: candles[m.ticker] || [] };
      rows.push(row);
      coverage.matched++;
    }
  }
  process.stderr.write('\n');
  return { rows, coverage };
}

/** Attach the decision and closing quotes at a given decision time. */
export function quoteRows(rows, decisionMin) {
  const out = [];
  for (const r of rows) {
    const dq = quoteAt(r.candles, r.startMs - decisionMin * 60e3);
    const cq = quoteAt(r.candles, r.startMs);
    out.push({ ...r, dq, cq });
  }
  return out;
}

// ── the pre-registered trade rule ───────────────────────────────────────────
export const RULE = { minEdge: 0.02, minPrice: 15, maxPrice: 90, cap: 0.12 };

const feeOf = (priceCents, rate) => (rate * priceCents * (100 - priceCents)) / 100;

/**
 * One contract per signal, taker at the quoted top of book, one rung per
 * pitcher-start per series. Exactly the rule pre-registered in
 * docs/PITCHER-EDGE-SEARCH.md; `w` is the weight on (model - mid).
 */
export function tradesAt(rows, w, { feeRate = FEE_RATE, rule = RULE } = {}) {
  const best = new Map();
  for (const r of rows) {
    const mid = r.dq.mid / 100;
    if (Math.abs(r.model - mid) > rule.cap) continue;
    const p = mid + w * (r.model - mid);
    const cands = [];
    for (const side of ['yes', 'no']) {
      const priceCents = side === 'yes' ? r.dq.ask : 100 - r.dq.bid;
      if (priceCents < rule.minPrice || priceCents > rule.maxPrice) continue;
      const fee = feeOf(priceCents, feeRate) / 100;
      const edge = (side === 'yes' ? p : 1 - p) - priceCents / 100 - fee;
      if (edge > rule.minEdge) cands.push({ side, priceCents, edge, fee: fee * 100 });
    }
    if (!cands.length) continue;
    const c = cands.sort((a, b) => b.edge - a.edge)[0];
    const key = `${r.cluster}|${r.series}`;
    if (!best.has(key) || c.edge > best.get(key).edge) best.set(key, { r, ...c });
  }
  const trades = [];
  for (const { r, side, priceCents, edge, fee } of best.values()) {
    const yes = side === 'yes';
    const payout = 100 * (yes ? r.settle : 1 - r.settle);
    const midSide = (q) => (q?.mid == null ? null : yes ? q.mid : 100 - q.mid);
    trades.push({
      ticker: r.ticker, series: r.series, market: r.market, date: r.date, cluster: r.cluster,
      side, priceCents, feeCents: fee, pnlCents: payout - priceCents - fee, edge,
      decisionMidSide: midSide(r.dq), closeMidSide: midSide(r.cq), expectedWinSide: priceCents / 100,
      model: yes ? r.model : 1 - r.model,
    });
  }
  return trades;
}

/** Brier of model vs decision mid, paired, with a cluster bootstrap by start. */
export function skill(rows, w = null) {
  const list = rows.map((r) => ({
    cluster: r.cluster, y: r.settle,
    model: Math.min(0.999, Math.max(0.001, r.model)),
    market: Math.min(0.999, Math.max(0.001, r.dq.mid / 100)),
    blend: w == null ? null : Math.min(0.999, Math.max(0.001, r.dq.mid / 100 + w * (r.model - r.dq.mid / 100))),
  }));
  const br = (k) => list.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / list.length;
  return {
    n: list.length,
    modelBrier: br('model'),
    marketBrier: br('market'),
    diff: brierDiff(list, 'model', 'market', { boot: BOOT }),
    blendDiff: w == null ? null : brierDiff(list, 'blend', 'market', { boot: BOOT }),
    optimalWeight: brierOptimalModelWeight(list),
    modelCalibration: calibrationBins(list, 'model'),
    marketCalibration: calibrationBins(list, 'market'),
  };
}

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
function fmtTrades(s) {
  if (!s || !s.n) return 'n=0';
  return `n=${String(s.n).padStart(4)} (${s.clusters} starts)  hit ${(100 * s.hitRate).toFixed(1)}% vs ${(100 * s.breakEvenHit).toFixed(1)}% priced  ` +
    `P&L ${pct(s.pnlPerContractCents, 2)}c/ct  ROI ${pct(s.roiPct)}% [${pct(s.roiCI95[0])}, ${pct(s.roiCI95[1])}]  ` +
    `CLV ${pct(s.clvMidCents, 2)}c`;
}
function fmtSkill(s) {
  return `n=${s.n}  model ${s.modelBrier.toFixed(4)} vs market ${s.marketBrier.toFixed(4)}  ` +
    `diff ${s.diff.point >= 0 ? '+' : ''}${s.diff.point.toFixed(4)} [${s.diff.ci95[0].toFixed(4)}, ${s.diff.ci95[1].toFixed(4)}]  ` +
    `Brier-optimal w ${s.optimalWeight.w}`;
}

async function stagePrices(which) {
  const saved = readJson(MODEL_IN);
  const M = saved.model;
  M.outsTable.table = M.outsTable.table.map((a) => Float64Array.from(a));
  const { raw, starts } = await loadAll();
  const feats = buildFeatures(raw, starts, saved.params);
  const cacheB = new Map();
  const projM2 = (i) => (feats[i] ? predictM2(feats[i], M) : null);
  const projBase = (i) => baselineProject(raw, starts[i], cacheB);

  const from = which === 'holdout' ? SPLIT.HOLD_START : SPLIT.VAL_START;
  const to = which === 'holdout' ? SPLIT.HOLD_END : SPLIT.VAL_END;
  console.log(`\n### ${which.toUpperCase()}  ${from} .. ${to}  decision T-${DECISION_MIN}  fee ${FEE_RATE}`);

  const { rows, coverage } = await priceRows({ raw, starts, from, to, project: projM2 });
  console.log('coverage:', JSON.stringify({ marketsInWindow: coverage.marketsInWindow, matched: coverage.matched, skip: coverage.skip }));
  console.log(`settlement vs box score disagreements: ${coverage.settleDisagrees.length}`, coverage.settleDisagrees.slice(0, 5));

  const q = quoteRows(rows, DECISION_MIN).filter((r) => r.dq?.bid != null && r.dq?.ask != null && (r.settle === 0 || r.settle === 1));
  console.log(`two-sided decision quote and binary settlement: ${q.length} of ${rows.length}`);
  const ages = q.map((r) => Math.round((r.startMs - DECISION_MIN * 60e3 - r.dq.ts * 1000) / 60e3)).sort((a, b) => a - b);
  console.log(`decision quote age (min): median ${ages[Math.floor(ages.length / 2)]}, p90 ${ages[Math.floor(ages.length * 0.9)]}, max ${ages[ages.length - 1]}`);

  // Baseline model probabilities on exactly the same contracts.
  const qBase = q.map((r) => {
    const p = projBase(r.startIdx);
    return { ...r, model: p.dist[r.market](r.threshold - 0.5) };
  });

  const out = { window: { from, to, decisionMin: DECISION_MIN, feeRate: FEE_RATE }, coverage: { ...coverage, settleDisagrees: coverage.settleDisagrees.length } };

  console.log('\n--- forecast skill: model vs decision mid (positive = model worse) ---');
  const slices = [['pooled', null], ...Object.entries(SERIES).map(([k, spec]) => [k + ' ' + spec.label, k])];
  const out2 = { m2: {}, shipped: {} };
  for (const [label, series] of slices) {
    const pick = (list) => (series ? list.filter((r) => r.series === series) : list);
    const a = pick(q), b = pick(qBase);
    if (!a.length) continue;
    const skA = skill(a), skB = skill(b);
    out2.m2[label] = skA; out2.shipped[label] = skB;
    console.log(`${label.padEnd(28)} M2      ${fmtSkill(skA)}`);
    console.log(`${''.padEnd(28)} shipped ${fmtSkill(skB)}`);
  }
  out.skill = out2;

  return { q, qBase, out, slices };
}

/** P&L for one weight, pooled and per market. */
function tradeReport(list, w, label) {
  const trades = tradesAt(list, w);
  const rows = {};
  rows.pooled = summarize(trades, { boot: BOOT });
  for (const [k, spec] of Object.entries(SERIES)) {
    const t = trades.filter((x) => x.series === k);
    if (t.length) rows[k + ' ' + spec.label] = summarize(t, { boot: BOOT });
  }
  if (label) {
    console.log(`\n--- trades, ${label} ---`);
    for (const [k, v] of Object.entries(rows)) console.log(`${k.padEnd(28)} ${fmtTrades(v)}`);
  }
  return { trades, rows };
}

/**
 * Ablation: what each added feature is actually worth, measured on the FIT
 * tail (2026-07-01..08-09) the coefficients were not fitted on. Zeroing a
 * coefficient is the cleanest test — the rest of the model is untouched.
 */
async function stageAblate() {
  const saved = readJson(MODEL_IN);
  const { raw, starts } = await loadAll();
  const all = starts.map((_, i) => i);
  const feats = buildFeatures(raw, starts, saved.params);
  const innerA = all.filter((i) => feats[i] && splitOf(starts[i]) === 'fit' && (starts[i].season < 2026 || starts[i].date <= INNER.A_END));
  const innerB = all.filter((i) => feats[i] && splitOf(starts[i]) === 'fit' && starts[i].season === 2026 && starts[i].date > INNER.A_END);
  const base = fitModel(innerA.map((i) => feats[i]), { route: saved.model.route });
  const zero = (M, idxs) => {
    const c = JSON.parse(JSON.stringify(M));
    for (const b of [c.betaK, c.betaBB, c.betaH, c.betaHR, c.betaHBP]) for (const i of idxs) b[i] = 0;
    return c;
  };
  const RT = RATE_TERMS;
  const cases = {
    'full model': base,
    'no umpire': zero(base, [RT.indexOf('ump')]),
    'no catcher': zero(base, [RT.indexOf('catcher')]),
    'no umpire or catcher': zero(base, [RT.indexOf('ump'), RT.indexOf('catcher')]),
    'no lineup handedness': zero(base, [RT.indexOf('platoon')]),
    'no temperature': zero(base, [RT.indexOf('temp')]),
    'no opponent at all': zero(base, [RT.indexOf('oppK'), RT.indexOf('oppBB'), RT.indexOf('oppH')]),
    'no home/away': zero(base, [RT.indexOf('home')]),
  };
  console.log(`ablation on the fit tail, ${innerB.length} starts (coefficients fitted on the ${innerA.length} before it)`);
  const head = ['k', 'outs', 'hits', 'bb', 'er'];
  console.log(`${''.padEnd(24)} ${head.map((h) => h.padStart(8)).join(' ')}   total`);
  for (const [label, M] of Object.entries(cases)) {
    const sc = scoreOutcomes(starts, innerB, (i) => predictM2(feats[i], M));
    console.log(`${label.padEnd(24)} ${head.map((h) => sc[h].ll.toFixed(4).padStart(8)).join(' ')}   ${sc.total.toFixed(5)}`);
  }
}

async function stageValidate() {
  const { q, qBase, out } = await stagePrices('validate');

  console.log('\n--- ROI by weight on (model - mid), M2 ---');
  const byW = {};
  for (let w = 0; w <= 1.0001; w += 0.1) {
    const key = w.toFixed(1);
    const { rows } = tradeReport(q, +key, null);
    byW[key] = rows;
    console.log(`w=${key}  ${fmtTrades(rows.pooled)}`);
  }
  out.byWeight = byW;

  console.log('\n--- ROI by weight, shipped model, same contracts ---');
  const byWBase = {};
  for (let w = 0; w <= 1.0001; w += 0.1) {
    const key = w.toFixed(1);
    const { rows } = tradeReport(qBase, +key, null);
    byWBase[key] = rows;
    console.log(`w=${key}  ${fmtTrades(rows.pooled)}`);
  }
  out.byWeightBaseline = byWBase;

  for (const w of [0.3, 0.5, 1.0]) tradeReport(q, w, `M2, w=${w}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
}

async function stageHoldout() {
  const W = Number(argOf('weight', NaN));
  if (!Number.isFinite(W)) throw new Error('--weight is required for the holdout run (the value chosen on VALIDATE)');
  const { q, out } = await stagePrices('holdout');
  console.log(`\nchosen weight w=${W} (fixed on VALIDATE)`);
  const { rows } = tradeReport(q, W, `M2, w=${W}, HOLDOUT`);
  out.holdoutTrades = rows;
  out.weight = W;
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
}

const IS_MAIN = process.argv[1] && path.basename(process.argv[1]) === 'pitcher-edge.mjs';
if (IS_MAIN) {
  if (STAGE === 'fit') await stageFit();
  else if (STAGE === 'validate') await stageValidate();
  else if (STAGE === 'holdout') await stageHoldout();
  else if (STAGE === 'ablate') await stageAblate();
  else throw new Error(`unknown --stage ${STAGE}`);
}
