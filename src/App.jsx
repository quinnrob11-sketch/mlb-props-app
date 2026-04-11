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
  dim: "#6b88ab", gold: "#ffc107", teal: "#26c6da",
};

const BC = {
  H: C.yellow, HR: C.red, R: C.green, RBI: C.orange, TB: C.purple,
  HRR: C.teal, "2B": C.blue, SB: C.green, K: C.red, "1B": C.yellow,
};

const BPROPS = ["H", "HR", "R", "RBI", "TB", "HRR", "2B", "SB", "K", "1B"];
const BMKTS = {
  H: "batter_hits", HR: "batter_home_runs", R: "batter_runs_scored",
  RBI: "batter_rbis", TB: "batter_total_bases", HRR: "batter_hits_runs_rbis",
  "2B": "batter_doubles", SB: "batter_stolen_bases", K: "batter_strikeouts",
  "1B": "batter_singles",
};
const PMKTS = {
  K: "pitcher_strikeouts", OUTS: "pitcher_outs", H: "pitcher_hits_allowed",
  ER: "pitcher_earned_runs", BB: "pitcher_walks",
};

// Park factors — Statcast 3-year rolling (100 = neutral)
const PARKS = {
  "Arizona Diamondbacks":  { r: 102, hr: 108, k: 101, pf: 1.02 },
  "Atlanta Braves":        { r: 101, hr: 104, k: 100, pf: 1.01 },
  "Baltimore Orioles":     { r: 103, hr: 108, k: 100, pf: 1.03 },
  "Boston Red Sox":        { r: 105, hr: 98,  k: 99,  pf: 1.05 },
  "Chicago Cubs":          { r: 104, hr: 112, k: 98,  pf: 1.04 },
  "Chicago White Sox":     { r: 98,  hr: 102, k: 101, pf: 0.98 },
  "Cincinnati Reds":       { r: 110, hr: 122, k: 98,  pf: 1.10 },
  "Cleveland Guardians":   { r: 97,  hr: 94,  k: 102, pf: 0.97 },
  "Colorado Rockies":      { r: 118, hr: 114, k: 92,  pf: 1.18 },
  "Detroit Tigers":        { r: 96,  hr: 92,  k: 102, pf: 0.96 },
  "Houston Astros":        { r: 101, hr: 104, k: 100, pf: 1.01 },
  "Kansas City Royals":    { r: 102, hr: 100, k: 100, pf: 1.02 },
  "Los Angeles Angels":    { r: 97,  hr: 96,  k: 102, pf: 0.97 },
  "Los Angeles Dodgers":   { r: 102, hr: 108, k: 101, pf: 1.02 },
  "Miami Marlins":         { r: 95,  hr: 88,  k: 103, pf: 0.95 },
  "Milwaukee Brewers":     { r: 103, hr: 110, k: 99,  pf: 1.03 },
  "Minnesota Twins":       { r: 101, hr: 106, k: 100, pf: 1.01 },
  "New York Mets":         { r: 99,  hr: 96,  k: 101, pf: 0.99 },
  "New York Yankees":      { r: 103, hr: 112, k: 99,  pf: 1.03 },
  "Oakland Athletics":     { r: 96,  hr: 90,  k: 102, pf: 0.96 },
  "Philadelphia Phillies":  { r: 104, hr: 108, k: 100, pf: 1.04 },
  "Pittsburgh Pirates":    { r: 96,  hr: 90,  k: 102, pf: 0.96 },
  "San Diego Padres":      { r: 98,  hr: 92,  k: 102, pf: 0.98 },
  "San Francisco Giants":  { r: 94,  hr: 86,  k: 103, pf: 0.94 },
  "Seattle Mariners":      { r: 96,  hr: 90,  k: 104, pf: 0.96 },
  "St. Louis Cardinals":   { r: 97,  hr: 94,  k: 101, pf: 0.97 },
  "Tampa Bay Rays":        { r: 96,  hr: 92,  k: 102, pf: 0.96 },
  "Texas Rangers":         { r: 103, hr: 106, k: 99,  pf: 1.03 },
  "Toronto Blue Jays":     { r: 102, hr: 108, k: 100, pf: 1.02 },
  "Washington Nationals":  { r: 99,  hr: 98,  k: 101, pf: 0.99 },
};

// League-average per-PA rates (2025 MLB)
const LGA = {
  h: 0.243, hr: 0.030, r: 0.115, rbi: 0.110, tb: 0.380,
  d: 0.042, s: 0.170, sb: 0.022, k: 0.225, "1b": 0.170,
};

const DEFAULT_PA = 4.1;

// ═══════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const oddsApi = (path, params = {}) => {
  const qs = new URLSearchParams({ path, ...params }).toString();
  return fetch(`/api/odds?${qs}`);
};

const mlbApi = (path, params = {}) => {
  const qs = new URLSearchParams({ path, ...params }).toString();
  return fetch(`/api/mlb?${qs}`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// MLB DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchMLBSchedule() {
  const today = new Date().toISOString().slice(0, 10);
  const r = await mlbApi("api/v1/schedule", {
    sportId: "1", date: today, hydrate: "probablePitcher(note),team",
  });
  if (!r.ok) throw new Error(`MLB schedule HTTP ${r.status}`);
  const data = await r.json();
  const games = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      const st = g.status?.detailedState || "";
      if (st === "Postponed" || st === "Cancelled") continue;
      games.push({
        gamePk: g.gamePk, gameDate: g.gameDate,
        away: { id: g.teams.away.team.id, name: g.teams.away.team.name },
        home: { id: g.teams.home.team.id, name: g.teams.home.team.name },
        pp: {
          away: g.probablePitchers?.away
            ? { id: g.probablePitchers.away.id, name: g.probablePitchers.away.fullName }
            : null,
          home: g.probablePitchers?.home
            ? { id: g.probablePitchers.home.id, name: g.probablePitchers.home.fullName }
            : null,
        },
        park: PARKS[g.teams.home.team.name] || { r: 100, hr: 100, k: 100, pf: 1.0 },
      });
    }
  }
  return games;
}

async function fetchRoster(teamId) {
  try {
    const r = await mlbApi(`api/v1/teams/${teamId}/roster`, { rosterType: "active" });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.roster || []).map(p => ({
      id: p.person.id, name: p.person.fullName,
      pos: p.position?.abbreviation || "?",
    }));
  } catch { return []; }
}

async function fetchPlayerStats(playerIds) {
  if (!playerIds.length) return {};
  const season = new Date().getFullYear();
  const map = {};
  // Batch in chunks of 40
  for (let i = 0; i < playerIds.length; i += 40) {
    const chunk = playerIds.slice(i, i + 40);
    try {
      const r = await mlbApi("api/v1/people", {
        personIds: chunk.join(","),
        hydrate: `stats(group=[hitting,pitching],type=[season],season=${season})`,
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const p of data.people || []) {
        const hitting = p.stats?.find(s => s.group?.displayName === "hitting" && s.type?.displayName === "season");
        const pitching = p.stats?.find(s => s.group?.displayName === "pitching" && s.type?.displayName === "season");
        map[p.id] = {
          id: p.id, name: p.fullName,
          bat: p.batSide?.code || "R", throw: p.pitchHand?.code || "R",
          pos: p.primaryPosition?.abbreviation || "?",
          hitting: hitting?.splits?.[0]?.stat || null,
          pitching: pitching?.splits?.[0]?.stat || null,
        };
      }
    } catch { /* skip chunk */ }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ODDS FETCHING + PARSING
// ═══════════════════════════════════════════════════════════════════════════════
function parseOddsInto(data, tgt) {
  const seen = new Set();
  const pri = ["draftkings", "fanduel", "betmgm", "caesars", "bovada", "betonlineag"];
  const keys = [...pri, ...(data.bookmakers || []).map(b => b.key).filter(k => !pri.includes(k))];
  for (const bk of keys) {
    const bm = (data.bookmakers || []).find(b => b.key === bk);
    if (!bm) continue;
    for (const mkt of bm.markets || []) {
      const byP = {};
      for (const o of mkt.outcomes || []) {
        const d = (o.description || "").toLowerCase().replace(/\s+/g, "_");
        if (!byP[d]) byP[d] = {};
        if (o.name === "Over") { byP[d].ov = o.price; if (o.point != null) byP[d].pt = o.point; }
        if (o.name === "Under") byP[d].uv = o.price;
      }
      for (const [desc, v] of Object.entries(byP)) {
        if (v.pt == null) continue;
        const key = `${desc}_${mkt.key}`;
        if (!seen.has(key)) { seen.add(key); tgt[key] = { pt: v.pt, ov: v.ov ?? null, uv: v.uv ?? null, bk: bm.title }; }
      }
    }
  }
}

const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, "_").trim();

function getLine(lines, name, mkt) {
  const n = norm(name);
  const parts = n.split("_").filter(p => p.length > 1 && !["jr", "sr", "ii", "iii", "iv"].includes(p));
  const last = parts.length > 0 ? parts.reduce((a, b) => b.length >= a.length ? b : a) : "";
  for (const [k, v] of Object.entries(lines || {})) {
    if (!k.endsWith(mkt)) continue;
    if (k.includes(last) && (parts.length < 2 || k.includes(parts[0]))) return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MATH — ODDS, PROBABILITY, PROJECTIONS, EDGE
// ═══════════════════════════════════════════════════════════════════════════════
const mlP = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
const dvg = (o, u) => o && u ? mlP(o) / (mlP(o) + mlP(u)) : null;
const toML = p => !p ? "—" : p >= 0.5 ? String(Math.round(-p / (1 - p) * 100)) : "+" + Math.round((1 - p) / p * 100);
const decOdds = ml => ml < 0 ? 1 + 100 / Math.abs(ml) : 1 + ml / 100;
const fmtO = ml => ml == null ? "—" : (ml > 0 ? "+" : "") + ml;

// Binomial PMF
function bPMF(n, k, p) {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

// P(X >= ceil(line)) via binomial — good for per-PA counting stats
function pOverBinom(proj, line, pa) {
  const n = Math.round(pa || DEFAULT_PA);
  const p = Math.min(Math.max(proj / n, 0.001), 0.95);
  const need = Math.floor(line) + 1;
  let cdf = 0;
  for (let k = 0; k < need; k++) cdf += bPMF(n, k, p);
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Poisson P(X >= ceil(line)) — better for pitcher counting stats (K, ER, etc.)
function pOverPoisson(lambda, line) {
  if (lambda <= 0) return 0;
  const need = Math.floor(line) + 1;
  let cdf = 0;
  let term = Math.exp(-lambda);
  cdf += term;
  for (let k = 1; k < need; k++) {
    term *= lambda / k;
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// ── Pitcher Projection ──
function projPitcher(pStats, park) {
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

  // Amplify K projection for elite arms — high-K pitchers outperform their rates
  // in individual games due to game-script leverage (pitching with lead = more K)
  const kBoost = kRate >= 0.28 ? 1.06 : kRate >= 0.24 ? 1.03 : 1.0;

  return {
    name: pStats.name, hand: pStats.throw || "R",
    projK: +(kRate * pBF * pkK * kBoost).toFixed(1),
    projIP: +pIP.toFixed(1),
    projOuts: Math.round(pIP * 3),
    projH: +(hRate * pBF).toFixed(1),
    projER: +(erRate * pBF * pkR).toFixed(1),
    projBB: +(bbRate * pBF).toFixed(1),
    era: s.era ?? "—", whip: s.whip ?? "—",
    kPer9: ip > 0 ? +((s.strikeOuts || 0) / ip * 9).toFixed(1) : 0,
    kPct: +(kRate * 100).toFixed(1),
    ip, gs, bf,
    _hRate: hRate, _kRate: kRate, _erRate: erRate,
    _hasModel: true,
  };
}

// ── Batter Projection ──
function projBatter(bStats, pitProj, park) {
  if (!bStats?.hitting) return null;
  const s = bStats.hitting;
  const pa = s.plateAppearances || 0;
  const g = s.gamesPlayed || 0;
  if (pa < 10) return null;

  const rate = k => (k || 0) / pa;
  const hR = rate(s.hits), hrR = rate(s.homeRuns), rR = rate(s.runs);
  const rbiR = rate(s.rbi), tbR = rate(s.totalBases), dR = rate(s.doubles);
  const sbR = rate(s.stolenBases), kR = rate(s.strikeOuts);
  const singles = (s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0);
  const sR = singles / pa;

  const paPerG = pa / Math.max(g, 1);
  const pPA = Math.min(paPerG * 1.05, 5.2);

  // Pitcher suppression — AMPLIFIED for differentiation
  // The market knows season rates; we push the pitcher factor harder
  // because individual game matchups are more volatile than season averages
  let hitF = 1, kF = 1, runF = 1;
  if (pitProj) {
    const rawHitF = pitProj._hRate / LGA.h;
    const rawKF = pitProj._kRate / LGA.k;
    const rawRunF = pitProj._erRate / LGA.r;
    // Amplify deviation from 1.0 by 40% — aces suppress MORE, bad arms inflate MORE
    hitF = Math.max(0.35, Math.min(2.0, 1 + (rawHitF - 1) * 1.4));
    kF = Math.max(0.35, Math.min(2.0, 1 + (rawKF - 1) * 1.4));
    runF = Math.max(0.35, Math.min(2.0, 1 + (rawRunF - 1) * 1.4));
  }

  // Platoon splits — real MLB splits are ~8-10%, not 3%
  // Favorable matchup (bat opposite hand or switch): boost
  // Unfavorable (same hand): suppress harder
  const plat = (bStats.bat === "L" && pitProj?.hand === "R") ||
               (bStats.bat === "R" && pitProj?.hand === "L") ||
               bStats.bat === "S";
  const sameSide = (bStats.bat === "L" && pitProj?.hand === "L") ||
                   (bStats.bat === "R" && pitProj?.hand === "R");
  const plA = plat ? 1.08 : sameSide ? 0.88 : 1.0;

  const pkHR = (park?.hr || 100) / 100;
  const pkR = park?.pf || 1.0;
  const pkK = (park?.k || 100) / 100;

  // Strikeout platoon is INVERTED — same-side matchups K MORE
  const plK = sameSide ? 1.12 : plat ? 0.90 : 1.0;

  const pH = +(hR * hitF * plA * pPA).toFixed(2);
  const pHR = +(hrR * hitF * plA * pPA * pkHR).toFixed(2);
  const pR = +(rR * runF * plA * pPA * pkR).toFixed(2);
  const pRBI = +(rbiR * runF * plA * pPA * pkR).toFixed(2);
  const pTB = +(tbR * hitF * plA * pPA * pkHR).toFixed(2);
  const p2B = +(dR * hitF * plA * pPA).toFixed(2);
  const pSB = +(sbR * pPA).toFixed(2);
  const pK = +(kR * kF * plK * pPA * pkK).toFixed(2);
  const p1B = +(sR * hitF * plA * pPA).toFixed(2);

  return {
    name: bStats.name, bat: bStats.bat, pos: bStats.pos, pa, g, pPA: +pPA.toFixed(1),
    H: pH, HR: pHR, R: pR, RBI: pRBI, TB: pTB,
    HRR: +(pH + pR + pRBI).toFixed(2),
    "2B": p2B, SB: pSB, K: pK, "1B": p1B,
    _hasModel: true,
  };
}

// ── Edge Calculation ──
function calcEdge(modelProj, live, propKey, pa) {
  if (modelProj == null || !live || live.ov == null || live.uv == null) return null;
  const line = live.pt;

  // Model probability of going OVER
  const isPitcherProp = ["K", "OUTS", "H", "ER", "BB"].includes(propKey);
  const modelPOver = isPitcherProp
    ? pOverPoisson(modelProj, line)
    : pOverBinom(modelProj, line, pa || DEFAULT_PA);

  const mktPOver = dvg(live.ov, live.uv);
  if (mktPOver == null) return null;

  const vig = +((mlP(live.ov) + mlP(live.uv) - 1) * 100).toFixed(1);

  // EV for each side
  const evOver = modelPOver * decOdds(live.ov) * 100 - 100;
  const evUnder = (1 - modelPOver) * decOdds(live.uv) * 100 - 100;

  const side = evOver >= evUnder ? "OVER" : "UNDER";
  const ev = +(side === "OVER" ? evOver : evUnder).toFixed(1);
  const winP = side === "OVER" ? modelPOver : (1 - modelPOver);
  const odds = side === "OVER" ? live.ov : live.uv;
  const edge = +(side === "OVER" ? (modelPOver - mktPOver) : ((1 - modelPOver) - (1 - mktPOver))).toFixed(3);

  // Kelly: f* = (bp − q) / b, fractional 25%
  let kelly = 0;
  if (edge > 0 && odds) {
    const b = decOdds(odds) - 1;
    const fk = (b * winP - (1 - winP)) / b;
    kelly = +Math.max(0, fk * 0.25 * 100).toFixed(1);
  }

  return {
    side, edge: +(edge * 100).toFixed(1), ev, kelly, vig,
    modelP: +(modelPOver * 100).toFixed(1), mktP: +(mktPOver * 100).toFixed(1),
    modelProj, line, odds, book: live.bk,
  };
}

// Market-implied projection — this is NOT a model projection.
// It just extracts what the market is pricing. Shown for reference only.
// Returns null for edge detection — you can't beat the market with its own numbers.
function impliedProj(live) {
  if (!live || live.ov == null || live.uv == null) return null;
  const fair = dvg(live.ov, live.uv);
  if (fair == null) return null;
  return +(live.pt + (fair - 0.5) * 2).toFixed(2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER LOAD FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════
async function loadAll(setSt) {
  const results = [];

  // Step 1: MLB schedule
  setSt("Fetching MLB schedule...");
  let mlbGames = [];
  try {
    mlbGames = await fetchMLBSchedule();
    setSt(`${mlbGames.length} games found — loading rosters...`);
  } catch (e) {
    setSt(`MLB API unavailable (${e.message}) — using odds-only mode`);
  }

  // Step 2: Rosters + Stats (parallel per game)
  const statsMap = {};
  if (mlbGames.length > 0) {
    const allPlayerIds = new Set();
    const rostersByTeam = {};

    // Fetch all rosters in parallel
    const rosterPromises = [];
    const teamIds = new Set();
    for (const g of mlbGames) {
      for (const t of [g.away, g.home]) {
        if (!teamIds.has(t.id)) {
          teamIds.add(t.id);
          rosterPromises.push(fetchRoster(t.id).then(r => { rostersByTeam[t.id] = r; }));
        }
      }
      // Also add probable pitchers
      if (g.pp.away?.id) allPlayerIds.add(g.pp.away.id);
      if (g.pp.home?.id) allPlayerIds.add(g.pp.home.id);
    }
    await Promise.all(rosterPromises);

    // Collect all player IDs from rosters
    for (const roster of Object.values(rostersByTeam)) {
      for (const p of roster) allPlayerIds.add(p.id);
    }

    setSt(`Loading stats for ${allPlayerIds.size} players...`);
    const fetched = await fetchPlayerStats([...allPlayerIds]);
    Object.assign(statsMap, fetched);
    setSt(`Stats loaded — fetching live odds...`);

    // Attach rosters to games
    for (const g of mlbGames) {
      g.awayRoster = rostersByTeam[g.away.id] || [];
      g.homeRoster = rostersByTeam[g.home.id] || [];
    }
  }

  // Step 3: Odds API — discover events
  setSt("Fetching odds events...");
  let oddsEvents = [];
  try {
    const r = await oddsApi(`sports/${SPORT}/events`, { dateFormat: "iso" });
    if (r.ok) oddsEvents = await r.json();
  } catch { /* silent */ }

  // Filter to upcoming
  const now = new Date();
  const seen = new Set();
  const unique = [];
  for (const e of oddsEvents) {
    const diff = (new Date(e.commence_time) - now) / 36e5;
    if (diff > 30 || diff < -6) continue;
    const key = `${e.away_team}@${e.home_team}`;
    if (!seen.has(key)) { seen.add(key); unique.push(e); }
  }
  unique.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

  // Step 4: Fetch odds for each event + build game data
  setSt(`${unique.length} odds events — fetching props...`);
  let totalEdges = 0;

  for (let i = 0; i < unique.length; i++) {
    const ev = unique[i];
    setSt(`${ev.away_team.split(" ").pop()} @ ${ev.home_team.split(" ").pop()} (${i + 1}/${unique.length})`);

    const lines = {};
    const [r1, r2, r3] = await Promise.all(
      ODDS_MKTS.map(m => oddsApi(`sports/${SPORT}/events/${ev.id}/odds`, {
        regions: "us", markets: m, oddsFormat: "american",
      }).catch(() => null))
    );
    for (const r of [r1, r2, r3]) {
      if (r?.ok) parseOddsInto(await r.json(), lines);
    }

    // Match to MLB game
    const mlbGame = mlbGames.find(g =>
      ev.home_team.includes(g.home.name.split(" ").pop()) ||
      g.home.name.includes(ev.home_team.split(" ").pop())
    );
    const park = mlbGame?.park || { r: 100, hr: 100, k: 100, pf: 1.0 };

    // Build pitcher projections
    const pitchers = [];
    const pitcherProjs = {};
    for (const side of ["away", "home"]) {
      const pp = mlbGame?.pp?.[side];
      if (pp && statsMap[pp.id]) {
        const proj = projPitcher(statsMap[pp.id], park);
        if (proj) {
          pitcherProjs[side] = proj;
          // Calculate edges for pitcher props
          const edges = {};
          for (const [pk, mkt] of Object.entries(PMKTS)) {
            const lv = getLine(lines, proj.name, mkt);
            const mp = pk === "K" ? proj.projK : pk === "OUTS" ? proj.projOuts
              : pk === "H" ? proj.projH : pk === "ER" ? proj.projER : proj.projBB;
            edges[pk] = { proj: mp, live: lv, edge: calcEdge(mp, lv, pk) };
          }
          pitchers.push({ ...proj, side, edges });
        }
      }
    }

    // Also discover pitchers from odds (fallback)
    const oddsOnlyPitchers = new Set();
    for (const k of Object.keys(lines)) {
      if (k.includes("pitcher_")) {
        const n = k.replace(/_(?:pitcher_)[^_]*$/, "").replace(/_/g, " ");
        if (n && !pitchers.find(p => norm(p.name) === norm(n))) oddsOnlyPitchers.add(n);
      }
    }
    for (const name of oddsOnlyPitchers) {
      const edges = {};
      for (const [pk, mkt] of Object.entries(PMKTS)) {
        const lv = getLine(lines, name, mkt);
        const ip = impliedProj(lv);
        edges[pk] = { proj: ip, live: lv, edge: null }; // no model edge without stats
      }
      pitchers.push({
        name, hand: "?", side: "?", edges, projK: edges.K?.proj,
        projOuts: edges.OUTS?.proj, projH: edges.H?.proj,
        projER: edges.ER?.proj, projBB: edges.BB?.proj,
        era: "—", whip: "—", kPer9: "—", kPct: "—", _noStats: true,
      });
    }

    // Build batter projections
    const batters = [];
    const oddsPlayerNames = new Set();
    for (const k of Object.keys(lines)) {
      if (!k.includes("pitcher_")) {
        const n = k.replace(/_(?:batter_)[^_]*$/, "").replace(/_/g, " ");
        if (n) oddsPlayerNames.add(n);
      }
    }

    for (const bName of oddsPlayerNames) {
      // Try to find this player in MLB stats
      let bStat = null;
      const bNorm = norm(bName);
      for (const s of Object.values(statsMap)) {
        if (s.hitting && norm(s.name) === bNorm) { bStat = s; break; }
      }
      if (!bStat) {
        // Fuzzy: match by last name
        const parts = bNorm.split("_").filter(p => p.length > 1);
        const last = parts.reduce((a, b) => b.length >= a.length ? b : a, "");
        for (const s of Object.values(statsMap)) {
          if (s.hitting && norm(s.name).includes(last)) { bStat = s; break; }
        }
      }

      // Determine which pitcher they face
      let oppPitProj = null;
      if (mlbGame) {
        const awayNames = (mlbGame.awayRoster || []).map(p => norm(p.name));
        const isAway = awayNames.some(n => n.includes(bNorm.split("_").pop()));
        oppPitProj = isAway ? pitcherProjs.home : pitcherProjs.away;
      }

      if (bStat) {
        const bp = projBatter(bStat, oppPitProj, park);
        if (bp) {
          const edges = {};
          let hasEdge = false;
          for (const pk of BPROPS) {
            const lv = getLine(lines, bStat.name, BMKTS[pk]);
            const e = calcEdge(bp[pk], lv, pk, bp.pPA);
            edges[pk] = { proj: bp[pk], live: lv, edge: e };
            if (e && e.edge > 3) { hasEdge = true; totalEdges++; }
          }
          batters.push({ ...bp, edges, hasEdge });
          continue;
        }
      }

      // Fallback: odds-implied only (no edge calculation possible)
      const edges = {};
      for (const pk of BPROPS) {
        const lv = getLine(lines, bName, BMKTS[pk]);
        const ip = impliedProj(lv);
        edges[pk] = { proj: ip, live: lv, edge: null };
      }
      batters.push({ name: bName, bat: "?", pos: "?", pa: 0, edges, _noStats: true });
    }

    // Sort batters: ones with edges first
    batters.sort((a, b) => {
      if (a.hasEdge && !b.hasEdge) return -1;
      if (!a.hasEdge && b.hasEdge) return 1;
      return 0;
    });

    results.push({
      id: ev.id, away: ev.away_team, home: ev.home_team,
      time: ev.commence_time, lines, park,
      pitchers, batters,
      propCount: Object.keys(lines).length,
    });
  }

  const withProps = results.filter(g => g.propCount > 0).length;
  setSt(`Done — ${results.length} games, ${totalEdges} model edges found`);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED STYLES
// ═══════════════════════════════════════════════════════════════════════════════
const sty = {
  th: { padding: "6px 8px", color: C.muted, fontSize: 8, fontWeight: 700, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: "#0a0f1a", textAlign: "left", letterSpacing: 0.3 },
  td: { padding: "5px 8px", verticalAlign: "middle" },
  inp: { background: C.bg, border: `1px solid ${C.border}`, color: C.white, borderRadius: 4, padding: "3px 5px", fontSize: 10, width: 52, outline: "none", fontFamily: "monospace", textAlign: "center" },
  badge: (bg, fg) => ({ background: bg + "22", color: fg, fontSize: 9, padding: "2px 8px", borderRadius: 4, fontWeight: 700 }),
  mono: { fontFamily: "monospace" },
  tag: (c) => ({ background: C.panel, borderRadius: 4, padding: "2px 6px", color: c, fontFamily: "monospace", fontSize: 9, fontWeight: 700 }),
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Edge Badge ──
function EdgeBadge({ e }) {
  if (!e) return <span style={{ color: C.yellow, fontSize: 8, fontStyle: "italic" }}>MKT ONLY — no edge calc</span>;
  const color = e.edge > 8 ? C.green : e.edge > 4 ? C.yellow : e.edge > 0 ? C.blue : e.edge < -4 ? C.red : C.dim;
  const grade = e.edge > 8 ? "A+" : e.edge > 5 ? "A" : e.edge > 3 ? "B" : e.edge > 0 ? "C" : "—";
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ color, fontWeight: 900, fontSize: 12, ...sty.mono }}>
          {e.side === "OVER" ? "O" : "U"} {e.edge > 0 ? "+" : ""}{e.edge}%
        </span>
        {e.edge > 5 && <span style={sty.badge(C.green, C.green)}>PLAY [{grade}]</span>}
        {e.edge > 2 && e.edge <= 5 && <span style={sty.badge(C.yellow, C.yellow)}>LEAN [{grade}]</span>}
      </div>
      {e.ev > 0 && (
        <div style={{ fontSize: 8, color: C.dim }}>
          EV +${e.ev}/100 · {e.kelly > 0 ? `${e.kelly}% Kelly` : ""} · Model {e.modelP}% vs Book {e.mktP}%
        </div>
      )}
      {e.ev <= 0 && e.edge > 0 && (
        <div style={{ fontSize: 8, color: C.dim }}>Thin — juice eats the edge ({e.vig}% vig)</div>
      )}
    </div>
  );
}

// ── Prop Cell (for both pitcher and batter) ──
function PropCell({ propData, color }) {
  const { proj, live, edge } = propData || {};
  const [ovr, setOvr] = useState("");
  const line = parseFloat(ovr) || live?.pt || null;
  const projEdge = line != null && proj != null ? +(proj - line).toFixed(2) : null;
  const fair = dvg(live?.ov, live?.uv);
  const vig = live?.ov && live?.uv ? +((mlP(live.ov) + mlP(live.uv) - 1) * 100).toFixed(1) : null;

  return (
    <div style={{ minWidth: 100 }}>
      {/* Model projection */}
      {proj != null && (
        <div style={{ marginBottom: 2 }}>
          <span style={{ color: color || C.white, fontFamily: "monospace", fontWeight: 900, fontSize: 15 }}>{proj}</span>
          {!edge && <span style={{ color: C.yellow, fontSize: 7, marginLeft: 3, fontStyle: "italic" }}>mkt</span>}
        </div>
      )}
      {/* Live line + odds */}
      {live && (
        <div style={{ marginBottom: 3 }}>
          <span style={{ color: C.blue, ...sty.mono, fontWeight: 700, fontSize: 11 }}>{live.pt} </span>
          <span style={{ color: live.ov > 0 ? C.green : C.yellow, fontSize: 9, fontWeight: 600 }}>{fmtO(live.ov)}</span>
          <span style={{ color: C.muted, fontSize: 8 }}>/</span>
          <span style={{ color: live.uv > 0 ? C.green : C.yellow, fontSize: 9, fontWeight: 600 }}>{fmtO(live.uv)}</span>
        </div>
      )}
      {/* Edge badge */}
      {edge && <EdgeBadge e={edge} />}
      {/* Override input */}
      <input type="number" step="0.5" value={ovr} onChange={e => setOvr(e.target.value)}
        placeholder={live ? "ovr" : "line"} style={{ ...sty.inp, marginTop: 3 }} />
      {/* Raw edge from projection */}
      {projEdge != null && !edge && (
        <div style={{ marginTop: 2, color: projEdge > 0 ? C.green : projEdge < 0 ? C.red : C.dim, ...sty.mono, fontWeight: 700, fontSize: 10 }}>
          {projEdge > 0 ? "+" : ""}{projEdge}
        </div>
      )}
      {fair != null && !edge && (
        <div style={{ fontSize: 7, color: C.dim }}>
          FV {(fair * 100).toFixed(0)}% ({toML(fair)}) <span style={{ color: vig <= 4 ? C.green : vig <= 7 ? C.yellow : C.red }}>{vig}%v</span>
        </div>
      )}
    </div>
  );
}

// ── Top Picks (Best +EV Plays) ──
function TopPicks({ games }) {
  const picks = [];
  for (const g of games) {
    const matchup = `${g.away.split(" ").pop()} @ ${g.home.split(" ").pop()}`;
    // Pitcher picks
    for (const p of g.pitchers) {
      for (const [pk, data] of Object.entries(p.edges || {})) {
        if (data.edge && data.edge.edge > 2 && data.edge.ev > 0) {
          picks.push({
            player: p.name, matchup, prop: `${pk} ${data.edge.side}`,
            line: data.edge.line, edge: data.edge.edge, ev: data.edge.ev,
            kelly: data.edge.kelly, odds: data.edge.odds, type: "pitcher",
            modelP: data.edge.modelP, mktP: data.edge.mktP, proj: data.proj,
          });
        }
      }
    }
    // Batter picks
    for (const b of g.batters) {
      for (const [pk, data] of Object.entries(b.edges || {})) {
        if (data.edge && data.edge.edge > 2 && data.edge.ev > 0) {
          picks.push({
            player: b.name, matchup, prop: `${pk} ${data.edge.side}`,
            line: data.edge.line, edge: data.edge.edge, ev: data.edge.ev,
            kelly: data.edge.kelly, odds: data.edge.odds, type: "batter",
            modelP: data.edge.modelP, mktP: data.edge.mktP, proj: data.proj,
          });
        }
      }
    }
  }
  picks.sort((a, b) => b.edge - a.edge);

  if (picks.length === 0) return null;

  return (
    <div style={{ background: C.panel, borderRadius: 10, padding: 14, marginBottom: 14, border: `1px solid ${C.green}44` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ color: C.green, fontWeight: 900, fontSize: 13 }}>+EV PLAYS</span>
        <span style={sty.badge(C.green, C.green)}>{picks.length} edges</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["PLAYER", "MATCHUP", "PROP", "LINE", "PROJ", "EDGE", "EV/$100", "KELLY%", "MODEL", "MARKET", "ODDS"].map(h => (
                <th key={h} style={{ ...sty.th, textAlign: h === "PLAYER" ? "left" : "center" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {picks.slice(0, 30).map((p, i) => {
              const ec = p.edge > 5 ? C.green : p.edge > 3 ? C.yellow : C.blue;
              return (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 ? "transparent" : C.card + "44" }}>
                  <td style={{ ...sty.td, whiteSpace: "nowrap" }}>
                    <b style={{ color: C.white, fontSize: 11, textTransform: "capitalize" }}>{p.player}</b>
                    <span style={{ color: C.muted, fontSize: 8, marginLeft: 4 }}>{p.type === "pitcher" ? "SP" : "BAT"}</span>
                  </td>
                  <td style={{ ...sty.td, color: C.dim, fontSize: 10, textAlign: "center" }}>{p.matchup}</td>
                  <td style={{ ...sty.td, textAlign: "center" }}>
                    <span style={{ color: ec, fontWeight: 700, fontSize: 11, ...sty.mono }}>{p.prop}</span>
                  </td>
                  <td style={{ ...sty.td, color: C.blue, textAlign: "center", ...sty.mono, fontWeight: 700 }}>{p.line}</td>
                  <td style={{ ...sty.td, color: C.white, textAlign: "center", ...sty.mono, fontWeight: 700 }}>{p.proj}</td>
                  <td style={{ ...sty.td, textAlign: "center" }}>
                    <span style={{ color: ec, fontWeight: 900, fontSize: 12, ...sty.mono }}>+{p.edge}%</span>
                  </td>
                  <td style={{ ...sty.td, color: p.ev > 0 ? C.green : C.red, textAlign: "center", ...sty.mono, fontWeight: 700 }}>
                    {p.ev > 0 ? "+" : ""}{p.ev}
                  </td>
                  <td style={{ ...sty.td, color: p.kelly > 1 ? C.green : C.dim, textAlign: "center", ...sty.mono }}>{p.kelly}%</td>
                  <td style={{ ...sty.td, color: C.dim, textAlign: "center", fontSize: 10 }}>{p.modelP}%</td>
                  <td style={{ ...sty.td, color: C.dim, textAlign: "center", fontSize: 10 }}>{p.mktP}%</td>
                  <td style={{ ...sty.td, color: p.odds > 0 ? C.green : C.yellow, textAlign: "center", ...sty.mono, fontWeight: 700, fontSize: 10 }}>
                    {fmtO(p.odds)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Pitcher Card ──
function PitcherCard({ p }) {
  const projIP = p.projOuts != null ? (p.projOuts / 3).toFixed(1) : p.projIP;
  const projERA = p.projER != null && projIP ? (p.projER / parseFloat(projIP) * 9).toFixed(2) : null;

  return (
    <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14, flex: 1, minWidth: 320 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {p.hand !== "?" && <span style={{ background: p.hand === "L" ? C.purple : C.blue, color: C.bg, fontSize: 8, fontWeight: 900, padding: "1px 4px", borderRadius: 3 }}>{p.hand}HP</span>}
        <b style={{ color: C.white, fontSize: 15, textTransform: "capitalize" }}>{p.name}</b>
        {p._noStats && <span style={sty.badge(C.yellow, C.yellow)}>ODDS ONLY</span>}
        {!p._noStats && <span style={sty.badge(C.green, C.green)}>MODEL</span>}
      </div>

      {/* Stats tags */}
      {!p._noStats && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {[
            [p.era + " ERA", parseFloat(p.era) <= 2.8 ? C.green : parseFloat(p.era) <= 3.5 ? C.yellow : C.red],
            [p.whip + " WHIP", parseFloat(p.whip) <= 1.05 ? C.green : parseFloat(p.whip) <= 1.2 ? C.yellow : C.red],
            [p.kPct + "% K", p.kPct >= 28 ? C.green : p.kPct >= 24 ? C.yellow : C.dim],
            [p.kPer9 + " K/9", p.kPer9 >= 10 ? C.green : p.kPer9 >= 8 ? C.yellow : C.dim],
          ].map(([l, c]) => <span key={l} style={sty.tag(c)}>{l}</span>)}
        </div>
      )}

      {/* Quick projections */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          ["PROJ K", p.projK, C.green],
          ["PROJ IP", projIP, C.blue],
          ["PROJ ER", p.projER, C.orange],
          ["PROJ ERA", projERA, projERA && parseFloat(projERA) <= 3.0 ? C.green : projERA && parseFloat(projERA) <= 4.0 ? C.yellow : C.red],
          ["PROJ BB", p.projBB, C.purple],
          ["PROJ H", p.projH, C.yellow],
        ].map(([label, val, color]) => val != null ? (
          <div key={label} style={{ background: C.panel, borderRadius: 5, padding: "5px 9px", textAlign: "center" }}>
            <div style={{ color: C.muted, fontSize: 7, letterSpacing: 0.3 }}>{label}</div>
            <div style={{ color, fontSize: 14, fontWeight: 900, ...sty.mono }}>{val}</div>
          </div>
        ) : null)}
      </div>

      {/* Prop rows */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <tbody>
          {[
            ["STRIKEOUTS", "K", C.green],
            ["OUTS REC", "OUTS", C.blue],
            ["HITS ALLOW", "H", C.yellow],
            ["EARNED RUNS", "ER", C.orange],
            ["WALKS", "BB", C.purple],
          ].map(([label, pk, color]) => {
            const data = p.edges?.[pk];
            return (
              <tr key={pk} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: "7px 8px", color: C.dim, fontSize: 10, width: 100 }}>{label}</td>
                <td style={{ padding: "7px 8px" }}>
                  <PropCell propData={data} color={color} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Batter Table ──
function BatterTable({ batters, visProps, setVP }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ color: C.muted, fontSize: 9, alignSelf: "center", marginRight: 4 }}>SHOW:</span>
        {BPROPS.map(k => (
          <button key={k} onClick={() => setVP(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])}
            style={{
              background: visProps.includes(k) ? BC[k] + "22" : C.bg,
              color: visProps.includes(k) ? BC[k] : C.muted,
              border: `1px solid ${visProps.includes(k) ? BC[k] + "55" : C.border}`,
              borderRadius: 4, padding: "3px 10px", fontSize: 10, fontWeight: 700,
              cursor: "pointer", fontFamily: "monospace",
            }}>
            {k}
          </button>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...sty.th, minWidth: 140, color: C.white }}>BATTER</th>
              {visProps.map(k => (
                <th key={k} style={{ ...sty.th, color: BC[k], borderLeft: `2px solid ${C.border}`, minWidth: 130, textAlign: "center" }}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batters.map((b, idx) => (
              <tr key={b.name + idx} style={{ borderBottom: `1px solid ${C.border}`, background: b.hasEdge ? C.green + "08" : "transparent" }}>
                <td style={{ ...sty.td, whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <b style={{ color: C.white, fontSize: 11, textTransform: "capitalize" }}>{b.name}</b>
                    {b._noStats && <span style={{ color: C.yellow, fontSize: 7 }}>MKT</span>}
                    {!b._noStats && b.bat && <span style={{ color: C.dim, fontSize: 7 }}>{b.bat}/{b.pos}</span>}
                  </div>
                  {!b._noStats && b.pa > 0 && (
                    <div style={{ color: C.muted, fontSize: 8 }}>{b.pa}PA · {b.g}G · ~{b.pPA}PA/gm</div>
                  )}
                </td>
                {visProps.map(k => (
                  <td key={k} style={{ ...sty.td, borderLeft: `2px solid ${C.border}`, textAlign: "center" }}>
                    <PropCell propData={b.edges?.[k]} color={BC[k]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Game Card ──
function GameCard({ game }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("p");
  const [visProps, setVP] = useState(["H", "HR", "R", "RBI", "TB"]);
  const { away, home, time, propCount, pitchers, batters, park } = game;
  const hasL = propCount > 0;
  const t = new Date(time);
  const timeStr = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  // Count edges in this game
  const gameEdges = [];
  for (const p of pitchers) {
    for (const [pk, d] of Object.entries(p.edges || {})) {
      if (d.edge && d.edge.edge > 2 && d.edge.ev > 0) gameEdges.push({ name: p.name, pk, ...d.edge });
    }
  }
  for (const b of batters) {
    for (const [pk, d] of Object.entries(b.edges || {})) {
      if (d.edge && d.edge.edge > 2 && d.edge.ev > 0) gameEdges.push({ name: b.name, pk, ...d.edge });
    }
  }

  const tabBtn = (k, label) => (
    <button onClick={e => { e.stopPropagation(); setTab(k); }} style={{
      padding: "5px 14px", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 10, fontFamily: "monospace",
      borderRadius: "5px 5px 0 0", background: tab === k ? C.green : "transparent", color: tab === k ? C.bg : C.muted,
      borderBottom: tab === k ? `2px solid ${C.green}` : "2px solid transparent",
    }}>{label}</button>
  );

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${gameEdges.length > 0 ? C.green + "66" : hasL ? C.blue + "33" : C.border}`, overflow: "hidden", marginBottom: 12 }}>
      <div onClick={() => setOpen(o => !o)} style={{ background: C.panel, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: C.white, fontWeight: 800, fontSize: 15 }}>
              {away} <span style={{ color: C.muted, fontWeight: 400 }}>@</span> {home}
            </span>
            {hasL && <span style={sty.badge(C.blue, C.blue)}>{propCount} props</span>}
            {gameEdges.length > 0 && <span style={sty.badge(C.green, C.green)}>{gameEdges.length} edges</span>}
            {!hasL && <span style={sty.badge(C.yellow, C.yellow)}>no props yet</span>}
          </div>
          <div style={{ color: C.muted, fontSize: 10, marginTop: 3 }}>
            {timeStr}
            {pitchers.length > 0 && <span style={{ color: C.dim, marginLeft: 10 }}>SP: {pitchers.map(p => p.name.split(" ").pop()).join(" vs ")}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {pitchers.filter(p => p.projK != null).slice(0, 2).map(p => (
            <div key={p.name} style={{ textAlign: "center", background: C.card, borderRadius: 6, padding: "4px 10px" }}>
              <div style={{ color: C.dim, fontSize: 8 }}>{p.name.split(" ").pop()}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: C.green, ...sty.mono, fontWeight: 700, fontSize: 12 }}>{p.projK}K</span>
                {p.projER != null && <span style={{ color: C.orange, ...sty.mono, fontWeight: 700, fontSize: 12 }}>{p.projER}ER</span>}
              </div>
              {!p._noStats && <div style={{ color: C.green, fontSize: 7 }}>MODEL</div>}
            </div>
          ))}
          <span style={{ color: C.muted, fontSize: 18, fontWeight: 300 }}>{open ? "−" : "+"}</span>
        </div>
      </div>

      {open && hasL && (
        <div style={{ background: C.card, padding: "12px 14px" }}>
          <div style={{ display: "flex", gap: 3, borderBottom: `1px solid ${C.border}`, marginBottom: 14, paddingBottom: 2 }}>
            {pitchers.length > 0 && tabBtn("p", "PITCHERS")}
            {batters.length > 0 && tabBtn("b", "ALL BATTERS")}
          </div>
          {tab === "p" && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {pitchers.map(p => <PitcherCard key={p.name} p={p} />)}
            </div>
          )}
          {tab === "b" && <BatterTable batters={batters} visProps={visProps} setVP={setVP} />}
        </div>
      )}

      {open && !hasL && (
        <div style={{ background: C.card, padding: 24, textAlign: "center", color: C.muted, fontSize: 11 }}>
          Props not posted yet — typically available ~2-3 hrs before first pitch
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [games, setGames] = useState([]);
  const [status, setStatus] = useState("Hit LOAD to pull MLB stats + live odds → model projections + edge detection");
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const g = await loadAll(setStatus);
    setGames(g);
    setUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }, []);

  const withProps = games.filter(g => g.propCount > 0).length;
  const totalProps = games.reduce((s, g) => s + g.propCount, 0);
  const totalEdges = games.reduce((s, g) => {
    let e = 0;
    for (const p of g.pitchers) for (const d of Object.values(p.edges || {})) if (d.edge?.edge > 2 && d.edge?.ev > 0) e++;
    for (const b of g.batters) for (const d of Object.values(b.edges || {})) if (d.edge?.edge > 2 && d.edge?.ev > 0) e++;
    return s + e;
  }, 0);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Inter', 'Segoe UI', sans-serif", color: C.white, padding: 16, maxWidth: 1400, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <div style={{ background: C.green, color: C.bg, fontWeight: 900, fontSize: 11, padding: "3px 10px", borderRadius: 4 }}>MLB</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: -0.5 }}>PROP ENGINE</h1>
            <span style={{ color: C.dim, fontSize: 9, fontWeight: 600 }}>v2 — MODEL + MARKET</span>
          </div>
          <div style={{ color: C.muted, fontSize: 10 }}>
            Independent projections (MLB Stats + park factors + pitcher matchup + platoon) vs. live market odds
            {updated && <span style={{ color: C.green }}> · Updated {updated}</span>}
          </div>
          <div style={{ color: status.includes("Error") ? C.red : status.includes("Done") ? C.green : C.dim, fontSize: 9, marginTop: 2 }}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{
          background: loading ? C.muted : `linear-gradient(135deg, ${C.green}, ${C.teal})`,
          color: C.bg, border: "none", borderRadius: 8, padding: "12px 28px",
          fontWeight: 900, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", fontFamily: "monospace",
        }}>
          {loading ? "LOADING..." : "LOAD GAMES"}
        </button>
      </div>

      {/* Summary bar */}
      {games.length > 0 && (
        <div style={{ background: C.panel, borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: `1px solid ${C.green}33`, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11 }}>
          <div><span style={{ color: C.muted }}>Games </span><span style={{ color: C.white, fontWeight: 700 }}>{games.length}</span></div>
          <div><span style={{ color: C.muted }}>With props </span><span style={{ color: C.blue, fontWeight: 700 }}>{withProps}</span></div>
          <div><span style={{ color: C.muted }}>Props </span><span style={{ color: C.blue, fontWeight: 700 }}>{totalProps}</span></div>
          <div><span style={{ color: C.muted }}>Model edges </span><span style={{ color: C.green, fontWeight: 700 }}>{totalEdges}</span></div>
        </div>
      )}

      {/* Top Picks */}
      {games.length > 0 && <TopPicks games={games} />}

      {/* High-K Pitchers */}
      {games.length > 0 && (() => {
        const pWatch = games.flatMap(g => g.pitchers)
          .filter(p => p.projK != null && p.projK >= 5.0)
          .sort((a, b) => b.projK - a.projK);
        return pWatch.length > 0 ? (
          <div style={{ background: C.panel, borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: `1px solid ${C.green}33` }}>
            <div style={{ color: C.green, fontSize: 10, fontWeight: 700, marginBottom: 8 }}>HIGH-K PITCHERS (proj 5.0+)</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {pWatch.slice(0, 14).map(p => (
                <div key={p.name} style={{ background: C.card, borderRadius: 8, padding: "8px 12px", border: `1px solid ${C.green}44`, minWidth: 130 }}>
                  <div style={{ color: C.green, fontWeight: 700, fontSize: 11, textTransform: "capitalize" }}>{p.name}</div>
                  <div style={{ color: C.muted, fontSize: 8 }}>{p.hand}HP · {p.era} ERA</div>
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    <div><div style={{ color: C.muted, fontSize: 7 }}>PROJ K</div><div style={{ color: C.green, ...sty.mono, fontWeight: 700, fontSize: 13 }}>{p.projK}</div></div>
                    <div><div style={{ color: C.muted, fontSize: 7 }}>K/9</div><div style={{ color: C.blue, ...sty.mono, fontWeight: 700, fontSize: 13 }}>{p.kPer9}</div></div>
                    {p.edges?.K?.live && <div><div style={{ color: C.muted, fontSize: 7 }}>LINE</div><div style={{ color: C.blue, ...sty.mono, fontWeight: 700, fontSize: 13 }}>{p.edges.K.live.pt}</div></div>}
                  </div>
                  {!p._noStats && <div style={{ color: C.green, fontSize: 7, marginTop: 3 }}>MODEL PROJECTION</div>}
                </div>
              ))}
            </div>
          </div>
        ) : null;
      })()}

      {/* Game Cards */}
      {games.map(g => <GameCard key={g.id} game={g} />)}

      {games.length === 0 && !loading && (
        <div style={{ textAlign: "center", padding: 80, color: C.muted }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>&#9918;</div>
          <div style={{ fontSize: 15, color: C.dim, marginBottom: 8 }}>Hit LOAD to pull every MLB game</div>
          <div style={{ fontSize: 11, color: C.muted, maxWidth: 500, margin: "0 auto" }}>
            Fetches real player stats from MLB, live odds from 6+ books, then runs independent projections
            with pitcher matchup analysis, park factors, and platoon adjustments to find +EV plays.
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, color: C.muted, fontSize: 8, textAlign: "center" }}>
        MLB Prop Engine v2 — Model: pitcher suppression + park factors + platoon + binomial/Poisson probability vs. devigged market odds — Kelly criterion sizing
      </div>
    </div>
  );
}
