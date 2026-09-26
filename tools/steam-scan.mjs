// Does following a price move pay? The 26 pre-registered tests of
// docs/STEAM-STUDY.md.
//
// No model, no forecast: every rule is a function of Kalshi's own quotes, the
// scheduled first pitch in the event ticker, and Kalshi's own settlement value.
// Prices are taker prices — YES costs the yes ask, NO costs 100 - yes bid — and
// the fee is charged on every leg.
//
//   node tools/steam-scan.mjs --kcache <dir> --split 2026-09-01 [--confirm] [--json out.json]
//
// --split is the last game date of the DISCOVERY window; everything after it is
// the confirmation window and is not printed without --confirm.
//
// The cache is read only. It is the 1-minute candlestick archive three earlier
// studies already built (`candles/`, `candles-bat/`, `candles-game/`), so this
// study makes no network request at all.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, parseEventTicker, startMsOf, quoteAt, roiStats, benjaminiHochberg } from './kalshi-common.mjs';

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const KCACHE = arg('--kcache', 'ecache');
const SPLIT = arg('--split', '2026-09-01');
const FEE_RATE = Number(arg('--fee-rate', '0.07'));
const SHOW_CONFIRM = process.argv.includes('--confirm');

// ── money ───────────────────────────────────────────────────────────────────
/** src/trade/fees.js, unrounded: 0.07 * P * (1-P) per contract, in cents. */
const feeCents = (priceCents) => (FEE_RATE * priceCents * (100 - priceCents)) / 100;
const payoutCents = (m, side) => {
  const v = 100 * Number(m.settlement_value_dollars);
  return side === 'yes' ? v : 100 - v;
};

// ── the universe ────────────────────────────────────────────────────────────
// Three contract classes, three candle directories. Every archive stops at the
// scheduled first pitch, which is why no in-game price can enter this study.
const CLASSES = {
  GAME: { dir: 'candles-game', series: ['KXMLBGAME', 'KXMLBSPREAD', 'KXMLBTOTAL', 'KXMLBRFI'] },
  PITCH: { dir: 'candles', series: ['KXMLBKS', 'KXMLBOUTS'] },
  BAT: { dir: 'candles-bat', series: ['KXMLBHIT', 'KXMLBTB', 'KXMLBHR', 'KXMLBRBI', 'KXMLBHRR'] },
};

// The two pre-registered windows, plus one late reference arm. `look` is how
// far back the move is measured from `decide`; both are minutes before T.
const WINDOWS = {
  F: { look: 40, decide: 30, label: '10-minute move, T-40 -> T-30' },
  S: { look: 90, decide: 30, label: '60-minute move, T-90 -> T-30' },
  L: { look: 15, decide: 5, label: '10-minute move, T-15 -> T-5 (reference)' },
};

/** 1-2c is the noise arm and is not one of the 26 tests. */
const bucketOf = (d) => {
  const a = Math.abs(d);
  if (a < 1) return null;
  if (a < 3) return 'R0';
  if (a < 5) return 'B1';
  if (a < 8) return 'B2';
  if (a < 13) return 'B3';
  return 'B4';
};

function loadMarkets() {
  const by = new Map();
  for (const [cls, cfg] of Object.entries(CLASSES)) {
    for (const s of cfg.series) {
      const f = path.join(KCACHE, `settled_${s}.json`);
      if (!fs.existsSync(f)) { process.stderr.write(`  no ${f}\n`); continue; }
      for (const m of readJson(f).markets) by.set(m.ticker, { ...m, series: s, cls });
    }
  }
  return by;
}

/**
 * One observation per (market, window): the move into the decision clock, the
 * taker prices at the decision and at first pitch, and the settlement.
 */
function observations(markets) {
  const rows = [];
  const cov = {};
  for (const [cls, cfg] of Object.entries(CLASSES)) {
    const dir = path.join(KCACHE, cfg.dir);
    if (!fs.existsSync(dir)) continue;
    const c = cov[cls] = { events: 0, markets: 0, scalar: 0, unmatched: 0, quoted: {} };
    for (const file of fs.readdirSync(dir)) {
      const seg = file.replace('.json', '');
      const p = parseEventTicker(`X-${seg}`);
      if (!p) continue;
      const T = startMsOf(p);
      const raw = readJson(path.join(dir, file));
      const candles = raw.candles || raw;
      c.events++;
      for (const [ticker, cd] of Object.entries(candles)) {
        const m = markets.get(ticker);
        if (!m) { c.unmatched++; continue; }
        c.markets++;
        // A cancelled player settles `scalar`. That cancellation IS the news
        // event this study must not rediscover, and there is no binary outcome
        // to tail, so the market is dropped outright.
        if (m.result !== 'yes' && m.result !== 'no') { c.scalar++; continue; }
        const at = (mins) => {
          const q = quoteAt(cd, T - mins * 60e3);
          return q && q.bid != null && q.ask != null ? q : null;
        };
        const close = at(0);
        if (!close) continue;
        for (const [w, cfg2] of Object.entries(WINDOWS)) {
          const a = at(cfg2.look);
          const b = at(cfg2.decide);
          if (!a || !b) continue;
          const d = b.mid - a.mid;
          const bucket = bucketOf(d);
          if (!bucket) continue;
          const side = d > 0 ? 'yes' : 'no';
          const price = side === 'yes' ? b.ask : 100 - b.bid;
          const out = side === 'yes' ? close.bid : 100 - close.ask;
          c.quoted[w] = (c.quoted[w] || 0) + 1;
          rows.push({
            cluster: m.event_ticker,
            date: p.date,
            cls,
            series: m.series,
            w,
            bucket,
            move: d,
            side,
            price,
            exit: out,
            spread: b.ask - b.bid,
            fwd: Math.sign(d) * (close.mid - b.mid),
            volume: m.volume_fp == null ? null : Number(m.volume_fp),
            payYes: payoutCents(m, 'yes'),
          });
        }
      }
    }
  }
  return { rows, cov };
}

// ── trades ──────────────────────────────────────────────────────────────────
const pay = (r, side) => (side === 'yes' ? r.payYes : 100 - r.payYes);

/** Hold to settlement: one fee, one leg. `flip` inverts the side (fade arm). */
function holdTrade(r, flip = false) {
  const side = flip ? (r.side === 'yes' ? 'no' : 'yes') : r.side;
  const price = flip ? 100 - r.price : r.price;
  const fee = feeCents(price);
  return { cluster: r.cluster, cost: price + fee, pnl: pay(r, side) - price - fee, price };
}

/** Round trip: in at the decision clock, out at first pitch. Two fees. */
function flipTrade(r) {
  const fin = feeCents(r.price);
  const fout = feeCents(r.exit);
  return { cluster: r.cluster, cost: r.price + fin, pnl: r.exit - r.price - fin - fout, price: r.price };
}

// ── the pre-registered tests ────────────────────────────────────────────────
const BUCKETS = ['B1', 'B2', 'B3', 'B4'];
const BLABEL = { R0: '1-2c', B1: '3-4c', B2: '5-7c', B3: '8-12c', B4: '13c+' };

const TESTS = [];
for (const w of ['F', 'S']) {
  for (const b of BUCKETS) {
    TESTS.push({
      id: `H${TESTS.length + 1}`,
      label: `HOLD to settlement, ${WINDOWS[w].label}, |move| ${BLABEL[b]}`,
      pick: (r) => r.w === w && r.bucket === b,
      make: holdTrade,
    });
  }
}
for (const w of ['F', 'S']) {
  for (const b of BUCKETS) {
    TESTS.push({
      id: `F${TESTS.length - 7}`,
      label: `FLIP out at first pitch, ${WINDOWS[w].label}, |move| ${BLABEL[b]}`,
      pick: (r) => r.w === w && r.bucket === b,
      make: flipTrade,
    });
  }
}
let ci = 0;
for (const w of ['F', 'S']) {
  for (const cls of ['GAME', 'PITCH', 'BAT']) {
    TESTS.push({
      id: `C${++ci}`,
      label: `HOLD, ${WINDOWS[w].label}, |move| >= 5c, ${cls}`,
      pick: (r) => r.w === w && r.cls === cls && Math.abs(r.move) >= 5,
      make: holdTrade,
    });
  }
}
let li = 0;
for (const [mk, nm] of [[holdTrade, 'HOLD'], [flipTrade, 'FLIP']]) {
  for (const [lab, ok] of [['spread <= 2c', (r) => r.spread <= 2], ['spread >= 3c', (r) => r.spread >= 3]]) {
    TESTS.push({
      id: `L${++li}`,
      label: `${nm}, ${WINDOWS.F.label}, |move| >= 5c, ${lab}`,
      pick: (r) => r.w === 'F' && Math.abs(r.move) >= 5 && ok(r),
      make: mk,
    });
  }
}

// Reference arms. Not among the 26, never corrected, reported so the sign of
// the 26 can be read: the noise bucket, the fade side, and the late window.
const REFS = [
  { id: 'R0f', label: `HOLD, ${WINDOWS.F.label}, |move| 1-2c (noise arm)`, pick: (r) => r.w === 'F' && r.bucket === 'R0', make: holdTrade },
  { id: 'R0s', label: `HOLD, ${WINDOWS.S.label}, |move| 1-2c (noise arm)`, pick: (r) => r.w === 'S' && r.bucket === 'R0', make: holdTrade },
  { id: 'RFADEf', label: `HOLD the OPPOSITE side, ${WINDOWS.F.label}, |move| >= 5c`, pick: (r) => r.w === 'F' && Math.abs(r.move) >= 5, make: (r) => holdTrade(r, true) },
  { id: 'RFADEs', label: `HOLD the OPPOSITE side, ${WINDOWS.S.label}, |move| >= 5c`, pick: (r) => r.w === 'S' && Math.abs(r.move) >= 5, make: (r) => holdTrade(r, true) },
  { id: 'RLATEh', label: `HOLD, ${WINDOWS.L.label}, |move| >= 5c`, pick: (r) => r.w === 'L' && Math.abs(r.move) >= 5, make: holdTrade },
  { id: 'RLATEf', label: `FLIP, ${WINDOWS.L.label}, |move| >= 5c`, pick: (r) => r.w === 'L' && Math.abs(r.move) >= 5, make: flipTrade },
];

// ── run ─────────────────────────────────────────────────────────────────────
const markets = loadMarkets();
process.stderr.write(`${markets.size} settled markets indexed\n`);
const { rows, cov } = observations(markets);
process.stderr.write(`${rows.length} observations\n`);

const inDiscovery = (r) => r.date <= SPLIT;
const score = (t) => {
  const d = rows.filter((r) => inDiscovery(r) && t.pick(r));
  const c = rows.filter((r) => !inDiscovery(r) && t.pick(r));
  const stat = (set) => {
    const s = roiStats(set.map(t.make));
    if (!s.n) return s;
    s.avgMove = set.reduce((x, r) => x + Math.abs(r.move), 0) / set.length;
    s.avgSpread = set.reduce((x, r) => x + r.spread, 0) / set.length;
    s.avgPrice = set.reduce((x, r) => x + r.price, 0) / set.length;
    // Descriptive, cost-free: does the price keep moving, and does it settle
    // that way? `fwdMove` is the signed mid change from the decision clock to
    // first pitch; `settleRate` is how often the tailed side won outright.
    s.fwdMoveCents = set.reduce((x, r) => x + r.fwd, 0) / set.length;
    s.settleRate = set.filter((r) => pay(r, r.side) > 50).length / set.length;
    return s;
  };
  return { id: t.id, label: t.label, discovery: stat(d), confirm: SHOW_CONFIRM ? stat(c) : 'hidden' };
};

const results = { split: SPLIT, feeRate: FEE_RATE, coverage: cov, tests: TESTS.map(score), refs: REFS.map(score) };

// Descriptive liquidity, by class: how much these contracts actually trade.
results.liquidity = Object.fromEntries(Object.keys(CLASSES).map((cls) => {
  const set = rows.filter((r) => r.w === 'F' && r.cls === cls);
  const vols = set.map((r) => r.volume).filter((v) => v != null).sort((a, b) => a - b);
  const sp = set.map((r) => r.spread).sort((a, b) => a - b);
  return [cls, {
    n: set.length,
    medianSpread: sp.length ? sp[sp.length >> 1] : null,
    pctSpreadLE2: sp.length ? sp.filter((x) => x <= 2).length / sp.length : null,
    volumeKnown: vols.length,
    pctZeroVolume: vols.length ? vols.filter((v) => v === 0).length / vols.length : null,
    medianVolume: vols.length ? vols[vols.length >> 1] : null,
  }];
}));

// Move-size census: how often each bucket even fires.
results.census = {};
for (const w of Object.keys(WINDOWS)) {
  const set = rows.filter((r) => r.w === w);
  results.census[w] = Object.fromEntries(['R0', ...BUCKETS].map((b) => [b, set.filter((r) => r.bucket === b).length]));
}

const K = TESTS.length;
const ps = results.tests.map((t) => t.discovery.p ?? 1);
const bh = benjaminiHochberg(ps, 0.10);
results.multiplicity = {
  preRegisteredTests: K,
  bonferroniAlpha: 0.05 / K,
  bhQ: 0.10,
  survivors: results.tests.filter((_, i) => bh.has(i)).map((t) => t.id),
};
results.tests.forEach((t, i) => {
  t.survivesBH = bh.has(i);
  t.survivesBonferroni = (t.discovery.p ?? 1) <= 0.05 / K;
});

const fmt = (s) => {
  if (s === 'hidden') return 'hidden';
  if (!s.n) return 'n=0';
  return `n=${s.n} g=${s.games} roi=${s.roiPct.toFixed(2)}% [${s.ci95[0].toFixed(2)}, ${s.ci95[1].toFixed(2)}] p=${s.p.toFixed(4)} `
    + `pnl/c=${s.pnlPerContract.toFixed(2)}c px=${s.avgPrice.toFixed(1)} sprd=${s.avgSpread.toFixed(2)} fwd=${s.fwdMoveCents.toFixed(2)}c win=${(100 * s.settleRate).toFixed(1)}%`;
};
const line = (t) => ({ id: t.id, label: t.label, d: fmt(t.discovery), c: fmt(t.confirm), bh: t.survivesBH, bonf: t.survivesBonferroni });

const outFile = arg('--json', null);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(JSON.stringify({
  split: results.split,
  coverage: results.coverage,
  census: results.census,
  liquidity: results.liquidity,
  tests: results.tests.map(line),
  refs: results.refs.map(line),
  multiplicity: results.multiplicity,
}, null, 1));
