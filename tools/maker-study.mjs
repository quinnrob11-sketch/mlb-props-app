// Would RESTING an order (maker) instead of crossing the spread (taker) have
// turned the bot's losing decisions into winning ones?
//
//   node tools/backtest-kalshi.mjs --from 2026-07-10 --to 2026-09-15 \
//     --cache <statsapi cache> --kcache mcache --json mcache/pitcher-t120.json
//   node tools/maker-study.mjs --decisions mcache/pitcher-t120.json \
//     --kcache mcache [--set bot] [--deadline 0] [--json out.json]
//
// The decision set is NOT rebuilt here. It is read from the JSON that
// `tools/backtest-kalshi.mjs` (and `tools/backtest-kalshi-batters.mjs`) already
// write, so the markets, the model probabilities, the decision time and the
// bot's screen are byte-identical to the published studies. This tool only
// changes what order is assumed to have been sent, and adds a fill model.
//
// Kalshi PUBLIC endpoints only. Every response is cached under --kcache.
//
// Method is pre-registered in docs/KALSHI-MAKER-STUDY.md. In one paragraph:
//
//   * The decision quote's two-sided book is reconstructed exactly from the
//     recorded side / price / mid (integers, asserted).
//   * Three orders are scored on the SAME decisions: taker at the ask with the
//     bot's full fee; maker resting at the best bid on the traded side; maker
//     one tick inside it. Maker fills are charged no fee by default, because
//     every one of these series reports fee_type "quadratic" rather than
//     "quadratic_with_maker_fees"; --maker-fee-rate re-charges them.
//   * A resting order at P fills if a later 1-minute candle before the deadline
//     prints a trade at or through P with at least `--min-volume` contracts.
//     This OVERSTATES fills: it ignores the queue in front of us. The
//     overstatement is bounded from the other side by the "queue-cleared" rule,
//     which requires the print to be strictly THROUGH P — which cannot happen
//     while anything rests at P, so it is a fill we would certainly have got.
//   * Unfilled decisions earn $0 and still consume capital, so ROI is reported
//     both on filled trades and over all decisions.
//   * 95% intervals are cluster bootstraps over GAMES.

import fs from 'node:fs';
import path from 'node:path';
import { kget, readJson, parseEventTicker, startMsOf, mulberry32, KALSHI } from './kalshi-common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const DECISIONS = arg('decisions', 'mcache/pitcher-t120.json').split(',');
const KCACHE = arg('kcache', 'mcache');
const SET = arg('set', 'bot');
const DECISION_MIN = Number(arg('decision-min', 120));
// Minutes after the scheduled first pitch at which an unfilled order is pulled.
// 0 = cancel at first pitch, which is what the bot's daily cycle implies.
const DEADLINE_MIN = Number(arg('deadline', 0));
const BOOT = Number(arg('boot', 5000));
const JSON_OUT = arg('json', null);
// Kalshi's LIVE tier drops candlestick history as it ages, and it has aged past
// the start of the earlier studies' window since they were run. Decisions before
// this date are dropped, because a market whose candles no longer exist would be
// scored as "never filled" for a reason that has nothing to do with the market.
const MIN_DATE = arg('min-date', '');
const TAKER_FEE_RATE = Number(arg('fee-rate', 0.07));
const MAKER_FEE_RATE = Number(arg('maker-fee-rate', 0)); // see docs: "quadratic" series
const CANDLE_DIR = path.join(KCACHE, 'mcandles');
// How far past the deadline the price path is followed, for the adverse-selection test.
const PATH_MIN = 120;

fs.mkdirSync(CANDLE_DIR, { recursive: true });

/** Fee in cents per contract at `rate` (0 for a series that does not charge makers). */
const feeCents = (rate, p) => (p > 0 && p < 100 ? (rate * p * (100 - p)) / 100 : 0);

// ── the decision set ────────────────────────────────────────────────────────
/**
 * Rebuild the two-sided decision quote from what the base study recorded.
 * It wrote priceCents (the taker price on the traded side) and
 * decisionMidSide (the book mid, expressed on the traded side), which pins the
 * YES book exactly. Both reconstructed values must be whole cents; anything
 * else means the recorded row is not what this tool thinks it is.
 */
function bookOf(t) {
  let yesBid, yesAsk;
  if (t.side === 'yes') {
    yesAsk = t.priceCents;
    yesBid = 2 * t.decisionMidSide - yesAsk;
  } else {
    yesBid = 100 - t.priceCents;
    yesAsk = 2 * (100 - t.decisionMidSide) - yesBid;
  }
  if (!Number.isInteger(yesBid) || !Number.isInteger(yesAsk) || yesAsk <= yesBid) {
    throw new Error(`cannot reconstruct book for ${t.ticker}: bid=${yesBid} ask=${yesAsk}`);
  }
  return { yesBid, yesAsk, spread: yesAsk - yesBid };
}

/**
 * `path` or `path#set`. The pitcher study writes `trades.<set>`; the batter
 * study writes `trades.<decisionMinutes>.<set>` because it reports both decision
 * times in one run. Both shapes are accepted, and the payout is taken from
 * whichever field that study recorded it in.
 */
function loadDecisions() {
  const out = [];
  for (const spec of DECISIONS) {
    const [f, set = SET] = spec.split('#');
    const j = readJson(f);
    const list = j.trades?.[set] || j.trades?.[String(DECISION_MIN)]?.[set];
    if (!list) throw new Error(`${f} has no trades.${set} (has ${Object.keys(j.trades || {})})`);
    for (const t of list) {
      if (MIN_DATE && t.date < MIN_DATE) continue;
      const seg = t.ticker.split('-')[1];
      const p = parseEventTicker(`X-${seg}`);
      const startMs = startMsOf(p);
      if (!startMs) throw new Error(`cannot date ${t.ticker}`);
      const b = bookOf(t);
      out.push({
        ...t,
        source: path.basename(f),
        set,
        game: seg, // cluster: every contract on one game moves together
        startMs,
        decisionMs: startMs - DECISION_MIN * 60e3,
        deadlineMs: startMs + DEADLINE_MIN * 60e3,
        pathEndMs: startMs + PATH_MIN * 60e3,
        ...b,
        // Prices, all on the traded side.
        takerPrice: t.priceCents,
        restBidPrice: t.side === 'yes' ? b.yesBid : 100 - b.yesAsk,
        // One tick inside the best bid. Only a maker order when the spread is
        // at least 2c; at 1c it would cross and is not a resting order at all.
        restImpPrice: t.side === 'yes' ? b.yesBid + 1 : 100 - b.yesAsk + 1,
        impPossible: b.spread >= 2,
        payoutCents: t.payoutCents ?? (t.won ? 100 : 0),
      });
    }
  }
  return out;
}

// ── candles, with volume and traded price range ─────────────────────────────
/**
 * 1-minute candles for one game's decision markets over the resting window and
 * the price path that follows it, compacted to
 * [end_ts, yesBid, yesAsk, volume, tradeLow, tradeHigh] and cached per game.
 * `volume` is 0 and the trade prices are null when the minute had no trade.
 */
async function gameCandles(gameKey, tickers, startTs, endTs) {
  const file = path.join(CANDLE_DIR, `${gameKey}_${startTs}_${endTs}.json`);
  if (fs.existsSync(file)) return readJson(file);
  const out = {};
  const cents = (d) => (d == null ? null : Math.round(Number(d) * 100));
  const periods = Math.ceil((endTs - startTs) / 60) + 2;
  const perRequest = Math.max(1, Math.floor(10000 / periods));
  for (let i = 0; i < tickers.length; i += perRequest) {
    const chunk = tickers.slice(i, i + perRequest);
    const body = await kget(
      `${KALSHI}/markets/candlesticks?market_tickers=${chunk.join(',')}&start_ts=${startTs}&end_ts=${endTs}&period_interval=1`,
      { gapMs: 350 },
    );
    for (const m of body.markets || []) {
      out[m.market_ticker] = (m.candlesticks || []).map((c) => [
        c.end_period_ts,
        cents(c.yes_bid?.close_dollars),
        cents(c.yes_ask?.close_dollars),
        Number(c.volume_fp ?? c.volume ?? 0) || 0,
        cents(c.price?.low_dollars),
        cents(c.price?.high_dollars),
      ]);
    }
    for (const t of chunk) out[t] ||= [];
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Top of book as of `ms`: the last candle ending at or before it. */
function quoteAt(candles, ms) {
  const ts = ms / 1000;
  let q = null;
  for (const c of candles || []) {
    if (c[0] > ts) break;
    q = c;
  }
  if (!q) return null;
  const bid = q[1] > 0 ? q[1] : null;
  const ask = q[2] != null && q[2] < 100 ? q[2] : null;
  return { bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : null };
}

/**
 * Would a resting order at `price` on `side` have filled before `deadlineTs`?
 *
 * Buying YES at P is a bid at P: a print at or below P means someone sold at
 * our price or better. Buying NO at Q is an offer of YES at 100 − Q: a print at
 * or above 100 − Q means someone bought at our price or better.
 *
 * `through` requires the print to be strictly past our level. Nothing can trade
 * through a price while orders rest at it, so `through` fills are fills we would
 * have got whatever our queue position was.
 */
function fillOf(candles, { side, price }, fromTs, deadlineTs, { minVolume = 0.0001, through = false } = {}) {
  const yesLevel = side === 'yes' ? price : 100 - price;
  for (const c of candles || []) {
    if (c[0] <= fromTs) continue;
    if (c[0] > deadlineTs) break;
    const [, , , vol, lo, hi] = c;
    if (!(vol >= minVolume) || lo == null || hi == null) continue;
    const hit = side === 'yes'
      ? (through ? lo < yesLevel : lo <= yesLevel)
      : (through ? hi > yesLevel : hi >= yesLevel);
    if (hit) return { ts: c[0], volume: vol, tradeLow: lo, tradeHigh: hi };
  }
  return null;
}

// ── statistics: cluster bootstrap over games ────────────────────────────────
/**
 * ROI over a set of decisions, clustered by game.
 *
 * `cost` is charged on EVERY decision (an order ties up its price whether or
 * not it fills) and `pnl` is 0 on an unfilled one; passing only the filled
 * decisions therefore gives ROI on filled trades, and passing all of them gives
 * ROI over all decisions. Both are reported.
 */
function rollup(rows, costOf, pnlOf, { boot = BOOT, seed = 12345 } = {}) {
  if (!rows.length) return { n: 0 };
  const clusters = new Map();
  let cost = 0, pnl = 0;
  for (const r of rows) {
    const c = costOf(r), p = pnlOf(r);
    cost += c; pnl += p;
    if (!clusters.has(r.game)) clusters.set(r.game, [0, 0]);
    const k = clusters.get(r.game);
    k[0] += p; k[1] += c;
  }
  const cl = [...clusters.values()];
  const rand = mulberry32(seed);
  const rois = [];
  for (let b = 0; b < boot; b++) {
    let p = 0, c = 0;
    for (let i = 0; i < cl.length; i++) {
      const k = cl[Math.floor(rand() * cl.length)];
      p += k[0]; c += k[1];
    }
    rois.push(c > 0 ? p / c : 0);
  }
  rois.sort((a, b) => a - b);
  return {
    n: rows.length,
    games: cl.length,
    costCents: cost,
    pnlCents: pnl,
    pnlPerDecisionCents: pnl / rows.length,
    roiPct: (100 * pnl) / cost,
    roiCI95: [100 * rois[Math.floor(0.025 * boot)], 100 * rois[Math.floor(0.975 * boot)]],
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Cluster-bootstrap 95% CI for the mean of `f`, over games. */
function meanCI(rows, f, { boot = BOOT, seed = 999 } = {}) {
  if (!rows.length) return { n: 0 };
  const clusters = new Map();
  for (const r of rows) {
    if (!clusters.has(r.game)) clusters.set(r.game, []);
    clusters.get(r.game).push(f(r));
  }
  const cl = [...clusters.values()];
  const rand = mulberry32(seed);
  const ms = [];
  for (let b = 0; b < boot; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < cl.length; i++) {
      const k = cl[Math.floor(rand() * cl.length)];
      for (const v of k) { s += v; n++; }
    }
    ms.push(s / n);
  }
  ms.sort((a, b) => a - b);
  return { n: rows.length, mean: mean(rows.map(f)), ci95: [ms[Math.floor(0.025 * boot)], ms[Math.floor(0.975 * boot)]] };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const decisions = loadDecisions();
  process.stderr.write(`${decisions.length} decisions from ${DECISIONS.join(', ')} (set "${SET}")\n`);

  // Candles, one request batch per game.
  const byGame = new Map();
  for (const d of decisions) {
    if (!byGame.has(d.game)) byGame.set(d.game, []);
    byGame.get(d.game).push(d);
  }
  const candles = {};
  let done = 0;
  for (const [g, ds] of byGame) {
    const startTs = Math.floor(Math.min(...ds.map((d) => d.decisionMs)) / 1000) - 60;
    const endTs = Math.ceil(Math.max(...ds.map((d) => d.pathEndMs)) / 1000);
    Object.assign(candles, await gameCandles(g, [...new Set(ds.map((d) => d.ticker))], startTs, endTs));
    if (++done % 25 === 0) process.stderr.write(`  candles for ${done}/${byGame.size} games\r`);
  }
  process.stderr.write('\n');

  // ── simulate ──────────────────────────────────────────────────────────────
  const VOL_THRESHOLDS = [0.0001, 5, 20];
  for (const d of decisions) {
    const cs = candles[d.ticker] || [];
    d.candles = cs.length;
    d.fromTs = d.decisionMs / 1000;
    d.deadlineTs = d.deadlineMs / 1000;
    d.volumeInWindow = cs.filter((c) => c[0] > d.fromTs && c[0] <= d.deadlineTs).reduce((s, c) => s + c[3], 0);
    d.closeQuote = quoteAt(cs, d.startMs);
    d.pathQuote = quoteAt(cs, d.pathEndMs);
    const sideMid = (q) => (q?.mid == null ? null : d.side === 'yes' ? q.mid : 100 - q.mid);
    d.closeMid = sideMid(d.closeQuote);
    d.pathMid = sideMid(d.pathQuote);

    d.fills = {};
    for (const [name, price, possible] of [
      ['bid', d.restBidPrice, true],
      ['imp', d.restImpPrice, d.impPossible],
    ]) {
      const f = {};
      for (const v of VOL_THRESHOLDS) {
        f[`v${v === 0.0001 ? 1 : v}`] = possible ? fillOf(cs, { side: d.side, price }, d.fromTs, d.deadlineTs, { minVolume: v }) : null;
      }
      f.through = possible ? fillOf(cs, { side: d.side, price }, d.fromTs, d.deadlineTs, { through: true }) : null;
      f.price = price;
      f.possible = possible;
      d.fills[name] = f;
    }
  }

  // ── strategies ────────────────────────────────────────────────────────────
  // Each returns, per decision: price paid, fee, whether it filled, and P&L.
  const taker = (d) => {
    const fee = feeCents(TAKER_FEE_RATE, d.takerPrice);
    return { filled: true, price: d.takerPrice, fee, cost: d.takerPrice + fee, pnl: d.payoutCents - d.takerPrice - fee };
  };
  const maker = (kind, fillKey, feeRate = MAKER_FEE_RATE) => (d) => {
    const f = d.fills[kind];
    const price = f.price;
    const fee = feeCents(feeRate, price);
    const filled = Boolean(f.possible && f[fillKey]);
    return { filled, price, fee, cost: price + fee, pnl: filled ? d.payoutCents - price - fee : 0 };
  };

  const strategies = {
    'a taker@ask fee0.07': taker,
    'a taker@ask fee0.035': (d) => {
      const fee = feeCents(0.035, d.takerPrice);
      return { filled: true, price: d.takerPrice, fee, cost: d.takerPrice + fee, pnl: d.payoutCents - d.takerPrice - fee };
    },
    'b maker@bid fee0 (vol>0)': maker('bid', 'v1'),
    'b maker@bid fee0 (vol>=5)': maker('bid', 'v5'),
    'b maker@bid fee0 (vol>=20)': maker('bid', 'v20'),
    'b maker@bid fee0 (traded through)': maker('bid', 'through'),
    'b maker@bid fee0.035 (vol>0)': maker('bid', 'v1', 0.035),
    'b maker@bid fee0.07 (vol>0)': maker('bid', 'v1', 0.07),
    'c maker@bid+1 fee0 (vol>0)': maker('imp', 'v1'),
    'c maker@bid+1 fee0 (traded through)': maker('imp', 'through'),
  };

  const windowOf = (d) => (d.date >= '2026-08-10' ? 'A Aug10-Sep15' : 'B Jul10-Aug9');
  const report = { config: { decisions: DECISIONS, set: SET, decisionMin: DECISION_MIN, deadlineMin: DEADLINE_MIN, minDate: MIN_DATE || null, takerFeeRate: TAKER_FEE_RATE, makerFeeRate: MAKER_FEE_RATE, boot: BOOT } };

  report.coverage = {
    decisions: decisions.length,
    games: byGame.size,
    tickersWithNoCandles: decisions.filter((d) => !d.candles).length,
    spreadHistogram: decisions.reduce((h, d) => ((h[d.spread] = (h[d.spread] || 0) + 1), h), {}),
    meanSpreadCents: mean(decisions.map((d) => d.spread)),
    meanTakerPriceCents: mean(decisions.map((d) => d.takerPrice)),
    meanTakerFeeCents: mean(decisions.map((d) => feeCents(TAKER_FEE_RATE, d.takerPrice))),
    bidPlusOnePossible: decisions.filter((d) => d.impPossible).length,
    medianWindowVolume: (() => {
      const v = decisions.map((d) => d.volumeInWindow).sort((a, b) => a - b);
      return { median: v[Math.floor(v.length / 2)], p10: v[Math.floor(v.length * 0.1)], p90: v[Math.floor(v.length * 0.9)], zero: v.filter((x) => x === 0).length };
    })(),
    byWindow: decisions.reduce((h, d) => ((h[windowOf(d)] = (h[windowOf(d)] || 0) + 1), h), {}),
  };

  // The arithmetic ceiling: what resting saves per contract IF it always filled.
  report.savingIfAlwaysFilled = {
    note: 'taker price + taker fee - rest price - maker fee, per contract; the most resting can be worth',
    atBidCents: mean(decisions.map((d) => d.takerPrice + feeCents(TAKER_FEE_RATE, d.takerPrice) - d.restBidPrice - feeCents(MAKER_FEE_RATE, d.restBidPrice))),
    takerLossPerContractCents: mean(decisions.map((d) => taker(d).pnl)),
  };

  report.strategies = {};
  for (const [name, fn] of Object.entries(strategies)) {
    const scored = decisions.map((d) => ({ ...d, r: fn(d) }));
    const filled = scored.filter((s) => s.r.filled);
    report.strategies[name] = {
      fillRate: filled.length / scored.length,
      filledN: filled.length,
      onFilled: rollup(filled, (s) => s.r.cost, (s) => s.r.pnl),
      allDecisions: rollup(scored, (s) => s.r.cost, (s) => s.r.pnl),
      byWindow: Object.fromEntries(['A Aug10-Sep15', 'B Jul10-Aug9'].map((w) => {
        const sub = scored.filter((s) => windowOf(s) === w);
        return [w, { fillRate: sub.filter((s) => s.r.filled).length / (sub.length || 1), onFilled: rollup(sub.filter((s) => s.r.filled), (s) => s.r.cost, (s) => s.r.pnl), allDecisions: rollup(sub, (s) => s.r.cost, (s) => s.r.pnl) }];
      })),
      bySource: Object.fromEntries([...new Set(scored.map((s) => s.source))].sort().map((k) => {
        const sub = scored.filter((s) => s.source === k);
        return [k, { fillRate: sub.filter((s) => s.r.filled).length / (sub.length || 1), onFilled: rollup(sub.filter((s) => s.r.filled), (s) => s.r.cost, (s) => s.r.pnl), allDecisions: rollup(sub, (s) => s.r.cost, (s) => s.r.pnl) }];
      })),
      bySeries: Object.fromEntries([...new Set(scored.map((s) => s.series))].sort().map((k) => {
        const sub = scored.filter((s) => s.series === k);
        return [k, { fillRate: sub.filter((s) => s.r.filled).length / (sub.length || 1), onFilled: rollup(sub.filter((s) => s.r.filled), (s) => s.r.cost, (s) => s.r.pnl), allDecisions: rollup(sub, (s) => s.r.cost, (s) => s.r.pnl) }];
      })),
      // CLV on filled trades: the close mid on the traded side, minus what we paid.
      clvVsPaidCents: meanCI(filled.filter((s) => s.closeMid != null), (s) => s.closeMid - s.r.price),
    };
  }

  // ── adverse selection ─────────────────────────────────────────────────────
  // Same resting order, filled vs unfilled. If resting fills preferentially when
  // the market is moving against us, the filled set should settle worse and its
  // price should have drifted down relative to the unfilled set.
  const adverse = {};
  for (const kind of ['bid', 'imp']) {
    for (const key of ['v1', 'through']) {
      const pool = decisions.filter((d) => d.fills[kind].possible);
      const filled = pool.filter((d) => d.fills[kind][key]);
      const unfilled = pool.filter((d) => !d.fills[kind][key]);
      const drift = (d) => (d.closeMid == null ? null : d.closeMid - d.decisionMidSide);
      const pathDrift = (d) => (d.pathMid == null ? null : d.pathMid - d.decisionMidSide);
      const withDrift = (xs) => xs.filter((d) => drift(d) != null);
      const withPath = (xs) => xs.filter((d) => pathDrift(d) != null);
      adverse[`${kind}/${key}`] = {
        n: pool.length,
        filled: filled.length,
        unfilled: unfilled.length,
        // Did the contract actually settle in our favour?
        settleWinRateFilled: filled.length ? filled.filter((d) => d.payoutCents === 100).length / filled.length : null,
        settleWinRateUnfilled: unfilled.length ? unfilled.filter((d) => d.payoutCents === 100).length / unfilled.length : null,
        // Where the price went, on the traded side, decision -> first pitch.
        midDriftFilled: meanCI(withDrift(filled), drift, { seed: 4242 }),
        midDriftUnfilled: meanCI(withDrift(unfilled), drift, { seed: 4242 }),
        // ... and 2h further on, deep into the game.
        pathDriftFilled: meanCI(withPath(filled), pathDrift, { seed: 4243 }),
        pathDriftUnfilled: meanCI(withPath(unfilled), pathDrift, { seed: 4243 }),
        // The same trade taken at the ask, split by whether the maker order filled.
        takerRoiOnFilled: rollup(filled, (d) => taker(d).cost, (d) => taker(d).pnl),
        takerRoiOnUnfilled: rollup(unfilled, (d) => taker(d).cost, (d) => taker(d).pnl),
      };
    }
  }
  report.adverseSelection = adverse;

  // Break-even fill rate: at what fill rate does maker@bid break even over all decisions?
  report.breakEven = (() => {
    const out = {};
    for (const kind of ['bid']) {
      const scored = decisions.map((d) => ({ d, r: maker(kind, 'v1')(d) }));
      const filled = scored.filter((s) => s.r.filled);
      const meanPnlOnFill = mean(filled.map((s) => s.r.pnl));
      out[kind] = { meanPnlPerFillCents: meanPnlOnFill, note: 'ROI over all decisions is positive iff mean P&L per fill is positive; fill rate scales it, it does not change the sign' };
    }
    return out;
  })();

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  print(report);
}

const pct = (x, d = 1) => (x == null ? '—' : `${(100 * x).toFixed(d)}%`);
const c = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}c`);
const roi = (s) => (!s || !s.n ? 'n=0' : `n=${String(s.n).padStart(4)} (${s.games} games)  ${c(s.pnlPerDecisionCents)}/dec  ROI ${s.roiPct >= 0 ? '+' : ''}${s.roiPct.toFixed(1)}% [${s.roiCI95[0].toFixed(1)}, ${s.roiCI95[1].toFixed(1)}]`);

function print(r) {
  console.log(`\n=== maker study: set "${r.config.set}", decision T-${r.config.decisionMin}, orders pulled at first pitch ${r.config.deadlineMin ? `+${r.config.deadlineMin}m` : ''} ===`);
  console.log('coverage:', JSON.stringify(r.coverage));
  console.log('\nceiling if resting always filled:', JSON.stringify(r.savingIfAlwaysFilled));
  console.log('\n=== strategies ===');
  for (const [name, s] of Object.entries(r.strategies)) {
    console.log(`\n${name}`);
    console.log(`  fill ${pct(s.fillRate)} (${s.filledN})   CLV vs paid ${c(s.clvVsPaidCents?.mean)} [${s.clvVsPaidCents?.ci95?.map((x) => x.toFixed(2)).join(', ')}]`);
    console.log(`  on filled      ${roi(s.onFilled)}`);
    console.log(`  all decisions  ${roi(s.allDecisions)}`);
    for (const [w, x] of Object.entries(s.byWindow)) console.log(`    ${w.padEnd(16)} fill ${pct(x.fillRate)}  filled ${roi(x.onFilled)}  all ${roi(x.allDecisions)}`);
    for (const [k, x] of Object.entries(s.bySource)) console.log(`    ${k.padEnd(16)} fill ${pct(x.fillRate)}  filled ${roi(x.onFilled)}  all ${roi(x.allDecisions)}`);
    for (const [k, x] of Object.entries(s.bySeries)) console.log(`    ${k.padEnd(16)} fill ${pct(x.fillRate)}  filled ${roi(x.onFilled)}  all ${roi(x.allDecisions)}`);
  }
  console.log('\n=== adverse selection (same resting order, filled vs unfilled) ===');
  for (const [k, a] of Object.entries(r.adverseSelection)) {
    console.log(`\n${k}: pool ${a.n}, filled ${a.filled}, unfilled ${a.unfilled}`);
    console.log(`  settled in our favour: filled ${pct(a.settleWinRateFilled)} vs unfilled ${pct(a.settleWinRateUnfilled)}`);
    const m = (x) => (!x || !x.n ? '—' : `${c(x.mean)} [${x.ci95.map((v) => v.toFixed(2)).join(', ')}] (n=${x.n})`);
    console.log(`  mid drift to first pitch: filled ${m(a.midDriftFilled)}  unfilled ${m(a.midDriftUnfilled)}`);
    console.log(`  mid drift +2h into game:  filled ${m(a.pathDriftFilled)}  unfilled ${m(a.pathDriftUnfilled)}`);
    console.log(`  same trade as a TAKER:    on filled ${roi(a.takerRoiOnFilled)}`);
    console.log(`                            on unfilled ${roi(a.takerRoiOnUnfilled)}`);
  }
  console.log('\nbreak-even:', JSON.stringify(r.breakEven));
}

await main();
