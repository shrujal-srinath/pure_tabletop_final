// box-pi/scripts/test-daemon-boot-resume.mjs
// Verifies daemon/index.js's boot sequence against all three resume paths,
// through the REAL running daemon (not just resume.js in isolation, which
// Task 5 already covered) — local journal present, local wiped with a
// cloud fallback row present, and neither.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { startDaemon } from './daemon-test-harness.mjs';
import { createJournal } from '../daemon/journal.js';
import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Scenario A: local journal present with an active game ───────────────
console.log('─── scenario A: local journal has an active game ───');
const dirA = path.join(ROOT, 'data-test-boot-resume-a');
fs.rmSync(dirA, { recursive: true, force: true });
{
    const journal = createJournal({ dir: dirA });
    let state = createEmptyState();
    function apply(action) { state = reduce(state, action); journal.recordAction(action, state); }
    apply({ type: ACTIONS.SETUP_GAME, payload: {
        teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
    } });
    apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 3 } });
    fs.writeFileSync(path.join(dirA, 'current-game-code.txt'), 'ATST');
}
const daemonA = await startDaemon({ dataDir: dirA });
try {
    const log = daemonA.getOutput();
    console.log('boot log:', log.split('\n').find((l) => l.includes('boot resume source')));
    assert.match(log, /boot resume source: local-journal/);
    // Confirm the resumed state actually reflects the pre-crash game, not
    // just the log line — connect fresh and read the connection-time state_update.
    const initial = await new Promise((resolve) => {
        const s = ioClient('http://localhost:3001', { transports: ['websocket'] });
        s.once('state_update', (state) => { resolve(state); s.close(); });
    });
    console.log('resumed teamA score:', initial.teamA.score, '(expect 3)');
    assert.equal(initial.teamA.score, 3);
    console.log('OK — scenario A resumed the real live score from the local journal.\n');
} finally {
    await daemonA.stop();
    fs.rmSync(dirA, { recursive: true, force: true });
}

// ── Scenario C first (no live DB needed) — neither journal nor cloud row ──
console.log('─── scenario C: neither local journal nor cloud row ───');
const dirC = path.join(ROOT, 'data-test-boot-resume-c');
fs.rmSync(dirC, { recursive: true, force: true });
const daemonC = await startDaemon({ dataDir: dirC });
try {
    const log = daemonC.getOutput();
    console.log('boot log:', log.split('\n').find((l) => l.includes('boot resume source')));
    assert.match(log, /boot resume source: fresh-start/);
    console.log('OK — scenario C started fresh, as expected.\n');
} finally {
    await daemonC.stop();
    fs.rmSync(dirC, { recursive: true, force: true });
}

// ── Scenario B: local journal wiped, cloud games row present ────────────
console.log('─── scenario B: local journal wiped, real cloud games row present ───');
const GAME_CODE = 'BXP2';
// Row inserted directly via SQL (bypassing RLS, exactly like Task 5's test) —
// done outside this script; see conversation for the insert/cleanup.
console.log(`(assumes a live 'games' row for code ${GAME_CODE} was inserted via SQL before this script ran)`);

const dirB = path.join(ROOT, 'data-test-boot-resume-b');
fs.rmSync(dirB, { recursive: true, force: true });
fs.mkdirSync(dirB, { recursive: true });
fs.writeFileSync(path.join(dirB, 'current-game-code.txt'), GAME_CODE); // journal itself absent — "wiped"

const daemonB = await startDaemon({ dataDir: dirB });
try {
    const log = daemonB.getOutput();
    console.log('boot log:', log.split('\n').find((l) => l.includes('boot resume source')));
    assert.match(log, /boot resume source: cloud-fallback/);
    const initial = await new Promise((resolve) => {
        const s = ioClient('http://localhost:3001', { transports: ['websocket'] });
        s.once('state_update', (state) => { resolve(state); s.close(); });
    });
    console.log('resumed (coarse) teamA score:', initial.teamA.score);
    console.log('OK — scenario B fell back to the cloud row when the local journal was gone.\n');
} finally {
    await daemonB.stop();
    fs.rmSync(dirB, { recursive: true, force: true });
}

console.log('ALL THREE RESUME SCENARIOS PASSED');
