// Price shopping, with the model switched off entirely.
//
//   node tools/shop.mjs [YYYY-MM-DD] [--min 3] [--books 3] [--all]
//
// Everything this repo measured says the model cannot beat a price
// (docs/AUDIT.md). The one thing it did NOT disprove is books disagreeing with
// each other: when one sportsbook prices a prop away from the consensus of the
// others, that gap is real money and it does not depend on anyone's forecast
// being right.
//
// So this ranks every row by exactly that and nothing else. The "fair" price is
// the de-vigged consensus across the books pricing that line, Pinnacle-weighted,
// which the board already computes. The edge is what one book offers against
// that consensus. The model's opinion is not consulted at any point — two rows
// with identical prices rank identically whatever the projection says.
//
// It is NOT a promise of profit. The consensus is itself an estimate, a stale
// quote looks exactly like a generous one, and nobody has yet measured this
// rule forward. tools/track.mjs is recording it from today so that question
// gets an answer. Until then treat the list as where to look, not what to bet.
import { installFetch } from './local-api.mjs';

const date =
  process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const MIN_EV = arg('--min', 1.5);
const MIN_BOOKS = arg('--books', 3);

installFetch('https://mlb-props-app.vercel.app');
const { loadSlate } = await import('../src/data/loadSlate.js');
const { flattenRows, pickText } = await import('../src/ui/rows.js');

const slate = await loadSlate({ date, onStatus: () => {}, projectLineups: true });
const rows = flattenRows(slate);

const { priceGaps } = await import('../src/analysis/shop.js');
// One implementation, shared with the SHOP tab on the site, so the terminal and
// the board can never disagree about what a gap is.
const shop = priceGaps(rows, { minBooks: MIN_BOOKS, minEvPct: MIN_EV }).map((g) => ({
  ...g,
  name: g.row.name,
  pick: pickText({ ...g.row, edge: { ...g.row.edge, side: g.side } }),
  matchup: g.row.matchup,
}));

const pct = (v) => `${(100 * v).toFixed(1)}%`;
console.log(
  `${date}: ${slate.games.length} games, ${rows.length} rows priced | ` +
    `odds ${slate.oddsError || 'ok'}\n` +
    `${shop.length} side(s) where a book pays more than the consensus of ${MIN_BOOKS}+ books, ` +
    `EV >= ${MIN_EV}%\n`,
);
if (!shop.length) {
  console.log('Nothing today. That is a normal result: it means the books agree.');
} else {
  console.log(
    'EV      BOOK   PRICE   CONSENSUS  THIS BOOK  BKS  PLAY',
  );
  for (const s of shop.slice(0, process.argv.includes('--all') ? shop.length : 25)) {
    console.log(
      `${s.ev.toFixed(1).padStart(5)}%  ${String(s.book).padEnd(5)} ` +
        `${String(s.odds).padStart(6)}  ${pct(s.fair).padStart(8)}   ${pct(s.implied).padStart(8)}  ` +
        `${String(s.books).padStart(3)}  ${s.name} — ${s.pick} (${s.matchup})`,
    );
  }
  console.log(
    '\nCONSENSUS is what the other books say the side is worth, vig removed.\n' +
      'THIS BOOK is what the listed price implies. The gap between them is the whole point;\n' +
      'the model is not consulted anywhere in this list.',
  );
}
