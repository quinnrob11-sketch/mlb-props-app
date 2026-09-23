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
import { priceGaps } from '../analysis/shop.js';
import FilterBar from './FilterBar.jsx';
import BestBets from './BestBets.jsx';
import ShopBoard from './ShopBoard.jsx';
import DfsBoard from './DfsBoard.jsx';
import KalshiBoard from './KalshiBoard.jsx';
// TODO(recon): the shared pitcher/batter table (minified `Wa`, app.js:2158) is
// reconstructed outside this region; file name assumed.
import PropTable from './PropTable.jsx';
import GamesBoard from './GamesBoard.jsx';
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
// Bumped V22 -> V35: slates now carry `game`, `teamLines` and a game-model
// NRFI, and an older cached slate would render game cards with no data.
const CACHE_KEY = 'slateCacheV35';

/**
 * Where today's numbers came from, in one line each. Replaces a raw upstream
 * error string in an amber banner, which told the user something was wrong
 * but not what it cost them or what to do.
 */
function SourceStatus({ slate }) {
  const keyProblem = (msg) =>
    /deactivated|not configured|invalid|401|unauthori[sz]ed|quota|usage/i.test(msg || '');
  const bookError = slate.oddsError || slate.gameLinesError;
  const sources = [
    { name: 'MLB stats & lineups', ok: true, detail: lineupDetail(slate) },
    {
      name: 'Sportsbooks',
      ok: !bookError,
      detail: !bookError
        ? 'DraftKings, FanDuel, BetMGM, Caesars, Pinnacle'
        : keyProblem(bookError)
          ? 'Odds API key missing or deactivated — player props and sportsbook game lines are unavailable. Set a working ODDS_API_KEY in Vercel, or add your own key in Settings.'
          : `Unavailable right now (${bookError}).`,
    },
    {
      name: 'Kalshi',
      ok: !slate.kalshiGameError,
      detail: slate.kalshiGameError
        ? `Unavailable right now (${slate.kalshiGameError}).`
        : 'Moneyline, run line and total — free, no key needed',
    },
  ];
  return (
    <ul className="sources" aria-label="Data sources">
      {sources.map((s) => (
        <li key={s.name} className={s.ok ? 'ok' : 'bad'}>
          <span className="dot" aria-hidden="true" />
          <b>{s.name}</b>
          <span className="src-detail">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function lineupDetail(slate) {
  const c = slate.lineupCounts;
  if (!c) return 'loaded';
  const parts = [];
  if (c.confirmed) parts.push(`${c.confirmed} confirmed`);
  if (c.projected) parts.push(`${c.projected} projected`);
  if (c.none) parts.push(`${c.none} not out`);
  return parts.length ? `lineups: ${parts.join(', ')}` : 'loaded';
}

export default function App() {
  const [date, setDate] = useState(slateDate());
  const [slate, setSlate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('games');
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
      localStorage.removeItem('slateCacheV22');
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
          `Showing games loaded at ${fmt.time(cached.loadedAt)} — press Refresh odds for current prices.`,
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

  // Price gaps come from EVERY priced row, not from the filtered play board.
  // A book out of line with its peers is worth taking whatever the model said
  // about it, so the criteria that govern model plays must not touch this.
  const shopGaps = useMemo(() => priceGaps(allRows), [allRows]);

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
  const propRows = priced.filter((r) => r.kind === 'pitcher' || r.kind === 'batter');
  const gameLineCount = allRows.filter((r) => r.kind === 'game').length;

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
          <span className="hdr-title">Edge Board</span>
          <span className="hdr-sub">Model vs. market on game lines and player props</span>
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
            'Loading…'
          ) : slate ? (
            <>
              ↻ Refresh <span className="lbl">odds</span>
            </>
          ) : (
            'Load games'
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
            <b>{gameLineCount}</b> game lines priced
          </div>
          <div className="cell">
            <b>{propRows.length}</b> props priced
          </div>
          {/* `.key` carries no desktop styling — at phone widths it pulls the
              two numbers the board is actually read for to the head of the
              single-row strip. */}
          <div className="cell key">
            <b className="pos">{callable.length}</b> plays
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

      {slate && <SourceStatus slate={slate} />}

      {slate && slate.skipped > 0 && (
        <div className="banner">
          {slate.skipped} game{slate.skipped > 1 ? 's' : ''} on this date already started or
          finished — only pre-game matchups are shown (grade finished slates in RESULTS).
        </div>
      )}


      {slate && slate.games.length > 0 && slate.games.every((g) => g.batters.length === 0) && (
        <div className="banner">
          Lineups aren't posted yet — batter props fill in once they are (usually 2–4 hours
          before first pitch). Refresh closer to game time.
        </div>
      )}

      <nav className="tabs" ref={tabsRef} aria-label="Boards">
        {[
          ['games', 'Games', slate ? slate.games.length : null, 'Every game: model vs. market on moneyline, run line, total and first inning'],
          ['best', 'Best Bets', bestRows.length, 'Every play the engine would take, most confident first'],
          ['shop', 'Shop', shopGaps.length, 'Where one book disagrees with the others — the model is not consulted'],
          ['pitchers', 'Pitcher Props', players(pitcherRows), 'Starting pitcher props'],
          ['batters', 'Batter Props', players(batterRows), 'Batter props'],
          ['results', 'Results', null, 'Grade past slates and see what has actually made money'],
          ['method', 'How It Works', null, 'What the models do and how far to trust them'],
        ].map(([key, label, count, hint]) => (
          <button
            key={key}
            className={`tab ${tab === key ? 'on' : ''}`}
            onClick={() => setTab(key)}
            title={hint}
            aria-current={tab === key ? 'page' : undefined}
          >
            {label}
            {count != null && <span className="n">{count}</span>}
          </button>
        ))}
        <span className="tabs-sep" aria-hidden="true" />
        {[
          ['dfs', 'DFS', dfsCount, 'The same plays, shopped across DFS pick’em apps'],
          ['kalshi', 'Kalshi Props', kalshiCount, 'Player props listed on Kalshi'],
        ].map(([key, label, count, hint]) => (
          <button
            key={key}
            className={`tab minor ${tab === key ? 'on' : ''}`}
            onClick={() => setTab(key)}
            title={hint}
            aria-current={tab === key ? 'page' : undefined}
          >
            {label}
            {count != null && <span className="n">{count}</span>}
          </button>
        ))}
      </nav>

      {slate && tab === 'games' && (
        <div className="toolbar">
          <input
            className="search"
            placeholder="Search team or park…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search games"
          />
        </div>
      )}

      {(tab === 'best' || tab === 'pitchers' || tab === 'batters' || tab === 'dfs') && (
        <div className="toolbar">
          <input
            className="search"
            placeholder="Search player, team, matchup…"
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
        <div className="notice welcome">
          <b>Pick a date and press Load games.</b>
          <div className="sub">
            The app pulls probable pitchers, lineups, season stats, park and weather, then prices
            every game's moneyline, run line, total and first inning — and every player prop —
            against live sportsbook and Kalshi prices.
          </div>
          <ol className="steps">
            <li>
              <b>Games</b> — start here. One card per game, model next to market.
            </li>
            <li>
              <b>Best Bets</b> — only the plays the engine would actually take.
            </li>
            <li>
              <b>Results</b> — grade past days to see what is really making money.
            </li>
          </ol>
        </div>
      )}

      {slate && tab === 'shop' && <ShopBoard gaps={shopGaps} rows={allRows.length} />}

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

      {slate && tab === 'games' && (
        <GamesBoard
          slate={slate}
          rows={allRows}
          query={query}
          slip={slip}
          toggleSlip={toggleSlip}
        />
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
