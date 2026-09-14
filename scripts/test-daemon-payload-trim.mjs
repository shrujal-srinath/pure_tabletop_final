// box-pi/scripts/test-daemon-payload-trim.mjs
// Verifies the payload-bloat cleanup (flagged in Task 6b, closed as a
// backlog follow-up): every state_update broadcast must no longer carry
// state-engine.js's internal `_previousState` UNDO snapshot, while UNDO
// itself must still work correctly — proving the daemon's own internal
// currentState still has what reduce() needs, only the outgoing wire
// payload is trimmed.
//
// Real daemon, real Socket.io client — inspects the RAW received object
// (not a typed/normalized one) so "the key is genuinely absent from the
// wire" is what's actually being checked, not inferred.

import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startDaemon, nextStateUpdate, sleep } from './daemon-test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const dataDir = path.join(ROOT, 'data-test-payload-trim');
fs.rmSync(dataDir, { recursive: true, force: true });

const { socket, stop } = await startDaemon({ dataDir });
try {
    console.log('─── setup_game (quick mode) ───');
    const afterSetup = await nextStateUpdate(socket, () => {
        socket.emit('setup_game', {
            teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
            periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
        });
    });
    console.log('setup_game payload has _previousState key:', '_previousState' in afterSetup, '(expect false)');
    assert.equal('_previousState' in afterSetup, false);

    console.log('\n─── SCORE via ui_action ───');
    socket.emit('ui_action', { type: 'UNLOCK_TOUCH' }); // only emits touch_lock_status, not state_update
    await sleep(150);
    const afterScore2 = await nextStateUpdate(socket, () => {
        socket.emit('ui_action', { type: 'SCORE', payload: { team: 'A', points: 2 } });
    });
    console.log('teamA.score after SCORE:', afterScore2.teamA.score, '(expect 2)');
    assert.equal(afterScore2.teamA.score, 2);
    console.log('SCORE payload has _previousState key:', '_previousState' in afterScore2, '(expect false)');
    assert.equal('_previousState' in afterScore2, false);
    console.log('raw payload size (bytes):', Buffer.byteLength(JSON.stringify(afterScore2)));

    console.log('\n─── UNDO — must still correctly revert the SCORE ───');
    const afterUndo = await nextStateUpdate(socket, () => {
        socket.emit('ui_action', { type: 'UNDO' });
    });
    console.log('teamA.score after UNDO:', afterUndo.teamA.score, '(expect 0 — reverted)');
    assert.equal(afterUndo.teamA.score, 0);
    console.log('UNDO payload has _previousState key:', '_previousState' in afterUndo, '(expect false)');
    assert.equal('_previousState' in afterUndo, false);

    console.log('\nOK — state_update broadcasts never carry _previousState, and UNDO still correctly reverts using the daemon\'s own internal (untrimmed) state.');
} finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
}
