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
