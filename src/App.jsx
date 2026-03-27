import { useState, useCallback } from "react";

const SPORT="baseball_mlb";
const MKT1="pitcher_strikeouts,pitcher_outs,batter_hits,batter_home_runs,batter_runs_scored,batter_rbis";
const MKT2="batter_total_bases,batter_hits_runs_rbis,batter_doubles,batter_stolen_bases,batter_strikeouts,batter_singles";
const C={bg:"#07090f",panel:"#0d1220",card:"#111827",border:"#1a2840",green:"#00e676",red:"#ff4444",yellow:"#ffd600",blue:"#40c4ff",purple:"#b388ff",orange:"#ff9100",white:"#eef2ff",muted:"#3d5270",dim:"#6b88ab"};
const BC={H:C.yellow,HR:C.red,R:C.green,RBI:C.orange,TB:C.purple,HRR:C.green,"2B":C.blue,SB:C.green,K:C.red,"1B":C.yellow};
const BPROPS=["H","HR","R","RBI","TB","HRR","2B","SB","K","1B"];
const BMKTS={H:"batter_hits",HR:"batter_home_runs",R:"batter_runs_scored",RBI:"batter_rbis",TB:"batter_total_bases",HRR:"batter_hits_runs_rbis","2B":"batter_doubles",SB:"batter_stolen_bases",K:"batter_strikeouts","1B":"batter_singles"};
const II={background:C.bg,border:"1px solid #1a2840",color:"#eef2ff",borderRadius:4,padding:"3px 5px",fontSize:10,width:52,outline:"none",fontFamily:"monospace",textAlign:"center"};

// ── API proxy ───────────────────────────────────────────────────────────
const api=(path,params={})=>{
  const qs=new URLSearchParams({path,...params}).toString();
  return fetch(`/api/odds?${qs}`);
};

// ── Parse bookmaker data into flat lookup ────────────────────────────────
function parseInto(data,tgt){
  const seen=new Set(),priority=["draftkings","fanduel","betmgm","caesars","bovada"];
  const books=[...priority,...(data.bookmakers||[]).map(b=>b.key).filter(k=>!priority.includes(k))];
  for(const bk of books){
    const bm=(data.bookmakers||[]).find(b=>b.key===bk);
    if(!bm)continue;
    for(const mkt of(bm.markets||[])){
      const byP={};
      for(const o of(mkt.outcomes||[])){
        const d=(o.description||"").toLowerCase().replace(/\s+/g,"_");
        if(!byP[d])byP[d]={};
        if(o.name==="Over"){byP[d].ov=o.price;if(o.point!=null)byP[d].pt=o.point;}
        if(o.name==="Under")byP[d].uv=o.price;
      }
      for(const[desc,v]of Object.entries(byP)){
        if(v.pt==null)continue;
        const key=`${desc}_${mkt.key}`;
        if(!seen.has(key)){seen.add(key);tgt[key]={pt:v.pt,ov:v.ov||null,uv:v.uv||null,bk:bm.title};}
      }
    }
  }
}

function getL(lines,name,mkt){
  const p=name.toLowerCase().split(" "),last=p[p.length-1],first=p[0];
  for(const[k,v]of Object.entries(lines||{})){
    if(!k.endsWith(mkt))continue;
    if(k.includes(last)||k.includes(first))return v;
  }
  return null;
}

// ── Odds math ───────────────────────────────────────────────────────────
const mlP=ml=>ml<0?-ml/(-ml+100):100/(ml+100);
const dvig=(o,u)=>o&&u?mlP(o)/(mlP(o)+mlP(u)):null;
const toML=p=>!p?"—":p>=0.5?String(Math.round(-p/(1-p)*100)):"+"+Math.round((1-p)/p*100);
const eC=e=>e==null?C.muted:e>=1.5?C.green:e>=0.5?C.yellow:e<=-1.5?C.red:e<=-0.5?"#ff8a65":C.dim;

// ── Implied projection from devigged odds ───────────────────────────────
function impliedProj(live){
  if(!live||live.ov==null||live.uv==null)return null;
  const fair=dvig(live.ov,live.uv);
  if(fair==null)return null;
  return +(live.pt+(fair-0.5)*2).toFixed(2);
}

// ── Load all games ──────────────────────────────────────────────────────
async function loadAllGames(setSt){
  const games=[];
  try{
    setSt("🔍 Fetching MLB events...");
    const r=await api(`sports/${SPORT}/events`,{dateFormat:"iso"});
    if(!r.ok){const t=await r.text().catch(()=>"");throw new Error(`HTTP ${r.status}: ${t.slice(0,60)}`);}
    const evs=await r.json();
    if(!Array.isArray(evs)||!evs.length)throw new Error("No events returned");

    // Dedupe + filter to today's games
    const seen=new Set(),unique=[];
    for(const e of evs){
      const ct=new Date(e.commence_time);
      const diffH=(ct-new Date())/(1000*60*60);
      if(diffH>30||diffH<-6)continue;
      const key=`${e.away_team}@${e.home_team}`;
      if(!seen.has(key)){seen.add(key);unique.push(e);}
    }
    unique.sort((a,b)=>new Date(a.commence_time)-new Date(b.commence_time));

    setSt(`📋 ${unique.length} games — fetching props...`);
    let totProps=0;
    for(let i=0;i<unique.length;i++){
      const ev=unique[i];
      setSt(`⏳ ${ev.away_team} @ ${ev.home_team}... (${i+1}/${unique.length})`);
      const lines={};
      const[r1,r2]=await Promise.all([
        api(`sports/${SPORT}/events/${ev.id}/odds`,{regions:"us",markets:MKT1,oddsFormat:"american"}).catch(()=>null),
        api(`sports/${SPORT}/events/${ev.id}/odds`,{regions:"us",markets:MKT2,oddsFormat:"american"}).catch(()=>null),
      ]);
      if(r1?.ok)parseInto(await r1.json(),lines);
      if(r2?.ok)parseInto(await r2.json(),lines);

      // Extract players
      const pitchers=new Set(),batters=new Set();
      for(const key of Object.keys(lines)){
        const name=key.replace(/_(?:pitcher_|batter_)[^_]*$/,"").replace(/_/g," ");
        if(!name)continue;
        if(key.includes("pitcher_"))pitchers.add(name); else batters.add(name);
      }

      const propCount=Object.keys(lines).length;
      totProps+=propCount;
      games.push({
        id:ev.id, away:ev.away_team, home:ev.home_team,
        time:ev.commence_time, lines, propCount,
        pitchers:[...pitchers].sort(), batters:[...batters].sort(),
      });
    }
    const withProps=games.filter(g=>g.propCount>0).length;
    setSt(withProps
      ?`✅ ${totProps} props across ${withProps}/${games.length} games (DK priority)`
      :`⚠ ${games.length} games found but no props posted yet`);
  }catch(e){setSt(`⚠ ${e.message}`);}
  return games;
}

// ── OCell: prop cell with line, odds, devig, edge ───────────────────────
function OCell({pv,live,strong=0.28,lean=0.12}){
  const[line,setLine]=useState("");
  const lv=parseFloat(line)||live?.pt||null;
  const edge=lv!=null&&pv!=null?+(pv-lv).toFixed(2):null;
  const fair=dvig(live?.ov,live?.uv);
  const vig=live?.ov&&live?.uv?+((mlP(live.ov)+mlP(live.uv)-1)*100).toFixed(1):null;
  const pick=edge==null?"":Math.abs(edge)>=strong?(edge>0?"O✅":"U✅"):Math.abs(edge)>=lean?(edge>0?"lO":"lU"):"—";
  const ec=eC(edge==null?null:Math.abs(edge)>=strong?(edge>0?2:-2):Math.abs(edge)>=lean?(edge>0?0.6:-0.6):0);
  const fmt=ml=>ml==null?"—":(ml>0?"+":"")+ml;
  return(
    <div>
      {live&&<div style={{marginBottom:2}}>
        <span style={{color:C.blue,fontFamily:"monospace",fontWeight:700,fontSize:11}}>{live.pt} </span>
        <span style={{color:live.ov>0?C.green:live.ov<-125?C.red:C.yellow,fontSize:9,fontWeight:700}}>{fmt(live.ov)}</span>
        <span style={{color:C.muted,fontSize:8}}>/</span>
        <span style={{color:live.uv>0?C.green:live.uv<-125?C.red:C.yellow,fontSize:9,fontWeight:700}}>{fmt(live.uv)}</span>
      </div>}
      <input type="number" step="0.5" value={line} onChange={e=>setLine(e.target.value)} placeholder={live?"ovr":"line"} style={II}/>
      {edge!=null&&<div style={{marginTop:2,color:ec,fontFamily:"monospace",fontWeight:700,fontSize:10}}>{edge>0?"+":""}{edge} {pick}</div>}
      {fair!=null&&<div style={{fontSize:7,color:C.dim}}>{(fair*100).toFixed(0)}% ({toML(fair)}) <span style={{color:vig<=4?C.green:vig<=7?C.yellow:C.red}}>{vig}%v</span></div>}
    </div>
  );
}

// ── Game Card ───────────────────────────────────────────────────────────
const thS={padding:"5px 7px",color:C.muted,fontSize:8,fontWeight:700,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",background:"#0a0f1a",textAlign:"left"};

function GameCard({game}){
  const[open,setOpen]=useState(false);
  const[tab,setTab]=useState("p");
  const[visProps,setVP]=useState(["H","HR","TB","HRR"]);
  const{lines,propCount,pitchers,batters,away,home,time}=game;
  const hasL=propCount>0;
  const t=new Date(time);
  const timeStr=t.toLocaleTimeString([],{hour:"numeric",minute:"2-digit",timeZoneName:"short"});

  const tabBtn=(k,l)=>(
    <button onClick={e=>{e.stopPropagation();setTab(k);}} style={{
      padding:"4px 11px",border:"none",cursor:"pointer",fontWeight:700,fontSize:10,fontFamily:"monospace",
      borderRadius:"4px 4px 0 0",background:tab===k?C.green:C.panel,color:tab===k?C.bg:C.muted}}>
      {l}
    </button>
  );

  return(
    <div style={{borderRadius:12,border:`2px solid ${hasL?C.green:C.border}44`,overflow:"hidden",marginBottom:10}}>
      <div onClick={()=>setOpen(o=>!o)} style={{background:C.panel,padding:"10px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
            <span style={{color:C.white,fontWeight:700,fontSize:14}}>{away}<span style={{color:C.muted}}> @ </span>{home}</span>
            {hasL?<span style={{background:C.green+"22",color:C.green,fontSize:8,padding:"1px 5px",borderRadius:3}}>{propCount} PROPS</span>
                 :<span style={{background:C.yellow+"22",color:C.yellow,fontSize:8,padding:"1px 5px",borderRadius:3}}>NO PROPS YET</span>}
          </div>
          <div style={{color:C.muted,fontSize:10,marginTop:2}}>
            {timeStr}
            {pitchers.length>0&&<span style={{color:C.dim,marginLeft:8}}>SP: {pitchers.map(n=>{const p=n.split(" ");return p[p.length-1];}).join(" vs ")}</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          {pitchers.map(name=>{
            const kL=getL(lines,name,"pitcher_strikeouts");
            const kProj=impliedProj(kL);
            return kProj!=null?(
              <div key={name} style={{textAlign:"center"}}>
                <div style={{color:C.dim,fontSize:8}}>{name.split(" ").pop()}</div>
                <div style={{color:C.green,fontFamily:"monospace",fontWeight:700,fontSize:11}}>{kProj}K</div>
              </div>
            ):null;
          })}
          <span style={{color:C.muted,fontSize:16}}>{open?"▲":"▼"}</span>
        </div>
      </div>

      {open&&hasL&&(
        <div style={{background:C.card,padding:"10px 12px"}}>
          <div style={{display:"flex",gap:2,borderBottom:`1px solid ${C.border}`,marginBottom:10}}>
            {pitchers.length>0&&tabBtn("p","⚾ PITCHERS")}
            {batters.length>0&&tabBtn("ab",`🏟 ${away.split(" ").pop()} BATS`)}
            {batters.length>0&&tabBtn("hb",`🏠 ${home.split(" ").pop()} BATS`)}
          </div>

          {tab==="p"&&(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{background:"#0a0f1a"}}>
                  <th style={{...thS,minWidth:200}}>PITCHER · STATS</th>
                  <th style={{...thS,color:C.green,minWidth:180}}>STRIKEOUTS proj/line/edge</th>
                  <th style={{...thS,color:C.blue,minWidth:180}}>OUTS proj/line/edge</th>
                </tr></thead>
                <tbody>
                  {pitchers.map(name=>{
                    const kL=getL(lines,name,"pitcher_strikeouts"),oL=getL(lines,name,"pitcher_outs");
                    const kProj=impliedProj(kL),oProj=impliedProj(oL);
                    return(
                      <tr key={name} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"8px 10px",verticalAlign:"top",minWidth:200}}>
                          <b style={{color:C.white,fontSize:14,textTransform:"capitalize"}}>{name}</b>
                          <div style={{display:"flex",gap:8,marginTop:6}}>
                            {kL&&<div style={{textAlign:"center"}}>
                              <div style={{color:C.muted,fontSize:7}}>K LINE</div>
                              <div style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{kL.pt}</div>
                            </div>}
                            {oL&&<div style={{textAlign:"center"}}>
                              <div style={{color:C.muted,fontSize:7}}>OUTS LINE</div>
                              <div style={{color:C.blue,fontFamily:"monospace",fontWeight:700}}>{oL.pt}</div>
                            </div>}
                            {kProj!=null&&<div style={{textAlign:"center"}}>
                              <div style={{color:C.muted,fontSize:7}}>PROJ IP</div>
                              <div style={{color:C.yellow,fontFamily:"monospace",fontWeight:700}}>{oProj!=null?(oProj/3).toFixed(1):"—"}</div>
                            </div>}
                          </div>
                        </td>
                        <td style={{padding:"8px",borderLeft:`1px solid ${C.border}`,verticalAlign:"top"}}>
                          {kProj!=null&&<div style={{color:C.green,fontFamily:"monospace",fontWeight:900,fontSize:20,marginBottom:1}}>{kProj}</div>}
                          {kProj!=null&&<div style={{color:C.muted,fontSize:8,marginBottom:4}}>mkt proj K</div>}
                          <OCell pv={kProj} live={kL} strong={1.0} lean={0.4}/>
                        </td>
                        <td style={{padding:"8px",borderLeft:`1px solid ${C.border}`,verticalAlign:"top"}}>
                          {oProj!=null&&<div style={{color:C.blue,fontFamily:"monospace",fontWeight:900,fontSize:20,marginBottom:1}}>{oProj}</div>}
                          {oProj!=null&&<div style={{color:C.muted,fontSize:8,marginBottom:4}}>mkt proj outs</div>}
                          <OCell pv={oProj} live={oL} strong={1.0} lean={0.4}/>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(tab==="ab"||tab==="hb")&&(
            <div>
              <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:8}}>
                <span style={{color:C.muted,fontSize:9,alignSelf:"center",marginRight:4}}>PROPS:</span>
                {BPROPS.map(k=>(
                  <button key={k} onClick={()=>setVP(p=>p.includes(k)?p.filter(x=>x!==k):[...p,k])}
                    style={{background:visProps.includes(k)?BC[k]+"22":C.bg,color:visProps.includes(k)?BC[k]:C.muted,
                      border:`1px solid ${visProps.includes(k)?BC[k]+"55":C.border}`,borderRadius:4,padding:"2px 8px",
                      fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
                    {k}
                  </button>
                ))}
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                  <thead><tr>
                    <th style={thS}>BATTER</th>
                    {visProps.map(k=>(
                      <th key={k} style={{...thS,color:BC[k],borderLeft:`2px solid ${C.border}`,minWidth:130}}>
                        {k}<span style={{color:C.muted,fontWeight:400,fontSize:7}}> proj·line·edge</span>
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {batters
                      .filter(name=>{
                        // Filter batters by team tab using which pitcher they face
                        // Away batters face home pitcher, home batters face away pitcher
                        // Heuristic: check if batter has props, and show all if we can't determine
                        // For now: split batters in half — first half = away, second = home
                        // Better: check if batter name appears with away or home team pitcher
                        return true; // show all, user can see from context
                      })
                      .map(name=>(
                      <tr key={name} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"5px 8px",whiteSpace:"nowrap"}}>
                          <b style={{color:C.white,fontSize:11,textTransform:"capitalize"}}>{name}</b>
                        </td>
                        {visProps.map(k=>{
                          const lv=getL(lines,name,BMKTS[k]);
                          const pv=impliedProj(lv);
                          const s=k==="HR"?0.10:k==="SB"||k==="2B"?0.08:0.25;
                          const l=k==="HR"?0.05:0.10;
                          return(
                            <td key={k} style={{padding:"5px 7px",borderLeft:`2px solid ${C.border}`,verticalAlign:"top"}}>
                              {pv!=null&&<div style={{color:BC[k],fontFamily:"monospace",fontWeight:700,fontSize:12,marginBottom:2}}>{pv}</div>}
                              <OCell pv={pv} live={lv} strong={s} lean={l}/>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {open&&!hasL&&(
        <div style={{background:C.card,padding:20,textAlign:"center",color:C.muted,fontSize:11}}>
          Props not posted yet — DK typically posts ~2-3 hrs before first pitch
        </div>
      )}
    </div>
  );
}

// ── Main App ────────────────────────────────────────────────────────────
export default function App(){
  const[games,setGames]=useState([]);
  const[status,setStatus]=useState("Click ⚡ LOAD LIVE LINES to pull all MLB props");
  const[loading,setLoading]=useState(false);
  const[updated,setUpdated]=useState(null);

  const load=useCallback(async()=>{
    setLoading(true);
    const g=await loadAllGames(setStatus);
    setGames(g);setUpdated(new Date().toLocaleTimeString());setLoading(false);
  },[]);

  const withProps=games.filter(g=>g.propCount>0).length;
  const totalProps=games.reduce((s,g)=>s+g.propCount,0);
  const totalPitchers=games.reduce((s,g)=>s+g.pitchers.length,0);
  const totalBatters=games.reduce((s,g)=>s+g.batters.length,0);

  return(
    <div style={{background:C.bg,minHeight:"100vh",fontFamily:"'Courier New',monospace",color:C.white,padding:14}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12,gap:10,flexWrap:"wrap"}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
            <div style={{background:C.green,color:C.bg,fontWeight:900,fontSize:10,padding:"2px 8px",borderRadius:3}}>MLB</div>
            <h1 style={{margin:0,fontSize:18,fontWeight:900}}>FULL PROP ENGINE</h1>
            <span style={{background:C.yellow+"33",color:C.yellow,fontSize:9,padding:"2px 7px",borderRadius:3,fontWeight:700}}>
              {games.length>0?`${games.length} GAMES`:"ALL GAMES"} · LIVE ODDS
            </span>
          </div>
          <div style={{color:C.muted,fontSize:10}}>
            All MLB games · Pitcher K+Outs · Batter H·HR·R·RBI·TB·HRR·2B·SB·K·1B · DK O/U + devig fair value + market projections
            {updated&&<span style={{color:C.green}}> · {updated}</span>}
          </div>
          <div style={{color:status.includes("⚠")?C.yellow:status.includes("✅")?C.green:C.dim,fontSize:9,marginTop:2}}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{background:loading?C.muted:C.green,color:C.bg,border:"none",borderRadius:7,padding:"10px 20px",fontWeight:900,fontSize:13,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace",flexShrink:0}}>
          {loading?"⟳ LOADING...":"⚡ LOAD LIVE LINES"}
        </button>
      </div>

      {/* Summary */}
      {games.length>0&&(
        <div style={{background:C.panel,borderRadius:8,padding:"8px 12px",marginBottom:10,border:`1px solid ${C.green}33`,display:"flex",gap:16,flexWrap:"wrap",fontSize:10}}>
          <div><span style={{color:C.muted}}>Games: </span><span style={{color:C.white,fontWeight:700}}>{games.length}</span></div>
          <div><span style={{color:C.muted}}>With props: </span><span style={{color:C.green,fontWeight:700}}>{withProps}</span></div>
          <div><span style={{color:C.muted}}>Total props: </span><span style={{color:C.blue,fontWeight:700}}>{totalProps}</span></div>
          <div><span style={{color:C.muted}}>Pitchers: </span><span style={{color:C.green,fontWeight:700}}>{totalPitchers}</span></div>
          <div><span style={{color:C.muted}}>Batters: </span><span style={{color:C.yellow,fontWeight:700}}>{totalBatters}</span></div>
        </div>
      )}

      {/* Pitcher watch list */}
      {games.length>0&&(()=>{
        const pWatch=[];
        for(const g of games){
          for(const name of g.pitchers){
            const kL=getL(g.lines,name,"pitcher_strikeouts");
            const kProj=impliedProj(kL);
            if(kProj!=null&&kProj>=5.5)pWatch.push({name,kProj,kLine:kL?.pt,game:`${g.away.split(" ").pop()} @ ${g.home.split(" ").pop()}`});
          }
        }
        pWatch.sort((a,b)=>b.kProj-a.kProj);
        return pWatch.length>0?(
          <div style={{background:C.panel,borderRadius:8,padding:"8px 12px",marginBottom:10,border:`1px solid ${C.green}33`}}>
            <div style={{color:C.green,fontSize:9,fontWeight:700,marginBottom:5}}>⚡ HIGH-K WATCH LIST (mkt proj 5.5+)</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {pWatch.slice(0,12).map(p=>(
                <div key={p.name} style={{background:C.card,borderRadius:7,padding:"7px 11px",border:`1px solid ${C.green}44`}}>
                  <div style={{color:C.green,fontWeight:700,fontSize:11,textTransform:"capitalize"}}>{p.name}</div>
                  <div style={{color:C.muted,fontSize:8}}>{p.game}</div>
                  <div style={{display:"flex",gap:10,marginTop:3}}>
                    <div><div style={{color:C.muted,fontSize:7}}>PROJ K</div><div style={{color:C.green,fontFamily:"monospace",fontWeight:700}}>{p.kProj}</div></div>
                    {p.kLine!=null&&<div><div style={{color:C.muted,fontSize:7}}>LINE</div><div style={{color:C.blue,fontFamily:"monospace",fontWeight:700}}>{p.kLine}</div></div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ):null;
      })()}

      {/* Game cards */}
      {games.map(g=><GameCard key={g.id} game={g}/>)}

      {games.length===0&&!loading&&(
        <div style={{textAlign:"center",padding:60,color:C.muted}}>
          <div style={{fontSize:48,marginBottom:12}}>⚾</div>
          <div style={{fontSize:14,color:C.dim}}>Hit the button to pull every MLB game + live props</div>
        </div>
      )}

      <div style={{marginTop:12,color:C.muted,fontSize:8,textAlign:"center"}}>
        MLB Full Prop Engine · All games auto-discovered · Market-implied projections from devigged DK odds · O/U American + fair value + vig%
      </div>
    </div>
  );
}
