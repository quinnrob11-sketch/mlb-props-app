// The candidate improved game model ("v2"), built on the feature table from
// tools/game-features.mjs.
//
// It reuses the whole of src/model/game.js below the inputs — the exact
// inning-by-inning convolution, the walk-off and skipped-ninth logic, the
// Gauss-Hermite mixture, the market readers. Nothing about the SHAPE of the
// distribution changes. What changes is the per-game expected runs fed into
// it, which is the part the price study said was close to the market but never
// in front of it:
//
//   1. Team offence regressed with the PRIOR SEASON and a sample-size-dependent
//      weight, instead of a fixed 25-game shrink toward league average.
//   2. The starter regressed COMPONENT BY COMPONENT (K, BB+HBP, HR per batter
//      faced, each with its own prior), blended with a regressed ERA, and with
//      the prior season carrying its own innings rather than a flat 0.6.
//   3. A bullpen index built from the arms that are actually AVAILABLE — every
//      reliever who did not throw on both of the last two days and did not
//      throw 25+ pitches yesterday — plus a fatigue term in the relief innings
//      the pen has already covered.
//   4. Lineup offence from the posted card, and, for the first inning, from the
//      TOP FOUR alone, which is who bats in it.
//   5. Rest, a change of city, and the time-zone shift.
//   6. Wind SPEED AND DIRECTION, not just temperature, and the home-plate
//      umpire's own run history.
//
// Every coefficient lives in one `params` object and is fitted by
// tools/fit-game-v2.mjs on the FIT window only.

import {
  AWAY_HALF_MEANS, HOME_HALF_MEANS, EXTRA_INNING_PMF, CALIBRATION_RPG,
  HOME_ADJUST, WALKOFF_EXACT, SIGMA_TEAM_TOTAL, SIGMA_SHARED,
  uncertainScoreGrid, summarizeGrid, totalProbs, spreadProbs, firstInningScoreless,
  tiltPmf, FIRST_INNING_AWAY_PMF, FIRST_INNING_HOME_PMF, projectGame,
} from '../src/model/game.js';
import { parkFactor } from '../src/lib/parks.js';
import { probToAmerican } from '../src/lib/odds.js';
import { clamp } from '../src/lib/probability.js';

const EXTRA_BASE = EXTRA_INNING_PMF.reduce((s, p, k) => s + p * k, 0);
const HOME_EXTRA_RATIO = 1.089;

/**
 * Defaults. Every one of these is refitted on the FIT window; the values here
 * are only a starting point for the search and a record of what each term is.
 */
export const DEFAULT_PARAMS = {
  // ── team offence ──────────────────────────────────────────────────────────
  offPriorGames: 25, // games of league-average prior (the shipped model's 25)
  offPriorSeasonGames: 0, // how many of the prior season's games to count
  offExp: 1, // exponent on the regressed offence index
  // ── posted lineup ─────────────────────────────────────────────────────────
  lineupExp: 1.7, // runs scale ~ OPS^1.7 (the shipped damping)
  top4Exp: 1.7, // the same, for the four cards that bat in the first inning
  lineupClamp: 0.1, // +-10% (the shipped clamp)
  firstInningAdjust: 1, // level correction on inning one only
  // ── starting pitcher ──────────────────────────────────────────────────────
  spKPriorBF: 300,
  spBbPriorBF: 400,
  spHrPriorBF: 900,
  spEraPriorIP: 60,
  spPriorSeasonWeight: 0.6, // weight on last season's line
  spEraWeight: 0.5, // ERA vs the component (FIP-style) estimate
  spExp: 1,
  spLo: 0.55,
  spHi: 1.7,
  spFirstInningExp: 1, // how much of the starter's edge shows in inning one
  spRestCoef: 0, // per day of rest away from five
  // ── bullpen ───────────────────────────────────────────────────────────────
  bpPriorIP: 120,
  bpRestedWeight: 0, // 0 = season pen, 1 = only the arms available tonight
  bpFatigueCoef: 0, // per relief inning thrown in the last two days, above four
  bpLo: 0.7,
  bpHi: 1.4,
  // ── environment ───────────────────────────────────────────────────────────
  parkExp: 0.7,
  tempCoef: 0.0025, // per degree F above 72
  windCoef: 0, // per mph, signed by direction (out +, in -)
  umpPriorGames: 100,
  umpExp: 0,
  // ── defence ───────────────────────────────────────────────────────────────
  defPriorBF: 3000, // batters faced of league-average prior on team BABIP
  defExp: 0, // exponent on the team's own balls-in-play conversion
  // ── rest and travel ───────────────────────────────────────────────────────
  restCoef: 0, // per day of rest above one
  cityCoef: 0, // changed city since the last game
  tzCoef: 0, // per hour of time-zone shift (negative = travelled west)
  denseCoef: 0, // per game played in the last ten above eight
  // ── structure (refitted by tools/fit-game-model.mjs on FIT) ──────────────
  homeAdjust: HOME_ADJUST,
  walkoffExact: WALKOFF_EXACT,
  sigmaShared: SIGMA_SHARED,
  sigmaTeamTotal: SIGMA_TEAM_TOTAL,
  explainedTeamSd: 0.12,
};

const ipOf = (outs) => outs / 3;
const safeLog = (x) => Math.log(Math.max(1e-6, x));

// ── league context, as of a date ───────────────────────────────────────────

/**
 * Everything league-wide the model needs, rebuilt from the feature rows
 * themselves so no extra request is needed and nothing can look ahead: runs
 * per team-game, the starter/reliever run-prevention baselines, the FIP
 * constant, and each umpire's own scoring history.
 *
 * `rows` must be the FULL chronological table (both seasons); the context for
 * a date only ever reads rows dated before it.
 */
export function buildLeagueContext(rows) {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byDate = new Map(); // date -> context
  const perSeason = new Map(); // season -> running totals

  // Team pitching lines carried forward: a team that is not playing today
  // still has yesterday's line.
  const spLine = new Map(); // `${season}:${teamId}` -> sp totals
  const rpLine = new Map();
  const umpSeen = new Map(); // umpId -> { games, runs }

  // The PRIOR season's league runs per team-game, read off the prior-season
  // team lines the feature table already carries. A team's last-year rate has
  // to be expressed against last year's league, not this one.
  const priorSeasonRpg = new Map(); // season -> runs per team-game a year earlier
  {
    const acc = new Map(); // season -> { runs, games, teams:Set }
    for (const r of sorted) {
      for (const which of ['away', 'home']) {
        const p = r[which].offPrior;
        if (!p?.gamesPlayed) continue;
        if (!acc.has(r.season)) acc.set(r.season, { runs: 0, games: 0, seen: new Set() });
        const a = acc.get(r.season);
        if (a.seen.has(r[which].teamId)) continue;
        a.seen.add(r[which].teamId);
        a.runs += p.runs;
        a.games += p.gamesPlayed;
      }
    }
    for (const [season, a] of acc) if (a.games) priorSeasonRpg.set(season, a.runs / a.games);
  }

  // Per-date centring constants for the posted-lineup ratio.
  const lineupCentre = new Map();
  {
    const acc = new Map();
    for (const r of sorted) {
      for (const which of ['away', 'home']) {
        for (const kind of ['nine', 'top4']) {
          const v = rawLineupRatio(r[which], kind);
          if (v == null) continue;
          if (!acc.has(r.date)) acc.set(r.date, { nine: [], top4: [] });
          acc.get(r.date)[kind].push(v);
        }
      }
    }
    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    for (const [date, a] of acc) {
      lineupCentre.set(date, {
        nine: a.nine.length >= 6 ? med(a.nine) : 1.026,
        top4: a.top4.length >= 6 ? med(a.top4) : 1.03,
      });
    }
  }

  let i = 0;
  const dates = [...new Set(sorted.map((r) => r.date))];
  for (const date of dates) {
    const season = Number(date.slice(0, 4));
    if (!perSeason.has(season)) perSeason.set(season, { runs: 0, teamGames: 0 });
    const s = perSeason.get(season);

    // Aggregate what is known STRICTLY BEFORE this date.
    let sp = { outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0, bf: 0, h: 0 };
    let rp = { outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0, bf: 0, h: 0 };
    for (const [key, line] of spLine) {
      if (!key.startsWith(`${season}:`)) continue;
      for (const f of Object.keys(sp)) sp[f] += line[f] || 0;
    }
    for (const [key, line] of rpLine) {
      if (!key.startsWith(`${season}:`)) continue;
      for (const f of Object.keys(rp)) rp[f] += line[f] || 0;
    }
    const allIp = ipOf(sp.outs + rp.outs);
    const allEr = sp.er + rp.er;
    const fipNum = (t) => 13 * t.hr + 3 * (t.bb + t.hbp) - 2 * t.k;
    const fipConstant = allIp > 0 ? (9 * allEr) / allIp - (fipNum(sp) + fipNum(rp)) / allIp : 3.1;
    const role = (t) => {
      const ip = ipOf(t.outs);
      return ip > 30 ? 0.5 * ((9 * t.er) / ip) + 0.5 * (fipNum(t) / ip + fipConstant) : null;
    };
    byDate.set(date, {
      rpg: s.teamGames > 200 ? s.runs / s.teamGames : CALIBRATION_RPG,
      spRa9: role(sp) ?? 4.1,
      rpRa9: role(rp) ?? 3.9,
      allRa9: allIp > 30 ? (9 * allEr) / allIp : 4.0,
      fipConstant,
      // League rates per batter faced, for the starter component regression.
      spKRate: sp.bf > 5000 ? sp.k / sp.bf : 0.222,
      spBbRate: sp.bf > 5000 ? (sp.bb + sp.hbp) / sp.bf : 0.086,
      spHrRate: sp.bf > 5000 ? sp.hr / sp.bf : 0.031,
      spBfPerIp: sp.outs > 300 ? sp.bf / ipOf(sp.outs) : 4.25,
      leagueBabip: (() => {
        const bip = sp.bf + rp.bf - sp.k - rp.k - sp.bb - rp.bb - sp.hbp - rp.hbp - sp.hr - rp.hr;
        return bip > 20000 ? (sp.h + rp.h - sp.hr - rp.hr) / bip : null;
      })(),
      umpSeen,
      umpSnapshot: new Map([...umpSeen].map(([k, v]) => [k, { ...v }])),
      leagueRunsPerGame: s.teamGames > 200 ? (2 * s.runs) / s.teamGames : 2 * CALIBRATION_RPG,
      priorSeasonRpg: priorSeasonRpg.get(season) ?? null,
      // Nine regulars always out-hit a season line that carries the bench, so
      // the raw ratio has a level in it (median 1.026). `loadSlate` centres it
      // across the slate; so does this, from the same day's cards only.
      lineupCentre: lineupCentre.get(date) || { nine: 1.026, top4: 1.03 },
    });

    // Now fold this date's games in, for tomorrow.
    while (i < sorted.length && sorted[i].date === date) {
      const r = sorted[i++];
      s.runs += r.actual.away + r.actual.home;
      s.teamGames += 2;
      for (const which of ['away', 'home']) {
        spLine.set(`${season}:${r[which].teamId}`, r[which].sp);
        rpLine.set(`${season}:${r[which].teamId}`, r[which].rp);
      }
      if (r.umpId != null) {
        if (!umpSeen.has(r.umpId)) umpSeen.set(r.umpId, { games: 0, runs: 0 });
        const u = umpSeen.get(r.umpId);
        u.games += 1;
        u.runs += r.actual.away + r.actual.home;
      }
    }
  }
  return byDate;
}

// ── the terms ──────────────────────────────────────────────────────────────

/** A team's own home park, applied at half strength: half its games are there. */
const ownPark = (side, P) => 0.5 + 0.5 * parkFactor(side.homePark, 'runs', P.parkExp);

const opsOf = (line) => {
  if (!line?.gamesPlayed) return null;
  const den = line.atBats + line.baseOnBalls + line.hitByPitch + line.sacFlies;
  if (!den || !line.atBats) return null;
  return (line.hits + line.baseOnBalls + line.hitByPitch) / den + line.totalBases / line.atBats;
};

/**
 * Team offence: this season's park-neutral runs per game, the prior season's,
 * and a league-average prior, weighted by how many games each is worth.
 *
 * In April the prior season is nearly all of what is known; in September it is
 * a footnote. That is what `offPriorSeasonGames` buys over the shipped fixed
 * 25-game shrink toward league average with no prior season at all.
 */
export function teamOffenceIndex(side, ctx, P) {
  const o = side.off;
  if (!o?.gamesPlayed) return { value: 1, parts: {} };
  const park = ownPark(side, P);
  const raw = o.runs / o.gamesPlayed / park / ctx.rpg;
  const gp = o.gamesPlayed;
  let num = gp * raw;
  let den = gp;
  if (P.offPriorSeasonGames > 0 && side.offPrior?.gamesPlayed) {
    // The prior season is expressed against ITS OWN league level by dividing
    // by its own runs per game; using this season's would import last year's
    // run environment.
    const p = side.offPrior;
    const priorRpg = p.runs / p.gamesPlayed;
    const leaguePriorRpg = ctx.priorSeasonRpg || priorRpg;
    const rawPrior = priorRpg / park / leaguePriorRpg;
    const w = Math.min(P.offPriorSeasonGames, p.gamesPlayed);
    num += w * rawPrior;
    den += w;
  }
  num += P.offPriorGames;
  den += P.offPriorGames;
  const shrunk = num / den;
  return { value: shrunk ** P.offExp, parts: { season: raw, shrunk } };
}

/** Tonight's card against the team's own season line, before centring. */
export function rawLineupRatio(side, which) {
  const lu = side.lineup?.[which];
  const teamOps = opsOf(side.off);
  if (!lu?.obp || !lu?.slg || !teamOps) return null;
  return (lu.obp + lu.slg) / teamOps;
}

/**
 * The lineup term, centred across the same day's slate and then damped and
 * clamped. Without the centring the term is a flat +4% on every offence in
 * the league, which is a level, not information, and the fit simply kills it.
 */
export function lineupIndex(side, ctx, P, which = 'nine') {
  const raw = rawLineupRatio(side, which);
  if (raw == null) return 1;
  const centre = ctx.lineupCentre?.[which] || 1;
  const exp = which === 'top4' ? P.top4Exp : P.lineupExp;
  return clamp((raw / centre) ** exp, 1 - P.lineupClamp, 1 + P.lineupClamp);
}

/**
 * The starter's runs allowed per nine, regressed component by component.
 *
 * Strikeouts settle down long before home runs do, so they get a smaller
 * prior; the shipped model regresses the finished ERA/FIP blend as one lump
 * with 60 innings of league average, which over-trusts a hot home-run rate and
 * under-trusts a real strikeout rate.
 */
export function starterRa9(starter, ctx, park, P) {
  const cur = starter?.curStarts || starter?.cur;
  if (!cur?.bf) return { ra9: ctx.spRa9, bf: 0 };
  const prior = starter.prior;
  const w = P.spPriorSeasonWeight;
  const bf = cur.bf + (prior?.bf ? w * prior.bf : 0);
  const sum = (f) => cur[f] + (prior ? w * (prior[f] || 0) : 0);
  const k = sum('k');
  const bbhbp = sum('bb') + sum('hbp');
  const hr = sum('hr');
  const outs = cur.outs + (prior?.outs ? w * prior.outs : 0);
  const er = sum('er');

  const reg = (count, priorBf, leagueRate) => (count + priorBf * leagueRate) / (bf + priorBf);
  const kRate = reg(k, P.spKPriorBF, ctx.spKRate);
  const bbRate = reg(bbhbp, P.spBbPriorBF, ctx.spBbRate);
  const hrRate = reg(hr, P.spHrPriorBF, ctx.spHrRate);
  // Rates per batter faced back to a per-inning FIP, using the league's own
  // batters-per-inning so the units match the constant.
  const perIp = ctx.spBfPerIp;
  const fip = (13 * hrRate + 3 * bbRate - 2 * kRate) * perIp + ctx.fipConstant;

  const ip = ipOf(outs);
  const eraRaw = ip > 0 ? (9 * er) / ip : ctx.spRa9;
  const era = (ip * eraRaw + P.spEraPriorIP * ctx.spRa9) / (ip + P.spEraPriorIP);

  // The pitcher's own line carries his home park; the league prior does not.
  const raw = (P.spEraWeight * era + (1 - P.spEraWeight) * fip) / park;
  let ra9 = raw;
  if (P.spRestCoef && starter.restDays != null) {
    const rest = clamp(starter.restDays, 3, 9);
    ra9 *= 1 + P.spRestCoef * (rest - 5);
  }
  return { ra9, bf };
}

/** How long tonight's starter is likely to last, from his own starts. */
export function starterProjIp(starter) {
  const cur = starter?.curStarts;
  if (!cur?.gs) return 4.6;
  const per = ipOf(cur.outs) / cur.gs;
  return clamp((cur.gs * per + 6 * 5.2) / (cur.gs + 6), 2, 7.5);
}

/**
 * Bullpen runs allowed per nine, from the arms that can actually pitch.
 *
 * `bpRestedWeight` slides between the season pen (0, what the shipped model
 * uses) and only the rested arms (1). `bpFatigueCoef` charges for relief
 * innings already thrown in the last two days, which is the other half of the
 * same story: a pen that covered eleven innings in two nights is both short of
 * its best arms and short of arms.
 */
export function bullpenRa9(side, ctx, park, P) {
  const blend = (t) => {
    const ip = ipOf(t.outs);
    if (ip <= 0) return null;
    const era = (9 * t.er) / ip;
    const fip = (13 * t.hr + 3 * (t.bb + t.hbp) - 2 * t.k) / ip + ctx.fipConstant;
    return (0.5 * era + 0.5 * fip) / park;
  };
  const all = { outs: 0, er: 0, hr: 0, bb: 0, hbp: 0, k: 0 };
  for (const f of Object.keys(all)) all[f] = (side.bull.rested[f] || 0) + (side.bull.tired[f] || 0);
  const allRaw = blend(all);
  const restedRaw = blend(side.bull.rested);
  const raw = restedRaw != null && allRaw != null
    ? (1 - P.bpRestedWeight) * allRaw + P.bpRestedWeight * restedRaw
    : allRaw ?? restedRaw;
  if (raw == null) return ctx.rpRa9;
  const ip = ipOf(all.outs);
  let ra9 = (ip * raw + P.bpPriorIP * ctx.rpRa9) / (ip + P.bpPriorIP);
  if (P.bpFatigueCoef) {
    const recent = ipOf((side.bull.reliefOutsD1 || 0) + (side.bull.reliefOutsD2 || 0));
    ra9 *= 1 + P.bpFatigueCoef * (recent - 4);
  }
  return ra9;
}

/**
 * Wind, temperature, roof and umpire.
 *
 * The shipped model uses temperature only, and says so: it has speed but not
 * direction. The feature table has direction, because statsapi records it
 * ("8 mph, Out To LF"). Out plays as +1, in as -1, across the field as 0.
 */
const WIND_SIGN = (dir) => {
  const d = String(dir || '').toLowerCase();
  if (d.startsWith('out')) return 1;
  if (d.startsWith('in')) return -1;
  return 0; // "L To R", "R To L", "Varies", "Calm", "None"
};

export function environmentIndex(row, ctx, P) {
  let env = parkFactor(row.venue, 'runs', P.parkExp);
  const wx = row.wx || {};
  if (!wx.indoor) {
    if (wx.tempF != null) env *= clamp(1 + P.tempCoef * (wx.tempF - 72), 0.94, 1.06);
    if (P.windCoef && wx.windMph != null) {
      env *= clamp(1 + P.windCoef * WIND_SIGN(wx.windDir) * wx.windMph, 0.9, 1.1);
    }
  }
  if (P.umpExp && row.umpId != null) {
    const u = ctx.umpSnapshot?.get(row.umpId);
    if (u?.games) {
      const idx = (u.runs / u.games) / ctx.leagueRunsPerGame;
      const shrunk = (u.games * idx + P.umpPriorGames) / (u.games + P.umpPriorGames);
      env *= shrunk ** P.umpExp;
    }
  }
  return env;
}

/**
 * Team defence, as the rate at which balls in play become hits. A starter's
 * own ERA already carries the gloves behind him, and so does the pen's; what
 * this asks is whether the SPECIFIC defence tonight moves the number beyond
 * that. League BABIP is computed from the same two aggregates.
 */
export function defenceIndex(side, ctx, P) {
  if (!P.defExp) return 1;
  const t = { h: 0, hr: 0, bf: 0, k: 0, bb: 0, hbp: 0 };
  for (const g of [side.sp, side.rp]) for (const f of Object.keys(t)) t[f] += g[f] || 0;
  const bip = t.bf - t.k - t.bb - t.hbp - t.hr;
  if (bip < 500 || !ctx.leagueBabip) return 1;
  const babip = (t.h - t.hr) / bip;
  const idx = babip / ctx.leagueBabip;
  const shrunk = (bip * idx + P.defPriorBF) / (bip + P.defPriorBF);
  return shrunk ** P.defExp;
}

/** Rest, a change of city, the time-zone shift and a dense recent schedule. */
export function restIndex(side, P) {
  const r = side.rest || {};
  let f = 1;
  if (P.restCoef && r.daysSinceLast != null) f *= 1 + P.restCoef * (clamp(r.daysSinceLast, 1, 4) - 1);
  if (P.cityCoef && r.changedCity != null) f *= 1 + P.cityCoef * r.changedCity;
  if (P.tzCoef && r.tzShift) f *= 1 + P.tzCoef * clamp(r.tzShift, -3, 3);
  if (P.denseCoef && r.gamesLast10 != null) f *= 1 + P.denseCoef * (clamp(r.gamesLast10, 6, 10) - 8);
  return f;
}

// ── the scoring inputs ─────────────────────────────────────────────────────

/**
 * The per-half-inning expected runs for both sides, which is the only thing
 * `uncertainScoreGrid` needs. Split out from `projectGameV2` so the fitter can
 * evaluate expected runs on thousands of team-games without paying for the
 * convolution.
 */
export function scoringInputs(row, ctx, P) {
  const level = ctx.rpg / CALIBRATION_RPG;
  const env = environmentIndex(row, ctx, P);

  const sideTerms = (which) => {
    const bat = row[which];
    const fld = row[which === 'away' ? 'home' : 'away'];
    const fldPark = ownPark(fld, P);
    const sp = starterRa9(fld.starter, ctx, fldPark, P);
    const bp = bullpenRa9(fld, ctx, fldPark, P);
    return {
      off: teamOffenceIndex(bat, ctx, P).value * lineupIndex(bat, ctx, P, 'nine') * restIndex(bat, P),
      offFirst: teamOffenceIndex(bat, ctx, P).value * lineupIndex(bat, ctx, P, 'top4') * restIndex(bat, P) * P.firstInningAdjust,
      sp: clamp((sp.ra9 / ctx.allRa9) ** P.spExp, P.spLo, P.spHi) * defenceIndex(fld, ctx, P),
      bp: clamp(bp / ctx.allRa9, P.bpLo, P.bpHi) * defenceIndex(fld, ctx, P),
      projIp: starterProjIp(fld.starter),
      hasStarter: !!fld.starter?.curStarts?.bf,
    };
  };

  const a = sideTerms('away');
  const h = sideTerms('home');

  const means = (base, t, first) =>
    base.map((leagueMean, i) => {
      const share = clamp(t.projIp - i, 0, 1);
      // The first inning is the starter's best: he has not been seen yet.
      // `spFirstInningExp` says how much of his edge is already showing.
      const spIdx = i === 0 ? t.sp ** P.spFirstInningExp : t.sp;
      const pitching = share * spIdx + (1 - share) * t.bp;
      const off = i === 0 ? first : t.off;
      return leagueMean * level * off * pitching * env;
    });

  const awayHalfMeans = means(AWAY_HALF_MEANS, a, a.offFirst);
  const homeHalfMeans = means(HOME_HALF_MEANS, h, h.offFirst).map((m) => m * P.homeAdjust);
  return {
    awayHalfMeans,
    homeHalfMeans,
    awayExtraMean: EXTRA_BASE * a.off * a.bp * env,
    homeExtraMean: EXTRA_BASE * h.off * h.bp * env * HOME_EXTRA_RATIO * P.homeAdjust,
    walkoffExact: P.walkoffExact,
    terms: { away: a, home: h, env, level },
  };
}

/**
 * The SHIPPED model, run on the same feature row, so "v1 vs v2" is measured on
 * identical games with identical as-of inputs. The only thing lent to v1 that
 * it does not compute itself is the projected starter innings: v1 gets that
 * from `projectPitcher`, which needs a start-by-start game log the feature
 * table does not carry, so both models use `starterProjIp` here. That isolates
 * the inputs under test instead of an unrelated workload estimator.
 */
export function projectGameV1FromRow(row, ctx) {
  const stat = (t) => (t && t.outs
    ? {
        inningsPitched: `${Math.floor(t.outs / 3)}.${t.outs % 3}`,
        earnedRuns: t.er, homeRuns: t.hr, baseOnBalls: t.bb,
        hitByPitch: t.hbp, strikeOuts: t.k,
      }
    : null);
  const side = (which) => {
    const x = row[which];
    const raw = rawLineupRatio(x, 'nine');
    const centre = ctx.lineupCentre?.nine || 1;
    return {
      offense: { runs: x.off.runs, gamesPlayed: x.off.gamesPlayed, ops: opsOf(x.off) },
      homePark: x.homePark,
      lineupOpsRatio: raw == null ? null : raw / centre,
      starter: x.starter?.curStarts?.outs
        ? { s26: stat(x.starter.curStarts), s25: stat(x.starter.prior), projIP: starterProjIp(x.starter) }
        : null,
      bullpen: stat(x.rp),
    };
  };
  return projectGame({
    away: side('away'),
    home: side('home'),
    league: { rpg: ctx.rpg, spRa9: ctx.spRa9, rpRa9: ctx.rpRa9, allRa9: ctx.allRa9, fipConstant: ctx.fipConstant },
    park: row.venue,
    wx: null,
  });
}

/** Expected runs for each side, without running the convolution. */
export function expectedRuns(row, ctx, P) {
  const s = scoringInputs(row, ctx, P);
  return {
    away: s.awayHalfMeans.reduce((x, y) => x + y, 0),
    home: s.homeHalfMeans.reduce((x, y) => x + y, 0),
    inputs: s,
  };
}

/**
 * The full v2 projection, shaped exactly like `projectGame`'s output so the
 * existing replay and price study can consume it unchanged.
 */
export function projectGameV2(row, ctx, P) {
  const scoring = scoringInputs(row, ctx, P);
  const sigmaTeam = Math.sqrt(Math.max(0, P.sigmaTeamTotal ** 2 - P.explainedTeamSd ** 2));
  const opts = { sigmaShared: P.sigmaShared, sigmaTeam };
  const grid = uncertainScoreGrid(scoring, opts);
  const summary = summarizeGrid(grid);
  const nrfiProb = firstInningScorelessV2(scoring, opts);
  const flags = [];
  if (!scoring.terms.away.hasStarter || !scoring.terms.home.hasStarter) flags.push('NO PROBABLE');
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
    fairTotal: medianLine(summary),
    nrfi: {
      nrfiProb,
      yrfiProb: 1 - nrfiProb,
      fairNrfiOdds: probToAmerican(nrfiProb),
      fairYrfiOdds: probToAmerican(1 - nrfiProb),
    },
    inputs: scoring.terms,
    flags,
  };
}

/** Same integration as `firstInningScoreless`, on the v2 inning-one means. */
function firstInningScorelessV2(input, options) {
  return firstInningScoreless(input, options);
}

function medianLine(summary) {
  let best = 8.5;
  let bestGap = Infinity;
  for (let line = 4.5; line <= 16.5; line += 1) {
    const gap = Math.abs(totalProbs(summary, line).over - 0.5);
    if (gap < bestGap) { best = line; bestGap = gap; }
  }
  return best;
}

export { tiltPmf, FIRST_INNING_AWAY_PMF, FIRST_INNING_HOME_PMF, safeLog };
