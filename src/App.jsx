import { useState, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const SPORT = "baseball_mlb";
// Split pitcher and batter markets — removed pitcher_outs (invalid market name)
const ODDS_MKTS = [
  "pitcher_strikeouts",
  "pitcher_hits_allowed,pitcher_earned_runs,pitcher_walks",
  "batter_hits,batter_home_runs,batter_runs_scored,batter_rbis,batter_total_bases",
  "batter_hits_runs_rbis,batter_doubles,batter_stolen_bases,batter_strikeouts,batter_singles",
];

const C = {
  bg: "#07090f", panel: "#0d1220", card: "#111827", border: "#1a2840",
  green: "#00e676", red: "#ff4444", yellow: "#ffd600", blue: "#40c4ff",
  purple: "#b388ff", orange: "#ff9100", white: "#eef2ff", muted: "#3d5270",
  dim: "#6b88ab", teal: "#26c6da",
};

const PMKTS = {
  K:"pitcher_strikeouts", H:"pitcher_hits_allowed",
  ER:"pitcher_earned_runs", BB:"pitcher_walks",
};
const BMKTS = {
  H:"batter_hits", HR:"batter_home_runs", R:"batter_runs_scored",
  RBI:"batter_rbis", TB:"batter_total_bases", HRR:"batter_hits_runs_rbis",
  "2B":"batter_doubles", SB:"batter_stolen_bases", K:"batter_strikeouts", "1B":"batter_singles",
};
const BPROPS = Object.keys(BMKTS);

const PROP_LABELS = { K:"Strikeouts", H:"Hits Allowed", ER:"Earned Runs", BB:"Walks" };
const BPROP_LABELS = { H:"Hits", HR:"Home Runs", R:"Runs", RBI:"RBIs", TB:"Total Bases", HRR:"H+R+RBI", "2B":"Doubles", SB:"Stolen Bases", K:"Strikeouts", "1B":"Singles" };

// All known market suffixes for name extraction
const ALL_MKT_SUFFIXES = [...Object.values(PMKTS), ...Object.values(BMKTS)];

// Park factors — Statcast 3-yr rolling (100 = neutral)
const PARKS = {
  "Arizona Diamondbacks":  {r:102,hr:108,k:101,pf:1.02},
  "Atlanta Braves":        {r:101,hr:104,k:100,pf:1.01},
  "Baltimore Orioles":     {r:103,hr:108,k:100,pf:1.03},
  "Boston Red Sox":        {r:105,hr:98, k:99, pf:1.05},
  "Chicago Cubs":          {r:104,hr:112,k:98, pf:1.04},
  "Chicago White Sox":     {r:98, hr:102,k:101,pf:0.98},
  "Cincinnati Reds":       {r:110,hr:122,k:98, pf:1.10},
  "Cleveland Guardians":   {r:97, hr:94, k:102,pf:0.97},
  "Colorado Rockies":      {r:118,hr:114,k:92, pf:1.18},
  "Detroit Tigers":        {r:96, hr:92, k:102,pf:0.96},
  "Houston Astros":        {r:101,hr:104,k:100,pf:1.01},
  "Kansas City Royals":    {r:102,hr:100,k:100,pf:1.02},
  "Los Angeles Angels":    {r:97, hr:96, k:102,pf:0.97},
  "Los Angeles Dodgers":   {r:102,hr:108,k:101,pf:1.02},
  "Miami Marlins":         {r:95, hr:88, k:103,pf:0.95},
  "Milwaukee Brewers":     {r:103,hr:110,k:99, pf:1.03},
  "Minnesota Twins":       {r:101,hr:106,k:100,pf:1.01},
  "New York Mets":         {r:99, hr:96, k:101,pf:0.99},
  "New York Yankees":      {r:103,hr:112,k:99, pf:1.03},
  "Oakland Athletics":     {r:96, hr:90, k:102,pf:0.96},
  "Philadelphia Phillies": {r:104,hr:108,k:100,pf:1.04},
  "Pittsburgh Pirates":    {r:96, hr:90, k:102,pf:0.96},
  "San Diego Padres":      {r:98, hr:92, k:102,pf:0.98},
  "San Francisco Giants":  {r:94, hr:86, k:103,pf:0.94},
  "Seattle Mariners":      {r:96, hr:90, k:104,pf:0.96},
  "St. Louis Cardinals":   {r:97, hr:94, k:101,pf:0.97},
  "Tampa Bay Rays":        {r:96, hr:92, k:102,pf:0.96},
  "Texas Rangers":         {r:103,hr:106,k:99, pf:1.03},
  "Toronto Blue Jays":     {r:102,hr:108,k:100,pf:1.02},
  "Washington Nationals":  {r:99, hr:98, k:101,pf:0.99},
};

// League-average rates
const LGA = {
  h:0.243, hr:0.030, r:0.115, rbi:0.110, tb:0.380, d:0.042, s:0.170, sb:0.022, k:0.225,
  pk:0.220, ph:0.240, per:0.040, pbb:0.080,
  tk:0.225, th:0.243, tbb:0.082,
};

// ═══════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const oddsApi = (path, params={}) => fetch(`/api/odds?${new URLSearchParams({path,...params})}`);
const mlbApi  = (path, params={}) => fetch(`/api/mlb?${new URLSearchParams({path,...params})}`);

// ═══════════════════════════════════════════════════════════════════════════════
// NAME MATCHING — properly handles multi-word market suffixes
// ═══════════════════════════════════════════════════════════════════════════════
const norm = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z\s]/g,"").replace(/\s+/g,"_").trim();

// Extract player name from an odds key like "gerrit_cole_pitcher_strikeouts"
function extractPlayerName(key) {
  for (const suf of ALL_MKT_SUFFIXES) {
    if (key.endsWith("_" + suf)) {
      return key.slice(0, -(suf.length + 1));
    }
  }
  return null;
}

// Find a line for a player + market from the odds map
function getLine(lines, name, mkt) {
  const n = norm(name);
  // Try exact match first
  const exactKey = n + "_" + mkt;
  if (lines[exactKey]) return lines[exactKey];
  // Fuzzy: last name + first name
  const parts = n.split("_").filter(p => p.length > 1 && !["jr","sr","ii","iii","iv"].includes(p));
  if (!parts.length) return null;
  // Use actual last part (surname) not longest
  const last = parts[parts.length - 1];
  const first = parts[0];
  for (const [k, v] of Object.entries(lines)) {
    if (!k.endsWith("_" + mkt)) continue;
    const playerPart = extractPlayerName(k) || "";
    if (playerPart.includes(last) && (parts.length < 2 || playerPart.includes(first))) return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MLB DATA
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchSchedule() {
  const today = new Date().toISOString().slice(0, 10);
  const r = await mlbApi("api/v1/schedule", { sportId: "1", date: today, hydrate: "probablePitcher(note),team" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  const games = [];
  for (const d of data.dates || []) for (const g of d.games || []) {
    if (g.status?.detailedState === "Postponed") continue;
    games.push({
      gamePk: g.gamePk,
      away: { id: g.teams.away.team.id, name: g.teams.away.team.name },
      home: { id: g.teams.home.team.id, name: g.teams.home.team.name },
      pp: {
        away: g.probablePitchers?.away ? { id: g.probablePitchers.away.id, name: g.probablePitchers.away.fullName } : null,
        home: g.probablePitchers?.home ? { id: g.probablePitchers.home.id, name: g.probablePitchers.home.fullName } : null,
      },
      park: PARKS[g.teams.home.team.name] || { r: 100, hr: 100, k: 100, pf: 1.0 },
    });
  }
  return games;
}

async function fetchRoster(teamId) {
  try {
    const r = await mlbApi("api/v1/teams/" + teamId + "/roster", { rosterType: "active" });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.roster || []).map(p => ({ id: p.person.id, name: p.person.fullName, pos: p.position?.abbreviation || "?" }));
  } catch { return []; }
}

async function fetchStats(ids) {
  if (!ids.length) return {};
  const season = new Date().getFullYear();
  const map = {};
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    try {
      const r = await mlbApi("api/v1/people", {
        personIds: chunk.join(","),
        hydrate: "stats(group=[hitting,pitching],type=[season],season=" + season + ")",
      });
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of d.people || []) {
        const hitting = p.stats?.find(s => s.group?.displayName === "hitting" && s.type?.displayName === "season");
        const pitching = p.stats?.find(s => s.group?.displayName === "pitching" && s.type?.displayName === "season");
        map[p.id] = {
          id: p.id, name: p.fullName, bat: p.batSide?.code || "R", throw: p.pitchHand?.code || "R",
          pos: p.primaryPosition?.abbreviation || "?",
          hitting: hitting?.splits?.[0]?.stat || null,
          pitching: pitching?.splits?.[0]?.stat || null,
        };
      }
    } catch { /* skip */ }
  }
  return map;
}

async function fetchTeamHitting() {
  const season = new Date().getFullYear();
  const map = {};
  try {
    const r = await mlbApi("api/v1/teams/stats", { stats: "season", group: "hitting", season: String(season), sportId: "1" });
    if (!r.ok) return map;
    const d = await r.json();
    for (const split of d.stats?.[0]?.splits || []) {
      const s = split.stat;
      const pa = s.plateAppearances || 1;
      map[split.team.id] = {
        name: split.team.name,
        kRate: (s.strikeOuts || 0) / pa,
        hRate: (s.hits || 0) / (s.atBats || 1),
        bbRate: (s.baseOnBalls || 0) / pa,
        avg: s.avg ? parseFloat(s.avg) : 0.243,
      };
    }
  } catch { /* */ }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ODDS PARSING
// ═══════════════════════════════════════════════════════════════════════════════
function parseOdds(data, tgt) {
  const pri = ["draftkings", "fanduel", "betmgm", "caesars", "bovada", "betonlineag"];
  const allKeys = (data.bookmakers || []).map(b => b.key);
  const ordered = [...pri.filter(k => allKeys.includes(k)), ...allKeys.filter(k => !pri.includes(k))];
  const seen = new Set();
  for (const bk of ordered) {
    const bm = (data.bookmakers || []).find(b => b.key === bk);
    if (!bm) continue;
    for (const mkt of bm.markets || []) {
      const byP = {};
      for (const o of mkt.outcomes || []) {
        const d = (o.description || "").toLowerCase().replace(/\s+/g, "_");
        if (!d) continue; // skip empty descriptions
        if (!byP[d]) byP[d] = {};
        if (o.name === "Over") { byP[d].ov = o.price; if (o.point != null) byP[d].pt = o.point; }
        if (o.name === "Under") byP[d].uv = o.price;
      }
      for (const [desc, v] of Object.entries(byP)) {
        if (v.pt == null) continue;
        const key = desc + "_" + mkt.key;
        if (!seen.has(key)) { seen.add(key); tgt[key] = { pt: v.pt, ov: v.ov ?? null, uv: v.uv ?? null, bk: bm.title }; }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ODDS MATH
// ═══════════════════════════════════════════════════════════════════════════════
const mlP = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
const dvg = (o, u) => o && u ? mlP(o) / (mlP(o) + mlP(u)) : null;
const fmtO = ml => ml == null ? "\u2014" : (ml > 0 ? "+" : "") + ml;

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function projPitcher(pStats, park, oppTeam) {
  if (!pStats?.pitching) return null;
  const s = pStats.pitching;
  const ip = parseFloat(s.inningsPitched) || 0;
  const bf = s.battersFaced || Math.round(ip * 3 + (s.hits || 0) + (s.baseOnBalls || 0));
  if (ip < 3 || bf < 10) return null;

  const kRate = (s.strikeOuts || 0) / bf;
  const hRate = (s.hits || 0) / bf;
  const erRate = (s.earnedRuns || 0) / bf;
  const bbRate = (s.baseOnBalls || 0) / bf;

  const gs = s.gamesStarted || s.gamesPlayed || 1;
  const avgIP = ip / gs;
  const pIP = Math.min(Math.max(avgIP, 4.5), 7.0);
  const pBF = Math.round(pIP * 3 + (hRate + bbRate) * pIP * 3);

  const pkK = (park?.k || 100) / 100;
  const pkR = park?.pf || 1.0;

  // Opponent team quality — realistic 5-12% swing, not 30%
  // Early-season team rates are noisy so we regress toward 1.0
  let oppK = 1.0, oppH = 1.0, oppBB = 1.0;
  if (oppTeam) {
    oppK = 1 + (oppTeam.kRate / LGA.tk - 1) * 0.7;
    oppH = 1 + (oppTeam.hRate / LGA.th - 1) * 0.7;
    oppBB = 1 + (oppTeam.bbRate / LGA.tbb - 1) * 0.5;
    oppK = Math.max(0.88, Math.min(1.15, oppK));
    oppH = Math.max(0.88, Math.min(1.15, oppH));
    oppBB = Math.max(0.88, Math.min(1.15, oppBB));
  }

  const kBoost = kRate >= 0.30 ? 1.08 : kRate >= 0.26 ? 1.05 : kRate >= 0.22 ? 1.02 : 1.0;

  // Projected pitch count: high-K pitchers average ~4.1 pitches/BF, others ~3.85
  const pitchesPerBF = kRate >= 0.26 ? 4.15 : kRate >= 0.20 ? 3.95 : 3.80;
  const projPitches = Math.round(pBF * pitchesPerBF);

  // Actual pitches per start from stats if available
  const totalPitches = s.numberOfPitches || s.pitchesThrown || 0;
  const avgPitches = totalPitches > 0 ? Math.round(totalPitches / gs) : null;

  return {
    name: pStats.name, hand: pStats.throw || "R",
    K: +(kRate * pBF * pkK * oppK * kBoost).toFixed(1),
    H: +(hRate * pBF * oppH).toFixed(1),
    ER: +(erRate * pBF * pkR * oppH).toFixed(1),
    BB: +(bbRate * pBF * oppBB).toFixed(1),
    era: s.era ?? "\u2014",
    kPer9: ip > 0 ? +((s.strikeOuts || 0) / ip * 9).toFixed(1) : 0,
    whip: ip > 0 ? +(((s.hits || 0) + (s.baseOnBalls || 0)) / ip).toFixed(2) : "\u2014",
    avgIP: +avgIP.toFixed(1),
    projPitches, avgPitches, pBF,
    _hRate: hRate, _kRate: kRate, _erRate: erRate, _bbRate: bbRate,
    oppTeamName: oppTeam?.name || "?",
    oppK: oppTeam ? +(oppTeam.kRate * 100).toFixed(1) : null,
    oppAVG: oppTeam ? oppTeam.avg.toFixed(3) : null,
  };
}

function projBatter(bStats, pitProj, park) {
  if (!bStats?.hitting) return null;
  const s = bStats.hitting;
  const pa = s.plateAppearances || 0;
  const g = s.gamesPlayed || 0;
  if (pa < 10) return null;

  const rate = k => (k || 0) / pa;
  const paPerG = pa / Math.max(g, 1);
  const pPA = Math.min(paPerG * 1.05, 5.2);

  // Pitcher suppression — moderate amplification, realistic range
  let hitF = 1, kF = 1, runF = 1;
  if (pitProj) {
    const hDev = pitProj._hRate / LGA.ph - 1;
    const kDev = pitProj._kRate / LGA.pk - 1;
    const rDev = pitProj._erRate / LGA.per - 1;
    hitF = Math.max(0.75, Math.min(1.30, 1 + hDev * 1.2));
    kF   = Math.max(0.75, Math.min(1.30, 1 + kDev * 1.2));
    runF = Math.max(0.75, Math.min(1.30, 1 + rDev * 1.0));
  }

  // Platoon splits — 6-8% swing (realistic MLB range)
  const batH = bStats.bat, pitH = pitProj?.hand;
  const favorable = (batH === "L" && pitH === "R") || (batH === "R" && pitH === "L") || batH === "S";
  const sameSide = (batH === "L" && pitH === "L") || (batH === "R" && pitH === "R");
  const plH = favorable ? 1.07 : sameSide ? 0.92 : 1.0;
  const plK = sameSide ? 1.08 : favorable ? 0.92 : 1.0;

  const pkHR = (park?.hr || 100) / 100;
  const pkR = park?.pf || 1.0;
  const pkK = (park?.k || 100) / 100;

  const singles = (s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0);

  return {
    name: bStats.name, bat: batH, pos: bStats.pos,
    H:   +(rate(s.hits) * hitF * plH * pPA).toFixed(2),
    HR:  +(rate(s.homeRuns) * hitF * plH * pPA * pkHR).toFixed(2),
    R:   +(rate(s.runs) * runF * plH * pPA * pkR).toFixed(2),
    RBI: +(rate(s.rbi) * runF * plH * pPA * pkR).toFixed(2),
    TB:  +(rate(s.totalBases) * hitF * plH * pPA * pkHR).toFixed(2),
    "2B":+(rate(s.doubles) * hitF * plH * pPA).toFixed(2),
    SB:  +(rate(s.stolenBases) * pPA).toFixed(2),
    K:   +(rate(s.strikeOuts) * kF * plK * pPA * pkK).toFixed(2),
    "1B":+((singles / pa) * hitF * plH * pPA).toFixed(2),
    get HRR() { return +(this.H + this.R + this.RBI).toFixed(2); },
    pPA, oppPitcher: pitProj?.name || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER LOAD
// ═══════════════════════════════════════════════════════════════════════════════
async function loadAll(setSt) {
  const pitcherPlays = [];
  const batterPlays = [];
  const log = { games: 0, mlbGames: 0, statsLoaded: 0, pitcherProps: 0, batterProps: 0, debugPitcherLines: 0 };

  // 1. MLB schedule
  setSt("Fetching MLB schedule...");
  let mlbGames = [];
  try { mlbGames = await fetchSchedule(); log.mlbGames = mlbGames.length; }
  catch (e) { setSt("MLB API error: " + e.message); }

  // 2. Team hitting stats
  setSt("Fetching team batting stats...");
  const teamHitting = await fetchTeamHitting();

  // 3. Rosters + Stats
  const statsMap = {};
  const rostersByTeam = {};
  if (mlbGames.length > 0) {
    const teamIds = new Set();
    const allIds = new Set();
    const rosterPs = [];
    for (const g of mlbGames) {
      for (const t of [g.away, g.home]) {
        if (!teamIds.has(t.id)) { teamIds.add(t.id); rosterPs.push(fetchRoster(t.id).then(r => { rostersByTeam[t.id] = r; })); }
      }
      if (g.pp.away?.id) allIds.add(g.pp.away.id);
      if (g.pp.home?.id) allIds.add(g.pp.home.id);
    }
    await Promise.all(rosterPs);
    for (const roster of Object.values(rostersByTeam)) for (const p of roster) allIds.add(p.id);
    setSt("Loading stats for " + allIds.size + " players...");
    const fetched = await fetchStats([...allIds]);
    Object.assign(statsMap, fetched);
    log.statsLoaded = Object.keys(statsMap).length;
    for (const g of mlbGames) {
      g.awayRoster = rostersByTeam[g.away.id] || [];
      g.homeRoster = rostersByTeam[g.home.id] || [];
    }
  }

  // 4. Odds events
  setSt("Fetching odds...");
  let evs = [];
  try { const r = await oddsApi("sports/" + SPORT + "/events", { dateFormat: "iso" }); if (r.ok) evs = await r.json(); }
  catch { /* */ }

  const now = new Date(), seen = new Set(), unique = [];
  for (const e of evs) {
    const diff = (new Date(e.commence_time) - now) / 36e5;
    if (diff > 30 || diff < -6) continue;
    const key = e.away_team + "@" + e.home_team;
    if (!seen.has(key)) { seen.add(key); unique.push(e); }
  }
  unique.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
  log.games = unique.length;

  // 5. For each game
  for (let i = 0; i < unique.length; i++) {
    const ev = unique[i];
    const awayShort = ev.away_team.split(" ").pop();
    const homeShort = ev.home_team.split(" ").pop();
    setSt("Props: " + awayShort + " @ " + homeShort + " (" + (i + 1) + "/" + unique.length + ")");

    // Fetch all odds for this event
    const lines = {};
    const rs = await Promise.all(ODDS_MKTS.map(m =>
      oddsApi("sports/" + SPORT + "/events/" + ev.id + "/odds", { regions: "us", markets: m, oddsFormat: "american" }).catch(() => null)
    ));
    for (const r of rs) { if (r?.ok) parseOdds(await r.json(), lines); }

    // Match to MLB game
    const mlbGame = mlbGames.find(g =>
      ev.home_team.includes(g.home.name.split(" ").pop()) || g.home.name.includes(homeShort)
    );
    const park = mlbGame?.park || { r: 100, hr: 100, k: 100, pf: 1.0 };
    const matchup = awayShort + " @ " + homeShort;
    const gameTime = new Date(ev.commence_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    // ─── PITCHER PROPS ───
    // Strategy: discover pitchers from BOTH odds data AND MLB schedule
    const pitProjs = {};

    // First, build projections from MLB probable pitchers
    for (const side of ["away", "home"]) {
      const pp = mlbGame?.pp?.[side];
      if (pp && statsMap[pp.id]) {
        const oppTeamId = side === "away" ? mlbGame.home.id : mlbGame.away.id;
        const oppTeam = teamHitting[oppTeamId] || null;
        const proj = projPitcher(statsMap[pp.id], park, oppTeam);
        if (proj) pitProjs[side] = proj;
      }
    }

    // Count pitcher lines in odds for debug
    const pitcherLineKeys = Object.keys(lines).filter(k => {
      for (const mkt of Object.values(PMKTS)) { if (k.endsWith("_" + mkt)) return true; }
      return false;
    });
    log.debugPitcherLines += pitcherLineKeys.length;

    // Now match pitcher projections to odds lines
    for (const [side, proj] of Object.entries(pitProjs)) {
      for (const [pk, mkt] of Object.entries(PMKTS)) {
        const lv = getLine(lines, proj.name, mkt);
        if (!lv) continue;
        const modelVal = proj[pk];
        if (modelVal == null) continue;
        const diff = +(modelVal - lv.pt).toFixed(2);
        pitcherPlays.push({
          player: proj.name, matchup, gameTime,
          prop: pk, propLabel: PROP_LABELS[pk] || pk,
          line: lv.pt, proj: modelVal, diff,
          direction: diff > 0 ? "OVER" : "UNDER",
          odds: lv, fair: dvg(lv.ov, lv.uv), hand: proj.hand,
          era: proj.era, kPer9: proj.kPer9, whip: proj.whip, avgIP: proj.avgIP,
          projPitches: proj.projPitches, avgPitches: proj.avgPitches, pBF: proj.pBF,
          oppTeamName: proj.oppTeamName, oppK: proj.oppK, oppAVG: proj.oppAVG,
        });
        log.pitcherProps++;
      }
    }

    // Also: discover pitchers from odds who we might have missed
    // (e.g. if MLB schedule didn't list them as probable)
    const discoveredPitchers = new Set();
    for (const k of pitcherLineKeys) {
      const pName = extractPlayerName(k);
      if (!pName) continue;
      const readable = pName.replace(/_/g, " ");
      // Check if we already projected this pitcher
      const alreadyDone = Object.values(pitProjs).some(p => norm(p.name) === pName);
      if (!alreadyDone) discoveredPitchers.add(readable);
    }
    // Try to match discovered pitchers to stats
    for (const pName of discoveredPitchers) {
      const pN = norm(pName);
      let pStat = null;
      for (const s of Object.values(statsMap)) {
        if (s.pitching && norm(s.name) === pN) { pStat = s; break; }
      }
      if (!pStat) {
        const parts = pN.split("_").filter(p => p.length > 1);
        const last = parts[parts.length - 1] || "";
        const first = parts[0] || "";
        for (const s of Object.values(statsMap)) {
          if (s.pitching && norm(s.name).includes(last) && (first.length < 2 || norm(s.name).includes(first))) { pStat = s; break; }
        }
      }
      if (!pStat) continue;
      // Determine opponent team
      let oppTeam = null;
      if (mlbGame) {
        const isAway = (mlbGame.awayRoster || []).some(p => norm(p.name) === norm(pStat.name));
        const oppTeamId = isAway ? mlbGame.home.id : mlbGame.away.id;
        oppTeam = teamHitting[oppTeamId] || null;
      }
      const proj = projPitcher(pStat, park, oppTeam);
      if (!proj) continue;
      for (const [pk, mkt] of Object.entries(PMKTS)) {
        const lv = getLine(lines, pStat.name, mkt);
        if (!lv) continue;
        const modelVal = proj[pk];
        if (modelVal == null) continue;
        const diff = +(modelVal - lv.pt).toFixed(2);
        pitcherPlays.push({
          player: proj.name, matchup, gameTime,
          prop: pk, propLabel: PROP_LABELS[pk] || pk,
          line: lv.pt, proj: modelVal, diff,
          direction: diff > 0 ? "OVER" : "UNDER",
          odds: lv, fair: dvg(lv.ov, lv.uv), hand: proj.hand,
          era: proj.era, kPer9: proj.kPer9, whip: proj.whip, avgIP: proj.avgIP,
          projPitches: proj.projPitches, avgPitches: proj.avgPitches, pBF: proj.pBF,
          oppTeamName: proj.oppTeamName, oppK: proj.oppK, oppAVG: proj.oppAVG,
        });
        log.pitcherProps++;
      }
    }

    // ─── BATTER PROPS ───
    // Discover batter names from odds using proper name extraction
    const batterNames = new Map(); // normalized name → readable name
    for (const k of Object.keys(lines)) {
      // Skip pitcher lines
      let isPitcher = false;
      for (const mkt of Object.values(PMKTS)) { if (k.endsWith("_" + mkt)) { isPitcher = true; break; } }
      if (isPitcher) continue;

      const pName = extractPlayerName(k);
      if (pName && !batterNames.has(pName)) {
        batterNames.set(pName, pName.replace(/_/g, " "));
      }
    }

    for (const [bN, bReadable] of batterNames) {
      // Match to stats
      let bStat = null;
      for (const s of Object.values(statsMap)) {
        if (s.hitting && norm(s.name) === bN) { bStat = s; break; }
      }
      if (!bStat) {
        const parts = bN.split("_").filter(p => p.length > 1);
        const last = parts[parts.length - 1] || "";
        const first = parts[0] || "";
        for (const s of Object.values(statsMap)) {
          if (s.hitting && norm(s.name).includes(last) && (first.length < 2 || norm(s.name).includes(first))) { bStat = s; break; }
        }
      }
      if (!bStat) continue;

      // Determine opposing pitcher
      let oppProj = null;
      if (mlbGame) {
        const awayNames = (mlbGame.awayRoster || []).map(p => norm(p.name));
        const isAway = awayNames.some(n => n.includes(bN.split("_").pop()));
        oppProj = isAway ? pitProjs.home : pitProjs.away;
      }

      const bp = projBatter(bStat, oppProj, park);
      if (!bp) continue;

      for (const pk of BPROPS) {
        const lv = getLine(lines, bStat.name, BMKTS[pk]);
        if (!lv) continue;
        const modelVal = pk === "HRR" ? bp.HRR : bp[pk];
        if (modelVal == null) continue;
        const diff = +(modelVal - lv.pt).toFixed(2);
        if (Math.abs(diff) < 0.30) continue; // only meaningful edges
        batterPlays.push({
          player: bp.name, pos: bp.pos, matchup, gameTime,
          prop: pk, propLabel: BPROP_LABELS[pk] || pk,
          line: lv.pt, proj: modelVal, diff,
          direction: diff > 0 ? "OVER" : "UNDER",
          odds: lv, fair: dvg(lv.ov, lv.uv), bat: bp.bat,
          oppPitcher: oppProj?.name || "?",
        });
        log.batterProps++;
      }
    }
  }

  // Sort by biggest edge
  pitcherPlays.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  batterPlays.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  setSt("Done \u2014 " + log.pitcherProps + " pitcher props, " + log.batterProps + " batter edges, " + log.debugPitcherLines + " pitcher lines in odds, " + log.games + " games");
  return { pitcherPlays, batterPlays, log };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════
const sty = {
  th: { padding: "8px 10px", color: C.muted, fontSize: 9, fontWeight: 700, borderBottom: "1px solid " + C.border, whiteSpace: "nowrap", background: "#0a0f1a", textAlign: "left", letterSpacing: 0.5, textTransform: "uppercase" },
  td: { padding: "7px 10px", borderBottom: "1px solid " + C.border, verticalAlign: "middle" },
  mono: { fontFamily: "'Courier New',monospace" },
};

function diffColor(diff) {
  const abs = Math.abs(diff || 0);
  if (abs >= 1.0) return diff > 0 ? C.green : C.red;
  if (abs >= 0.5) return diff > 0 ? "#66ff99" : "#ff8a65";
  if (abs >= 0.3) return diff > 0 ? C.yellow : "#ffab91";
  return C.dim;
}

function callLabel(diff) {
  const abs = Math.abs(diff || 0);
  const dir = diff > 0 ? "OVER" : "UNDER";
  if (abs >= 1.0) return dir + " !!";
  if (abs >= 0.5) return dir;
  if (abs >= 0.3) return "lean " + dir;
  return "\u2014";
}

function PitcherTable({ plays }) {
  if (!plays.length) return (
    <div style={{ color: C.muted, padding: 40, textAlign: "center" }}>
      <div style={{ fontSize: 14, marginBottom: 8 }}>No pitcher props matched</div>
      <div style={{ fontSize: 10 }}>Check that the odds API is returning pitcher markets</div>
    </div>
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["Pitcher", "Matchup", "vs Team", "Prop", "Line", "Proj", "Diff", "Call", "Odds", "Pitches", "K/9", "ERA", "WHIP", "Opp K%", "Opp AVG"].map(h => (
              <th key={h} style={{ ...sty.th, textAlign: ["Line", "Proj", "Diff", "Pitches", "K/9", "ERA", "WHIP", "Opp K%", "Opp AVG"].includes(h) ? "center" : "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plays.map((p, i) => {
            const abs = Math.abs(p.diff);
            const rowBg = abs >= 1.0 ? (p.diff > 0 ? C.green + "0D" : C.red + "0D") : abs >= 0.5 ? (p.diff > 0 ? C.green + "08" : C.red + "08") : "transparent";
            return (
              <tr key={i} style={{ background: rowBg }}>
                <td style={{ ...sty.td, whiteSpace: "nowrap" }}>
                  <b style={{ color: C.white, fontSize: 12 }}>{p.player}</b>
                  <span style={{ color: C.muted, fontSize: 9, marginLeft: 4 }}>{p.hand}HP</span>
                </td>
                <td style={{ ...sty.td, color: C.dim, fontSize: 10, whiteSpace: "nowrap" }}>{p.matchup} <span style={{ color: C.muted, fontSize: 8 }}>{p.gameTime}</span></td>
                <td style={{ ...sty.td, color: C.dim, fontSize: 10 }}>{p.oppTeamName}</td>
                <td style={sty.td}><span style={{ color: C.blue, fontWeight: 700, fontSize: 11 }}>{p.propLabel}</span></td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, color: C.blue, fontWeight: 700, fontSize: 14 }}>{p.line}</td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, fontWeight: 900, fontSize: 15, color: C.white }}>{p.proj}</td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, fontWeight: 900, fontSize: 15, color: diffColor(p.diff) }}>
                  {p.diff > 0 ? "+" : ""}{p.diff}
                </td>
                <td style={{ ...sty.td, textAlign: "center" }}>
                  <span style={{ background: diffColor(p.diff) + "22", color: diffColor(p.diff), padding: "3px 10px", borderRadius: 4, fontWeight: 700, fontSize: 10, ...sty.mono }}>
                    {callLabel(p.diff)}
                  </span>
                </td>
                <td style={{ ...sty.td, textAlign: "center", fontSize: 10, ...sty.mono }}>
                  <span style={{ color: p.odds?.ov > 0 ? C.green : C.yellow }}>{fmtO(p.odds?.ov)}</span>
                  <span style={{ color: C.muted }}>/</span>
                  <span style={{ color: p.odds?.uv > 0 ? C.green : C.yellow }}>{fmtO(p.odds?.uv)}</span>
                </td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, fontSize: 11 }}>
                  <span style={{ color: C.white, fontWeight: 700 }}>{p.projPitches || "\u2014"}</span>
                  {p.avgPitches && <span style={{ color: C.muted, fontSize: 8 }}>{" (" + p.avgPitches + " avg)"}</span>}
                </td>
                <td style={{ ...sty.td, textAlign: "center", color: C.green, fontSize: 11, ...sty.mono, fontWeight: 700 }}>{p.kPer9}</td>
                <td style={{ ...sty.td, textAlign: "center", color: C.dim, fontSize: 11, ...sty.mono }}>{p.era}</td>
                <td style={{ ...sty.td, textAlign: "center", color: C.dim, fontSize: 11, ...sty.mono }}>{p.whip}</td>
                <td style={{ ...sty.td, textAlign: "center", color: p.oppK > 23 ? C.green : p.oppK < 20 ? C.red : C.dim, fontSize: 11, ...sty.mono, fontWeight: 700 }}>
                  {p.oppK != null ? p.oppK + "%" : "\u2014"}
                </td>
                <td style={{ ...sty.td, textAlign: "center", color: C.dim, fontSize: 11, ...sty.mono }}>{p.oppAVG || "\u2014"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BatterTable({ plays }) {
  if (!plays.length) return <div style={{ color: C.muted, padding: 40, textAlign: "center" }}>No batter edges above 0.3 threshold</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["Player", "Pos", "Matchup", "vs Pitcher", "Prop", "Line", "Proj", "Diff", "Call", "Odds"].map(h => (
              <th key={h} style={{ ...sty.th, textAlign: ["Line", "Proj", "Diff"].includes(h) ? "center" : "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plays.map((p, i) => {
            const abs = Math.abs(p.diff);
            const rowBg = abs >= 1.0 ? (p.diff > 0 ? C.green + "0D" : C.red + "0D") : abs >= 0.5 ? (p.diff > 0 ? C.green + "08" : C.red + "08") : "transparent";
            return (
              <tr key={i} style={{ background: rowBg }}>
                <td style={{ ...sty.td, whiteSpace: "nowrap" }}>
                  <b style={{ color: C.white, fontSize: 12 }}>{p.player}</b>
                  <span style={{ color: C.muted, fontSize: 9, marginLeft: 4 }}>{p.bat}HB</span>
                </td>
                <td style={{ ...sty.td, color: C.dim, fontSize: 10 }}>{p.pos}</td>
                <td style={{ ...sty.td, color: C.dim, fontSize: 10, whiteSpace: "nowrap" }}>{p.matchup} <span style={{ color: C.muted, fontSize: 8 }}>{p.gameTime}</span></td>
                <td style={{ ...sty.td, color: C.dim, fontSize: 10 }}>{p.oppPitcher?.split(" ").pop() || "?"}</td>
                <td style={sty.td}><span style={{ color: C.orange, fontWeight: 700, fontSize: 11 }}>{p.propLabel}</span></td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, color: C.blue, fontWeight: 700, fontSize: 14 }}>{p.line}</td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, fontWeight: 900, fontSize: 15, color: C.white }}>{p.proj}</td>
                <td style={{ ...sty.td, textAlign: "center", ...sty.mono, fontWeight: 900, fontSize: 15, color: diffColor(p.diff) }}>
                  {p.diff > 0 ? "+" : ""}{p.diff}
                </td>
                <td style={{ ...sty.td, textAlign: "center" }}>
                  <span style={{ background: diffColor(p.diff) + "22", color: diffColor(p.diff), padding: "3px 10px", borderRadius: 4, fontWeight: 700, fontSize: 10, ...sty.mono }}>
                    {callLabel(p.diff)}
                  </span>
                </td>
                <td style={{ ...sty.td, textAlign: "center", fontSize: 10, ...sty.mono }}>
                  <span style={{ color: p.odds?.ov > 0 ? C.green : C.yellow }}>{fmtO(p.odds?.ov)}</span>
                  <span style={{ color: C.muted }}>/</span>
                  <span style={{ color: p.odds?.uv > 0 ? C.green : C.yellow }}>{fmtO(p.odds?.uv)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [pitcherPlays, setPitcherPlays] = useState([]);
  const [batterPlays, setBatterPlays] = useState([]);
  const [log, setLog] = useState(null);
  const [status, setStatus] = useState("Hit LOAD to pull MLB stats + live odds");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("pitchers");
  const [propFilter, setPropFilter] = useState("ALL");
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await loadAll(setStatus);
    setPitcherPlays(result.pitcherPlays);
    setBatterPlays(result.batterPlays);
    setLog(result.log);
    setUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }, []);

  const strongSP = pitcherPlays.filter(p => Math.abs(p.diff) >= 0.5);
  const strongBat = batterPlays.filter(p => Math.abs(p.diff) >= 0.5);

  const tabBtn = (key, label, count) => (
    <button key={key} onClick={() => setTab(key)} style={{
      background: tab === key ? C.green : C.panel,
      color: tab === key ? C.bg : C.dim,
      border: "1px solid " + (tab === key ? C.green : C.border),
      borderRadius: 6, padding: "8px 18px", fontSize: 12, fontWeight: 700,
      cursor: "pointer", fontFamily: "monospace",
    }}>
      {label} <span style={{ opacity: 0.7 }}>({count})</span>
    </button>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Inter','Segoe UI',sans-serif", color: C.white, padding: "16px 20px", maxWidth: 1500, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div style={{ background: C.green, color: C.bg, fontWeight: 900, fontSize: 11, padding: "3px 10px", borderRadius: 4 }}>MLB</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: -0.5 }}>PROP ENGINE</h1>
          </div>
          <div style={{ color: C.muted, fontSize: 10 }}>
            Model projections vs. sportsbook lines
            {updated && <span style={{ color: C.green }}>{" \u00b7 Updated " + updated}</span>}
          </div>
          <div style={{ color: status.includes("Error") ? C.red : status.includes("Done") ? C.green : C.dim, fontSize: 9, marginTop: 2, ...sty.mono }}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{
          background: loading ? C.muted : C.green, color: C.bg, border: "none", borderRadius: 8,
          padding: "14px 32px", fontWeight: 900, fontSize: 14, cursor: loading ? "not-allowed" : "pointer", fontFamily: "monospace",
        }}>
          {loading ? "LOADING..." : "LOAD GAMES"}
        </button>
      </div>

      {log && (
        <div style={{ background: C.panel, borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: "1px solid " + C.border, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11 }}>
          <div><span style={{ color: C.muted }}>Games </span><span style={{ color: C.white, fontWeight: 700 }}>{log.games}</span></div>
          <div><span style={{ color: C.muted }}>Players </span><span style={{ color: C.blue, fontWeight: 700 }}>{log.statsLoaded}</span></div>
          <div><span style={{ color: C.muted }}>SP Props </span><span style={{ color: C.green, fontWeight: 700 }}>{pitcherPlays.length}</span></div>
          <div><span style={{ color: C.muted }}>Strong SP </span><span style={{ color: strongSP.length > 0 ? C.green : C.muted, fontWeight: 700 }}>{strongSP.length}</span></div>
          <div><span style={{ color: C.muted }}>Bat Edges </span><span style={{ color: C.orange, fontWeight: 700 }}>{batterPlays.length}</span></div>
          <div><span style={{ color: C.muted }}>Strong BAT </span><span style={{ color: strongBat.length > 0 ? C.orange : C.muted, fontWeight: 700 }}>{strongBat.length}</span></div>
          <div><span style={{ color: C.muted }}>Pitcher lines in odds </span><span style={{ color: log.debugPitcherLines > 0 ? C.green : C.red, fontWeight: 700 }}>{log.debugPitcherLines}</span></div>
        </div>
      )}

      {(pitcherPlays.length > 0 || batterPlays.length > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {tabBtn("pitchers", "PITCHERS", pitcherPlays.length)}
          {tabBtn("batters", "BATTERS", batterPlays.length)}
          {tabBtn("strong-bat", "STRONG BAT", strongBat.length)}
        </div>
      )}

      {tab === "pitchers" && pitcherPlays.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
          {["ALL", "K", "H", "ER", "BB"].map(f => {
            const ct = f === "ALL" ? pitcherPlays.length : pitcherPlays.filter(p => p.prop === f).length;
            const active = propFilter === f;
            return (
              <button key={f} onClick={() => setPropFilter(f)} style={{
                background: active ? C.blue : C.card,
                color: active ? C.bg : C.dim,
                border: "1px solid " + (active ? C.blue : C.border),
                borderRadius: 4, padding: "4px 12px", fontSize: 11, fontWeight: 700,
                cursor: "pointer", fontFamily: "monospace",
              }}>
                {f === "ALL" ? "ALL PROPS" : f === "K" ? "STRIKEOUTS" : f === "H" ? "HITS ALLOWED" : f === "ER" ? "EARNED RUNS" : "WALKS"} ({ct})
              </button>
            );
          })}
        </div>
      )}

      {tab === "pitchers" && <PitcherTable plays={propFilter === "ALL" ? pitcherPlays : pitcherPlays.filter(p => p.prop === propFilter)} />}
      {tab === "batters" && <BatterTable plays={batterPlays} />}
      {tab === "strong-bat" && <BatterTable plays={strongBat} />}

      {pitcherPlays.length === 0 && batterPlays.length === 0 && !loading && (
        <div style={{ textAlign: "center", padding: 80, color: C.muted }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>{"\u26be"}</div>
          <div style={{ fontSize: 15, color: C.dim, marginBottom: 8 }}>Hit LOAD to pull every MLB game</div>
          <div style={{ fontSize: 11, color: C.muted, maxWidth: 500, margin: "0 auto" }}>
            Fetches real player stats + team batting data from MLB API, live odds from 6+ books,
            then runs projections with opponent quality, park factors, and platoon splits.
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, color: C.muted, fontSize: 8, textAlign: "center", ...sty.mono }}>
        MLB Prop Engine — opponent quality + pitcher suppression + park factors + platoon splits
      </div>
    </div>
  );
}
