/**
 * Sharp action: a soft book lagging Pinnacle's number.
 *
 * WHAT THIS IS NOT. The phrase "sharp action" usually means handle: what share
 * of the money, and what share of the tickets, went to each side, and the
 * reverse line movement you get when those two disagree. This project has none
 * of that. Handle and ticket counts are sold by services it does not subscribe
 * to, they appear in no endpoint it calls, and without them reverse line
 * movement cannot be computed at all — not approximately, not at all. Any tool
 * here claiming to show it would be inventing it.
 *
 * WHAT IS LEFT, and it is not nothing: Pinnacle takes the largest limits at the
 * smallest margin and moves on money rather than on opinion, which is why the
 * rest of the market watches its number. A soft book still sitting on a price
 * Pinnacle has already left is the most defensible "you are on the same side as
 * the money" signal this data supports. It is a statement about two prices, not
 * about anybody's handle, and that is exactly why it can be measured.
 *
 * Model-free, like its cousin src/analysis/shop.js: no projection is consulted
 * anywhere, and two rows with identical prices rank identically whatever the
 * model thinks of them (test/sharp.test.js pins this).
 *
 * The difference between the two rules is one line of code and the whole
 * question: `shop` compares a book against the de-vigged consensus of every
 * book at the line, `sharp` compares it against Pinnacle alone. Which is better
 * is an empirical question with no answer yet — see docs/SHARP.md.
 */

import { americanToDecimal, devig } from '../lib/odds.js';

/** Short label of the reference book. Matches `BOOK_LABEL.pinnacle`. */
export const SHARP_BOOK = 'PIN';

/** Below this the gap is inside the noise of two books rounding differently. */
export const MIN_GAP_PTS = 1;

/**
 * @typedef {object} BookPrice
 * @property {string} book Short label, e.g. "DK".
 * @property {number} over American odds.
 * @property {number} under American odds.
 */

/**
 * Every two-sided price on a row, by book.
 *
 * Reads whichever shape the caller has: the compact `books` map the archive
 * stores (`{DK: [-110, -110]}`), or the live board's `venues` array. One-sided
 * quotes and DFS multipliers are dropped — a side without its opposite cannot
 * be de-vigged, and a payout multiplier is not half of a price.
 *
 * @param {object} row
 * @returns {BookPrice[]}
 */
export function bookPrices(row) {
  const out = [];
  const add = (book, over, under) => {
    if (!book) return;
    if (typeof over !== 'number' || typeof under !== 'number') return;
    out.push({ book: String(book), over, under });
  };
  for (const [book, pair] of Object.entries(row?.books || {})) add(book, pair?.[0], pair?.[1]);
  if (!out.length) for (const v of row?.venues || []) add(v.short, v.over, v.under);
  return out;
}

/**
 * @typedef {object} SharpGap
 * @property {string} key Row key plus book and side, stable across runs.
 * @property {object} row The row this came from.
 * @property {"over"|"under"} side The side Pinnacle's number implies.
 * @property {string} book The soft book lagging.
 * @property {number} odds That book's American price on `side`.
 * @property {number} pinFair Pinnacle's de-vigged probability of `side`.
 * @property {number} bookFair The soft book's de-vigged probability of `side`.
 * @property {number} gapPts Probability points between them, after the vig.
 * @property {number} ev Percent of stake, taking Pinnacle's number as true.
 * @property {number} nBooks Two-sided books on the row, Pinnacle included.
 */

/**
 * Rank every soft book sitting off Pinnacle's de-vigged number.
 *
 * Both books are de-vigged before they are compared, so a book with a fat hold
 * does not read as disagreement. The gap is signed onto one side by
 * construction: if Pinnacle makes the over likelier than the soft book does,
 * the over is the lagging side, and the under gap is the same number negated.
 *
 * `ev` takes Pinnacle's de-vigged number as the true probability. That is the
 * rule's whole assumption stated as a number, not a claim that it is right.
 *
 * `minEvPct` exists so this rule can be held to the SAME threshold as
 * src/analysis/shop.js in a head-to-head replay. Gap points and EV percent are
 * different units; comparing the two rules at "1" of each would be comparing
 * two different questions.
 *
 * @param {object[]} rows
 * @param {{minGapPts?: number, minEvPct?: number, sharpBook?: string}} [opts]
 * @returns {SharpGap[]} widest gap first.
 */
export function sharpGaps(rows, opts = {}) {
  const minGap = opts.minGapPts ?? MIN_GAP_PTS;
  const minEv = opts.minEvPct ?? -Infinity;
  const sharpBook = opts.sharpBook ?? SHARP_BOOK;
  const out = [];

  for (const row of rows || []) {
    const prices = bookPrices(row);
    const pin = prices.find((p) => p.book === sharpBook);
    if (!pin) continue;
    const pinOver = devig(pin.over, pin.under).fairOver;
    if (pinOver == null) continue;

    for (const soft of prices) {
      if (soft.book === sharpBook) continue;
      const softOver = devig(soft.over, soft.under).fairOver;
      if (softOver == null) continue;

      // The lagging side is the one Pinnacle prices higher than this book does.
      const side = pinOver > softOver ? 'over' : 'under';
      const pinFair = side === 'over' ? pinOver : 1 - pinOver;
      const bookFair = side === 'over' ? softOver : 1 - softOver;
      const gapPts = 100 * (pinFair - bookFair);
      if (!(gapPts >= minGap)) continue;

      const odds = side === 'over' ? soft.over : soft.under;
      const dec = americanToDecimal(odds);
      if (dec == null) continue;
      const ev = 100 * (pinFair * dec - 1);
      if (!(ev >= minEv)) continue;

      out.push({
        key: `${row.key ?? `${row.gamePk}:${row.market}:${row.line}`}:${soft.book}:${side}`,
        row,
        side,
        book: soft.book,
        odds,
        pinFair,
        bookFair,
        gapPts,
        ev,
        nBooks: prices.length,
      });
    }
  }

  // Widest gap first, then the better price, then a stable tiebreak so the same
  // board always renders in the same order.
  return out.sort(
    (a, b) => b.gapPts - a.gapPts || b.ev - a.ev || String(a.key).localeCompare(String(b.key)),
  );
}

/**
 * @typedef {object} LineMove
 * @property {object} row
 * @property {number} movePts De-vigged probability points the over gained
 *   between the opening and closing snapshot. Negative favours the under.
 * @property {"over"|"under"|"none"} toward Which side the move favoured.
 */

/**
 * How each archived row's price moved from open to close.
 *
 * Measured on the de-vigged consensus, not on the raw American price: a book
 * can move -110/-110 to -105/-115 without changing the total, and that is a
 * real move, while a book widening both sides is only charging more vig.
 *
 * `tools/track.mjs` writes the opening price on the first snapshot of the day
 * and overwrites the closing price on every later run, so these two numbers
 * bracket the day whether it was snapshotted twice or ten times.
 *
 * @param {object[]} rows archived rows (see tools/track.mjs)
 * @param {{minPts?: number}} [opts]
 * @returns {LineMove[]} biggest move first.
 */
export function lineMoves(rows, opts = {}) {
  const minPts = opts.minPts ?? 0;
  const out = [];
  for (const row of rows || []) {
    if (row?.fairOver == null || row?.closeFairOver == null) continue;
    const movePts = 100 * (row.closeFairOver - row.fairOver);
    if (Math.abs(movePts) < minPts) continue;
    out.push({
      row,
      movePts,
      toward: movePts > 0 ? 'over' : movePts < 0 ? 'under' : 'none',
    });
  }
  return out.sort(
    (a, b) =>
      Math.abs(b.movePts) - Math.abs(a.movePts) ||
      String(a.row.key).localeCompare(String(b.row.key)),
  );
}
