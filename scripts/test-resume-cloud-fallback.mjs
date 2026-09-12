// box-pi/scripts/test-resume-cloud-fallback.mjs
// Verifies Part B's fallback path against the REAL live Supabase project:
// local journal is empty (wiped/never existed), a `games` row exists for
// the code (inserted directly via SQL for this test, mimicking a game the
// daemon itself would have written), and resumeGameState() falls back to
// it correctly. Uses the public anon key — games SELECT is a public RLS
// policy, no service-role write access needed for this read-only path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createJournal } from '../daemon/journal.js';
import { resumeGameState } from '../daemon/resume.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../daemon/.env') });

const GAME_CODE = 'BXPI'; // inserted directly via SQL before this script ran — see conversation
const TEST_DIR = './data-test-resume-cloud';

fs.rmSync(TEST_DIR, { recursive: true, force: true }); // "local journal was lost" — nothing here at all
const journal = createJournal({ dir: TEST_DIR });

const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
});

console.log(`─── local journal for ${GAME_CODE} is empty; games row exists in the cloud — resumeGameState() ───`);
const result = await resumeGameState({ journal, supabaseClient, gameCode: GAME_CODE });

assert.equal(result.source, 'cloud-fallback');
assert.equal(result.state.teamA.score, 11);
assert.equal(result.state.teamB.score, 9);
assert.equal(result.state.teamA.fouls, 2);
assert.equal(result.state.teamB.fouls, 3);
assert.equal(result.state.clock.period, 2);
assert.equal(result.state.possession, 'B');
assert.equal(result.state.clock.isRunning, false, 'always resumes paused regardless of what gameRunning said in the cloud row');
assert.equal(result.state.meta.gameMode, 'stats');
assert.equal(result.state.teamA.players.length, 0, 'roster is NOT recoverable from games.data alone — a real, documented limitation of this fallback path');

console.log('resume source:', result.source);
console.log(`resumed: ${result.state.teamA.name} ${result.state.teamA.score} (${result.state.teamA.fouls}F, ${result.state.teamA.timeouts}TO) - ` +
            `${result.state.teamB.score} (${result.state.teamB.fouls}F, ${result.state.teamB.timeouts}TO) ${result.state.teamB.name}, ` +
            `P${result.state.clock.period}, possession ${result.state.possession}, clock ${result.state.clock.gameMs}ms remaining, isRunning=${result.state.clock.isRunning}`);
console.log('OK — matches the live games row exactly (coarse: roster empty, as expected for this path).');

fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('\nALL CHECKS PASSED');
