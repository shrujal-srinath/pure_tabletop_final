// box-pi/scripts/test-resume-local.mjs
// Verifies Part B's primary path: resumeGameState() finds an active game in
// the local journal and resumes from it — no network involved (the
// local-journal branch returns before ever touching supabaseClient).

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createJournal } from '../daemon/journal.js';
import { resumeGameState } from '../daemon/resume.js';
import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';

const TEST_DIR = './data-test-resume-local';
fs.rmSync(TEST_DIR, { recursive: true, force: true });

console.log('─── simulate a live game being scored, then a crash ───');
let journalA = createJournal({ dir: TEST_DIR });
let expected = createEmptyState();
function apply(journal, action) {
    expected = reduce(expected, action);
    journal.recordAction(action, expected);
}

apply(journalA, { type: ACTIONS.SETUP_GAME, payload: {
    teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
    periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'stats',
    roster: { teamA: [{ id: 'p1', name: 'Arjun', number: '7' }], teamB: [] },
} });
apply(journalA, { type: ACTIONS.SCORE, payload: { team: 'A', points: 2, playerId: 'p1' } });
apply(journalA, { type: ACTIONS.FOUL, payload: { team: 'B' } });
console.log(`live state before crash: ${expected.teamA.name} ${expected.teamA.score} - ${expected.teamB.score} ${expected.teamB.name}, gameActive=${expected.meta.gameActive}`);

console.log('\n─── simulated crash + restart: fresh createJournal() on the same dir, resumeGameState() ───');
const journalB = createJournal({ dir: TEST_DIR });
// supabaseClient is intentionally undefined — the local-journal path must
// never touch it. If this throws, that guarantee is broken.
const result = await resumeGameState({ journal: journalB, supabaseClient: undefined, gameCode: null });

assert.equal(result.source, 'local-journal');
assert.deepEqual(result.state, expected);
console.log(`resume source: ${result.source}`);
console.log(`resumed state: ${result.state.teamA.name} ${result.state.teamA.score} - ${result.state.teamB.score} ${result.state.teamB.name}, gameActive=${result.state.meta.gameActive}`);
console.log('OK — matches the live state exactly, and never touched supabaseClient.');

console.log('\n─── fresh-start path: no journal, no cloud row ───');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
const journalC = createJournal({ dir: TEST_DIR });
const freshResult = await resumeGameState({ journal: journalC, supabaseClient: undefined, gameCode: null });
assert.equal(freshResult.source, 'fresh-start');
console.log(`resume source: ${freshResult.source} — gameActive=${freshResult.state.meta.gameActive}`);

fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('\nALL CHECKS PASSED');
