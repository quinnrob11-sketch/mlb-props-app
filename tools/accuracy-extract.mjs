// Replay the SHIPPED models against what actually happened, and write one
// compact record per projection so `tools/accuracy-report.mjs` can score
// calibration, error and slices without re-projecting.
//
//   node tools/accuracy-extract.mjs --kind pitchers --from 2026-03-20 --to 2026-09-22 \
//     --cache .backtest-cache --out .backtest-cache/acc_p_2026.ndjson
//   node tools/accuracy-extract.mjs --kind batters  --from 2026-08-01 --to 2026-08-31 \
//     --cache .backtest-cache --out .backtest-cache/acc_b_2026-08.ndjson
//   node tools/accuracy-extract.mjs --kind games --features .backtest-cache/features_2026.json \
//     --params .backtest-cache/params-core.json --src --lineup posted --weather recorded \
//     --out .backtest-cache/acc_g_2026.ndjson
//
// This is NOT a new replay. It imports the existing lookahead-free replays —
// `tools/backtest-pitchers.mjs`, `tools/backtest-batters.mjs` and
// `tools/backtest-games-v2.mjs` — and only records what they produce. Every
// as-of rule, every caveat and every cache lives in those files.
//
// The batter replay holds one boxscore per game in memory, so a whole season
// is extracted a month at a time; the files concatenate.

import fs from 'node:fs';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const KIND = arg('kind', 'pitchers');
const OUT = arg('out', null);
if (!OUT) throw new Error('--out is required');
/**
 * `--tuning '{"kLevel":1}'` overrides `PITCHER_TUNING` / `BATTER_TUNING` for
 * the whole extract, so a counterfactual ("what would this market's
 * calibration be without that level factor?") can be MEASURED rather than
 * argued about. It changes nothing that ships.
 */
const TUNING = arg('tuning', null) ? JSON.parse(arg('tuning')) : null;
if (TUNING) process.stderr.write(`tuning override: ${JSON.stringify(TUNING)}\n`);

/** P(X > line) at every line in the ladder, rounded to five places. */
const ladder = (dist, lines) => lines.map((l) => Math.round(1e5 * dist(l)) / 1e5);
const r3 = (x) => (Number.isFinite(x) ? Math.round(1e3 * x) / 1e3 : null);

const out = [];
const push = (o) => out.push(JSON.stringify(o));

// ── pitchers ────────────────────────────────────────────────────────────────
export const PITCHER_LINES = {
  k: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
  outs: [11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5],
  hits: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  bb: [0.5, 1.5, 2.5, 3.5],
  er: [0.5, 1.5, 2.5, 3.5, 4.5],
};
const PITCHER_PROJ = { k: 'projK', outs: 'projOuts', hits: 'projH', bb: 'projBB', er: 'projER' };

async function extractPitchers() {
  const { buildStarts } = await import('./backtest-pitchers.mjs');
  const { projectPitcher } = await import('../src/model/pitcher.js');
  const starts = buildStarts();
  process.stderr.write(`${starts.length} starts\n`);
  for (const s of starts) {
    const proj = projectPitcher(TUNING ? { ...s.input, tuning: TUNING } : s.input);
    const log = s.input.gameLog || [];
    // Days of rest: the gap to his previous start. Visible on the board.
    let rest = null;
    if (log.length) {
      const last = log.map((x) => x.date).sort().at(-1);
      rest = Math.round((Date.parse(s.date) - Date.parse(last)) / 86400000);
    }
    const m = {};
    for (const [mk, lines] of Object.entries(PITCHER_LINES)) {
      m[mk] = [r3(proj[PITCHER_PROJ[mk]]), s.actual[mk === 'hits' ? 'hits' : mk], ladder(proj.dist[mk], lines)];
    }
    push({
      t: 'p',
      d: s.date,
      id: s.id,
      g: s.gamePk,
      h: s.input.isHome ? 1 : 0,
      pk: s.input.park,
      ns: log.length,                                  // starts already on his card
      bf: Number(s.input.season26?.battersFaced || 0), // season-to-date batters faced
      rest,
      ip: r3(proj.projIP),
      m,
    });
  }
}

// ── batters ─────────────────────────────────────────────────────────────────
export const BATTER_LINES = {
  hits: [0.5, 1.5, 2.5],
  tb: [0.5, 1.5, 2.5, 3.5, 4.5],
  hr: [0.5, 1.5],
  rbi: [0.5, 1.5, 2.5],
  hrr: [0.5, 1.5, 2.5, 3.5, 4.5],
  runs: [0.5, 1.5],
  k: [0.5, 1.5, 2.5],
  singles: [0.5, 1.5],
  sb: [0.5],
};
const BATTER_PROJ = {
  hits: 'projH', tb: 'projTB', hr: 'projHR', rbi: 'projRBI',
  hrr: 'projHRR', runs: 'projR', k: 'projK', singles: 'proj1B', sb: 'projSB',
};

async function extractBatters() {
  const { buildRows } = await import('./backtest-batters.mjs');
  const { projectBatter } = await import('../src/model/batter.js');
  const rows = buildRows();
  process.stderr.write(`${rows.length} batter-games\n`);

  // The slot a PROJECTED card would have given him: the slot he batted in the
  // last game he started, within this window. `src/data/projectedLineup.js`
  // builds tonight's guess the same way, from recent batting orders. Used only
  // to price what an unconfirmed lineup costs, never as an input to the row.
  const lastSlot = new Map();
  const bydate = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const prevSlot = new Map();
  for (const r of bydate) {
    const key = `${r.gamePk}:${r.id}`;
    if (lastSlot.has(r.id)) prevSlot.set(key, lastSlot.get(r.id));
    lastSlot.set(r.id, r.slot);
  }

  for (const r of rows) {
    const proj = projectBatter(TUNING ? { ...r.input, tuning: TUNING } : r.input);
    const m = {};
    for (const [mk, lines] of Object.entries(BATTER_LINES)) {
      m[mk] = [r3(proj[BATTER_PROJ[mk]]), r.actual[mk], ladder(proj.dist[mk], lines)];
    }
    const ps = prevSlot.get(`${r.gamePk}:${r.id}`) ?? null;
    // What the same projection would have said from a projected card. Only the
    // point projections are kept; the shape does not change with the slot.
    let alt = null;
    if (ps != null && ps !== r.slot) {
      const p2 = projectBatter({ ...r.input, slot: ps, ...(TUNING ? { tuning: TUNING } : {}) });
      alt = Object.fromEntries(Object.entries(BATTER_PROJ).map(([mk, k]) => [mk, r3(p2[k])]));
    }
    push({
      t: 'b',
      d: r.date,
      id: r.id,
      g: r.gamePk,
      slot: r.slot,
      tm: r.teamId,
      h: r.side === 'home' ? 1 : 0,
      pk: r.park,
      pa26: Number(r.input.season26?.plateAppearances || 0),
      pa: [r3(proj.pa), r.actual.pa],
      ps,
      alt,
      m,
    });
  }
}

// ── games ───────────────────────────────────────────────────────────────────
export const TOTAL_LINES = [6.5, 7.5, 8.5, 9.5, 10.5];
export const SPREAD_POINTS = [-1.5, 1.5];

async function extractGames() {
  const { buildGames } = await import('./backtest-games-v2.mjs');
  const { games, skip } = buildGames();
  process.stderr.write(`${games.length} games, skipped ${JSON.stringify(skip)}\n`);
  for (const x of games) {
    push({
      t: 'g',
      d: x.date,
      g: x.gamePk,
      pk: x.park,
      bs: x.bothStarters ? 1 : 0,
      lu: x.hasLineups ? 1 : 0,
      ml: [Math.round(1e5 * x.model.pHome) / 1e5, x.actual.homeWin],
      runs: [r3(x.model.projAway), x.actual.away, r3(x.model.projHome), x.actual.home],
      tot: [r3(x.model.projAway + x.model.projHome), x.actual.total, ladder((l) => x.model.total(l).over, TOTAL_LINES)],
      mar: [r3(x.model.projHome - x.model.projAway), x.actual.margin, ladder((p) => x.model.spread(p).home, SPREAD_POINTS)],
      nrfi: x.bothStarters && x.actual.firstInningRuns != null
        ? [Math.round(1e5 * x.model.nrfi.nrfiProb) / 1e5, x.actual.firstInningRuns === 0 ? 1 : 0]
        : null,
    });
  }
}

if (KIND === 'pitchers') await extractPitchers();
else if (KIND === 'batters') await extractBatters();
else if (KIND === 'games') await extractGames();
else throw new Error(`unknown --kind ${KIND}`);

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n');
process.stderr.write(`wrote ${out.length} records to ${OUT}\n`);
