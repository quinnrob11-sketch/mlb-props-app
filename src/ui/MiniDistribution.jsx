// A sparkline of a projection's outcome distribution.
//
// The expanded pitcher and batter panels used to be four columns of label/value
// text — every projection reduced to a single number with no indication of how
// confident it was. That is the least useful form for the question actually
// being asked, because the mean is the one thing the book already knows. A
// pitcher projected for 5.4 strikeouts into a 5.5 line is a completely
// different bet depending on whether 5.4 is a tight peak or a wide smear, and a
// column of numbers cannot tell you which.
//
// This draws the same `dist` the edge engine prices from, so the shape shown is
// the shape used. It is deliberately small and unlabelled: it sits under a
// number that is already stated, and its job is to convey spread at a glance,
// not to be read off.

const WIDTH = 120;
const HEIGHT = 18;

export default function MiniDistribution({ distFn, mean }) {
  // `dist` holds closures, which do not survive the JSON round-trip into
  // localStorage, so a slate restored from cache has none. The row degrades to
  // its bare number rather than rendering an empty box.
  if (typeof distFn !== 'function' || mean == null || isNaN(mean)) return null;

  // Window follows the MASS, not the mean. A symmetric window around the mean
  // clipped the right tail on the skewed markets — earned runs kept only 86% of
  // its probability, which is exactly the part of the distribution someone
  // looking at an over is interested in. Walk the survival function out to the
  // 1st and 99th percentiles instead, so every market shows essentially all of
  // itself whatever its shape.
  const CAP = 40;
  let lo = 0;
  while (lo < CAP && distFn(lo + 0.5) > 0.99) lo++;
  let hi = lo;
  while (hi < CAP && distFn(hi + 0.5) > 0.01) hi++;
  // Never degenerate to a couple of bars on a very tight distribution.
  if (hi - lo < 4) hi = lo + 4;

  const bars = [];
  for (let k = lo; k <= hi; k++) {
    const a = distFn(k - 0.5);
    const b = distFn(k + 0.5);
    if (a == null || b == null || isNaN(a) || isNaN(b)) return null;
    bars.push(Math.max(0, a - b));
  }
  const peak = Math.max(...bars, 1e-6);
  const barWidth = WIDTH / bars.length;

  return (
    <svg
      className="minidist"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {bars.map((p, i) => {
        const h = Math.max(0.8, (p / peak) * HEIGHT);
        // The bucket the mean falls in is the accent; the rest is the spread
        // around it, so the eye lands on the projection and reads outward.
        const isMean = lo + i === Math.round(mean);
        return (
          <rect
            key={i}
            x={i * barWidth + 0.4}
            y={HEIGHT - h}
            width={Math.max(0.8, barWidth - 0.8)}
            height={h}
            className={isMean ? 'peak' : ''}
          />
        );
      })}
    </svg>
  );
}
