import { useMemo, useState } from "react";

import {
  breakdownFromStorage,
  MIN_N,
  MIN_HISTORY,
} from "../analysis/profitability.js";

/**
 * Cumulative profit breakdown (RESULTS tab).
 *
 * Answers "which aspect of the model has actually been profitable" by slicing
 * every graded pick in localStorage along one dimension at a time and ranking
 * the cells by ROI in units at the price actually taken.
 *
 * Presentational only — every number comes from src/analysis/profitability.js.
 * `version` is bumped by ResultsView whenever a date finishes grading or a file
 * is imported, which is what re-reads storage.
 */

const signed = (v, digits = 2) =>
  v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(digits);

const pct = (v, digits = 1) =>
  v == null || !isFinite(v) ? "—" : (v * 100).toFixed(digits) + "%";

const signedPct = (v, digits = 1) =>
  v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(digits) + "%";

const cents = (v) => (v == null || !isFinite(v) ? "—" : signed(v, 1) + "¢");

const sign = (v) => (v == null || !isFinite(v) ? "" : v >= 0 ? "pos" : "neg");

export default function ProfitBreakdown({ version = 0 }) {
  const [dimKey, setDimKey] = useState("market");

  // Recomputed only when a grading run or an import bumps `version`.
  const data = useMemo(
    () => breakdownFromStorage(typeof localStorage === "undefined" ? null : localStorage),
    [version],
  );

  const dim =
    data.dimensions.find((d) => d.key === dimKey) || data.dimensions[0];

  if (!data.nGraded)
    return (
      <div className="notice">
        <b>No graded picks yet.</b>
        <div className="sub">
          Hit GRADE ALL HISTORY above. Every slate you loaded pre-game is
          snapshotted, so grading walks the whole archive once and caches it —
          after that this breakdown is instant and cumulative.
        </div>
      </div>
    );

  return (
    <>
      <div className="tiles">
        <div className="tile">
          <div className={`v ${sign(data.overall.units)}`}>
            {signed(data.overall.units)}
          </div>
          <div className="l">Units at price taken</div>
        </div>
        <div className="tile">
          <div className={`v ${sign(data.overall.roi)}`}>
            {signedPct(data.overall.roi)}
          </div>
          <div className="l">ROI per unit risked</div>
        </div>
        <div className="tile">
          <div className="v">{pct(data.overall.hitRate, 1)}</div>
          <div className="l">
            Hit rate ({data.overall.wins}–{data.overall.losses}
            {data.overall.pushes ? `–${data.overall.pushes}` : ""})
          </div>
        </div>
        <div className="tile">
          <div className={`v ${sign(data.overall.avgClvCents)}`}>
            {cents(data.overall.avgClvCents)}
          </div>
          <div className="l">Avg CLV vs close</div>
        </div>
        <div className="tile">
          <div className="v">{data.nGraded}</div>
          <div className="l">Graded picks · {data.nDates} days</div>
        </div>
      </div>

      {data.headline ? (
        <div className="notice callout">
          <b>
            Most profitable: {data.headline.cell.label} (
            {data.headline.dimensionLabel.toLowerCase()}) at{" "}
            <span className={sign(data.headline.cell.roi)}>
              {signedPct(data.headline.cell.roi)}
            </span>{" "}
            ROI over {data.headline.cell.decided} settled picks.
          </b>
          <div className="sub">
            {signed(data.headline.cell.units)} units, hit rate{" "}
            {pct(data.headline.cell.hitRate)} (95% CI{" "}
            {pct(data.headline.cell.ci?.lo, 0)}–{pct(data.headline.cell.ci?.hi, 0)}
            ), CLV {cents(data.headline.cell.avgClvCents)}. That interval is the
            honest width of what you know — attack this only if its bottom end
            still clears your break-even price.
          </div>
        </div>
      ) : (
        <div className="banner">{data.message}</div>
      )}

      <div className="toolbar">
        <div className="chips">
          {data.dimensions.map((d) => (
            <button
              key={d.key}
              className={`chip ${d.key === dim.key ? "on" : ""}`}
              onClick={() => setDimKey(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="psub">
        {dim.blurb} Ranked by ROI; a cell needs {MIN_N} settled picks before it
        is called an edge, and the whole history needs {MIN_HISTORY} before any
        leader is named.
        {dim.nUnknown > 0 && (
          <>
            {" "}
            {dim.nUnknown} pick{dim.nUnknown === 1 ? "" : "s"} carry no value for
            this dimension and are excluded.
          </>
        )}
      </div>

      {!dim.cells.length ? (
        <div className="notice">
          <b>Not enough data yet for {dim.label.toLowerCase()}.</b>
          <div className="sub">
            No graded pick records this field. Slates snapshotted by older builds
            do not carry it; it fills in from the next slate you load.
          </div>
        </div>
      ) : (
        <>
          {!dim.enough && (
            <div className="banner">
              Not enough data yet: no {dim.label.toLowerCase()} value has reached{" "}
              {MIN_N} settled picks, so nothing below is ranked as an edge. The
              rows are shown for shape only.
            </div>
          )}
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{dim.label}</th>
                  <th className="num">n</th>
                  <th className="num">W–L–P</th>
                  <th className="num">Hit rate</th>
                  <th className="num">95% CI</th>
                  <th className="num">Units</th>
                  <th className="num">ROI</th>
                  <th className="num">CLV</th>
                </tr>
              </thead>
              <tbody>
                {dim.cells.map((c) => (
                  <tr key={c.value}>
                    <td>
                      <div className="pname">{c.label}</div>
                      {!c.qualified && (
                        <div className="psub">
                          small sample — under {MIN_N} settled
                        </div>
                      )}
                    </td>
                    <td className="num">{c.n}</td>
                    <td className="num">
                      {c.wins}–{c.losses}
                      {c.pushes ? `–${c.pushes}` : ""}
                    </td>
                    <td className="num">{pct(c.hitRate)}</td>
                    <td className="num dim">
                      {c.ci
                        ? `${pct(c.ci.lo, 0)}–${pct(c.ci.hi, 0)}`
                        : "—"}
                    </td>
                    <td className="num">
                      <span className={c.qualified ? sign(c.units) : "dim"}>
                        {signed(c.units)}
                      </span>
                    </td>
                    <td className="num">
                      <b className={c.qualified ? sign(c.roi) : "dim"}>
                        {signedPct(c.roi)}
                      </b>
                    </td>
                    <td className="num">
                      <span className={c.qualified ? sign(c.avgClvCents) : "dim"}>
                        {cents(c.avgClvCents)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
