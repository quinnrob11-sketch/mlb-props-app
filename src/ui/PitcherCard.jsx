import { fmt } from "../lib/format.js";
import MiniDistribution from "./MiniDistribution.jsx";

// Which projections get a shape drawn under them, and the `dist` key each one
// is priced from. Order matches the market list the board shows.
const PITCHER_DIST_ROWS = [
  { label: "Strikeouts", key: "projK", distKey: "k" },
  { label: "Outs recorded", key: "projOuts", distKey: "outs" },
  { label: "Hits allowed", key: "projH", distKey: "hits" },
  { label: "Earned runs", key: "projER", distKey: "er" },
  { label: "Walks", key: "projBB", distKey: "bb" },
];

/**
 * Expanded detail panel for a pitcher row (bundle: `ch`).
 *
 * Rendered inside the `detail` row of the props table. Shows the season line,
 * the workload model that drives every pitcher projection, the full projection
 * set, and the recent game log the pitch budget was derived from.
 */
export default function PitcherCard({ p }) {
  const proj = p.proj || {};
  // Defaulted rather than destructured off `proj` directly: see the note by the
  // workload block below.
  const workload = proj.workload || {};
  // Same reasoning as `workload`: a slate restored from an older cache, or a
  // pitcher the stats fetch dropped, can be missing this. An expanded card that
  // renders "no starts" is fine; one that unmounts the app is not.
  const recentLog = Array.isArray(p.recentLog) ? p.recentLog : [];
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
        {/* Guarded. `workload` is always present on a freshly projected slate,
            but a slate RESTORED from localStorage was written by whichever
            version the user last ran, and the projection shape has changed
            across v20-v22. Reading through it unguarded meant one missing
            field unmounted the entire app — a blank page, not a broken card.
            The cache key is versioned now too, so this is belt and braces. */}
        <div className="kv">
          <span>Pitch budget (recent-weighted)</span>
          <span>{workload.budget != null ? Math.round(workload.budget) : '—'}</span>
        </div>
        <div className="kv">
          <span>Pitches / BF</span>
          <span>{fmt.n2(workload.pPerBF)}</span>
        </div>
        <div className="kv">
          <span>BF / IP</span>
          <span>{fmt.n2(workload.bfPerIp)}</span>
        </div>
        <div className="kv">
          <span>IP from budget · recent avg IP</span>
          <span>
            {fmt.n1(workload.ipBudget)} · {fmt.n1(workload.recentIp)}
          </span>
        </div>
        <div className="kv">
          <span>
            <b>Projected IP / BF / pitches</b>
          </span>
          <span>
            <b>
              {fmt.n1(proj.projIP)} / {fmt.int(proj.projBF)} /{" "}
              {fmt.int(proj.projPitches)}
            </b>
          </span>
        </div>
        <div className="kv">
          <span>Projected strikes / balls</span>
          <span>
            {fmt.int(proj.projStrikes)} / {fmt.int(proj.projBalls)}
          </span>
        </div>
      </div>

      <div>
        <h4>Projections (all props)</h4>
        {/* Each projection now carries the SHAPE behind it, not just the mean.
            A pitcher projected for 5.4 strikeouts against a 5.5 line is a very
            different bet depending on whether that 5.4 is a tight peak or a
            wide smear, and a column of single numbers cannot say which. The
            sparkline is the same distribution the edge engine prices from, so
            what you see is what it used. `dist` is dropped when a slate is
            restored from cache — the row degrades to the bare number. */}
        {PITCHER_DIST_ROWS.map(({ label, key, distKey }) => (
          <div className="projrow" key={key}>
            <div className="kv">
              <span>{label}</span>
              <span>{fmt.n1(proj[key])}</span>
            </div>
            <MiniDistribution distFn={proj.dist?.[distKey]} mean={proj[key]} />
          </div>
        ))}
        <div className="kv">
          <span>Blended FIP / ERA</span>
          <span>
            {fmt.n2(proj.fip)} / {fmt.n2(proj.eraBlend)}
          </span>
        </div>
      </div>

      <div>
        <h4>Last {recentLog.length} starts (IP · pitches · K)</h4>
        {recentLog
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
        {!recentLog.length && (
          <div className="psub">
            No 2026 starts yet — using prior-season workload.
          </div>
        )}
      </div>
    </div>
  );
}
