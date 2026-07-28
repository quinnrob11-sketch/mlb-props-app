import { useEffect, useRef, useState } from "react";
import { fmt, slateDate } from "../lib/format.js";
import { gradeSlate } from "../data/gradeSlate.js";
import { verdictClass } from "./VerdictChip.jsx";
import {
  exportGradedHistory,
  importGradedHistory,
  listSnapshotDates,
  loadGradedDay,
  loadSnapshot,
  saveGradedDay,
  ungradedDates,
} from "./snapshotStore.js";
import ProfitBreakdown from "./ProfitBreakdown.jsx";

/** American odds → decimal. Returns null for a missing price. */
const toDecimal = (american) =>
  american == null
    ? null
    : american > 0
      ? 1 + american / 100
      : 1 + 100 / -american;

/** Pause between dates so the MLB proxy is never hammered. */
const POLITE_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attach closing-line information to freshly graded rows.
 *
 * `closeOdds` is kept alongside the percentage CLV because the profit
 * breakdown reports CLV in cents, which needs both American prices.
 */
function withClosingLines(rows, date) {
  let closes = {};
  try {
    closes = JSON.parse(localStorage.getItem(`close:${date}`) || "{}");
  } catch {}
  return rows.map((row) => {
    const close = closes[`${row.kind}:${row.playerId}:${row.market}:${row.line}`];
    const closeOdds = row.side === "over" ? close?.over : close?.under;
    // CLV: how much better your price was than the closing price.
    const clv =
      closeOdds != null && row.odds != null
        ? (toDecimal(row.odds) / toDecimal(closeOdds) - 1) * 100
        : null;
    return { ...row, closeOdds: closeOdds ?? null, clv };
  });
}

/**
 * RESULTS tab (bundle: `vh`) — grades a saved snapshot against real box scores
 * and reports hit rate plus closing line value for that date, then the
 * cumulative profit breakdown across every date ever graded.
 */
export default function ResultsView() {
  const [date, setDate] = useState(slateDate(-1));
  const [graded, setGraded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Bumped whenever the graded cache changes, which is what re-reads storage
  // for the breakdown below.
  const [version, setVersion] = useState(0);
  const [sweep, setSweep] = useState(null); // {done, total, date} while sweeping
  const cancelled = useRef(false);
  const alive = useRef(true);
  const fileInput = useRef(null);

  // `alive` is re-armed on every mount, not just the first: StrictMode mounts,
  // unmounts and remounts in development, and a ref left at false there would
  // silently swallow every setState below.
  useEffect(() => {
    alive.current = true;
    return () => {
      // A sweep in flight must stop touching state once this tab unmounts.
      alive.current = false;
      cancelled.current = true;
    };
  }, []);

  const savedDates = listSnapshotDates();

  /**
   * Grade one date and cache it. `useCache` short-circuits the network entirely
   * when the date has already been graded.
   */
  async function gradeDate(d, { useCache = false, onStatus } = {}) {
    if (useCache) {
      const cached = loadGradedDay(d);
      if (cached) return cached.rows;
    }
    const snapshot = loadSnapshot(d);
    if (!snapshot || !snapshot.rows.length) return null;
    const rows = withClosingLines(
      await gradeSlate({ date: d, snapshot, onStatus }),
      d,
    );
    saveGradedDay(d, rows);
    return rows;
  }

  async function grade(d, { useCache = false } = {}) {
    setBusy(true);
    setGraded(null);
    setStatus("");
    try {
      const rows = await gradeDate(d, { useCache, onStatus: setStatus });
      if (!alive.current) return;
      if (!rows) {
        setStatus(
          `No saved projections for ${d}. The engine snapshots every slate you load, so any slate you loaded pre-game grades automatically the next day.`,
        );
        setBusy(false);
        return;
      }
      setGraded(rows);
      setVersion((v) => v + 1);
      setStatus("");
    } catch (err) {
      if (alive.current) setStatus(String(err.message || err));
    }
    if (alive.current) setBusy(false);
  }

  const onGrade = () => grade(date);

  /**
   * Walk every saved-but-ungraded date, oldest first, caching each one.
   *
   * Sequential and paced on purpose: `gradeSlate` already fetches one boxscore
   * at a time, and a `POLITE_MS` gap between dates keeps a ten-day backfill
   * from looking like a scraper. Each await yields to the browser, so the tab
   * stays interactive and the STOP button works.
   */
  async function gradeAll() {
    const pending = ungradedDates(slateDate());
    if (!pending.length) {
      setStatus(
        "Every saved slate is already graded — the breakdown below is up to date.",
      );
      return;
    }
    cancelled.current = false;
    setBusy(true);
    setStatus("");
    let done = 0;
    for (const d of pending) {
      if (cancelled.current || !alive.current) break;
      setSweep({ done, total: pending.length, date: d });
      try {
        await gradeDate(d, {
          useCache: true,
          onStatus: (m) => alive.current && setSweep({ done, total: pending.length, date: d, inner: m }),
        });
      } catch (err) {
        // One bad date must not abandon the backfill.
        if (alive.current) setStatus(`${d}: ${String(err.message || err)}`);
      }
      done += 1;
      if (alive.current) setVersion((v) => v + 1);
      if (done < pending.length) await sleep(POLITE_MS);
    }
    if (!alive.current) return;
    setSweep(null);
    setBusy(false);
    setStatus(
      cancelled.current
        ? `Stopped after ${done} of ${pending.length} dates. The dates already graded are cached.`
        : `Graded ${done} new date${done === 1 ? "" : "s"}.`,
    );
  }

  function onExport() {
    try {
      const payload = exportGradedHistory();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `mlb-graded-history-${slateDate()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(
        `Exported ${payload.nRows} graded picks across ${payload.nDays} date${payload.nDays === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setStatus(String(err.message || err));
    }
  }

  async function onImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const res = importGradedHistory(await file.text());
      if (!alive.current) return;
      setVersion((v) => v + 1);
      setStatus(
        res.days
          ? `Imported ${res.rows} graded picks across ${res.days} date${res.days === 1 ? "" : "s"}.${res.errors.length ? ` ${res.errors.length} entr${res.errors.length === 1 ? "y" : "ies"} skipped.` : ""}`
          : res.errors.join(" ") || "Nothing to import.",
      );
    } catch (err) {
      if (alive.current) setStatus(String(err.message || err));
    }
  }

  // On mount, jump to the most recent saved slate that is not today's. A date
  // already in the graded cache renders straight from it — no refetch.
  useEffect(() => {
    const today = slateDate();
    const latest = savedDates.find((d) => d < today);
    if (latest) {
      setDate(latest);
      grade(latest, { useCache: true });
    }
  }, []);

  const called = (graded || []).filter(
    (r) => r.verdict !== "PASS" && (r.result === "WIN" || r.result === "LOSS"),
  );
  const calledWins = called.filter((r) => r.result === "WIN").length;
  const strong = called.filter((r) => r.verdict === "STRONG");
  const strongWins = strong.filter((r) => r.result === "WIN").length;
  const settled = (graded || []).filter(
    (r) => r.result === "WIN" || r.result === "LOSS" || r.result === "PUSH",
  );
  const clvs = called.map((r) => r.clv).filter((c) => c != null && isFinite(c));
  const avgClv = clvs.length
    ? clvs.reduce((a, c) => a + c, 0) / clvs.length
    : null;

  return (
    <>
      <div className="toolbar">
        <input
          type="date"
          className="search"
          style={{ width: 170 }}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy} onClick={onGrade}>
          {busy ? "GRADING…" : "GRADE SLATE"}
        </button>
        <button className="btn" disabled={busy} onClick={gradeAll}>
          GRADE ALL HISTORY
        </button>
        {sweep && (
          <button
            className="btn"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            STOP
          </button>
        )}
        <button className="btn" onClick={onExport}>
          EXPORT JSON
        </button>
        <button className="btn" onClick={() => fileInput.current?.click()}>
          IMPORT JSON
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={onImportFile}
        />
        {savedDates.length > 0 && (
          <span className="psub">
            Saved slates: {savedDates.slice(0, 6).join(" · ")}
          </span>
        )}
      </div>

      {sweep && (
        <div className="banner">
          Grading history — {sweep.done + 1} of {sweep.total} · {sweep.date}
          {sweep.inner ? ` · ${sweep.inner}` : ""}
        </div>
      )}

      {status && <div className="banner">{status}</div>}

      {graded && (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="v">
                {calledWins}–{called.length - calledWins}
              </div>
              <div className="l">All called picks</div>
            </div>
            <div className="tile">
              <div className="v">
                {called.length
                  ? Math.round((calledWins / called.length) * 100) + "%"
                  : "—"}
              </div>
              <div className="l">Hit rate</div>
            </div>
            <div className="tile">
              <div className="v">
                {strongWins}–{strong.length - strongWins}
              </div>
              <div className="l">STRONG picks</div>
            </div>
            <div className="tile">
              <div
                className={`v ${avgClv != null ? (avgClv >= 0 ? "pos" : "neg") : ""}`}
              >
                {avgClv != null ? fmt.ev(avgClv) : "—"}
              </div>
              <div className="l">Avg CLV vs close</div>
            </div>
            <div className="tile">
              <div className="v">{settled.length}</div>
              <div className="l">Props graded</div>
            </div>
          </div>

          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Prop</th>
                  <th className="num">Line</th>
                  <th className="num">Proj</th>
                  <th className="num">Actual</th>
                  <th>Side called</th>
                  <th>Result</th>
                  <th className="num">CLV</th>
                </tr>
              </thead>
              <tbody>
                {settled
                  .sort(
                    (a, b) =>
                      (a.result === "WIN" ? -1 : 1) -
                      (b.result === "WIN" ? -1 : 1),
                  )
                  .map((r, i) => (
                    <tr key={i}>
                      <td>
                        <div className="pname">{r.name}</div>
                        <div className="psub">{r.matchup}</div>
                      </td>
                      <td className="mkt">{r.label}</td>
                      <td className="num">
                        {r.line}
                        {r.alt && <span className="book altb">ALT</span>}
                      </td>
                      <td className="num">{r.proj}</td>
                      <td className="num">
                        <b>{r.actual}</b>
                      </td>
                      <td>
                        {r.verdict !== "PASS" ? (
                          <span
                            className={`vchip ${verdictClass(r.verdict, r.side)}`}
                          >
                            {r.verdict} {r.side?.toUpperCase()}
                          </span>
                        ) : (
                          <span className="vchip v-pass">PASS</span>
                        )}
                      </td>
                      <td>
                        {r.result === "WIN" ? (
                          <b className="pos">✓ WIN</b>
                        ) : r.result === "LOSS" ? (
                          <b className="neg">✕ LOSS</b>
                        ) : (
                          <span className="dim">{r.result}</span>
                        )}
                      </td>
                      <td className="num">
                        {r.clv != null && isFinite(r.clv) ? (
                          <span className={r.clv >= 0 ? "pos" : "neg"}>
                            {fmt.ev(r.clv)}
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!graded && !status && !sweep && (
        <div className="notice">
          <b>Grade any saved slate against the real box scores.</b>
          <div className="sub">
            Every time you load a slate, the engine snapshots its projections.
            Pick a date and hit GRADE SLATE to see model vs. reality — including
            hit rate on STRONG calls and closing line value.
          </div>
        </div>
      )}

      <h3 className="sechead">Cumulative profit — every graded date</h3>
      <ProfitBreakdown version={version} />
    </>
  );
}
