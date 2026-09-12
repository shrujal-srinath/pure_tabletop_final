// box-pi/scripts/test-daemon-dispatch-parity.mjs
// Proves ONE dispatch path: a score triggered by simulated Pico input
// (devMode stdin) and the identical score triggered by a raw Socket.io
// ui_action produce byte-identical resulting team state. (Not tested with
// FOUL as the task literally suggested — the real Pico firmware has no
// foul button at all, confirmed in Task 3; SCORE is the action type that
// genuinely exists on both the Pico and UI sides, so it's the real proof
// of "one path" rather than a hypothetical one.)

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, nextStateUpdate, sleep } from './daemon-test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data-test-dispatch-parity');

const SETUP_PAYLOAD = {
    teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
    periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
};

const daemon = await startDaemon({ dataDir: DATA_DIR });
try {
    console.log('─── path A: SCORE via simulated Pico input (devMode stdin) ───');
    await nextStateUpdate(daemon.socket, () => daemon.socket.emit('setup_game', SETUP_PAYLOAD));
    const afterPicoScore = await nextStateUpdate(daemon.socket, () => daemon.sendPico('SCORE_A2'));
    console.log('teamA after SCORE_A2 via Pico:', JSON.stringify(afterPicoScore.teamA));

    console.log('\n─── path B: the identical score via a raw Socket.io ui_action ───');
    await nextStateUpdate(daemon.socket, () => daemon.socket.emit('setup_game', SETUP_PAYLOAD)); // fresh state
    daemon.socket.emit('ui_action', { type: 'UNLOCK_TOUCH' });
    await sleep(100);
    const afterUiScore = await nextStateUpdate(daemon.socket, () =>
        daemon.socket.emit('ui_action', { type: 'SCORE', payload: { team: 'A', points: 2 } })
    );
    console.log('teamA after equivalent ui_action SCORE:', JSON.stringify(afterUiScore.teamA));

    assert.deepEqual(afterUiScore.teamA, afterPicoScore.teamA, 'both paths must produce byte-identical resulting team state');
    console.log('\nOK — Pico-originated and UI-originated SCORE actions produce identical resulting state. One dispatch path, confirmed.');
} finally {
    await daemon.stop();
}
