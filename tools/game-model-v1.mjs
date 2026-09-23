// The v36 game model, frozen.
//
// The v2 study scored its candidate against "the shipped model" by calling
// `projectGame` from src/model/game.js. Once the study's inputs were PORTED
// into that file (v37), that call stopped being a control and started being
// the new model measuring itself, so the control is frozen here instead:
// this is `projectGame` and `weatherFactor` exactly as they stood at commit
// 7265ac8, with the constants they had then.
//
// Nothing below the inputs is copied. The convolution, the walk-off logic, the
// Gauss-Hermite mixture and the market readers are imported from
// src/model/game.js, because the port did not touch any of them — which is
// itself worth checking, and test/game.test.js checks it. Only the two
// constants the port DID move (`EXPLAINED_TEAM_SD`, and therefore the residual
// team sigma) are pinned back to their v36 values here.

import {
  AWAY_HALF_MEANS, HOME_HALF_MEANS, EXTRA_INNING_PMF, CALIBRATION_RPG,
  SIGMA_SHARED, SIGMA_TEAM_TOTAL,
  uncertainScoreGrid, summarizeGrid, totalProbs, spreadProbs, firstInningScoreless,
  runsAllowedTalent,
} from '../src/model/game.js';
import { parkFactor } from '../src/lib/parks.js';
import { probToAmerican } from '../src/lib/odds.js';
import { clamp } from '../src/lib/probability.js';

/** v36 values. */
const HOME_ADJUST = 0.988;
const HOME_EXTRA_RATIO = 1.089;
const EXPLAINED_TEAM_SD = 0.12;
const SIGMA_TEAM = Math.sqrt(SIGMA_TEAM_TOTAL ** 2 - EXPLAINED_TEAM_SD ** 2);
const OPTS = { sigmaShared: SIGMA_SHARED, sigmaTeam: SIGMA_TEAM };

/** v36 weather: temperature only, 2.5% per 10F, no wind at any speed. */
export function weatherFactorV1(wx) {
  if (!wx || wx.indoor || wx.tempF == null) return 1;
  return clamp(1 + 0.0025 * (wx.tempF - 72), 0.94, 1.06);
}

/** `projectGame` as it stood before the port. */
export function projectGameV1({ away, home, league, park, wx }) {
  const env = parkFactor(park, 'runs', 0.7) * weatherFactorV1(wx);

  const ownPark = (side) => 0.5 + 0.5 * parkFactor(side.homePark, 'runs', 0.7);

  const offenseIndex = (side) => {
    const o = side.offense;
    if (!o?.gamesPlayed || o.runs == null) return { value: 1, parts: {} };
    const raw = o.runs / o.gamesPlayed / ownPark(side) / league.rpg;
    const shrunk = (o.gamesPlayed * raw + 25) / (o.gamesPlayed + 25);
    const lineup = side.lineupOpsRatio ? clamp(side.lineupOpsRatio ** 1.7, 0.9, 1.1) : 1;
    return { value: shrunk * lineup, parts: { season: shrunk, lineup } };
  };

  const pitchingIndex = (side) => {
    const p = ownPark(side);
    const starter = side.starter
      ? runsAllowedTalent(
          [{ stat: side.starter.s26, weight: 1 }, { stat: side.starter.s25, weight: 0.6 }],
          league.spRa9, 60, league.fipConstant, p,
        )
      : { ra9: league.spRa9, ip: 0 };
    const bullpen = side.bullpen
      ? runsAllowedTalent([{ stat: side.bullpen, weight: 1 }], league.rpRa9, 120, league.fipConstant, p)
      : { ra9: league.rpRa9, ip: 0 };
    return {
      starter: clamp(starter.ra9 / league.allRa9, 0.55, 1.7),
      bullpen: clamp(bullpen.ra9 / league.allRa9, 0.7, 1.4),
      starterRa9: starter.ra9,
      bullpenRa9: bullpen.ra9,
      projIP: clamp(side.starter?.projIP ?? 5.2, 1, 9),
    };
  };

  const off = { away: offenseIndex(away), home: offenseIndex(home) };
  const pit = { away: pitchingIndex(away), home: pitchingIndex(home) };
  const level = league.rpg / CALIBRATION_RPG;

  const halfMeans = (base, batting, fielding) =>
    base.map((leagueMean, i) => {
      const starterShare = clamp(fielding.projIP - i, 0, 1);
      const pitching = starterShare * fielding.starter + (1 - starterShare) * fielding.bullpen;
      return leagueMean * level * batting.value * pitching * env;
    });

  const extraBase = EXTRA_INNING_PMF.reduce((s, p, k) => s + p * k, 0);
  const scoring = {
    awayHalfMeans: halfMeans(AWAY_HALF_MEANS, off.away, pit.home),
    homeHalfMeans: halfMeans(HOME_HALF_MEANS, off.home, pit.away).map((m) => m * HOME_ADJUST),
    awayExtraMean: extraBase * off.away.value * pit.home.bullpen * env,
    homeExtraMean: extraBase * off.home.value * pit.away.bullpen * env * HOME_EXTRA_RATIO * HOME_ADJUST,
  };
  const summary = summarizeGrid(uncertainScoreGrid(scoring, OPTS));
  const nrfiProb = firstInningScoreless(scoring, OPTS);

  const flags = [];
  if (!away.starter || !home.starter) flags.push('NO PROBABLE');
  if (!away.offense?.gamesPlayed || !home.offense?.gamesPlayed) flags.push('NO TEAM STATS');

  let fairTotal = 8.5;
  let bestGap = Infinity;
  for (let line = 4.5; line <= 16.5; line += 1) {
    const gap = Math.abs(totalProbs(summary, line).over - 0.5);
    if (gap < bestGap) { fairTotal = line; bestGap = gap; }
  }

  return {
    pHome: summary.pHome,
    pAway: 1 - summary.pHome,
    projAway: summary.meanAway,
    projHome: summary.meanHome,
    projTotal: summary.meanAway + summary.meanHome,
    fairHomeOdds: probToAmerican(summary.pHome),
    fairAwayOdds: probToAmerican(1 - summary.pHome),
    total: (line) => totalProbs(summary, line),
    spread: (homeSpread) => spreadProbs(summary, homeSpread),
    fairTotal,
    nrfi: {
      nrfiProb,
      yrfiProb: 1 - nrfiProb,
      fairNrfiOdds: probToAmerican(nrfiProb),
      fairYrfiOdds: probToAmerican(1 - nrfiProb),
    },
    inputs: { env, offense: off, pitching: pit },
    flags,
  };
}
