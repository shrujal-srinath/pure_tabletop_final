// box-pi/scripts/test-state-engine.mjs
// Throwaway verification script for shared/state-engine.js — no framework,
// just calling reduce() with fake actions and printing what comes back.
// Demonstrates: a rejected TIMEOUT, a player hitting fouledOut at 5 fouls,
// and UNDO reverting exactly one action.

import { reduce, ACTIONS, createEmptyState } from '../shared/state-engine.js';

function summarize(state) {
    const { _previousState, ...rest } = state;
    return { ...rest, _previousState: _previousState ? '<snapshot present>' : null };
}

function step(label, state, action) {
    const next = reduce(state, action);
    console.log(`\n─── ${label} ───`);
    console.log('action:', JSON.stringify(action));
    console.log('result:', JSON.stringify(summarize(next), null, 2));
    return next;
}

let state = createEmptyState();

state = step('SETUP_GAME', state, {
    type: ACTIONS.SETUP_GAME,
    payload: {
        teamAName: 'Rockets', teamAColor: '#EF4444',
        teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'stats',
        roster: { teamA: [{ id: 'p1', name: 'Arjun', number: '7' }], teamB: [] },
    },
});

state = step('SCORE (with playerId — no attribution needed)', state, {
    type: ACTIONS.SCORE, payload: { team: 'A', points: 2, playerId: 'p1' },
});

state = step('SCORE (no playerId — sets pendingAttribution)', state, {
    type: ACTIONS.SCORE, payload: { team: 'A', points: 3, ts: 1234567890 },
});

state = step('ATTRIBUTE_SHOT (resolves the pending prompt)', state, {
    type: ACTIONS.ATTRIBUTE_SHOT, payload: { playerId: 'p1' },
});

// Foul the same player 5 times to demonstrate fouledOut flipping at 5.
for (let i = 1; i <= 5; i++) {
    state = step(`FOUL #${i} on p1`, state, {
        type: ACTIONS.FOUL, payload: { team: 'A', playerId: 'p1' },
    });
}

state = step('TIMEOUT #1 (bracket allows 2 in H1)', state, {
    type: ACTIONS.TIMEOUT, payload: { team: 'A' },
});

state = step('TIMEOUT #2 (uses up the H1 allotment)', state, {
    type: ACTIONS.TIMEOUT, payload: { team: 'A' },
});

state = step('TIMEOUT #3 — REJECTED, none left in this bracket', state, {
    type: ACTIONS.TIMEOUT, payload: { team: 'A' },
});

state = step('CLOCK_START', state, { type: ACTIONS.CLOCK_START });

state = step('CLOCK_TICK (12s off the game + shot clock)', state, {
    type: ACTIONS.CLOCK_TICK, payload: { deltaMs: 12000 },
});

const beforeUndo = state;
state = step('UNDO (should revert only the CLOCK_TICK)', state, { type: ACTIONS.UNDO });

console.log('\n─── UNDO check ───');
console.log('gameMs before UNDO:', beforeUndo.clock.gameMs, '(after the 12s tick)');
console.log('gameMs after UNDO: ', state.clock.gameMs, '(back to pre-tick, clock still running)');

state = step('UNDO again — single-level, should no-op (no redo)', state, { type: ACTIONS.UNDO });
