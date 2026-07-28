// Unit tests for the criteria filter (src/ui/filters.js).
//
//   node --test test/          (npm test)
//
// Pure module — no DOM, no React. `localStorage` is absent under node, which
// the persistence helpers are expected to tolerate.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CRITERIA,
  VERDICT_TIERS,
  KIND_CHOICES,
  MARKET_CHOICES,
  applyCriteria,
  countActiveCriteria,
  describeCriteria,
  diagnoseCriteria,
  explainEmpty,
  gameOptions,
  hasFlag,
  isConfirmedLineup,
  isDefaultCriteria,
  loadCriteria,
  marketLabel,
  normalizeCriteria,
  parseHm,
  parseIp,
  relaxCriterion,
  rowBookCount,
  rowBooks,
  rowEdgePts,
  rowEv,
  rowKelly,
  rowOdds,
  rowSample,
  rowStartMinutes,
  rowTeams,
  rowTwoSided,
  rowVig,
  saveCriteria,
  teamOptions,
} from '../src/ui/filters.js';

// ── fixtures ───────────────────────────────────────────────────────────────

/** A fully-populated row, overridable field by field. */
function makeRow(over = {}) {
  const edge = {
    modelOver: 0.6,
    usedOver: 0.57,
    fairOver: 0.52,
    vig: 0.045,
    twoSided: true,
    nBooks: 4,
    sharp: true,
    edge: 0.08,
    side: 'over',
    sideEdge: 0.08,
    ev: 12,
    odds: -110,
    verdict: 'STRONG',
    kelly: 0.03,
    ...(over.edge || {}),
  };
  return {
    kind: 'pitcher',
    key: 'p:1:pitcher_strikeouts',
    alt: false,
    playerId: 1,
    name: 'Test Arm',
    team: 'NYY',
    teamName: 'New York Yankees',
    matchup: 'NYY @ BOS',
    gameDate: '2026-07-28T23:05:00Z',
    opp: 'BOS',
    market: 'pitcher_strikeouts',
    label: 'Strikeouts',
    line: 5.5,
    book: 'DK',
    overBook: 'DK',
    underBook: 'PIN',
    nBooks: 4,
    over: -110,
    under: -110,
    proj: 6.1,
    flags: [],
    detailRef: { season: { pa: null, ip: '90.0' } },
    ...over,
    edge,
  };
}

/** Local-time ISO string for today at HH:MM, so start-window tests are TZ-safe. */
function localAt(hour, minute = 0) {
  const d = new Date(2026, 6, 28, hour, minute, 0, 0);
  return d.toISOString();
}

// ── defaults ───────────────────────────────────────────────────────────────

test('DEFAULT_CRITERIA filters nothing except alternate lines', () => {
  // The badge counts criteria moved off their default, so a fresh install
  // reads zero even though the (default-on) alt rule is narrowing the board.
  assert.equal(countActiveCriteria(DEFAULT_CRITERIA), 0);
  assert.equal(isDefaultCriteria(DEFAULT_CRITERIA), true);
  assert.deepEqual(describeCriteria(DEFAULT_CRITERIA), ['alternate lines hidden']);

  const rows = [makeRow(), makeRow({ key: 'alt', alt: true })];
  assert.equal(applyCriteria(rows, DEFAULT_CRITERIA).length, 1);
  assert.equal(applyCriteria(rows, { ...DEFAULT_CRITERIA, hideAlts: false }).length, 2);
  // Showing alts is itself a deviation from the default, so it does count.
  assert.equal(countActiveCriteria({ ...DEFAULT_CRITERIA, hideAlts: false }), 1);
  assert.equal(isDefaultCriteria({ ...DEFAULT_CRITERIA, hideAlts: false }), false);
});

test('applyCriteria returns a new array and never mutates the input', () => {
  const rows = [makeRow()];
  const out = applyCriteria(rows, { hideAlts: false });
  assert.notEqual(out, rows);
  assert.deepEqual(out, rows);
  assert.equal(applyCriteria(null, DEFAULT_CRITERIA).length, 0);
  assert.equal(applyCriteria(undefined, undefined).length, 0);
});

// ── defensive reading ──────────────────────────────────────────────────────

test('a row mid-migration (no edge, no flags) never throws', () => {
  const bare = { kind: 'batter', market: 'batter_hits', matchup: 'A @ B' };
  const criteria = {
    minEdge: 0.03,
    minEv: 5,
    minKelly: 0.01,
    oddsMin: -200,
    oddsMax: 150,
    maxVig: 0.06,
    minBooks: 2,
    requireBook: 'DK',
    twoSidedOnly: true,
    minSample: 100,
    excludeSmallSample: true,
    confirmedLineupOnly: true,
    excludeBulkOpener: true,
    excludeShortLeash: true,
    markets: ['batter_hits'],
    kinds: ['batter'],
    startAfter: '12:00',
    startBefore: '23:00',
    teams: ['A'],
    games: ['A @ B'],
    hideAlts: true,
  };
  assert.doesNotThrow(() => applyCriteria([bare, null, undefined], criteria));
  // Everything unreadable is excluded rather than crashing.
  assert.equal(applyCriteria([bare], criteria).length, 0);
  // ...but with no active criteria it survives untouched.
  assert.equal(applyCriteria([bare], { hideAlts: false }).length, 1);
});

test('accessors tolerate missing fields', () => {
  assert.equal(rowEv({}), null);
  assert.equal(rowEdgePts({}), null);
  assert.equal(rowKelly({}), null);
  assert.equal(rowOdds({}), null);
  assert.equal(rowVig({}), null);
  assert.equal(rowBookCount({}), null);
  assert.equal(rowStartMinutes({}), null);
  assert.equal(rowTwoSided({}), false);
  assert.equal(hasFlag({}, 'SMALL SAMPLE'), false);
  assert.deepEqual([...rowBooks({})], []);
  assert.deepEqual([...rowTeams({})], []);
});

test('rowEdgePts is absolute and prefers sideEdge over raw edge', () => {
  assert.equal(rowEdgePts(makeRow({ edge: { sideEdge: -0.09, edge: 0.09 } })), 0.09);
  const noSide = makeRow();
  delete noSide.edge.sideEdge;
  noSide.edge.edge = -0.04;
  assert.equal(rowEdgePts(noSide), 0.04);
});

test('rowOdds falls back to the posted side price', () => {
  const row = makeRow({ over: -125, under: 105 });
  delete row.edge.odds;
  assert.equal(rowOdds(row), -125);
  row.edge.side = 'under';
  assert.equal(rowOdds(row), 105);
  row.edge.side = null;
  assert.equal(rowOdds(row), null);
});

// ── group 1: edge & confidence ─────────────────────────────────────────────

test('minEdge / minEv / minKelly are inclusive lower bounds', () => {
  const rows = [
    makeRow({ key: 'a', edge: { sideEdge: 0.08, ev: 12, kelly: 0.03 } }),
    makeRow({ key: 'b', edge: { sideEdge: 0.05, ev: 6, kelly: 0.01 } }),
    makeRow({ key: 'c', edge: { sideEdge: 0.02, ev: 1, kelly: 0.001 } }),
  ];
  const keys = (c) => applyCriteria(rows, { hideAlts: false, ...c }).map((r) => r.key);
  assert.deepEqual(keys({ minEdge: 0.05 }), ['a', 'b']);
  assert.deepEqual(keys({ minEv: 6 }), ['a', 'b']);
  assert.deepEqual(keys({ minKelly: 0.01 }), ['a', 'b']);
  assert.deepEqual(keys({ minEdge: 0.05, minEv: 12 }), ['a']);
});

test('verdict tiers: PASS is only included when selected', () => {
  const rows = VERDICT_TIERS.map((v, i) => makeRow({ key: `v${i}`, edge: { verdict: v } }));
  const base = { hideAlts: false };
  assert.equal(applyCriteria(rows, base).length, 4);
  assert.deepEqual(
    applyCriteria(rows, { ...base, verdicts: ['STRONG', 'SOLID', 'LEAN'] }).map(
      (r) => r.edge.verdict,
    ),
    ['STRONG', 'SOLID', 'LEAN'],
  );
  assert.deepEqual(
    applyCriteria(rows, { ...base, verdicts: ['STRONG'] }).map((r) => r.edge.verdict),
    ['STRONG'],
  );
});

test('a narrowed verdict list drops rows that have no edge at all', () => {
  const priced = makeRow({ key: 'priced' });
  const unpriced = makeRow({ key: 'unpriced', line: null });
  unpriced.edge = null;
  const rows = [priced, unpriced];
  // All tiers selected = no tier filter, so the unpriced row survives.
  assert.equal(applyCriteria(rows, { hideAlts: false }).length, 2);
  assert.deepEqual(
    applyCriteria(rows, { hideAlts: false, verdicts: ['STRONG'] }).map((r) => r.key),
    ['priced'],
  );
});

// ── group 2: odds & book ───────────────────────────────────────────────────

test('odds range is inclusive on both ends', () => {
  const rows = [-300, -110, 120, 300].map((odds, i) =>
    makeRow({ key: `o${i}`, edge: { odds } }),
  );
  const got = (c) => applyCriteria(rows, { hideAlts: false, ...c }).map((r) => r.edge.odds);
  assert.deepEqual(got({ oddsMin: -200, oddsMax: 150 }), [-110, 120]);
  assert.deepEqual(got({ oddsMin: -300, oddsMax: 300 }), [-300, -110, 120, 300]);
  assert.deepEqual(got({ oddsMax: -110 }), [-300, -110]);
  assert.deepEqual(got({ oddsMin: 120 }), [120, 300]);
});

test('maxVig, minBooks, requireBook and twoSidedOnly', () => {
  const cheap = makeRow({ key: 'cheap', nBooks: 5, edge: { vig: 0.02 } });
  const juicy = makeRow({
    key: 'juicy',
    nBooks: 1,
    book: 'FD',
    overBook: 'FD',
    underBook: null,
    under: null,
    edge: { vig: 0.09, twoSided: false, nBooks: 1 },
  });
  const rows = [cheap, juicy];
  const keys = (c) => applyCriteria(rows, { hideAlts: false, ...c }).map((r) => r.key);

  assert.deepEqual(keys({ maxVig: 0.05 }), ['cheap']);
  assert.deepEqual(keys({ minBooks: 2 }), ['cheap']);
  assert.deepEqual(keys({ requireBook: 'PIN' }), ['cheap']);
  assert.deepEqual(keys({ requireBook: 'FD' }), ['juicy']);
  assert.deepEqual(keys({ requireBook: 'DK' }), ['cheap']);
  assert.deepEqual(keys({ twoSidedOnly: true }), ['cheap']);
});

test('rowBooks collects every book label attached to the row', () => {
  const row = makeRow({ book: 'dk', overBook: 'MGM', underBook: 'PIN' });
  assert.deepEqual([...rowBooks(row)].sort(), ['DK', 'MGM', 'PIN']);
  const withQuotes = makeRow({ quotes: [{ book: 'CZR' }, { book: 'FD' }] });
  assert.equal(rowBooks(withQuotes).has('CZR'), true);
  assert.equal(rowBooks(makeRow({ books: ['FD'] })).has('FD'), true);
});

test('twoSidedOnly falls back to the posted prices when edge.twoSided is absent', () => {
  const row = makeRow({ over: -110, under: null });
  delete row.edge.twoSided;
  assert.equal(rowTwoSided(row), false);
  row.under = -110;
  assert.equal(rowTwoSided(row), true);
});

// ── group 3: data quality ──────────────────────────────────────────────────

test('flag exclusions drop exactly the flagged rows', () => {
  const clean = makeRow({ key: 'clean', flags: [] });
  const small = makeRow({ key: 'small', flags: ['SMALL SAMPLE'] });
  const bulk = makeRow({ key: 'bulk', flags: ['BULK/OPENER RISK'] });
  const leash = makeRow({ key: 'leash', flags: ['SHORT LEASH', 'PLATOON+'] });
  const rows = [clean, small, bulk, leash];
  const keys = (c) => applyCriteria(rows, { hideAlts: false, ...c }).map((r) => r.key);

  assert.deepEqual(keys({ excludeSmallSample: true }), ['clean', 'bulk', 'leash']);
  assert.deepEqual(keys({ excludeBulkOpener: true }), ['clean', 'small', 'leash']);
  assert.deepEqual(keys({ excludeShortLeash: true }), ['clean', 'small', 'bulk']);
  assert.deepEqual(
    keys({ excludeSmallSample: true, excludeBulkOpener: true, excludeShortLeash: true }),
    ['clean'],
  );
});

test('rowSample reads batter PA, pitcher BF, or derives BF from innings', () => {
  assert.equal(rowSample(makeRow({ detailRef: { season: { pa: 412 } } })), 412);
  assert.equal(rowSample(makeRow({ detailRef: { season: { pa: '250' } } })), 250);
  assert.equal(rowSample(makeRow({ detailRef: { season: { bf: 380 } } })), 380);
  // 90 IP * 4.3 BF/inning.
  assert.equal(rowSample(makeRow({ detailRef: { season: { ip: '90.0' } } })), 387);
  // No season line at all is the smallest possible sample, not "unknown".
  assert.equal(rowSample(makeRow({ detailRef: {} })), 0);
  assert.equal(rowSample({}), 0);
  // Explicit sampleSize wins.
  assert.equal(rowSample(makeRow({ sampleSize: 7, detailRef: { season: { pa: 400 } } })), 7);
});

test('parseIp treats the fractional digit as outs', () => {
  assert.equal(parseIp('45.0'), 45);
  assert.equal(parseIp('45.1'), 45 + 1 / 3);
  assert.equal(parseIp('45.2'), 45 + 2 / 3);
  assert.equal(parseIp(null), null);
  assert.equal(parseIp('nope'), null);
});

test('minSample keeps rows at or above the threshold', () => {
  const rows = [
    makeRow({ key: 'big', detailRef: { season: { pa: 400 } } }),
    makeRow({ key: 'small', detailRef: { season: { pa: 80 } } }),
    makeRow({ key: 'none', detailRef: null }),
  ];
  assert.deepEqual(
    applyCriteria(rows, { hideAlts: false, minSample: 100 }).map((r) => r.key),
    ['big'],
  );
});

test('confirmed-lineup filter: pitchers exempt, unknown source passes', () => {
  const pitcher = makeRow({ key: 'p', kind: 'pitcher' });
  const unknown = makeRow({ key: 'unknown', kind: 'batter' });
  const confirmed = makeRow({ key: 'confirmed', kind: 'batter', lineupSource: 'confirmed' });
  const projected = makeRow({ key: 'projected', kind: 'batter', lineupSource: 'projected' });
  const fallback = makeRow({ key: 'fallback', kind: 'batter', lineupSource: 'fallback' });
  const flagged = makeRow({ key: 'flagged', kind: 'batter', flags: ['PROJ LINEUP'] });
  const viaDetail = makeRow({
    key: 'viaDetail',
    kind: 'batter',
    detailRef: { lineupSource: 'projected' },
  });
  const viaGame = makeRow({ key: 'viaGame', kind: 'batter', game: { lineupSource: 'projected' } });

  assert.equal(isConfirmedLineup(pitcher), true);
  assert.equal(isConfirmedLineup(unknown), true);
  assert.equal(isConfirmedLineup(flagged), false);

  const rows = [pitcher, unknown, confirmed, projected, fallback, flagged, viaDetail, viaGame];
  assert.deepEqual(
    applyCriteria(rows, { hideAlts: false, confirmedLineupOnly: true }).map((r) => r.key),
    ['p', 'unknown', 'confirmed'],
  );
});

// ── group 4: slate & market ────────────────────────────────────────────────

test('market multi-select uses the market keys behind PITCHER/BATTER_MARKETS', () => {
  assert.equal(MARKET_CHOICES.length, 14);
  assert.equal(marketLabel('batter_total_bases'), 'Total Bases');
  assert.equal(marketLabel('unknown_market'), 'unknown_market');

  const rows = [
    makeRow({ key: 'k', market: 'pitcher_strikeouts' }),
    makeRow({ key: 'tb', market: 'batter_total_bases', kind: 'batter' }),
    makeRow({ key: 'hr', market: 'batter_home_runs', kind: 'batter' }),
  ];
  assert.deepEqual(
    applyCriteria(rows, {
      hideAlts: false,
      markets: ['pitcher_strikeouts', 'batter_home_runs'],
    }).map((r) => r.key),
    ['k', 'hr'],
  );
});

test('kind filter covers pitcher / batter / nrfi', () => {
  const rows = [
    makeRow({ key: 'p', kind: 'pitcher' }),
    makeRow({ key: 'b', kind: 'batter' }),
    makeRow({ key: 'n', kind: 'nrfi' }),
  ];
  assert.deepEqual(KIND_CHOICES, ['pitcher', 'batter', 'nrfi']);
  assert.equal(applyCriteria(rows, { hideAlts: false }).length, 3);
  assert.deepEqual(
    applyCriteria(rows, { hideAlts: false, kinds: ['batter', 'nrfi'] }).map((r) => r.key),
    ['b', 'n'],
  );
});

test('game-time window compares local wall clock', () => {
  const rows = [
    makeRow({ key: 'noon', gameDate: localAt(12, 5) }),
    makeRow({ key: 'evening', gameDate: localAt(19, 10) }),
    makeRow({ key: 'late', gameDate: localAt(22, 40) }),
  ];
  assert.equal(rowStartMinutes(rows[1]), 19 * 60 + 10);
  const keys = (c) => applyCriteria(rows, { hideAlts: false, ...c }).map((r) => r.key);
  assert.deepEqual(keys({ startAfter: '18:00' }), ['evening', 'late']);
  assert.deepEqual(keys({ startBefore: '20:00' }), ['noon', 'evening']);
  assert.deepEqual(keys({ startAfter: '13:00', startBefore: '20:00' }), ['evening']);
  // An unparseable bound is dropped by normalizeCriteria rather than applied.
  assert.equal(normalizeCriteria({ startAfter: '99:99' }).startAfter, null);
  assert.equal(parseHm('7:05'), 7 * 60 + 5);
  assert.equal(parseHm('nope'), null);
});

test('team and game multi-selects match either side of the matchup', () => {
  const nyy = makeRow({ key: 'nyy', team: 'NYY', matchup: 'NYY @ BOS' });
  const bos = makeRow({ key: 'bos', team: 'BOS', matchup: 'NYY @ BOS' });
  const lad = makeRow({ key: 'lad', team: 'LAD', matchup: 'SD @ LAD' });
  const rows = [nyy, bos, lad];

  assert.deepEqual([...rowTeams(nyy)].sort(), ['BOS', 'NYY']);
  assert.deepEqual(teamOptions(rows), ['BOS', 'LAD', 'NYY', 'SD']);
  assert.deepEqual(gameOptions(rows).sort(), ['NYY @ BOS', 'SD @ LAD']);

  const keys = (c) => applyCriteria(rows, { hideAlts: false, ...c }).map((r) => r.key);
  // Picking BOS keeps both sides of the BOS game — it is a game-level filter.
  assert.deepEqual(keys({ teams: ['BOS'] }), ['nyy', 'bos']);
  assert.deepEqual(keys({ teams: ['LAD'] }), ['lad']);
  assert.deepEqual(keys({ games: ['SD @ LAD'] }), ['lad']);
});

// ── normalisation ──────────────────────────────────────────────────────────

test('normalizeCriteria coerces junk back to a usable shape', () => {
  const c = normalizeCriteria({
    minEdge: '0.05',
    minEv: 'abc',
    minKelly: 5, // clamped to 1
    verdicts: ['STRONG', 'NOPE', 'STRONG'],
    kinds: [],
    markets: ['pitcher_strikeouts', 'not_a_market'],
    requireBook: 'BOVADA',
    minBooks: 2.6,
    twoSidedOnly: 'yes',
    teams: ['NYY', 5],
    startAfter: ' 18:30 ',
    extraJunk: true,
  });
  assert.equal(c.minEdge, 0.05);
  assert.equal(c.minEv, null);
  assert.equal(c.minKelly, 1);
  assert.deepEqual(c.verdicts, ['STRONG']);
  assert.deepEqual(c.kinds, KIND_CHOICES); // empty list is not a valid filter
  assert.deepEqual(c.markets, ['pitcher_strikeouts']);
  assert.equal(c.requireBook, null);
  assert.equal(c.minBooks, 3);
  assert.equal(c.twoSidedOnly, false);
  assert.deepEqual(c.teams, ['NYY']);
  assert.equal(c.startAfter, '18:30');
  assert.equal('extraJunk' in c, false);
  assert.deepEqual(normalizeCriteria(null), normalizeCriteria(DEFAULT_CRITERIA));
  assert.deepEqual(normalizeCriteria('nope'), normalizeCriteria(undefined));
});

test('relaxCriterion resets every field the criterion owns', () => {
  const c = normalizeCriteria({ oddsMin: -150, oddsMax: 120, minEv: 5 });
  const relaxed = relaxCriterion(c, 'odds');
  assert.equal(relaxed.oddsMin, null);
  assert.equal(relaxed.oddsMax, null);
  assert.equal(relaxed.minEv, 5, 'other criteria untouched');
  assert.deepEqual(relaxCriterion(c, 'nonexistent'), c);
});

test('countActiveCriteria counts a two-field criterion once', () => {
  assert.equal(countActiveCriteria({}), 0);
  assert.equal(countActiveCriteria({ oddsMin: -150, oddsMax: 120 }), 1);
  assert.equal(countActiveCriteria({ startAfter: '18:00', startBefore: '22:00' }), 1);
  assert.equal(countActiveCriteria({ minEv: 5, excludeSmallSample: true }), 2);
  // ...and the alt rule counts only once it is moved off its default.
  assert.equal(countActiveCriteria({ minEv: 5, hideAlts: false }), 2);
});

// ── diagnostics / empty state ──────────────────────────────────────────────

test('diagnoseCriteria ranks the filter doing the most damage first', () => {
  const rows = [
    makeRow({ key: 'a', edge: { ev: 12 }, flags: ['SMALL SAMPLE'] }),
    makeRow({ key: 'b', edge: { ev: 1 }, flags: ['SMALL SAMPLE'] }),
    makeRow({ key: 'c', edge: { ev: 1 }, flags: ['SMALL SAMPLE'] }),
    makeRow({ key: 'd', edge: { ev: 1 }, flags: [] }),
  ];
  const criteria = { hideAlts: false, minEv: 10, excludeSmallSample: true };
  assert.equal(applyCriteria(rows, criteria).length, 0);

  const diag = diagnoseCriteria(rows, criteria);
  assert.deepEqual(
    diag.map((d) => d.key),
    ['minEv', 'excludeSmallSample'],
  );
  // Dropping the EV floor lets the three small-sample-free... none: only 'd'
  // clears the flag test, so relaxing minEv recovers 'd'.
  assert.equal(diag[0].recovered, 1);
  assert.equal(diag[1].recovered, 1);
  assert.equal(diag[0].label, 'EV ≥ 10%');
});

test('explainEmpty names the biggest cut', () => {
  const rows = [
    makeRow({ key: 'a', edge: { ev: 1 } }),
    makeRow({ key: 'b', edge: { ev: 2 } }),
  ];
  const msg = explainEmpty(rows, { hideAlts: false, minEv: 20 });
  assert.ok(msg);
  assert.match(msg.headline, /Filtered out all 2 rows/);
  assert.match(msg.detail, /EV ≥ 20%/);
  assert.match(msg.detail, /brings back 2 rows/);
});

test('explainEmpty admits when no single filter is responsible', () => {
  // Every row fails BOTH criteria, so relaxing either one alone recovers none.
  const rows = [
    makeRow({ key: 'a', edge: { ev: 1 }, flags: ['SMALL SAMPLE'] }),
    makeRow({ key: 'b', edge: { ev: 2 }, flags: ['SMALL SAMPLE'] }),
  ];
  const msg = explainEmpty(rows, { hideAlts: false, minEv: 10, excludeSmallSample: true });
  assert.ok(msg);
  assert.match(msg.detail, /No single filter is responsible/);
  assert.match(msg.detail, /2 are active together/);
});

test('explainEmpty returns null when the criteria are not the reason', () => {
  assert.equal(explainEmpty([makeRow()], { hideAlts: false }), null, 'no active criteria');
  assert.equal(explainEmpty([], { minEv: 10 }), null, 'nothing to filter in the first place');
  assert.equal(explainEmpty(null, { minEv: 10 }), null);
});

// ── persistence ────────────────────────────────────────────────────────────

test('loadCriteria / saveCriteria round-trip through a localStorage shim', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    // First run with no keys at all: defaults, alts hidden.
    assert.equal(loadCriteria().hideAlts, true);

    // First run for a user who had opted into alts under the old key.
    store.set('showAlts', 'on');
    assert.equal(loadCriteria().hideAlts, false);

    const saved = saveCriteria({ minEv: 5, verdicts: ['STRONG'], hideAlts: false });
    assert.equal(store.get('showAlts'), 'on', 'legacy key mirrored');
    assert.equal(JSON.parse(store.get('criteriaV1')).minEv, 5);
    assert.deepEqual(loadCriteria(), saved);

    // A corrupt blob degrades to the legacy-seeded defaults instead of throwing.
    store.set('criteriaV1', '{not json');
    assert.doesNotThrow(() => loadCriteria());
    assert.deepEqual(loadCriteria(), normalizeCriteria({ hideAlts: false }));
    store.delete('showAlts');
    assert.equal(loadCriteria().hideAlts, true, 'alts hidden by default');
    assert.equal(countActiveCriteria(loadCriteria()), 0, 'defaults are not "filters set"');
  } finally {
    delete globalThis.localStorage;
  }
});

test('persistence helpers no-op without localStorage', () => {
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.doesNotThrow(() => loadCriteria());
  assert.deepEqual(loadCriteria(), normalizeCriteria(DEFAULT_CRITERIA));
  assert.deepEqual(saveCriteria({ minEv: 3 }).minEv, 3);
});
