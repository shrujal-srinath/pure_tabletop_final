// box-pi/scripts/test-cloud-sync-throttle.mjs
// Verifies (no network — a mock Supabase client): clock_tick broadcasts
// throttle to ~1/sec regardless of internal tick rate, a FOUL never triggers
// a spurious clock_tick, and only actually-changed score/foul/timeout data
// triggers score_update.

import { createCloudSync } from '../daemon/cloud-sync.js';
import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';

const broadcasts = []; // { event, payload }
const writes = []; // { table, op, row }

const mockChannel = {
    send: ({ event, payload }) => broadcasts.push({ event, payload }),
    subscribe: (cb) => { cb?.('SUBSCRIBED'); return mockChannel; },
};
const mockSupabaseClient = {
    channel: () => mockChannel,
    removeChannel: () => {},
    from: (table) => ({
        insert: (row) => { writes.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }); },
        update: (fields) => ({
            eq: (col, val) => { writes.push({ table, op: 'update', row: { [col]: val, ...fields } }); return Promise.resolve({ error: null }); },
        }),
    }),
};

const cloudSync = createCloudSync({ supabaseClient: mockSupabaseClient, gameCode: 'TEST' });
cloudSync.connect();

let state = createEmptyState();
function apply(action) {
    state = reduce(state, action);
    cloudSync.onStateChange(state, action);
}

apply({ type: ACTIONS.SETUP_GAME, payload: {
    teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
    periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'stats',
    roster: { teamA: [{ id: 'p1', name: 'Arjun', number: '7' }], teamB: [] },
} });
apply({ type: ACTIONS.CLOCK_START });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('─── feeding 30 CLOCK_TICK actions, one every ~100ms of REAL time (3 real seconds) ───');
// The throttle in cloud-sync.js gates on Date.now() — real elapsed wall-clock
// time — because that's what the real daemon/clock.js ticker actually drives
// it with. A tight synchronous loop wouldn't advance real time at all and
// would prove nothing; this awaits a real sleep per tick to match production.
for (let i = 0; i < 30; i++) {
    await sleep(100);
    apply({ type: ACTIONS.CLOCK_TICK, payload: { deltaMs: 100 } });
}

const clockTicksBroadcast = broadcasts.filter((b) => b.event === 'clock_tick');
console.log(`internal ticks fed: 30 | clock_tick broadcasts sent: ${clockTicksBroadcast.length}`);
console.log('(expect ~3, one per elapsed real second, not 30)');

console.log('\n─── a FOUL should broadcast score_update but NOT a spurious clock_tick ───');
const broadcastsBeforeFoul = broadcasts.length;
apply({ type: ACTIONS.FOUL, payload: { team: 'B' } });
const newBroadcasts = broadcasts.slice(broadcastsBeforeFoul);
console.log('broadcasts triggered by the FOUL:', JSON.stringify(newBroadcasts.map((b) => b.event)));

console.log('\n─── a second FOUL on the same team with no other change should NOT double-broadcast score_update ───');
// (foul count already changed once above; repeat the exact same action type
// to confirm each new foul still diffs correctly — it SHOULD broadcast again
// since fouls actually incremented again, this just proves diffing tracks
// the latest value, not "did this action type fire before".)
const beforeSecondFoul = broadcasts.length;
apply({ type: ACTIONS.FOUL, payload: { team: 'B' } });
console.log('broadcasts for 2nd real foul (should still be score_update, since fouls really did change again):', JSON.stringify(broadcasts.slice(beforeSecondFoul).map((b) => b.event)));

console.log('\n─── an action with truly no observable score/clock change should broadcast nothing new ───');
// ATTRIBUTE_SHOT with no pending attribution is a no-op reject in state-engine
// (lastError set, nothing else changes) — score_update must not re-fire.
const beforeNoop = broadcasts.length;
apply({ type: ACTIONS.ATTRIBUTE_SHOT, payload: { playerId: 'p1' } });
console.log('broadcasts for a rejected no-op action:', JSON.stringify(broadcasts.slice(beforeNoop).map((b) => b.event)), '(expect [] — nothing changed)');

console.log('\n─── all game_actions/games writes recorded by the mock client (structural — real network write path pending service key) ───');
for (const w of writes) {
    console.log(`${w.op.toUpperCase()} ${w.table}:`, JSON.stringify(w.row));
}
