// GAMES board (v35) — the landing view. One card per game:
//
//   who is pitching, what the model projects, and — for the moneyline, run line,
//   total, the same three over the first five innings, and the first inning —
//   the side the model leans to, its probability next to the market's, the best
//   price available and the engine's call.
//
// The card is built to be read in a few seconds. Every number that needs a
// sentence of explanation gets it once, in the legend, not on every card.

import { useMemo, useState } from 'react';
import { fmt } from '../lib/format.js';
import { pickText, teamNickname as nickname } from './rows.js';
import VerdictChip from './VerdictChip.jsx';

const MARKET_ORDER = [
  'game_ml', 'game_spread', 'game_total',
  'f5_ml', 'f5_spread', 'f5_total',
  'nrfi',
];
const MARKET_NAME = {
  game_ml: 'Moneyline',
  game_spread: 'Run line',
  game_total: 'Total',
  f5_ml: 'F5 moneyline',
  f5_spread: 'F5 run line',
  f5_total: 'F5 total',
  nrfi: '1st inning',
};

/** The projected total shown beside a total row, full game or first five. */
const projTotalFor = (model, market) =>
  market === 'game_total' ? model?.projTotal : market === 'f5_total' ? model?.f5?.projTotal : null;

/**
 * The side of a market row to show, and the numbers for that side.
 *
 * The engine's called side when it has one; otherwise the side the model rates
 * above the market (or above 50% when there is no market at all).
 */
function sideView(row) {
  const edge = row.edge;
  const modelOver = edge?.modelOver ?? row.modelOver ?? null;
  let side = edge?.side;
  if (!side && modelOver != null) side = modelOver >= (edge?.fairOver ?? 0.5) ? 'over' : 'under';
  if (!side) return null;
  const on = (p) => (p == null ? null : side === 'over' ? p : 1 - p);
  return {
    side,
    words: pickText(row, side),
    model: on(modelOver),
    market: on(edge?.fairOver ?? null),
    price: side === 'over' ? row.over : row.under,
    book: side === 'over' ? row.overBook : row.underBook,
    gap: edge?.edge == null ? null : side === 'over' ? edge.edge : -edge.edge,
  };
}

function WinBar({ game }) {
  const m = game.game;
  if (!m) return null;
  const away = Math.round(m.pAway * 100);
  return (
    <div className="winbar" aria-label={`Win chance: ${game.away.abbr} ${away}%, ${game.home.abbr} ${100 - away}%`}>
      <div className="winbar-labels">
        <span>
          <b>{game.away.abbr}</b> {away}%
        </span>
        <span className="dim">model win chance</span>
        <span>
          {100 - away}% <b>{game.home.abbr}</b>
        </span>
      </div>
      <div className="winbar-track">
        <i className="winbar-away" style={{ width: `${away}%` }} />
      </div>
    </div>
  );
}

function Starter({ pitcher }) {
  if (!pitcher) return <span className="dim">TBD</span>;
  const era = pitcher.season?.era;
  return (
    <span className="starter">
      <b>{pitcher.name}</b>
      <span className="dim">
        {' '}
        {pitcher.hand !== '?' ? `${pitcher.hand}HP` : ''}
        {era ? ` · ${era} ERA` : ''}
        {pitcher.proj?.projIP ? ` · ~${fmt.n1(pitcher.proj.projIP)} IP` : ''}
      </span>
    </span>
  );
}

function GameCard({ game, rowsByKey, slip, toggleSlip }) {
  const m = game.game;
  const away = game.pitchers.find((p) => p.side === 'away');
  const home = game.pitchers.find((p) => p.side === 'home');

  const lines = MARKET_ORDER.map((market) => {
    const key = market === 'nrfi' ? `n:${game.gamePk}` : `g:${game.gamePk}:${market}`;
    return { market, row: rowsByKey.get(key) || null };
  });

  // A wind with a DIRECTION is shown at any speed, because from v37 it is in
  // the number: out of the park adds runs, in from it takes them away. A wind
  // with only a speed is still shown at 12 mph and up, and is still worth
  // nothing to the model, because an unsigned speed cannot say which way.
  const wind = game.wx?.windMph == null
    ? ''
    : game.wx.windDir
      ? `, wind ${game.wx.windMph} mph ${game.wx.windDir}`
      : game.wx.windMph >= 12
        ? `, wind ${game.wx.windMph} mph`
        : '';
  const weather = game.wx?.indoor
    ? 'roof'
    : game.wx?.tempF != null
      ? `${game.wx.tempF}°F${wind}`
      : null;

  const lineupNote =
    game.lineupStatus === 'confirmed'
      ? null
      : game.lineupStatus === 'none'
        ? 'lineups not out'
        : 'projected lineups';

  const suppressed = lines.filter(({ row }) =>
    row?.edge?.why?.some((w) => w.includes('off market')),
  );

  return (
    <article className="gcard">
      <header className="gcard-head">
        <div>
          <h3 className="gcard-title">
            {nickname(game.away)} <span className="at">@</span> {nickname(game.home)}
          </h3>
          <div className="gcard-meta">
            {fmt.time(game.gameDate)} · {game.venue}
            {weather ? ` · ${weather}` : ''}
            {lineupNote && <span className="flag">{lineupNote}</span>}
          </div>
        </div>
        {m && (
          <div className="gcard-score" title="Model's projected final score (mean runs)">
            <span className="dim">Projected</span>
            <b>
              {game.away.abbr} {fmt.n1(m.projAway)} – {fmt.n1(m.projHome)} {game.home.abbr}
            </b>
          </div>
        )}
      </header>

      <div className="gcard-starters">
        <Starter pitcher={away} />
        <span className="vs">vs</span>
        <Starter pitcher={home} />
      </div>

      <WinBar game={game} />

      <table className="gtable">
        <thead>
          <tr>
            <th>Market</th>
            <th title="The side the model rates higher than the market does">Side</th>
            <th className="num">Model</th>
            <th className="num">Market</th>
            <th className="num">Best price</th>
            <th>Call</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ market, row }) => {
            if (!row) {
              // No price anywhere. Still show the model's number where it has one.
              const nrfi = market === 'nrfi' ? m?.nrfi : null;
              return (
                <tr key={market} className="noline">
                  <td className="gmarket">{MARKET_NAME[market]}</td>
                  <td>
                    {nrfi
                      ? nrfi.nrfiProb >= 0.5
                        ? 'NRFI — no run in the 1st'
                        : 'YRFI — a run in the 1st'
                      : <span className="dim">—</span>}
                  </td>
                  <td className="num">
                    {nrfi ? fmt.pct(Math.max(nrfi.nrfiProb, nrfi.yrfiProb)) : '—'}
                  </td>
                  <td className="num dim">—</td>
                  <td className="num dim">no line</td>
                  <td>
                    <span className="dim">—</span>
                  </td>
                </tr>
              );
            }
            const v = sideView(row);
            const inSlip = !!slip[row.key];
            const callable = row.edge && row.edge.verdict !== 'PASS';
            return (
              <tr key={market} className={callable ? 'callable' : ''}>
                <td className="gmarket">
                  {MARKET_NAME[market]}
                  {projTotalFor(m, market) != null ? (
                    <span className="dim"> · proj {fmt.n1(projTotalFor(m, market))}</span>
                  ) : null}
                </td>
                <td className="gpick">{v?.words}</td>
                <td className="num">{fmt.pct(v?.model)}</td>
                <td className="num">
                  {fmt.pct(v?.market)}
                  {v?.gap != null && (
                    <span className={`gap ${Math.abs(v.gap) >= 0.03 ? (v.gap > 0 ? 'pos' : 'neg') : 'dim'}`}>
                      {v.gap > 0 ? '+' : ''}
                      {Math.round(v.gap * 100)}
                    </span>
                  )}
                </td>
                <td className="num">
                  {fmt.odds(v?.price)}
                  {v?.book && <span className="book">{v.book}</span>}
                </td>
                <td className="gcall">
                  <VerdictChip edge={row.edge} row={row} />
                  {callable && (
                    <button
                      className={`addbtn mini ${inSlip ? 'in' : ''}`}
                      onClick={() => toggleSlip(row)}
                      aria-label={inSlip ? 'Remove from slip' : 'Add to slip'}
                    >
                      {inSlip ? '✓' : '+'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {suppressed.length > 0 && (
        <p className="gnote">
          The model is far from the market on the{' '}
          {suppressed.map(({ market }) => MARKET_NAME[market].toLowerCase()).join(' and ')} — that
          is treated as the model being wrong, not as an edge.
        </p>
      )}
      {m?.flags?.length > 0 && (
        <p className="gnote">
          {m.flags.includes('NO PROBABLE') && 'A probable starter is not announced; the model assumes an average start. '}
          {m.flags.includes('NO TEAM STATS') && 'Team stats were unavailable; league averages used.'}
        </p>
      )}
    </article>
  );
}

export default function GamesBoard({ slate, rows, query, slip, toggleSlip }) {
  const [order, setOrder] = useState('time');
  const rowsByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const games = useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    const list = slate.games.filter(
      (g) =>
        !q ||
        [g.away.abbr, g.home.abbr, g.away.name, g.home.name, g.venue]
          .join(' ')
          .toLowerCase()
          .includes(q),
    );
    const best = (g) =>
      Math.max(
        0,
        ...rows
          .filter((r) => r.gamePk === g.gamePk && (r.kind === 'game' || r.kind === 'nrfi'))
          .map((r) => (r.edge && r.edge.verdict !== 'PASS' ? r.edge.ev ?? 0 : 0)),
      );
    return order === 'plays'
      ? [...list].sort((a, b) => best(b) - best(a) || new Date(a.gameDate) - new Date(b.gameDate))
      : [...list].sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
  }, [slate, rows, query, order]);

  if (!slate.games.length) {
    return (
      <div className="notice">
        <b>No games left to play on this date.</b>
        <div className="sub">Pick another date, or grade finished games in Results.</div>
      </div>
    );
  }

  return (
    <>
      <div className="glegend">
        <details>
          <summary>What do the columns mean?</summary>
          <b>Side</b> is the side the model likes better than the market does — not necessarily
          one it expects to win. <b>Model</b> is this app's probability for it. <b>Market</b> is the
          sportsbooks' and Kalshi's price with the margin removed; the small number beside it is
          how many points the model disagrees. <b>Call</b> is PASS unless the price is good enough
          <i> and </i>the disagreement is small enough to believe.
        </details>
        <div className="chips" role="group" aria-label="Order games">
          {[
            ['time', 'By start time'],
            ['plays', 'Plays first'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`chip ${order === key ? 'on' : ''}`}
              aria-pressed={order === key}
              onClick={() => setOrder(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {games.length ? (
        <div className="gcards">
          {games.map((game) => (
            <GameCard
              key={game.gamePk}
              game={game}
              rowsByKey={rowsByKey}
              slip={slip}
              toggleSlip={toggleSlip}
            />
          ))}
        </div>
      ) : (
        <div className="notice">
          <b>No game matches “{query}”.</b>
        </div>
      )}
    </>
  );
}
