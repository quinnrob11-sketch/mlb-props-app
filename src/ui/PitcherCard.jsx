import { fmt } from "../lib/format.js";

/**
 * Expanded detail panel for a pitcher row (bundle: `ch`).
 *
 * Rendered inside the `detail` row of the props table. Shows the season line,
 * the workload model that drives every pitcher projection, the full projection
 * set, and the recent game log the pitch budget was derived from.
 */
export default function PitcherCard({ p }) {
  const proj = p.proj;
  return (
    <div className="detail-grid">
      <div>
        <h4>Season ({p.season ? `${p.season.gs} GS` : "no 2026 data"})</h4>
        {p.season && (
          <>
            <div className="kv">
              <span>ERA / WHIP</span>
              <span>
                {p.season.era} / {p.season.whip}
              </span>
            </div>
            <div className="kv">
              <span>IP · K · BB</span>
              <span>
                {p.season.ip} · {p.season.k} · {p.season.bb}
              </span>
            </div>
          </>
        )}
        {p.prior && (
          <div className="kv">
            <span>2025</span>
            <span>
              {p.prior.era} ERA · {p.prior.gs} GS
            </span>
          </div>
        )}
        <div className="kv">
          <span>Opp K% / AVG</span>
          <span>
            {fmt.pct(p.oppK)} /{" "}
            {p.oppAvg != null && p.oppAvg.toFixed
              ? p.oppAvg.toFixed(3)
              : p.oppAvg}
          </span>
        </div>
      </div>

      <div>
        <h4>Workload model</h4>
        <div className="kv">
          <span>Pitch budget (recent-weighted)</span>
          <span>{Math.round(proj.workload.budget)}</span>
        </div>
        <div className="kv">
          <span>Pitches / BF</span>
          <span>{fmt.n2(proj.workload.pPerBF)}</span>
        </div>
        <div className="kv">
          <span>BF / IP</span>
          <span>{fmt.n2(proj.workload.bfPerIp)}</span>
        </div>
        <div className="kv">
          <span>IP from budget · recent avg IP</span>
          <span>
            {fmt.n1(proj.workload.ipBudget)} · {fmt.n1(proj.workload.recentIp)}
          </span>
        </div>
        <div className="kv">
          <span>
            <b>Projected IP / BF / pitches</b>
          </span>
          <span>
            <b>
              {fmt.n1(proj.projIP)} / {Math.round(proj.projBF)} /{" "}
              {Math.round(proj.projPitches)}
            </b>
          </span>
        </div>
        <div className="kv">
          <span>Projected strikes / balls</span>
          <span>
            {Math.round(proj.projStrikes)} / {Math.round(proj.projBalls)}
          </span>
        </div>
      </div>

      <div>
        <h4>Projections (all props)</h4>
        <div className="kv">
          <span>Strikeouts</span>
          <span>{fmt.n1(proj.projK)}</span>
        </div>
        <div className="kv">
          <span>Outs recorded</span>
          <span>{fmt.n1(proj.projOuts)}</span>
        </div>
        <div className="kv">
          <span>Hits allowed</span>
          <span>{fmt.n1(proj.projH)}</span>
        </div>
        <div className="kv">
          <span>Earned runs</span>
          <span>{fmt.n1(proj.projER)}</span>
        </div>
        <div className="kv">
          <span>Walks</span>
          <span>{fmt.n1(proj.projBB)}</span>
        </div>
        <div className="kv">
          <span>Blended FIP / ERA</span>
          <span>
            {fmt.n2(proj.fip)} / {fmt.n2(proj.eraBlend)}
          </span>
        </div>
      </div>

      <div>
        <h4>Last {p.recentLog.length} starts (IP · pitches · K)</h4>
        {p.recentLog
          .slice()
          .reverse()
          .map((start, i) => (
            <div className="kv" key={i}>
              <span>{start.date}</span>
              <span>
                {fmt.n1(start.ip)} IP · {start.pitches} p · {start.k} K
              </span>
            </div>
          ))}
        {!p.recentLog.length && (
          <div className="psub">
            No 2026 starts yet — using prior-season workload.
          </div>
        )}
      </div>
    </div>
  );
}
