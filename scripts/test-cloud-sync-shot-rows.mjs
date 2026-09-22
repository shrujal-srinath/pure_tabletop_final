// box-pi/scripts/test-cloud-sync-shot-rows.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Verifies the SHAPE of the shot_events rows this daemon writes — the part
// the rest of the ecosystem actually reads. No network; a mock Supabase
// client captures the rows.
//
// The case that matters most here is the free throw. 'unlocated' and
// 'free_throw' are NOT interchangeable: 'unlocated' means "a field goal whose
// location we failed to capture" (a data-quality hole worth reporting), while
// 'free_throw' means "this shot has no court location and never could have"
// (correct and complete). The website distinguishes them — every spatial
// consumer filters free throws out before touching x/y/zone, and migration 013
// back-filled the historical rows the web console had been faking as
// zone 'mid_top' at the FT-line point. box-pi wrote FTs as 'unlocated' until
// this was fixed, which would have shown up downstream as a game full of
// "missing location" warnings for shots that never had one.
//
// Run: node scripts/test-cloud-sync-shot-rows.mjs
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import { createCloudSync } from '../daemon/cloud-sync.js';
import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';
import { resolveTap } from '../shared/court-geometry.js';

const shotEventsTable = [];
const mockChannel = { send: () => {}, subscribe: (cb) => { cb?.('SUBSCRIBED'); return mockChannel; } };

const mockSupabaseClient = {
    channel: () => mockChannel,
    removeChannel: () => {},
    from: (table) => {
        if (table !== 'shot_events') {
            return { insert: () => Promise.resolve({ error: null }), update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        }
        return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
            insert: (row) => {
                shotEventsTable.push(row);
                return Promise.resolve({ error: null });
            },
        };
    },
};

const cloudSync = createCloudSync({ supabaseClient: mockSupabaseClient, gameCode: 'TEST', retryIntervalMs: 200 });
cloudSync.connect();

let state = createEmptyState();
function apply(action) {
    state = reduce(state, action);
    cloudSync.onStateChange(state, action);
}

apply({ type: ACTIONS.SETUP_GAME, payload: {
    teamAName: 'BMSCE', teamAColor: '#EF2B2D', teamBName: 'RVCE', teamBColor: '#4C86FF',
    periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'advanced',
    roster: { teamA: [{ id: 'p1', name: 'M. Carter', number: '4' }], teamB: [] },
} });

const settle = () => new Promise((r) => setTimeout(r, 20));

// ── 1. Free throw ──────────────────────────────────────────────────────────
console.log('─── a +1 free throw ───');
apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 1, playerId: 'p1' } });
await settle();

const ft = shotEventsTable.at(-1);
console.log('row:', JSON.stringify({ zone: ft.zone, x: ft.x, y: ft.y, shot_type: ft.shot_type, points: ft.points }));
assert.equal(ft.shot_type, 'free_throw', 'a 1-point shot is a free throw');
assert.equal(ft.zone, 'free_throw', "free throws must persist zone 'free_throw', never 'unlocated'");
assert.equal(ft.x, null, 'a free throw has no x');
assert.equal(ft.y, null, 'a free throw has no y');
console.log("OK — zone 'free_throw' with NULL coords, matching migration 013.\n");

// ── 2. A free throw cannot be given a location even if a caller passes one ──
console.log('─── a +1 that a caller wrongly hands a court location ───');
apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 1, playerId: 'p1', x: 50, y: 38.67, zone: 'mid_top' } });
await settle();

const ftForced = shotEventsTable.at(-1);
console.log('row:', JSON.stringify({ zone: ftForced.zone, x: ftForced.x, y: ftForced.y }));
assert.equal(ftForced.zone, 'free_throw', 'normalization happens in the writer, so no call site can reintroduce a located FT');
assert.equal(ftForced.x, null);
assert.equal(ftForced.y, null);
console.log('OK — the exact fake-location shape migration 013 had to clean up is now impossible to write.\n');

// ── 3. A located field goal passes its coordinates straight through ────────
console.log('─── a +3 from the top of the key, located via resolveTap ───');
const tap = resolveTap({ lx: 56, ly: 50, points: 3 });
assert.equal(tap.ok, true, 'sanity: this tap should be a valid 3');
apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 3, playerId: 'p1', x: tap.x, y: tap.y, zone: tap.zone } });
await settle();

const fg = shotEventsTable.at(-1);
console.log('row:', JSON.stringify({ zone: fg.zone, x: fg.x, y: fg.y, shot_type: fg.shot_type, points: fg.points }));
assert.equal(fg.shot_type, 'field_goal');
assert.equal(fg.zone, 'three_top_center');
assert.equal(fg.x, tap.x, 'portrait x is persisted verbatim — no rounding, no snapping');
assert.equal(fg.y, tap.y, 'portrait y is persisted verbatim');
assert.equal(fg.points, 3);
console.log('OK — located field goals persist exactly the coordinates the engine resolved.\n');

// ── 4. An unattributed field goal is 'unlocated', not 'free_throw' ─────────
console.log('─── a +2 whose location was never captured ───');
apply({ type: ACTIONS.SCORE, payload: { team: 'B', points: 2, playerId: 'p1' } });
await settle();

const un = shotEventsTable.at(-1);
console.log('row:', JSON.stringify({ zone: un.zone, x: un.x, y: un.y, shot_type: un.shot_type }));
assert.equal(un.shot_type, 'field_goal');
assert.equal(un.zone, 'unlocated', "a field goal with no captured location is 'unlocated' — a real data hole, distinct from a free throw");
assert.equal(un.x, null);
console.log("OK — 'unlocated' still means what it means; only free throws were reclassified.\n");

// ── 5. A miss: no score change, a row with made:false ─────────────────────
console.log('─── a MISS, located beyond the arc ───');
const scoreBefore = { A: state.teamA.score, B: state.teamB.score };
apply({ type: ACTIONS.SHOT_MISS, payload: { team: 'A' } });
assert.equal(state.teamA.score, scoreBefore.A, 'a miss must not change the score');
assert.equal(state.pendingAttribution.made, false, 'a miss opens an attribution prompt flagged as a miss');
assert.equal(state.pendingAttribution.points, null, 'a miss has no points until its location is known');

const missTap = resolveTap({ lx: 56, ly: 50 }); // no `points` — the location decides
apply({ type: ACTIONS.ATTRIBUTE_SHOT, payload: {
    playerId: 'p1', x: missTap.x, y: missTap.y, zone: missTap.zone, points: missTap.impliedPoints,
} });
await settle();

const miss = shotEventsTable.at(-1);
console.log('row:', JSON.stringify({ zone: miss.zone, made: miss.made, points: miss.points, x: miss.x, y: miss.y }));
assert.equal(miss.made, false, 'the row must record that the shot missed');
assert.equal(miss.points, 3, 'a miss beyond the arc is a 3-point ATTEMPT, resolved from its location');
assert.equal(miss.zone, 'three_top_center');
assert.equal(state.teamA.score, scoreBefore.A, 'and the score is still untouched after the attribution');
console.log('OK — made:false with the attempt value derived from where the shot was taken.\n');

console.log('─── a MISS inside the arc is a 2-point attempt ───');
apply({ type: ACTIONS.SHOT_MISS, payload: { team: 'B' } });
const missTap2 = resolveTap({ lx: 40, ly: 50 });
apply({ type: ACTIONS.ATTRIBUTE_SHOT, payload: {
    playerId: 'p1', x: missTap2.x, y: missTap2.y, zone: missTap2.zone, points: missTap2.impliedPoints,
} });
await settle();

const miss2 = shotEventsTable.at(-1);
console.log('row:', JSON.stringify({ zone: miss2.zone, made: miss2.made, points: miss2.points }));
assert.equal(miss2.made, false);
assert.equal(miss2.points, 2, 'the same flow yields a 2 when the tap is inside the arc');
console.log('OK — the attempt value follows the location, with no second button.\n');

console.log('─── makes still record made:true ───');
apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 2, playerId: 'p1', zone: 'at_rim', x: 50, y: 10.5 } });
await settle();
const make = shotEventsTable.at(-1);
assert.equal(make.made, true, 'a SCORE is still a make — the miss work must not have flipped the default');
console.log('OK — made:true preserved for scores.\n');

console.log('─── quick mode records no misses at all ───');
let qs = createEmptyState();
qs = reduce(qs, { type: ACTIONS.SETUP_GAME, payload: {
    teamAName: 'A', teamAColor: '#fff', teamBName: 'B', teamBColor: '#000',
    periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
} });
const qsAfter = reduce(qs, { type: ACTIONS.SHOT_MISS, payload: { team: 'A' } });
assert.ok(qsAfter.lastError, 'quick mode rejects a miss rather than silently dropping it');
assert.equal(qsAfter.pendingAttribution, null, 'and opens no prompt');
console.log(`OK — rejected with: "${qsAfter.lastError}"\n`);

console.log('ALL CHECKS PASSED');
process.exit(0);
