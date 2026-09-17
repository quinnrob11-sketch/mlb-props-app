// Do the VENUES disagree with each other enough to be worth trading?
//
//   node tools/venue-gap.mjs [YYYY-MM-DD] [--live]
//
// The model has no measured edge against Kalshi (docs/KALSHI-BACKTEST.md,
// docs/KALSHI-BATTER-BACKTEST.md). A price difference between two venues does
// not need the model to be right about anything: if the sportsbook consensus
// says 55% and Kalshi's ask implies 48% for the SAME contract, the cheaper side
// is better than that consensus by 7 points whatever the model thinks.
//
// This measures how often that happens, and how big the gaps are after costs:
//
//   book fair     de-vigged consensus across the sportsbooks pricing that line
//                 (the same `consensusFair` the board uses)
//   kalshi cost   what you actually pay on Kalshi for the same side, fee
//                 included (ask + fee), as a probability
//   gap           book fair - kalshi cost, in probability points. Positive means
//                 Kalshi sells that side cheaper than the books' own consensus.
//
// A positive gap is not automatically profit: the consensus is itself an
// estimate, Kalshi depth is thin, and both move. It is a measurement of how far
// apart two independent markets sit right now.
import { installFetch } from './local-api.mjs';
import { feePerContractCents } from '../src/trade/fees.js';
import { seriesForMarket, matchKalshiMarket, normalizeMarket } from '../src/lib/kalshi.js';

const date =
  process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
installFetch(process.argv.includes('--live') ? 'https://mlb-props-app.vercel.app' : undefined);

const { loadSlate } = await import('../src/data/loadSlate.js');
const { flattenRows } = await import('../src/ui/rows.js');
const { createClient } = await import('../bot/kalshiClient.mjs');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const kalshiDateSegment = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${y.slice(2)}${MONTHS[Number(m) - 1]}${d}`;
};

const slate = await loadSlate({ date, onStatus: () => {} });
const rows = flattenRows(slate).filter((r) => r.kind === 'pitcher' || r.kind === 'batter');
console.log(`${date}: ${slate.games.length} games, ${rows.length} prop rows, odds ${slate.oddsError || 'ok'}`);

const client = createClient({ env: 'prod' });
const series = [...new Set(rows.map((r) => seriesForMarket(r.market)).filter(Boolean))];
const markets = [];
for (const s of series) markets.push(...(await client.markets(s)));
const segment = kalshiDateSegment(date);
const forDate = markets.map(normalizeMarket).filter((m) => m && m.eventTicker?.includes(segment));
console.log(`kalshi: ${forDate.length} open markets in ${series.length} series`);

/** Probability you pay for one side on Kalshi, fee included. */
const costProb = (cents) =>
  cents == null || cents <= 0 || cents >= 100 ? null : (cents + feePerContractCents(cents)) / 100;

const gaps = [];
for (const row of rows) {
  if (row.line == null || Math.abs(row.line % 1) !== 0.5) continue;
  // Two or more books, so the consensus is not one quote wearing a hat.
  if (!row.edge || row.edge.fairOver == null || (row.edge.nBooks ?? 0) < 2) continue;
  const match = matchKalshiMarket({ player: row.name, market: row.market, line: row.line, markets: forDate });
  if (match.status !== 'matched') continue;
  const k = match.market;
  if (k.yesAsk == null || k.yesBid == null) continue;

  // The books' de-vigged OVER probability is the same event as Kalshi YES.
  const bookOver = row.edge.fairOver;
  const yesCost = costProb(k.yesAsk);
  const noCost = costProb(100 - k.yesBid);
  if (yesCost == null || noCost == null) continue;

  const yesGap = bookOver - yesCost;
  const noGap = 1 - bookOver - noCost;
  const [side, gap, cost] = yesGap >= noGap ? ['yes', yesGap, yesCost] : ['no', noGap, noCost];
  gaps.push({
    ticker: k.ticker,
    market: row.market,
    side,
    gapPts: 100 * gap,
    bookOver: 100 * bookOver,
    kalshiCost: 100 * cost,
    nBooks: row.edge.nBooks,
    spread: k.yesAsk - k.yesBid,
  });
}

gaps.sort((a, b) => b.gapPts - a.gapPts);
const pts = gaps.map((g) => g.gapPts).sort((a, b) => a - b);
const q = (p) => (pts.length ? pts[Math.floor(p * (pts.length - 1))].toFixed(1) : '-');
console.log(`\nmatched at both venues: ${gaps.length} contracts`);
console.log(`best-side gap percentiles (pts): p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}`);
console.log(
  `positive after fees: ${gaps.filter((g) => g.gapPts > 0).length}` +
    `  |  over 3 pts: ${gaps.filter((g) => g.gapPts > 3).length}` +
    `  |  over 5 pts: ${gaps.filter((g) => g.gapPts > 5).length}`,
);
const byMarket = {};
for (const g of gaps) (byMarket[g.market] ||= []).push(g.gapPts);
console.log('\nmedian gap by market:');
for (const [m, list] of Object.entries(byMarket).sort((a, b) => b[1].length - a[1].length)) {
  const s = [...list].sort((a, b) => a - b);
  console.log(`  ${m.padEnd(24)} n=${String(list.length).padStart(4)}  median ${s[Math.floor(s.length / 2)].toFixed(1)}pts`);
}
console.log('\ntop 15 by gap:');
for (const g of gaps.slice(0, 15)) {
  console.log(
    `${g.gapPts.toFixed(1).padStart(5)}pts  ${g.side.toUpperCase().padEnd(3)} ${g.ticker.padEnd(44)} ` +
      `books ${g.bookOver.toFixed(1)}% over (${g.nBooks})  kalshi cost ${g.kalshiCost.toFixed(1)}%  spread ${g.spread}c`,
  );
}
