// v35: game model, team market pricing, game-line + doubleheader grading, and
// the projection fixes that shipped with them.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AWAY_HALF_MEANS,
  HOME_HALF_MEANS,
  EXTRA_INNING_PMF,
  HOME_ADJUST,
  finalScoreGrid,
  uncertainScoreGrid,
  summarizeGrid,
  totalProbs,
  spreadProbs,
  noPush,
  tiltPmf,
  HALF_INNING_PMF,
  projectGame,
  leagueRunPrevention,
} from '../src/model/game.js';
import {
  parseKalshiGameTicker,
  kalshiGameQuotes,
  kalshiQuote,
  parseGameOdds,
  priceTeamMarkets,
} from '../src/data/teamMarkets.js';
import { flattenRows, pickText } from '../src/ui/rows.js';
import { snapshotRowKey } from '../src/ui/snapshotStore.js';
import { gradeSlate } from '../src/data/gradeSlate.js';
import { parkFactor } from '../src/lib/parks.js';
import { projectPitcher } from '../src/model/pitcher.js';
import { evaluateEdge } from '../src/model/edges.js';

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const extraBase = EXTRA_INNING_PMF.reduce((s, p, k) => s + p * k, 0);
const leagueScoring = (overrides = {}) => ({
  awayHalfMeans: AWAY_HALF_MEANS,
  homeHalfMeans: HOME_HALF_MEANS.map((m) => m * HOME_ADJUST),
  awayExtraMean: extraBase,
  homeExtraMean: extraBase * 1.089 * HOME_ADJUST,
  ...overrides,
});

// ── score distribution ─────────────────────────────────────────────────────

test('the final-score distribution is a proper distribution', () => {
  const grid = uncertainScoreGrid(leagueScoring());
  const total = grid.reduce((a, b) => a + b, 0);
  close(total, 1, 1e-9, 'probability mass');
  // No game ends tied.
  for (let s = 0; s < 31; s++) assert.equal(grid[s * 31 + s], 0, `tie at ${s}`);
});

test('two league-average teams reproduce the measured 2026 league rates', () => {
  const s = summarizeGrid(uncertainScoreGrid(leagueScoring()));
  close(s.pHome, 0.5288, 0.01, 'home win');
  close(totalProbs(s, 8.5).over, 0.491, 0.015, 'over 8.5');
  close(spreadProbs(s, -1.5).home, 0.3602, 0.015, 'home -1.5');
  close(s.meanAway + s.meanHome, 8.986, 0.15, 'mean total');
});

test('the home team never trails in a game it wins, and walk-offs cluster at one run', () => {
  const s = summarizeGrid(finalScoreGrid(leagueScoring()));
  const homeBy1 = s.margin.get(1);
  const awayBy1 = s.margin.get(-1);
  assert.ok(homeBy1 > awayBy1, 'home one-run wins outnumber away one-run wins');
});

test('better offence moves every market the right way', () => {
  const base = summarizeGrid(uncertainScoreGrid(leagueScoring()));
  const strongHome = summarizeGrid(
    uncertainScoreGrid(leagueScoring({ homeHalfMeans: HOME_HALF_MEANS.map((m) => m * 1.2) })),
  );
  assert.ok(strongHome.pHome > base.pHome);
  assert.ok(spreadProbs(strongHome, -1.5).home > spreadProbs(base, -1.5).home);
  assert.ok(totalProbs(strongHome, 8.5).over > totalProbs(base, 8.5).over);
});

test('whole-number totals push, and noPush removes the push from both sides', () => {
  const s = summarizeGrid(uncertainScoreGrid(leagueScoring()));
  const t = totalProbs(s, 9);
  assert.ok(t.push > 0.05, 'nine runs exactly is common');
  close(t.over + t.under + t.push, 1, 1e-9, 'partition');
  close(noPush(t), t.over / (t.over + t.under), 1e-12, 'conditional');
  assert.equal(totalProbs(s, 8.5).push, 0);
});

test('tilting preserves the requested mean', () => {
  for (const m of [0.2, 0.48, 0.9]) {
    const pmf = tiltPmf(HALF_INNING_PMF, m);
    close(pmf.reduce((s, p, k) => s + p * k, 0), m, 1e-6, `mean ${m}`);
  }
});

test('league FIP constant makes league FIP equal league ERA', () => {
  const sp = { inningsPitched: '900.0', earnedRuns: 400, homeRuns: 110, baseOnBalls: 300, hitByPitch: 40, strikeOuts: 800 };
  const rp = { inningsPitched: '600.0', earnedRuns: 250, homeRuns: 70, baseOnBalls: 230, hitByPitch: 25, strikeOuts: 620 };
  const lg = leagueRunPrevention([sp], [rp]);
  close(lg.allRa9, (9 * 650) / 1500, 1e-9, 'league ERA');
  // A league-average starter/reliever mix blends to league ERA.
  close((lg.spRa9 * 900 + lg.rpRa9 * 600) / 1500, lg.allRa9, 1e-9, 'roles blend back');
});

test('projectGame: an ace at home beats a replacement starter on the road', () => {
  const league = { rpg: 4.49, spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 };
  const offense = { runs: 675, gamesPlayed: 150, ops: 0.72 };
  const ace = { inningsPitched: '180.0', earnedRuns: 50, homeRuns: 14, baseOnBalls: 40, hitByPitch: 5, strikeOuts: 220 };
  const bad = { inningsPitched: '120.0', earnedRuns: 80, homeRuns: 24, baseOnBalls: 55, hitByPitch: 8, strikeOuts: 80 };
  const side = (s26) => ({ offense, homePark: 'Target Field', starter: { s26, s25: null, projIP: 6 }, bullpen: null });
  const g = projectGame({ away: side(bad), home: side(ace), league, park: 'Target Field', wx: null });
  assert.ok(g.pHome > 0.6, `pHome ${g.pHome}`);
  assert.ok(g.projAway < g.projHome);
  close(g.pHome + g.pAway, 1, 1e-12, 'ML sums');
  assert.ok(g.nrfi.nrfiProb > 0.4 && g.nrfi.nrfiProb < 0.65);
  // Coors raises the total for the identical matchup.
  const coors = projectGame({ away: side(bad), home: side(ace), league, park: 'Coors Field', wx: null });
  assert.ok(coors.projTotal > g.projTotal);
});

// ── market parsing ─────────────────────────────────────────────────────────

test('Kalshi game tickers carry the date, Eastern start and away+home codes', () => {
  assert.deepEqual(parseKalshiGameTicker('KXMLBGAME-26SEP161310CWSCLE'), {
    date: '2026-09-16',
    etMinutes: 13 * 60 + 10,
    teams: 'CWSCLE',
  });
  assert.equal(parseKalshiGameTicker('garbage'), null);
});

const game = (gamePk, away, home, iso) => ({
  gamePk,
  gameDate: iso,
  teams: {
    away: { team: { abbreviation: away, name: `${away} Team` } },
    home: { team: { abbreviation: home, name: `${home} Team` } },
  },
});

test('Kalshi spread contracts are oriented to the home side, doubleheaders by start time', () => {
  const games = [
    game(1, 'DET', 'CLE', '2026-09-16T17:10:00Z'), // 13:10 ET
    game(2, 'DET', 'CLE', '2026-09-16T23:10:00Z'), // 19:10 ET
  ];
  const mk = (ticker, strike, yesAsk, noAsk) => ({
    ticker,
    eventTicker: ticker.split('-').slice(0, 2).join('-'),
    series: ticker.split('-')[0],
    yesAsk,
    noAsk,
    raw: { floor_strike: strike },
  });
  const markets = [
    mk('KXMLBGAME-26SEP161910DETCLE-CLE', null, 55, 47),
    mk('KXMLBGAME-26SEP161910DETCLE-DET', null, 47, 55),
    mk('KXMLBSPREAD-26SEP161910DETCLE-CLE2', 1.5, 40, 62),
    mk('KXMLBSPREAD-26SEP161910DETCLE-DET2', 1.5, 30, 72),
    mk('KXMLBTOTAL-26SEP161910DETCLE-9', 8.5, 48, 54),
  ];
  const byGame = kalshiGameQuotes(markets, games, '2026-09-16');
  assert.equal(byGame.get(1).game_ml.length, 0, 'the evening contract is game 2');
  const g2 = byGame.get(2);
  assert.equal(g2.game_ml.length, 1, 'only the home contract is the moneyline');
  const home15 = g2.game_spread.find((q) => q.point === -1.5);
  const away15 = g2.game_spread.find((q) => q.point === 1.5);
  // Home -1.5: YES on "CLE wins by over 1.5" is the home (over) side.
  assert.ok(home15.over > home15.under, 'home -1.5 at 40c is the longer price');
  // Home +1.5 from the away contract: YES (DET by 2+) is the UNDER side.
  assert.ok(away15.under > away15.over, 'DET -1.5 at 30c is the long side, stored as under');
  assert.equal(g2.game_total[0].point, 8.5);
});

test('Kalshi quotes include the trading fee', () => {
  const q = kalshiQuote({ yesAsk: 50, noAsk: 50, ticker: 'x' }, 0);
  // 50c + 1.75c fee is worse than even money on both sides.
  assert.ok(q.over < -100 && q.under < -100);
});

test('sportsbook game odds keep only mirrored spreads and matching totals', () => {
  const event = {
    home_team: 'Home',
    away_team: 'Away',
    bookmakers: [
      {
        key: 'draftkings',
        markets: [
          { key: 'h2h', outcomes: [{ name: 'Home', price: -130 }, { name: 'Away', price: 110 }] },
          { key: 'spreads', outcomes: [{ name: 'Home', price: 140, point: -1.5 }, { name: 'Away', price: -160, point: 1.5 }] },
          { key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 8.5 }, { name: 'Under', price: -115, point: 8.5 }] },
        ],
      },
      {
        key: 'prizepicks', // not a game-line book
        markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: -500 }, { name: 'Away', price: 400 }] }],
      },
    ],
  };
  const q = parseGameOdds(event);
  assert.deepEqual(q.game_ml, [{ book: 'DK', point: 0, over: -130, under: 110, w: 1 }]);
  assert.equal(q.game_spread[0].point, -1.5);
  assert.equal(q.game_total[0].point, 8.5);
});

test('team markets use the tighter implausibility limit', () => {
  const model = { pHome: 0.62, pAway: 0.38, spread: () => ({ home: 0.5, away: 0.5, push: 0 }), total: () => ({ over: 0.5, under: 0.5, push: 0 }) };
  // Priced so the row would otherwise be a LEAN: +100 on the home side.
  const books = { game_ml: [{ book: 'DK', point: 0, over: 100, under: -120, w: 1 }, { book: 'FD', point: 0, over: 100, under: -120, w: 1 }], game_spread: [], game_total: [] };
  const [ml] = priceTeamMarkets(model, books, null);
  assert.equal(ml.edge.verdict, 'PASS');
  assert.ok(ml.edge.why.some((w) => w.includes('8pts')), ml.edge.why.join());
  // The same 12-point disagreement on a prop is not suppressed by that rule.
  const prop = evaluateEdge(0.61, 5.5, -110, -110, { weight: 0.45 });
  assert.ok(!prop.why.some((w) => w.includes('off market')));
});

// ── rows, wording, grading ─────────────────────────────────────────────────

const slateGame = {
  gamePk: 777,
  venue: 'Progressive Field',
  gameDate: '2026-09-16T23:10:00Z',
  away: { abbr: 'DET', name: 'Detroit Tigers' },
  home: { abbr: 'CLE', name: 'Cleveland Guardians' },
  pitchers: [],
  batters: [],
  game: { projHome: 4.6, projAway: 4.1, projTotal: 8.7, flags: [] },
  teamLines: [
    { market: 'game_ml', label: 'Moneyline', line: 0, over: -120, under: 100, overBook: 'DK', underBook: 'FD', nBooks: 2, edge: { side: 'under', verdict: 'LEAN' } },
    { market: 'game_spread', label: 'Run Line', line: -1.5, over: 150, under: -170, overBook: 'DK', underBook: 'DK', nBooks: 1, edge: { side: 'over', verdict: 'PASS' } },
    { market: 'game_total', label: 'Total', line: 8.5, over: -110, under: -110, overBook: 'DK', underBook: 'DK', nBooks: 1, edge: { side: 'over', verdict: 'PASS' } },
  ],
  nrfiLine: { yrfiOdds: -115, nrfiOdds: -105, yrfiBook: 'DK', nrfiBook: 'FD', nBooks: 2 },
  nrfiEdge: { side: 'under', verdict: 'PASS' },
};

test('game lines and NRFI flatten into ordinary rows with plain-English picks', () => {
  const rows = flattenRows({ games: [slateGame] });
  const byMarket = Object.fromEntries(rows.map((r) => [r.market, r]));
  assert.equal(rows.length, 4);
  assert.equal(pickText(byMarket.game_ml), 'Tigers win');
  assert.equal(pickText({ ...byMarket.game_ml, game: { ...slateGame, away: { name: 'Chicago White Sox' } } }), 'White Sox win');
  assert.equal(pickText(byMarket.game_ml, 'over'), 'Guardians win');
  assert.equal(pickText(byMarket.game_spread), 'Guardians -1.5');
  assert.equal(pickText(byMarket.game_spread, 'under'), 'Tigers +1.5');
  assert.equal(pickText(byMarket.game_total, 'under'), 'Under 8.5 runs');
  assert.equal(pickText(byMarket.nrfi), 'NRFI — no run in the 1st');
  assert.equal(byMarket.game_ml.book, 'FD', 'book follows the called side');
  assert.equal(byMarket.game_ml.proj, 4.6 - 4.1);
});

test('snapshot keys separate the two games of a doubleheader', () => {
  const a = snapshotRowKey({ kind: 'batter', gamePk: 1, playerId: 9, market: 'batter_hits' });
  const b = snapshotRowKey({ kind: 'batter', gamePk: 2, playerId: 9, market: 'batter_hits' });
  assert.notEqual(a, b);
  // Rows saved before v35 keep their original key.
  assert.equal(snapshotRowKey({ kind: 'batter', playerId: 9, market: 'batter_hits' }), 'batter:9:batter_hits');
});

function stubMlb(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(String(url).split('path=')[1] || '');
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    if (!hit) throw new Error(`unstubbed ${path}`);
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  };
  return () => { globalThis.fetch = real; };
}

const box = (playerId, hits) => ({
  teams: {
    away: { players: { [`ID${playerId}`]: { person: { id: playerId }, stats: { batting: { plateAppearances: 4, hits, homeRuns: 0, totalBases: hits, runs: 0, rbi: 0, strikeOuts: 1, stolenBases: 0, doubles: 0, triples: 0 }, pitching: {} } } } },
    home: { players: {} },
  },
});

test('doubleheader props grade against their own game; game lines grade off the linescore', async () => {
  const restore = stubMlb({
    '/api/v1/schedule': {
      dates: [{
        games: [
          { gamePk: 1, status: { abstractGameState: 'Final' }, linescore: { teams: { away: { runs: 2 }, home: { runs: 5 } }, innings: [{ away: { runs: 0 }, home: { runs: 0 } }, ...Array.from({ length: 8 }, () => ({ away: { runs: 0 }, home: { runs: 0 } }))] } },
          { gamePk: 2, status: { abstractGameState: 'Final' }, linescore: { teams: { away: { runs: 6 }, home: { runs: 5 } }, innings: [{ away: { runs: 1 }, home: { runs: 0 } }, ...Array.from({ length: 8 }, () => ({ away: { runs: 0 }, home: { runs: 0 } }))] } },
        ],
      }],
    },
    '/api/v1/game/1/boxscore': box(42, 1),
    '/api/v1/game/2/boxscore': box(42, 0),
  });
  try {
    const rows = [
      { kind: 'batter', gamePk: 1, playerId: 42, distKey: 'hits', line: 0.5, side: 'over' },
      { kind: 'batter', gamePk: 2, playerId: 42, distKey: 'hits', line: 0.5, side: 'over' },
      // Pre-v35 row: the player played twice, so it cannot be placed.
      { kind: 'batter', playerId: 42, distKey: 'hits', line: 0.5, side: 'over' },
      { kind: 'game', gamePk: 1, playerId: 1, market: 'game_ml', line: 0, side: 'over' },
      { kind: 'game', gamePk: 1, playerId: 1, market: 'game_spread', line: -1.5, side: 'over' },
      { kind: 'game', gamePk: 2, playerId: 2, market: 'game_spread', line: 1.5, side: 'over' },
      { kind: 'game', gamePk: 2, playerId: 2, market: 'game_total', line: 11, side: 'under' },
      { kind: 'nrfi', gamePk: 1, playerId: 1, market: 'nrfi', line: 0.5, side: 'under' },
      { kind: 'nrfi', gamePk: 2, playerId: 2, market: 'nrfi', line: 0.5, side: 'under' },
    ];
    const graded = await gradeSlate({ date: '2026-09-04', snapshot: { rows } });
    assert.deepEqual(
      graded.map((r) => r.result),
      ['WIN', 'LOSS', 'NO DATA', 'WIN', 'WIN', 'WIN', 'PUSH', 'WIN', 'LOSS'],
    );
  } finally {
    restore();
  }
});

// ── projection fixes ───────────────────────────────────────────────────────

test("the Dodgers' renamed park gets Dodger Stadium's factors", () => {
  assert.equal(parkFactor('UNIQLO Field at Dodger Stadium', 'hr'), parkFactor('Dodger Stadium', 'hr'));
  assert.notEqual(parkFactor('UNIQLO Field at Dodger Stadium', 'hr'), 1);
});

test('ERA and FIP are shrunk, and a non-numeric ERA cannot make projER NaN', () => {
  const base = { gamesStarted: 4, gamesPlayed: 4, numberOfPitches: 360, battersFaced: 90, strikeOuts: 18, baseOnBalls: 9, hits: 20, homeRuns: 2 };
  const run = (s26) => projectPitcher({ season26: s26, season25: null, gameLog: [], park: 'Target Field' });
  const bad = run({ ...base, inningsPitched: '20.0', era: '7.20' });
  const avg = run({ ...base, inningsPitched: '20.0', era: '4.20' });
  // Before the fix this gap was 10.6 points on P(ER > 2.5).
  assert.ok(bad.dist.er(2.5) - avg.dist.er(2.5) < 0.06, `${bad.dist.er(2.5)} vs ${avg.dist.er(2.5)}`);
  const empty = run({ ...base, inningsPitched: '0.0', era: '-.--', battersFaced: 0 });
  assert.ok(Number.isFinite(empty.projER));
  assert.ok(Number.isFinite(empty.dist.er(2.5)));
});

// ── v35 review fixes ───────────────────────────────────────────────────────

import { matchOddsEvent } from '../src/data/teamMarkets.js';
import { applyCriteria } from '../src/ui/filters.js';

test("a sportsbook event from another day never prices this game", () => {
  const g = { gameDate: '2026-09-17T23:05:00Z', teams: { home: { team: { name: 'H' } }, away: { team: { name: 'A' } } } };
  const today = { id: 'today', home_team: 'H', away_team: 'A', commence_time: '2026-09-16T23:05:00Z' };
  const nightcap = { id: 'dh', home_team: 'H', away_team: 'A', commence_time: '2026-09-17T19:05:00Z' };
  assert.equal(matchOddsEvent([today], g), null);
  assert.equal(matchOddsEvent([today, nightcap], g)?.id, 'dh');
});

test('a minimum player sample does not hide game lines or NRFI', () => {
  const rows = [
    { key: 'g', kind: 'game', line: 8.5, detailRef: null, flags: [] },
    { key: 'n', kind: 'nrfi', line: 0.5, detailRef: null, flags: [] },
    { key: 'b', kind: 'batter', line: 0.5, detailRef: { season: { pa: 10 } }, flags: [] },
  ];
  assert.deepEqual(applyCriteria(rows, { hideAlts: false, minSample: 50 }).map((r) => r.key), ['g', 'n']);
});

test('the home park adjusts a pitcher’s own line, not the league prior', () => {
  const league = { rpg: 4.49, spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 };
  const offense = { runs: 675, gamesPlayed: 150, ops: 0.72 };
  const side = (homePark) => ({ offense, homePark, starter: null, bullpen: null });
  // No starter and no bullpen line: pitching is pure league prior, so the
  // team's home park must not change it.
  const coors = projectGame({ away: side('Target Field'), home: side('Coors Field'), league, park: 'Target Field' });
  const twins = projectGame({ away: side('Target Field'), home: side('Target Field'), league, park: 'Target Field' });
  close(coors.inputs.pitching.home.starter, twins.inputs.pitching.home.starter, 1e-12, 'prior-only starter index');
});

test('a game called before nine innings voids run line and total, keeps the moneyline', async () => {
  const restore = stubMlb({
    '/api/v1/schedule': {
      dates: [{ games: [{ gamePk: 5, status: { abstractGameState: 'Final' }, linescore: { teams: { away: { runs: 1 }, home: { runs: 4 } }, innings: Array.from({ length: 6 }, () => ({ away: { runs: 0 }, home: { runs: 0 } })) } }] }],
    },
    '/api/v1/game/5/boxscore': { teams: { away: { players: {} }, home: { players: {} } } },
  });
  try {
    const rows = [
      { kind: 'game', gamePk: 5, playerId: 5, market: 'game_ml', line: 0, side: 'over' },
      { kind: 'game', gamePk: 5, playerId: 5, market: 'game_spread', line: -1.5, side: 'over' },
      { kind: 'game', gamePk: 5, playerId: 5, market: 'game_total', line: 4.5, side: 'over' },
    ];
    const graded = await gradeSlate({ date: '2026-09-05', snapshot: { rows } });
    assert.deepEqual(graded.map((r) => r.result), ['WIN', 'VOID', 'VOID']);
  } finally {
    restore();
  }
});

// ── v35.1 board policy ─────────────────────────────────────────────────────

import { attachLines } from '../src/model/lines.js';
import { PITCHER_MARKETS } from '../src/lib/markets.js';

const pitcherOdds = (quotes) => ({ pitcher_strikeouts: { 'test arm': quotes } });
const kProjection = (p) => ({ projK: 6, dist: { k: () => p } });
const kRow = (quotes, p) =>
  attachLines({ pitcher_strikeouts: PITCHER_MARKETS.pitcher_strikeouts }, 'test arm', pitcherOdds(quotes), kProjection(p), false)[0];

test('a pitcher prop priced by one book is never a play', () => {
  const row = kRow([{ book: 'DK', point: 5.5, over: 110, under: -130, w: 1 }], 0.55);
  assert.equal(row.edge.verdict, 'PASS');
  assert.ok(row.edge.why.includes('needs 2+ books'), row.edge.why.join());
});

test('a pitcher prop longer than +150 is never a play', () => {
  const q = (book) => ({ book, point: 5.5, over: 190, under: -240, w: 1 });
  // Model 42% vs a 31% market: a LEAN on price alone before the +150 rule.
  const row = kRow([q('DK'), q('FD')], 0.42);
  assert.equal(row.edge.verdict, 'PASS');
  assert.ok(row.edge.why.includes('price longer than +150'), row.edge.why.join());
});

test('a two-book pitcher prop at a normal price can still be a play', () => {
  const q = (book) => ({ book, point: 5.5, over: 105, under: -125, w: 1 });
  const row = kRow([q('DK'), q('FD')], 0.55);
  assert.notEqual(row.edge.verdict, 'PASS', row.edge.why.join());
});

test('game lines are information only', () => {
  // 56% vs a 49% low-margin market (+105/-105): a LEAN before the information-only rule.
  const model = { pHome: 0.56, pAway: 0.44, spread: () => ({ home: 0.5, away: 0.5, push: 0 }), total: () => ({ over: 0.5, under: 0.5, push: 0 }) };
  const q = (book) => ({ book, point: 0, over: 105, under: -105, w: 1 });
  const [ml] = priceTeamMarkets(model, { game_ml: [q('DK'), q('FD')], game_spread: [], game_total: [] }, null);
  assert.equal(ml.edge.verdict, 'PASS');
  assert.ok(ml.edge.why.some((w) => w.startsWith('game lines are information only')), ml.edge.why.join());
  assert.ok(ml.edge.ev > 0, 'the number is still shown');
});

// ── v35.2 pitcher leash ────────────────────────────────────────────────────

test('a reliever handed a start gets a reliever-sized leash, not 82 pitches', () => {
  // 30 relief appearances at ~22 pitches, no start this season, a starter last year.
  const reliever = { gamesStarted: 0, gamesPlayed: 30, numberOfPitches: 660, battersFaced: 170, strikeOuts: 45, baseOnBalls: 15, hits: 35, homeRuns: 4, inningsPitched: '40.0', era: '3.60' };
  const lastYearStarter = { gamesStarted: 28, gamesPlayed: 28, numberOfPitches: 2500, battersFaced: 640, strikeOuts: 150, baseOnBalls: 50, hits: 140, homeRuns: 18, inningsPitched: '150.0', era: '4.10' };
  const opener = projectPitcher({ season26: reliever, season25: lastYearStarter, gameLog: [], park: 'Target Field' });
  assert.ok(opener.workload.budget < 45, `budget ${opener.workload.budget}`);
  assert.ok(opener.projOuts < 10, `projOuts ${opener.projOuts}`);
  // The old behaviour is still one tuning override away.
  const old = projectPitcher({ season26: reliever, season25: lastYearStarter, gameLog: [], park: 'Target Field', tuning: { reliefBudget: null, budgetFloor: 45 } });
  assert.ok(old.workload.budget > 75, `old budget ${old.workload.budget}`);
  // A pitcher with starts in his log is untouched by the relief rule.
  const starterLog = [1, 2, 3].map((i) => ({ ip: 6, pitches: 95, bf: 24, k: 6, date: `2026-08-0${i}` }));
  const starter = projectPitcher({ season26: { ...lastYearStarter, gamesStarted: 3, gamesPlayed: 3, numberOfPitches: 285 }, season25: null, gameLog: starterLog, park: 'Target Field' });
  assert.ok(starter.workload.budget > 90, `starter budget ${starter.workload.budget}`);
});

test('home/away terms are neutral unless the caller says which side', () => {
  const s26 = { gamesStarted: 20, gamesPlayed: 20, numberOfPitches: 1800, battersFaced: 480, strikeOuts: 110, baseOnBalls: 35, hits: 105, homeRuns: 12, inningsPitched: '115.0', era: '3.90' };
  const gameLog = [1, 2, 3].map((i) => ({ ip: 6, pitches: 92, bf: 24, k: 6, date: `2026-08-0${i}` }));
  const run = (isHome) => projectPitcher({ season26: s26, season25: null, gameLog, park: 'Target Field', isHome });
  const neutral = run(undefined), home = run(true), away = run(false);
  assert.ok(home.projK > neutral.projK && neutral.projK > away.projK);
  assert.ok(home.projOuts > neutral.projOuts && neutral.projOuts > away.projOuts);
  assert.equal(projectPitcher({ season26: s26, season25: null, gameLog, park: 'Target Field', isHome: true, tuning: { homeK: 0, homeBudget: 0 } }).projK, neutral.projK);
});
