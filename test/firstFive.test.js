// First five innings (F5): the model, the parsing, the pricing and the
// settlement. docs/FIRST-FIVE.md has the measurement these pin.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AWAY_HALF_MEANS,
  HOME_HALF_MEANS,
  EXTRA_INNING_PMF,
  HOME_ADJUST,
  firstFiveGrid,
  firstFiveMarkets,
  uncertainScoreGrid,
  summarizeGrid,
  noPush,
  projectGame,
} from '../src/model/game.js';
import { parseGameOdds, priceTeamMarkets, TEAM_MARKETS } from '../src/data/teamMarkets.js';
import { pickText } from '../src/ui/rows.js';
import { gradeSlate } from '../src/data/gradeSlate.js';
import { MARKET_WEIGHT } from '../src/model/edges.js';

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
const leagueF5 = (overrides) =>
  firstFiveMarkets(summarizeGrid(uncertainScoreGrid(leagueScoring(overrides), { build: firstFiveGrid })));

// ── the distribution ───────────────────────────────────────────────────────

test('the five-inning distribution is proper, and a tie after five is allowed', () => {
  const grid = uncertainScoreGrid(leagueScoring(), { build: firstFiveGrid });
  close(grid.reduce((a, b) => a + b, 0), 1, 1e-9, 'probability mass');
  // Unlike the final score, level after five is a real state with real mass.
  let tied = 0;
  for (let s = 0; s < 31; s++) tied += grid[s * 31 + s];
  assert.ok(tied > 0.1, `tie mass ${tied}`);
});

/**
 * The pin. Measured on the 4,761 nine-inning games of 2025 and 2026 through
 * 2026-09-22 that reached five innings (every one of them), from the MLB
 * linescores in `tools/game-features.mjs`:
 *
 *                       model    actual
 *     away runs in 5    2.383    2.385
 *     home runs in 5    2.599    2.623
 *     total in 5        4.982    5.007
 *     home leads       44.98%   45.33%
 *     away leads       39.72%   39.15%
 *     level            15.30%   15.52%
 *     over 3.5         62.18%   62.51%
 *     over 4.5         49.35%   49.91%
 *     over 5.5         37.79%   38.40%
 *     over 6.5         28.03%   28.92%
 *     home -0.5        44.98%   45.33%
 *     home -1.5        31.85%   32.81%
 *
 * Nothing was fitted for this: the F5 grid is the full game's own fitted
 * scoring rates, convolved five times instead of nine. The model runs about
 * half a point low on every over and a point low on home -1.5, which is the
 * same slightly-too-narrow signature the full game carries.
 */
test('two league-average teams reproduce the measured league F5 rates', () => {
  const f = leagueF5();
  close(f.projAway, 2.385, 0.04, 'away runs in five');
  close(f.projHome, 2.623, 0.04, 'home runs in five');
  close(f.projTotal, 5.007, 0.06, 'total in five');
  close(f.pHome, 0.4533, 0.012, 'home leads after five');
  close(f.pAway, 0.3915, 0.012, 'away leads after five');
  close(f.pTie, 0.1552, 0.012, 'level after five');
  close(f.total(3.5).over, 0.6251, 0.012, 'over 3.5');
  close(f.total(4.5).over, 0.4991, 0.012, 'over 4.5');
  close(f.total(5.5).over, 0.384, 0.012, 'over 5.5');
  close(f.total(6.5).over, 0.2892, 0.012, 'over 6.5');
  close(f.spread(-0.5).home, 0.4533, 0.012, 'home -0.5');
  close(f.spread(-1.5).home, 0.3281, 0.012, 'home -1.5');
});

test('the three F5 outcomes partition, and the tie is carried as a push, not dropped', () => {
  const f = leagueF5();
  close(f.pHome + f.pAway + f.pTie, 1, 1e-9, 'home / away / tie partition');
  assert.equal(f.moneyline.push, f.pTie);
  // What the board compares against a book price: P(home leads | not level).
  close(noPush(f.moneyline), f.pHome / (f.pHome + f.pAway), 1e-12, 'conditional on no tie');
  assert.ok(noPush(f.moneyline) > f.pHome, 'removing the tie lifts the home side');
  // A half-point F5 run line cannot push; the whole-number moneyline can.
  assert.equal(f.spread(-0.5).push, 0);
  assert.equal(f.total(4.5).push, 0);
  assert.ok(f.total(5).push > 0.1, 'five runs exactly is common');
});

test('a better home offence moves every F5 market the right way', () => {
  const base = leagueF5();
  const strong = leagueF5({ homeHalfMeans: HOME_HALF_MEANS.map((m) => m * 1.25) });
  assert.ok(strong.pHome > base.pHome);
  assert.ok(strong.pTie < base.pTie, 'a mismatch is less often level');
  assert.ok(strong.spread(-0.5).home > base.spread(-0.5).home);
  assert.ok(strong.total(4.5).over > base.total(4.5).over);
  assert.ok(strong.projTotal > base.projTotal);
});

test('F5 is a strict prefix of the game: fewer runs, and it moves with the full-game total', () => {
  const league = { rpg: 4.49, spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 };
  const offense = { runs: 675, gamesPlayed: 150, ops: 0.72 };
  const side = () => ({ offense, homePark: 'Target Field', starter: null, bullpen: null });
  const flat = projectGame({ away: side(), home: side(), league, park: 'Target Field' });
  const coors = projectGame({ away: side(), home: side(), league, park: 'Coors Field' });
  assert.ok(flat.f5.projTotal < flat.projTotal, 'five innings score less than nine');
  assert.ok(flat.f5.projTotal / flat.projTotal > 0.5 && flat.f5.projTotal / flat.projTotal < 0.62);
  assert.ok(coors.f5.projTotal > flat.f5.projTotal, 'Coors lifts the F5 total too');
  close(flat.f5.pHome + flat.f5.pAway + flat.f5.pTie, 1, 1e-9, 'partition');
});

// ── parsing ────────────────────────────────────────────────────────────────

test('the F5 book markets parse, and a three-way Draw price is ignored on purpose', () => {
  const event = {
    home_team: 'Home',
    away_team: 'Away',
    bookmakers: [
      {
        key: 'draftkings',
        markets: [
          { key: 'h2h', outcomes: [{ name: 'Home', price: -130 }, { name: 'Away', price: 110 }] },
          // Three-way: the tie is its own outcome and its price is not a side.
          { key: 'h2h_1st_5_innings', outcomes: [{ name: 'Home', price: -105 }, { name: 'Away', price: 130 }, { name: 'Draw', price: 460 }] },
          { key: 'spreads_1st_5_innings', outcomes: [{ name: 'Home', price: 120, point: -0.5 }, { name: 'Away', price: -140, point: 0.5 }] },
          { key: 'totals_1st_5_innings', outcomes: [{ name: 'Over', price: -115, point: 4.5 }, { name: 'Under', price: -105, point: 4.5 }] },
          // A mismatched pair is not one market, F5 or otherwise.
          { key: 'spreads_1st_5_innings', outcomes: [{ name: 'Home', price: 120, point: -0.5 }, { name: 'Away', price: -140, point: 1.5 }] },
        ],
      },
    ],
  };
  const q = parseGameOdds(event);
  assert.deepEqual(q.f5_ml, [{ book: 'DK', point: 0, over: -105, under: 130, w: 1 }]);
  assert.equal(q.f5_spread.length, 1);
  assert.equal(q.f5_spread[0].point, -0.5);
  assert.equal(q.f5_total[0].point, 4.5);
  // The full-game markets are untouched by any of it.
  assert.equal(q.game_ml[0].over, -130);
});

test('a feed that serves no F5 markets shows nothing rather than erroring', () => {
  const event = {
    home_team: 'Home',
    away_team: 'Away',
    bookmakers: [{ key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: -130 }, { name: 'Away', price: 110 }] }] }],
  };
  const q = parseGameOdds(event);
  for (const key of Object.keys(TEAM_MARKETS)) assert.ok(Array.isArray(q[key]), `${key} bucket exists`);
  assert.deepEqual(q.f5_ml, []);
  assert.deepEqual(q.f5_total, []);

  const model = projectGame({
    away: { offense: { runs: 675, gamesPlayed: 150 }, homePark: 'Target Field', starter: null, bullpen: null },
    home: { offense: { runs: 675, gamesPlayed: 150 }, homePark: 'Target Field', starter: null, bullpen: null },
    league: { rpg: 4.49, spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 },
    park: 'Target Field',
  });
  const rows = priceTeamMarkets(model, q, null);
  assert.deepEqual(rows.map((r) => r.market), ['game_ml']);
});

// ── pricing ────────────────────────────────────────────────────────────────

test('F5 rows are priced beside the game lines, and carry the tie as the push', () => {
  const model = projectGame({
    away: { offense: { runs: 675, gamesPlayed: 150 }, homePark: 'Target Field', starter: null, bullpen: null },
    home: { offense: { runs: 700, gamesPlayed: 150 }, homePark: 'Target Field', starter: null, bullpen: null },
    league: { rpg: 4.49, spRa9: 4.1, rpRa9: 3.9, allRa9: 4.0, fipConstant: 3.1 },
    park: 'Target Field',
  });
  const q = (point, over, under) => [{ book: 'DK', point, over, under, w: 1 }];
  const books = {
    game_ml: q(0, -120, 100),
    game_spread: q(-1.5, 140, -160),
    game_total: q(8.5, -110, -110),
    f5_ml: q(0, -105, 130),
    f5_spread: q(-0.5, 120, -140),
    f5_total: q(4.5, -115, -105),
  };
  const rows = priceTeamMarkets(model, books, null);
  const by = Object.fromEntries(rows.map((r) => [r.market, r]));
  assert.deepEqual(Object.keys(by).sort(), ['f5_ml', 'f5_spread', 'f5_total', 'game_ml', 'game_spread', 'game_total']);

  // The moneyline row's push IS the tie, and the model number is conditional.
  close(by.f5_ml.push, model.f5.pTie, 1e-12, 'tie recorded as push');
  close(by.f5_ml.modelOver, model.f5.pHome / (model.f5.pHome + model.f5.pAway), 1e-12, 'conditional home');
  assert.equal(by.f5_spread.push, 0);
  assert.equal(by.f5_total.push, 0);
  assert.equal(by.f5_total.line, 4.5);
  // Information only, exactly like the full-game lines beside them. At the
  // shipped weights every row is a PASS on arithmetic alone, so the rule is
  // shown by lending the market the weight that would otherwise reach LEAN —
  // which also proves F5 borrows the game lines' weight rather than the 0.55
  // default a market with no MARKET_WEIGHT entry would get.
  for (const row of rows) assert.equal(row.edge.verdict, 'PASS');
  const had = MARKET_WEIGHT.game_total;
  MARKET_WEIGHT.game_total = 0.3;
  try {
    // Even prices the model disagrees with, so the row would otherwise clear
    // LEAN and the demotion has something to demote. The total is left out:
    // at a posted F5 line the model and an even-money book agree to within a
    // point or two, and no price manufactures a disagreement that is not there.
    const juicy = { ...books, f5_ml: q(0, 130, 130), f5_spread: q(-0.5, 150, 150) };
    const lent = priceTeamMarkets(model, juicy, null).filter((r) => r.market === 'f5_ml' || r.market === 'f5_spread');
    assert.equal(lent.length, 2);
    for (const row of lent) {
      assert.equal(row.edge.verdict, 'PASS', row.market);
      assert.ok(
        row.edge.why.some((w) => w.includes('information only')),
        `${row.market}: ${row.edge.why.join()}`,
      );
    }
  } finally {
    MARKET_WEIGHT.game_total = had;
  }
});

// ── wording ────────────────────────────────────────────────────────────────

test('an F5 row says F5 in plain words on both sides', () => {
  const game = { home: { name: 'Cleveland Guardians' }, away: { name: 'Detroit Tigers' } };
  const row = (market, line) => ({ market, line, game });
  assert.equal(pickText(row('f5_ml', 0), 'over'), 'Guardians lead after 5');
  assert.equal(pickText(row('f5_ml', 0), 'under'), 'Tigers lead after 5');
  assert.equal(pickText(row('f5_spread', -0.5), 'over'), 'Guardians -0.5 (F5)');
  assert.equal(pickText(row('f5_spread', -0.5), 'under'), 'Tigers +0.5 (F5)');
  assert.equal(pickText(row('f5_total', 4.5), 'over'), 'Over 4.5 runs in 5');
  assert.equal(pickText(row('f5_total', 4.5), 'under'), 'Under 4.5 runs in 5');
});

// ── settlement ─────────────────────────────────────────────────────────────

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

const inning = (a, h) => ({ away: { runs: a }, home: { runs: h } });

test('F5 rows settle on the first five innings, not on the final score', async () => {
  // Away leads 3-1 after five and the total is 4; the home team then wins 7-3.
  // Every F5 row must be graded against the first five, and the full-game
  // rows against the nine.
  const restore = stubMlb({
    '/api/v1/schedule': {
      dates: [{
        games: [{
          gamePk: 9,
          status: { abstractGameState: 'Final' },
          linescore: {
            teams: { away: { runs: 3 }, home: { runs: 7 } },
            innings: [inning(2, 0), inning(0, 0), inning(1, 1), inning(0, 0), inning(0, 0), inning(0, 3), inning(0, 3), inning(0, 0), inning(0, 0)],
          },
        }],
      }],
    },
    '/api/v1/game/9/boxscore': { teams: { away: { players: {} }, home: { players: {} } } },
  });
  try {
    const rows = [
      { kind: 'game', gamePk: 9, playerId: 9, market: 'f5_total', line: 4.5, side: 'under' }, // 4 runs -> WIN
      { kind: 'game', gamePk: 9, playerId: 9, market: 'f5_total', line: 3.5, side: 'over' }, // 4 runs -> WIN
      { kind: 'game', gamePk: 9, playerId: 9, market: 'f5_ml', line: 0, side: 'over' }, // home trailed -> LOSS
      { kind: 'game', gamePk: 9, playerId: 9, market: 'f5_spread', line: 0.5, side: 'over' }, // home +0.5, margin -2 -> LOSS
      { kind: 'game', gamePk: 9, playerId: 9, market: 'f5_spread', line: 2.5, side: 'over' }, // home +2.5 -> WIN
      { kind: 'game', gamePk: 9, playerId: 9, market: 'game_ml', line: 0, side: 'over' }, // home won -> WIN
      { kind: 'game', gamePk: 9, playerId: 9, market: 'game_total', line: 9.5, side: 'over' }, // 10 -> WIN
    ];
    const graded = await gradeSlate({ date: '2026-09-06', snapshot: { rows } });
    assert.deepEqual(graded.map((r) => r.result), ['WIN', 'WIN', 'LOSS', 'LOSS', 'WIN', 'WIN', 'WIN']);
  } finally {
    restore();
  }
});

test('level after five is a PUSH on the F5 moneyline, and a game stopped short voids it', async () => {
  const restore = stubMlb({
    '/api/v1/schedule': {
      dates: [{
        games: [
          // 2-2 after five, home wins 5-2. F5 moneyline pushes.
          { gamePk: 1, status: { abstractGameState: 'Final' }, linescore: { teams: { away: { runs: 2 }, home: { runs: 5 } }, innings: [inning(1, 0), inning(0, 1), inning(1, 1), inning(0, 0), inning(0, 0), inning(0, 3), inning(0, 0), inning(0, 0), inning(0, 0)] } },
          // Rained out after four: no F5 market has an outcome.
          { gamePk: 2, status: { abstractGameState: 'Final' }, linescore: { teams: { away: { runs: 1 }, home: { runs: 4 } }, innings: [inning(1, 2), inning(0, 1), inning(0, 1), inning(0, 0)] } },
        ],
      }],
    },
    '/api/v1/game/1/boxscore': { teams: { away: { players: {} }, home: { players: {} } } },
    '/api/v1/game/2/boxscore': { teams: { away: { players: {} }, home: { players: {} } } },
  });
  try {
    const rows = [
      { kind: 'game', gamePk: 1, playerId: 1, market: 'f5_ml', line: 0, side: 'over' },
      { kind: 'game', gamePk: 2, playerId: 2, market: 'f5_ml', line: 0, side: 'over' },
      { kind: 'game', gamePk: 2, playerId: 2, market: 'f5_total', line: 4.5, side: 'under' },
    ];
    const graded = await gradeSlate({ date: '2026-09-07', snapshot: { rows } });
    assert.deepEqual(graded.map((r) => r.result), ['PUSH', 'VOID', 'VOID']);
  } finally {
    restore();
  }
});
