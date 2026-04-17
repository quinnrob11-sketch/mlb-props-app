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
const PROP_COLORS = {
  K:C.green, OUTS:C.blue, H:C.yellow, ER:C.orange, BB:C.purple,
  HR:C.red, R:C.green, RBI:C.orange, TB:C.purple, HRR:C.teal,
  "2B":C.blue, SB:C.green, "1B":C.yellow,
};

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

// League-average per-PA rates (2025 MLB)
const LGA = {h:0.243,hr:0.030,r:0.115,rbi:0.110,tb:0.380,d:0.042,s:0.170,sb:0.022,k:0.225};

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
// PROJECTION ENGINE — PURE MODEL, NO MARKET BLENDING
// ═══════════════════════════════════════════════════════════════════════════════

function projPitcher(pStats, park) {
  if (!pStats?.pitching) return null;
  const s = pStats.pitching;
  const ip = parseFloat(s.inningsPitched)||0;
  const bf = s.battersFaced || Math.round(ip*3+(s.hits||0)+(s.baseOnBalls||0));
  if (ip<3||bf<10) return null;

  const kRate = (s.strikeOuts||0)/bf;
  const hRate = (s.hits||0)/bf;
  const erRate = (s.earnedRuns||0)/bf;
  const bbRate = (s.baseOnBalls||0)/bf;

  const gs = s.gamesStarted||s.gamesPlayed||1;
  const avgIP = ip/gs;
  const pIP = Math.min(Math.max(avgIP,4.5),7.0);
  const pBF = Math.round(pIP*3 + (hRate+bbRate)*pIP*3);

  const pkK = (park?.k||100)/100;
  const pkR = park?.pf||1.0;

  // K boost for elite arms — they outperform rate in single games
  const kBoost = kRate>=0.28 ? 1.06 : kRate>=0.24 ? 1.03 : 1.0;

  return {
    name:pStats.name, hand:pStats.throw||"R",
    K:  +(kRate*pBF*pkK*kBoost).toFixed(1),
    OUTS: Math.round(pIP*3),
    H:  +(hRate*pBF).toFixed(1),
    ER: +(erRate*pBF*pkR).toFixed(1),
    BB: +(bbRate*pBF).toFixed(1),
    era:s.era??"—", kPer9: ip>0?+((s.strikeOuts||0)/ip*9).toFixed(1):0,
    _hRate:hRate, _kRate:kRate, _erRate:erRate,
  };
}

function projBatter(bStats, pitProj, park) {
  if (!bStats?.hitting) return null;
  const s = bStats.hitting;
  const pa = s.plateAppearances||0;
  const g = s.gamesPlayed||0;
  if (pa<10) return null;

  const rate = k=>(k||0)/pa;
  const paPerG = pa/Math.max(g,1);
  const pPA = Math.min(paPerG*1.05, 5.2);

  // Pitcher suppression — AMPLIFIED 40% from raw
  let hitF=1, kF=1, runF=1;
  if (pitProj) {
    hitF = Math.max(0.35, Math.min(2.0, 1+(pitProj._hRate/LGA.h - 1)*1.4));
    kF   = Math.max(0.35, Math.min(2.0, 1+(pitProj._kRate/LGA.k - 1)*1.4));
    runF = Math.max(0.35, Math.min(2.0, 1+(pitProj._erRate/LGA.r - 1)*1.4));
  }

  // Platoon — real MLB splits are 8-12%
  const batH = bStats.bat, pitH = pitProj?.hand;
  const favorable = (batH==="L"&&pitH==="R")||(batH==="R"&&pitH==="L")||batH==="S";
  const sameSide  = (batH==="L"&&pitH==="L")||(batH==="R"&&pitH==="R");
  const plH = favorable?1.08 : sameSide?0.88 : 1.0; // for hits/power
  const plK = sameSide?1.12 : favorable?0.90 : 1.0;  // K goes UP same-side

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
    pPA,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER LOAD — builds flat list of all plays
// ═══════════════════════════════════════════════════════════════════════════════
async function loadAll(setSt) {
  const plays = []; // flat list: every prop with a projection
  const log = { games:0, mlbGames:0, statsLoaded:0, matched:0, unmatched:0, propsFound:0 };

  // 1. MLB schedule
  setSt("Fetching MLB schedule...");
  let mlbGames = [];
  try {
    mlbGames = await fetchSchedule();
    log.mlbGames = mlbGames.length;
    setSt(`${mlbGames.length} MLB games — loading rosters + stats...`);
  } catch(e) { setSt(`MLB API error: ${e.message} — continuing with odds only`); }

  // 2. Rosters + Stats
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

  // 3. Odds events
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

  // 4. For each game: fetch odds, match stats, build plays
  for (let i=0; i<unique.length; i++) {
    const ev = unique[i];
    setSt(`Props: ${ev.away_team.split(" ").pop()} @ ${ev.home_team.split(" ").pop()} (${i+1}/${unique.length})`);

    const lines = {};
    const rs = await Promise.all(ODDS_MKTS.map(m=>oddsApi(`sports/${SPORT}/events/${ev.id}/odds`,{regions:"us",markets:m,oddsFormat:"american"}).catch(()=>null)));
    for (const r of rs) { if (r?.ok) parseOdds(await r.json(), lines); }
    log.propsFound += Object.keys(lines).length;

    // Match to MLB game for park + pitchers
    const mlbGame = mlbGames.find(g=>
      ev.home_team.includes(g.home.name.split(" ").pop())||g.home.name.includes(ev.home_team.split(" ").pop())
    );
    const park = mlbGame?.park || {r:100,hr:100,k:100,pf:1.0};
    const matchup = `${ev.away_team.split(" ").pop()} @ ${ev.home_team.split(" ").pop()}`;
    const gameTime = new Date(ev.commence_time).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});

    // Build pitcher projections
    const pitProjs = {};
    for (const side of ["away","home"]) {
      const pp = mlbGame?.pp?.[side];
      if (pp && statsMap[pp.id]) {
        const proj = projPitcher(statsMap[pp.id], park);
        if (proj) {
          pitProjs[side] = proj;
          // Add pitcher plays
          for (const [pk, mkt] of Object.entries(PMKTS)) {
            const lv = getLine(lines, proj.name, mkt);
            if (!lv) continue;
            const modelVal = proj[pk];
            if (modelVal==null) continue;
            const diff = +(modelVal - lv.pt).toFixed(2);
            const fair = dvg(lv.ov, lv.uv);
            plays.push({
              player:proj.name, type:"SP", matchup, gameTime,
              prop:pk, line:lv.pt, proj:modelVal, diff,
              direction: diff>0?"OVER":"UNDER",
              odds:lv, fair, hasModel:true,
              info:`${proj.hand}HP · ${proj.era} ERA · ${proj.kPer9} K/9`,
            });
            log.matched++;
          }
        }
      }
    }

    // Discover batters from odds + match to stats
    const batterNames = new Set();
    for (const k of Object.keys(lines)) {
      if (!k.includes("pitcher_")) {
        const n = k.replace(/_(?:batter_)[^_]*$/,"").replace(/_/g," ");
        if (n) batterNames.add(n);
      }
    }

    for (const bName of batterNames) {
      // Match to MLB stats
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

      // Determine opposing pitcher
      let oppProj = null;
      if (mlbGame) {
        const awayNames = (mlbGame.awayRoster||[]).map(p=>norm(p.name));
        const isAway = awayNames.some(n=>n.includes(bN.split("_").pop()));
        oppProj = isAway ? pitProjs.home : pitProjs.away;
      }

      if (bStat) {
        const bp = projBatter(bStat, oppProj, park);
        if (bp) {
          for (const pk of BPROPS) {
            const lv = getLine(lines, bStat.name, BMKTS[pk]);
            if (!lv) continue;
            const modelVal = bp[pk];
            if (modelVal==null) continue;
            const diff = +(modelVal - lv.pt).toFixed(2);
            const fair = dvg(lv.ov, lv.uv);
            const oppName = oppProj?.name?.split(" ").pop()||"?";
            plays.push({
              player:bp.name, type:bp.pos, matchup, gameTime,
              prop:pk, line:lv.pt, proj:modelVal, diff,
              direction: diff>0?"OVER":"UNDER",
              odds:lv, fair, hasModel:true,
              info:`${bp.bat}HB · vs ${oppName} · ~${bp.pPA.toFixed(1)} PA`,
            });
            log.matched++;
          }
          continue;
        }
      }

      // No stats — still show the line but mark as no model
      for (const pk of BPROPS) {
        const lv = getLine(lines, bName, BMKTS[pk]);
        if (!lv) continue;
        plays.push({
          player:bName, type:"?", matchup, gameTime,
          prop:pk, line:lv.pt, proj:null, diff:null,
          direction:null, odds:lv, fair:dvg(lv.ov,lv.uv),
          hasModel:false, info:"no stats matched",
        });
        log.unmatched++;
      }
    }
  }

  // Sort: biggest absolute diff first (model plays only on top)
  plays.sort((a,b) => {
    if (a.hasModel && !b.hasModel) return -1;
    if (!a.hasModel && b.hasModel) return 1;
    return Math.abs(b.diff||0) - Math.abs(a.diff||0);
  });

  setSt(`Done — ${log.matched} model projections, ${log.unmatched} unmatched, ${log.propsFound} total props across ${log.games} games (${log.statsLoaded} player stats loaded)`);
  return { plays, log };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════
const sty = {
  th: {padding:"8px 10px",color:C.muted,fontSize:9,fontWeight:700,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",background:"#0a0f1a",textAlign:"left",letterSpacing:0.5,textTransform:"uppercase"},
  td: {padding:"7px 10px",borderBottom:`1px solid ${C.border}`,verticalAlign:"middle"},
  mono: {fontFamily:"'Courier New',monospace"},
};

function PlaysTable({ plays, filter }) {
  const filtered = filter==="all" ? plays :
    filter==="model" ? plays.filter(p=>p.hasModel) :
    filter==="over" ? plays.filter(p=>p.diff>0) :
    filter==="under" ? plays.filter(p=>p.diff<0) :
    plays.filter(p=>p.hasModel && Math.abs(p.diff)>=0.3);

  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr>
            {["Player","Type","Matchup","Prop","Line","Proj","Diff","Call","Odds","Fair%","Info"].map(h=>(
              <th key={h} style={{...sty.th,textAlign:h==="Diff"||h==="Line"||h==="Proj"||h==="Fair%"?"center":h==="Odds"?"center":"left"}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((p,i) => {
            const absDiff = Math.abs(p.diff||0);
            const diffColor = !p.hasModel ? C.muted :
              absDiff>=1.0 ? (p.diff>0?C.green:C.red) :
              absDiff>=0.5 ? (p.diff>0?"#66ff99":"#ff8a65") :
              absDiff>=0.2 ? (p.diff>0?C.yellow:"#ffab91") : C.dim;
            const rowBg = !p.hasModel ? "transparent" :
              absDiff>=1.0 ? (p.diff>0?C.green+"0D":C.red+"0D") :
              absDiff>=0.5 ? (p.diff>0?C.green+"08":C.red+"08") : "transparent";

            return (
              <tr key={i} style={{background:rowBg}}>
                <td style={{...sty.td,whiteSpace:"nowrap"}}>
                  <b style={{color:C.white,fontSize:12,textTransform:"capitalize"}}>{p.player}</b>
                </td>
                <td style={{...sty.td,color:C.dim,fontSize:10}}>{p.type}</td>
                <td style={{...sty.td,color:C.dim,fontSize:10,whiteSpace:"nowrap"}}>{p.matchup} <span style={{color:C.muted,fontSize:8}}>{p.gameTime}</span></td>
                <td style={{...sty.td}}>
                  <span style={{color:PROP_COLORS[p.prop]||C.white,fontWeight:700,...sty.mono}}>{p.prop}</span>
                </td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,color:C.blue,fontWeight:700,fontSize:13}}>{p.line}</td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,fontWeight:900,fontSize:14,color:p.hasModel?C.white:C.muted}}>
                  {p.proj!=null ? p.proj : "—"}
                </td>
                <td style={{...sty.td,textAlign:"center",...sty.mono,fontWeight:900,fontSize:14,color:diffColor}}>
                  {p.diff!=null ? (p.diff>0?"+":"")+p.diff : "—"}
                </td>
                <td style={{...sty.td,textAlign:"center"}}>
                  {p.hasModel && p.diff!=null ? (
                    <span style={{
                      background: (absDiff>=0.5?(p.diff>0?C.green:C.red):C.dim)+"22",
                      color: absDiff>=0.5?(p.diff>0?C.green:C.red):C.dim,
                      padding:"2px 8px",borderRadius:4,fontWeight:700,fontSize:10,...sty.mono,
                    }}>
                      {absDiff>=1.0 ? (p.direction+" !!") : absDiff>=0.5 ? p.direction : absDiff>=0.2 ? "lean "+p.direction : "—"}
                    </span>
                  ) : <span style={{color:C.muted,fontSize:9}}>no model</span>}
                </td>
                <td style={{...sty.td,textAlign:"center",fontSize:10,...sty.mono}}>
                  {p.odds && (
                    <span>
                      <span style={{color:p.odds.ov>0?C.green:C.yellow}}>{fmtO(p.odds.ov)}</span>
                      <span style={{color:C.muted}}>/</span>
                      <span style={{color:p.odds.uv>0?C.green:C.yellow}}>{fmtO(p.odds.uv)}</span>
                    </span>
                  )}
                </td>
                <td style={{...sty.td,textAlign:"center",color:C.dim,fontSize:10,...sty.mono}}>
                  {p.fair!=null ? (p.fair*100).toFixed(0)+"%" : "—"}
                </td>
                <td style={{...sty.td,color:C.muted,fontSize:9,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {p.info}
                </td>
              </tr>
            );
          })}
          {filtered.length===0 && (
            <tr><td colSpan={11} style={{...sty.td,textAlign:"center",color:C.muted,padding:40}}>No plays match this filter</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [plays, setPlays] = useState([]);
  const [log, setLog] = useState(null);
  const [status, setStatus] = useState("Hit LOAD to pull MLB stats + live odds");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("strong");
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await loadAll(setStatus);
    setPlays(result.plays);
    setLog(result.log);
    setUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }, []);

  const modelPlays = plays.filter(p=>p.hasModel);
  const strongPlays = plays.filter(p=>p.hasModel && Math.abs(p.diff)>=0.5);
  const overPlays = plays.filter(p=>p.hasModel && p.diff>0.2);
  const underPlays = plays.filter(p=>p.hasModel && p.diff<-0.2);

  const filterBtn = (key, label, count) => (
    <button key={key} onClick={()=>setFilter(key)} style={{
      background: filter===key ? C.green : C.panel,
      color: filter===key ? C.bg : C.dim,
      border:`1px solid ${filter===key?C.green:C.border}`,
      borderRadius:6, padding:"6px 14px", fontSize:11, fontWeight:700,
      cursor:"pointer", fontFamily:"monospace",
    }}>
      {label} {count!=null && <span style={{opacity:0.7}}>({count})</span>}
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
            Pure model projections vs. sportsbook lines — sorted by biggest edge
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
          <div><span style={{color:C.muted}}>Props found </span><span style={{color:C.blue,fontWeight:700}}>{log.propsFound}</span></div>
          <div><span style={{color:C.muted}}>Player stats loaded </span><span style={{color:C.green,fontWeight:700}}>{log.statsLoaded}</span></div>
          <div><span style={{color:C.muted}}>Model projections </span><span style={{color:C.green,fontWeight:700}}>{log.matched}</span></div>
          <div><span style={{color:C.muted}}>Unmatched (no stats) </span><span style={{color:log.unmatched>log.matched?C.red:C.yellow,fontWeight:700}}>{log.unmatched}</span></div>
          <div><span style={{color:C.muted}}>Strong plays (0.5+) </span><span style={{color:C.green,fontWeight:700}}>{strongPlays.length}</span></div>
        </div>
      )}

      {/* Filter tabs */}
      {plays.length>0 && (
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
          {filterBtn("strong","STRONG PLAYS",strongPlays.length)}
          {filterBtn("model","ALL MODEL",modelPlays.length)}
          {filterBtn("over","OVERS",overPlays.length)}
          {filterBtn("under","UNDERS",underPlays.length)}
          {filterBtn("all","ALL PROPS",plays.length)}
        </div>
      )}

      {/* Main table */}
      {plays.length > 0 && <PlaysTable plays={plays} filter={filter} />}

      {/* Empty state */}
      {plays.length===0 && !loading && (
        <div style={{textAlign:"center",padding:80,color:C.muted}}>
          <div style={{fontSize:52,marginBottom:16}}>&#9918;</div>
          <div style={{fontSize:15,color:C.dim,marginBottom:8}}>Hit LOAD to pull every MLB game</div>
          <div style={{fontSize:11,color:C.muted,maxWidth:500,margin:"0 auto"}}>
            Fetches real player stats from MLB Stats API, live odds from 6+ books,
            then runs independent projections with pitcher matchup, park factors,
            and platoon splits. Sorted by who will over/under perform their line the most.
          </div>
        </div>
      )}

      <div style={{marginTop:14,color:C.muted,fontSize:8,textAlign:"center",...sty.mono}}>
        MLB Prop Engine — pure model: pitcher suppression (1.4x amplified) + park factors (30 stadiums) + platoon splits (8-12%) — NO market blending
      </div>
    </div>
  );
}
