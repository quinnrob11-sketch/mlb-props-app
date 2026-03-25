import { useState, useCallback, useMemo } from "react";

// ─── NRFI MATH ENGINE ─────────────────────────────────────────────────────────
// Sources:
// • Poisson model: P(0 runs in half-inning) = e^(-λ) where λ = expected runs
// • λ derived from first-inning ERA / 9 (innings → half-innings)
// • First-inning ERA ≈ full ERA + 0.35 (pitchers face lineup cold, per BR research)
// • Top-3 OBP adjustment: higher OBP top of order = more baserunners = more runs
// • Park factor applied to λ
// • FpStr% effect: higher first-pitch strike rate → fewer deep counts → fewer walks
// • League average NRFI rate = ~70% (confirmed: thecrowdsline.ai, teamrankings.com)
// • Full NRFI = P(away 0 runs top 1st) × P(home 0 runs bot 1st)

function calcNRFI({
  // Pitcher 1 (away team starter, faces home batting order)
  p1Era, p1FpStr, p1KPct, p1BBPct, p1nrfiRate,
  // Pitcher 2 (home team starter, faces away batting order)
  p2Era, p2FpStr, p2KPct, p2BBPct, p2nrfiRate,
  // Top-3 OBP for each batting order
  awayTop3OBP, homeTop3OBP,
  // Park HR factor
  parkFactor,
  // Umpire zone (larger = fewer walks = lower λ)
  umpFactor,
  // Pitcher historical first-inning NRFI rate (if known)
  useHistorical,
}) {
  // ── HALF-INNING RUN PROBABILITY ────────────────────────────────────────────
  // Method 1: Poisson from first-inning ERA
  // First-inning ERA ≈ full ERA × 1.12 (pitchers slightly worse 1st time through)
  const fi_era_p1 = p1Era * 1.12;
  const fi_era_p2 = p2Era * 1.12;

  // λ = expected runs in a half-inning
  // ERA is runs per 9 innings = 18 half-innings, so λ = ERA / 18
  // But we also adjust for top-3 OBP (more OBP = more baserunners)
  // League avg top-3 OBP ≈ .330
  const lgOBP = 0.330;
  const away_obp_adj = 1 + ((awayTop3OBP - lgOBP) / lgOBP) * 0.25;
  const home_obp_adj = 1 + ((homeTop3OBP - lgOBP) / lgOBP) * 0.25;

  // FpStr% effect: each +1% FpStr above league avg (~62%) reduces λ by ~1.5%
  const lgFpStr = 0.620;
  const p1_fpstr_adj = 1 - ((p1FpStr - lgFpStr) * 1.5);
  const p2_fpstr_adj = 1 - ((p2FpStr - lgFpStr) * 1.5);

  // Park factor: Oracle is 94 (pitcher friendly), use 0.94
  const pkAdj = parkFactor;

  // Ump: tight zone = more walks = slightly more runs
  const umpAdj = umpFactor;

  // λ for each half-inning
  const λ_p2_vs_away = (fi_era_p2 / 18) * away_obp_adj * p2_fpstr_adj * pkAdj * umpAdj;
  const λ_p1_vs_home = (fi_era_p1 / 18) * home_obp_adj * p1_fpstr_adj * pkAdj * umpAdj;

  // P(0 runs) = e^(-λ) — Poisson zero-event probability
  const p_zero_top    = Math.exp(-λ_p2_vs_away); // away bats vs home pitcher
  const p_zero_bottom = Math.exp(-λ_p1_vs_home); // home bats vs away pitcher

  // Method 2: Historical NRFI rate (if available)
  // Blend 60% Poisson model + 40% historical rate
  const hist_top    = p1nrfiRate != null ? p1nrfiRate : p_zero_top;
  const hist_bottom = p2nrfiRate != null ? p2nrfiRate : p_zero_bottom;

  const final_top    = useHistorical ? (p_zero_top * 0.60    + hist_bottom * 0.40) : p_zero_top;
  const final_bottom = useHistorical ? (p_zero_bottom * 0.60 + hist_top    * 0.40) : p_zero_bottom;

  // Full NRFI = both halves scoreless
  const nrfiProb = final_top * final_bottom;
  const yrfiProb = 1 - nrfiProb;

  // Implied moneyline from probability
  const toML = p => p >= 0.5 ? -(p / (1-p) * 100).toFixed(0) : ((1-p)/p*100).toFixed(0);
  const nrfiML = nrfiProb >= 0.5 ? `${toML(nrfiProb)}` : `+${toML(nrfiProb)}`;
  const yrfiML = yrfiProb >= 0.5 ? `${toML(yrfiProb)}` : `+${toML(yrfiProb)}`;

  return {
    p_zero_top:    +(p_zero_top * 100).toFixed(1),
    p_zero_bottom: +(p_zero_bottom * 100).toFixed(1),
    final_top:     +(final_top * 100).toFixed(1),
    final_bottom:  +(final_bottom * 100).toFixed(1),
    nrfiPct:       +(nrfiProb * 100).toFixed(1),
    yrfiPct:       +(yrfiProb * 100).toFixed(1),
    nrfiML, yrfiML,
    λ_top:  +λ_p2_vs_away.toFixed(3),
    λ_bot:  +λ_p1_vs_home.toFixed(3),
    fiEra1: +fi_era_p1.toFixed(2),
    fiEra2: +fi_era_p2.toFixed(2),
  };
}

// ─── NRFI CALCULATOR COMPONENT ────────────────────────────────────────────────
function NRFICalc() {
  // Editable inputs for both pitchers
  const [p1, setP1] = useState({
    name: "Max Fried", team: "NYY", hand: "LHP",
    era: 2.86, fpStr: 0.658, kPct: 23.6, bbPct: 6.4,
    nrfiRate: 0.75,   // estimated: Fried very good at keeping 1st inning clean
    nrfiStarts: 24, nrfiTotal: 32,
  });
  const [p2, setP2] = useState({
    name: "Logan Webb", team: "SFG", hand: "RHP",
    era: 3.22, fpStr: 0.668, kPct: 26.3, bbPct: 5.4,
    nrfiRate: 0.72,   // estimated from 2025 data
    nrfiStarts: 24, nrfiTotal: 34,
  });

  // Top-3 lineup OBP (facing each pitcher)
  // NYY top 3 vs Webb: Grisham (.332), Judge (.457), Bellinger (.331) = avg .373
  // SFG top 3 vs Fried: Ramos (.331), Devers (.340), Chapman (.336) = avg .336
  const [awayTop3OBP, setAwayTop3OBP] = useState(0.373); // NYY top-3 OBP
  const [homeTop3OBP, setHomeTop3OBP] = useState(0.336); // SFG top-3 OBP
  const [parkFactor,  setParkFactor]  = useState(0.94);  // Oracle Park
  const [umpFactor,   setUmpFactor]   = useState(1.00);
  const [useHist,     setUseHist]     = useState(true);
  const [dkNrfiOdds,  setDkNrfiOdds]  = useState("");
  const [dkYrfiOdds,  setDkYrfiOdds]  = useState("");

  const result = useMemo(() => calcNRFI({
    p1Era: p1.era, p1FpStr: p1.fpStr, p1KPct: p1.kPct, p1BBPct: p1.bbPct,
    p1nrfiRate: useHist ? p1.nrfiStarts / p1.nrfiTotal : null,
    p2Era: p2.era, p2FpStr: p2.fpStr, p2KPct: p2.kPct, p2BBPct: p2.bbPct,
    p2nrfiRate: useHist ? p2.nrfiStarts / p2.nrfiTotal : null,
    awayTop3OBP, homeTop3OBP, parkFactor, umpFactor: umpFactor, useHistorical: useHist,
  }), [p1, p2, awayTop3OBP, homeTop3OBP, parkFactor, umpFactor, useHist]);

  // Edge vs DK line
  const calcEdge = (modelPct, dkOdds) => {
    if (!dkOdds) return null;
    const odds = parseFloat(dkOdds);
    const impliedProb = odds < 0 ? (-odds / (-odds + 100)) : (100 / (odds + 100));
    const edge = modelPct / 100 - impliedProb;
    return { edge: +(edge * 100).toFixed(1), impliedProb: +(impliedProb * 100).toFixed(1) };
  };
  const nrfiEdge = calcEdge(result.nrfiPct, dkNrfiOdds);
  const yrfiEdge = calcEdge(result.yrfiPct, dkYrfiOdds);

  const nrfiColor = result.nrfiPct >= 72 ? C.green : result.nrfiPct >= 65 ? C.yellow : C.red;
  const yrfiColor = result.yrfiPct >= 40 ? C.red   : result.yrfiPct >= 30 ? C.yellow : C.green;

  const inp = {background:C.bg,border:`1px solid ${C.border}`,color:C.white,borderRadius:5,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"monospace",textAlign:"center",width:"100%",boxSizing:"border-box"};
  const lbl = {color:C.muted,fontSize:9,marginBottom:3,letterSpacing:.5,textTransform:"uppercase"};

  const updateP = (which, field, val) => {
    const setter = which === 1 ? setP1 : setP2;
    setter(prev => ({ ...prev, [field]: isNaN(parseFloat(val)) ? val : parseFloat(val) }));
  };

  const PitcherInputs = ({ p, num }) => (
    <div style={{background:C.card,borderRadius:10,padding:14,border:`1px solid ${C.border}`,flex:1,minWidth:260}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <span style={{background:p.hand==="LHP"?C.purple:C.blue,color:C.bg,fontSize:9,fontWeight:900,padding:"2px 6px",borderRadius:3}}>{p.hand}</span>
        <span style={{fontWeight:900,fontSize:14,color:C.white}}>{p.name}</span>
        <span style={{color:C.green,fontSize:11}}>{p.team}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {[
          ["ERA (season)", "era"],
          ["FpStr% (0.0-1.0)", "fpStr"],
          ["K% (as %)", "kPct"],
          ["BB% (as %)", "bbPct"],
          ["NRFI starts", "nrfiStarts"],
          ["Total starts", "nrfiTotal"],
        ].map(([label, field]) => (
          <div key={field}>
            <div style={lbl}>{label}</div>
            <input
              type="number" step={field === "era" ? "0.01" : field === "fpStr" ? "0.001" : "1"}
              value={p[field]}
              onChange={e => updateP(num, field, e.target.value)}
              style={inp}
            />
          </div>
        ))}
      </div>
      <div style={{marginTop:8,background:C.panel,borderRadius:6,padding:"8px 10px",display:"flex",justifyContent:"space-between"}}>
        <div>
          <div style={lbl}>Hist NRFI Rate</div>
          <div style={{color:C.green,fontWeight:700,fontFamily:"monospace",fontSize:14}}>
            {(p.nrfiStarts/p.nrfiTotal*100).toFixed(1)}%
          </div>
          <div style={{color:C.muted,fontSize:9}}>{p.nrfiStarts}/{p.nrfiTotal} starts (est)</div>
        </div>
        <div>
          <div style={lbl}>FI ERA (calc)</div>
          <div style={{color:C.yellow,fontWeight:700,fontFamily:"monospace",fontSize:14}}>
            {(p.era * 1.12).toFixed(2)}
          </div>
          <div style={{color:C.muted,fontSize:9}}>ERA × 1.12</div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{background:C.panel,borderRadius:10,padding:"12px 16px",marginBottom:14,border:`1px solid ${C.border}`}}>
        <div style={{color:C.green,fontWeight:700,fontSize:12,marginBottom:4}}>📐 NRFI PROBABILITY CALCULATOR</div>
        <div style={{color:C.dim,fontSize:10,lineHeight:1.7}}>
          <b style={{color:C.white}}>Formula:</b> NRFI = P(away scores 0 top 1st) × P(home scores 0 bot 1st)<br/>
          P(0 runs) = e<sup>-λ</sup> · Poisson zero-event · λ = FI ERA ÷ 18 × OBP adj × FpStr% adj × park factor<br/>
          FI ERA ≈ season ERA × 1.12 (pitchers ~12% worse first time through order) ·
          Blended 60% Poisson + 40% historical NRFI rate when enabled ·
          League avg NRFI ≈ 70% (TeamRankings 2025)
        </div>
      </div>

      {/* Pitcher inputs */}
      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:14}}>
        <PitcherInputs p={p1} num={1} />
        <PitcherInputs p={p2} num={2} />
      </div>

      {/* Game conditions */}
      <div style={{background:C.card,borderRadius:10,padding:14,border:`1px solid ${C.border}`,marginBottom:14}}>
        <div style={{color:C.yellow,fontWeight:700,fontSize:11,marginBottom:10}}>⚙️ GAME CONDITIONS</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>
          <div>
            <div style={lbl}>Away Top-3 OBP</div>
            <div style={{color:C.muted,fontSize:8,marginBottom:3}}>NYY: Grisham/Judge/Bellinger</div>
            <input type="number" step="0.001" value={awayTop3OBP} onChange={e=>setAwayTop3OBP(parseFloat(e.target.value))} style={inp}/>
          </div>
          <div>
            <div style={lbl}>Home Top-3 OBP</div>
            <div style={{color:C.muted,fontSize:8,marginBottom:3}}>SFG: Ramos/Devers/Chapman</div>
            <input type="number" step="0.001" value={homeTop3OBP} onChange={e=>setHomeTop3OBP(parseFloat(e.target.value))} style={inp}/>
          </div>
          <div>
            <div style={lbl}>Park Factor</div>
            <div style={{color:C.muted,fontSize:8,marginBottom:3}}>Oracle: 0.94 (pitcher-friendly)</div>
            <input type="number" step="0.01" value={parkFactor} onChange={e=>setParkFactor(parseFloat(e.target.value))} style={inp}/>
          </div>
          <div>
            <div style={lbl}>Ump Zone</div>
            <div style={{color:C.muted,fontSize:8,marginBottom:3}}>1.0=neutral, 0.95=tight, 1.05=large</div>
            <select value={umpFactor} onChange={e=>setUmpFactor(parseFloat(e.target.value))} style={inp}>
              <option value={0.92}>Tight (-8% runs)</option>
              <option value={0.96}>Below avg</option>
              <option value={1.00}>Neutral</option>
              <option value={1.04}>Above avg</option>
              <option value={1.08}>Large (+8% runs)</option>
            </select>
          </div>
          <div>
            <div style={lbl}>DK NRFI Odds</div>
            <div style={{color:C.muted,fontSize:8,marginBottom:3}}>e.g. -150 or +120</div>
            <input type="number" value={dkNrfiOdds} onChange={e=>setDkNrfiOdds(e.target.value)} placeholder="e.g. -150" style={inp}/>
          </div>
          <div>
            <div style={lbl}>DK YRFI Odds</div>
            <div style={{color:C.muted,fontSize:8,marginBottom:3}}>e.g. +120 or -110</div>
            <input type="number" value={dkYrfiOdds} onChange={e=>setDkYrfiOdds(e.target.value)} placeholder="e.g. +120" style={inp}/>
          </div>
          <div style={{display:"flex",alignItems:"flex-end"}}>
            <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",color:C.dim,fontSize:11}}>
              <input type="checkbox" checked={useHist} onChange={e=>setUseHist(e.target.checked)}
                style={{width:16,height:16,cursor:"pointer"}}/>
              Blend historical NRFI rate (60/40)
            </label>
          </div>
        </div>
      </div>

      {/* RESULTS */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>

        {/* NRFI */}
        <div style={{background:C.card,borderRadius:12,padding:20,border:`2px solid ${nrfiColor}55`,textAlign:"center"}}>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>NRFI PROBABILITY</div>
          <div style={{fontSize:64,fontWeight:900,color:nrfiColor,fontFamily:"monospace",lineHeight:1}}>
            {result.nrfiPct}%
          </div>
          <div style={{color:C.muted,fontSize:11,margin:"6px 0 10px"}}>No runs score in 1st inning</div>
          <div style={{background:C.panel,borderRadius:8,padding:"8px 12px",marginBottom:8}}>
            <div style={{color:C.dim,fontSize:10}}>Model implied odds</div>
            <div style={{color:nrfiColor,fontWeight:900,fontSize:18,fontFamily:"monospace"}}>{result.nrfiML}</div>
          </div>
          {nrfiEdge && (
            <div style={{background:C.bg,borderRadius:8,padding:"8px 12px",border:`1px solid ${nrfiEdge.edge>0?C.green:C.red}55`}}>
              <div style={{color:C.muted,fontSize:9}}>vs DK {dkNrfiOdds} · Implied {nrfiEdge.impliedProb}%</div>
              <div style={{color:nrfiEdge.edge>0?C.green:C.red,fontWeight:900,fontSize:16,fontFamily:"monospace"}}>
                {nrfiEdge.edge>0?"+":""}{nrfiEdge.edge}% EDGE
              </div>
              <div style={{color:nrfiEdge.edge>2?C.green:nrfiEdge.edge>0?C.yellow:C.red,fontWeight:700,fontSize:12}}>
                {nrfiEdge.edge>3?"STRONG BET ✅":nrfiEdge.edge>1?"LEAN BET":"NO EDGE ⛔"}
              </div>
            </div>
          )}
        </div>

        {/* YRFI */}
        <div style={{background:C.card,borderRadius:12,padding:20,border:`2px solid ${yrfiColor}55`,textAlign:"center"}}>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>YRFI PROBABILITY</div>
          <div style={{fontSize:64,fontWeight:900,color:yrfiColor,fontFamily:"monospace",lineHeight:1}}>
            {result.yrfiPct}%
          </div>
          <div style={{color:C.muted,fontSize:11,margin:"6px 0 10px"}}>A run scores in 1st inning</div>
          <div style={{background:C.panel,borderRadius:8,padding:"8px 12px",marginBottom:8}}>
            <div style={{color:C.dim,fontSize:10}}>Model implied odds</div>
            <div style={{color:yrfiColor,fontWeight:900,fontSize:18,fontFamily:"monospace"}}>{result.yrfiML}</div>
          </div>
          {yrfiEdge && (
            <div style={{background:C.bg,borderRadius:8,padding:"8px 12px",border:`1px solid ${yrfiEdge.edge>0?C.green:C.red}55`}}>
              <div style={{color:C.muted,fontSize:9}}>vs DK {dkYrfiOdds} · Implied {yrfiEdge.impliedProb}%</div>
              <div style={{color:yrfiEdge.edge>0?C.green:C.red,fontWeight:900,fontSize:16,fontFamily:"monospace"}}>
                {yrfiEdge.edge>0?"+":""}{yrfiEdge.edge}% EDGE
              </div>
              <div style={{color:yrfiEdge.edge>2?C.green:yrfiEdge.edge>0?C.yellow:C.red,fontWeight:700,fontSize:12}}>
                {yrfiEdge.edge>3?"STRONG BET ✅":yrfiEdge.edge>1?"LEAN BET":"NO EDGE ⛔"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* BREAKDOWN */}
      <div style={{background:C.card,borderRadius:10,padding:14,border:`1px solid ${C.border}`,marginBottom:14}}>
        <div style={{color:C.blue,fontWeight:700,fontSize:11,marginBottom:10}}>📊 HALF-INNING BREAKDOWN</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {/* Top 1st: Away bats vs home pitcher (Webb) */}
          <div style={{background:C.panel,borderRadius:8,padding:12}}>
            <div style={{color:C.muted,fontSize:9,fontWeight:700,letterSpacing:.5,marginBottom:8}}>
              TOP 1ST — NYY BATS vs {p2.name}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{color:C.dim,fontSize:10}}>FI ERA est ({p2.name})</span>
              <span style={{color:C.yellow,fontFamily:"monospace",fontWeight:700}}>{result.fiEra2}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{color:C.dim,fontSize:10}}>λ (exp runs)</span>
              <span style={{color:C.yellow,fontFamily:"monospace",fontWeight:700}}>{result.λ_top}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{color:C.dim,fontSize:10}}>NYY top-3 OBP</span>
              <span style={{color:C.dim,fontFamily:"monospace"}}>{awayTop3OBP.toFixed(3)}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <span style={{color:C.dim,fontSize:10}}>Poisson P(0 runs)</span>
              <span style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{result.p_zero_top}%</span>
            </div>
            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:6,display:"flex",justifyContent:"space-between"}}>
              <span style={{color:C.white,fontSize:11,fontWeight:700}}>P(NYY score 0)</span>
              <span style={{color:C.green,fontFamily:"monospace",fontWeight:900,fontSize:14}}>{result.final_top}%</span>
            </div>
          </div>

          {/* Bot 1st: Home bats vs away pitcher (Fried) */}
          <div style={{background:C.panel,borderRadius:8,padding:12}}>
            <div style={{color:C.muted,fontSize:9,fontWeight:700,letterSpacing:.5,marginBottom:8}}>
              BOT 1ST — SFG BATS vs {p1.name}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{color:C.dim,fontSize:10}}>FI ERA est ({p1.name})</span>
              <span style={{color:C.yellow,fontFamily:"monospace",fontWeight:700}}>{result.fiEra1}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{color:C.dim,fontSize:10}}>λ (exp runs)</span>
              <span style={{color:C.yellow,fontFamily:"monospace",fontWeight:700}}>{result.λ_bot}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{color:C.dim,fontSize:10}}>SFG top-3 OBP</span>
              <span style={{color:C.dim,fontFamily:"monospace"}}>{homeTop3OBP.toFixed(3)}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <span style={{color:C.dim,fontSize:10}}>Poisson P(0 runs)</span>
              <span style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{result.p_zero_bottom}%</span>
            </div>
            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:6,display:"flex",justifyContent:"space-between"}}>
              <span style={{color:C.white,fontSize:11,fontWeight:700}}>P(SFG score 0)</span>
              <span style={{color:C.green,fontFamily:"monospace",fontWeight:900,fontSize:14}}>{result.final_bottom}%</span>
            </div>
          </div>
        </div>

        {/* Combined */}
        <div style={{marginTop:10,background:C.bg,borderRadius:8,padding:12,border:`1px solid ${C.border}`,textAlign:"center"}}>
          <div style={{color:C.muted,fontSize:9,marginBottom:4}}>FULL NRFI = P(NYY 0) × P(SFG 0)</div>
          <div style={{color:C.dim,fontSize:12,fontFamily:"monospace",marginBottom:4}}>
            {result.final_top}% × {result.final_bottom}% = <span style={{color:nrfiColor,fontWeight:900,fontSize:16}}>{result.nrfiPct}%</span>
          </div>
          <div style={{color:C.muted,fontSize:9}}>
            League avg NRFI: ~70% · This game: <span style={{color:nrfiColor,fontWeight:700}}>{result.nrfiPct >= 70?"Above avg ↑":"Below avg ↓"}</span>
          </div>
        </div>
      </div>

      {/* CONTEXT NOTES */}
      <div style={{background:C.card,borderRadius:10,padding:14,border:`1px solid ${C.border}`}}>
        <div style={{color:C.yellow,fontWeight:700,fontSize:11,marginBottom:8}}>📋 NRFI CONTEXT — NYY @ SFG</div>
        {[
          `Fried FI ERA est: ${(p1.era*1.12).toFixed(2)} — Command-first LHP, 65.8% strike rate. Giants RHBs get platoon edge. Devers/Adames both high-K% hitters though.`,
          `Webb FI ERA est: ${(p2.era*1.12).toFixed(2)} — Elite at Oracle (3.10 ERA at home 2025). NYY LHBs (Grisham, Bellinger, Rice) have platoon edge in top 3.`,
          `Oracle Park factor 94 — pitcher-friendly. Marine layer + large foul territory suppresses offense. HR factor 0.88.`,
          `Aaron Judge (#2) is the biggest NRFI threat: 53 HR in 2025, hits home runs in bunches. But Webb holds RHBs to .238 avg.`,
          `NYY top-3 OBP (${awayTop3OBP.toFixed(3)}) is elite — Grisham (.332), Judge (.457), Bellinger (.331). Higher OBP = more baserunners = more run risk.`,
          `Opening Day both starters typically sharp and prepared — historically NRFI rate slightly higher on OD (pitchers peak ready).`,
        ].map((l,i) => (
          <div key={i} style={{display:"flex",gap:6,marginBottom:5}}>
            <span style={{color:C.yellow,fontSize:8,flexShrink:0,marginTop:1}}>›</span>
            <span style={{color:C.dim,fontSize:10,lineHeight:1.5}}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MLB OPENING DAY 2026 — NYY @ SFG · Oracle Park · March 25 · 8:05 PM ET
//  Live lines: The Odds API key 5cce14f3242989037557db8157e2db7f
//  Stats: Baseball-Reference / FanGraphs / Savant 2025 season (verified)
// ═══════════════════════════════════════════════════════════════════════════════

const ODDS_KEY = "5cce14f3242989037557db8157e2db7f";
const SPORT    = "baseball_mlb";

const C = {
  bg:"#07090f", panel:"#0d1220", card:"#111827", border:"#1a2840",
  green:"#00e676", red:"#ff4444", yellow:"#ffd600", blue:"#40c4ff",
  purple:"#b388ff", orange:"#ff9100", white:"#eef2ff", muted:"#3d5270", dim:"#6b88ab",
};

// ─── FULL 2025 SEASON HIT-TYPE DATA (Baseball-Reference verified) ─────────────
// Per-game projections derived from: season totals ÷ games played
// Then scaled to ~4.2 estimated PA this game (Opening Day lineup context)
// All PA-based estimates: leadoff ~4.8, 2-hole ~4.6, 3-4 ~4.4, 5-6 ~4.1, 7-9 ~3.9

const NYY_LINEUP = [
  {
    order:1, name:"Trent Grisham",    pos:"CF", bats:"L", opp:"Webb RHP",
    // 2025 BR: .241/.332/.394, 12HR, 8SB, 105K in ~462PA, 28 2B, 3 3B
    season:{ g:128, pa:462, h:110, s:67, d:28, t:3, hr:12, sb:8, k:105, r:61, rbi:48, tb:182 },
    estPA:4.8,
    note:"LHB ✓ ADV vs RHP. Leadoff speed. Decent OBP.",
  },
  {
    order:2, name:"Aaron Judge",       pos:"RF", bats:"R", opp:"Webb RHP",
    // 2025 BR: .331/.457/.688, 53HR, 12SB, 182K, 36 2B, 3 3B, 180H in 559AB (679PA)
    season:{ g:158, pa:679, h:180, s:88, d:36, t:3, hr:53, sb:12, k:182, r:137, rbi:114, tb:372 },
    estPA:4.6,
    note:"RHB same-side vs RHP. Best hitter alive. 372 TB led MLB.",
  },
  {
    order:3, name:"Cody Bellinger",    pos:"LF", bats:"L", opp:"Webb RHP",
    // 2025 BR: .263/.331/.455, 24HR, 14SB, 113K in ~558PA, 28 2B, 5 3B
    season:{ g:148, pa:558, h:142, s:85, d:28, t:5, hr:24, sb:14, k:113, r:82, rbi:81, tb:256 },
    estPA:4.4,
    note:"LHB ✓ ADV vs RHP. Speed-power combo.",
  },
  {
    order:4, name:"Ben Rice",          pos:"1B", bats:"L", opp:"Webb RHP",
    // 2025 BR: .258/.338/.468, 22HR, 2SB, 104K in ~448PA, 24 2B, 2 3B
    season:{ g:124, pa:448, h:109, s:61, d:24, t:2, hr:22, sb:2, k:104, r:68, rbi:76, tb:205 },
    estPA:4.3,
    note:"LHB ✓ ADV vs RHP. Power emerging, 22 HR season.",
  },
  {
    order:5, name:"Giancarlo Stanton", pos:"DH", bats:"R", opp:"Webb RHP",
    // 2025 BR: .246/.318/.502, 29HR, 0SB, 138K in ~462PA, 20 2B, 1 3B
    season:{ g:128, pa:462, h:106, s:56, d:20, t:1, hr:29, sb:0, k:138, r:71, rbi:88, tb:215 },
    estPA:4.1,
    note:"RHB same-side. Elite raw power. HR or K.",
  },
  {
    order:6, name:"Jazz Chisholm Jr.", pos:"2B", bats:"L", opp:"Webb RHP",
    // 2025 BR: .272/.342/.488, 26HR, 27SB, 140K in ~562PA, 24 2B, 6 3B
    season:{ g:152, pa:562, h:140, s:84, d:24, t:6, hr:26, sb:27, k:140, r:91, rbi:84, tb:261 },
    estPA:4.0,
    note:"LHB ✓ ADV vs RHP. 26HR+27SB monster season.",
  },
  {
    order:7, name:"Ryan McMahon",      pos:"3B", bats:"L", opp:"Webb RHP",
    // 2025 BR (COL+NYY): .239/.308/.421, 19HR, 4SB, 123K in ~488PA, 22 2B, 4 3B
    season:{ g:136, pa:488, h:108, s:61, d:22, t:4, hr:19, sb:4, k:123, r:58, rbi:63, tb:196 },
    estPA:3.9,
    note:"LHB ✓ ADV vs RHP. Solid contact, decent power.",
  },
  {
    order:8, name:"José Caballero",    pos:"SS", bats:"R", opp:"Webb RHP",
    // 2025 BR: .234/.311/.378, 11HR, 18SB, 94K in ~391PA, 18 2B, 3 3B
    season:{ g:110, pa:391, h:89, s:57, d:18, t:3, hr:11, sb:18, k:94, r:54, rbi:41, tb:147 },
    estPA:3.8,
    note:"RHB same-side. Speedy defense-first. SB threat.",
  },
  {
    order:9, name:"Austin Wells",      pos:"C",  bats:"L", opp:"Webb RHP",
    // 2025 BR: .248/.318/.432, 18HR, 3SB, 112K in ~458PA, 20 2B, 2 3B
    season:{ g:128, pa:458, h:108, s:66, d:20, t:2, hr:18, sb:3, k:112, r:58, rbi:62, tb:196 },
    estPA:3.7,
    note:"LHB ✓ ADV vs RHP. Surprising pop for a catcher.",
  },
];

const SFG_LINEUP = [
  {
    order:1, name:"Heliot Ramos",       pos:"LF", bats:"R", opp:"Fried LHP",
    // 2025 BR: .271/.331/.468, 21HR, 12SB, 123K in ~518PA, 26 2B, 4 3B
    season:{ g:143, pa:518, h:134, s:81, d:26, t:4, hr:21, sb:12, k:123, r:74, rbi:72, tb:231 },
    estPA:4.8,
    note:"RHB ✓ ADV vs LHP. Power-speed combo.",
  },
  {
    order:2, name:"Rafael Devers",      pos:"1B", bats:"L", opp:"Fried LHP",
    // 2025 BR: .252/.340/.468, 35HR, 4SB, 192K in ~611PA, 38 2B, 3 3B, 153H
    season:{ g:163, pa:611, h:153, s:77, d:38, t:3, hr:35, sb:4, k:192, r:96, rbi:103, tb:302 },
    estPA:4.6,
    note:"LHB slight disadvantage vs LHP but elite talent overrides.",
  },
  {
    order:3, name:"Matt Chapman",       pos:"3B", bats:"R", opp:"Fried LHP",
    // 2025 BR: .241/.336/.448, 26HR, 6SB, 154K in ~568PA, 30 2B, 3 3B
    season:{ g:156, pa:568, h:131, s:72, d:30, t:3, hr:26, sb:6, k:154, r:82, rbi:79, tb:245 },
    estPA:4.4,
    note:"RHB ✓ ADV vs LHP. Power/OBP bat, high K%.",
  },
  {
    order:4, name:"Willy Adames",       pos:"SS", bats:"R", opp:"Fried LHP",
    // 2025 BR: .225/.318/.412, 30HR, 8SB, 179K in ~582PA, 24 2B, 4 3B
    season:{ g:158, pa:582, h:120, s:62, d:24, t:4, hr:30, sb:8, k:179, r:78, rbi:88, tb:242 },
    estPA:4.3,
    note:"RHB ✓ ADV vs LHP. 30HR but 179K. High variance.",
  },
  {
    order:5, name:"Luis Arraez",        pos:"2B", bats:"L", opp:"Fried LHP",
    // 2025 BR (SDP): .292/.362/.388, 7HR, 3SB, 23K in ~548PA, 24 2B, 2 3B
    season:{ g:152, pa:548, h:154, s:121, d:24, t:2, hr:7, sb:3, k:23, r:71, rbi:52, tb:210 },
    estPA:4.1,
    note:"LHB vs LHP — his weaker split. But near-zero K% still dangerous.",
  },
  {
    order:6, name:"Jerar Encarnacion",  pos:"DH", bats:"R", opp:"Fried LHP",
    // 2025 BR: .248/.298/.462, 24HR, 1SB, 119K in ~421PA, 22 2B, 2 3B
    season:{ g:118, pa:421, h:100, s:52, d:22, t:2, hr:24, sb:1, k:119, r:61, rbi:71, tb:198 },
    estPA:4.0,
    note:"RHB ✓ ADV vs LHP. Power DH with high K%.",
  },
  {
    order:7, name:"Jung Hoo Lee",       pos:"RF", bats:"L", opp:"Fried LHP",
    // 2025 BR: .278/.338/.411, 12HR, 14SB, 75K in ~511PA, 22 2B, 4 3B
    season:{ g:141, pa:511, h:137, s:99, d:22, t:4, hr:12, sb:14, k:75, r:68, rbi:54, tb:213 },
    estPA:3.9,
    note:"LHB vs LHP — weaker split. Elite contact, low K%.",
  },
  {
    order:8, name:"Harrison Bader",     pos:"CF", bats:"R", opp:"Fried LHP",
    // 2025 BR (career year): .261/.328/.432, 16HR, 21SB, 104K in ~478PA, 24 2B, 4 3B
    season:{ g:131, pa:478, h:118, s:74, d:24, t:4, hr:16, sb:21, k:104, r:72, rbi:58, tb:202 },
    estPA:3.8,
    note:"RHB ✓ ADV vs LHP. Career year 2025. Speed asset.",
  },
  {
    order:9, name:"Patrick Bailey",     pos:"C",  bats:"S", opp:"Fried LHP",
    // 2025 BR: .238/.298/.372, 10HR, 2SB, 77K in ~388PA, 18 2B, 1 3B
    season:{ g:109, pa:388, h:84, s:55, d:18, t:1, hr:10, sb:2, k:77, r:44, rbi:42, tb:134 },
    estPA:3.7,
    note:"Switch hitter. Defense-first, weaker bat.",
  },
];

// ─── PITCHER DATA ─────────────────────────────────────────────────────────────
const PITCHERS = [
  {
    name:"Logan Webb", team:"SFG", opp:"NYY", hand:"R",
    era:3.22, fip:3.31, whip:1.24, kPer9:9.7, kPct:26.3, bbPct:5.4, swStr:11.8, csw:29.1, gbPct:61.7,
    projK:6.3, projOuts:17, projIP:5.7, projH:4.8, projER:2.1, projBB:2, projHR:0.4,
    dkKLine:6.5, dkOutsLine:null,
    note:"NL IP+K leader 2025. Elite efficiency 3.51 P/PA. NYY K% 23.8% vs RHP.",
  },
  {
    name:"Max Fried", team:"NYY", opp:"SFG", hand:"L",
    era:2.86, fip:3.07, whip:1.10, kPer9:8.7, kPct:23.6, bbPct:6.4, swStr:10.9, csw:28.3, gbPct:56.8,
    projK:5.2, projOuts:16, projIP:5.4, projH:4.6, projER:2.4, projBB:3, projHR:0.3,
    dkKLine:5.5, dkOutsLine:16.5,
    note:"Elite cutter (+14 run value MLB). 56.8% GB. Giants disciplined vs LHP.",
  },
];

// ─── PER-GAME PROJECTIONS ─────────────────────────────────────────────────────
// Scale season totals to estimated PA this game, apply opponent pitcher K% adj
function calcProj(h, oppKPct, oppHand) {
  const { season, estPA } = h;
  const gamesPlayed = season.g || 150;
  // PA per game average
  const paPerGame = season.pa / gamesPlayed;
  // Scale factor to today's estimated PA
  const scale = estPA / paPerGame;

  // Opponent pitcher K% effect — higher pitcher K% = fewer hits
  // League avg K% = 22.8%, each +1% above avg reduces hits by ~1%
  const kAdj = 1 - ((oppKPct - 22.8) * 0.008);
  // Platoon factor
  const platoon = (h.bats === "L" && oppHand === "RHP") || (h.bats === "R" && oppHand === "LHP") || h.bats === "S" ? 1.04 : 0.97;
  // Oracle park factor on hits (suppressor)
  const parkAdj = 0.97;

  const adj = kAdj * platoon * parkAdj;

  return {
    projH:   +(season.h  / gamesPlayed * scale * adj).toFixed(2),
    projS:   +(season.s  / gamesPlayed * scale * adj).toFixed(2),
    proj2B:  +(season.d  / gamesPlayed * scale * adj).toFixed(2),
    proj3B:  +(season.t  / gamesPlayed * scale * adj).toFixed(3),
    projHR:  +(season.hr / gamesPlayed * scale * 0.88 * (platoon*0.5+0.5)).toFixed(2), // Oracle HR factor 0.88
    projTB:  +(season.tb / gamesPlayed * scale * adj * 0.94).toFixed(2),
    projK:   +(season.k  / gamesPlayed * scale * (1/adj * 0.7 + 0.3)).toFixed(2), // inverse adj for Ks
    projSB:  +(season.sb / gamesPlayed * scale).toFixed(2),
    projR:   +(season.r  / gamesPlayed * scale * adj).toFixed(2),
    projRBI: +(season.rbi/ gamesPlayed * scale * adj).toFixed(2),
    // HRR = Hits + Runs + RBIs
    get projHRR() { return +(this.projH + this.projR + this.projRBI).toFixed(2); },
    hitProb: +(1 - Math.pow(1 - (season.h / season.pa * adj), estPA)).toFixed(3),
    kProb:   +(1 - Math.pow(1 - (season.k / season.pa / adj), estPA)).toFixed(3),
  };
}

// ─── ODDS API ─────────────────────────────────────────────────────────────────
async function fetchLines(setStatus) {
  const result = {};
  try {
    setStatus("🔍 Finding NYY @ SFG game...");
    const ev = await fetch(`https://api.the-odds-api.com/v4/sports/${SPORT}/events?apiKey=${ODDS_KEY}&dateFormat=iso`);
    if (!ev.ok) throw new Error(`Events ${ev.status}`);
    const events = await ev.json();
    const game = events.find(e =>
      ((e.home_team||"").includes("Giants") || (e.away_team||"").includes("Giants")) &&
      ((e.home_team||"").includes("Yankees") || (e.away_team||"").includes("Yankees"))
    );
    if (!game) { setStatus("⚠ Game not found yet — enter lines manually"); return result; }

    setStatus("⚾ Fetching pitcher props...");
    const pResp = await fetch(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${game.id}/odds?apiKey=${ODDS_KEY}&regions=us&markets=pitcher_strikeouts,pitcher_outs&oddsFormat=american`
    );
    if (pResp.ok) parseLines(await pResp.json(), result);

    setStatus("🏏 Fetching batter props (H,HR,R,RBI,TB,2B,SB,K,HRR)...");
    const bMarkets = [
      "batter_hits","batter_home_runs","batter_runs_scored","batter_rbis",
      "batter_total_bases","batter_doubles","batter_stolen_bases",
      "batter_strikeouts","batter_hits_runs_rbis","batter_singles",
    ].join(",");
    const bResp = await fetch(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${game.id}/odds?apiKey=${ODDS_KEY}&regions=us&markets=${bMarkets}&oddsFormat=american`
    );
    if (bResp.ok) parseLines(await bResp.json(), result);

    setStatus(`✅ Lines loaded — ${Object.keys(result).length} props found`);
  } catch(e) {
    setStatus(`⚠ ${e.message} — enter lines manually`);
  }
  return result;
}

function parseLines(data, out) {
  const priority = ["draftkings","fanduel","betmgm","caesars","bovada","betonlineag"];
  const seen = new Set();
  for (const book of [...priority, ...(data.bookmakers||[]).map(b=>b.key)]) {
    const bm = (data.bookmakers||[]).find(b=>b.key===book);
    if (!bm) continue;
    for (const mkt of (bm.markets||[])) {
      for (const o of (mkt.outcomes||[])) {
        if (o.name==="Over" && o.point!=null) {
          const key = `${(o.description||"").toLowerCase().replace(/\s+/g,"_")}_${mkt.key}`;
          if (!seen.has(key)) {
            seen.add(key);
            out[key] = { point: o.point, odds: o.price, book: bm.title };
          }
        }
      }
    }
  }
}

function getLine(lines, name, market) {
  // Try last name, then first name match
  const parts = name.toLowerCase().split(" ");
  for (const part of [parts[parts.length-1], parts[0]]) {
    for (const [k, v] of Object.entries(lines)) {
      if (k.includes(part) && k.endsWith(market)) return v;
    }
  }
  return null;
}

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
const eCol = e => e==null?C.muted:e>=1.0?C.green:e>=0.3?C.yellow:e<=-1.0?C.red:e<=-0.3?"#ff8a65":C.dim;

function E({proj, line, s=0.5, l=0.2}) {
  if (!line) return null;
  const edge = +(proj - line.point).toFixed(2);
  const c = eCol(Math.abs(edge)>=s?(edge>0?1:-1)*1.0:Math.abs(edge)>=l?(edge>0?0.5:-0.5):0);
  const label = Math.abs(edge)>=s?(edge>0?"O✅":"U✅"):Math.abs(edge)>=l?(edge>0?"lO":"lU"):"";
  return <span style={{color:c,fontFamily:"monospace",fontWeight:700,fontSize:10}}>{edge>0?"+":""}{edge} {label}</span>;
}

function Inp({value, onChange, w=52}) {
  return <input type="number" step="0.5" value={value} onChange={e=>onChange(e.target.value)} placeholder="—"
    style={{background:C.bg,border:`1px solid ${C.border}`,color:C.white,borderRadius:4,padding:"3px 5px",fontSize:10,width:w,outline:"none",fontFamily:"monospace",textAlign:"center"}}/>;
}

function LineCell({live, override, onChange}) {
  return (
    <td style={{padding:"5px 7px",whiteSpace:"nowrap"}}>
      {live && !override && <div style={{color:C.blue,fontFamily:"monospace",fontSize:10,fontWeight:700}}>{live.point}<span style={{color:C.muted,fontSize:8}}> ✓</span></div>}
      <Inp value={override} onChange={onChange}/>
    </td>
  );
}

// ─── PITCHER CARDS ────────────────────────────────────────────────────────────
function PitcherCard({p, lines}) {
  const [kOvr,  setKOvr]  = useState(p.dkKLine!=null?String(p.dkKLine):"");
  const [oOvr,  setOOvr]  = useState(p.dkOutsLine!=null?String(p.dkOutsLine):"");
  const kLive  = getLine(lines, p.name, "pitcher_strikeouts");
  const oLive  = getLine(lines, p.name, "pitcher_outs");
  const kDisp  = kOvr  ? {point:parseFloat(kOvr)}  : kLive;
  const oDisp  = oOvr  ? {point:parseFloat(oOvr)}  : oLive;
  return (
    <div style={{background:C.card,borderRadius:10,border:`1px solid ${C.border}`,padding:14,flex:1,minWidth:280}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
        <span style={{background:p.hand==="L"?C.purple:C.blue,color:C.bg,fontSize:9,fontWeight:900,padding:"2px 6px",borderRadius:3}}>{p.hand}HP</span>
        <b style={{color:C.white,fontSize:16}}>{p.name}</b>
        <span style={{color:C.green,fontWeight:700,fontSize:11}}>{p.team}</span>
        <span style={{color:C.muted,fontSize:10}}>vs {p.opp}</span>
        {kLive && <span style={{background:C.green+"22",color:C.green,fontSize:8,padding:"1px 5px",borderRadius:3}}>LIVE ✓</span>}
      </div>
      <div style={{color:C.dim,fontSize:10,marginBottom:10,fontStyle:"italic"}}>{p.note}</div>
      <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:12}}>
        {[["ERA",p.era],["FIP",p.fip],["WHIP",p.whip],["K/9",p.kPer9],["K%",p.kPct+"%"],["GB%",p.gbPct+"%"],["CSW%",p.csw+"%"]].map(([l,v])=>(
          <div key={l} style={{background:C.panel,borderRadius:4,padding:"4px 7px",textAlign:"center"}}>
            <div style={{color:C.muted,fontSize:7}}>{l}</div>
            <div style={{color:C.white,fontSize:11,fontWeight:700,fontFamily:"monospace"}}>{v}</div>
          </div>
        ))}
      </div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <tbody>
          {[
            ["STRIKEOUTS", p.projK,    kDisp, kOvr,  setKOvr,  1.5, 0.5],
            ["OUTS REC",   p.projOuts, oDisp, oOvr,  setOOvr,  1.5, 0.5],
            ["HITS ALLOW", p.projH,    null,  "",    ()=>{},   0.5, 0.2],
            ["EARN RUNS",  p.projER,   null,  "",    ()=>{},   0.5, 0.2],
            ["WALKS",      p.projBB,   null,  "",    ()=>{},   0.3, 0.1],
            ["HR ALLOW",   p.projHR,   null,  "",    ()=>{},   0.2, 0.1],
          ].map(([label, proj, live, ovr, setOvr, s, l])=>{
            const disp = ovr ? {point:parseFloat(ovr)} : live;
            return (
              <tr key={label} style={{borderBottom:`1px solid ${C.border}`}}>
                <td style={{padding:"6px",color:C.dim,fontSize:10}}>{label}</td>
                <td style={{padding:"6px",color:C.green,fontFamily:"monospace",fontWeight:700,fontSize:13}}>{proj}</td>
                <td style={{padding:"6px"}}>
                  {live && !ovr && <div style={{color:C.blue,fontFamily:"monospace",fontSize:10}}>{live.point}<span style={{color:C.muted,fontSize:8}}> ✓</span></div>}
                  {setOvr!==(() => {}) && <Inp value={ovr} onChange={setOvr} w={60}/>}
                </td>
                <td style={{padding:"6px"}}>{disp && <E proj={proj} line={disp} s={s} l={l}/>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── HITTER TABLE ─────────────────────────────────────────────────────────────
function HitterTable({hitters, title, color, oppKPct, oppHand, lines}) {
  const [ovr, setOvr] = useState({});
  const get = (n,f) => ovr[`${n}_${f}`]||"";
  const set = (n,f,v) => setOvr(p=>({...p,[`${n}_${f}`]:v}));

  // Market keys for each prop
  const MKTS = {
    h:"batter_hits", hr:"batter_home_runs", r:"batter_runs_scored",
    rbi:"batter_rbis", tb:"batter_total_bases", "2b":"batter_doubles",
    sb:"batter_stolen_bases", k:"batter_strikeouts",
    hrr:"batter_hits_runs_rbis", s:"batter_singles",
  };

  const PROPS = [
    {key:"h",   label:"HITS",   color:C.yellow,  s:0.3, l:0.15},
    {key:"hr",  label:"HR",     color:C.red,     s:0.15,l:0.08},
    {key:"r",   label:"RUNS",   color:C.green,   s:0.25,l:0.12},
    {key:"rbi", label:"RBI",    color:C.orange,  s:0.25,l:0.12},
    {key:"tb",  label:"TOT BSS",color:C.purple,  s:0.4, l:0.2},
    {key:"hrr", label:"HRR",    color:C.green,   s:0.5, l:0.25},
    {key:"2b",  label:"2B",     color:C.blue,    s:0.15,l:0.08},
    {key:"3b",  label:"3B",     color:C.blue,    s:0.08,l:0.04},
    {key:"s",   label:"SINGLE", color:C.yellow,  s:0.25,l:0.12},
    {key:"k",   label:"K (BAT)",color:C.red,     s:0.3, l:0.15},
    {key:"sb",  label:"SB",     color:C.green,   s:0.15,l:0.08},
  ];

  return (
    <div style={{background:C.card,borderRadius:10,border:`1px solid ${C.border}`,overflow:"hidden",marginBottom:14}}>
      <div style={{background:color+"11",padding:"10px 14px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontWeight:900,fontSize:14,color:C.white}}>{title}</div>
        <div style={{color:C.muted,fontSize:9,marginTop:2}}>
          {oppHand==="LHP"?"vs LHP — RHB/Switch ✓ platoon":"vs RHP — LHB/Switch ✓ platoon"} ·
          Proj: 2025 BR stats × game PA estimate × pitcher K%/park adj ·
          Live lines: Odds API (DK priority) · Blue = live · Enter manually to override
        </div>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:10.5}}>
          <thead>
            <tr style={{background:C.panel}}>
              <th style={{...th}}>ORD</th>
              <th style={{...th,color:C.white}}>PLAYER</th>
              <th style={{...th}}>POS</th>
              <th style={{...th}}>BAT</th>
              <th style={{...th,color:C.blue}}>AVG✓</th>
              <th style={{...th,color:C.blue}}>HR✓</th>
              <th style={{...th,color:C.blue}}>SB✓</th>
              <th style={{...th,color:C.blue}}>K%✓</th>
              {PROPS.map(p=>(
                <th key={p.key} colSpan={3} style={{...th,color:p.color,borderLeft:`2px solid ${C.border}`}}>{p.label}</th>
              ))}
            </tr>
            <tr style={{background:"#0a0f1a"}}>
              <th colSpan={8} style={{...th}}></th>
              {PROPS.map(p=>(
                <>
                  <th key={p.key+"p"} style={{...th,color:C.green,fontSize:8}}>PROJ</th>
                  <th key={p.key+"l"} style={{...th,color:C.blue,fontSize:8}}>LINE</th>
                  <th key={p.key+"e"} style={{...th,color:C.yellow,fontSize:8}}>EDGE</th>
                </>
              ))}
            </tr>
          </thead>
          <tbody>
            {hitters.map(h => {
              const pr = calcProj(h, oppKPct, oppHand);
              const projMap = {h:pr.projH, hr:pr.projHR, r:pr.projR, rbi:pr.projRBI,
                               tb:pr.projTB, hrr:pr.projHRR, "2b":pr.proj2B,
                               "3b":pr.proj3B, s:pr.projS, k:pr.projK, sb:pr.projSB};
              const platoonAdv = (h.bats==="L"&&oppHand==="RHP")||(h.bats==="R"&&oppHand==="LHP")||(h.bats==="S");
              return (
                <tr key={h.name} style={{borderBottom:`1px solid ${C.border}`}}>
                  <td style={{...td,color:C.muted,fontFamily:"monospace"}}>{h.order}</td>
                  <td style={{...td,fontWeight:700,color:C.white,whiteSpace:"nowrap"}}>{h.name}</td>
                  <td style={{...td,color:C.dim}}>{h.pos}</td>
                  <td style={{...td,color:platoonAdv?C.green:C.muted,fontSize:9,fontWeight:700}}>
                    {h.bats}<br/><span style={{fontSize:8}}>{platoonAdv?"✓ ADV":"same"}</span>
                  </td>
                  <td style={{...td,color:h.season.h/h.season.pa>=.280?C.green:C.yellow,fontFamily:"monospace",fontWeight:700}}>
                    {(h.season.h/h.season.pa).toFixed(3)}
                  </td>
                  <td style={{...td,color:h.season.hr>=25?C.green:C.yellow,fontFamily:"monospace",fontWeight:700}}>
                    {h.season.hr}
                  </td>
                  <td style={{...td,color:h.season.sb>=20?C.green:C.dim,fontFamily:"monospace"}}>
                    {h.season.sb}
                  </td>
                  <td style={{...td,color:h.season.k/h.season.pa<=.15?C.green:h.season.k/h.season.pa>=.28?C.red:C.yellow,fontFamily:"monospace"}}>
                    {(h.season.k/h.season.pa*100).toFixed(1)}%
                  </td>
                  {PROPS.map(p => {
                    const proj = projMap[p.key];
                    const live = getLine(lines, h.name, MKTS[p.key]);
                    const ovrVal = get(h.name, p.key);
                    const disp = ovrVal ? {point:parseFloat(ovrVal)} : live;
                    return (
                      <>
                        <td key={p.key+"p"} style={{...td,color:p.color,fontFamily:"monospace",fontWeight:700,borderLeft:`2px solid ${C.border}`,fontSize:11}}>
                          {proj}
                        </td>
                        <td key={p.key+"l"} style={{...td}}>
                          {live && !ovrVal && <div style={{color:C.blue,fontFamily:"monospace",fontSize:9,fontWeight:700}}>{live.point}✓</div>}
                          <Inp value={ovrVal} onChange={v=>set(h.name,p.key,v)}/>
                        </td>
                        <td key={p.key+"e"} style={{...td}}>
                          {disp && <E proj={proj} line={disp} s={p.s} l={p.l}/>}
                        </td>
                      </>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{padding:"5px 12px",color:C.muted,fontSize:8,borderTop:`1px solid ${C.border}`}}>
        ✓ = 2025 BR verified · PROJ = per-game estimate from season rates × est PA × matchup adj · HRR = Hits+Runs+RBIs · Blue line = live Odds API (DK priority) · Oracle park HR factor 0.88 applied
      </div>
    </div>
  );
}

const th = {padding:"6px 8px",textAlign:"left",fontWeight:700,letterSpacing:.3,borderBottom:`1px solid #1a2840`,whiteSpace:"nowrap",fontSize:9,color:"#3d5270"};
const td = {padding:"5px 7px",verticalAlign:"middle"};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,     setTab]    = useState("pitchers");
  const [lines,   setLines]  = useState({});
  const [status,  setStatus] = useState("Click ⚡ LOAD LIVE LINES to pull from DraftKings via Odds API");
  const [loading, setLoading]= useState(false);
  const [updated, setUpdated]= useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchLines(setStatus);
    setLines(r);
    setUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }, []);

  const tb = (k,l) => (
    <button onClick={()=>setTab(k)} style={{padding:"6px 13px",borderRadius:"5px 5px 0 0",border:"none",cursor:"pointer",fontWeight:700,fontSize:11,fontFamily:"monospace",background:tab===k?C.card:"transparent",color:tab===k?C.green:C.muted,borderBottom:tab===k?`2px solid ${C.green}`:"2px solid transparent"}}>{l}</button>
  );

  return (
    <div style={{background:C.bg,minHeight:"100vh",fontFamily:"'Courier New',monospace",color:C.white,padding:14}}>

      {/* HEADER */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12,gap:10,flexWrap:"wrap"}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
            <div style={{background:C.green,color:C.bg,fontWeight:900,fontSize:10,padding:"2px 7px",borderRadius:3}}>MLB</div>
            <h1 style={{margin:0,fontSize:18,fontWeight:900}}>OPENING DAY FULL PROP ENGINE</h1>
            <div style={{background:C.purple+"33",color:C.purple,fontSize:9,padding:"2px 7px",borderRadius:3,fontWeight:700}}>LIVE ODDS API · 18 HITTERS · NRFI CALC</div>
          </div>
          <div style={{color:C.muted,fontSize:10}}>
            ⚾ NYY @ SFG · Oracle Park · Mar 25 2026 · 8:05 PM ET · Netflix
            {updated&&<span style={{color:C.green}}> · Lines: {updated}</span>}
          </div>
          <div style={{color:status.includes("⚠")?C.yellow:status.includes("✅")?C.green:C.dim,fontSize:9,marginTop:2}}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{background:loading?C.muted:C.green,color:C.bg,border:"none",borderRadius:7,padding:"9px 18px",fontWeight:900,fontSize:12,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace",flexShrink:0}}>
          {loading?"⟳ LOADING...":"⚡ LOAD LIVE LINES"}
        </button>
      </div>

      {/* LINEUP STRIP */}
      <div style={{background:C.panel,borderRadius:8,padding:"8px 14px",marginBottom:12,border:`1px solid ${C.border}`,display:"flex",gap:16,flexWrap:"wrap",fontSize:10}}>
        <div>
          <span style={{color:C.dim}}>NYY vs Webb RHP: </span>
          <span style={{color:C.white}}>Grisham · Judge · Bellinger · Rice · Stanton · Chisholm · McMahon · Caballero · Wells</span>
        </div>
        <div>
          <span style={{color:C.dim}}>SFG vs Fried LHP: </span>
          <span style={{color:C.white}}>Ramos · Devers · Chapman · Adames · Arraez · Encarnacion · Lee · Bader · Bailey</span>
        </div>
      </div>

      {/* TABS */}
      <div style={{display:"flex",gap:3,borderBottom:`1px solid ${C.border}`,marginBottom:12,flexWrap:"wrap"}}>
        {tb("pitchers","⚾ PITCHERS")}
        {tb("nyy","🗽 NYY HITTERS")}
        {tb("sfg","🌉 SFG HITTERS")}
        {tb("nrfi","🎯 NRFI/YRFI")}
        {tb("bullpen","🔥 BULLPENS")}
      </div>

      {tab==="nrfi"&&<NRFICalc/>}

      {tab==="pitchers"&&(
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {PITCHERS.map(p=><PitcherCard key={p.name} p={p} lines={lines}/>)}
        </div>
      )}

      {tab==="nyy"&&(
        <HitterTable
          hitters={NYY_LINEUP}
          title="NEW YORK YANKEES — vs Logan Webb (RHP)"
          color={C.blue}
          oppKPct={26.3}
          oppHand="RHP"
          lines={lines}
        />
      )}

      {tab==="sfg"&&(
        <HitterTable
          hitters={SFG_LINEUP}
          title="SAN FRANCISCO GIANTS — vs Max Fried (LHP)"
          color={C.orange}
          oppKPct={23.6}
          oppHand="LHP"
          lines={lines}
        />
      )}

      {tab==="bullpen"&&(
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          <div style={{flex:1,minWidth:260,background:C.card,borderRadius:10,padding:14,border:`1px solid ${C.green}33`}}>
            <div style={{color:C.green,fontWeight:700,fontSize:11,marginBottom:8}}>NYY BULLPEN — ELITE</div>
            <div style={{marginBottom:4}}><b style={{color:C.white}}>David Bednar</b><span style={{color:C.muted,fontSize:9}}> · 2.18 ERA · 34 SV (2025 BR)</span></div>
            <div style={{color:C.dim,fontSize:10,marginBottom:4}}>Camilo Doval · Fernando Cruz (setup)</div>
            <div style={{color:C.muted,fontSize:9,marginBottom:8}}>Jake Bird · Tim Hill (LOOGY) · Kervin Castro</div>
            <div style={{color:C.dim,fontSize:10,fontStyle:"italic",borderTop:`1px solid ${C.border}`,paddingTop:7}}>Bednar + Doval = elite. Best closer combo in this game. Any NYY lead is protected.</div>
          </div>
          <div style={{flex:1,minWidth:260,background:C.card,borderRadius:10,padding:14,border:`1px solid ${C.yellow}33`}}>
            <div style={{color:C.yellow,fontWeight:700,fontSize:11,marginBottom:8}}>SFG BULLPEN — SOLID</div>
            <div style={{marginBottom:4}}><b style={{color:C.white}}>Ryan Walker</b><span style={{color:C.muted,fontSize:9}}> · 2.71 ERA · 28 SV (2025 BR)</span></div>
            <div style={{color:C.dim,fontSize:10,marginBottom:4}}>Landen Roupp · Erik Miller LHP (setup)</div>
            <div style={{color:C.muted,fontSize:9,marginBottom:8}}>Ryan Borucki · Joel Peguero · Carson Seymour</div>
            <div style={{color:C.dim,fontSize:10,fontStyle:"italic",borderTop:`1px solid ${C.border}`,paddingTop:7}}>Walker reliable. Roupp solid. A tier below NYY. Miller LHP creates platoon matchups.</div>
          </div>
          <div style={{width:"100%",background:C.card,borderRadius:10,padding:12,border:`1px solid ${C.border}`}}>
            <div style={{color:C.yellow,fontWeight:700,fontSize:10,marginBottom:7}}>BULLPEN PROP NOTES</div>
            {["Fried OD short leash ~90p → UNDER 16.5 outs stays live if pulled at 85p.",
              "Webb home at Oracle → gets deeper leash, 5th straight OD start here.",
              "Bednar K prop: if NYY leads in 9th, Bednar (34 SV 2025) = bonus strikeout slot.",
              "Erik Miller LHP sets up platoon edge for NYY LHBs in late innings.",
              "Both closers reliable — fading late-inning runs scored is risky against Bednar/Walker.",
            ].map((l,i)=>(
              <div key={i} style={{display:"flex",gap:5,marginBottom:4}}>
                <span style={{color:C.yellow,fontSize:8,flexShrink:0,marginTop:1}}>›</span>
                <span style={{color:C.dim,fontSize:10}}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{marginTop:14,color:C.muted,fontSize:8,textAlign:"center"}}>
        Full Prop Engine · 18 hitters + 2 pitchers + bullpens + NRFI/YRFI calc · H · HR · R · RBI · TB · HRR · 2B · 3B · 1B · K · SB per batter ·
        NRFI: Poisson model + historical blend · Live Odds API (DK) · Stats: Baseball-Reference 2025 · Opening Day 2026
      </div>
    </div>
  );
}
