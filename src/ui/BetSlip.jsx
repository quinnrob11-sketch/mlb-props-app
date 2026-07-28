import { fmt } from "../lib/format.js";
import { probToAmerican } from "../lib/odds.js";

/**
 * Parlay slip (bundle: `ph`).
 *
 * Legs are combined naively: decimal odds multiply, and model probabilities
 * multiply as if the legs were independent. `edge.usedOver` is the blended
 * (market-respecting) probability actually priced; it falls back to the raw
 * model probability when no blend was applied.
 */
export default function BetSlip({ slip, toggleSlip, clear, bankroll }) {
  const legs = Object.values(slip);

  let decimal = 1;
  let prob = 1;
  for (const leg of legs) {
    const edge = leg.edge;
    const dec = edge.odds > 0 ? 1 + edge.odds / 100 : 1 + 100 / -edge.odds;
    decimal *= dec;
    const over = edge.usedOver ?? edge.modelOver;
    prob *= edge.side === "over" ? over : 1 - over;
  }
  const american =
    decimal >= 2
      ? Math.round((decimal - 1) * 100)
      : Math.round(-100 / (decimal - 1));
  const ev = (prob * decimal - 1) * 100;

  return (
    <aside className="slip">
      <h3>
        🧾 SLIP ({legs.length} leg{legs.length > 1 ? "s" : ""})
      </h3>
      {legs.map((leg) => (
        <div className="slip-row" key={leg.key}>
          <span>
            {leg.name} {leg.short} {leg.edge.side === "over" ? "O" : "U"}
            {leg.line}{" "}
            <span className="dim">
              ({fmt.odds(leg.edge.odds)}
              {leg.book ? ` ${leg.book}` : ""}
              {leg.edge.kelly > 0
                ? ` · ${(leg.edge.kelly * bankroll).toFixed(1)}u`
                : ""}
              )
            </span>
          </span>
          <button
            className="x"
            onClick={() => toggleSlip(leg)}
            aria-label="remove"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="slip-tot">
        <span>Combined odds</span>
        <b>{legs.length ? fmt.odds(american) : "—"}</b>
      </div>
      <div className="slip-tot">
        <span>Model parlay prob</span>
        <b>{fmt.pct(prob)}</b>
      </div>
      <div className="slip-tot">
        <span>Model parlay EV</span>
        <b className={ev >= 0 ? "pos" : "neg"}>{fmt.ev(ev)}</b>
      </div>
      <div className="slip-tot">
        <span className="psub">
          Fair price: {fmt.odds(probToAmerican(prob))}
        </span>
        <button className="addbtn" onClick={clear}>
          Clear
        </button>
      </div>
    </aside>
  );
}
