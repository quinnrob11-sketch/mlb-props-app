// Fit the home/away coefficients, market by market, on the FIT window only.
//
//   node tools/homefield-fit.mjs --kind pitchers --from 2025-03-20 --to 2025-10-01 \
//     --cache .backtest-cache --sweep '{"homeH":[0,-0.02,-0.04]}' --out .work/hf_p25.json
//
//   node tools/homefield-fit.mjs --report .work/hf_p25.json .work/hf_p26.json
//
// This is NOT a new replay. It imports `tools/backtest-pitchers.mjs` and
// `tools/backtest-batters.mjs` -- the same lookahead-free replays every other
// study on this repository uses -- and only re-projects their rows with a
// different `tuning` object. Every as-of rule and every cache lives there.
//
// Windows, by date, so one run of a season splits itself:
//   fit  <= 2026-08-09   (all of 2025, and 2026 up to the cut)
//   val  2026-08-10..2026-09-01
//   sep  2026-09-02 onward   -- SIGN CHECK ONLY. Eight branches have read that
//                               window today; nothing is selected on it.
//
// Scored over the same standard ladder `tools/accuracy-report.mjs` uses, per
// window and per side of the ballpark: Bernoulli log loss, Brier, the
// calibration gap (mean quoted probability minus the frequency observed, in
// percentage points) and the point bias (actual minus projected).
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

// The ladders in tools/accuracy-extract.mjs. Duplicated rather than imported
// because that module extracts a whole season at import time.
const PITCHER_LINES = {
  k: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
  outs: [11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5],
  hits: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  bb: [0.5, 1.5, 2.5, 3.5],
  er: [0.5, 1.5, 2.5, 3.5, 4.5],
};
const PITCHER_PROJ = { k: 'projK', outs: 'projOuts', hits: 'projH', bb: 'projBB', er: 'projER' };
const BATTER_LINES = {
  hits: [0.5, 1.5, 2.5],
  tb: [0.5, 1.5, 2.5, 3.5, 4.5],
  hr: [0.5, 1.5],
  rbi: [0.5, 1.5, 2.5],
  hrr: [0.5, 1.5, 2.5, 3.5, 4.5],
  runs: [0.5, 1.5],
  k: [0.5, 1.5, 2.5],
  singles: [0.5, 1.5],
};
const BATTER_PROJ = {
  hits: 'projH', tb: 'projTB', hr: 'projHR', rbi: 'projRBI',
  hrr: 'projHRR', runs: 'projR', k: 'projK', singles: 'proj1B',
};

const FIT_TO = '2026-08-09';
const VAL_TO = '2026-09-01';
const windowOf = (d) => (d <= FIT_TO ? 'fit' : d <= VAL_TO ? 'val' : 'sep');

// ---- report mode ----------------------------------------------------------
if (process.argv.includes('--report')) {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
  const merged = new Map(); // term -> value -> window -> side -> market -> acc
  for (const f of files) {
    for (const [term, byValue] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) {
      if (!merged.has(term)) merged.set(term, new Map());
      const M = merged.get(term);
      for (const [v, byWin] of Object.entries(byValue)) {
        if (!M.has(v)) M.set(v, {});
        for (const [w, bySide] of Object.entries(byWin)) {
          M.get(v)[w] ||= {};
          for (const [side, byMkt] of Object.entries(bySide)) {
            M.get(v)[w][side] ||= {};
            for (const [mkt, a] of Object.entries(byMkt)) {
              const t = (M.get(v)[w][side][mkt] ||= { n: 0, nb: 0, ll: 0, br: 0, p: 0, o: 0, proj: 0, act: 0 });
              for (const k of Object.keys(t)) t[k] += a[k];
            }
          }
        }
      }
    }
  }
  const only = arg('markets', null) ? arg('markets').split(',') : null;
  for (const [term, M] of merged) {
    console.log(`\n================ ${term} ================`);
    const all = [...new Set([...M.values()].flatMap((byWin) => Object.keys(byWin.fit ? byWin.fit.all : {})))];
    for (const mkt of only || all) {
      console.log(`\n-- ${mkt}`);
      console.log('  value    | fit logloss   brier     gap H/A (pts)    bias H/A       | val logloss  gap H/A        | sep gap H/A');
      for (const [v, byWin] of [...M].sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const cell = (w, side) => (byWin[w] && byWin[w][side] ? byWin[w][side][mkt] : null);
        const g = (w, side) => { const a = cell(w, side); return a ? (100 * (a.p - a.o)) / a.nb : NaN; };
        const bi = (w, side) => { const a = cell(w, side); return a ? (a.act - a.proj) / a.n : NaN; };
        const f = cell('fit', 'all');
        const vv = cell('val', 'all');
        if (!f) continue;
        const num = (x, w, p) => (Number.isFinite(x) ? x.toFixed(p) : '-').padStart(w);
        console.log(
          `  ${String(v).padStart(7)} | ${(f.ll / f.nb).toFixed(5)}  ${(f.br / f.nb).toFixed(5)}  ` +
          `${num(g('fit', 'home'), 6, 2)}/${num(g('fit', 'away'), 6, 2)}  ` +
          `${num(bi('fit', 'home'), 7, 3)}/${num(bi('fit', 'away'), 7, 3)} | ` +
          `${vv ? (vv.ll / vv.nb).toFixed(5) : '   -   '}  ` +
          `${num(g('val', 'home'), 6, 2)}/${num(g('val', 'away'), 6, 2)} | ` +
          `${num(g('sep', 'home'), 6, 2)}/${num(g('sep', 'away'), 6, 2)}`,
        );
      }
    }
  }
  process.exit(0);
}

// ---- sweep mode -----------------------------------------------------------
const KIND = arg('kind', 'pitchers');
const OUT = arg('out', null);
if (!OUT) throw new Error('--out is required');
const SWEEP = JSON.parse(arg('sweep', '{}'));
/** Coefficients held fixed while each term in `--sweep` is moved. */
const BASE = JSON.parse(arg('base', '{}'));

const LINES = KIND === 'pitchers' ? PITCHER_LINES : BATTER_LINES;
const PROJ = KIND === 'pitchers' ? PITCHER_PROJ : BATTER_PROJ;

let rows;
let project;
if (KIND === 'pitchers') {
  const { buildStarts } = await import('./backtest-pitchers.mjs');
  const { projectPitcher } = await import('../src/model/pitcher.js');
  project = projectPitcher;
  rows = buildStarts().map((s) => ({ d: s.date, home: !!s.input.isHome, input: s.input, actual: s.actual }));
} else {
  const { buildRows } = await import('./backtest-batters.mjs');
  const { projectBatter } = await import('../src/model/batter.js');
  project = projectBatter;
  rows = buildRows().map((r) => ({ d: r.date, home: r.side === 'home', input: r.input, actual: r.actual }));
}
process.stderr.write(`${rows.length} rows\n`);

function score(tuning) {
  const acc = {};
  const bucket = (w, side, mkt) => {
    acc[w] ||= {};
    acc[w][side] ||= {};
    return (acc[w][side][mkt] ||= { n: 0, nb: 0, ll: 0, br: 0, p: 0, o: 0, proj: 0, act: 0 });
  };
  for (const r of rows) {
    const w = windowOf(r.d);
    const proj = project({ ...r.input, tuning });
    for (const [mkt, lines] of Object.entries(LINES)) {
      const mean = proj[PROJ[mkt]];
      const a = r.actual[mkt];
      if (!Number.isFinite(mean) || !Number.isFinite(a)) continue;
      const dist = proj.dist[mkt];
      if (!dist) continue;
      for (const side of ['all', r.home ? 'home' : 'away']) {
        const t = bucket(w, side, mkt);
        t.n++; t.proj += mean; t.act += a;
        for (const line of lines) {
          const p = dist(line);
          const o = a > line ? 1 : 0;
          t.nb++; t.p += p; t.o += o;
          t.br += (p - o) ** 2;
          t.ll += -Math.log(Math.max(1e-9, o ? p : 1 - p));
        }
      }
    }
  }
  return acc;
}

const out = {};
for (const [term, values] of Object.entries(SWEEP)) {
  out[term] = {};
  for (const v of values) {
    process.stderr.write(`${term} = ${v}\n`);
    out[term][v] = score({ ...BASE, [term]: v });
  }
}
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
process.stderr.write(`wrote ${OUT}\n`);
