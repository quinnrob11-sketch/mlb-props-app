// Feature building and fitting for the M2 pitcher model (tools/pitcher-model2.mjs).
//
// Every aggregate a start reads is built from events strictly BEFORE that
// start's date, so a row is exactly what was knowable that morning. The fitted
// coefficients come from the FIT split only.

import { parkFactor } from '../src/lib/parks.js';
import { projectPitcher } from '../src/model/pitcher.js';
import { LEAGUE_AVG } from '../src/model/league.js';
import { parseInningsPitched } from '../src/model/pitcher.js';
import {
  ct, pooled, ols, poissonFit, fitOutsTable, outsPmfFromTable, assembleDist, clamp,
} from './pitcher-model2.mjs';

/** Decaying running totals with a queryable history; adds must be in time order. */
export class Series {
  constructor(tau, n) { this.tau = tau; this.n = n; this.times = []; this.states = []; }
  add(t, vals) {
    const last = this.times.length - 1;
    if (last >= 0 && this.times[last] === t) {
      for (let i = 0; i < this.n; i++) this.states[last][i] += vals[i];
      return;
    }
    const prev = last >= 0 ? this.states[last] : null;
    const s = new Float64Array(this.n);
    if (prev) {
      const f = Math.exp(-(t - this.times[last]) / this.tau);
      for (let i = 0; i < this.n; i++) s[i] = prev[i] * f;
    }
    for (let i = 0; i < this.n; i++) s[i] += vals[i];
    this.times.push(t); this.states.push(s);
  }
  /** Decayed totals over everything added strictly before `t`. */
  query(t) {
    let lo = 0, hi = this.times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const out = new Float64Array(this.n);
    if (idx < 0) return out;
    const f = Math.exp(-(t - this.times[idx]) / this.tau);
    for (let i = 0; i < this.n; i++) out[i] = this.states[idx][i] * f;
    return out;
  }
}

const get = (map, key, make) => { let v = map.get(key); if (!v) { v = make(); map.set(key, v); } return v; };

export const DEFAULT_PARAMS = {
  tauRate: 200,      // half-life-ish for the pitcher's own per-BF rates (days)
  tauWork: 45,       // for workload / depth
  tauOpp: 200,       // for opposing batters
  tauCtx: 400,       // for umpire and catcher
  offDays: 60,       // effective length of the offseason gap
  sK: 300, sBB: 300, sH: 400, sHR: 600, sHBP: 600, sER: 700,  // pooling strength, in BF
  sBat: 250,         // pooling strength for a batter, in PA
  sUmp: 6000, sCat: 4000,
};

/**
 * Build the as-of feature row for every start.
 * `starts` must be sorted by date. Nothing reads its own or any later game.
 */
export function buildFeatures(raw, starts, P = DEFAULT_PARAMS) {
  const { pitcherLogs, batterLogs, teamLogs, hands } = raw;
  const T = (date, season) => ct(date, season, P.offDays);

  // ── league, as-of ─────────────────────────────────────────────────────────
  // Starter population rates (bf, k, bb, h, hr, hbp, outs, pitches, starts, er).
  const lgStart = new Series(400, 10);
  const lgBat = new Series(400, 4);   // pa, k, bb, h

  // ── per-entity series ─────────────────────────────────────────────────────
  const pRate = new Map();   // pitcherId -> Series(bf,k,bb,h,hr,hbp,er,outs)
  const pWork = new Map();   // pitcherId -> Series(starts,outs,pitches,bf,ip)
  const pApp = new Map();    // pitcherId -> Series(apps,outs,pitches,bf)  all appearances
  const bRate = new Map();   // batterId  -> Series(pa,k,bb,h)
  const uRate = new Map();   // umpireId  -> Series(bf,k,bb)
  const cRate = new Map();   // catcherId -> Series(bf,k,bb)

  // Feed every pitching appearance (including relief) into the rate series,
  // and every batter game into the batter series, in date order.
  const events = [];
  for (const [id, logs] of pitcherLogs) {
    for (const g of logs) events.push({ t: T(g.date, g.season), kind: 'p', id, g });
  }
  for (const [id, logs] of batterLogs) {
    for (const g of logs) events.push({ t: T(g.date, g.season), kind: 'b', id, g });
  }
  events.sort((a, b) => a.t - b.t);

  // Starts, in the same time order, so umpire/catcher/league series see only
  // earlier games.
  const startEvents = starts.map((s, i) => ({ t: T(s.date, s.season), i, s }));
  startEvents.sort((a, b) => a.t - b.t);

  // Two passes would be simplest, but the series must be built incrementally so
  // a query at time t sees only t' < t. Build the full series first (queries
  // are time-indexed and always strict), which is equivalent and much faster.
  for (const e of events) {
    if (e.kind === 'p') {
      const st = e.g.stat;
      get(pRate, e.id, () => new Series(P.tauRate, 8))
        .add(e.t, [st.battersFaced, st.strikeOuts, st.baseOnBalls, st.hits, st.homeRuns, st.hitByPitch, st.earnedRuns, st.outs]);
      get(pApp, e.id, () => new Series(P.tauWork, 4))
        .add(e.t, [1, st.outs, st.numberOfPitches, st.battersFaced]);
      if (st.gamesStarted === 1) {
        get(pWork, e.id, () => new Series(P.tauWork, 5))
          .add(e.t, [1, st.outs, st.numberOfPitches, st.battersFaced, st.outs / 3]);
      }
    } else {
      const g = e.g;
      get(bRate, e.id, () => new Series(P.tauOpp, 4)).add(e.t, [g.pa, g.k, g.bb, g.h]);
      lgBat.add(e.t, [g.pa, g.k, g.bb, g.h]);
    }
  }
  for (const e of startEvents) {
    const a = e.s.actual;
    lgStart.add(e.t, [a.bf, a.k, a.bb, a.hits, a.hr, a.hbp, a.outs, a.pitches, 1, a.er]);
    if (e.s.umpId) get(uRate, e.s.umpId, () => new Series(P.tauCtx, 3)).add(e.t, [a.bf, a.k, a.bb]);
    if (e.s.catcherId) get(cRate, e.s.catcherId, () => new Series(P.tauCtx, 3)).add(e.t, [a.bf, a.k, a.bb]);
  }

  // ── one row per start ─────────────────────────────────────────────────────
  const rows = [];
  for (const s of starts) {
    const t = T(s.date, s.season);
    const L = lgStart.query(t);
    const LB = lgBat.query(t);
    if (L[0] < 2000 || LB[0] < 5000) { rows.push(null); continue; }  // too early in 2025 to say anything
    const lg = {
      k: L[1] / L[0], bb: L[2] / L[0], h: L[3] / L[0], hr: L[4] / L[0], hbp: L[5] / L[0],
      er: L[9] / L[0],
      outsPerStart: L[6] / L[8], pitchesPerStart: L[7] / L[8], bfPerStart: L[0] / L[8],
      batK: LB[1] / LB[0], batBB: LB[2] / LB[0], batH: LB[3] / LB[0],
    };

    const R = pRate.get(s.id)?.query(t) || new Float64Array(8);
    const bf = R[0];
    const own = {
      k: pooled(R[1], bf, lg.k, P.sK),
      bb: pooled(R[2], bf, lg.bb, P.sBB),
      h: pooled(R[3], bf, lg.h, P.sH),
      hr: pooled(R[4], bf, lg.hr, P.sHR),
      hbp: pooled(R[5], bf, lg.hbp, P.sHBP),
      er: pooled(R[6], bf, lg.er, P.sER),
      bf,
    };

    const W = pWork.get(s.id)?.query(t) || new Float64Array(5);
    const A = pApp.get(s.id)?.query(t) || new Float64Array(4);
    const nStarts = W[0];
    const outsPerStart = nStarts > 0.3 ? W[1] / nStarts : null;
    const pitchesPerStart = nStarts > 0.3 ? W[2] / nStarts : null;
    // A reliever handed a start: his own relief workload is the only evidence.
    const reliefOuts = A[0] > 0.3 ? A[1] / A[0] : null;

    // Opponent: the nine men posted, each with his own recency-weighted,
    // partially pooled rate.
    let oK = 0, oBB = 0, oH = 0, nB = 0, adv = 0;
    for (const b of s.oppLineup) {
      const B = bRate.get(b.id)?.query(t);
      if (!B || B[0] < 1) continue;
      oK += pooled(B[1], B[0], lg.batK, P.sBat);
      oBB += pooled(B[2], B[0], lg.batBB, P.sBat);
      oH += pooled(B[3], B[0], lg.batH, P.sBat);
      nB++;
      if (b.bat === 'S' || (s.throws === 'R' && b.bat === 'L') || (s.throws === 'L' && b.bat === 'R')) adv++;
    }
    if (!nB) {
      // No posted lineup: fall back to the opponent's team season rates.
      const tl = teamLogs.get(`${s.oppId}:${s.season}`) || [];
      let pa = 0, k = 0, bb = 0, h = 0;
      for (const g of tl) { if (g.date >= s.date) continue; const st = g.stat; pa += +st.plateAppearances || 0; k += +st.strikeOuts || 0; bb += +st.baseOnBalls || 0; h += +st.hits || 0; }
      if (!pa) { rows.push(null); continue; }
      oK = k / pa; oBB = bb / pa; oH = h / pa; nB = 1; adv = 4.9;
    } else { oK /= nB; oBB /= nB; oH /= nB; }
    const platoonShare = adv / (nB || 9);

    const U = uRate.get(s.umpId)?.query(t) || new Float64Array(3);
    const umpK = pooled(U[1], U[0], lg.k, P.sUmp) / lg.k;
    const umpBB = pooled(U[2], U[0], lg.bb, P.sUmp) / lg.bb;
    const C = cRate.get(s.catcherId)?.query(t) || new Float64Array(3);
    const catK = pooled(C[1], C[0], lg.k, P.sCat) / lg.k;
    const catBB = pooled(C[2], C[0], lg.bb, P.sCat) / lg.bb;

    const seasonDay = (Date.parse(s.date) - Date.parse(`${s.season}-03-20`)) / 864e5;
    const rest = s.restDays == null ? 5 : clamp(s.restDays, 3, 12);

    rows.push({
      start: s,
      lg,
      own,
      nStarts, outsPerStart, pitchesPerStart, reliefOuts,
      oppK: oK, oppBB: oBB, oppH: oH, platoonShare, nBatters: nB,
      umpK, umpBB, catK, catBB,
      parkSO: parkFactor(s.venue, 'so', 1), parkH: parkFactor(s.venue, 'hits', 1), parkHR: parkFactor(s.venue, 'hr', 1),
      home: s.isHome ? 1 : 0,
      tempZ: s.temp == null ? 0 : (s.temp - 72) / 10,
      rest, longRest: rest >= 7 ? 1 : 0,
      progress: seasonDay / 100,
      isOpener: nStarts < 1.5 ? 1 : 0,
    });
  }
  return rows;
}

// ── design matrices ─────────────────────────────────────────────────────────
const L = (x) => Math.log(Math.max(1e-6, x));

/** Rate-model design row. One matrix serves K, BB, H and HR; the offset differs. */
function rateX(f) {
  return [
    1,
    L(f.oppK / f.lg.batK),
    L(f.oppBB / f.lg.batBB),
    L(f.oppH / f.lg.batH),
    f.platoonShare - 0.55,
    f.home - 0.5,
    L(f.umpK),
    L(f.catK),
    f.tempZ,
    f.progress - 1.2,
    f.isOpener,
  ];
}
export const RATE_TERMS = ['int', 'oppK', 'oppBB', 'oppH', 'platoon', 'home', 'ump', 'catcher', 'temp', 'progress', 'opener'];

function outsX(f) {
  const ops = f.outsPerStart ?? f.reliefOuts ?? f.lg.outsPerStart;
  const pps = f.pitchesPerStart ?? f.lg.pitchesPerStart * 0.5;
  return [
    1,
    ops - f.lg.outsPerStart,
    (pps - f.lg.pitchesPerStart) / 10,
    f.home - 0.5,
    (f.rest - 5) / 3,
    f.longRest,
    f.progress - 1.2,
    L(f.oppK / f.lg.batK),
    L((f.oppH + f.oppBB) / (f.lg.batH + f.lg.batBB)),
    f.isOpener,
    Math.min(3, f.nStarts) - 3,
  ];
}
export const OUTS_TERMS = ['int', 'ownOuts', 'ownPitch', 'home', 'rest', 'longRest', 'progress', 'oppK', 'oppOnBase', 'opener', 'fewStarts'];

/**
 * Conditional-mean design for a counting stat GIVEN depth. `r` holds the
 * per-BF rates the rate models already predicted for this start, so the
 * pitcher's own quality enters here and only the depth shape is new.
 */
function condX(f, outs, r, market) {
  const z = (outs - 15.5) / 3;
  if (market === 'er') {
    // Earned runs get a run-value composite rather than four correlated rate
    // terms. Fitting them separately produced a NEGATIVE coefficient on the
    // walk rate, which is nonsense and is what collinearity between four
    // per-BF rates looks like. The weights are the classic linear ones.
    const runs = 0.47 * (r.pH - r.pHR) + 1.4 * r.pHR + 0.33 * r.pBB;
    const lgRuns = 0.47 * (f.lg.h - f.lg.hr) + 1.4 * f.lg.hr + 0.33 * f.lg.bb;
    return [1, z, z * z, L(runs / lgRuns), L(f.own.er / f.lg.er), L(r.pK / f.lg.k), L(f.parkH), L(f.parkHR), f.home - 0.5];
  }
  return [
    1, z, z * z,
    L(r.pH / f.lg.h),
    L(r.pBB / f.lg.bb),
    L(r.pK / f.lg.k),
    L(r.pHR / f.lg.hr),
    L(f.parkH),
    L(f.parkHR),
    f.home - 0.5,
  ];
}
export const COND_TERMS = ['int', 'outs', 'outs2', 'pH', 'pBB', 'pK', 'pHR', 'parkH', 'parkHR', 'home'];
/**
 * The other way to get a marginal: predict it directly from what is knowable,
 * with predicted depth as a covariate instead of realised depth as a
 * conditioning variable.
 *
 * This exists because conditioning on the depth that actually happened is a
 * COLLIDER for the damage markets. Fitted that way, the earned-run model came
 * back with a coefficient of -0.26 on the pitcher's own run-value rate: given
 * that he got through 18 outs, the pitcher who "should" have been hit was
 * having a good night, so within that slice his rate predicts FEWER runs. That
 * is a true statement about a conditional and a useless one for pricing a
 * contract, because at the decision time depth is not known either. Each
 * market gets whichever of the two routes wins on the fit window.
 */
function directX(f, r, muOuts) {
  return [
    1,
    L(muOuts / 15.5),
    L(r.pH / f.lg.h),
    L(r.pBB / f.lg.bb),
    L(r.pK / f.lg.k),
    L(r.pHR / f.lg.hr),
    L(f.own.er / f.lg.er),
    L(f.parkH),
    L(f.parkHR),
    f.home - 0.5,
    f.progress - 1.2,
  ];
}
export const DIRECT_TERMS = ['int', 'muOuts', 'pH', 'pBB', 'pK', 'pHR', 'ownER', 'parkH', 'parkHR', 'home', 'progress'];

/** Offset for the direct model: predicted batters faced times the per-BF rate. */
function directOffset(f, r, muOuts, market) {
  const bf = muOuts / r.Q;
  const runs = 0.47 * (r.pH - r.pHR) + 1.4 * r.pHR + 0.33 * r.pBB;
  const rate = market === 'k' ? r.pK : market === 'hits' ? r.pH : market === 'bb' ? r.pBB : runs;
  return L(bf * rate);
}

export const COND_TERMS_ER = ['int', 'outs', 'outs2', 'runs', 'ownER', 'pK', 'parkH', 'parkHR', 'home'];

const dot = (x, b) => x.reduce((s, v, i) => s + v * b[i], 0);

// ── fitting ─────────────────────────────────────────────────────────────────
/** Fit every coefficient of M2 on `fitRows` (FIT split only). */
export function fitModel(fitRows, opts = {}) {
  const rows = fitRows.filter(Boolean);
  const X = rows.map(rateX);

  const fitRate = (yKey, ownKey) => poissonFit(
    X,
    rows.map((f) => f.start.actual[yKey]),
    rows.map((f) => Math.max(1, f.start.actual.bf)),
    rows.map((f) => L(f.own[ownKey])),
  );
  const betaK = fitRate('k', 'k');
  const betaBB = fitRate('bb', 'bb');
  const betaH = fitRate('hits', 'h');
  const betaHR = fitRate('hr', 'hr');
  const betaHBP = fitRate('hbp', 'hbp');

  // Outs made on runners, as a share of the batters who reached: the term that
  // turns "batters faced" into "outs recorded".
  let extra = 0, reached = 0;
  for (const f of rows) {
    const a = f.start.actual;
    const r = a.hits + a.bb + a.hbp;
    extra += a.outs - (a.bf - r);
    reached += r;
  }
  const gamma = clamp(extra / Math.max(1, reached), 0, 0.4);

  const XO = rows.map(outsX);
  const betaOuts = ols(XO, rows.map((f) => f.start.actual.outs), 1e-4);
  const muOuts = XO.map((x) => x.reduce((s, v, i) => s + v * betaOuts[i], 0));
  const outsTable = fitOutsTable(muOuts, rows.map((f) => f.start.actual.outs));

  // Per-BF rates this model would predict for each fit row, so the
  // conditional-mean models can read them as features.
  const half = { betaK, betaBB, betaH, betaHR, betaHBP, gamma };
  const rates = rows.map((f) => ratesOf(f, half));

  // Conditional means given depth, one per counting market, plus that
  // market's own variance-to-mean ratio measured around those means.
  const condFit = (yKey) => {
    const XC = rows.map((f, i) => condX(f, f.start.actual.outs, rates[i], yKey === 'hits' ? 'hits' : yKey));
    const y = rows.map((f) => f.start.actual[yKey]);
    const beta = poissonFit(XC, y, rows.map(() => 1), rows.map(() => 0), { ridge: 1e-5 });
    let sm = 0, sv = 0;
    for (let i = 0; i < rows.length; i++) {
      const m = Math.exp(XC[i].reduce((a, v, j) => a + v * beta[j], 0));
      sm += m; sv += (y[i] - m) ** 2;
    }
    return { beta, phi: clamp(sv / Math.max(1e-6, sm), 0.5, 2.5) };
  };
  const K = condFit('k');
  const H = condFit('hits');
  const BB = condFit('bb');
  const ER = condFit('er');

  // The direct route, fitted on the same rows.
  const muOutsRow = rows.map((f) => clamp(dot(outsX(f), betaOuts), 4, 24));
  const directFit = (yKey, market) => {
    const XD = rows.map((f, i) => directX(f, rates[i], muOutsRow[i]));
    const off = rows.map((f, i) => directOffset(f, rates[i], muOutsRow[i], market));
    const y = rows.map((f) => f.start.actual[yKey]);
    const beta = poissonFit(XD, y, rows.map(() => 1), off, { ridge: 1e-5 });
    let sm = 0, sv = 0;
    for (let i = 0; i < rows.length; i++) {
      const m = Math.exp(off[i] + XD[i].reduce((a, v, j) => a + v * beta[j], 0));
      sm += m; sv += (y[i] - m) ** 2;
    }
    return { beta, phi: clamp(sv / Math.max(1e-6, sm), 0.5, 2.5) };
  };
  const dK = directFit('k', 'k');
  const dH = directFit('hits', 'hits');
  const dBB = directFit('bb', 'bb');
  const dER = directFit('er', 'er');

  const M = {
    betaK, betaBB, betaH, betaHR, betaHBP, gamma,
    betaOuts, outsTable,
    cond: {
      k: K.beta, phiK: K.phi,
      h: H.beta, phiH: H.phi,
      bb: BB.beta, phiBB: BB.phi,
      er: ER.beta, phiER: ER.phi,
    },
    direct: {
      k: dK.beta, phiK: dK.phi,
      h: dH.beta, phiH: dH.phi,
      bb: dBB.beta, phiBB: dBB.phi,
      er: dER.beta, phiER: dER.phi,
    },
    // Which route each market uses; chosen on the fit window by the driver.
    route: { k: 'cond', hits: 'cond', bb: 'cond', er: 'direct', ...(opts.route || {}) },
    cal: { k: [0, 1], hits: [0, 1], bb: [0, 1], er: [0, 1] },
  };

  // Calibration slope of the MARGINAL projection.
  //
  // Each conditional mean is unbiased given the depth that actually happened,
  // but the projection a bettor sees averages it over a PREDICTED depth
  // distribution indexed only by predicted outs — and that step throws away
  // whatever the pitcher's own rates say about depth beyond their effect on
  // the mean. The result is a projection that ranks starts well and spreads
  // them too little: on the fit window, regressing the outcome on the
  // projection returns a slope near 1.4 for hits allowed. One regression per
  // market puts the spread back, and it is measured, not assumed.
  for (const [m, key] of [['k', 'k'], ['hits', 'hits'], ['bb', 'bb'], ['er', 'er']]) {
    const proj = rows.map((f) => marginalMean(f, M, m));
    const y = rows.map((f) => f.start.actual[key]);
    const n = rows.length;
    const mx = proj.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (proj[i] - mx) * (y[i] - my); sxx += (proj[i] - mx) ** 2; }
    const slope = clamp(sxy / Math.max(1e-9, sxx), 0.5, 2.5);
    M.cal[m] = [my - slope * mx, slope];
  }
  return M;
}

/** The marginal mean of one market, before calibration. */
function marginalMean(f, M, market) {
  const rates = ratesOf(f, M);
  const muOuts = clamp(dot(outsX(f), M.betaOuts), 4, 24);
  const pmf = outsPmfFromTable(M.outsTable, muOuts);
  const key = market === 'hits' ? 'h' : market;
  if ((M.route?.[market] || 'cond') === 'direct') {
    return Math.exp(directOffset(f, rates, muOuts, market) + dot(directX(f, rates, muOuts), M.direct[key]));
  }
  let s = 0;
  for (let o = 0; o < 28; o++) {
    if (pmf[o] < 1e-9) continue;
    s += pmf[o] * Math.exp(dot(condX(f, o, rates, market), beta_(M, key)));
  }
  return s;
}
const beta_ = (M, key) => M.cond[key];

/** Per-BF rates for one start, from the rate half of a fitted model. */
function ratesOf(f, M) {
  const x = rateX(f);
  const pK = clamp(f.own.k * Math.exp(dot(x, M.betaK)), 0.03, 0.45);
  const pBB = clamp(f.own.bb * Math.exp(dot(x, M.betaBB)), 0.01, 0.20);
  const pH = clamp(f.own.h * Math.exp(dot(x, M.betaH)), 0.10, 0.36);
  const pHR = clamp(f.own.hr * Math.exp(dot(x, M.betaHR)), 0.003, 0.08);
  const pHBP = clamp(f.own.hbp * Math.exp(dot(x, M.betaHBP)), 0.002, 0.04);
  const reach = clamp(pH + pBB + pHBP, 0.20, 0.50);
  const qB = 1 - reach;
  return { pK, pBB, pH, pHR, pHBP, qB, Q: qB + M.gamma * reach };
}

/** Project one start with a fitted M2. */
export function predictM2(f, M) {
  const rates = ratesOf(f, M);
  const muOuts = clamp(dot(outsX(f), M.betaOuts), 4, 24);
  const outsPmf = outsPmfFromTable(M.outsTable, muOuts);

  const mean = (beta, market) => {
    const cache = new Float64Array(28).fill(-1);
    return (o) => {
      if (cache[o] < 0) cache[o] = Math.exp(dot(condX(f, o, rates, market), beta));
      return cache[o];
    };
  };
  const C = M.cond;
  const D = M.direct;
  const route = M.route || { k: 'cond', hits: 'cond', bb: 'cond', er: 'direct' };
  const flat = (market, key) => {
    const v = Math.exp(directOffset(f, rates, muOuts, market) + dot(directX(f, rates, muOuts), D[key]));
    return () => v;
  };
  const pick = (market, key, condBeta) => (route[market] === 'direct' ? flat(market, key) : mean(condBeta, market));
  const raw0 = {
    k: pick('k', 'k', C.k), h: pick('hits', 'h', C.h), bb: pick('bb', 'bb', C.bb), er: pick('er', 'er', C.er),
  };
  const phi = {
    k: route.k === 'direct' ? D.phiK : C.phiK,
    hits: route.hits === 'direct' ? D.phiH : C.phiH,
    bb: route.bb === 'direct' ? D.phiBB : C.phiBB,
    er: route.er === 'direct' ? D.phiER : C.phiER,
  };
  // Calibrate the marginal, then scale the conditional mean curve to match it.
  const scale = {};
  for (const [m, fn] of [['k', raw0.k], ['hits', raw0.h], ['bb', raw0.bb], ['er', raw0.er]]) {
    let s = 0;
    for (let o = 0; o < 28; o++) if (outsPmf[o] >= 1e-9) s += outsPmf[o] * fn(o);
    const [a, b] = (M.cal && M.cal[m]) || [0, 1];
    scale[m] = s > 1e-6 ? clamp((a + b * s) / s, 0.3, 3) : 1;
  }
  const sc = (fn, k) => (o) => fn(o) * scale[k];
  const means = {
    k: sc(raw0.k, 'k'), phiK: phi.k,
    h: sc(raw0.h, 'hits'), phiH: phi.hits,
    bb: sc(raw0.bb, 'bb'), phiBB: phi.bb,
    er: sc(raw0.er, 'er'), phiER: phi.er,
  };
  const dist = assembleDist(outsPmf, means);

  let mOuts = 0, mH = 0, mBB = 0, mER = 0, mK = 0;
  for (let o = 0; o < 28; o++) {
    const w = outsPmf[o];
    if (w < 1e-9) continue;
    mOuts += o * w;
    mK += w * means.k(o); mH += w * means.h(o); mBB += w * means.bb(o); mER += w * means.er(o);
  }
  return {
    dist, rates, muOuts,
    projOuts: mOuts, projBF: mOuts / rates.Q,
    projK: mK, projH: mH, projBB: mBB, projER: mER,
  };
}

// ── the shipped model, on the same rows ─────────────────────────────────────
const SP_TO_LEAGUE_H = 1.0187, SP_TO_LEAGUE_K = 0.9871, SP_TO_LEAGUE_BB = 0.9266;

/**
 * Rebuild `projectPitcher`'s own inputs for a start, exactly as
 * tools/backtest-pitchers.mjs does, so the baseline is measured on identical
 * rows rather than quoted from an earlier document.
 */
export function baselineInput(raw, s, cache) {
  const logs = raw.pitcherLogs.get(s.id) || [];
  const sum = (season) => {
    const o = { gamesStarted: 0, gamesPlayed: 0, battersFaced: 0, strikeOuts: 0, baseOnBalls: 0, hits: 0, homeRuns: 0, numberOfPitches: 0, earnedRuns: 0, outs: 0, strikes: 0 };
    for (const g of logs) {
      if (g.season !== season) continue;
      if (season === s.season && g.date >= s.date) continue;
      for (const k of Object.keys(o)) o[k] += g.stat[k] || 0;
    }
    if (!o.gamesPlayed) return null;
    const ip = o.outs / 3;
    return {
      ...o,
      inningsPitched: `${Math.floor(o.outs / 3)}.${o.outs % 3}`,
      era: ip > 0 ? ((9 * o.earnedRuns) / ip).toFixed(2) : '-.--',
      strikePercentage: o.numberOfPitches ? (o.strikes / o.numberOfPitches).toFixed(3).replace(/^0/, '') : undefined,
    };
  };
  const gameLog = logs
    .filter((g) => g.season === s.season && g.date < s.date && g.stat.gamesStarted > 0)
    .map((g) => ({ ip: g.stat.outs / 3, pitches: g.stat.numberOfPitches, bf: g.stat.battersFaced, k: g.stat.strikeOuts, date: g.date }));
  // Opponent team rates, season to date.
  const tl = raw.teamLogs.get(`${s.oppId}:${s.season}`) || [];
  let pa = 0, k = 0, bb = 0, h = 0, ab = 0;
  for (const g of tl) {
    if (g.date >= s.date) continue;
    const st = g.stat;
    pa += +st.plateAppearances || 0; k += +st.strikeOuts || 0; bb += +st.baseOnBalls || 0; h += +st.hits || 0; ab += +st.atBats || 0;
  }
  // League, season to date, as loadSlate builds it.
  const key = `${s.season}:${s.date}`;
  let lg = cache.get(key);
  if (!lg) {
    let Pa = 0, K = 0, Bb = 0, H = 0, Ab = 0;
    for (const [mk, logsT] of raw.teamLogs) {
      if (!mk.endsWith(`:${s.season}`)) continue;
      for (const g of logsT) {
        if (g.date >= s.date) continue;
        const st = g.stat;
        Pa += +st.plateAppearances || 0; K += +st.strikeOuts || 0; Bb += +st.baseOnBalls || 0; H += +st.hits || 0; Ab += +st.atBats || 0;
      }
    }
    lg = Pa ? {
      ...LEAGUE_AVG, kRate: K / Pa, bbRate: Bb / Pa, avg: H / Ab,
      spHRate: (H / Pa) * SP_TO_LEAGUE_H, spKRate: (K / Pa) * SP_TO_LEAGUE_K, spBbRate: (Bb / Pa) * SP_TO_LEAGUE_BB,
    } : { ...LEAGUE_AVG };
    cache.set(key, lg);
  }
  return {
    season26: sum(s.season),
    season25: sum(s.season - 1),
    gameLog,
    opp: pa ? { kRate: k / pa, bbRate: bb / pa, avg: h / ab } : null,
    park: s.venue,
    lg,
    isHome: s.isHome,
  };
}

export function baselineProject(raw, s, cache) {
  return projectPitcher(baselineInput(raw, s, cache));
}

export { parseInningsPitched };
