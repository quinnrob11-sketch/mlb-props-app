// Root component (minified: `ah`).
//
// Owns everything: slate date, the loaded slate, load/error status, the bet
// slip, the persisted settings (odds key / bankroll / sharp mode / alt lines)
// and tab routing. Every board below it is presentational.

import { useEffect, useMemo, useState } from 'react';

import { fmt, slateDate } from '../lib/format.js';
import { PITCHER_MARKETS, BATTER_MARKETS } from '../lib/markets.js';
import { loadSlate } from '../data/loadSlate.js';
// Snapshot / closing-line persistence (minified `hh`, `mh`, `kh`, `Sh`).
import { saveSnapshot, saveClosingLines, serializeSlate, reviveSlate } from './snapshotStore.js';
import { flattenRows } from './rows.js';
import { applyCriteria, loadCriteria, saveCriteria } from './filters.js';
import FilterBar from './FilterBar.jsx';
import BestBets from './BestBets.jsx';
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
const CACHE_KEY = 'slateCacheV19';

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

  // Tab counts track the filtered set. PITCHERS/BATTERS keep their original
  // "distinct players" meaning rather than switching to a prop-row count.
  const players = (list) => new Set(list.map((r) => r.playerId)).size;
  const nrfiGames = slate ? slate.games.filter((g) => g.nrfi).length : 0;
  const nrfiOn = criteria.kinds.includes('nrfi');

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
            v19.2 · tightened calls · PIN-anchored consensus · CLV · weather · ¼-Kelly
          </span>
        </div>
        <div className="hdr-spacer" />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Slate date"
        />
        <button className="btn" onClick={() => setShowSettings(true)} title="Settings">
          ⚙ Settings
        </button>
        <button className="btn btn-primary" disabled={loading} onClick={load}>
          {loading ? 'LOADING…' : slate ? '↻ REFRESH SLATE' : 'LOAD SLATE'}
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
          <div className="cell">
            <b className="pos">{callable.length}</b> callable edges
          </div>
          <div className="cell">
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

      <nav className="tabs">
        {[
          ['best', 'BEST BETS', bestRows.length],
          ['pitchers', 'PITCHERS', players(pitcherRows)],
          ['batters', 'BATTERS', players(batterRows)],
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

      {(tab === 'best' || tab === 'pitchers' || tab === 'batters') && (
        <div className="toolbar">
          <input
            className="search"
            placeholder="🔍 Search player, team, matchup…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
          <FilterBar
            criteria={criteria}
            onChange={setCriteria}
            rows={allRows}
            altCount={altEdges}
            showStrongChip={tab === 'best'}
          />
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
