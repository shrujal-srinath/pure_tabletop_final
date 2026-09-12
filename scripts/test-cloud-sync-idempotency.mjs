// box-pi/scripts/test-cloud-sync-idempotency.mjs
// Verifies the application-level guard added in daemon/cloud-sync.js for
// shot_events.client_event_id (no network — a mock Supabase client
// simulates the exact failure this guard exists for): the FIRST insert
// attempt for a shot actually lands server-side but returns an error to the
// caller (an "ambiguous network failure" — response lost, not the request).
// The retry queue retries the SAME write (same client_event_id). Without
// the guard this would insert a duplicate row; with it, the retry's
// check-before-insert finds the row already there and skips.

import assert from 'node:assert/strict';
import { createCloudSync } from '../daemon/cloud-sync.js';
import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';

const shotEventsTable = [];
const failedOnce = new Set();

const mockChannel = { send: () => {}, subscribe: (cb) => { cb?.('SUBSCRIBED'); return mockChannel; } };

const mockSupabaseClient = {
    channel: () => mockChannel,
    removeChannel: () => {},
    from: (table) => {
        if (table !== 'shot_events') {
            return { insert: () => Promise.resolve({ error: null }), update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        }
        return {
            select: () => ({
                eq: (_c1, gameCode) => ({
                    eq: (_c2, clientEventId) => ({
                        maybeSingle: () => {
                            const found = shotEventsTable.find((r) => r.game_code === gameCode && r.client_event_id === clientEventId);
                            return Promise.resolve({ data: found ? { id: 'fake-id' } : null, error: null });
                        },
                    }),
                }),
            }),
            insert: (row) => {
                // Simulate: the request actually lands (the row IS persisted)
                // but the response back to the caller is lost — exactly the
                // ambiguous failure this guard exists for. Only the FIRST
                // attempt for a given client_event_id behaves this way.
                const isRetry = failedOnce.has(row.client_event_id);
                shotEventsTable.push(row);
                if (!isRetry) {
                    failedOnce.add(row.client_event_id);
                    return Promise.resolve({ error: { message: 'simulated ambiguous network failure' } });
                }
                return Promise.resolve({ error: null });
            },
        };
    },
};

// Fast retry interval so the test doesn't wait the real 15s default.
const cloudSync = createCloudSync({ supabaseClient: mockSupabaseClient, gameCode: 'TEST', retryIntervalMs: 200 });
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

console.log('─── SCORE with playerId (stats mode) — first write attempt fails with an "ambiguous" error ───');
apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 2, playerId: 'p1' } });

await new Promise((r) => setTimeout(r, 20));
console.log('rows in shot_events immediately after the first (failed-response) attempt:', shotEventsTable.length, '(the row DID land — the response was what was "lost")');
assert.equal(shotEventsTable.length, 1);

console.log('\n─── waiting for the retry queue to retry the SAME write ───');
await new Promise((r) => setTimeout(r, 400)); // > retryIntervalMs

console.log('rows in shot_events after the retry ran:', shotEventsTable.length, '(guard should have skipped a duplicate insert)');
assert.equal(shotEventsTable.length, 1, 'the retry must NOT have created a second row for the same client_event_id');
console.log('OK — exactly one shot_events row exists despite two write attempts for the same logical event.');

console.log('\n─── a genuinely different score gets its OWN client_event_id — guard keys on (game_code, client_event_id), not globally ───');
apply({ type: ACTIONS.SCORE, payload: { team: 'B', points: 3, playerId: 'p1' } });
await new Promise((r) => setTimeout(r, 20));
console.log('rows in shot_events:', shotEventsTable.length, '(expect 2 — the new event lands on its own first attempt same as the first one did)');
assert.equal(shotEventsTable.length, 2);

console.log('\nALL CHECKS PASSED');
process.exit(0);
