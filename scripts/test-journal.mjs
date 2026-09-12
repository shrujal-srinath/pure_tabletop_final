// box-pi/scripts/test-journal.mjs
// Throwaway verification for daemon/journal.js. Covers: same-process
// reconstruction, a simulated crash/restart (fresh createJournal() instance
// pointed at the same dir), and a forced snapshot rotation followed by more
// actions, to prove replay isn't secretly relying on pre-rotation entries.

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createJournal } from '../daemon/journal.js';
import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';

const TEST_DIR = './data-test';
fs.rmSync(TEST_DIR, { recursive: true, force: true }); // clean slate for repeat runs

// Small threshold so the test can force a rotation without playing 50 real actions.
const SNAPSHOT_EVERY = 5;

let expected = createEmptyState();
function apply(journal, action) {
    expected = reduce(expected, action);
    journal.recordAction(action, expected);
    return expected;
}

console.log('─── phase 1: journal #1 — SETUP_GAME + 3 actions (no rotation yet) ───');
let journal1 = createJournal({ dir: TEST_DIR, snapshotEveryNActions: SNAPSHOT_EVERY });

apply(journal1, { type: ACTIONS.SETUP_GAME, payload: {
    teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
    periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'stats',
    roster: { teamA: [{ id: 'p1', name: 'Arjun', number: '7' }], teamB: [] },
} });
apply(journal1, { type: ACTIONS.SCORE, payload: { team: 'A', points: 2, playerId: 'p1' } });
apply(journal1, { type: ACTIONS.FOUL, payload: { team: 'B' } });
apply(journal1, { type: ACTIONS.SCORE, payload: { team: 'B', points: 3 } });

const reconstructed1 = journal1.reconstructState();
assert.deepEqual(reconstructed1, expected, 'reconstructState() should match the actual last state fed in');
console.log('OK — reconstructState() matches after 4 actions, same process.');
console.log('teamA score:', reconstructed1.teamA.score, '| teamB score:', reconstructed1.teamB.score);

console.log('\n─── phase 2: simulated crash — fresh createJournal() on the same dir ───');
const journal2 = createJournal({ dir: TEST_DIR, snapshotEveryNActions: SNAPSHOT_EVERY });
const reconstructed2 = journal2.reconstructState();
assert.deepEqual(reconstructed2, expected, 'a fresh journal instance should reconstruct the same state from disk');
console.log('OK — new instance (simulated restart) reconstructs the same state purely from disk.');

console.log('\n─── phase 3: force a snapshot rotation ───');
console.log(`(threshold is ${SNAPSHOT_EVERY}; we are at 4 actions since start — the 5th triggers rotation)`);
apply(journal2, { type: ACTIONS.SCORE, payload: { team: 'A', points: 1, playerId: 'p1' } }); // action #5 -> rotation

const journalLinesAfterRotation = fs.readFileSync(`${TEST_DIR}/journal.ndjson`, 'utf8').trim();
const snapshotExists = fs.existsSync(`${TEST_DIR}/snapshot.json`);
console.log('snapshot.json written:', snapshotExists);
console.log('journal.ndjson content after rotation:', JSON.stringify(journalLinesAfterRotation), '(should be empty — rotated)');
assert.equal(snapshotExists, true, 'rotation should have written a snapshot');
assert.equal(journalLinesAfterRotation, '', 'journal should be truncated after rotation');

// A couple more actions AFTER the rotation, so replay must combine the new
// snapshot with journal entries recorded after it, not just the snapshot alone.
apply(journal2, { type: ACTIONS.FOUL, payload: { team: 'A', playerId: 'p1' } });
apply(journal2, { type: ACTIONS.TIMEOUT, payload: { team: 'B' } });

const reconstructed3 = journal2.reconstructState();
assert.deepEqual(reconstructed3, expected, 'reconstructState() should combine the post-rotation snapshot with the actions recorded after it');
console.log('OK — reconstructState() correct after rotation + 2 more actions (same process).');

console.log('\n─── phase 4: second simulated crash, AFTER rotation ───');
const journal3 = createJournal({ dir: TEST_DIR, snapshotEveryNActions: SNAPSHOT_EVERY });
const reconstructed4 = journal3.reconstructState();
assert.deepEqual(reconstructed4, expected, 'reconstruction after a post-rotation restart must not depend on the truncated pre-rotation journal entries');
console.log('OK — fresh instance after rotation still reconstructs correctly (not relying on truncated pre-rotation entries).');
console.log('final teamA fouls:', reconstructed4.teamA.fouls, '| teamB timeouts:', reconstructed4.teamB.timeouts);

console.log('\n─── phase 5: clear() ───');
journal3.clear();
console.log('journal.ndjson exists after clear():', fs.existsSync(`${TEST_DIR}/journal.ndjson`));
console.log('snapshot.json exists after clear(): ', fs.existsSync(`${TEST_DIR}/snapshot.json`));
assert.equal(fs.existsSync(`${TEST_DIR}/snapshot.json`), false);
// journal.ndjson is recreated empty immediately by clear() so recordAction
// keeps working post-clear — confirm it's empty, not confirm it's absent.
assert.equal(fs.readFileSync(`${TEST_DIR}/journal.ndjson`, 'utf8'), '');
console.log('OK — snapshot.json removed; journal.ndjson reset to empty (ready for a fresh game).');

console.log('\nALL CHECKS PASSED');
