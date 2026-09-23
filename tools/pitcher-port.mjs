// The reproduction check for docs/PITCHER-PORT.md.
//
//   node tools/pitcher-port.mjs --cache .work/cache --kcache .work/kcache \
//     [--decision-min 120] [--json .work/port.json]
//
// Replays the holdout window (2026-09-02 .. 2026-09-22) against the real
// Kalshi decision-time prices the study used, and scores FOUR models on
// identical contracts:
//
//   ported        src/model/pitcher.js as it now stands, fed the way
//                 src/data/loadSlate.js feeds it (the nine posted batters
//                 through `lineupOpponent`, with the team aggregate behind it)
//   v36 board     tools/pitcher-model-v1.mjs — the FROZEN shipped model — fed
//                 exactly the same inputs. This is the control. It is frozen
//                 because the study's control was `src/model/pitcher.js`
//                 itself, and once the port lands that import is the new model
//                 measuring itself.
//   v36 team opp  the same frozen model fed the opponent's TEAM season rates,
//                 which is what the study's `baselineProject` did. It is here
//                 only to reproduce the study's own "shipped" column and to
//                 show how much of the study's headline the board already had.
//   decision-time the ported model with the opponent read from the most recent
//                 card posted BEFORE tonight, never tonight's own — what a
//                 board loaded at T-120 usually has.
//
// Public MLB StatsAPI and cached public Kalshi only. No orders, no Odds API.

import fs from 'node:fs';
import path from 'node:path';
import { loadRaw, buildStarts, argOf } from './pitcher-data.mjs';
import { boardInput, previousCard } from './pitcher-board.mjs';
import { priceRows, quoteRows, SPLIT, SERIES, splitOf } from './pitcher-edge.mjs';
import { brierDiff } from './kalshi-common.mjs';
import { projectPitcher, PITCHER_FIT as FIT_CONST } from '../src/model/pitcher.js';
import { projectPitcherV1 } from './pitcher-model-v1.mjs';

const CACHE = argOf('cache', path.resolve('.work/cache'));
const DECISION_MIN = Number(argOf('decision-min', 120));
const BOOT = Number(argOf('boot', 20000));
const JSON_OUT = argOf('json', null);

const raw = await loadRaw({ cacheDir: CACHE, seasons: [2025, 2026], through: SPLIT.HOLD_END });
const starts = buildStarts(raw);
const lgCache = new Map();

const hold = [];
for (let i = 0; i < starts.length; i++) if (splitOf(starts[i]) === 'hold') hold.push(i);
console.log(`holdout ${SPLIT.HOLD_START} .. ${SPLIT.HOLD_END}: ${hold.length} starts, decision T-${DECISION_MIN}`);

// ── the four input sets ─────────────────────────────────────────────────────
const boardIn = new Map();
const teamIn = new Map();
const priorIn = new Map();
let cardsFound = 0;
for (const i of hold) {
  boardIn.set(i, boardInput(raw, starts[i], lgCache));
  teamIn.set(i, boardInput(raw, starts[i], lgCache, { teamOpp: true }));
  const prev = previousCard(raw, starts[i]);
  if (prev.length) cardsFound++;
  priorIn.set(i, boardInput(raw, starts[i], lgCache, { lineup: prev }));
}
const usedLineup = (m) => hold.filter((i) => m.get(i).opp?.source === 'lineup').length;
console.log(`opponent source — tonight's card usable for ${usedLineup(boardIn)} of ${hold.length} starts; ` +
  `a previously-posted card existed for ${cardsFound} and was usable for ${usedLineup(priorIn)}`);

const MODELS = {
  ported: (i) => projectPitcher(boardIn.get(i)),
  'v36 board': (i) => projectPitcherV1(boardIn.get(i)),
  'v36 team opp': (i) => projectPitcherV1(teamIn.get(i)),
  'ported, previous card': (i) => projectPitcher(priorIn.get(i)),
  'v36 board, previous card': (i) => projectPitcherV1(priorIn.get(i)),
  // Attribution, for the per-term table in docs/PITCHER-PORT.md. Each one
  // switches a single ported term back off; nothing here was chosen on this
  // window, it is only being taken apart.
  'no depthK': (i) => projectPitcher({ ...boardIn.get(i), tuning: { depthK: false } }),
  'no workDecay': (i) => projectPitcher({ ...boardIn.get(i), tuning: { workDecay: false } }),
  'v36 budgetSpread': (i) => projectPitcher({ ...boardIn.get(i), tuning: { budgetSpread: 18 } }),
  'v36 calibration': (i) => projectPitcher({ ...boardIn.get(i), fit: { ...FIT_CONST, cal: null, progress: null }, tuning: { hLevel: 0.97 } }),
  'v36 opponent': (i) => projectPitcher({ ...boardIn.get(i), fit: { ...FIT_CONST, opp: null } }),
};
const cached = {};
for (const [name, fn] of Object.entries(MODELS)) {
  const m = new Map();
  for (const i of hold) m.set(i, fn(i));
  cached[name] = m;
}

// ── the priced contracts ────────────────────────────────────────────────────
const { rows, coverage } = await priceRows({
  raw, starts, from: SPLIT.HOLD_START, to: SPLIT.HOLD_END,
  project: (i) => cached.ported.get(i) || null,
});
console.log('coverage:', JSON.stringify({ marketsInWindow: coverage.marketsInWindow, matched: coverage.matched, skip: coverage.skip }));
const quoted = quoteRows(rows, DECISION_MIN);
const q = quoted.filter((r) => r.dq?.bid != null && r.dq?.ask != null && (r.settle === 0 || r.settle === 1));
console.log(`two-sided decision quote and binary settlement: ${q.length} of ${rows.length}`);

const clip = (p) => Math.min(0.999, Math.max(0.001, p));
const pairs = q.map((r) => {
  const o = { cluster: r.cluster, series: r.series, y: r.settle, market: clip(r.dq.mid / 100) };
  for (const name of Object.keys(MODELS)) {
    o[name] = clip(cached[name].get(r.startIdx).dist[r.market](r.threshold - 0.5));
  }
  return o;
});

// ── the tables ──────────────────────────────────────────────────────────────
const SLICES = [['pooled', null], ...Object.entries(SERIES).map(([k, s]) => [`${k} ${s.label}`, k])];
const brier = (list, key) => list.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / list.length;
const fmt = (d) => `${d.point >= 0 ? '+' : ''}${d.point.toFixed(4)} [${d.ci95[0] >= 0 ? '+' : ''}${d.ci95[0].toFixed(4)}, ${d.ci95[1] >= 0 ? '+' : ''}${d.ci95[1].toFixed(4)}]`;

const out = { decisionMin: DECISION_MIN, n: pairs.length, coverage: { ...coverage, settleDisagrees: coverage.settleDisagrees.length }, table: {} };

function table(title, a, b) {
  console.log(`\n--- ${title} (negative = "${a}" forecasts better) ---`);
  const rowsOut = {};
  for (const [label, series] of SLICES) {
    const list = series ? pairs.filter((r) => r.series === series) : pairs;
    if (!list.length) continue;
    const d = brierDiff(list, a, b, { boot: BOOT });
    rowsOut[label] = { n: list.length, a: brier(list, a), b: brier(list, b), diff: d };
    console.log(`${label.padEnd(26)} n=${String(list.length).padStart(4)}  ${a} ${brier(list, a).toFixed(4)}  ${b} ${brier(list, b).toFixed(4)}  diff ${fmt(d)}`);
  }
  out.table[`${a} vs ${b}`] = rowsOut;
}

// Leg 1: does the port beat the model it replaces, on identical contracts?
table('PORTED vs the frozen v36, both fed the board\'s own inputs', 'ported', 'v36 board');
// The study's own comparison, reproduced: its candidate was measured against a
// baseline fed team rates, which is not what the board has had since v33.
table('the study\'s baseline: frozen v36 on TEAM opponent rates', 'v36 board', 'v36 team opp');
// Leg 2: what the board actually gets, with only a previously-posted card.
table('DECISION-TIME: ported on the previous card vs frozen v36 on the same', 'ported, previous card', 'v36 board, previous card');
table('decision-time cost: previous card vs tonight\'s, ported', 'ported, previous card', 'ported');
// And the verdict that does not move.
for (const v of ['no depthK', 'no workDecay', 'v36 budgetSpread', 'v36 calibration', 'v36 opponent']) {
  table(`attribution: ported vs ported with "${v}"`, 'ported', v);
}
table('ported vs the exchange decision mid', 'ported', 'market');
table('frozen v36 vs the exchange decision mid', 'v36 board', 'market');

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
}
