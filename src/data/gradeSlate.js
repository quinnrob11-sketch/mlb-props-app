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
    (await mlbFetch(`/api/v1/schedule?sportId=1&date=${date}`)).dates?.[0]
      ?.games || []
  ).filter((game) => game.status?.abstractGameState === 'Final');

  // playerId -> { pitching?, batting? }
  const actualsByPlayer = new Map();

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

  for (const box of boxes) {
    for (const side of ['away', 'home']) {
      const players = box.teams?.[side]?.players || {};
      for (const key of Object.keys(players)) {
        const entry = players[key];
        const playerId = entry.person?.id;
        if (!playerId) continue;

        const rec = actualsByPlayer.get(playerId) || {};
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

        actualsByPlayer.set(playerId, rec);
      }
    }
  }

  const graded = [];
  for (const row of snapshot?.rows || []) {
    const rec = actualsByPlayer.get(row.playerId);
    const line = row.kind === 'pitcher' ? rec?.pitching : rec?.batting;
    const actual = line ? line[row.distKey] : undefined;

    if (actual === undefined) {
      graded.push({ ...row, actual: null, result: 'NO DATA' });
      continue;
    }

    // Book lines are usually half-points, so PUSH only happens on integer lines.
    let over = 'PUSH';
    if (actual > row.line) over = 'over';
    else if (actual < row.line) over = 'under';

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
