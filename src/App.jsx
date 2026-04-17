import { useState, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const SPORT = "baseball_mlb";
const ODDS_MKTS = [
  "pitcher_strikeouts,pitcher_outs,pitcher_hits_allowed,pitcher_earned_runs,pitcher_walks",
  "batter_hits,batter_home_runs,batter_runs_scored,batter_rbis,batter_total_bases",
  "batter_hits_runs_rbis,batter_doubles,batter_stolen_bases,batter_strikeouts,batter_singles",
];

const C = {
  bg: "#07090f", panel: "#0d1220", card: "#111827", border: "#1a2840",
  green: "#00e676", red: "#ff4444", yellow: "#ffd600", blue: "#40c4ff",
  purple: "#b388ff", orange: "#ff9100", white: "#eef2ff", muted: "#3d5270",
  dim: "#6b88ab", teal: "#26c6da",
};

const BPROPS = ["H","HR","R","RBI","TB","HRR","2B","SB","K","1B"];
const BMKTS = {
  H:"batter_hits", HR:"batter_home_runs", R:"batter_runs_scored",
  RBI:"batter_rbis", TB:"batter_total_bases", HRR:"batter_hits_runs_rbis",
  "2B":"batter_doubles", SB:"batter_stolen_bases", K:"batter_strikeouts", "1B":"batter_singles",
};
const PMKTS = {
  K:"pitcher_strikeouts", OUTS:"pitcher_outs", H:"pitcher_hits_allowed",
  ER:"pitcher_earned_runs", BB:"pitcher_walks",
};
const PROP_LABELS = { K:"Strikeouts", OUTS:"Outs Recorded", H:"Hits Allowed", ER:"Earned Runs", BB:"Walks" };
const BPROP_LABELS = { H:"Hits", HR:"Home Runs", R:"Runs", RBI:"RBIs", TB:"Total Bases", HRR:"H+R+RBI", "2B":"Doubles", SB:"Stolen Bases", K:"Strikeouts", "1B":"Singles" };

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

// League-average rates (2025 MLB season norms)
const LGA = {
  // per-PA batter rates
  h:0.243, hr:0.030, r:0.115, rbi:0.110, tb:0.380, d:0.042, s:0.170, sb:0.022, k:0.225,
  // per-BF pitcher rates
  pk:0.220, ph:0.240, per:0.040, pbb:0.080,
  // team per-PA rates (league average)
  tk:0.225, th:0.243, tbb:0.082,
};

// ═══════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const oddsApi = (path, params={}) => fetch(`/api/odds?${new URLSearchParams({path,...params})}`);
const mlbApi  = (path, params={}) => fetch(`/api/mlb?${new URLSearchParams({path,...params})}`);

// ═══════════════════════════════════════════════════════════════════════════════
// MLB DATA
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchSchedule() {
  const today = new Date().toISOString().slice(0,10);
  const r = await mlbApi("api/v1/schedule", {sportId:"1",date:today,hydrate:"probablePitcher(note),team"});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const games = [];
  for (const d of data.dates||[]) for (const g of d.games||[]) {
    if (g.status?.detailedState==="Postponed") continue;
    games.push({
      gamePk:g.gamePk, gameDate:g.gameDate,
      away:{id:g.teams.away.team.id, name:g.teams.away.team.name},
      home:{id:g.teams.home.team.id, name:g.teams.home.team.name},
      pp:{
        away:g.probablePitchers?.away?{id:g.probablePitchers.away.id,name:g.probablePitchers.away.fullName}:null,
        home:g.probablePitchers?.home?{id:g.probablePitchers.home.id,name:g.probablePitchers.home.fullName}:null,
      },
      park: PARKS[g.teams.home.team.name]||{r:100,hr:100,k:100,pf:1.0},
    });
  }
  return games;
}

async function fetchRoster(teamId) {
  try {
    const r = await mlbApi(`api/v1/teams/${teamId}/roster`,{rosterType:"active"});
    if (!r.ok) return [];
    const d = await r.json();
    return (d.roster||[]).map(p=>({id:p.person.id,name:p.person.fullName,pos:p.position?.abbreviation||"?"}));
  } catch { return []; }
}

async function fetchStats(ids) {
  if (!ids.length) return {};
  const season = new Date().getFullYear();
  const map = {};
  for (let i=0; i<ids.length; i+=40) {
    const chunk = ids.slice(i,i+40);
    try {
      const r = await mlbApi("api/v1/people",{
        personIds:chunk.join(","),
        hydrate:`stats(group=[hitting,pitching],type=[season],season=${season})`,
      });
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of d.people||[]) {
        const hitting = p.stats?.find(s=>s.group?.displayName==="hitting"&&s.type?.displayName==="season");
        const pitching = p.stats?.find(s=>s.group?.displayName==="pitching"&&s.type?.displayName==="season");
        map[p.id] = {
          id:p.id, name:p.fullName, bat:p.batSide?.code||"R", throw:p.pitchHand?.code||"R",
          pos:p.primaryPosition?.abbreviation||"?",
          hitting:hitting?.splits?.[0]?.stat||null,
          pitching:pitching?.splits?.[0]?.stat||null,
        };
      }
    } catch {/* skip */}
  }
  return map;
}

// Fetch team-level hitting stats for opponent quality adjustments
async function fetchTeamHitting() {
  const season = new Date().getFullYear();
  const map = {};
  try {
    const r = await mlbApi("api/v1/teams/stats",{stats:"season",group:"hitting",season:String(season),sportId:"1"});
    if (!r.ok) return map;
    const d = await r.json();
    for (const split of d.stats?.[0]?.splits||[]) {
      const s = split.stat;
      const pa = s.plateAppearances||1;
      map[split.team.id] = {
        name: split.team.name,
        kRate: (s.strikeOuts||0)/pa,       // team K rate per PA
        hRate: (s.hits||0)/(s.atBats||1),  // team batting average
        bbRate:(s.baseOnBalls||0)/pa,       // team walk rate
        hrRate:(s.homeRuns||0)/pa,          // team HR rate
        avg: s.avg ? parseFloat(s.avg) : 0.243,
      };
    }
  } catch {/* */}
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ODDS PARSING
// ═══════════════════════════════════════════════════════════════════════════════
function parseOdds(data, tgt) {
  const seen = new Set();
  const pri = ["draftkings","fanduel","betmgm","caesars","bovada","betonlineag"];
  const keys = [...pri,...(data.bookmakers||[]).map(b=>b.key).filter(k=>!pri.includes(k))];
  for (const bk of keys) {
    const bm = (data.bookmakers||[]).find(b=>b.key===bk);
    if (!bm) continue;
    for (const mkt of bm.markets||[]) {
      const byP = {};
      for (const o of mkt.outcomes||[]) {
        const d = (o.description||"").toLowerCase().replace(/\s+/g,"_");
        if (!byP[d]) byP[d]={};
        if (o.name==="Over") { byP[d].ov=o.price; if (o.point!=null) byP[d].pt=o.point; }
        if (o.name==="Under") byP[d].uv=o.price;
      }
      for (const [desc,v] of Object.entries(byP)) {
        if (v.pt==null) continue;
        const key = `${desc}_${mkt.key}`;
        if (!seen.has(key)) { seen.add(key); tgt[key]={pt:v.pt,ov:v.ov??null,uv:v.uv??null,bk:bm.title}; }
      }
    }
  }
}

const norm = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z\s]/g,"").replace(/\s+/g,"_").trim();

function getLine(lines, name, mkt) {
  const n = norm(name);
  const parts = n.split("_").filter(p=>p.length>1&&!["jr","sr","ii","iii","iv"].includes(p));
  const last = parts.length>0 ? parts.reduce((a,b)=>b.length>=a.length?b:a) : "";
  for (const [k,v] of Object.entries(lines||{})) {
    if (!k.endsWith(mkt)) continue;
    if (k.includes(last)&&(parts.length<2||k.includes(parts[0]))) return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ODDS MATH
// ═══════════════════════════════════════════════════════════════════════════════
const mlP = ml => ml<0 ? -ml/(-ml+100) : 100/(ml+100);
const dvg = (o,u) => o&&u ? mlP(o)/(mlP(o)+mlP(u)) : null;
const fmtO = ml => ml==null ? "—" : (ml>0?"+":"")+ml;

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * Pitcher projection — uses OPPOSING TEAM batting stats as a major lever.
 * A pitcher facing a high-K team gets boosted K projection; facing a
 * low-K contact team gets suppressed. This is the #1 factor books use
 * that a flat per-BF rate misses.
 */
function projPitcher(pStats, park, oppTeam) {
  if (!pStats?.pitching) return null;
  const s = pStats.pitching;
  const ip = parseFloat(s.inningsPitched)||0;
  const bf = s.battersFaced || Math.round(ip*3+(s.hits||0)+(s.baseOnBalls||0));
  if (ip<3||bf<10) return null;

  const kRate  = (s.strikeOuts||0)/bf;
  const hRate  = (s.hits||0)/bf;
  const erRate = (s.earnedRuns||0)/bf;
  const bbRate = (s.baseOnBalls||0)/bf;

  const gs = s.gamesStarted||s.gamesPlayed||1;
  const avgIP = ip/gs;
  const pIP = Math.min(Math.max(avgIP,4.5),7.0);
  const pBF = Math.round(pIP*3 + (hRate+bbRate)*pIP*3);

  // Park factors
  const pkK = (park?.k||100)/100;
  const pkR = park?.pf||1.0;

  // ─── OPPONENT QUALITY (the big lever) ───
  // Compare opposing team's rates to league average, amplify 1.6x
  let oppK=1.0, oppH=1.0, oppBB=1.0;
  if (oppTeam) {
    oppK  = 1 + (oppTeam.kRate/LGA.tk - 1) * 1.6;   // high-K team → more Ks
    oppH  = 1 + (oppTeam.hRate/LGA.th - 1) * 1.6;   // high-AVG team → more hits allowed
    oppBB = 1 + (oppTeam.bbRate/LGA.tbb - 1) * 1.4;  // high-BB team → more walks
    oppK  = Math.max(0.65, Math.min(1.45, oppK));
    oppH  = Math.max(0.65, Math.min(1.45, oppH));
    oppBB = Math.max(0.65, Math.min(1.45, oppBB));
  }

  // K boost for elite arms
  const kBoost = kRate>=0.30 ? 1.08 : kRate>=0.26 ? 1.05 : kRate>=0.22 ? 1.02 : 1.0;

  const projK  = +(kRate * pBF * pkK * oppK * kBoost).toFixed(1);
  const projH  = +(hRate * pBF * oppH).toFixed(1);
  const projER = +(erRate * pBF * pkR * oppH).toFixed(1);
  const projBB = +(bbRate * pBF * oppBB).toFixed(1);

  return {
    name:pStats.name, hand:pStats.throw||"R",
    K: projK,
    OUTS: Math.round(pIP*3),
    H: projH,
    ER: projER,
    BB: projBB,
    era: s.era??"—",
    kPer9: ip>0?+((s.strikeOuts||0)/ip*9).toFixed(1):0,
    whip: ip>0?+(((s.hits||0)+(s.baseOnBalls||0))/ip).toFixed(2):"—",
    avgIP: +avgIP.toFixed(1),
    _hRate:hRate, _kRate:kRate, _erRate:erRate, _bbRate:bbRate,
    oppTeamName: oppTeam?.name||"?",
    oppK: oppTeam ? +(oppTeam.kRate*100).toFixed(1) : null,
    oppAVG: oppTeam ? oppTeam.avg.toFixed(3) : null,
  };
}

/*
 * Batter projection — non-linear pitcher suppression.
 * Elite pitchers suppress more aggressively, bad pitchers inflate more.
 */
function projBatter(bStats, pitProj, park) {
  if (!bStats?.hitting) return null;
  const s = bStats.hitting;
  const pa = s.plateAppearances||0;
  const g = s.gamesPlayed||0;
  if (pa<10) return null;

  const rate = k=>(k||0)/pa;
  const paPerG = pa/Math.max(g,1);
  const pPA = Math.min(paPerG*1.05, 5.2);

  // Non-linear pitcher suppression — amplified 1.8x, squared deviation for extremes
  let hitF=1, kF=1, runF=1;
  if (pitProj) {
    const hDev = pitProj._hRate/LGA.ph - 1;    // negative = tough pitcher
    const kDev = pitProj._kRate/LGA.pk - 1;    // positive = high-K pitcher
    const rDev = pitProj._erRate/LGA.per - 1;

    // Amplify + add non-linear component for extremes
    hitF = 1 + hDev*1.8 + Math.sign(hDev)*hDev*hDev*3;
    kF   = 1 + kDev*1.8 + Math.sign(kDev)*kDev*kDev*3;
    runF = 1 + rDev*1.6;

    hitF = Math.max(0.45, Math.min(1.65, hitF));
    kF   = Math.max(0.45, Math.min(1.65, kF));
    runF = Math.max(0.45, Math.min(1.65, runF));
  }

  // Platoon — real MLB splits are 8-12%
  const batH = bStats.bat, pitH = pitProj?.hand;
  const favorable = (batH==="L"&&pitH==="R")||(batH==="R"&&pitH==="L")||batH==="S";
  const sameSide  = (batH==="L"&&pitH==="L")||(batH==="R"&&pitH==="R");
  const plH = favorable?1.10 : sameSide?0.86 : 1.0;
  const plK = sameSide?1.14 : favorable?0.88 : 1.0;

  const pkHR = (park?.hr||100)/100;
  const pkR  = park?.pf||1.0;
  const pkK  = (park?.k||100)/100;

  const singles = (s.hits||0)-(s.doubles||0)-(s.triples||0)-(s.homeRuns||0);

  const pH   = +(rate(s.hits)*hitF*plH*pPA).toFixed(2);
  const pHR  = +(rate(s.homeRuns)*hitF*plH*pPA*pkHR).toFixed(2);
  const pR   = +(rate(s.runs)*runF*plH*pPA*pkR).toFixed(2);
  const pRBI = +(rate(s.rbi)*runF*plH*pPA*pkR).toFixed(2);
  const pTB  = +(rate(s.totalBases)*hitF*plH*pPA*pkHR).toFixed(2);
  const p2B  = +(rate(s.doubles)*hitF*plH*pPA).toFixed(2);
  const pSB  = +(rate(s.stolenBases)*pPA).toFixed(2);
  const pK   = +(rate(s.strikeOuts)*kF*plK*pPA*pkK).toFixed(2);
  const p1B  = +((singles/pa)*hitF*plH*pPA).toFixed(2);

  return {
    name:bStats.name, bat:batH, pos:bStats.pos,
    H:pH, HR:pHR, R:pR, RBI:pRBI, TB:pTB,
    HRR:+(pH+pR+pRBI).toFixed(2),
    "2B":p2B, SB:pSB, K:pK, "1B":p1B,
    pPA, oppPitcher: pitProj?.name||null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER LOAD
// ═══════════════════════════════════════════════════════════════════════════════
async function loadAll(setSt) {
  const pitcherPlays = [];
  const batterPlays = [];
  const log = { games:0, mlbGames:0, statsLoaded:0, pitcherProps:0, batterProps:0 };

  // 1. MLB schedule
  setSt("Fetching MLB schedule...");
  let mlbGames = [];
  try {
    mlbGames = await fetchSchedule();
    log.mlbGames = mlbGames.length;
  } catch(e) { setSt(`MLB API error: ${e.message}`); }

  // 2. Team hitting stats (for opponent quality)
  setSt("Fetching team batting stats...");
  const teamHitting = await fetchTeamHitting();

  // 3. Rosters + Stats
  const statsMap = {};
  const rostersByTeam = {};
  if (mlbGames.length>0) {
    const teamIds = new Set();
    const allIds = new Set();
    const rosterPs = [];
    for (const g of mlbGames) {
      for (const t of [g.away,g.home]) {
        if (!teamIds.has(t.id)) { teamIds.add(t.id); rosterPs.push(fetchRoster(t.id).then(r=>{rostersByTeam[t.id]=r;})); }
      }
      if (g.pp.away?.id) allIds.add(g.pp.away.id);
      if (g.pp.home?.id) allIds.add(g.pp.home.id);
    }
    await Promise.all(rosterPs);
    for (const roster of Object.values(rostersByTeam)) for (const p of roster) allIds.add(p.id);

    setSt(`Loading stats for ${allIds.size} players...`);
    const fetched = await fetchStats([...allIds]);
    Object.assign(statsMap, fetched);
    log.statsLoaded = Object.keys(statsMap).length;

    for (const g of mlbGames) {
      g.awayRoster = rostersByTeam[g.away.id]||[];
      g.homeRoster = rostersByTeam[g.home.id]||[];
    }
  }

  // 4. Odds events
  setSt("Fetching odds...");
  let evs = [];
  try {
    const r = await oddsApi(`sports/${SPORT}/events`,{dateFormat:"iso"});
    if (r.ok) evs = await r.json();
  } catch {/* */}

  const now = new Date(), seen = new Set(), unique = [];
  for (const e of evs) {
    const diff = (new Date(e.commence_time)-now)/36e5;
    if (diff>30||diff<-6) continue;
    const key = `${e.away_team}@${e.home_team}`;
    if (!seen.has(key)) { seen.add(key); unique.push(e); }
  }
  unique.sort((a,b)=>new Date(a.commence_time)-new Date(b.commence_time));
  log.games = unique.length;

  // 5. For each game: fetch odds, match stats, build plays
  for (let i=0; i<unique.length; i++) {
    const ev = unique[i];
    setSt(`Props: ${ev.away_team.split(" ").pop()} @ ${ev.home_team.split(" ").pop()} (${i+1}/${unique.length})`);

    const lines = {};
    const rs = await Promise.all(ODDS_MKTS.map(m=>oddsApi(`sports/${SPORT}/events/${ev.id}/odds`,{regions:"us",markets:m,oddsFormat:"american"}).catch(()=>null)));
    for (const r of rs) { if (r?.ok) parseOdds(await r.json(), lines); }

    // Match to MLB game
    const mlbGame = mlbGames.find(g=>
      ev.home_team.includes(g.home.name.split(" ").pop())||g.home.name.includes(ev.home_team.split(" ").pop())
    );
    const park = mlbGame?.park || {r:100,hr:100,k:100,pf:1.0};
    const matchup = `${ev.away_team.split(" ").pop()} @ ${ev.home_team.split(" ").pop()}`;
    const gameTime = new Date(ev.commence_time).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});

    // Build pitcher projections — now with opponent team quality
    const pitProjs = {};
    for (const side of ["away","home"]) {
      const pp = mlbGame?.pp?.[side];
      if (pp && statsMap[pp.id]) {
        // Opposing team is the OTHER side
        const oppTeamId = side==="away" ? mlbGame.home.id : mlbGame.away.id;
        const oppTeam = teamHitting[oppTeamId] || null;
        const proj = projPitcher(statsMap[pp.id], park, oppTeam);
        if (proj) {
          pitProjs[side] = proj;
          for (const [pk, mkt] of Object.entries(PMKTS)) {
            const lv = getLine(lines, proj.name, mkt);
            if (!lv) continue;
            const modelVal = proj[pk];
            if (modelVal==null) continue;
            const diff = +(modelVal - lv.pt).toFixed(2);
            const fair = dvg(lv.ov, lv.uv);
            pitcherPlays.push({
              player:proj.name, matchup, gameTime,
              prop:pk, propLabel: PROP_LABELS[pk]||pk,
              line:lv.pt, proj:modelVal, diff,
              direction: diff>0?"OVER":"UNDER",
              odds:lv, fair, hand:proj.hand,
              era:proj.era, kPer9:proj.kPer9, whip:proj.whip, avgIP:proj.avgIP,
              oppTeamName:proj.oppTeamName, oppK:proj.oppK, oppAVG:proj.oppAVG,
            });
            log.pitcherProps++;
          }
        }
      }
    }

    // Batter plays — only include if edge is meaningful (|diff| >= 0.25)
    const batterNames = new Set();
    for (const k of Object.keys(lines)) {
      if (!k.includes("pitcher_")) {
        const n = k.replace(/_(?:batter_)[^_]*$/,"").replace(/_/g," ");
        if (n) batterNames.add(n);
      }
    }

    for (const bName of batterNames) {
      let bStat = null;
      const bN = norm(bName);
      for (const s of Object.values(statsMap)) {
        if (s.hitting && norm(s.name)===bN) { bStat=s; break; }
      }
      if (!bStat) {
        const parts = bN.split("_").filter(p=>p.length>1);
        const last = parts.reduce((a,b)=>b.length>=a.length?b:a,"");
        const first = parts[0]||"";
        for (const s of Object.values(statsMap)) {
          if (s.hitting && norm(s.name).includes(last) && (first.length<2||norm(s.name).includes(first))) { bStat=s; break; }
        }
      }

      let oppProj = null;
      if (mlbGame) {
        const awayNames = (mlbGame.awayRoster||[]).map(p=>norm(p.name));
        const isAway = awayNames.some(n=>n.includes(bN.split("_").pop()));
        oppProj = isAway ? pitProjs.home : pitProjs.away;
      }

      if (!bStat) continue;
      const bp = projBatter(bStat, oppProj, park);
      if (!bp) continue;

      for (const pk of BPROPS) {
        const lv = getLine(lines, bStat.name, BMKTS[pk]);
        if (!lv) continue;
        const modelVal = bp[pk];
        if (modelVal==null) continue;
        const diff = +(modelVal - lv.pt).toFixed(2);
        // Only keep meaningful edges
        if (Math.abs(diff) < 0.20) continue;
        const fair = dvg(lv.ov, lv.uv);
        batterPlays.push({
          player:bp.name, pos:bp.pos, matchup, gameTime,
          prop:pk, propLabel: BPROP_LABELS[pk]||pk,
          line:lv.pt, proj:modelVal, diff,
          direction: diff>0?"OVER":"UNDER",
          odds:lv, fair, bat:bp.bat,
          oppPitcher:oppProj?.name||"?",
        });
        log.batterProps++;
      }
    }
  }

  // Sort by biggest edge
  pitcherPlays.sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff));
  batterPlays.sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff));

  setSt(`Done — ${log.pitcherProps} pitcher props, ${log.batterProps} batter edges across ${log.games} games`);
  return { pitcherPlays, batterPlays, log };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════
const sty = {
  th: {padding:"8px 10px",color:C.muted,fontSize:9,fontWeight:700,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",background:"#0a0f1a",textAlign:"left",letterSpacing:0.5,textTransform:"uppercase"},
  td: {padding:"7px 10px",borderBottom:`1px solid ${C.border}`,verticalAlign:"middle"},
  mono: {fontFamily:"'Courier New',monospace"},
};

function diffColor(diff) {
  const abs = Math.abs(diff||0);
  if (abs>=1.0) return diff>0 ? C.green : C.red;
  if (abs>=0.5) return diff>0 ? "#66ff99" : "#ff8a65";
  if (abs>=0.3) return diff>0 ? C.yellow : "#ffab91";
  return C.dim;
}

function callLabel(diff) {
  const abs = Math.abs(diff||0);
  const dir = diff>0 ? "OVER" : "UNDER";
  if (abs>=1.0) return dir+" !!";
  if (abs>=0.5) return dir;
  if (abs>=0.3) return "lean "+dir;
  return "—";
}

function PitcherTable({ plays }) {
  if (!plays.length) return <div style={{color:C.muted,padding:20,textAlign:"center"}}>No pitcher props found</div>;
  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr>
            {["Pitcher","Matchup","vs Team","Prop","Line","Proj","Diff","Call","Odds","K/9","ERA","WHIP","Opp K%","Opp AVG"].map(h=>(
              <th key={h} style={{...sty.th,textAlign:["Line","Proj","Diff","K/9","ERA","WHIP","Opp K%","Opp AVG"].includes(h)?"center":"left"}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plays.map((p,i) => {
            const abs = Math.abs(p.diff);
            const rowBg = abs>=1.0 ? (p.diff>0?C.green+"0D":C.red+"0D") : abs>=0.5 ? (p.diff>0?C.green+"08":C.red+"08") : "transparent";
            return (
              <tr key={i} style={{background:rowBg}}>
                <td style={{...sty.td,whiteSpace:"nowrap"}}>
                  <b style={{color:C.white,fontSize:12}}>{p.player}</b>
                  <span style={{color:C.muted,fontSize:9,marginLeft:4}}>{p.hand}HP</span>
                </td>
                <td style={{...sty.td,color:C.dim,fontSize:10,whiteSpace:"nowrap"}}>{p.matchup} <span style={{color:C.muted,fontSize:8}}>{p.gameTime}</span></td>
                <td style={{...sty.td,color:C.dim,fontSize:10}}>{p.oppTeamName}</td>
                <td style={{...sty.td}}>
                  <span style={{color:C.blue,fontWeight:700,fontSize:11}}>{p.propLabel}</span>
                </td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,color:C.blue,fontWeight:700,fontSize:14}}>{p.line}</td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,fontWeight:900,fontSize:15,color:C.white}}>{p.proj}</td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,fontWeight:900,fontSize:15,color:diffColor(p.diff)}}>
                  {p.diff>0?"+":""}{p.diff}
                </td>
                <td style={{...sty.td,textAlign:"center"}}>
                  <span style={{
                    background: diffColor(p.diff)+"22",
                    color: diffColor(p.diff),
                    padding:"3px 10px",borderRadius:4,fontWeight:700,fontSize:10,...sty.mono,
                  }}>
                    {callLabel(p.diff)}
                  </span>
                </td>
                <td style={{...sty.td,textAlign:"center",fontSize:10,...sty.mono}}>
                  <span style={{color:p.odds?.ov>0?C.green:C.yellow}}>{fmtO(p.odds?.ov)}</span>
                  <span style={{color:C.muted}}>/</span>
                  <span style={{color:p.odds?.uv>0?C.green:C.yellow}}>{fmtO(p.odds?.uv)}</span>
                </td>
                <td style={{...sty.td,textAlign:"center",color:C.green,fontSize:11,...sty.mono,fontWeight:700}}>{p.kPer9}</td>
                <td style={{...sty.td,textAlign:"center",color:C.dim,fontSize:11,...sty.mono}}>{p.era}</td>
                <td style={{...sty.td,textAlign:"center",color:C.dim,fontSize:11,...sty.mono}}>{p.whip}</td>
                <td style={{...sty.td,textAlign:"center",color:p.oppK>23?C.green:p.oppK<20?C.red:C.dim,fontSize:11,...sty.mono,fontWeight:700}}>
                  {p.oppK!=null ? p.oppK+"%" : "—"}
                </td>
                <td style={{...sty.td,textAlign:"center",color:C.dim,fontSize:11,...sty.mono}}>
                  {p.oppAVG||"—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BatterTable({ plays }) {
  if (!plays.length) return <div style={{color:C.muted,padding:20,textAlign:"center"}}>No batter edges above threshold</div>;
  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr>
            {["Player","Pos","Matchup","vs Pitcher","Prop","Line","Proj","Diff","Call","Odds"].map(h=>(
              <th key={h} style={{...sty.th,textAlign:["Line","Proj","Diff"].includes(h)?"center":"left"}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plays.map((p,i) => {
            const abs = Math.abs(p.diff);
            const rowBg = abs>=1.0 ? (p.diff>0?C.green+"0D":C.red+"0D") : abs>=0.5 ? (p.diff>0?C.green+"08":C.red+"08") : "transparent";
            return (
              <tr key={i} style={{background:rowBg}}>
                <td style={{...sty.td,whiteSpace:"nowrap"}}>
                  <b style={{color:C.white,fontSize:12}}>{p.player}</b>
                  <span style={{color:C.muted,fontSize:9,marginLeft:4}}>{p.bat}HB</span>
                </td>
                <td style={{...sty.td,color:C.dim,fontSize:10}}>{p.pos}</td>
                <td style={{...sty.td,color:C.dim,fontSize:10,whiteSpace:"nowrap"}}>{p.matchup} <span style={{color:C.muted,fontSize:8}}>{p.gameTime}</span></td>
                <td style={{...sty.td,color:C.dim,fontSize:10}}>{p.oppPitcher?.split(" ").pop()||"?"}</td>
                <td style={{...sty.td}}>
                  <span style={{color:C.orange,fontWeight:700,fontSize:11}}>{p.propLabel}</span>
                </td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,color:C.blue,fontWeight:700,fontSize:14}}>{p.line}</td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,fontWeight:900,fontSize:15,color:C.white}}>{p.proj}</td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,fontWeight:900,fontSize:15,color:diffColor(p.diff)}}>
                  {p.diff>0?"+":""}{p.diff}
                </td>
                <td style={{...sty.td,textAlign:"center"}}>
                  <span style={{
                    background: diffColor(p.diff)+"22",
                    color: diffColor(p.diff),
                    padding:"3px 10px",borderRadius:4,fontWeight:700,fontSize:10,...sty.mono,
                  }}>
                    {callLabel(p.diff)}
                  </span>
                </td>
                <td style={{...sty.td,textAlign:"center",fontSize:10,...sty.mono}}>
                  <span style={{color:p.odds?.ov>0?C.green:C.yellow}}>{fmtO(p.odds?.ov)}</span>
                  <span style={{color:C.muted}}>/</span>
                  <span style={{color:p.odds?.uv>0?C.green:C.yellow}}>{fmtO(p.odds?.uv)}</span>
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

  const strongSP = pitcherPlays.filter(p=>Math.abs(p.diff)>=0.5);
  const strongBat = batterPlays.filter(p=>Math.abs(p.diff)>=0.5);

  const tabBtn = (key, label, count) => (
    <button key={key} onClick={()=>setTab(key)} style={{
      background: tab===key ? C.green : C.panel,
      color: tab===key ? C.bg : C.dim,
      border:`1px solid ${tab===key?C.green:C.border}`,
      borderRadius:6, padding:"8px 18px", fontSize:12, fontWeight:700,
      cursor:"pointer", fontFamily:"monospace",
    }}>
      {label} <span style={{opacity:0.7}}>({count})</span>
    </button>
  );

  return (
    <div style={{background:C.bg,minHeight:"100vh",fontFamily:"'Inter','Segoe UI',sans-serif",color:C.white,padding:"16px 20px",maxWidth:1500,margin:"0 auto"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16,gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
            <div style={{background:C.green,color:C.bg,fontWeight:900,fontSize:11,padding:"3px 10px",borderRadius:4}}>MLB</div>
            <h1 style={{margin:0,fontSize:22,fontWeight:900,letterSpacing:-0.5}}>PROP ENGINE</h1>
          </div>
          <div style={{color:C.muted,fontSize:10}}>
            Model projections vs. sportsbook lines — opponent quality + park + platoon
            {updated && <span style={{color:C.green}}> · Updated {updated}</span>}
          </div>
          <div style={{color:status.includes("Error")?C.red:status.includes("Done")?C.green:C.dim,fontSize:9,marginTop:2,...sty.mono}}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{
          background:loading?C.muted:C.green, color:C.bg, border:"none", borderRadius:8,
          padding:"14px 32px", fontWeight:900, fontSize:14, cursor:loading?"not-allowed":"pointer",
          fontFamily:"monospace",
        }}>
          {loading ? "LOADING..." : "LOAD GAMES"}
        </button>
      </div>

      {/* Stats bar */}
      {log && (
        <div style={{background:C.panel,borderRadius:8,padding:"10px 14px",marginBottom:12,border:`1px solid ${C.border}`,display:"flex",gap:20,flexWrap:"wrap",fontSize:11}}>
          <div><span style={{color:C.muted}}>Games </span><span style={{color:C.white,fontWeight:700}}>{log.games}</span></div>
          <div><span style={{color:C.muted}}>Players loaded </span><span style={{color:C.blue,fontWeight:700}}>{log.statsLoaded}</span></div>
          <div><span style={{color:C.muted}}>Pitcher props </span><span style={{color:C.green,fontWeight:700}}>{pitcherPlays.length}</span></div>
          <div><span style={{color:C.muted}}>Strong SP (0.5+) </span><span style={{color:strongSP.length>0?C.green:C.muted,fontWeight:700}}>{strongSP.length}</span></div>
          <div><span style={{color:C.muted}}>Batter edges </span><span style={{color:C.orange,fontWeight:700}}>{batterPlays.length}</span></div>
          <div><span style={{color:C.muted}}>Strong BAT (0.5+) </span><span style={{color:strongBat.length>0?C.orange:C.muted,fontWeight:700}}>{strongBat.length}</span></div>
        </div>
      )}

      {/* Tabs */}
      {(pitcherPlays.length>0||batterPlays.length>0) && (
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
          {tabBtn("pitchers","PITCHERS",pitcherPlays.length)}
          {tabBtn("strong-sp","STRONG SP",strongSP.length)}
          {tabBtn("batters","BATTERS",batterPlays.length)}
          {tabBtn("strong-bat","STRONG BAT",strongBat.length)}
        </div>
      )}

      {/* Content */}
      {tab==="pitchers" && <PitcherTable plays={pitcherPlays} />}
      {tab==="strong-sp" && <PitcherTable plays={strongSP} />}
      {tab==="batters" && <BatterTable plays={batterPlays} />}
      {tab==="strong-bat" && <BatterTable plays={strongBat} />}

      {/* Empty state */}
      {pitcherPlays.length===0 && batterPlays.length===0 && !loading && (
        <div style={{textAlign:"center",padding:80,color:C.muted}}>
          <div style={{fontSize:52,marginBottom:16}}>&#9918;</div>
          <div style={{fontSize:15,color:C.dim,marginBottom:8}}>Hit LOAD to pull every MLB game</div>
          <div style={{fontSize:11,color:C.muted,maxWidth:500,margin:"0 auto"}}>
            Fetches real player stats + team batting stats from MLB API, live odds from 6+ books,
            then runs projections with opponent quality, park factors, and platoon splits.
          </div>
        </div>
      )}

      <div style={{marginTop:14,color:C.muted,fontSize:8,textAlign:"center",...sty.mono}}>
        MLB Prop Engine — opponent team quality (1.6x) + non-linear pitcher suppression (1.8x) + park factors (30 stadiums) + platoon splits (10-14%)
      </div>
    </div>
  );
}
