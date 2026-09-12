// box-pi/scripts/test-daemon-clock-toggle.mjs
// Verifies CLOCK_TOGGLE resolution: the Pico's one physical clock button
// means CLOCK_START when the clock is stopped and CLOCK_STOP when it's
// running, resolved by daemon/index.js reading currentState.clock.isRunning
// immediately before dispatching — never as a concept the Pico or the
// reducer know about. Confirmed via real state_update broadcasts, not logs.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, nextStateUpdate, waitForState } from './daemon-test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data-test-clock-toggle');

const daemon = await startDaemon({ dataDir: DATA_DIR });
try {
    const afterSetup = await nextStateUpdate(daemon.socket, () => daemon.socket.emit('setup_game', {
        teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
    }));
    console.log('clock.isRunning right after setup:', afterSetup.clock.isRunning, '(expect false)');
    assert.equal(afterSetup.clock.isRunning, false);

    console.log('\n─── CLOCK_TOGGLE #1 (clock currently stopped) ───');
    // Once running, CLOCK_TICK broadcasts arrive independently every ~100ms —
    // waitForState ignores those and only resolves on the transition we
    // actually asked for, rather than assuming "the next broadcast" is ours.
    const afterToggle1 = await waitForState(daemon.socket, () => daemon.sendPico('CLOCK_TOGGLE'), (s) => s.clock.isRunning === true);
    console.log('clock.isRunning:', afterToggle1.clock.isRunning, '(expect true — toggle resolved to CLOCK_START)');
    assert.equal(afterToggle1.clock.isRunning, true);

    console.log('\n─── CLOCK_TOGGLE #2 (clock currently running, ticks are actively flowing) ───');
    const afterToggle2 = await waitForState(daemon.socket, () => daemon.sendPico('CLOCK_TOGGLE'), (s) => s.clock.isRunning === false);
    console.log('clock.isRunning:', afterToggle2.clock.isRunning, '(expect false — toggle resolved to CLOCK_STOP)');
    assert.equal(afterToggle2.clock.isRunning, false);

    console.log('\nOK — one physical button correctly alternates START/STOP based on current state, resolved entirely in the orchestrator.');
} finally {
    await daemon.stop();
}
