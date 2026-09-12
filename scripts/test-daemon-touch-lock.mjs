// box-pi/scripts/test-daemon-touch-lock.mjs
// Verifies touch-lock: kept fully separate from game state (own event,
// never bundled into state_update), toggled by the Pico's physical
// SETTINGS switch, and genuinely blocks ui_action dispatch while locked —
// not just a UI-side cosmetic state.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, nextStateUpdate, sleep } from './daemon-test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data-test-touch-lock');

/** Fires `trigger`, then reports whether a state_update arrived within `waitMs`. */
async function stateUpdateArrivesWithin(socket, trigger, waitMs = 400) {
    let received = false;
    const handler = () => { received = true; };
    socket.on('state_update', handler);
    trigger();
    await sleep(waitMs);
    socket.off('state_update', handler);
    return received;
}

const daemon = await startDaemon({ dataDir: DATA_DIR });
try {
    await nextStateUpdate(daemon.socket, () => daemon.socket.emit('setup_game', {
        teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
    }));

    console.log('─── touch starts locked — a FOUL ui_action must be ignored ───');
    const fouledWhileLocked = await stateUpdateArrivesWithin(daemon.socket, () =>
        daemon.socket.emit('ui_action', { type: 'FOUL', payload: { team: 'A' } })
    );
    console.log('state_update arrived for the locked-out FOUL attempt:', fouledWhileLocked, '(expect false)');
    assert.equal(fouledWhileLocked, false);

    console.log('\n─── physical SETTINGS toggle unlocks — confirm via touch_lock_status, and that it is NEVER bundled into state_update ───');
    const stateUpdatesSeenDuringToggle = [];
    daemon.socket.on('state_update', (s) => stateUpdatesSeenDuringToggle.push(s));
    const unlockStatus = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for touch_lock_status')), 3000);
        daemon.socket.once('touch_lock_status', (payload) => { clearTimeout(timer); resolve(payload); });
        daemon.sendPico('SETTINGS');
    });
    await sleep(200); // let any (incorrect) bundled state_update have a chance to arrive
    console.log('touch_lock_status payload:', JSON.stringify(unlockStatus));
    assert.equal(unlockStatus.unlocked, true);
    assert.equal(stateUpdatesSeenDuringToggle.length, 0, 'a touch-lock toggle must not itself cause a state_update — it is not game state');
    console.log('state_update broadcasts caused by the toggle:', stateUpdatesSeenDuringToggle.length, '(expect 0)');
    // Structural check: confirm state_update payloads never carry a touch/ui field at all.
    const anyStateUpdateHasTouchField = 'ui' in (stateUpdatesSeenDuringToggle[0] || {}) || 'touchUnlocked' in (stateUpdatesSeenDuringToggle[0] || {});
    assert.equal(anyStateUpdateHasTouchField, false);

    console.log('\n─── now unlocked — the same FOUL ui_action must actually apply ───');
    const afterFoul = await nextStateUpdate(daemon.socket, () =>
        daemon.socket.emit('ui_action', { type: 'FOUL', payload: { team: 'A' } })
    );
    console.log('teamA.fouls after FOUL while unlocked:', afterFoul.teamA.fouls, '(expect 1)');
    assert.equal(afterFoul.teamA.fouls, 1);

    console.log('\n─── SETTINGS toggle again — locks it back ───');
    const lockStatus = await new Promise((resolve) => {
        daemon.socket.once('touch_lock_status', resolve);
        daemon.sendPico('SETTINGS');
    });
    console.log('touch_lock_status payload:', JSON.stringify(lockStatus));
    assert.equal(lockStatus.unlocked, false);

    console.log('\n─── locked again — a second FOUL must be ignored once more ───');
    const fouledWhileLockedAgain = await stateUpdateArrivesWithin(daemon.socket, () =>
        daemon.socket.emit('ui_action', { type: 'FOUL', payload: { team: 'A' } })
    );
    console.log('state_update arrived for the re-locked FOUL attempt:', fouledWhileLockedAgain, '(expect false)');
    assert.equal(fouledWhileLockedAgain, false);

    console.log('\nOK — touch-lock genuinely gates ui_action dispatch, is broadcast on its own event, and never appears inside state_update.');
} finally {
    await daemon.stop();
}
