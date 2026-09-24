// gradeSlate — RESULTS grading (minified: `ih`).
//
// Re-fetches the schedule for a date, pulls a boxscore for every Final game
// *sequentially* (one status line per game), flattens every player's pitching
// and batting line into a single map keyed by player id, then walks the saved
// snapshot rows and scores each one against the actual value for its distKey.

import { mlbFetch } from '../lib/api.js';
import { parseInningsPitched } from '../model/pitcher.js';

export async function gradeSlate({ date, snapshot, onStatus }) {
  const status = (message) => onStatus && onStatus(message);

  status('Fetching final boxscores…');
  const finals = (
    (await mlbFetch(`/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`)).dates?.[0]
      ?.games || []
  ).filter((game) => game.status?.abstractGameState === 'Final');

  // FIX(v35) — actuals are keyed by GAME and player. Keyed by player alone, the
  // second game of a doubleheader overwrote the first, so every doubleheader
  // prop was graded against whichever boxscore happened to be read last
  // (2026-09-04 DET@CLE: 13 batters had different hit totals across the two
  // games). `gamesByPlayer` lets a pre-v35 row with no gamePk be graded only
  // when the player appeared in exactly one game that day.
  const actuals = new Map(); // `${gamePk}:${playerId}` -> { pitching?, batting? }
  const gamesByPlayer = new Map(); // playerId -> Set<gamePk>

  // Game-line results straight from the linescore: final score and first inning.
  const gameResults = new Map();
  for (const game of finals) {
    const ls = game.linescore;
    const away = ls?.teams?.away?.runs ?? game.teams?.away?.score;
    const home = ls?.teams?.home?.runs ?? game.teams?.home?.score;
    if (away == null || home == null) continue;
    const first = ls?.innings?.[0];
    // First five innings, straight off the linescore. A book grades F5 once
    // five innings are complete, so a game that did not get there voids them
    // — `f5` stays null and the rows settle VOID, the same way a shortened
    // game voids the full-game total and run line. Taken as the first five
    // ENTRIES rather than `num <= 5`: the linescore is ordered, and a payload
    // without `num` must not silently yield no innings at all.
    const five = (ls?.innings || []).slice(0, 5);
    const f5 =
      five.length === 5 && five.every((i) => i.away?.runs != null && i.home?.runs != null)
        ? {
            margin: five.reduce((s, i) => s + i.home.runs - i.away.runs, 0),
            total: five.reduce((s, i) => s + i.home.runs + i.away.runs, 0),
          }
        : null;
    gameResults.set(game.gamePk, {
      f5,
      // Sportsbooks void run lines and totals on a game called before nine
      // innings (8.5 with the home side ahead, which still shows 9 innings in
      // the linescore). The moneyline stands once the game is official.
      fullLength: (ls?.innings?.length ?? 9) >= 9,
      margin: home - away,
      total: home + away,
      firstInning:
        first && first.away?.runs != null && first.home?.runs != null
          ? first.away.runs + first.home.runs
          : null,
    });
  }

  // Boxscores are fetched concurrently. This used to be a sequential loop so
  // that each game could get its own status line, which cost one full round
  // trip per Final game — 15 on a normal slate, and RESULTS grades a whole
  // history of them. The counter below carries the same information.
  let done = 0;
  const boxes = await Promise.all(
    finals.map(async (game) => {
      const box = await mlbFetch(`/api/v1/game/${game.gamePk}/boxscore`);
      status(`Boxscores ${++done}/${finals.length}…`);
      return box;
    }),
  );

  boxes.forEach((box, boxIndex) => {
    const gamePk = finals[boxIndex].gamePk;
    for (const side of ['away', 'home']) {
      const players = box.teams?.[side]?.players || {};
      for (const key of Object.keys(players)) {
        const entry = players[key];
        const playerId = entry.person?.id;
        if (!playerId) continue;

        const rec = actuals.get(`${gamePk}:${playerId}`) || {};
        const pitching = entry.stats?.pitching;
        const batting = entry.stats?.batting;

        if (pitching && Object.keys(pitching).length)
          rec.pitching = {
            k: pitching.strikeOuts || 0,
            outs: Math.round(parseInningsPitched(pitching.inningsPitched) * 3),
            hits: pitching.hits || 0,
            er: pitching.earnedRuns || 0,
            bb: pitching.baseOnBalls || 0,
            pitches: pitching.numberOfPitches || pitching.pitchesThrown || 0,
          };

        // A batting line only counts if the player actually came to the plate.
        if (
          batting &&
          Object.keys(batting).length &&
          (batting.plateAppearances || 0) > 0
        )
          rec.batting = {
            hits: batting.hits || 0,
            hr: batting.homeRuns || 0,
            tb: batting.totalBases || 0,
            runs: batting.runs || 0,
            rbi: batting.rbi || 0,
            k: batting.strikeOuts || 0,
            sb: batting.stolenBases || 0,
            singles:
              (batting.hits || 0) -
              (batting.doubles || 0) -
              (batting.triples || 0) -
              (batting.homeRuns || 0),
            hrr: (batting.hits || 0) + (batting.runs || 0) + (batting.rbi || 0),
          };

        actuals.set(`${gamePk}:${playerId}`, rec);
        if (!gamesByPlayer.has(playerId)) gamesByPlayer.set(playerId, new Set());
        gamesByPlayer.get(playerId).add(gamePk);
      }
    }
  });

  /** The actual value a snapshot row settles on, or undefined. */
  const actualFor = (row) => {
    if (row.kind === 'game' || row.kind === 'nrfi') {
      const result = gameResults.get(row.gamePk ?? row.playerId);
      if (!result) return undefined;
      if (row.kind === 'nrfi') return result.firstInning ?? undefined;
      // First five innings settle on the first five innings, and need five of
      // them — not nine. Checked before the full-length rule below, which is
      // about the ninth inning and says nothing about these.
      if (row.market?.startsWith('f5_')) {
        if (!result.f5) return 'VOID';
        return row.market === 'f5_total' ? result.f5.total : result.f5.margin;
      }
      if (row.market !== 'game_ml' && !result.fullLength) return 'VOID';
      if (row.market === 'game_total') return result.total;
      // Moneyline and run line settle on the home margin. "over" is the home
      // side, so the home side wins when margin > -line (line 0 for ML).
      return result.margin;
    }
    let gamePk = row.gamePk;
    if (gamePk == null) {
      const games = gamesByPlayer.get(row.playerId);
      // A legacy row for a player who played twice cannot be placed: say so
      // rather than grade it against a guess.
      if (!games || games.size !== 1) return undefined;
      gamePk = [...games][0];
    }
    const rec = actuals.get(`${gamePk}:${row.playerId}`);
    const line = row.kind === 'pitcher' ? rec?.pitching : rec?.batting;
    return line ? line[row.distKey] : undefined;
  };

  /** The number `actual` is compared against for "over". */
  const settleLine = (row) =>
    row.kind === 'game' && !row.market?.endsWith('_total') ? -(row.line ?? 0) : row.line;

  const graded = [];
  for (const row of snapshot?.rows || []) {
    const actual = actualFor(row);
    if (actual === 'VOID') {
      graded.push({ ...row, actual: null, result: 'VOID' });
      continue;
    }

    if (actual === undefined) {
      graded.push({ ...row, actual: null, result: 'NO DATA' });
      continue;
    }

    // Book lines are usually half-points, so PUSH only happens on integer lines.
    let over = 'PUSH';
    const against = settleLine(row);
    if (actual > against) over = 'over';
    else if (actual < against) over = 'under';

    const result =
      row.side && over !== 'PUSH'
        ? over === row.side
          ? 'WIN'
          : 'LOSS'
        : over === 'PUSH'
          ? 'PUSH'
          : '—';

    graded.push({ ...row, actual, result });
  }

  status('Done.');
  return graded;
}
