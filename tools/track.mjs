// Paper-trade the BOARD and keep the record on disk.
//
//   node tools/track.mjs daily            snapshot today, close + grade yesterday
//   node tools/track.mjs snapshot [date]  record every priced row, as it stands now
//   node tools/track.mjs close    [date]  overwrite the closing prices
//   node tools/track.mjs grade    [date]  settle against the box scores
//   node tools/track.mjs report [--all]   every category, with its interval
//   node tools/track.mjs replay [--rule=shop|sharp|both]   score a rule on the archive
//
// Why this exists. The Kalshi bot paper-trades one venue, and since the market
// weights dropped to their measured values (v36.2) it plans zero orders — so
// what it records is now always "nothing qualified". Meanwhile the rule the
// board actually runs on, one book out of line with the others, was only ever
// recorded into one browser's localStorage. Neither accumulates a record you
// can audit.
//
// This does. It stores EVERY priced row, not only the ones that graded as
// plays, and it stores the inputs (model probability, both sides' best prices,
// how many books) rather than only the verdict. So a rule change does not
// invalidate the history: any later rule can be replayed over these files
// offline, with no further API calls.
//
// Odds cost: snapshot and close route /api/* through the production
// deployment, reusing its CDN cache and the key in Vercel's env rather than
// spending fresh credits per run. Two runs a day is the intended rate.
import fs from 'node:fs';
import path from 'node:path';

import { installFetch } from './local-api.mjs';
import { attachBooks, gameLineBooks } from './sharp.mjs';

const DIR = 'bot/state/track';
const args = process.argv.slice(2);
const cmd = args[0] || 'report';
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const et = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const today = et(new Date());
const yesterday = et(new Date(Date.now() - 864e5));

installFetch('https://mlb-props-app.vercel.app');
const { loadSlate } = await import('../src/data/loadSlate.js');
const { flattenRows } = await import('../src/ui/rows.js');
const { gradeSlate } = await import('../src/data/gradeSlate.js');
const { buildBreakdown, buildExport, MIN_N, MIN_HISTORY } = await import(
  '../src/analysis/profitability.js'
);

const file = (date) => path.join(DIR, `${date}.json`);
const readDay = (date) => {
  try {
    return JSON.parse(fs.readFileSync(file(date), 'utf8'));
  } catch {
    return null;
  }
};
const writeDay = (date, day) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(date), JSON.stringify(day, null, 1));
};
const keyOf = (r) => `${r.gamePk}:${r.playerId ?? r.market}:${r.market}:${r.line}:${r.alt ? 1 : 0}`;
const round = (v, places) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** places) / 10 ** places;

/** Every row the board priced, reduced to what a later replay needs. */
async function rowsFor(date) {
  const slate = await loadSlate({ date, onStatus: () => {}, projectLineups: true });
  const out = [];
  // Per-book two-sided prices. Without these the archive records only the BEST
  // price and a book count, so no Pinnacle-versus-a-soft-book rule could ever
  // be replayed over it — the same gap `nBooksTwoSided` had, closed the same
  // way: before the history accumulates rather than after.
  const gameBooks = await gameLineBooks(slate.games);
  for (const r of attachBooks(flattenRows(slate), gameBooks)) {
    const e = r.edge;
    if (!e || e.modelOver == null) continue;
    out.push({
      key: keyOf(r),
      gamePk: r.gamePk,
      playerId: r.playerId ?? null,
      name: r.name,
      kind: r.kind,
      market: r.market,
      label: r.label || r.market,
      distKey: r.distKey,
      line: r.line,
      alt: r.alt || false,
      matchup: r.matchup,
      gameDate: r.gameDate,
      lineupSource: r.lineupSource ?? null,
      // Inputs, so any later rule can be re-priced from the file alone.
      modelOver: round(e.modelOver, 4),
      fairOver: round(e.fairOver, 4),
      over: r.over ?? null,
      under: r.under ?? null,
      nBooks: e.nBooks ?? null,
      nBooksTwoSided: r.nBooksTwoSided ?? null,
      overBook: r.overBook ?? null,
      underBook: r.underBook ?? null,
      // Every book's two-sided price, `{ DK: [over, under] }`, Pinnacle
      // included when it quotes. Compact on purpose: a pair of integers per
      // book, no labels repeated, no one-sided quotes, no DFS multipliers.
      books: r.books ?? null,
      sharp: e.sharp || false,
      // What the board said at the time.
      side: e.side ?? null,
      verdict: e.verdict,
      odds: e.odds ?? null,
      ev: e.ev == null ? null : round(e.ev, 2),
      edgePts: e.sideEdge == null ? null : round(100 * e.sideEdge, 2),
      book: r.book ?? null,
    });
  }
  return { slate, rows: out };
}

async function snapshot(date) {
  const { slate, rows } = await rowsFor(date);
  const existing = readDay(date);
  // First write wins: the entry price is what was on the board when it first
  // showed the row. Later runs only add rows that are new.
  const byKey = new Map((existing?.rows || []).map((r) => [r.key, r]));
  let added = 0;
  for (const row of rows)
    if (!byKey.has(row.key)) {
      byKey.set(row.key, row);
      added += 1;
    }
  const day = {
    date,
    schema: 'track.day',
    version: 1,
    openedAt: existing?.openedAt || new Date().toISOString(),
    games: slate.games.length,
    rows: [...byKey.values()],
  };
  writeDay(date, day);
  const plays = day.rows.filter((r) => r.verdict && r.verdict !== 'PASS').length;
  console.log(
    `${date}: ${day.rows.length} priced rows (${added} new), ${plays} called plays, ` +
      `${slate.games.length} games | odds ${slate.oddsError || 'ok'}`,
  );
}

async function close(date) {
  const day = readDay(date);
  if (!day) return console.log(`${date}: nothing snapshotted`);
  const { rows } = await rowsFor(date);
  const now = new Map(rows.map((r) => [r.key, r]));
  let updated = 0;
  for (const row of day.rows) {
    const fresh = now.get(row.key);
    if (!fresh) continue;
    row.closeOver = fresh.over;
    row.closeUnder = fresh.under;
    row.closeFairOver = fresh.fairOver;
    row.closeBooks = fresh.books ?? null;
    // CLV is measured on the side the board called, against the price it quoted.
    row.closeOdds = row.side === 'under' ? fresh.under : fresh.over;
    updated += 1;
  }
  day.closedAt = new Date().toISOString();
  writeDay(date, day);
  console.log(`${date}: closing prices on ${updated}/${day.rows.length} rows`);
}

async function grade(date) {
  const day = readDay(date);
  if (!day) return console.log(`${date}: nothing snapshotted`);
  const graded = await gradeSlate({ date, snapshot: { rows: day.rows }, onStatus: () => {} });
  // gradeSlate returns exactly one entry per input row, in order, so the rows
  // are matched by position. Matching by key instead would collide whenever two
  // rows differ only by the side called — they share player, market and line —
  // and the second would silently overwrite the first's result.
  if (graded.length !== day.rows.length)
    throw new Error(`grade: ${graded.length} results for ${day.rows.length} rows`);
  let settled = 0;
  for (const [i, row] of day.rows.entries()) {
    const g = graded[i];
    row.result = g.result;
    row.actual = g.actual ?? null;
    if (['WIN', 'LOSS', 'PUSH'].includes(String(g.result).toUpperCase())) settled += 1;
  }
  day.gradedAt = new Date().toISOString();
  writeDay(date, day);
  console.log(`${date}: graded ${settled}/${day.rows.length} rows`);
}

/**
 * Replay a rule over the whole archive and grade it.
 *
 * The archive stores INPUTS — both sides' best prices, EVERY book's two-sided
 * price, the de-vigged consensus, the book counts — not just what the board
 * decided, so a rule invented later can be scored on history that was recorded
 * before it existed. That is the point of keeping every priced row rather than
 * only the plays.
 *
 *   node tools/track.mjs replay                 the shop rule (default)
 *   node tools/track.mjs replay --rule=sharp    lagging Pinnacle
 *   node tools/track.mjs replay --rule=both     both, side by side
 *
 * Both rules are cousins and the honest question is which is better: "out of
 * line with the consensus of three books" (shop) or "out of line with Pinnacle
 * alone" (sharp). `--rule=both` is that comparison, in one command, on exactly
 * the same graded rows. It needs graded rows to mean anything — see
 * docs/SHARP.md for what counts as enough.
 *
 * Any row with a graded `actual` can be scored on either side, because over
 * wins exactly when the actual clears the line.
 */
async function replay() {
  const minBooks = Number((args.find((a) => a.startsWith('--books=')) || '').split('=')[1] || 3);
  const minEv = Number((args.find((a) => a.startsWith('--min=')) || '').split('=')[1] || 1);
  const rule = (args.find((a) => a.startsWith('--rule=')) || '').split('=')[1] || 'shop';

  const rows = allRows().filter((r) => r.actual != null && r.line != null);
  const nDays = new Set(rows.map((r) => r.date)).size;

  // Shape the stored row the way the shared modules expect, so the replay and
  // the live board run the same code rather than two versions of it.
  const shaped = rows.map((r) => ({ ...r, edge: { fairOver: r.fairOver, nBooks: r.nBooks } }));

  const rules = {
    async shop() {
      const { priceGaps } = await import('../src/analysis/shop.js');
      return {
        label: `SHOP RULE (${minBooks}+ books, EV >= ${minEv}%)`,
        bets: priceGaps(shaped, { minBooks, minEvPct: minEv }),
      };
    },
    async sharp() {
      const { sharpGaps } = await import('../src/analysis/sharp.js');
      return {
        // Held to the SAME EV threshold as the shop rule above, so
        // `--rule=both` compares two rules and not two thresholds. The gap
        // floor stays at its own default and only rejects rounding noise.
        label: `SHARP RULE (lagging Pinnacle, EV >= ${minEv}%)`,
        bets: sharpGaps(shaped, { minEvPct: minEv }),
      };
    },
  };
  const wanted = rule === 'both' ? ['shop', 'sharp'] : [rule];
  for (const name of wanted)
    if (!rules[name]) return console.log(`unknown rule "${name}" — try shop, sharp or both`);

  for (const name of wanted) {
    const { label, bets } = await rules[name]();
    score(label, bets, rows, nDays);
  }
  console.log(
    'At this sample size the numbers above are not evidence of anything; they are a\n' +
      'record. Run "report" for the interval that says whether they mean anything.',
  );
}

/**
 * The number `actual` is compared against for "over".
 *
 * Must match `settleLine` in src/data/gradeSlate.js exactly. A game moneyline
 * or run line settles on the HOME MARGIN against `-line`, not against `line`:
 * the home side covers when margin > -line, and line is 0 for a moneyline. The
 * replay used `row.line` for every row, which graded every game-line bet
 * backwards whenever the line was not zero — invisible while the rule being
 * replayed fired only on player props, and not invisible at all now that the
 * Pinnacle rule fires almost exclusively on game lines.
 */
const settleLine = (row) =>
  row.kind === 'game' && !String(row.market).endsWith('_total') ? -(row.line ?? 0) : row.line;

/** Settle a list of {row, side, odds} against the archive's graded results. */
function score(label, bets, rows, nDays) {
  if (!bets.length)
    return console.log(
      `\n${label}\n  no graded rows match this rule yet (${rows.length} graded rows, ${nDays} day(s))\n`,
    );

  let units = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  const byMarket = {};
  for (const g of bets) {
    const actual = Number(g.row.actual);
    const against = settleLine(g.row);
    const over = actual > against ? 'over' : actual < against ? 'under' : 'push';
    const dec = 1 + (g.odds > 0 ? g.odds / 100 : 100 / -g.odds);
    const u = over === 'push' ? 0 : over === g.side ? dec - 1 : -1;
    units += u;
    if (over === 'push') pushes += 1;
    else if (over === g.side) wins += 1;
    else losses += 1;
    const m = (byMarket[g.row.market] ||= { n: 0, units: 0 });
    m.n += 1;
    m.units += u;
  }
  const decided = wins + losses;
  console.log(`\n${label} — ${bets.length} bet(s) over ${nDays} day(s)\n`);
  console.log(
    `  ${wins}-${losses}${pushes ? '-' + pushes : ''}  ${units >= 0 ? '+' : ''}${units.toFixed(2)} units  ` +
      `ROI ${decided ? ((100 * units) / decided).toFixed(1) : '-'}%\n`,
  );
  for (const [market, m] of Object.entries(byMarket).sort((a, b) => b[1].n - a[1].n))
    console.log(
      `  ${market.padEnd(24)} n=${String(m.n).padStart(4)}  ${m.units >= 0 ? '+' : ''}${m.units.toFixed(2)} units`,
    );
  console.log('');
}

/** Every stored day, oldest first. */
function allRows() {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    const day = readDay(f.replace('.json', ''));
    for (const row of day?.rows || []) rows.push({ ...row, date: day.date });
  }
  return rows;
}

const pct = (v, d = 1) => (v == null ? '   -  ' : `${v >= 0 ? '+' : ''}${(100 * v).toFixed(d)}%`);
const range = (ci) => (ci == null ? '' : `[${pct(ci.low, 0)}, ${pct(ci.high, 0)}]`);
const readOf = (c) =>
  !c.qualified
    ? `${Math.max(0, MIN_N - c.decided)} more`
    : c.proven
      ? 'EDGE'
      : c.roiCi && c.roiCi.high < 0
        ? 'AVOID'
        : 'no signal';

function report() {
  const rows = allRows();
  if (!rows.length) return console.log(`no history in ${DIR} yet — run "daily" first`);
  const out = buildBreakdown(rows);
  const dates = new Set(rows.map((r) => r.date));
  const called = rows.filter((r) => r.verdict && r.verdict !== 'PASS').length;
  console.log(
    `\nPAPER RECORD — ${dates.size} day(s), ${rows.length} priced rows, ` +
      `${called} called plays, ${out.nSettled} settled\n`,
  );
  console.log(out.message + '\n');
  if (out.overall.decided)
    console.log(
      `overall  ${out.overall.wins}-${out.overall.losses}  ROI ${pct(out.overall.roi)} ` +
        `${range(out.overall.roiCi)}  CLV ${out.overall.avgClvCents?.toFixed(2) ?? '-'}c\n`,
    );

  const keys = ['market', 'books', 'verdict', 'kind'];
  const want = args.includes('--all') ? out.dimensions : out.dimensions.filter((d) => keys.includes(d.key));
  for (const dim of want) {
    if (!dim.cells.length) continue;
    console.log(`── ${dim.label} ${'─'.repeat(Math.max(0, 58 - dim.label.length))}`);
    for (const c of dim.cells)
      console.log(
        `  ${String(c.label).padEnd(22)} n=${String(c.decided).padStart(4)} ` +
          `${(c.wins + '-' + c.losses).padStart(8)}  ROI ${pct(c.roi).padStart(7)} ` +
          `${range(c.roiCi).padStart(18)}  CLV ${(c.avgClvCents ?? 0).toFixed(1).padStart(6)}c  ${readOf(c)}`,
      );
    console.log('');
  }
  console.log(
    `A category needs ${MIN_N} settled picks AND an interval clearing zero before it means\n` +
      `anything; the whole history needs ${MIN_HISTORY} before any leader is named.`,
  );
}

/**
 * Hand the record to the site's RESULTS tab.
 *
 * Writes the same envelope its IMPORT JSON button reads, so the disk record and
 * the in-app breakdown are the same history rather than two rival ones.
 */
function exportHistory(out) {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    /* no record yet */
  }
  const days = files
    .map((f) => readDay(f.replace('.json', '')))
    .filter(Boolean)
    // Only rows the board actually called; the rest are inputs kept for
    // re-pricing, and RESULTS has no use for them.
    .map((d) => ({ ...d, rows: d.rows.filter((r) => r.verdict && r.verdict !== 'PASS') }))
    .filter((d) => d.rows.length);
  const payload = buildExport(days);
  fs.writeFileSync(out, JSON.stringify(payload, null, 1));
  console.log(
    `wrote ${out}: ${payload.nDays} day(s), ${payload.nRows} called plays. ` +
      'Load it with IMPORT JSON on the RESULTS tab.',
  );
}

/**
 * Prove the grading path end to end against a game whose box score is known.
 *
 * Not part of `npm test` — it needs the network. It exists because a silent
 * mis-grade corrupts the record permanently, and because an earlier version of
 * this tool did exactly that: it matched results back to rows by a key that
 * left out the side, so two rows differing only by over/under collided and both
 * took the second one's result.
 */
async function selftest() {
  const GAME = 823570; // 2026-09-20 PHI @ NYM
  const expect = [
    ['batter_hits', 'hits', 0.5, 'over', 'LOSS'],   // Lindor: 0 hits
    ['batter_hits', 'hits', 0.5, 'under', 'WIN'],
    ['pitcher_strikeouts', 'k', 4.5, 'over', 'WIN'], // Tong: 5 K
    ['pitcher_strikeouts', 'k', 5.5, 'over', 'LOSS'],
    ['pitcher_outs', 'outs', 14.5, 'under', 'WIN'],  // Tong: 14 outs
  ];
  const rows = expect.map(([market, distKey, line, side], i) => ({
    key: `selftest-${i}`,
    gamePk: GAME,
    playerId: market.startsWith('batter') ? 596019 : 804636,
    name: market.startsWith('batter') ? 'Francisco Lindor' : 'Jonah Tong',
    kind: market.startsWith('batter') ? 'batter' : 'pitcher',
    market,
    label: market,
    distKey,
    line,
    alt: false,
    side,
    verdict: 'LEAN',
    odds: -110,
  }));
  const graded = await gradeSlate({ date: '2026-09-20', snapshot: { rows }, onStatus: () => {} });
  let bad = 0;
  graded.forEach((g, i) => {
    const want = expect[i][4];
    if (g.result !== want) bad += 1;
    console.log(
      `${g.result === want ? 'ok  ' : 'BAD '}${g.name.padEnd(18)} ${g.market.padEnd(20)} ` +
        `${g.side.padEnd(5)} ${g.line} -> ${g.result} (actual ${g.actual}, expected ${want})`,
    );
  });
  console.log(bad ? `${bad} MISGRADED` : 'all correct');
  if (bad) process.exitCode = 1;
}

switch (cmd) {
  case 'snapshot':
    await snapshot(dateArg || today);
    break;
  case 'close':
    await close(dateArg || today);
    break;
  case 'grade':
    await grade(dateArg || yesterday);
    break;
  case 'daily':
    // One command for the scheduler, safe to run several times a day.
    //
    // The close has to be captured on the DAY, near first pitch: the schedule
    // proxy returns nothing for a date once it is past, so yesterday's prices
    // can no longer be read. Every run overwrites the closing prices, so the
    // last run before first pitch is the one that sticks — which is what a
    // closing line is. Grading yesterday needs no slate at all; gradeSlate
    // fetches the box scores itself.
    await snapshot(today);
    await close(today);
    await grade(yesterday);
    break;
  case 'report':
    report();
    break;
  case 'replay':
    await replay();
    break;
  case 'export':
    exportHistory(args.find((a) => a.endsWith('.json')) || 'bot/state/track-export.json');
    break;
  case 'selftest':
    await selftest();
    break;
  default:
    console.log(
      'usage: node tools/track.mjs [daily|snapshot|close|grade|report|replay|export|selftest] [YYYY-MM-DD]\n' +
        '       replay [--rule=shop|sharp|both] [--books=3] [--min=1]',
    );
}
