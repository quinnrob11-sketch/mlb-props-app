import { fmt } from '../lib/format.js';
import { pickText } from './rows.js';
import { MIN_BOOKS } from '../analysis/shop.js';

/**
 * SHOP — where one book disagrees with the others.
 *
 * The only board here that does not consult the model at all. Five studies
 * (docs/AUDIT.md) measured the projections against real prices and found no
 * edge; the one idea none of them killed is books disagreeing with each other.
 * A price out of line with the consensus of its peers is money whoever is right
 * about the baseball.
 */
export default function ShopBoard({ gaps, rows }) {
  if (!gaps.length)
    return (
      <div className="notice">
        <b>The books agree today.</b>
        <div className="sub">
          Nothing on this slate is priced far enough from the consensus of {MIN_BOOKS}+ books to
          be worth taking. That is the normal result, not a fault — most days most prices agree,
          and an empty board here is the honest answer rather than a shortage of ideas.
          {rows > 0 && ` ${rows} rows were priced and checked.`}
        </div>
      </div>
    );

  return (
    <>
      <div className="trlegend top">
        <b>This board ignores the model completely.</b> Every row below is here because one book
        pays more than the de-vigged consensus of the others — <i>not</i> because the projection
        likes it. That matters: replayed against real prices the model returned <b>−3.7%</b> over
        1,232 trades, while a price out of line with its peers is worth money whoever is right
        about the baseball. Take the listed book and price, flat stakes. The consensus is itself
        an estimate built from a handful of books, and a stale quote looks exactly like a
        generous one, so this is where to look rather than what to trust.
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th className="num">EV</th>
              <th>Play</th>
              <th>Book</th>
              <th className="num">Price</th>
              <th className="num">Consensus</th>
              <th className="num">This book</th>
              <th className="num">Gap</th>
              <th className="num">Books</th>
            </tr>
          </thead>
          <tbody>
            {gaps.map((g) => (
              <tr key={g.key}>
                <td className="num">
                  <b className="pos">{g.ev.toFixed(1)}%</b>
                </td>
                <td>
                  <div className="pname">
                    {g.row.name} — {pickText({ ...g.row, edge: { ...g.row.edge, side: g.side } })}
                  </div>
                  <div className="psub">
                    {g.row.matchup}
                    {g.row.gameDate ? ` · ${fmt.time(g.row.gameDate)}` : ''}
                  </div>
                </td>
                <td>
                  <span className="book">{g.book}</span>
                </td>
                <td className="num">{fmt.odds(g.odds)}</td>
                <td className="num">{fmt.pct(g.fair)}</td>
                <td className="num dim">{fmt.pct(g.implied)}</td>
                <td className="num">{g.gapPts.toFixed(1)}pts</td>
                <td className="num dim">{g.books}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="psub">
        <b>Consensus</b> is what the other books say the side is worth with the vig removed;{' '}
        <b>this book</b> is what the listed price implies. The difference is the whole reason the
        row is here. Every one of these is being recorded by the paper tracker, so RESULTS will
        eventually say whether shopping actually pays rather than leaving it an argument.
      </div>
    </>
  );
}
