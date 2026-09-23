// Feed the SHIPPED model — `src/model/game.js`, the file the board actually
// runs — from the study's feature table, so the port can be measured on the
// same holdout, against the same prices, as the candidate model it came from.
//
// `tools/game-model-v2.mjs` is the recipe. This is the thing that shipped.
// The two are not identical by design: the study refitted the four structural
// constants on its FIT window alone so the holdout could not appear in them,
// while the shipped file keeps the constants fitted on the whole 2026 season
// (and pinned by test/gameFit.test.js). Everything ABOVE those constants — the
// offence prior, the component starter regression, the lineup, the park
// exponent, the temperature and the signed wind, the first inning — is the
// ported recipe, coefficient for coefficient.
//
// It also knows how to answer the harder question: what would the model have
// been worth with only what was KNOWABLE at the decision time? The study's
// feature table carries two things that are not — the card that took the
// field, and the weather recorded at first pitch — so `inputs` selects:
//
//   lineup:  'posted'    the card that took the field (the study's optimism)
//            'projected' the team's most recent previously-posted card, which
//                        is what src/data/projectedLineup.js builds when MLB
//                        has not posted tonight's
//            'none'      no card at all; the lineup term degrades to 1
//   weather: 'recorded'  first-pitch conditions, wind direction included
//            'forecast'  an Open-Meteo hourly forecast for the first-pitch
//                        hour — temperature and speed, NO direction, which is
//                        exactly what `fetchWeather` gives the live board
//            'none'      no weather at all

import { projectGame } from '../src/model/game.js';
import { rawLineupRatio, starterProjIp } from './game-model-v2.mjs';

/** A feature-table pitching total as a statsapi-shaped season line. */
const statOf = (t) => (t && t.outs
  ? {
      inningsPitched: `${Math.floor(t.outs / 3)}.${t.outs % 3}`,
      earnedRuns: t.er,
      homeRuns: t.hr,
      baseOnBalls: t.bb,
      hitByPitch: t.hbp,
      strikeOuts: t.k,
      battersFaced: t.bf,
    }
  : null);

/**
 * The bullpen the candidate model uses: every reliever on the team, rested and
 * tired together (`bpRestedWeight` fitted to 0, so availability is not used).
 * Taken this way rather than from the team's relief split so the shipped model
 * and the candidate are reading the identical innings.
 */
function bullpenTotals(side) {
  const all = { outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0, bf: 0 };
  for (const f of Object.keys(all)) {
    all[f] = (side.bull?.rested?.[f] || 0) + (side.bull?.tired?.[f] || 0);
  }
  return all;
}

/** The slate-centred lineup ratio for one side, from a chosen card. */
function lineupRatios(side, ctx, mode, projected) {
  if (mode === 'none') return { nine: null, top4: null };
  // 'projected' keeps tonight's posted card when there is one — a posted card
  // is authoritative and the live board uses it the same way — and falls back
  // to the team's most recent previous card when there is not. 'prev' never
  // looks at tonight's card at all, which is the pessimistic reading of how
  // much of the slate is really posted by T-120.
  let card = mode === 'prev' ? projected : side.lineup;
  if (mode === 'projected' && !card?.nine) card = projected;
  if (!card?.nine) return { nine: null, top4: null };
  const from = { ...side, lineup: card };
  const one = (kind) => {
    const raw = rawLineupRatio(from, kind);
    if (raw == null) return null;
    const centre = ctx.lineupCentre?.[kind] || 1;
    return raw / centre;
  };
  return { nine: one('nine'), top4: one('top4') };
}

/**
 * Run `src/model/game.js` on one feature row.
 *
 * @param {object} row   a row from tools/game-features.mjs
 * @param {object} ctx   the league context for that date
 * @param {object} [inputs] { lineup, weather, asof }
 *   `asof` is the per-game record written by tools/game-features-asof.mjs:
 *   { away: {lineup}, home: {lineup}, wx } — the previously-posted cards and
 *   the archived forecast.
 */
export function projectGameSrcFromRow(row, ctx, inputs = {}) {
  const lineupMode = inputs.lineup || 'posted';
  const weatherMode = inputs.weather || 'recorded';
  const asof = inputs.asof || null;

  const side = (which) => {
    const x = row[which];
    const ratios = lineupRatios(x, ctx, lineupMode, asof?.[which]?.lineup);
    const sp = x.starter;
    return {
      offense: { runs: x.off.runs, gamesPlayed: x.off.gamesPlayed },
      offensePrior: x.offPrior?.gamesPlayed
        ? { runs: x.offPrior.runs, gamesPlayed: x.offPrior.gamesPlayed }
        : null,
      homePark: x.homePark,
      lineupOpsRatio: ratios.nine,
      lineupTop4OpsRatio: ratios.top4,
      starter: sp?.curStarts?.outs
        ? {
            s26: statOf(sp.curStarts),
            s25: statOf(sp.prior),
            projIP: starterProjIp(sp),
            restDays: sp.restDays,
          }
        : null,
      bullpen: statOf(bullpenTotals(x)),
    };
  };

  let wx = null;
  if (weatherMode === 'recorded') wx = row.wx || null;
  else if (weatherMode === 'forecast') {
    // Temperature and speed only. The live board's forecast carries no
    // direction, so neither does this, and the wind term goes quiet.
    const f = asof?.wx;
    wx = row.wx?.indoor
      ? { indoor: 1 }
      : f
        ? { indoor: 0, tempF: f.tempF, windMph: f.windMph, windDir: null }
        : null;
  }

  return projectGame({
    away: side('away'),
    home: side('home'),
    league: {
      rpg: ctx.rpg,
      spRa9: ctx.spRa9,
      rpRa9: ctx.rpRa9,
      allRa9: ctx.allRa9,
      fipConstant: ctx.fipConstant,
      spKRate: ctx.spKRate,
      spBbRate: ctx.spBbRate,
      spHrRate: ctx.spHrRate,
      spBfPerIp: ctx.spBfPerIp,
      priorSeasonRpg: ctx.priorSeasonRpg,
    },
    park: row.venue,
    wx,
  });
}
