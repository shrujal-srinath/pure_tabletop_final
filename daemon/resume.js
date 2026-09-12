// box-pi/daemon/resume.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Boot Resume (Task 5, Part B)
//
// On daemon startup, before accepting any Pico input: figure out whether a
// game was already in progress and rebuild its state, using BOTH sources
// of truth together —
//   1. The local journal (daemon/journal.js) — fast, and definitely
//      current up to the last local write. Primary source.
//   2. The cloud `games` row — fallback of last resort, for when the local
//      journal itself was lost (SD card corruption, fresh card, wiped
//      data/ dir). Coarser: only the last persisted snapshot, no action
//      replay, no roster (games.data doesn't carry player lists — see
//      wire-contract.js's GamesDataRow).
//   3. Neither — start fresh and wait for a new setup_game.
// Whichever path is taken is logged clearly, since that matters while
// testing crash recovery and matters to a ref wondering why the roster
// disappeared after a hard crash.
// ═══════════════════════════════════════════════════════════════════════

import { createEmptyState } from '../shared/state-engine.js';
import { fetchGameRow } from './cloud-sync.js';

/**
 * Rebuilds a coarse state-engine State from a `games` row's `data` JSONB.
 * Last-known-snapshot only — no action replay is possible from the cloud
 * row alone, and roster/personal-foul detail isn't in games.data at all.
 * @param {{code:string, status:string, data:Object}} row
 * @returns {Object}
 */
export function cloudRowToState(row) {
    const empty = createEmptyState();
    const d = row.data;

    return {
        ...empty,
        teamA: { ...empty.teamA, name: d.teamA.name, color: d.teamA.color, score: d.teamA.score, fouls: d.teamA.fouls, timeouts: d.teamA.timeouts },
        teamB: { ...empty.teamB, name: d.teamB.name, color: d.teamB.color, score: d.teamB.score, fouls: d.teamB.fouls, timeouts: d.teamB.timeouts },
        clock: {
            gameMs: (d.gameState.gameTime.minutes * 60 + d.gameState.gameTime.seconds) * 1000,
            shotMs: d.gameState.shotClock * 1000,
            // Always resume paused — an operator should restart the clock
            // deliberately after a crash, not have it silently keep running.
            isRunning: false,
            shotClockRunning: false,
            period: d.gameState.period,
            totalPeriods: d.settings.periods,
            periodMs: d.settings.periodDuration * 60 * 1000,
            shotClockMs: d.settings.shotClockDuration * 1000,
        },
        possession: d.gameState.possession,
        meta: { gameCode: row.code, gameActive: row.status === 'live', gameMode: d.settings.gameMode },
    };
}

/**
 * @param {Object} opts
 * @param {ReturnType<import('./journal.js').createJournal>} opts.journal
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient
 * @param {string|null} opts.gameCode The code to check in the cloud fallback — null if none is known yet (e.g. truly first boot).
 * @returns {Promise<{state: Object, source: 'local-journal'|'cloud-fallback'|'fresh-start'}>}
 */
export async function resumeGameState({ journal, supabaseClient, gameCode }) {
    const local = journal.reconstructState();
    if (local.meta.gameActive) {
        console.log(`[resume] resumed from local journal — game ${local.meta.gameCode ?? gameCode}, score ${local.teamA.score}-${local.teamB.score}, period ${local.clock.period}`);
        return { state: local, source: 'local-journal' };
    }

    if (gameCode) {
        const row = await fetchGameRow(supabaseClient, gameCode);
        if (row && row.status === 'live') {
            const state = cloudRowToState(row);
            console.log(
                `[resume] resumed from cloud fallback — game ${gameCode}, score ${state.teamA.score}-${state.teamB.score}, period ${state.clock.period} ` +
                `(coarse: last snapshot only, no action replay, roster not recoverable this way)`
            );
            return { state, source: 'cloud-fallback' };
        }
    }

    console.log('[resume] no active game found locally or in the cloud — starting fresh');
    return { state: createEmptyState(), source: 'fresh-start' };
}
