// Model outcome distribution bar chart (minified: `oh`).
//
// `distFn(x)` is the model's survival function: P(outcome > x). The chart
// differences it across each bucket to get a pmf bar, marks the book line and
// captions the two tail probabilities.

import { fmt } from '../lib/format.js';

// SVG geometry (user units; the viewBox is stretched to fit its container).
const WIDTH = 300;
const HEIGHT = 44;
const BAR_GAP = 2;

export default function DistributionChart({ distFn, line, market, side }) {
  if (!distFn || line == null) return null;

  // Outs are recorded in thirds of an inning, so bucket them 3 at a time and
  // always show a full 9-inning start (27 outs). Everything else is a
  // per-unit count, shown out to line + 5 (min 8, max 14).
  const step = market === 'pitcher_outs' ? 3 : 1;
  const maxK = market === 'pitcher_outs' ? 27 : Math.min(14, Math.max(8, Math.ceil(line + 5)));

  const bars = [];
  for (let k = 0; k <= maxK; k += step) {
    // P(k bucket) = P(X > k-0.5) - P(X > k+step-0.5), continuity-corrected.
    const atLow = distFn(k - 0.5);
    const atHigh = distFn(k + step - 0.5);
    if (atLow == null || atHigh == null || isNaN(atLow) || isNaN(atHigh)) return null;
    bars.push({ k, p: Math.max(0, atLow - atHigh) });
  }

  // Floor the peak at 0.001 so an all-but-empty distribution still scales.
  const peak = Math.max(...bars.map((b) => b.p), 0.001);
  const barWidth = WIDTH / bars.length;
  // x of the book line, placed at the bucket boundary (hence the +0.5).
  const markX = ((line - bars[0].k) / step + 0.5) * barWidth;
  const pOver = distFn(line);

  return (
    <div className="distwrap">
      <svg
        className="distchart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT + 14}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Model outcome distribution"
      >
        {bars.map((bar, i) => {
          // 1.5px floor keeps near-zero buckets visible.
          const h = Math.max(1.5, (bar.p / peak) * HEIGHT);
          return (
            <rect
              key={bar.k}
              x={i * barWidth + BAR_GAP}
              y={HEIGHT - h}
              width={Math.max(1, barWidth - BAR_GAP * 2)}
              height={h}
              rx="2"
              className={bar.k > line ? 'over' : 'under'}
            />
          );
        })}
        <line className="mark" x1={markX} y1="0" x2={markX} y2={HEIGHT} />
        <text x="2" y={HEIGHT + 11}>
          {bars[0].k}
        </text>
        <text x={WIDTH - 14} y={HEIGHT + 11}>
          {bars[bars.length - 1].k}
        </text>
        <text x={Math.min(WIDTH - 60, Math.max(4, markX + 4))} y="9">
          {'line '}
          {line}
        </text>
      </svg>
      <div className="dist-caption">
        {'model distribution · '}
        <i className="u">
          {'■ under '}
          {fmt.pct(1 - pOver)}
        </i>
        {' · '}
        <i className="o">
          {'■ over '}
          {fmt.pct(pOver)}
        </i>
        {side ? (
          <span>
            {' · playing the '}
            <i className={side === 'over' ? 'side-over' : 'side-under'}>{side.toUpperCase()}</i>
          </span>
        ) : null}
      </div>
    </div>
  );
}
