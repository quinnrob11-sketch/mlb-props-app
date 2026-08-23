// Root component (minified: `ah`).
//
// Owns everything: slate date, the loaded slate, load/error status, the bet
// slip, the persisted settings (odds key / bankroll / sharp mode / alt lines)
// and tab routing. Every board below it is presentational.

import { useEffect, useMemo, useRef, useState } from 'react';

import { fmt, slateDate } from '../lib/format.js';
import { PITCHER_MARKETS, BATTER_MARKETS } from '../lib/markets.js';
import { loadSlate } from '../data/loadSlate.js';
// Snapshot / closing-line persistence (minified `hh`, `mh`, `kh`, `Sh`).
import { saveSnapshot, saveClosingLines, serializeSlate, reviveSlate } from './snapshotStore.js';
import { flattenRows } from './rows.js';
import { seriesForMarket } from '../lib/kalshi.js';
import { applyCriteria, loadCriteria, saveCriteria } from './filters.js';
import { loadPriceMode, savePriceMode } from './makerMode.js';
import { buildDfsBoard } from './dfsRows.js';
import FilterBar from './FilterBar.jsx';
import BestBets from './BestBets.jsx';
import DfsBoard from './DfsBoard.jsx';
import KalshiBoard from './KalshiBoard.jsx';
// TODO(recon): the shared pitcher/batter table (minified `Wa`, app.js:2158) is
// reconstructed outside this region; file name assumed.
import PropTable from './PropTable.jsx';
import SlateView from './SlateView.jsx';
import ResultsView from './ResultsView.jsx';
import MethodologyView from './MethodologyView.jsx';
import BetSlip from './BetSlip.jsx';
import SettingsModal from './SettingsModal.jsx';

// A cached slate is only trusted for 20 minutes — after that the odds are too
// stale to price against.
const CACHE_TTL_MS = 20 * 60 * 1000;
// Bumped v19 -> v22. The cached slate is a serialised PROJECTION, and the
// projection's shape changed across v20, v21 and v22 (workload, run-environment
// terms, the shrunk pitcher fields). Rehydrating a v19 slate into a v22
// component tree crashed the whole app rather than one card. Bumping the key
// makes a stale slate simply absent, which the UI already handles.
const CACHE_KEY = 'slateCacheV22';

export default function App() {
  const [date, setDate] = useState(slateDate());
  const [slate, setSlate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('best');
  const [query, setQuery] = useState('');
  const [slip, setSlip] = useState({});
  const [showSettings, setShowSettings] = useState(false);

  // Persisted settings.
  const [oddsKey, setOddsKey] = useState(() => localStorage.getItem('oddsKeyOverride') || '');
  const [bankroll, setBankroll] = useState(() => Number(localStorage.getItem('bankroll')) || 100);
  // Sharp mode is opt-out: anything other than the literal "off" means on.
  const [sharp, setSharp] = useState(() => localStorage.getItem('sharpMode') !== 'off');
  // Taker (hit the best price now) vs maker (rest inside Kalshi's book).
  // Persisted next to `criteriaV1` / `bankroll` / `sharpMode`.
  const [priceMode, setPriceMode] = useState(() => loadPriceMode());
  useEffect(() => {
    savePriceMode(priceMode);
  }, [priceMode]);
  // The whole criteria filter, persisted under `criteriaV1`. It also owns the
  // alt-line rule that used to live in its own `showAlts` key — `loadCriteria`
  // seeds `hideAlts` from that key on first run and `saveCriteria` mirrors it
  // back, so upgrading users keep their toggle.
  const [criteria, setCriteria] = useState(() => loadCriteria());
  useEffect(() => {
    saveCriteria(criteria);
  }, [criteria]);

  // Restore a recent cached slate on mount so a reload does not burn odds
  // credits. Runs once — a later date change does not re-check the cache.
  useEffect(() => {
    try {
      // Drop the pre-v19 cache key if it is still hanging around.
      localStorage.removeItem('slateCache');
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (
        cached &&
        Array.isArray(cached.games) &&
        cached.games.every((g) => Array.isArray(g.pitchers) && Array.isArray(g.batters)) &&
        cached.date === date &&
        Date.now() - new Date(cached.loadedAt).getTime() < CACHE_TTL_MS
      ) {
        setSlate(reviveSlate(cached));
        setStatus(
          `Restored cached slate from ${fmt.time(cached.loadedAt)} — hit REFRESH SLATE for current odds.`,
        );
      }
    } catch {}
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    setSlip({});
    try {
      const next = await loadSlate({
        date,
        oddsKey: oddsKey || undefined,
        onStatus: setStatus,
        sharp,
      });
      setSlate(next);
      saveSnapshot(date, next);
      saveClosingLines(date, next);
      try {
        // `serializeSlate` drops the `dist` closures, which cannot survive JSON.
        localStorage.setItem(CACHE_KEY, JSON.stringify(serializeSlate(next)));
      } catch {}
      setStatus(
        `Loaded ${next.games.length} games at ${fmt.time(next.loadedAt)}${
          next.remaining ? ` · odds credits left: ${next.remaining}` : ''
        }`,
      );
    } catch (err) {
      setError(String(err.message || err));
      setStatus('');
    } finally {
      setLoading(false);
    }
  }

  const allRows = useMemo(() => flattenRows(slate), [slate]);
  // The alt rule alone — the slate summary strip reports on the board the user
  // has chosen to look at, not on the criteria-narrowed subset.
  const rows = useMemo(
    () => allRows.filter((r) => !criteria.hideAlts || !r.alt),
    [allRows, criteria.hideAlts],
  );
  // Every active criterion applied (including the alt rule). Boards render this.
  const filtered = useMemo(() => applyCriteria(allRows, criteria), [allRows, criteria]);

  // Count of callable alt-line rungs, shown on the ALT chip even while alts are
  // hidden (computed from `allRows`, not the filtered list).
  const altEdges = allRows.filter(
    (r) => r.alt && r.line != null && r.edge && r.edge.verdict !== 'PASS',
  ).length;

  const priced = rows.filter((r) => r.line != null);
  const callable = priced.filter((r) => r.edge && r.edge.verdict !== 'PASS');
  const strong = callable.filter((r) => r.edge.verdict === 'STRONG');

  // Per-board row sets: `*Rows` is what renders, `*All` is the same board with
  // no criteria at all, which the empty state needs to explain what was cut.
  const isCallable = (r) => r.line != null && r.edge && r.edge.verdict !== 'PASS';
  const bestAll = allRows.filter(isCallable);
  const bestRows = filtered.filter(isCallable);
  const pitcherAll = allRows.filter((r) => r.kind === 'pitcher');
  const pitcherRows = filtered.filter((r) => r.kind === 'pitcher');
  const batterAll = allRows.filter((r) => r.kind === 'batter');
  const batterRows = filtered.filter((r) => r.kind === 'batter');
  // DFS board: only rows a DFS app actually carries survive `buildDfsBoard`,
  // so the tab count is the real number of shoppable plays.
  const dfsRows = filtered.filter(isCallable);
  const dfsCount = buildDfsBoard(dfsRows).length;
  // Rows that could map to a listed Kalshi series. Kalshi carries only two
  // daily MLB player-prop series, so this is legitimately a small number and
  // the tab should say so rather than looking broken.
  const kalshiCount = filtered.filter(
    (r) => r.line != null && Math.abs(r.line % 1) === 0.5 && seriesForMarket(r.market),
  ).length;

  // Tab counts track the filtered set. PITCHERS/BATTERS keep their original
  // "distinct players" meaning rather than switching to a prop-row count.
  const players = (list) => new Set(list.map((r) => r.playerId)).size;
  const nrfiGames = slate ? slate.games.filter((g) => g.nrfi).length : 0;
  const nrfiOn = criteria.kinds.includes('nrfi');

  // On a phone the tab row is a single horizontally-scrollable strip rather
  // than two wrapped lines, so the selected tab has to be scrolled into view.
  // The guard makes this a no-op on desktop, where the row wraps and there is
  // nothing to scroll.
  const tabsRef = useRef(null);
  useEffect(() => {
    const nav = tabsRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const active = nav.querySelector('.tab.on');
    if (!active) return;
    const navBox = nav.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    nav.scrollLeft += box.left - navBox.left - (navBox.width - box.width) / 2;
  }, [tab]);

  const toggleSlip = (row) =>
    setSlip((prev) => {
      const next = { ...prev };
      if (next[row.key]) delete next[row.key];
      else next[row.key] = row;
      return next;
    });

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-brand">
          <span className="hdr-logo">MLB</span>
          <span className="hdr-title">PROP ENGINE</span>
          <span className="hdr-sub">
            v22 · backtested calibration · PIN-anchored consensus · CLV · weather · ¼-Kelly
          </span>
        </div>
        <div className="hdr-spacer" />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Slate date"
        />
        {/* The `.lbl` spans are dropped at phone widths so the whole header
            fits one 40px row; the desktop labels are unchanged. */}
        <button
          className="btn"
          onClick={() => setShowSettings(true)}
          title="Settings"
          aria-label="Settings"
        >
          ⚙ <span className="lbl">Settings</span>
        </button>
        <button className="btn btn-primary" disabled={loading} onClick={load}>
          {loading ? (
            'LOADING…'
          ) : slate ? (
            <>
              ↻ REFRESH <span className="lbl">SLATE</span>
            </>
          ) : (
            'LOAD SLATE'
          )}
        </button>
      </header>

      <div className="statusline" role="status">
        {error ? (
          <span className="err">✕ {error}</span>
        ) : (
          <span className={loading ? '' : 'ok'}>{status}</span>
        )}
      </div>

      {slate && (
        <div className="strip">
          <div className="cell">
            <b>{slate.games.length}</b> games
          </div>
          <div className="cell">
            <b>{slate.games.reduce((n, g) => n + g.pitchers.length, 0)}</b> starters
          </div>
          <div className="cell">
            <b>{slate.games.reduce((n, g) => n + g.batters.length, 0)}</b> lineup bats
          </div>
          <div className="cell">
            <b>{priced.length}</b> props w/ lines
          </div>
          {/* `.key` carries no desktop styling — at phone widths it pulls the
              two numbers the board is actually read for to the head of the
              single-row strip. */}
          <div className="cell key">
            <b className="pos">{callable.length}</b> callable edges
          </div>
          <div className="cell key">
            <b className="pos">{strong.length}</b> strong
          </div>
          {slate.remaining && (
            <div className="cell">
              <b>{slate.remaining}</b> odds credits left
            </div>
          )}
        </div>
      )}

      {slate && slate.skipped > 0 && (
        <div className="banner">
          {slate.skipped} game{slate.skipped > 1 ? 's' : ''} on this date already started or
          finished — only pre-game matchups are shown (grade finished slates in RESULTS).
        </div>
      )}

      {slate?.oddsError && (
        <div className="banner">
          Odds feed issue: {slate.oddsError} — projections still computed; lines may be missing.
          Check the API key in Settings.
        </div>
      )}

      {slate && slate.games.length > 0 && slate.games.every((g) => g.batters.length === 0) && (
        <div className="banner">
          Lineups not posted yet — the batter board fills in automatically once lineups drop
          (usually 2–4 hours before first pitch). Hit REFRESH closer to game time.
        </div>
      )}

      <nav className="tabs" ref={tabsRef}>
        {[
          ['best', 'BEST BETS', bestRows.length],
          ['pitchers', 'PITCHERS', players(pitcherRows)],
          ['batters', 'BATTERS', players(batterRows)],
          ['dfs', 'DFS', dfsCount],
          ['kalshi', 'KALSHI', kalshiCount],
          ['nrfi', 'NRFI', nrfiOn ? nrfiGames : 0],
          ['results', 'RESULTS', null],
          ['method', 'METHOD', null],
        ].map(([key, label, count]) => (
          <button
            key={key}
            className={`tab ${tab === key ? 'on' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
            {count != null && <span className="n">({count})</span>}
          </button>
        ))}
      </nav>

      {(tab === 'best' || tab === 'pitchers' || tab === 'batters' || tab === 'dfs') && (
        <div className="toolbar">
          <input
            className="search"
            placeholder="🔍 Search player, team, matchup…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
          {/* `.toolgroup` is `display: contents` above 720px, so on desktop its
              children stay the same direct flex items of `.toolbar` they always
              were. Below 720px it becomes the scrollable half of a single-row
              toolbar. */}
          <div className="toolgroup">
            <FilterBar
              criteria={criteria}
              onChange={setCriteria}
              rows={allRows}
              altCount={altEdges}
              showStrongChip={tab === 'best'}
            />
            {tab !== 'dfs' && (
              <div className="chips modeswitch" role="group" aria-label="Price mode">
                {[
                  ['taker', 'Taker', 'Best price on the board right now — click to hit it.'],
                  [
                    'maker',
                    'Maker',
                    "Kalshi rows only: the live bid/ask, where the model's fair value sits in it, and where a resting order could still have edge. Display only.",
                  ],
                ].map(([key, label, hint]) => (
                  <button
                    key={key}
                    className={`chip ${priceMode === key ? 'on' : ''}`}
                    onClick={() => setPriceMode(key)}
                    title={hint}
                    aria-pressed={priceMode === key}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {!slate && !loading && (
        <div className="notice">
          <b>No slate loaded.</b>
          <div className="sub">
            Pick a date and hit LOAD SLATE — the engine pulls probables, lineups, season +
            recent-form stats, park factors, weather and live sportsbook lines (incl. Pinnacle),
            then prices every prop with a real probability distribution.
          </div>
        </div>
      )}

      {slate && tab === 'best' && (
        <BestBets
          rows={bestRows}
          unfilteredRows={bestAll}
          criteria={criteria}
          query={query}
          slip={slip}
          toggleSlip={toggleSlip}
          bankroll={bankroll}
          priceMode={priceMode}
        />
      )}

      {slate && tab === 'pitchers' && (
        <PropTable
          rows={pitcherRows}
          unfilteredRows={pitcherAll}
          criteria={criteria}
          query={query}
          markets={PITCHER_MARKETS}
          kind="pitcher"
          slip={slip}
          toggleSlip={toggleSlip}
          priceMode={priceMode}
        />
      )}

      {slate && tab === 'batters' && (
        <PropTable
          rows={batterRows}
          unfilteredRows={batterAll}
          criteria={criteria}
          query={query}
          markets={BATTER_MARKETS}
          kind="batter"
          slip={slip}
          toggleSlip={toggleSlip}
          priceMode={priceMode}
        />
      )}

      {slate && tab === 'kalshi' && (
        <KalshiBoard rows={filtered} bankroll={bankroll} />
      )}

      {slate && tab === 'dfs' && (
        <DfsBoard
          rows={dfsRows}
          unfilteredRows={bestAll}
          criteria={criteria}
          query={query}
        />
      )}

      {slate && tab === 'nrfi' && nrfiOn && <SlateView slate={slate} />}
      {slate && tab === 'nrfi' && !nrfiOn && (
        <div className="notice">
          <b>NRFI is switched off in your filters.</b>
          <div className="sub">
            The “Board” criterion under Slate &amp; market has NRFI deselected, so the
            first-inning board is hidden. Re-select it in Filters, or hit Reset.
          </div>
        </div>
      )}
      {tab === 'results' && <ResultsView />}
      {tab === 'method' && <MethodologyView />}

      {Object.keys(slip).length > 0 && (
        <BetSlip
          slip={slip}
          toggleSlip={toggleSlip}
          clear={() => setSlip({})}
          bankroll={bankroll}
        />
      )}

      {showSettings && (
        <SettingsModal
          oddsKey={oddsKey}
          bankroll={bankroll}
          sharp={sharp}
          onSave={(nextKey, nextBankroll, nextSharp) => {
            setOddsKey(nextKey);
            localStorage.setItem('oddsKeyOverride', nextKey);
            setBankroll(nextBankroll);
            localStorage.setItem('bankroll', String(nextBankroll));
            setSharp(nextSharp);
            localStorage.setItem('sharpMode', nextSharp ? 'on' : 'off');
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
