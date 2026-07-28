// Coverage for the projected-lineup path and the odds-request dedupe.
//
// `globalThis.fetch` is stubbed rather than the modules under test, so these
// exercise the real `mlbFetch` / `oddsFetch` plumbing (path encoding, proxy
// contract, chunking) alongside the projection logic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSlate } from '../src/data/loadSlate.js';
import { SEASON } from '../src/lib/api.js';

const DATE = '2026-07-28';

// Two matchups. AWAY/HOME (ids 10/20) have posted cards. ROAD/HOST (30/40) do
// not, and play a doubleheader — which is also the duplicate-odds-event case.
const TEAMS = {
  10: { id: 10, name: 'Away Anchors', abbreviation: 'AWA', teamName: 'Anchors' },
  20: { id: 20, name: 'Home Harbors', abbreviation: 'HOM', teamName: 'Harbors' },
  30: { id: 30, name: 'Road Runners', abbreviation: 'ROA', teamName: 'Runners' },
  40: { id: 40, name: 'Host Hounds', abbreviation: 'HOS', teamName: 'Hounds' },
};

const named = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: Number(`${prefix}${String(i + 1).padStart(2, '0')}`),
    fullName: `${prefix} Batter${i + 1}`,
  }));

const POSTED_AWAY = named('11', 9);
const POSTED_HOME = named('22', 9);
const RECENT_ROAD = named('33', 9);
const RECENT_HOST = named('44', 9);

function scheduleGame({ gamePk, away, home, lineups, gameDate }) {
  return {
    gamePk,
    gameDate,
    status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
    venue: { id: 1, name: 'Test Field' },
    teams: {
      away: { team: TEAMS[away], probablePitcher: { id: 900 + away, fullName: `SP ${away}` } },
      home: { team: TEAMS[home], probablePitcher: { id: 900 + home, fullName: `SP ${home}` } },
    },
    ...(lineups ? { lineups } : {}),
  };
}

/** Boxscore with `battingOrder` encoded the way MLB does it: slot*100 + seq. */
function boxscore(teamId, order) {
  const players = {};
  order.forEach((p, i) => {
    players[`ID${p.id}`] = {
      person: { id: p.id, fullName: p.fullName },
      battingOrder: String((i + 1) * 100),
    };
  });
  // A pinch hitter who took over the 4-hole: same slot, non-zero sequence, so
  // he must not be mistaken for a starter.
  players.ID99999 = {
    person: { id: 99999, fullName: 'Pinch Hitter' },
    battingOrder: '401',
  };
  return {
    teams: {
      away: { team: { id: teamId }, players },
      home: { team: { id: teamId + 1000 }, players: {} },
    },
  };
}

function rosterPayload(order) {
  return {
    roster: [
      ...order.map((p, i) => ({
        person: {
          id: p.id,
          fullName: p.fullName,
          stats: [{ splits: [{ stat: { plateAppearances: 400 - i } }] }],
        },
        position: { abbreviation: 'CF', type: 'Outfielder' },
      })),
      // Pitchers on the active roster must never reach the fallback tier.
      {
        person: { id: 98765, fullName: 'Reliever Guy' },
        position: { abbreviation: 'P', type: 'Pitcher' },
      },
    ],
  };
}

const ODDS_EVENTS = [
  {
    id: 'a'.repeat(32),
    home_team: 'Home Harbors',
    away_team: 'Away Anchors',
    commence_time: `${DATE}T17:05:00Z`,
  },
  {
    id: 'b'.repeat(32),
    home_team: 'Host Hounds',
    away_team: 'Road Runners',
    commence_time: `${DATE}T22:10:00Z`,
  },
];

/**
 * Install a stubbed `globalThis.fetch` and return the call log.
 *
 * @param {object} [options]
 * @param {boolean} [options.doubleheader] - Add a second ROAD@HOST game that
 *   the odds feed still lists as one event.
 */
function stubFetch({ doubleheader = true } = {}) {
  const calls = { mlb: [], odds: [] };

  const games = [
    scheduleGame({
      gamePk: 1,
      away: 10,
      home: 20,
      gameDate: `${DATE}T17:05:00Z`,
      lineups: { awayPlayers: POSTED_AWAY, homePlayers: POSTED_HOME },
    }),
    scheduleGame({ gamePk: 2, away: 30, home: 40, gameDate: `${DATE}T22:10:00Z` }),
  ];
  if (doubleheader)
    games.push(
      scheduleGame({ gamePk: 3, away: 30, home: 40, gameDate: `${DATE}T01:10:00Z` }),
    );

  const json = (body) => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'x-requests-remaining' ? '5000' : null) },
    json: async () => body,
  });

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'http://test.local');

    if (u.pathname === '/api/mlb') {
      const path = u.searchParams.get('path');
      calls.mlb.push(path);
      const p = new URL(path, 'https://statsapi.mlb.com');
      const q = p.searchParams;

      if (p.pathname === '/api/v1/schedule') {
        // Slate schedule vs. a team's lookback window.
        if (!q.get('teamId')) return json({ dates: [{ games }] });
        const teamId = Number(q.get('teamId'));
        return json({
          dates: [
            {
              games: [
                {
                  gamePk: 5000 + teamId,
                  gameDate: '2026-07-26T23:05:00Z',
                  status: { abstractGameState: 'Final' },
                },
              ],
            },
          ],
        });
      }
      if (p.pathname === '/api/v1/teams/stats') return json({ stats: [{ splits: [] }] });
      if (/^\/api\/v1\/teams\/\d+\/roster$/.test(p.pathname)) {
        const teamId = Number(p.pathname.split('/')[4]);
        return json(rosterPayload(teamId === 30 ? RECENT_ROAD : RECENT_HOST));
      }
      if (/^\/api\/v1\/game\/\d+\/boxscore$/.test(p.pathname)) {
        const teamId = Number(p.pathname.split('/')[4]) - 5000;
        return json(boxscore(teamId, teamId === 30 ? RECENT_ROAD : RECENT_HOST));
      }
      if (p.pathname === '/api/v1/people') return json({ people: [] });
      if (p.pathname === '/api/v1/venues') return json({ venues: [] });
      throw new Error(`unstubbed MLB path: ${p.pathname}`);
    }

    if (u.pathname === '/api/odds') {
      const endpoint = u.searchParams.get('endpoint');
      calls.odds.push({ endpoint, eventId: u.searchParams.get('eventId') });
      if (endpoint === 'events') return json(ODDS_EVENTS);
      return json({ bookmakers: [] });
    }

    // open-meteo and anything else: no data, exercised via the silent catch.
    throw new Error(`unstubbed host: ${u.href}`);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function load(options) {
  const stub = stubFetch(options);
  try {
    return { slate: await loadSlate({ date: DATE }), calls: stub.calls };
  } finally {
    stub.restore();
  }
}

const mlbCalls = (calls, re) => calls.mlb.filter((p) => re.test(p));

test('a posted lineup is used verbatim and marked confirmed', async () => {
  const { slate, calls } = await load();
  const game = slate.games.find((g) => g.gamePk === 1);

  assert.equal(game.batters.length, 18);
  assert.deepEqual(
    game.batters.filter((b) => b.side === 'away').map((b) => b.name),
    POSTED_AWAY.map((p) => p.fullName),
  );
  assert.deepEqual(
    game.batters.filter((b) => b.side === 'away').map((b) => b.slot),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  for (const batter of game.batters) {
    assert.equal(batter.lineupSource, 'confirmed');
    assert.ok(!batter.flags.includes('PROJ LINEUP'));
  }

  assert.equal(game.lineupStatus, 'confirmed');
  assert.deepEqual(game.lineups, { away: 'confirmed', home: 'confirmed' });

  // Teams with a posted card are never looked up.
  assert.equal(mlbCalls(calls, /teamId=10|teamId=20/).length, 0);
  assert.equal(mlbCalls(calls, /teams\/(10|20)\/roster/).length, 0);
});

test('a game with no posted lineup gets nine projected batters per side', async () => {
  const { slate } = await load();
  const game = slate.games.find((g) => g.gamePk === 2);

  const away = game.batters.filter((b) => b.side === 'away');
  const home = game.batters.filter((b) => b.side === 'home');
  assert.equal(away.length, 9);
  assert.equal(home.length, 9);

  // Order and names come from the last completed game's actual batting order,
  // and the pinch hitter in the 4-hole is not one of them.
  assert.deepEqual(away.map((b) => b.name), RECENT_ROAD.map((p) => p.fullName));
  assert.ok(!game.batters.some((b) => b.name === 'Pinch Hitter'));
  assert.ok(!game.batters.some((b) => b.name === 'Reliever Guy'));

  for (const batter of game.batters) {
    assert.equal(batter.lineupSource, 'projected');
    assert.ok(batter.flags.includes('PROJ LINEUP'));
    assert.match(batter.lineupProvenance, /^last lineup 2026-07-26$/);
  }

  assert.equal(game.lineupStatus, 'projected');
  assert.deepEqual(game.lineups, { away: 'projected', home: 'projected' });
});

test('slate-level lineup counts are reported alongside lineupsPosted', async () => {
  const { slate } = await load();

  assert.equal(slate.games.length, 3);
  assert.deepEqual(slate.lineupCounts, { confirmed: 1, projected: 2, none: 0 });
  // Unchanged meaning: only the game MLB actually posted a card for.
  assert.equal(slate.lineupsPosted, 1);
  assert.equal(slate.lineupError, null);
});

test('per-team fetches are cached across a doubleheader', async () => {
  const { calls } = await load({ doubleheader: true });

  // Two half-games per team need projecting, but each team is fetched once.
  for (const teamId of [30, 40]) {
    assert.equal(mlbCalls(calls, new RegExp(`teamId=${teamId}\\b`)).length, 1);
    assert.equal(mlbCalls(calls, new RegExp(`teams/${teamId}/roster`)).length, 1);
  }
  // One boxscore per team, not per half-game: tier 1 filled all nine slots.
  assert.equal(mlbCalls(calls, /boxscore/).length, 2);
});

test('duplicate odds events are requested once', async () => {
  const { slate, calls } = await load({ doubleheader: true });

  const eventOdds = calls.odds.filter((c) => c.endpoint === 'event-odds');
  // Three games, two distinct events — the doubleheader used to buy the same
  // event twice, in parallel, at full price.
  assert.equal(eventOdds.length, 2);
  assert.deepEqual(
    [...new Set(eventOdds.map((c) => c.eventId))].sort(),
    ['a'.repeat(32), 'b'.repeat(32)],
  );
  assert.equal(slate.oddsRequests, 2);
});

test('projection can be switched off, restoring posted-lineups-only behaviour', async () => {
  const stub = stubFetch();
  try {
    const slate = await loadSlate({ date: DATE, projectLineups: false });
    assert.equal(slate.games.find((g) => g.gamePk === 2).batters.length, 0);
    assert.deepEqual(slate.lineupCounts, { confirmed: 1, projected: 0, none: 2 });
    assert.equal(mlbCalls(stub.calls, /boxscore/).length, 0);
  } finally {
    stub.restore();
  }
});

test('the roster hydrate asks for the current season', async () => {
  const { calls } = await load();
  const roster = calls.mlb.find((p) => /teams\/30\/roster/.test(p));
  assert.ok(roster.includes(`season=${SEASON}`), roster);
  assert.ok(roster.includes('rosterType=active'), roster);
});
