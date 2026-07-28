import { fmt } from "../lib/format.js";

/**
 * Expanded detail panel for a batter row (bundle: `dh`).
 *
 * Season line + matchup context, the per-game projection set, and a handful of
 * threshold probabilities read straight off the model's distributions.
 */
export default function BatterCard({ b }) {
  const proj = b.proj;
  return (
    <div className="detail-grid">
      <div>
        <h4>Season</h4>
        {b.season ? (
          <>
            <div className="kv">
              <span>AVG / OBP / SLG</span>
              <span>
                {b.season.avg} / {b.season.obp} / {b.season.slg}
              </span>
            </div>
            <div className="kv">
              <span>PA · HR · SB</span>
              <span>
                {b.season.pa} · {b.season.hr} · {b.season.sb}
              </span>
            </div>
          </>
        ) : (
          <div className="psub">
            No 2026 batting data — projections lean on 2025 + league priors.
          </div>
        )}
        <div className="kv">
          <span>Matchup</span>
          <span>
            {b.batSide} vs {b.vsHand}HP{" "}
            {proj.platoon > 1
              ? "(platoon +)"
              : proj.platoon < 1
                ? "(platoon −)"
                : ""}
          </span>
        </div>
        <div className="kv">
          <span>Expected PA (slot #{b.slot})</span>
          <span>{fmt.n1(proj.pa)}</span>
        </div>
      </div>

      <div>
        <h4>Per-game projections</h4>
        <div className="kv">
          <span>Hits</span>
          <span>{fmt.n2(proj.projH)}</span>
        </div>
        <div className="kv">
          <span>Total bases</span>
          <span>{fmt.n2(proj.projTB)}</span>
        </div>
        <div className="kv">
          <span>Home runs</span>
          <span>{fmt.n2(proj.projHR)}</span>
        </div>
        <div className="kv">
          <span>H+R+RBI</span>
          <span>{fmt.n2(proj.projHRR)}</span>
        </div>
        <div className="kv">
          <span>Strikeouts</span>
          <span>{fmt.n2(proj.projK)}</span>
        </div>
        <div className="kv">
          <span>Stolen bases</span>
          <span>{fmt.n2(proj.projSB)}</span>
        </div>
      </div>

      <div>
        <h4>Hit probabilities</h4>
        <div className="kv">
          <span>P(1+ hit)</span>
          <span>{fmt.pct(proj.dist.hits(0.5))}</span>
        </div>
        <div className="kv">
          <span>P(2+ hits)</span>
          <span>{fmt.pct(proj.dist.hits(1.5))}</span>
        </div>
        <div className="kv">
          <span>P(HR)</span>
          <span>{fmt.pct(proj.dist.hr(0.5))}</span>
        </div>
        <div className="kv">
          <span>P(2+ TB)</span>
          <span>{fmt.pct(proj.dist.tb(1.5))}</span>
        </div>
        <div className="kv">
          <span>P(2+ HRR)</span>
          <span>{fmt.pct(proj.dist.hrr(1.5))}</span>
        </div>
      </div>
    </div>
  );
}
