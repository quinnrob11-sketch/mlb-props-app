/**
 * Verification harness for the reconstructed lib modules.
 *
 * Two kinds of check:
 *   1. Mathematical identities that must hold for correct implementations.
 *   2. An "oracle" diff: lines 1-212 of the original minified bundle are
 *      loaded verbatim as a module and every reconstructed function is
 *      compared against its minified counterpart on a grid of inputs.
 *
 * Run: node /tmp/work/recon/verify.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  erf,
  normalCdf,
  poissonPmf,
  poissonCdf,
  binomPmf,
  binomTailOver,
  poissonTailOver,
  negBinomTailOver,
  clamp,
} from "./src/lib/probability.js";
import {
  americanToDecimal,
  impliedProb,
  probToAmerican,
  devig,
  consensusFair,
  kellyFraction,
  blend,
} from "./src/lib/odds.js";
import { PARK_FACTORS, parkFactor } from "./src/lib/parks.js";
import { MARKET_WEIGHT } from "./src/lib/constants.js";

let passed = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function close(name, actual, expected, eps = 1e-12) {
  const good =
    (Number.isNaN(actual) && Number.isNaN(expected)) ||
    Math.abs(actual - expected) <= eps;
  ok(name, good, good ? "" : `got ${actual}, want ${expected}`);
}

/* ------------------------------------------------------------------ */
/* 1. Identity checks                                                  */
/* ------------------------------------------------------------------ */

// clamp
close("clamp inside range", clamp(5, 0, 10), 5);
close("clamp below", clamp(-3, 0, 10), 0);
close("clamp above", clamp(99, 0, 10), 10);

// erf
close("erf(0) = 0", erf(0), 0, 1e-9);
close("erf odd symmetry", erf(-1.234), -erf(1.234), 0);
close("erf(inf) -> 1", erf(6), 1, 1e-7);
close("erf(1) ~ 0.8427008", erf(1), 0.842700792949715, 1.5e-7);

// normalCdf
close("normalCdf(0) = 0.5", normalCdf(0), 0.5, 1e-9);
close("normalCdf symmetry", normalCdf(-1.5) + normalCdf(1.5), 1, 1e-9);
// True Phi(1.96) = 0.9750021048517795; A&S 7.1.26 is only good to ~1.5e-7.
close("normalCdf(1.96) ~ 0.9750021", normalCdf(1.96), 0.9750021048517795, 1e-7);
close("normalCdf shifted/scaled", normalCdf(7, 5, 2), normalCdf(1), 1e-12);
close("normalCdf sd<=0 degenerate", normalCdf(6, 5, 0), 1);
close("normalCdf sd<=0 below", normalCdf(4, 5, 0), 0);

// poissonPmf / poissonCdf
for (const lambda of [0.5, 1, 3.7, 12]) {
  let sum = 0;
  for (let k = 0; k <= 200; k++) sum += poissonPmf(k, lambda);
  close(`poissonPmf sums to 1 (lambda=${lambda})`, sum, 1, 1e-10);
  close(`poissonPmf(0) = e^-lambda (${lambda})`, poissonPmf(0, lambda), Math.exp(-lambda), 1e-15);
  // E[X] = sum_{k>=0} P(X > k)
  let mean = 0;
  for (let k = 0; k <= 300; k++) mean += poissonTailOver(k, lambda);
  close(`poissonTailOver tail-sum = mean (${lambda})`, mean, lambda, 1e-8);
}
close("poissonPmf lambda=0 at k=0", poissonPmf(0, 0), 1);
close("poissonPmf lambda=0 at k=3", poissonPmf(3, 0), 0);

// poissonCdf monotone non-decreasing and -> 1
{
  let prev = -Infinity;
  let monotone = true;
  for (let k = 0; k <= 60; k++) {
    const v = poissonCdf(k, 5.5);
    if (v < prev - 1e-15) monotone = false;
    prev = v;
  }
  ok("poissonCdf monotone non-decreasing", monotone);
  close("poissonCdf -> 1", poissonCdf(200, 5.5), 1, 1e-12);
  close("poissonCdf(-1) = 0", poissonCdf(-1, 5.5), 0);
  ok("poissonCdf capped at 1", poissonCdf(400, 5.5) <= 1);
}

// binomPmf / binomTailOver
for (const [n, p] of [[1, 0.3], [5, 0.5], [20, 0.17], [40, 0.62]]) {
  let sum = 0;
  for (let k = 0; k <= n; k++) sum += binomPmf(k, n, p);
  close(`binomPmf sums to 1 (n=${n}, p=${p})`, sum, 1, 1e-12);
  let mean = 0;
  for (let k = 0; k <= n; k++) mean += binomTailOver(k, n, p);
  close(`binomTailOver tail-sum = n*p (n=${n}, p=${p})`, mean, n * p, 1e-10);
}
for (const p of [0.05, 0.25, 0.5, 0.73, 0.99]) {
  // n = 1: P(X > 0) is exactly p
  close(`binomTailOver n=1 equals p (${p})`, binomTailOver(0, 1, p), p, 1e-14);
  close(`binomTailOver n=1 half-line (${p})`, binomTailOver(0.5, 1, p), p, 1e-14);
}
close("binomPmf out of support (k<0)", binomPmf(-1, 5, 0.4), 0);
close("binomPmf out of support (k>n)", binomPmf(6, 5, 0.4), 0);
close("binomTailOver n<=0", binomTailOver(0, 0, 0.5), 0);
close("binomTailOver p<=0", binomTailOver(0, 5, 0), 0);
close("binomTailOver p>=1", binomTailOver(0, 5, 1), 1);
{
  // monotone decreasing in the line
  let monotone = true;
  let prev = Infinity;
  for (let line = -1; line <= 25; line++) {
    const v = binomTailOver(line, 20, 0.4);
    if (v > prev + 1e-15) monotone = false;
    prev = v;
  }
  ok("binomTailOver monotone decreasing in line", monotone);
}

// negBinomTailOver
for (const [mean, k] of [[1.2, 1.3], [4.5, 1.3], [8, 2.5], [3, 0.7]]) {
  let acc = 0;
  for (let i = 0; i <= 800; i++) acc += negBinomTailOver(i, mean, k);
  close(`negBinomTailOver tail-sum = mean (mu=${mean}, k=${k})`, acc, mean, 1e-6);
}
close("negBinomTailOver mean<=0", negBinomTailOver(1.5, 0), 0);
ok(
  "negBinomTailOver -> poissonTailOver as dispersion grows",
  Math.abs(negBinomTailOver(4.5, 5, 1e7) - poissonTailOver(4.5, 5)) < 1e-4,
  `nb=${negBinomTailOver(4.5, 5, 1e7)} pois=${poissonTailOver(4.5, 5)}`
);
ok(
  "negBinomTailOver fatter tail than Poisson at same mean",
  negBinomTailOver(9.5, 5) > poissonTailOver(9.5, 5)
);
{
  let monotone = true;
  let prev = Infinity;
  for (let line = 0; line <= 30; line++) {
    const v = negBinomTailOver(line, 5);
    if (v > prev + 1e-15) monotone = false;
    prev = v;
  }
  ok("negBinomTailOver monotone decreasing in line", monotone);
}

/* ---- odds ---- */
close("americanToDecimal(+150)", americanToDecimal(150), 2.5);
close("americanToDecimal(-200)", americanToDecimal(-200), 1.5);
close("americanToDecimal(-110)", americanToDecimal(-110), 1 + 100 / 110, 1e-15);
ok("americanToDecimal(null)", americanToDecimal(null) === null);
ok("americanToDecimal(NaN)", americanToDecimal(NaN) === null);

close("impliedProb(+100)", impliedProb(100), 0.5);
close("impliedProb(-110)", impliedProb(-110), 110 / 210, 1e-15);

ok("probToAmerican(0)", probToAmerican(0) === null);
ok("probToAmerican(1)", probToAmerican(1) === null);
close("probToAmerican(0.5)", probToAmerican(0.5), -100);
{
  let roundTrips = true;
  const bad = [];
  for (let a = -2000; a <= 2000; a += 5) {
    if (a > -100 && a < 100) continue; // not real American prices
    // +100 and -100 are the same price (p = 0.5); probToAmerican canonicalises
    // the pick'em to -100, so accept that as a round-trip.
    const expect = a === 100 ? -100 : a;
    const back = probToAmerican(impliedProb(a));
    if (back !== expect) {
      roundTrips = false;
      bad.push(`${a}->${back}`);
    }
  }
  ok("probToAmerican(impliedProb(x)) round-trips", roundTrips, bad.slice(0, 5).join(", "));
}

{
  const d = devig(-110, -110);
  close("devig(-110,-110).fairOver", d.fairOver, 0.5, 1e-15);
  close("devig(-110,-110).vig", d.vig, 2 * (110 / 210) - 1, 1e-15);
  ok("devig(-110,-110).twoSided", d.twoSided === true);
}
{
  const d = devig(-200, 170);
  ok("devig asymmetric favours the favourite", d.fairOver > 0.5 && d.fairOver < 1);
  ok("devig vig positive", d.vig > 0);
}
{
  const over = devig(-110, null);
  const under = devig(null, -110);
  close("devig one-sided over haircut", over.fairOver, 110 / 210 - 0.025, 1e-15);
  close("devig one-sided under mirrors", under.fairOver, 1 - (110 / 210 - 0.025), 1e-15);
  ok("devig one-sided vig null", over.vig === null && under.vig === null);
  ok("devig one-sided not twoSided", !over.twoSided && !under.twoSided);
  const none = devig(null, null);
  ok("devig empty", none.fairOver === null && none.nBooks === undefined);
}

{
  const c = consensusFair([
    { over: -110, under: -110, w: 1 },
    { over: -110, under: -110, w: 3 },
  ]);
  close("consensusFair identical books", c.fairOver, 0.5, 1e-15);
  ok("consensusFair nBooks", c.nBooks === 2);
  ok("consensusFair sharp flag", c.sharp === true);
  const w = consensusFair([
    { over: 100, under: 100 }, // fair 0.5, weight 1
    { over: -300, under: 220, w: 3 },
  ]);
  const heavy = devig(-300, 220).fairOver;
  close("consensusFair weighted mean", w.fairOver, (0.5 * 1 + heavy * 3) / 4, 1e-15);
  const one = consensusFair([{ over: -115, under: null }]);
  ok("consensusFair one-sided fallback", one.nBooks === 1 && one.sharp === false && !one.twoSided);
  const empty = consensusFair([]);
  ok("consensusFair empty", empty.fairOver === null && empty.nBooks === 0);
  const nullish = consensusFair(null);
  ok("consensusFair null-safe", nullish.nBooks === 0);
}

close("kellyFraction p=0.6 @ +100", kellyFraction(0.6, 100), 0.2, 1e-15);
close("kellyFraction at fair price = 0", kellyFraction(0.5, 100), 0, 1e-15);
close("kellyFraction negative edge floors at 0", kellyFraction(0.4, 100), 0);
close("kellyFraction p=0.55 @ -110", kellyFraction(0.55, -110), (0.55 * (100 / 110) - 0.45) / (100 / 110), 1e-15);
ok("kellyFraction null price", kellyFraction(0.6, null) === null);
ok("kellyFraction null prob", kellyFraction(null, 100) === null);

close("blend over at fair price = 0 EV", blend(0.5, 100, "over"), 0, 1e-13);
close("blend under at fair price = 0 EV", blend(0.5, 100, "under"), 0, 1e-13);
close("blend +EV over", blend(0.6, 100, "over"), 20, 1e-13);
close("blend under uses 1-p", blend(0.4, 100, "under"), 20, 1e-13);
ok("blend null price", blend(0.5, null, "over") === null);

/* ---- parks / constants ---- */
close("parkFactor Coors runs w=1", parkFactor("Coors Field", "runs", 1), 1.12, 1e-12);
close("parkFactor Coors runs default w", parkFactor("Coors Field", "runs"), 1 + 0.7 * 0.12, 1e-12);
close("parkFactor Oracle hr default w", parkFactor("Oracle Park", "hr"), 1 + 0.7 * -0.09, 1e-12);
close("parkFactor unknown park", parkFactor("Nowhere Stadium", "hr"), 1);
close("parkFactor unknown key", parkFactor("Coors Field", "doubles"), 1);
close("parkFactor w=0 is neutral", parkFactor("Coors Field", "runs", 0), 1);
ok("PARK_FACTORS venue count", Object.keys(PARK_FACTORS).length === 33, `got ${Object.keys(PARK_FACTORS).length}`);
ok(
  "PARK_FACTORS all five keys present, integer-valued",
  Object.values(PARK_FACTORS).every(
    (f) =>
      ["runs", "hr", "hits", "so", "bb"].every(
        (k) => typeof f[k] === "number" && Number.isInteger(f[k])
      ) && Object.keys(f).length === 5
  )
);
ok("MARKET_WEIGHT key count", Object.keys(MARKET_WEIGHT).length === 15, `got ${Object.keys(MARKET_WEIGHT).length}`);
ok(
  "MARKET_WEIGHT values in (0,1)",
  Object.values(MARKET_WEIGHT).every((v) => v > 0 && v < 1)
);

/* ------------------------------------------------------------------ */
/* 2. Oracle diff against the original minified source                 */
/* ------------------------------------------------------------------ */

const SRC = "/tmp/work/app.js";
const region = readFileSync(SRC, "utf8").split("\n").slice(0, 212).join("\n");
const oraclePath = join(tmpdir(), `recon-oracle-${process.pid}.mjs`);
writeFileSync(
  oraclePath,
  `${region}\nexport { zp, Dp, $p, Hp, Up, ln, Ni, vl, oe, sn, $a, Ei, _i, Kp, bp, Ha, Vp, un, Pi };\n`
);
const O = await import(pathToFileURL(oraclePath).href);
unlinkSync(oraclePath);

const same = (a, b) =>
  (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b) || a === b;

function diff(name, mine, theirs, argSets) {
  const bad = [];
  for (const args of argSets) {
    const a = mine(...args);
    const b = theirs(...args);
    const equal =
      typeof a === "object" && a !== null
        ? JSON.stringify(a) === JSON.stringify(b)
        : same(a, b);
    if (!equal) bad.push(`f(${JSON.stringify(args)}) mine=${JSON.stringify(a)} orig=${JSON.stringify(b)}`);
  }
  ok(`oracle: ${name}`, bad.length === 0, bad.slice(0, 3).join(" | "));
}

const xs = [-3.7, -1, -0.5, 0, 0.25, 0.5, 1, 1.5, 2.5, 3, 4.5, 7, 12.5];
const means = [0.01, 0.4, 1, 2.5, 5.5, 9, 14.3];
const ps = [0.001, 0.05, 0.25, 0.5, 0.73, 0.99];
const ns = [1, 2, 5, 20, 40];
const americans = [-2500, -300, -110, -101, 100, 115, 250, 1200, null, undefined, NaN];
const probs = [0, 0.02, 0.25, 0.5, 0.499999, 0.75, 0.999, 1, null];

diff("erf", erf, O.zp, xs.map((x) => [x]));
diff(
  "normalCdf",
  normalCdf,
  O.Dp,
  xs.flatMap((x) => [[x], [x, 2], [x, 2, 3], [x, 2, 0], [x, 2, -1]])
);
diff("poissonPmf", poissonPmf, O.$p, [0, 1, 2, 3, 7, 15, 40].flatMap((k) => means.concat([0, -1]).map((m) => [k, m])));
diff("poissonCdf", poissonCdf, O.Hp, [-2, -1, 0, 1, 3, 8, 25].flatMap((k) => means.map((m) => [k, m])));
diff("binomPmf", binomPmf, O.Up, ns.flatMap((n) => [-1, 0, 1, 3, n, n + 1].flatMap((k) => ps.map((p) => [k, n, p]))));
diff("binomTailOver", binomTailOver, O.ln, xs.flatMap((x) => ns.concat([0, -1]).flatMap((n) => ps.concat([0, 1, 1.5]).map((p) => [x, n, p]))));
diff("poissonTailOver", poissonTailOver, O.Ni, xs.flatMap((x) => means.concat([0, -1]).map((m) => [x, m])));
diff(
  "negBinomTailOver",
  negBinomTailOver,
  O.vl,
  xs.flatMap((x) => means.concat([0, -1]).flatMap((m) => [[x, m], [x, m, 0.7], [x, m, 2.5], [x, m, 10]]))
);
diff("clamp", clamp, O.oe, [[5, 0, 10], [-3, 0, 10], [99, 0, 10], [NaN, 0, 1], [0.5, 0, 1]]);
diff("americanToDecimal", americanToDecimal, O.sn, americans.concat([0]).map((a) => [a]));
diff("impliedProb", impliedProb, O.$a, americans.concat([0]).map((a) => [a]));
diff("probToAmerican", probToAmerican, O.Ei, probs.concat([NaN, -0.5, 1.5]).map((p) => [p]));
diff("devig", devig, O._i, americans.flatMap((a) => americans.map((b) => [a, b])));
diff("kellyFraction", kellyFraction, O.bp, probs.flatMap((p) => americans.map((a) => [p, a])));
diff("blend", blend, O.Ha, probs.flatMap((p) => americans.flatMap((a) => [[p, a, "over"], [p, a, "under"]])));
diff(
  "parkFactor",
  parkFactor,
  O.un,
  ["Coors Field", "Oracle Park", "Nowhere", "Rate Field"].flatMap((park) =>
    ["runs", "hr", "hits", "so", "bb", "xx"].flatMap((k) => [[park, k], [park, k, 1], [park, k, 0], [park, k, 0.35]])
  )
);
diff(
  "consensusFair",
  consensusFair,
  O.Kp,
  [
    [null],
    [[]],
    [[{ over: -110, under: -110 }]],
    [[{ over: -110, under: -110, w: 3 }, { over: 105, under: -125 }]],
    [[{ over: -115, under: null }]],
    [[{ over: null, under: null }, { over: null, under: -130 }]],
    [[{ over: 100, under: 100 }, { over: -300, under: 220, w: 3 }]],
  ]
);

ok("oracle: PARK_FACTORS deep-equal", JSON.stringify(PARK_FACTORS) === JSON.stringify(O.Vp));
ok("oracle: MARKET_WEIGHT deep-equal", JSON.stringify(MARKET_WEIGHT) === JSON.stringify(O.Pi));

/* ------------------------------------------------------------------ */

console.log(`passed: ${passed}`);
if (failures.length) {
  console.error(`FAILED: ${failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
