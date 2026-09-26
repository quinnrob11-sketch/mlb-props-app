// Sharp action, as far as this data can honestly show it.
//
//   node tools/sharp.mjs [YYYY-MM-DD] [--min 1] [--all]   scan the live board
//   node tools/sharp.mjs moves [--min 1] [--all]          open -> close, from the archive
//
// READ THIS FIRST. "Sharp action" normally means handle: money percentage,
// ticket percentage, and the reverse line movement you get when the two
// disagree. This project has none of it. Nobody here buys that data, no
// endpoint it calls returns it, and without it reverse line movement is not
// approximable — it is simply not computable. This tool does not pretend.
//
// What it does instead: Pinnacle takes the biggest limits at the thinnest
// margin and moves its number on money rather than on opinion, which is why
// the rest of the market watches it. A soft book still sitting on a price
// Pinnacle has already left is the closest thing to "the sharp money is on
// this side" that two price feeds can support. The rule is in
// src/analysis/sharp.js and consults no model, exactly as src/analysis/shop.js
// does not.
//
// It is NOT a promise. Pinnacle can be the stale one, a two-book comparison is
// thinner than the consensus the shop rule uses, and neither rule has a
// measured record yet. tools/track.mjs archives the per-book prices this needs
// so the question gets an answer; `node tools/track.mjs replay --rule=sharp`
// scores it against the shop rule once there are graded rows. See docs/SHARP.md.
//
// Odds cost: routed through the production deployment like every other tool
// here, so it spends that deployment's CDN cache and not fresh API credits.
import fs from 'node:fs';

import { installFetch } from './local-api.mjs';

const LIVE = 'https://mlb-props-app.vercel.app';
const TRACK_DIR = 'bot/state/track';

/**
 * Per-book two-sided prices for the GAME lines, keyed `gamePk:market:line`.
 *
 * Player props already carry every book's price on the row (`row.venues`).
 * Game lines do not: `priceTeamMarkets` keeps the best price and the list of
 * book NAMES and drops the per-book prices, and that module is not ours to
 * change. So this re-reads the one bulk game-odds response the slate load
 * already fetched — same URL, same CDN cache entry, no extra credits — and
 * parses it with the repo's own parser rather than a second copy of it.
 *
 * First five innings are deliberately not here: they come from a per-event
 * endpoint (one request each) and only two books quote them, so the cost is
 * real and the Pinnacle comparison is unavailable anyway.
 *
 * @param {object[]} games slate games
 * @returns {Promise<Map<string, Record<string, [number, number]>>>}
 */
export async function gameLineBooks(games) {
  const { oddsFetch } = await import('../src/lib/api.js');
  const { matchOddsEvent, parseGameOdds } = await import('../src/data/teamMarkets.js');

  let events = [];
  try {
    const res = await oddsFetch({ endpoint: 'game-odds', books: 'wide' });
    if (Array.isArray(res.body)) events = res.body;
  } catch {
    // Game lines drop out; the prop rows still scan. Never fatal.
  }

  const out = new Map();
  for (const game of games || []) {
    // `matchOddsEvent` wants a raw MLB schedule game; a slate game carries the
    // same two names under different keys.
    const event = matchOddsEvent(events, {
      gameDate: game.gameDate,
      teams: {
        home: { team: { name: game.home?.name } },
        away: { team: { name: game.away?.name } },
      },
    });
    if (!event) continue;
    for (const [market, quotes] of Object.entries(parseGameOdds(event)))
      for (const q of quotes) {
        if (typeof q.over !== 'number' || typeof q.under !== 'number') continue;
        const key = `${game.gamePk}:${market}:${q.point}`;
        const bucket = out.get(key) || out.set(key, {}).get(key);
        bucket[q.book] = [q.over, q.under];
      }
  }
  return out;
}

/**
 * Hang a compact `books` map on every row that has one.
 *
 * `{ DK: [-110, -110], PIN: [-105, -108] }` — two-sided prices only, because a
 * single side cannot be de-vigged and a DFS multiplier is not half of a price.
 * Mutates and returns `rows`.
 *
 * @param {object[]} rows flattened board rows
 * @param {Map<string, Record<string, [number, number]>>} [gameBooks]
 */
export function attachBooks(rows, gameBooks) {
  for (const row of rows || []) {
    const books = {};
    for (const v of row.venues || [])
      if (typeof v.over === 'number' && typeof v.under === 'number')
        books[v.short] = [v.over, v.under];
    const fallback = row.venues?.length
      ? null
      : gameBooks?.get(`${row.gamePk}:${row.market}:${row.line}`);
    const use = Object.keys(books).length ? books : fallback;
    if (use && Object.keys(use).length) row.books = use;
  }
  return rows;
}

/**
 * Today's archive file, when there is one — the only staleness we can measure.
 *
 * Indexed by `gamePk:market:line` rather than by either side's own row key:
 * `tools/track.mjs` and `src/ui/rows.js` build different keys for the same row,
 * and a main line and its alternate rung always differ in `line`.
 */
const rowIndex = (row) => `${row.gamePk}:${row.market}:${row.line}`;

function openingBooks(date) {
  try {
    const day = JSON.parse(fs.readFileSync(`${TRACK_DIR}/${date}.json`, 'utf8'));
    return {
      openedAt: day.openedAt ? new Date(day.openedAt) : null,
      byRow: new Map((day.rows || []).map((r) => [rowIndex(r), r.books || null])),
    };
  } catch {
    return null;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const date =
  args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const num = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const MIN = num('--min', 1);
const LIMIT = args.includes('--all') ? Infinity : 25;
const pct = (v) => `${(100 * v).toFixed(1)}%`;

async function scan() {
  installFetch(LIVE);
  const { loadSlate } = await import('../src/data/loadSlate.js');
  const { flattenRows, pickText } = await import('../src/ui/rows.js');
  const { sharpGaps, SHARP_BOOK } = await import('../src/analysis/sharp.js');

  const slate = await loadSlate({ date, onStatus: () => {}, projectLineups: true });
  const rows = attachBooks(flattenRows(slate), await gameLineBooks(slate.games));
  const withPin = rows.filter((r) => r.books?.[SHARP_BOOK]).length;
  const gaps = sharpGaps(rows, { minGapPts: MIN });

  // The one staleness we can measure. The odds feed's per-book `last_update`
  // is dropped before it reaches any row here and that parser is not ours to
  // change, so "how long has this price stood" can only be answered against
  // our own earlier snapshot of the same day.
  const open = openingBooks(date);
  const heldFor = (gap) => {
    if (!open?.openedAt) return '-';
    const was = open.byRow.get(rowIndex(gap.row))?.[gap.book];
    if (!was || was[0] !== gap.row.books[gap.book][0] || was[1] !== gap.row.books[gap.book][1])
      return '-';
    return `${Math.round((Date.now() - open.openedAt) / 60000)}m`;
  };

  console.log(
    `${date}: ${slate.games.length} games, ${rows.length} rows priced | odds ${slate.oddsError || 'ok'}\n` +
      `${withPin} row(s) carry a two-sided ${SHARP_BOOK} price — only those can be scanned at all.\n` +
      `${gaps.length} soft-book price(s) at least ${MIN} de-vigged point(s) off ${SHARP_BOOK}.\n`,
  );
  if (!gaps.length) {
    console.log(
      withPin
        ? 'Nothing today. That is a normal result: it means the books agree with Pinnacle.'
        : `No ${SHARP_BOOK} prices on this board, so there is no sharp signal to compute. ` +
            'That is a data gap, not a quiet market.',
    );
    return;
  }

  console.log(' GAP     EV     BOOK   PRICE     PIN   THIS BOOK  HELD  PLAY');
  for (const g of gaps.slice(0, LIMIT)) {
    const play = pickText({ ...g.row, edge: { ...g.row.edge, side: g.side } });
    console.log(
      `${g.gapPts.toFixed(1).padStart(4)}pt ${g.ev.toFixed(1).padStart(5)}%  ` +
        `${g.book.padEnd(5)} ${String(g.odds).padStart(6)}  ${pct(g.pinFair).padStart(6)}  ` +
        `${pct(g.bookFair).padStart(9)}  ${heldFor(g).padStart(4)}  ` +
        `${g.row.name} — ${play} (${g.row.matchup})`,
    );
  }
  console.log(
    `\nGAP is de-vigged probability points between ${SHARP_BOOK} and that book on that side.\n` +
      `EV takes ${SHARP_BOOK}'s number as true, which is the rule's assumption written as a number,\n` +
      'not a claim that it holds. HELD is how long that book has shown this exact price since\n' +
      "today's first snapshot; \"-\" means it has moved since, or that nothing was snapshotted yet.\n" +
      'No model is consulted anywhere in this list.',
  );
}

function moves() {
  let files = [];
  try {
    files = fs.readdirSync(TRACK_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return console.log(`no archive in ${TRACK_DIR} yet — run "node tools/track.mjs daily" first`);
  }
  const rows = [];
  for (const f of files) {
    const day = JSON.parse(fs.readFileSync(`${TRACK_DIR}/${f}`, 'utf8'));
    for (const r of day.rows || []) rows.push({ ...r, date: day.date });
  }
  return report(rows, files.length);
}

async function report(rows, nDays) {
  const { lineMoves } = await import('../src/analysis/sharp.js');
  const moved = lineMoves(rows, { minPts: MIN });
  const priced = rows.filter((r) => r.fairOver != null && r.closeFairOver != null).length;
  console.log(
    `\nLINE MOVEMENT — ${nDays} day(s), ${rows.length} archived rows, ${priced} with both an ` +
      `opening and a closing price\n${moved.length} moved at least ${MIN} de-vigged point(s).\n`,
  );
  if (!moved.length) return;
  console.log('  MOVE   TOWARD  OPEN    CLOSE   ROW');
  for (const m of moved.slice(0, LIMIT))
    console.log(
      `  ${((m.movePts > 0 ? '+' : '') + m.movePts.toFixed(1)).padStart(6)}pt ${m.toward.padEnd(6)} ` +
        `${(100 * m.row.fairOver).toFixed(1).padStart(5)}%  ${(100 * m.row.closeFairOver).toFixed(1).padStart(5)}%  ` +
        `${m.row.date} ${m.row.name} ${m.row.label} ${m.row.line}`,
    );
  const over = moved.filter((m) => m.toward === 'over').length;
  console.log(
    `\n${over} moved toward the over, ${moved.length - over} toward the under. MOVE is de-vigged\n` +
      'probability points, so a book widening both sides reads as zero rather than as a move.\n' +
      'WITH THIS MUCH DATA THIS PROVES NOTHING. It is a few days of rows; whether the closing\n' +
      'line is where the truth ends up needs months, and the number above is a record, not a\n' +
      'result. It is here now so that it is correct when there is enough of it.',
  );
}

if (import.meta.main) {
  if (args[0] === 'moves') moves();
  else await scan();
}
