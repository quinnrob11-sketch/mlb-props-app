/**
 * Price shopping: where one book disagrees with the others.
 *
 * Everything this repo has measured says the model cannot beat a price
 * (docs/AUDIT.md — 1,232 replayed trades, -3.7%, and the exchange's forecast
 * better than the model's in every series). The one idea five studies did not
 * kill is books disagreeing with EACH OTHER. When a book prices a side away
 * from the consensus of the others, that gap is money, and it does not depend
 * on anyone's forecast being right.
 *
 * So nothing here consults a projection. Two rows with identical prices rank
 * identically whatever the model thinks of them. The only inputs are the
 * de-vigged consensus the board already computes, the best price on each side,
 * and how many books posted a two-way quote.
 *
 * What it is not: a promise. The consensus is itself an estimate built from a
 * handful of books, a stale quote looks exactly like a generous one, and this
 * rule has no measured track record yet — tools/track.mjs began recording the
 * rows it fires on in September 2026 so the question gets an answer rather than
 * an argument.
 */

import { toDecimal } from './profitability.js';

/**
 * Two books is not a consensus: it is one book's opinion of the other, and a
 * single stale quote moves it as far as a real disagreement does.
 */
export const MIN_BOOKS = 3;

/** Below this the gap is inside the noise of the consensus itself. */
export const MIN_EV_PCT = 1;

/**
 * Count of books with a TWO-SIDED price, which is what a de-vigged consensus
 * rests on. `nBooks` counts every book at the line, which is a different and
 * larger number — on one 16-game slate it differed on 495 of 2,148 rows.
 */
export const twoSidedBooks = (row) => row?.nBooksTwoSided ?? row?.edge?.nBooks ?? 0;

/**
 * Every side where a book pays more than the consensus says it should.
 *
 * @param {object[]} rows flattened board rows
 * @param {{minBooks?:number, minEvPct?:number}} [opts]
 * @returns {object[]} ranked best first
 */
export function priceGaps(rows, opts = {}) {
  const minBooks = opts.minBooks ?? MIN_BOOKS;
  const minEv = opts.minEvPct ?? MIN_EV_PCT;
  const out = [];

  for (const row of rows || []) {
    const fairOver = row?.edge?.fairOver;
    if (fairOver == null) continue;
    const books = twoSidedBooks(row);
    if (books < minBooks) continue;

    for (const [side, odds, book, fair] of [
      ['over', row.over, row.overBook, fairOver],
      ['under', row.under, row.underBook, 1 - fairOver],
    ]) {
      const dec = toDecimal(odds);
      if (dec == null || !book) continue;
      const ev = 100 * (fair * dec - 1);
      if (!(ev >= minEv)) continue;
      out.push({
        key: `${row.key ?? `${row.gamePk}:${row.playerId}:${row.market}:${row.line}`}:${side}`,
        row,
        side,
        odds,
        book,
        fair,
        implied: 1 / dec,
        gapPts: 100 * (fair - 1 / dec),
        ev,
        books,
      });
    }
  }

  // Best first, then the wider consensus, then a stable tiebreak so the same
  // board always renders in the same order.
  return out.sort(
    (a, b) => b.ev - a.ev || b.books - a.books || String(a.key).localeCompare(String(b.key)),
  );
}
