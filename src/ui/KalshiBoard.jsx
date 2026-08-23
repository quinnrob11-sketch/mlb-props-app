// KALSHI board — the straight-through view.
//
// Everything else in this app prices against sportsbooks. This tab shows the
// full exchange pipeline for every row that maps to a Kalshi market, in the
// order the automation applies it:
//
//     model probability
//       -> calibration correction   (measured, src/trade/calibration.js)
//         -> live Kalshi bid/ask
//           -> edge, minus the fee hurdle
//             -> quarter-Kelly size, capped by every risk limit
//
// The point is that each step is VISIBLE. The single most useful column is
// "real edge", because it is routinely a different number from the raw edge and
// occasionally the opposite sign — on batter_hits_runs_rbis@0.5 the model reads
// 3.35 points high in both backtested seasons, so an apparent 4-point edge is
// really negative after fees. A board that showed only the raw edge would be
// pointing you at exactly the trades that lose.
//
// READ-ONLY. Nothing here places an order, and nothing here can. Execution
// lives in src/trade/execution.js behind an explicit environment gate.

import { useMemo, useState, useEffect, useCallback } from 'react';

import { fmt } from '../lib/format.js';
import { seriesForMarket, marketQuote, matchKalshiMarket } from '../lib/kalshi.js';
import { useKalshiBooks } from './MakerPanel.jsx';
import { calibrate, isMeasured } from '../trade/calibration.js';
import { buildSignal } from '../trade/signals.js';
import { sizeOrder, DEFAULT_LIMITS } from '../trade/risk.js';
import { feePerContractCents } from '../trade/fees.js';

/**
 * The local execution bridge. Orders are placed by a process on YOUR machine
 * holding YOUR key — never by this page, and never by the deployment.
 *
 * A private key cannot live safely in a browser (any injected script can read
 * localStorage, and signing in page context keeps it in memory for the life of
 * the tab), and a Vercel route would be a PUBLIC endpoint able to spend your
 * money. Loopback is the only arrangement where the key never transits the
 * network at all.
 *
 * Start it with:  node tools/kalshi-bridge.mjs
 */
const BRIDGE = 'http://127.0.0.1:8787';

/** Poll the bridge so the UI can say honestly whether clicking will do anything. */
function useBridge() {
  const [state, setState] = useState({ status: 'checking', mode: null });
  useEffect(() => {
    let live = true;
    const check = () =>
      fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .then((b) => live && setState({ status: 'up', mode: b.mode, ledger: b }))
        .catch(() => live && setState({ status: 'down', mode: null }));
    check();
    const id = setInterval(check, 15000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return state;
}

/**
 * The automation daemon's read-only status endpoint.
 *
 * The daemon is STARTED AND STOPPED from the shell that owns it, never from
 * here — the control over a process that spends money belongs with the process,
 * not in a web page that anyone with the URL can reach. What this gives you is
 * visibility: what mode it is in, what it has done, and whether it is still
 * alive. There is no route on the other end that mutates anything.
 *
 * Start it with:  npm run auto     (or double-click start-automation.cmd)
 */
const DAEMON = 'http://127.0.0.1:8788';

function useDaemon() {
  const [state, setState] = useState({ status: 'checking', data: null });
  useEffect(() => {
    let live = true;
    const check = () =>
      fetch(`${DAEMON}/`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .then((d) => live && setState({ status: 'up', data: d }))
        .catch(() => live && setState({ status: 'down', data: null }));
    check();
    // 5s: fast enough that the feed feels live, slow enough to be free.
    const id = setInterval(check, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return state;
}

/** Rows that could possibly map: a half-integer line on a mapped series. */
function candidateRows(rows) {
  return (rows || []).filter(
    (row) =>
      row.line != null &&
      Math.abs(row.line % 1) === 0.5 &&
      seriesForMarket(row.market),
  );
}

export default function KalshiBoard({ rows, bankroll = 1000 }) {
  const bridge = useBridge();
  const daemon = useDaemon();
  const [placed, setPlaced] = useState({});
  const candidates = useMemo(() => candidateRows(rows), [rows]);

  const place = useCallback(
    async (play) => {
      const key = play.row.key;
      setPlaced((s) => ({ ...s, [key]: { status: 'sending' } }));
      try {
        const res = await fetch(`${BRIDGE}/order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Only WHICH market and WHICH direction. The bridge re-prices from the
          // live book and re-runs every risk limit before it signs anything, so
          // nothing here can talk it into an order the rules would refuse.
          body: JSON.stringify({
            ticker: play.ticker,
            market: play.row.market,
            line: play.row.line,
            modelProb: play.rawProbOnSide != null && play.side === 'yes'
              ? play.rawProbOnSide
              : 1 - play.rawProbOnSide,
            gameId: play.row.gamePk ?? play.row.game?.gamePk,
            playerId: play.row.playerId,
          }),
        });
        const body = await res.json();
        setPlaced((s) => ({
          ...s,
          [key]: res.ok
            ? { status: 'done', detail: body }
            : { status: 'refused', detail: body?.error || `HTTP ${res.status}` },
        }));
      } catch (err) {
        setPlaced((s) => ({
          ...s,
          [key]: { status: 'refused', detail: String(err?.message || err) },
        }));
      }
    },
    [],
  );
  const books = useKalshiBooks(candidates, true);

  const plays = useMemo(() => {
    if (books.status !== 'ready') return [];
    const out = [];
    for (const row of candidates) {
      const match = matchKalshiMarket({
        player: row.name,
        market: row.market,
        line: row.line,
        markets: books.markets ?? [],
      });
      const entry = books.entries.get(row.key);
      const quote = entry?.quote ?? (match?.market ? marketQuote(match.market) : null);
      if (!quote || quote.yesBid == null || quote.yesAsk == null) continue;

      const distFn = row.detailRef?.proj?.dist?.[row.distKey];
      if (typeof distFn !== 'function') continue;
      const rawProb = distFn(row.line);
      if (rawProb == null || isNaN(rawProb)) continue;

      const cal = calibrate(rawProb, row.market, row.line);

      // The quote carries no depth, so a nominal book is synthesised purely to
      // let `buildSignal` price the two sides. Size below is therefore
      // INDICATIVE — the runner checks real resting depth before ordering, and
      // that is the number that binds in practice.
      const book = {
        bestYesBid: quote.yesBid,
        bestYesAsk: quote.yesAsk,
        spreadCents: quote.spreadCents,
        yes: [{ cents: quote.yesBid, contracts: 1e6 }],
        no: [{ cents: 100 - quote.yesAsk, contracts: 1e6 }],
      };

      const signal = buildSignal({
        modelProb: cal.prob,
        book,
        ticker: match?.market?.ticker ?? row.key,
      });
      if (!signal?.side) continue;

      const sizing = signal.tradeable
        ? sizeOrder({
            signal,
            bankroll,
            gameId: row.gamePk ?? row.game?.gamePk,
            playerId: row.playerId,
            limits: DEFAULT_LIMITS,
          })
        : { contracts: 0, costDollars: 0, binding: null };

      // Both stated on the side actually being traded, so the columns line up
      // with the price beside them.
      const rawProbOnSide = signal.side === 'yes' ? rawProb : 1 - rawProb;
      const rawEdge = rawProbOnSide - signal.priceCents / 100;

      out.push({
        row,
        ticker: match?.market?.ticker ?? null,
        side: signal.side,
        priceCents: signal.priceCents,
        rawProbOnSide,
        rawEdge,
        calPts: cal.corrected ? cal.correctionPts : 0,
        measured: isMeasured(row.market, row.line),
        edge: signal.edge,
        feePts: feePerContractCents(signal.priceCents) / 100,
        evCents: signal.evCents,
        tradeable: signal.tradeable,
        reason: signal.reason,
        sizing,
      });
    }
    // Best real edge first — that is the order you would actually work them.
    return out.sort((a, b) => b.edge - a.edge);
  }, [candidates, books, bankroll]);

  if (!candidates.length) {
    return (
      <div className="notice">
        <b>No rows map to a Kalshi market.</b>
        <div className="sub">
          Kalshi lists seven daily MLB player-prop series — hits+runs+RBIs,
          total bases, hits, home runs, RBIs, strikeouts and outs — so pitcher
          markets other than strikeouts and outs, and any line that is not a
          half-integer, have no exchange equivalent.
        </div>
      </div>
    );
  }

  if (books.status === 'loading') {
    return <div className="notice"><b>Loading Kalshi markets…</b></div>;
  }
  if (books.status === 'error') {
    return (
      <div className="notice">
        <b>Kalshi markets unavailable.</b>
        <div className="sub">{books.error}</div>
      </div>
    );
  }

  const live = plays.filter((p) => p.tradeable);

  return (
    <>
      <div className="conviction-head">
        <b>{live.length} tradeable on Kalshi</b>
        <span>
          {candidates.length} rows map to a listed market · model → calibration →
          live price → fee → size
        </span>
        {/* The board must never look like it can place an order when it cannot,
            and must be unmistakable when it can. */}
        <span className={`bridge-pill ${bridge.status} ${bridge.mode || ''}`}>
          {bridge.status === 'up'
            ? bridge.mode === 'live'
              ? 'BRIDGE LIVE — clicks place real orders'
              : 'bridge up · paper'
            : bridge.status === 'checking'
              ? 'checking bridge…'
              : 'bridge offline — run node tools/kalshi-bridge.mjs'}
        </span>
      </div>

      {/* Automation status. Read-only by construction — see `useDaemon`. */}
      {daemon.status === 'up' && daemon.data && (
        <div className={`auto-panel ${daemon.data.mode === 'live' ? 'live' : ''}`}>
          <div className="auto-head">
            <b>
              {daemon.data.running
                ? daemon.data.mode === 'live'
                  ? '● AUTOMATION RUNNING — placing real orders'
                  : '● Automation running · paper'
                : '○ Automation stopped'}
            </b>
            <span>
              {daemon.data.session.orders}/{daemon.data.session.maxOrders} orders ·
              ${(daemon.data.openExposureDollars ?? 0).toFixed(0)}/$
              {daemon.data.session.maxCommittedDollars.toFixed(0)} committed ·
              every {daemon.data.intervalSeconds}s
              {daemon.data.liveUntil ? ` · expires ${daemon.data.liveUntil}` : ''}
            </span>
            {daemon.data.clv && (
              <span className="auto-clv">
                CLV {daemon.data.clv.meanCentsEdge >= 0 ? '+' : ''}
                {daemon.data.clv.meanCentsEdge.toFixed(1)}¢ over{' '}
                {daemon.data.clv.fills} fills
              </span>
            )}
          </div>
          <div className="auto-feed">
            {(daemon.data.activity || []).slice(0, 12).map((a, i) => (
              <div key={i} className="auto-line">
                <span className="auto-time">
                  {new Date(a.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                {a.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {daemon.status === 'down' && (
        <div className="psub" style={{ margin: '0 2px 10px' }}>
          Automation not running — <code>npm run auto</code>, or double-click{' '}
          <code>start-automation.cmd</code>. It is started from your machine, not
          from this page.
        </div>
      )}

      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Market</th>
              <th className="num">Line</th>
              <th className="num">Model</th>
              <th className="num">Calib</th>
              <th className="num">Price</th>
              <th className="num">Raw edge</th>
              <th className="num">Fee</th>
              <th className="num">Real edge</th>
              <th className="num">Size</th>
              <th>Call</th>
            </tr>
          </thead>
          <tbody>
            {plays.map((p) => (
              <tr key={p.row.key}>
                <td>
                  <b>{p.row.name}</b>
                  <div className="psub">{p.ticker || '—'}</div>
                </td>
                <td>{p.row.label}</td>
                <td className="num">{p.row.line}</td>
                <td className="num">{fmt.pct(p.rawProbOnSide)}</td>
                <td className="num">
                  {/* The correction actually applied, in points. Blank when the
                      line has never been measured — absence of a measurement is
                      not the same as a measured zero. */}
                  {p.measured
                    ? `${p.calPts > 0 ? '−' : '+'}${Math.abs(100 * p.calPts).toFixed(1)}`
                    : <span className="dim">n/m</span>}
                </td>
                <td className="num">
                  {p.side.toUpperCase()} {p.priceCents}¢
                </td>
                <td className="num">{(100 * p.rawEdge).toFixed(1)}</td>
                <td className="num dim">−{(100 * p.feePts).toFixed(2)}</td>
                <td className={`num ${p.edge - p.feePts > 0 ? 'pos' : 'neg'}`}>
                  <b>{(100 * (p.edge - p.feePts)).toFixed(1)}</b>
                </td>
                <td className="num">
                  {p.sizing.contracts > 0
                    ? `${p.sizing.contracts} · $${p.sizing.costDollars.toFixed(0)}`
                    : '—'}
                </td>
                <td>
                  {!p.tradeable ? (
                    <span className="psub">{p.reason}</span>
                  ) : (
                    (() => {
                      const st = placed[p.row.key];
                      if (st?.status === 'done') {
                        return (
                          <span className="verdict solid" title={st.detail?.clientOrderId}>
                            {st.detail?.mode === 'live' ? 'PLACED' : 'PAPER'}{' '}
                            {st.detail?.contracts}@{st.detail?.priceCents}¢
                          </span>
                        );
                      }
                      if (st?.status === 'sending') {
                        return <span className="psub">sending…</span>;
                      }
                      return (
                        <>
                          <button
                            className="addbtn"
                            disabled={bridge.status !== 'up'}
                            title={
                              bridge.status !== 'up'
                                ? 'Start the bridge: node tools/kalshi-bridge.mjs'
                                : bridge.mode === 'live'
                                  ? 'Places a REAL order through your local bridge'
                                  : 'Records a paper order through your local bridge'
                            }
                            onClick={() => place(p)}
                          >
                            {bridge.mode === 'live' ? 'Take it' : 'Paper it'}
                          </button>
                          {/* A refusal is shown against the row that caused it
                              rather than as a toast — the reason belongs beside
                              the numbers it refers to. */}
                          {st?.status === 'refused' && (
                            <div className="psub neg">{st.detail}</div>
                          )}
                        </>
                      );
                    })()
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="psub" style={{ marginTop: 10 }}>
        <b>Read-only.</b> Size is indicative — it assumes depth at the quoted
        price. The runner checks real resting depth before ordering, and depth is
        frequently the binding limit. <b>n/m</b> means the line has never been
        backtested, so no correction is applied; that is not the same as a
        measured zero. See <code>TRADING.md</code>.
      </div>
    </>
  );
}
