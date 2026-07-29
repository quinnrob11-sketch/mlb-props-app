// Maker view: the Kalshi order book behind a row, and where a resting order
// could sit inside it.
//
// DISPLAY ONLY. This component reads an order book and does arithmetic. It
// places nothing, prepares nothing and authorises nothing — `restCents` is a
// number on a screen, and there is no control anywhere in this file that could
// become an order.
//
// When there is no book (Kalshi does not list the prop, the contract could not
// be matched to a player, the feed is down, or only one side is quoted) the
// panel says which of those happened. It never turns a midpoint or a last trade
// into a spread.

import { useEffect, useMemo, useState } from "react";

import {
  fetchKalshiMarkets,
  marketQuote,
  matchKalshiMarket,
  seriesForMarket,
} from "../lib/kalshi.js";
import { describeMaker, fmtCents, kalshiOffer, makerPlan } from "./makerMode.js";

/**
 * Load the Kalshi books for whatever rows are on screen.
 *
 * One fetch per series, shared across every row, and only while maker mode is
 * on — taker mode costs nothing. Failures are surfaced, not swallowed: a row
 * with no book must say so rather than quietly showing nothing.
 *
 * @param {object[]} rows
 * @param {boolean} enabled
 * @returns {{status: "idle"|"loading"|"ready"|"error", error: string|null,
 *   entries: Map<string, {quote: object|null, match: object}>}}
 */
export function useKalshiBooks(rows, enabled) {
  // A stable primitive so a re-sorted row array does not refetch.
  const seriesKey = useMemo(() => {
    const set = new Set();
    for (const row of rows || []) {
      if (!kalshiOffer(row)) continue;
      const series = seriesForMarket(row.market);
      if (series) set.add(series);
    }
    return [...set].sort().join(",");
  }, [rows]);

  const [state, setState] = useState({ status: "idle", markets: [], error: null });

  useEffect(() => {
    if (!enabled || !seriesKey) {
      setState({ status: "idle", markets: [], error: null });
      return undefined;
    }
    const controller = new AbortController();
    let live = true;
    setState({ status: "loading", markets: [], error: null });
    fetchKalshiMarkets({
      seriesTickers: seriesKey.split(","),
      signal: controller.signal,
    })
      .then((res) => {
        if (!live) return;
        setState({
          status: "ready",
          markets: res.markets,
          error: res.errors.length ? res.errors[0].error : null,
        });
      })
      .catch((err) => {
        if (!live) return;
        setState({
          status: "error",
          markets: [],
          error: String(err?.message || err),
        });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [enabled, seriesKey]);

  const entries = useMemo(() => {
    const map = new Map();
    if (state.status !== "ready") return map;
    for (const row of rows || []) {
      if (!kalshiOffer(row) || map.has(row.key)) continue;
      const match = matchKalshiMarket({
        player: row.name,
        market: row.market,
        line: row.line,
        markets: state.markets,
      });
      map.set(row.key, {
        match,
        quote: match.status === "matched" ? marketQuote(match.market) : null,
      });
    }
    return map;
  }, [rows, state]);

  return { status: state.status, error: state.error, entries };
}

/** Where fair and a resting order sit between the bid and the ask, 0..100%. */
function pct(plan, cents) {
  if (cents == null || !plan.spreadCents) return null;
  const raw = ((cents - plan.bidCents) / plan.spreadCents) * 100;
  return Math.max(0, Math.min(100, raw));
}

/**
 * @param {object} props
 * @param {object} props.row
 * @param {{quote: object|null, match: object}|undefined} props.entry
 * @param {"idle"|"loading"|"ready"|"error"} props.status - The fetch status.
 * @param {string|null} [props.error]
 * @param {boolean} [props.compact]
 */
export default function MakerPanel({ row, entry, status, error, compact = false }) {
  if (!kalshiOffer(row))
    return (
      <div className="maker">
        <span className="dim">
          No order book — Kalshi does not list this prop, so there is nothing
          to rest inside. Switch to Taker for the venues quoting this line.
        </span>
      </div>
    );

  // Kalshi quotes a prop but this app has no VERIFIED series mapping for the
  // market, so there is no book to fetch. Saying so beats spinning forever.
  if (!seriesForMarket(row.market))
    return (
      <div className="maker">
        <span className="dim">
          No order book — this market has no verified Kalshi series, so no
          bid/ask can be shown for it.
        </span>
      </div>
    );

  if (status === "loading" || status === "idle")
    return (
      <div className="maker">
        <span className="dim">Loading the Kalshi book…</span>
      </div>
    );

  if (status === "error")
    return (
      <div className="maker">
        <span className="dim">
          Kalshi order book unavailable{error ? ` (${error})` : ""} — no bid/ask
          to show. Nothing here is inferred from the last trade.
        </span>
      </div>
    );

  const plan = makerPlan({ row, quote: entry?.quote ?? null });
  const matchReason =
    entry && entry.match && entry.match.status !== "matched"
      ? entry.match.reason
      : null;

  if (plan.status !== "ok" && plan.status !== "no-room")
    return (
      <div className="maker">
        <span className="dim">{matchReason ? `No Kalshi book: ${matchReason}.` : plan.reason}</span>
      </div>
    );

  const fairPct = pct(plan, plan.fairCents);
  const restPct = pct(plan, plan.restCents);

  return (
    <div className="maker" title={describeMaker(plan)}>
      <div className="makerline">
        <span className="vchip v-venue kal">
          KAL {plan.contract}
          {plan.threshold != null ? ` ${plan.threshold}+` : ""}
        </span>
        <b>
          {fmtCents(plan.bidCents)} / {fmtCents(plan.askCents)}
        </b>
        <span className="dim">
          {fmtCents(plan.spreadCents)} wide
          {plan.depth?.volume != null ? ` · vol ${plan.depth.volume}` : ""}
        </span>
      </div>

      <div className="spreadbar" aria-hidden="true">
        {fairPct != null && (
          <i className="fairmark" style={{ left: `${fairPct}%` }} />
        )}
        {restPct != null && (
          <i className="restmark" style={{ left: `${restPct}%` }} />
        )}
      </div>

      <div className="makerline">
        <span>
          model fair <b className="pos">{fmtCents(plan.fairCents)}</b>{" "}
          <span className="dim">
            {plan.fairInside
              ? "inside the spread"
              : plan.fairCents >= plan.askCents
                ? "at or above the ask"
                : "at or below the bid"}
          </span>
        </span>
      </div>

      <div className="makerline">
        {plan.status === "no-room" ? (
          <span className="dim">{plan.reason}</span>
        ) : (
          <span>
            rest a bid at <b>{fmtCents(plan.restCents)}</b>{" "}
            <span className="dim">
              {plan.restImproves ? "best in book" : "queued behind the bid"} ·{" "}
              {fmtCents(plan.restEdgeCents)} under fair · crossing now costs{" "}
              {fmtCents(plan.takerCents)}
            </span>
          </span>
        )}
      </div>

      {!compact && (
        <div className="vnote">
          Display only — this shows where a price could sit. Nothing is sent to
          Kalshi.
        </div>
      )}
    </div>
  );
}
