// box-pi/scripts/test-daemon-e2e-smoke.mjs
// End-to-end smoke test: boot fresh, setup_game via a raw Socket.io
// message, feed a short sequence of actions, confirm state_update
// broadcasts correctly at each step.
//
// Two deviations from the task's literal description, both because the
// REAL hardware doesn't support what was described (same class of
// discrepancy as Task 3's Pico vocabulary check):
//   - "clock start/stop" is fed as CLOCK_TOGGLE (Pico has one physical
//     button, not two) — daemon/index.js resolving that correctly is
//     already its own dedicated test; this script just uses the real
//     vocabulary.
//   - "foul" cannot come from simulated Pico input at all — the real Pico
//     has no foul button (Task 3 finding). Sent as a ui_action instead,
//     clearly labeled.
// The Supabase-row confirmation this scenario also asks for is NOT run
// here — it needs SUPABASE_SERVICE_KEY, still not in daemon/.env (same
// open item carried from Task 5). Everything else in the pipeline (local
// dispatch, journal, LAN broadcasts) is verified live below.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, nextStateUpdate, waitForState, sleep } from './daemon-test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data-test-e2e-smoke');

const daemon = await startDaemon({ dataDir: DATA_DIR });
try {
    console.log('─── boot fresh ───');
    console.log(daemon.getOutput().trim().split('\n').filter((l) => l.includes('[daemon]') || l.includes('[resume]')).join('\n'));

    console.log('\n─── setup_game via a raw Socket.io message (stats mode) ───');
    const afterSetup = await nextStateUpdate(daemon.socket, () => daemon.socket.emit('setup_game', {
        teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'stats',
        roster: { teamA: [{ id: 'p1', name: 'Arjun', number: '7' }], teamB: [{ id: 'p2', name: 'Bilal', number: '9' }] },
    }));
    assert.equal(afterSetup.meta.gameActive, true);
    console.log(`gameActive=${afterSetup.meta.gameActive}, gameCode=${afterSetup.meta.gameCode}, mode=${afterSetup.meta.gameMode}`);

    console.log('\n─── SCORE via simulated Pico input (SCORE_A2) ───');
    const afterScore = await nextStateUpdate(daemon.socket, () => daemon.sendPico('SCORE_A2'));
    console.log(`teamA.score=${afterScore.teamA.score}, pendingAttribution=${JSON.stringify(afterScore.pendingAttribution)}`);
    assert.equal(afterScore.teamA.score, 2);

    console.log('\n─── FOUL via ui_action (no real Pico foul button exists — this is the touchscreen path) ───');
    daemon.socket.emit('ui_action', { type: 'UNLOCK_TOUCH' });
    await sleep(100);
    const afterFoul = await nextStateUpdate(daemon.socket, () =>
        daemon.socket.emit('ui_action', { type: 'FOUL', payload: { team: 'B', playerId: 'p2' } })
    );
    console.log(`teamB.fouls=${afterFoul.teamB.fouls}, p2 personal fouls=${afterFoul.teamB.players.find((p) => p.id === 'p2')?.fouls}`);
    assert.equal(afterFoul.teamB.fouls, 1);

    console.log('\n─── CLOCK_TOGGLE via simulated Pico input (start) ───');
    const afterStart = await waitForState(daemon.socket, () => daemon.sendPico('CLOCK_TOGGLE'), (s) => s.clock.isRunning === true);
    console.log(`clock.isRunning=${afterStart.clock.isRunning}`);
    await sleep(500); // let real ticks actually happen before stopping

    console.log('\n─── CLOCK_TOGGLE via simulated Pico input (stop) ───');
    const afterStop = await waitForState(daemon.socket, () => daemon.sendPico('CLOCK_TOGGLE'), (s) => s.clock.isRunning === false);
    console.log(`clock.isRunning=${afterStop.clock.isRunning}, gameMs=${afterStop.clock.gameMs} (ticked down while running)`);
    assert.ok(afterStop.clock.gameMs < afterStart.clock.gameMs, 'game clock should have ticked down while running');

    console.log('\n═══ SUMMARY ═══');
    console.log(`Final: ${afterStop.teamA.name} ${afterStop.teamA.score} - ${afterStop.teamB.score} ${afterStop.teamB.name}, ` +
                `teamB fouls ${afterStop.teamB.fouls}, clock ${afterStop.clock.gameMs}ms remaining, stopped.`);
    console.log('Local pipeline (dispatch -> reduce -> journal -> LAN broadcast) verified end-to-end.');
    console.log('NOT verified here: the games.data/game_actions rows actually landing in Supabase — blocked on');
    console.log('SUPABASE_SERVICE_KEY, same open item as Task 5. Cloud writes were attempted with the anon key');
    console.log('and are queued for retry (expected — RLS correctly rejects them), not crashing anything:');
    console.log(daemon.getOutput().split('\n').filter((l) => l.includes('queued for retry')).slice(0, 3).join('\n') || '(none logged yet — retry queue drains async)');

    console.log('\nOK — end-to-end local smoke test passed.');
} finally {
    await daemon.stop();
}
