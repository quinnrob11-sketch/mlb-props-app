// Criteria filter controls: a handful of inline chips in the existing toolbar
// plus a "Filters" modal holding the full four-group set.
//
// All predicate logic lives in `./filters.js` — this file is presentation and
// wiring only. It renders through the stylesheet's existing vocabulary
// (`toolbar`, `chips`, `chip`, `chip.on`, `btn`, `btn-ghost`, `modal`,
// `modal-bg`, `check`, `hint`, `row`); the only additions are the layout
// helpers `modal.wide` / `modal-body` / `grid2` / `fgroup`.

import { useMemo, useState } from 'react';

import {
  BOOK_CHOICES,
  DEFAULT_CRITERIA,
  KIND_CHOICES,
  KIND_LABEL,
  MARKET_CHOICES,
  VERDICT_TIERS,
  applyCriteria,
  countActiveCriteria,
  describeCriteria,
  gameOptions,
  normalizeCriteria,
  teamOptions,
} from './filters.js';

/** Toggle `value` in/out of `list`, preserving the caller's order. */
function toggle(list, value) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * A labelled number input that maps an empty box to `null` ("no bound").
 * `scale` lets a fraction-valued criterion (edge, Kelly, vig) be typed in
 * percent: the stored value is `typed / scale`.
 */
function NumField({ label, value, onChange, scale = 1, step, min, max, placeholder, hint }) {
  const shown = value == null ? '' : String(Math.round(value * scale * 1000) / 1000);
  return (
    <div className="fgroup">
      <label>{label}</label>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={shown}
        placeholder={placeholder || 'any'}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') return onChange(null);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n / scale : null);
        }}
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/** A row of toggle chips over a fixed option list. */
function ChipRow({ options, isOn, onToggle, labelOf = (v) => v }) {
  return (
    <div className="chips">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`chip ${isOn(opt) ? 'on' : ''}`}
          onClick={() => onToggle(opt)}
        >
          {labelOf(opt)}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, children }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/**
 * @param {object} props
 * @param {object} props.criteria      current (normalised) criteria
 * @param {(next:object)=>void} props.onChange  receives a full replacement object
 * @param {object[]} props.rows        UNFILTERED rows, for option lists + the live match count
 * @param {boolean} [props.showStrongChip]  render the BEST-BETS-only "STRONG only" chip
 * @param {number} [props.altCount]    callable alt rungs, shown on the ALT chip
 */
export default function FilterBar({ criteria, onChange, rows, showStrongChip, altCount = 0 }) {
  const [open, setOpen] = useState(false);
  const c = criteria;
  const set = (patch) => onChange(normalizeCriteria({ ...c, ...patch }));
  const reset = () => onChange(normalizeCriteria(DEFAULT_CRITERIA));

  const activeCount = countActiveCriteria(c);
  const teams = useMemo(() => teamOptions(rows), [rows]);
  const games = useMemo(() => gameOptions(rows), [rows]);
  const matching = useMemo(() => applyCriteria(rows, c).length, [rows, c]);

  // "STRONG only" is the tier list narrowed to exactly STRONG — the same
  // criterion the modal edits, not a parallel piece of state.
  const strongOnly = c.verdicts.length === 1 && c.verdicts[0] === 'STRONG';
  const marketsFor = (kind) => MARKET_CHOICES.filter((m) => m.kind === kind);

  return (
    <>
      {/* ── inline chips: the toggles worth reaching for every slate ── */}
      <button
        type="button"
        className={`chip ${c.hideAlts ? '' : 'on'}`}
        title="Alternate-line rungs (K 4.5/5.5/6.5…) that grade as callable"
        onClick={() => set({ hideAlts: !c.hideAlts })}
      >
        ALT lines{altCount > 0 ? ` (${altCount})` : ''}
      </button>

      {showStrongChip && (
        <button
          type="button"
          className={`chip ${strongOnly ? 'on' : ''}`}
          title="Show only STRONG verdicts"
          onClick={() => set({ verdicts: strongOnly ? [...VERDICT_TIERS] : ['STRONG'] })}
        >
          STRONG only
        </button>
      )}

      <button
        type="button"
        className={`chip ${c.minEv != null ? 'on' : ''}`}
        title="Minimum expected value of 5% of stake"
        onClick={() => set({ minEv: c.minEv != null ? null : 5 })}
      >
        EV 5%+
      </button>

      <button
        type="button"
        className={`chip ${c.twoSidedOnly ? 'on' : ''}`}
        title="Only markets with a genuine two-way price"
        onClick={() => set({ twoSidedOnly: !c.twoSidedOnly })}
      >
        2-sided
      </button>

      <button
        type="button"
        className={`chip ${c.excludeSmallSample ? 'on' : ''}`}
        title="Drop players flagged SMALL SAMPLE"
        onClick={() => set({ excludeSmallSample: !c.excludeSmallSample })}
      >
        No small sample
      </button>

      <button
        type="button"
        className={`btn ${activeCount ? 'btn-primary' : ''}`}
        onClick={() => setOpen(true)}
        title={activeCount ? describeCriteria(c).join(' · ') : 'Filter the board by criteria'}
      >
        ⚙ Filters
        {activeCount > 0 && <span className="n">({activeCount})</span>}
      </button>

      {activeCount > 0 && (
        <button type="button" className="btn btn-ghost" onClick={reset} title="Clear every filter">
          Reset
        </button>
      )}

      {/* ── the full set ── */}
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>Filter criteria</h3>
            <p className="hint">
              {matching} of {rows.length} rows on this slate match
              {activeCount > 0
                ? ` · ${activeCount} ${activeCount > 1 ? 'criteria' : 'criterion'} changed from default`
                : ' · all criteria at their defaults'}
            </p>

            <div className="modal-body">
              {/* 1 ─────────────────────────────────────────────────────── */}
              <h4>Edge &amp; confidence</h4>
              <div className="grid2">
                <NumField
                  label="Min edge (probability points)"
                  value={c.minEdge}
                  scale={100}
                  step="0.5"
                  min="0"
                  max="50"
                  onChange={(v) => set({ minEdge: v })}
                  hint="Model % minus de-vigged book %, on the called side."
                />
                <NumField
                  label="Min EV (% of stake)"
                  value={c.minEv}
                  step="0.5"
                  onChange={(v) => set({ minEv: v })}
                  hint="Negative values are allowed if you want to see the whole board."
                />
                <NumField
                  label="Min ¼-Kelly stake (% of bankroll)"
                  value={c.minKelly}
                  scale={100}
                  step="0.1"
                  min="0"
                  max="100"
                  onChange={(v) => set({ minKelly: v })}
                />
              </div>
              <label>Verdict tier</label>
              <ChipRow
                options={VERDICT_TIERS}
                isOn={(v) => c.verdicts.includes(v)}
                onToggle={(v) => set({ verdicts: toggle(c.verdicts, v) })}
              />
              <p className="hint">
                All four selected means no tier filter. Deselecting a tier also hides rows that have
                no verdict at all (no book line).
              </p>

              {/* 2 ─────────────────────────────────────────────────────── */}
              <h4>Odds &amp; book</h4>
              <div className="grid2">
                <NumField
                  label="Min American odds"
                  value={c.oddsMin}
                  step="5"
                  onChange={(v) => set({ oddsMin: v })}
                  placeholder="e.g. -250"
                />
                <NumField
                  label="Max American odds"
                  value={c.oddsMax}
                  step="5"
                  onChange={(v) => set({ oddsMax: v })}
                  placeholder="e.g. +150"
                />
                <NumField
                  label="Max vig (%)"
                  value={c.maxVig}
                  scale={100}
                  step="0.5"
                  min="0"
                  onChange={(v) => set({ maxVig: v })}
                  hint="Market overround across the books at this line."
                />
                <NumField
                  label="Min books at the line"
                  value={c.minBooks}
                  step="1"
                  min="0"
                  onChange={(v) => set({ minBooks: v })}
                />
              </div>
              <label>Require a price from</label>
              <ChipRow
                options={BOOK_CHOICES}
                isOn={(b) => c.requireBook === b}
                onToggle={(b) => set({ requireBook: c.requireBook === b ? null : b })}
              />
              <Check checked={c.twoSidedOnly} onChange={(v) => set({ twoSidedOnly: v })}>
                Two-sided lines only — skip markets priced on one side, where the fair price is a
                guess
              </Check>

              {/* 3 ─────────────────────────────────────────────────────── */}
              <h4>Data quality</h4>
              <div className="grid2">
                <NumField
                  label="Min season sample (PA for bats, BF for arms)"
                  value={c.minSample}
                  step="10"
                  min="0"
                  onChange={(v) => set({ minSample: v })}
                  hint="A player with no season line at all counts as 0."
                />
              </div>
              <Check
                checked={c.excludeSmallSample}
                onChange={(v) => set({ excludeSmallSample: v })}
              >
                Exclude <b>SMALL SAMPLE</b> players
              </Check>
              <Check
                checked={c.confirmedLineupOnly}
                onChange={(v) => set({ confirmedLineupOnly: v })}
              >
                Confirmed lineups only — drops batters on projected/fallback lineups and anything
                flagged <b>PROJ LINEUP</b>
              </Check>
              <Check checked={c.excludeBulkOpener} onChange={(v) => set({ excludeBulkOpener: v })}>
                Exclude <b>BULK/OPENER RISK</b> arms
              </Check>
              <Check checked={c.excludeShortLeash} onChange={(v) => set({ excludeShortLeash: v })}>
                Exclude <b>SHORT LEASH</b> arms
              </Check>

              {/* 4 ─────────────────────────────────────────────────────── */}
              <h4>Slate &amp; market</h4>
              <label>Board</label>
              <ChipRow
                options={KIND_CHOICES}
                labelOf={(k) => KIND_LABEL[k]}
                isOn={(k) => c.kinds.includes(k)}
                onToggle={(k) => set({ kinds: toggle(c.kinds, k) })}
              />

              <label>Pitcher markets</label>
              <div className="chips">
                {marketsFor('pitcher').map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`chip ${c.markets.includes(m.key) ? 'on' : ''}`}
                    title={m.label}
                    onClick={() => set({ markets: toggle(c.markets, m.key) })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <label>Batter markets</label>
              <div className="chips">
                {marketsFor('batter').map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`chip ${c.markets.includes(m.key) ? 'on' : ''}`}
                    title={m.label}
                    onClick={() => set({ markets: toggle(c.markets, m.key) })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="hint">
                No market selected means every market.
                {c.markets.length > 0 && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => set({ markets: [] })}
                    >
                      Clear {c.markets.length}
                    </button>
                  </>
                )}
              </p>

              <div className="grid2">
                <div className="fgroup">
                  <label>First pitch from</label>
                  <input
                    type="time"
                    value={c.startAfter || ''}
                    onChange={(e) => set({ startAfter: e.target.value || null })}
                  />
                </div>
                <div className="fgroup">
                  <label>First pitch until</label>
                  <input
                    type="time"
                    value={c.startBefore || ''}
                    onChange={(e) => set({ startBefore: e.target.value || null })}
                  />
                </div>
              </div>
              <p className="hint">Local wall-clock time, inclusive on both ends.</p>

              <label>Teams {c.teams.length > 0 ? `(${c.teams.length})` : ''}</label>
              {teams.length ? (
                <ChipRow
                  options={teams}
                  isOn={(t) => c.teams.includes(t)}
                  onToggle={(t) => set({ teams: toggle(c.teams, t) })}
                />
              ) : (
                <p className="hint">No teams on the board yet.</p>
              )}

              <label>Games {c.games.length > 0 ? `(${c.games.length})` : ''}</label>
              {games.length ? (
                <ChipRow
                  options={games}
                  isOn={(g) => c.games.includes(g)}
                  onToggle={(g) => set({ games: toggle(c.games, g) })}
                />
              ) : (
                <p className="hint">No games on the board yet.</p>
              )}

              <Check checked={c.hideAlts} onChange={(v) => set({ hideAlts: v })}>
                Hide alternate lines — off-consensus rungs of the same market
              </Check>
            </div>

            <div className="row">
              <button className="btn btn-ghost" onClick={reset} disabled={activeCount === 0}>
                Reset all
              </button>
              <button className="btn btn-primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
