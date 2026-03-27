import { useState, useCallback } from "react";

const SPORT = "baseball_mlb";
const MKT1 = "pitcher_strikeouts,pitcher_outs,pitcher_hits_allowed,pitcher_earned_runs,pitcher_walks";
const MKT2 = "batter_hits,batter_home_runs,batter_runs_scored,batter_rbis,batter_total_bases";
const MKT3 = "batter_hits_runs_rbis,batter_doubles,batter_stolen_bases,batter_strikeouts,batter_singles";

const C = {
  bg: "#07090f", panel: "#0d1220", card: "#111827", border: "#1a2840",
  green: "#00e676", red: "#ff4444", yellow: "#ffd600", blue: "#40c4ff",
  purple: "#b388ff", orange: "#ff9100", white: "#eef2ff", muted: "#3d5270", dim: "#6b88ab",
};
const BC = { H: C.yellow, HR: C.red, R: C.green, RBI: C.orange, TB: C.purple, HRR: C.green, "2B": C.blue, SB: C.green, K: C.red, "1B": C.yellow };
const BPROPS = ["H", "HR", "R", "RBI", "TB", "HRR", "2B", "SB", "K", "1B"];
const BMKTS = { H: "batter_hits", HR: "batter_home_runs", R: "batter_runs_scored", RBI: "batter_rbis", TB: "batter_total_bases", HRR: "batter_hits_runs_rbis", "2B": "batter_doubles", SB: "batter_stolen_bases", K: "batter_strikeouts", "1B": "batter_singles" };
const PMKTS = { K: "pitcher_strikeouts", OUTS: "pitcher_outs", H: "pitcher_hits_allowed", ER: "pitcher_earned_runs", BB: "pitcher_walks" };

// ── API proxy ───────────────────────────────────────────────────────────
const api = (path, params = {}) => {
  const qs = new URLSearchParams({ path, ...params }).toString();
  return fetch(`/api/odds?${qs}`);
};

// ── Parse bookmaker data ────────────────────────────────────────────────
function parseInto(data, tgt) {
  const seen = new Set();
  const priority = ["draftkings", "fanduel", "betmgm", "caesars", "bovada", "betonlineag"];
  const books = [...priority, ...(data.bookmakers || []).map(b => b.key).filter(k => !priority.includes(k))];
  for (const bk of books) {
    const bm = (data.bookmakers || []).find(b => b.key === bk);
    if (!bm) continue;
    for (const mkt of (bm.markets || [])) {
      const byP = {};
      for (const o of (mkt.outcomes || [])) {
        const d = (o.description || "").toLowerCase().replace(/\s+/g, "_");
        if (!byP[d]) byP[d] = {};
        if (o.name === "Over") { byP[d].ov = o.price; if (o.point != null) byP[d].pt = o.point; }
        if (o.name === "Under") byP[d].uv = o.price;
      }
      for (const [desc, v] of Object.entries(byP)) {
        if (v.pt == null) continue;
        const key = `${desc}_${mkt.key}`;
        if (!seen.has(key)) { seen.add(key); tgt[key] = { pt: v.pt, ov: v.ov || null, uv: v.uv || null, bk: bm.title }; }
      }
    }
  }
}

function getL(lines, name, mkt) {
  const parts = name.toLowerCase().split(" ");
  const last = parts[parts.length - 1], first = parts[0];
  for (const [k, v] of Object.entries(lines || {})) {
    if (!k.endsWith(mkt)) continue;
    if (k.includes(last) || k.includes(first)) return v;
  }
  return null;
}

// ── Odds math ───────────────────────────────────────────────────────────
const mlP = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
const dvig = (o, u) => o && u ? mlP(o) / (mlP(o) + mlP(u)) : null;
const toML = p => !p ? "—" : p >= 0.5 ? String(Math.round(-p / (1 - p) * 100)) : "+" + Math.round((1 - p) / p * 100);

function impliedProj(live) {
  if (!live || live.ov == null || live.uv == null) return null;
  const fair = dvig(live.ov, live.uv);
  if (fair == null) return null;
  return +(live.pt + (fair - 0.5) * 2).toFixed(2);
}

// ── Load all games ──────────────────────────────────────────────────────
async function loadAllGames(setSt) {
  const games = [];
  try {
    setSt("Fetching MLB events...");
    const r = await api(`sports/${SPORT}/events`, { dateFormat: "iso" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const evs = await r.json();
    if (!Array.isArray(evs) || !evs.length) throw new Error("No events returned");

    const seen = new Set(), unique = [];
    for (const e of evs) {
      const diffH = (new Date(e.commence_time) - new Date()) / 36e5;
      if (diffH > 30 || diffH < -6) continue;
      const key = `${e.away_team}@${e.home_team}`;
      if (!seen.has(key)) { seen.add(key); unique.push(e); }
    }
    unique.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

    setSt(`${unique.length} games — fetching props...`);
    let totProps = 0;
    for (let i = 0; i < unique.length; i++) {
      const ev = unique[i];
      setSt(`${ev.away_team} @ ${ev.home_team}... (${i + 1}/${unique.length})`);
      const lines = {};
      const [r1, r2, r3] = await Promise.all([
        api(`sports/${SPORT}/events/${ev.id}/odds`, { regions: "us", markets: MKT1, oddsFormat: "american" }).catch(() => null),
        api(`sports/${SPORT}/events/${ev.id}/odds`, { regions: "us", markets: MKT2, oddsFormat: "american" }).catch(() => null),
        api(`sports/${SPORT}/events/${ev.id}/odds`, { regions: "us", markets: MKT3, oddsFormat: "american" }).catch(() => null),
      ]);
      if (r1?.ok) parseInto(await r1.json(), lines);
      if (r2?.ok) parseInto(await r2.json(), lines);
      if (r3?.ok) parseInto(await r3.json(), lines);

      const pitchers = new Set(), batters = new Set();
      for (const key of Object.keys(lines)) {
        const name = key.replace(/_(?:pitcher_|batter_)[^_]*$/, "").replace(/_/g, " ");
        if (!name) continue;
        if (key.includes("pitcher_")) pitchers.add(name); else batters.add(name);
      }

      const propCount = Object.keys(lines).length;
      totProps += propCount;
      games.push({
        id: ev.id, away: ev.away_team, home: ev.home_team,
        time: ev.commence_time, lines, propCount,
        pitchers: [...pitchers].sort(), batters: [...batters].sort(),
      });
    }
    const withProps = games.filter(g => g.propCount > 0).length;
    setSt(`Done — ${totProps} props across ${withProps}/${games.length} games`);
  } catch (e) { setSt(`Error: ${e.message}`); }
  return games;
}

// ── Shared styles ───────────────────────────────────────────────────────
const th = { padding: "6px 8px", color: C.muted, fontSize: 8, fontWeight: 700, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: "#0a0f1a", textAlign: "left", letterSpacing: 0.3 };
const td = { padding: "5px 8px", verticalAlign: "middle" };
const inp = { background: C.bg, border: `1px solid ${C.border}`, color: C.white, borderRadius: 4, padding: "3px 5px", fontSize: 10, width: 52, outline: "none", fontFamily: "monospace", textAlign: "center" };
const fmt = ml => ml == null ? "—" : (ml > 0 ? "+" : "") + ml;

// ── Prop Cell ───────────────────────────────────────────────────────────
function PropCell({ proj, live, thresholds }) {
  const [ovr, setOvr] = useState("");
  const line = parseFloat(ovr) || live?.pt || null;
  const edge = line != null && proj != null ? +(proj - line).toFixed(2) : null;
  const fair = dvig(live?.ov, live?.uv);
  const vig = live?.ov && live?.uv ? +((mlP(live.ov) + mlP(live.uv) - 1) * 100).toFixed(1) : null;
  const [s, l] = thresholds || [0.25, 0.10];
  const pick = edge == null ? "" : Math.abs(edge) >= s ? (edge > 0 ? "O" : "U") + " ✅" : Math.abs(edge) >= l ? (edge > 0 ? "lean O" : "lean U") : "";
  const ec = edge == null ? C.muted : Math.abs(edge) >= s ? (edge > 0 ? C.green : C.red) : Math.abs(edge) >= l ? (edge > 0 ? C.yellow : "#ff8a65") : C.dim;

  return (
    <div style={{ minWidth: 90 }}>
      {live && (
        <div style={{ marginBottom: 3 }}>
          <span style={{ color: C.blue, fontFamily: "monospace", fontWeight: 700, fontSize: 11 }}>{live.pt} </span>
          <span style={{ color: live.ov > 0 ? C.green : C.yellow, fontSize: 9, fontWeight: 600 }}>{fmt(live.ov)}</span>
          <span style={{ color: C.muted, fontSize: 8 }}>/</span>
          <span style={{ color: live.uv > 0 ? C.green : C.yellow, fontSize: 9, fontWeight: 600 }}>{fmt(live.uv)}</span>
        </div>
      )}
      <input type="number" step="0.5" value={ovr} onChange={e => setOvr(e.target.value)} placeholder={live ? "ovr" : "line"} style={inp} />
      {edge != null && <div style={{ marginTop: 2, color: ec, fontFamily: "monospace", fontWeight: 700, fontSize: 10 }}>{edge > 0 ? "+" : ""}{edge} {pick}</div>}
      {fair != null && <div style={{ fontSize: 7, color: C.dim }}>FV {(fair * 100).toFixed(0)}% ({toML(fair)}) <span style={{ color: vig <= 4 ? C.green : vig <= 7 ? C.yellow : C.red }}>{vig}%v</span></div>}
    </div>
  );
}

// ── Pitcher Card ────────────────────────────────────────────────────────
function PitcherCard({ name, lines }) {
  const stats = {};
  for (const [key, mkt] of Object.entries(PMKTS)) {
    const live = getL(lines, name, mkt);
    stats[key] = { live, proj: impliedProj(live) };
  }

  const projIP = stats.OUTS.proj != null ? (stats.OUTS.proj / 3).toFixed(1) : null;
  const projERA = stats.ER.proj != null && projIP ? (stats.ER.proj / parseFloat(projIP) * 9).toFixed(2) : null;

  return (
    <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 14, flex: 1, minWidth: 320 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <b style={{ color: C.white, fontSize: 15, textTransform: "capitalize" }}>{name}</b>
      </div>

      {/* Quick stats row */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          ["PROJ K", stats.K.proj, C.green],
          ["PROJ IP", projIP, C.blue],
          ["PROJ ER", stats.ER.proj, C.orange],
          ["PROJ ERA", projERA, projERA && parseFloat(projERA) <= 3.0 ? C.green : projERA && parseFloat(projERA) <= 4.0 ? C.yellow : C.red],
          ["PROJ BB", stats.BB.proj, C.purple],
          ["PROJ H", stats.H.proj, C.yellow],
        ].map(([label, val, color]) => val != null ? (
          <div key={label} style={{ background: C.panel, borderRadius: 5, padding: "5px 9px", textAlign: "center" }}>
            <div style={{ color: C.muted, fontSize: 7, letterSpacing: 0.3 }}>{label}</div>
            <div style={{ color, fontSize: 14, fontWeight: 900, fontFamily: "monospace" }}>{val}</div>
          </div>
        ) : null)}
      </div>

      {/* Prop rows */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <tbody>
          {[
            ["STRIKEOUTS", stats.K, C.green, [1.0, 0.4]],
            ["OUTS REC", stats.OUTS, C.blue, [1.0, 0.4]],
            ["HITS ALLOW", stats.H, C.yellow, [0.5, 0.2]],
            ["EARNED RUNS", stats.ER, C.orange, [0.5, 0.2]],
            ["WALKS", stats.BB, C.purple, [0.3, 0.15]],
          ].map(([label, s, color, thr]) => (
            <tr key={label} style={{ borderBottom: `1px solid ${C.border}` }}>
              <td style={{ padding: "7px 8px", color: C.dim, fontSize: 10, width: 100 }}>{label}</td>
              <td style={{ padding: "7px 8px" }}>
                {s.proj != null && <span style={{ color, fontFamily: "monospace", fontWeight: 900, fontSize: 16 }}>{s.proj}</span>}
              </td>
              <td style={{ padding: "7px 8px" }}>
                <PropCell proj={s.proj} live={s.live} thresholds={thr} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Batter Table ────────────────────────────────────────────────────────
function BatterTable({ batters, lines, visProps, setVP }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ color: C.muted, fontSize: 9, alignSelf: "center", marginRight: 4 }}>SHOW:</span>
        {BPROPS.map(k => (
          <button key={k} onClick={() => setVP(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])}
            style={{
              background: visProps.includes(k) ? BC[k] + "22" : C.bg, color: visProps.includes(k) ? BC[k] : C.muted,
              border: `1px solid ${visProps.includes(k) ? BC[k] + "55" : C.border}`, borderRadius: 4, padding: "3px 10px",
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "monospace",
            }}>
            {k}
          </button>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, minWidth: 140, color: C.white }}>BATTER</th>
              {visProps.map(k => (
                <th key={k} style={{ ...th, color: BC[k], borderLeft: `2px solid ${C.border}`, minWidth: 120, textAlign: "center" }}>
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batters.map(name => (
              <tr key={name} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <b style={{ color: C.white, fontSize: 11, textTransform: "capitalize" }}>{name}</b>
                </td>
                {visProps.map(k => {
                  const lv = getL(lines, name, BMKTS[k]);
                  const pv = impliedProj(lv);
                  const thr = k === "HR" ? [0.10, 0.05] : k === "SB" || k === "2B" ? [0.08, 0.04] : [0.25, 0.10];
                  return (
                    <td key={k} style={{ ...td, borderLeft: `2px solid ${C.border}`, textAlign: "center" }}>
                      {pv != null && <div style={{ color: BC[k], fontFamily: "monospace", fontWeight: 700, fontSize: 13, marginBottom: 3 }}>{pv}</div>}
                      <PropCell proj={pv} live={lv} thresholds={thr} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Game Card ───────────────────────────────────────────────────────────
function GameCard({ game }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("p");
  const [visProps, setVP] = useState(["H", "HR", "TB", "HRR"]);
  const { lines, propCount, pitchers, batters, away, home, time } = game;
  const hasL = propCount > 0;
  const t = new Date(time);
  const timeStr = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const awayShort = away.split(" ").pop();
  const homeShort = home.split(" ").pop();

  const tabBtn = (k, label) => (
    <button onClick={e => { e.stopPropagation(); setTab(k); }} style={{
      padding: "5px 14px", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 10, fontFamily: "monospace",
      borderRadius: "5px 5px 0 0", background: tab === k ? C.green : "transparent", color: tab === k ? C.bg : C.muted,
      borderBottom: tab === k ? `2px solid ${C.green}` : "2px solid transparent",
    }}>
      {label}
    </button>
  );

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${hasL ? C.green + "44" : C.border}`, overflow: "hidden", marginBottom: 12 }}>
      {/* Header bar */}
      <div onClick={() => setOpen(o => !o)} style={{ background: C.panel, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: C.white, fontWeight: 800, fontSize: 15 }}>{away} <span style={{ color: C.muted, fontWeight: 400 }}>@</span> {home}</span>
            {hasL && <span style={{ background: C.green + "22", color: C.green, fontSize: 9, padding: "2px 8px", borderRadius: 4, fontWeight: 700 }}>{propCount} props</span>}
            {!hasL && <span style={{ background: C.yellow + "22", color: C.yellow, fontSize: 9, padding: "2px 8px", borderRadius: 4 }}>no props yet</span>}
          </div>
          <div style={{ color: C.muted, fontSize: 10, marginTop: 3 }}>
            {timeStr}
            {pitchers.length > 0 && <span style={{ color: C.dim, marginLeft: 10 }}>SP: {pitchers.map(n => n.split(" ").pop()).join(" vs ")}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {pitchers.map(name => {
            const kProj = impliedProj(getL(lines, name, "pitcher_strikeouts"));
            const erProj = impliedProj(getL(lines, name, "pitcher_earned_runs"));
            return kProj != null ? (
              <div key={name} style={{ textAlign: "center", background: C.card, borderRadius: 6, padding: "4px 10px" }}>
                <div style={{ color: C.dim, fontSize: 8 }}>{name.split(" ").pop()}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ color: C.green, fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{kProj}K</span>
                  {erProj != null && <span style={{ color: C.orange, fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{erProj}ER</span>}
                </div>
              </div>
            ) : null;
          })}
          <span style={{ color: C.muted, fontSize: 18, fontWeight: 300 }}>{open ? "−" : "+"}</span>
        </div>
      </div>

      {/* Expanded content */}
      {open && hasL && (
        <div style={{ background: C.card, padding: "12px 14px" }}>
          <div style={{ display: "flex", gap: 3, borderBottom: `1px solid ${C.border}`, marginBottom: 14, paddingBottom: 2 }}>
            {pitchers.length > 0 && tabBtn("p", "PITCHERS")}
            {batters.length > 0 && tabBtn("b", "ALL BATTERS")}
          </div>

          {tab === "p" && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {pitchers.map(name => <PitcherCard key={name} name={name} lines={lines} />)}
            </div>
          )}

          {tab === "b" && (
            <BatterTable batters={batters} lines={lines} visProps={visProps} setVP={setVP} />
          )}
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

// ── Main App ────────────────────────────────────────────────────────────
export default function App() {
  const [games, setGames] = useState([]);
  const [status, setStatus] = useState("Click LOAD LIVE LINES to pull all MLB props");
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const g = await loadAllGames(setStatus);
    setGames(g);
    setUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  }, []);

  const withProps = games.filter(g => g.propCount > 0).length;
  const totalProps = games.reduce((s, g) => s + g.propCount, 0);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Courier New', monospace", color: C.white, padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <div style={{ background: C.green, color: C.bg, fontWeight: 900, fontSize: 11, padding: "3px 10px", borderRadius: 4 }}>MLB</div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>PROP ENGINE</h1>
            {games.length > 0 && <span style={{ color: C.yellow, fontSize: 10, fontWeight: 700 }}>{games.length} GAMES</span>}
          </div>
          <div style={{ color: C.muted, fontSize: 10 }}>
            Pitcher K · Outs · ER · BB · H | Batter H · HR · R · RBI · TB · HRR · 2B · SB · K · 1B
            {updated && <span style={{ color: C.green }}> | Updated {updated}</span>}
          </div>
          <div style={{ color: status.includes("Error") ? C.red : status.includes("Done") ? C.green : C.dim, fontSize: 9, marginTop: 2 }}>{status}</div>
        </div>
        <button onClick={load} disabled={loading} style={{
          background: loading ? C.muted : C.green, color: C.bg, border: "none", borderRadius: 8,
          padding: "12px 24px", fontWeight: 900, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", fontFamily: "monospace",
        }}>
          {loading ? "LOADING..." : "LOAD LIVE LINES"}
        </button>
      </div>

      {/* Summary bar */}
      {games.length > 0 && (
        <div style={{ background: C.panel, borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: `1px solid ${C.green}33`, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11 }}>
          <div><span style={{ color: C.muted }}>Games </span><span style={{ color: C.white, fontWeight: 700 }}>{games.length}</span></div>
          <div><span style={{ color: C.muted }}>With props </span><span style={{ color: C.green, fontWeight: 700 }}>{withProps}</span></div>
          <div><span style={{ color: C.muted }}>Props </span><span style={{ color: C.blue, fontWeight: 700 }}>{totalProps}</span></div>
        </div>
      )}

      {/* Watch list */}
      {games.length > 0 && (() => {
        const pWatch = [];
        for (const g of games) {
          for (const name of g.pitchers) {
            const kL = getL(g.lines, name, "pitcher_strikeouts");
            const erL = getL(g.lines, name, "pitcher_earned_runs");
            const kProj = impliedProj(kL);
            const erProj = impliedProj(erL);
            const outsL = getL(g.lines, name, "pitcher_outs");
            const outsProj = impliedProj(outsL);
            const projIP = outsProj != null ? (outsProj / 3).toFixed(1) : null;
            if (kProj != null && kProj >= 5.0) pWatch.push({ name, kProj, erProj, projIP, kLine: kL?.pt, game: `${g.away.split(" ").pop()} @ ${g.home.split(" ").pop()}` });
          }
        }
        pWatch.sort((a, b) => b.kProj - a.kProj);
        return pWatch.length > 0 ? (
          <div style={{ background: C.panel, borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: `1px solid ${C.green}33` }}>
            <div style={{ color: C.green, fontSize: 10, fontWeight: 700, marginBottom: 8 }}>HIGH-K PITCHERS (proj 5.0+)</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {pWatch.slice(0, 14).map(p => (
                <div key={p.name} style={{ background: C.card, borderRadius: 8, padding: "8px 12px", border: `1px solid ${C.green}44`, minWidth: 130 }}>
                  <div style={{ color: C.green, fontWeight: 700, fontSize: 11, textTransform: "capitalize" }}>{p.name}</div>
                  <div style={{ color: C.muted, fontSize: 8 }}>{p.game}</div>
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    <div><div style={{ color: C.muted, fontSize: 7 }}>PROJ K</div><div style={{ color: C.green, fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{p.kProj}</div></div>
                    {p.erProj != null && <div><div style={{ color: C.muted, fontSize: 7 }}>PROJ ER</div><div style={{ color: C.orange, fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{p.erProj}</div></div>}
                    {p.projIP && <div><div style={{ color: C.muted, fontSize: 7 }}>PROJ IP</div><div style={{ color: C.blue, fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{p.projIP}</div></div>}
                    {p.kLine != null && <div><div style={{ color: C.muted, fontSize: 7 }}>LINE</div><div style={{ color: C.blue, fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{p.kLine}</div></div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null;
      })()}

      {/* Game cards */}
      {games.map(g => <GameCard key={g.id} game={g} />)}

      {games.length === 0 && !loading && (
        <div style={{ textAlign: "center", padding: 80, color: C.muted }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>⚾</div>
          <div style={{ fontSize: 15, color: C.dim }}>Hit the button to pull every MLB game + live props</div>
        </div>
      )}

      <div style={{ marginTop: 14, color: C.muted, fontSize: 8, textAlign: "center" }}>
        MLB Prop Engine — all games auto-discovered — market projections from devigged DK/FanDuel/Pinnacle odds
      </div>
    </div>
  );
}
