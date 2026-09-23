// tools/fit-game-model.mjs grew exports so tools/fit-game-v2.mjs could refit
// the four structural constants on a chosen window (docs/GAME-EDGE-SEARCH.md).
// These guard the refactor: the measurement and the league simulation must
// still produce exactly what the shipped constants were fitted against.

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, loss, targetsFrom, TARGET_2026_FULL } from '../tools/fit-game-model.mjs';
import { HOME_ADJUST, WALKOFF_EXACT, SIGMA_SHARED, SIGMA_TEAM_TOTAL } from '../src/model/game.js';

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('the shipped constants still reproduce the 2026 league rates they were fitted to', () => {
  const r = run(HOME_ADJUST, WALKOFF_EXACT, SIGMA_SHARED, SIGMA_TEAM_TOTAL);
  const t = TARGET_2026_FULL;
  close(r.homeWin, t.homeWin, 0.004, 'home win');
  close(r.nrfi, t.nrfi, 0.008, 'NRFI');
  close(r.homeCover15, t.homeCover15, 0.006, 'home -1.5');
  close(r.over85, t.over85, 0.008, 'over 8.5');
  close(r.homeBy1, t.homeBy1, 0.006, 'home wins by one');
  // The loss at the shipped point is small; any refactor that changed the
  // simulation would blow this up long before it moved a rate above.
  assert.ok(loss(r, t) < 12, `loss ${loss(r, t)}`);
});

test('targetsFrom measures the rates the fit minimises against', () => {
  // Four games: 5-4 home (walk-off shape), 2-1 away, 6-6 -> 7-6 in extras,
  // 0-3 away with a scoreless first.
  const g = [
    { a: 4, h: 5, inn: 9, nrfi: 1 },
    { a: 2, h: 1, inn: 9, nrfi: 0 },
    { a: 6, h: 7, inn: 11, nrfi: 1 },
    { a: 3, h: 0, inn: 9, nrfi: 1 },
  ];
  const t = targetsFrom(g);
  assert.equal(t.n, 4);
  assert.equal(t.homeWin, 0.5);
  assert.equal(t.nrfi, 0.75);
  assert.equal(t.extras, 0.25);
  assert.equal(t.homeBy1, 0.5); // 5-4 and 7-6
  assert.equal(t.awayBy1, 0.25); // 2-1
  assert.equal(t.homeCover15, 0); // no home win by two or more
  assert.equal(t.awayCover15, 0.25); // 3-0
  assert.equal(t.meanAway, 3.75);
  assert.equal(t.meanHome, 3.25);
  assert.equal(t.over85, 0.5); // 13 and 9
});
