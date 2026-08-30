// The verdict pill shown on every prop row/card (minified: `Co`), plus its
// class-name helper (`od`).

/**
 * CSS class for a verdict/side pair.
 *
 * `v-over` / `v-under` colour the chip by the side being played; STRONG calls
 * additionally get `fill` (solid rather than outlined). Anything without a
 * side, or an explicit PASS, is the neutral `v-pass`.
 */
export function verdictClass(verdict, side) {
  if (!side || verdict === 'PASS') return 'v-pass';
  const base = side === 'over' ? 'v-over' : 'v-under';
  return verdict === 'STRONG' ? `${base} fill` : base;
}

export default function VerdictChip({ edge }) {
  if (!edge || edge.verdict === 'PASS' || !edge.side)
    return <span className="vchip v-pass">PASS</span>;

  return (
    <span className={`vchip ${verdictClass(edge.verdict, edge.side)}`}>
      {edge.verdict} {edge.side.toUpperCase()}
    </span>
  );
}

/**
 * The reason a LEAN/PASS is not rated higher, rendered as a dim annotation
 * beside the verdict chip: a +10.8% EV wearing a bare LEAN reads as a bug;
 * "LEAN · model >15pts off market" reads as intended caution.
 *
 * First reason inline, the full demotion list in the title. Renders nothing on
 * a clean ladder or on STRONG/SOLID (their reasons never demoted them to a
 * verdict that needs explaining).
 */
export function WhyNote({ edge }) {
  if (!edge?.why?.length) return null;
  if (edge.verdict !== 'LEAN' && edge.verdict !== 'PASS') return null;
  return (
    <span className="vwhy" title={edge.why.join(' · ')}>
      {edge.why[0]}
    </span>
  );
}

/**
 * The track-record chip: what the model has PROVEN in this market at this
 * line, from the Aug 3-22 replay (src/model/trackRecord.js). This is the
 * "is this real?" answer, per row: ✓ PROVEN takes on its own; ◆ TOP PICKS
 * ONLY earns only near the top of the ranked board; ✕ NO EDGE is shown for
 * information and should not be bet on model probability.
 */
import { trackRecord } from '../model/trackRecord.js';

export function TrackChip({ market, line }) {
  const tr = trackRecord(market, line);
  if (!tr) return null;
  return (
    <span className={`tchip t-${tr.tier}${tr.measured ? '' : ' t-unmeasured'}`} title={tr.note}>
      {tr.label}
    </span>
  );
}
