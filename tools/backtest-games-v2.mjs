// The v2 replay, shaped exactly like tools/backtest-games.mjs so that
// tools/backtest-kalshi-games.mjs can price it without knowing the difference.
//
//   node tools/backtest-kalshi-games.mjs --v2 \
//     --features .backtest-cache/features_2026.json \
//     --features .backtest-cache/features_2025.json \
//     --params .backtest-cache/params-core.json \
//     --from 2026-08-10 --to 2026-09-01 --kcache .kalshi-cache
//
// It exports the same three things the v1 replay does — `buildGames`,
// `validate` and `USE_LINEUPS` — and returns the same game shape, with
// `model` coming from `projectGameV2` instead of `projectGame`. The lineups
// are always in (they are part of the feature table), and the weather IS used,
// which the v1 replay cannot do; both are declared in the doc.

import fs from 'node:fs';
import { argv } from './backtest-common.mjs';
import { validateGames as validate } from './backtest-common.mjs';
import { buildLeagueContext, projectGameV2, projectGameV1FromRow } from './game-model-v2.mjs';

export { validate };

const featureFiles = process.argv
  .map((a, i) => (a === '--features' ? process.argv[i + 1] : null))
  .filter(Boolean);
const PARAMS_FILE = argv('params', '.backtest-cache/params-core.json');
/** `--as-v1` prices the SHIPPED model on the same rows, as a control. */
const AS_V1 = process.argv.includes('--as-v1');

export const USE_LINEUPS = true;

const rows = [];
for (const f of featureFiles) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')).rows);
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const ctxByDate = buildLeagueContext(rows);
const PARAMS = JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')).params;
process.stderr.write(`v2 replay: ${rows.length} feature rows, params ${PARAMS_FILE}${AS_V1 ? ' (priced AS V1)' : ''}\n`);

export function buildGames() {
  const out = [];
  const skip = {};
  const bump = (r) => (skip[r] = (skip[r] || 0) + 1);
  for (const r of rows) {
    if (r.actual.scheduledInnings !== 9) { bump('not a nine-inning game'); continue; }
    if (!(r.away.off?.gamesPlayed >= 10) || !(r.home.off?.gamesPlayed >= 10)) { bump('under ten games played'); continue; }
    const ctx = ctxByDate.get(r.date);
    const model = AS_V1 ? projectGameV1FromRow(r, ctx) : projectGameV2(r, ctx, PARAMS);
    // The shipped model on the identical row, carried alongside so the price
    // study can score v2 against v1 paired on the same markets.
    const modelV1 = AS_V1 ? null : projectGameV1FromRow(r, ctx);
    out.push({
      gamePk: r.gamePk,
      gameNumber: r.gameNumber,
      date: r.date,
      gameDate: r.gameDate,
      awayId: r.away.teamId,
      homeId: r.home.teamId,
      awayAbbr: r.away.abbr,
      homeAbbr: r.home.abbr,
      park: r.venue,
      bothStarters: !model.flags.includes('NO PROBABLE'),
      hasLineups: !!(r.away.lineup?.nine && r.home.lineup?.nine),
      model,
      modelV1,
      actual: {
        away: r.actual.away,
        home: r.actual.home,
        total: r.actual.away + r.actual.home,
        margin: r.actual.home - r.actual.away,
        homeWin: r.actual.home > r.actual.away ? 1 : 0,
        firstInningRuns: r.actual.firstRuns,
        innings: r.actual.innings,
      },
    });
  }
  return { games: out, skip };
}

if (process.argv[1] && process.argv[1].endsWith('backtest-games-v2.mjs')) {
  const { games, skip } = buildGames();
  const from = argv('from', '0000');
  const to = argv('to', '9999');
  const inWindow = games.filter((g) => g.date >= from && g.date <= to);
  const v = validate(inWindow);
  console.log(`${inWindow.length} games, ${from}..${to}`);
  console.log('skipped:', JSON.stringify(skip));
  const row = (label, o) => o && console.log(`${label.padEnd(16)} model ${(100 * o.pred).toFixed(2)}%  actual ${(100 * o.actual).toFixed(2)}%  (n=${o.n})`);
  row('home win', v.homeWin);
  row('NRFI', v.nrfi);
  for (const [k, o] of Object.entries(v.totals)) row(k, o);
  for (const [k, o] of Object.entries(v.spreads)) row(k, o);
  console.log(`brier            pHome ${v.brier.pHome.toFixed(4)}  over8.5 ${v.brier.over85.toFixed(4)}`);
}
