// Model outcome distribution (minified original: `oh`).
//
// `distFn(x)` is the model's survival function: P(outcome > x). The chart
// differences it across each bucket to get a pmf bar, marks the book line, and
// marks where the model's own projection sits relative to it.
//
// REBUILT(v22.6). Two things were wrong with the original beyond taste:
//
//   1. `preserveAspectRatio="none"` stretched the SVG to its container, which
//      is right for the bars and wrong for everything else — the tick labels
//      and the line caption were horizontally distorted by whatever width the
//      card happened to be, and the distortion changed between the desktop
//      grid and a phone.
//   2. It drew the book line but never the PROJECTION. The whole question the
//      chart exists to answer is "which side of the line does the model sit
//      on, and by how much", and you could not read that off it.
//
// The fix for (1) is to stop putting text in a stretched SVG at all: bars are
// SVG (they should stretch), labels are HTML (they should not).

import { fmt } from '../lib/format.js';

// Bar-band geometry, in user units. Height is real; width is stretched to the
// container, which is exactly what we want for bars and nothing else.
const WIDTH = 300;
const HEIGHT = 52;
const BAR_GAP = 1.5;

export default function DistributionChart({ distFn, line, market, side, proj }) {
  if (!distFn || line == null) return null;

  // Outs are recorded in thirds of an inning, so bucket them 3 at a time and
  // always show a full 9-inning start (27 outs). Everything else is a per-unit
  // count, shown out to line + 5 (min 8, max 14).
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
  const first = bars[0].k;
  const last = bars[bars.length - 1].k;

  // Map a value in outcome space to a fraction of the chart's width. Used for
  // both the SVG marks and the HTML labels, so they cannot drift apart.
  const frac = (value) => ((value - first) / step + 0.5) / bars.length;
  const lineFrac = Math.min(1, Math.max(0, frac(line)));
  const projFrac = proj != null ? Math.min(1, Math.max(0, frac(proj))) : null;

  const pOver = distFn(line);
  // Which way the model leans, independent of which side is being played.
  const modelLeansOver = pOver >= 0.5;

  return (
    <div className="distwrap">
      <div className="dist-plot">
        <svg
          className="distchart"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Model distribution: ${fmt.pct(pOver)} over ${line}`}
        >
          {bars.map((bar, i) => {
            // 1.5px floor keeps near-zero buckets visible.
            const h = Math.max(1.5, (bar.p / peak) * HEIGHT);
            const isOver = bar.k > line;
            // The side actually being played is solid; the other side is a
            // wash. When no side is chosen both are a wash, so the chart never
            // implies a recommendation the engine did not make.
            const played = side ? (side === 'over') === isOver : null;
            return (
              <rect
                key={bar.k}
                x={i * barWidth + BAR_GAP}
                y={HEIGHT - h}
                width={Math.max(1, barWidth - BAR_GAP * 2)}
                height={h}
                className={`bar ${isOver ? 'over' : 'under'} ${played === false ? 'muted' : ''}`}
              />
            );
          })}
        </svg>

        {/* Marks are HTML so they stay crisp and unstretched at any width. */}
        <div className="dist-line" style={{ left: `${lineFrac * 100}%` }} />
        {projFrac != null && (
          <div
            className={`dist-proj ${modelLeansOver ? 'over' : 'under'}`}
            style={{ left: `${projFrac * 100}%` }}
            title={`model projection ${fmt.n1(proj)}`}
          />
        )}
      </div>

      <div className="dist-axis">
        <span>{first}</span>
        <span className="dist-line-label" style={{ left: `${lineFrac * 100}%` }}>
          line {line}
        </span>
        <span>{last}</span>
      </div>

      <div className="dist-caption">
        <i className="u">under {fmt.pct(1 - pOver)}</i>
        <i className="o">over {fmt.pct(pOver)}</i>
        {proj != null && (
          <span className="dist-proj-note">
            model {fmt.n1(proj)}
            {' · '}
            {Math.abs(proj - line) < 0.05
              ? 'on the line'
              : `${fmt.n1(Math.abs(proj - line))} ${proj > line ? 'above' : 'below'}`}
          </span>
        )}
        {side ? (
          <span className={`dist-side ${side === 'over' ? 'side-over' : 'side-under'}`}>
            playing {side.toUpperCase()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
