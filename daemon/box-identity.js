// box-pi/daemon/box-identity.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Box Identity (online QR setup / remote game assignment)
//
// Ports the real, already-shipped `box_units` mechanism from the old
// website codebase's `src/services/boxUnitService.ts` verbatim (verified
// against that file directly, not reinvented) — this device already
// exists as a real live-Supabase table (`box_units`: box_code PK,
// game_code, status 'waiting'|'game_ready'|'live', last_seen epoch-ms
// heartbeat, created_at), consumed today by that other product. This
// module is the Pi-side half of the same contract:
//   1. Pi boots -> registerBoxUnit(boxCode) (insert if new, else read
//      existing state — mirrors the source exactly, including firing an
//      immediate heartbeat on the "existing row" path).
//   2. startBoxHeartbeat -> updates last_seen every 8000ms, matching the
//      source's setInterval(send, 8000) exactly (not a guessed interval).
//   3. Dual-subscribe, matching the source's real redundancy — never
//      trimmed to just one path:
//        - subscribeBoxSignal: broadcast channel `box-signal:{code}`,
//          event `game_assigned` — the ~50ms-latency fast path.
//        - subscribeBoxUnit: Postgres Changes on the box_units row
//          itself, channel `box_unit_{code}` — the backup path, in case
//          a broadcast is ever missed.
//   4. markBoxLive / resetBoxUnit — the source's own lifecycle bookends
//      (Pi marks itself 'live' once a game loads, resets to 'waiting'
//      once the game ends), ported the same way.
//
// What this module deliberately does NOT do: decide what happens when a
// game gets assigned. Both subscription paths just call the same
// `onGameAssigned(gameCode)` callback — daemon/index.js owns the actual
// policy (the active-game guardrail, the already-presented dedup, and
// the confirm-before-loading UX), same separation of concerns as
// uart-bridge.js only ever parsing bytes into actions, never deciding
// what they mean.
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

const HEARTBEAT_INTERVAL_MS = 8000; // matches the source's setInterval(send, 8000) exactly

// Same alphabet/length as the website's own generateGameCode() (see
// src/services/supabaseGameService.ts) — excludes visually-ambiguous
// characters (O/0, I/1, S/5). The old repo's box-code generator itself
// lives on the Pi hardware side, outside that repo, and wasn't found to
// copy verbatim — but boxUnitService.ts's own docblock example
// ("BX7K") is a 4-char uppercase-alphanumeric code from the same family,
// so this reuses the one real, verified generator in the codebase rather
// than inventing a new format that might not match what the website
// expects to parse/display.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
function generateBoxCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    return code;
}

/**
 * Part A — persisted box identity. Generated once, ever; every
 * subsequent boot just reads the file back. Same local-file pattern as
 * journal.js's own data files — losing this (SD card wipe) means the Pi
 * shows up as a "new" device next boot, which is an acceptable, rare
 * failure mode, not one this module tries to prevent.
 * @param {string} dataDir
 * @returns {string}
 */
export function getOrCreateBoxCode(dataDir) {
    const file = path.join(dataDir, 'box-code.txt');
    if (fs.existsSync(file)) {
        const code = fs.readFileSync(file, 'utf8').trim();
        if (code) return code;
    }
    const code = generateBoxCode();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, code);
    console.log(`[box-identity] generated new box code: ${code}`);
    return code;
}

/**
 * Mirrors registerBoxUnit's real logic exactly: insert if the row is
 * new, otherwise just read the existing state back (and fire one
 * heartbeat in the background on that path, same as the source).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {string} boxCode
 * @returns {Promise<{game_code: string|null, status: 'waiting'|'game_ready'|'live'}>}
 */
export async function registerBoxUnit(supabaseClient, boxCode) {
    const upper = boxCode.toUpperCase();

    const { data: existing, error: selectError } = await supabaseClient
        .from('box_units')
        .select('game_code, status')
        .eq('box_code', upper)
        .maybeSingle();

    if (selectError) {
        console.error('[box-identity] register: select failed:', selectError.message);
        return { game_code: null, status: 'waiting' };
    }

    if (existing) {
        supabaseClient
            .from('box_units')
            .update({ last_seen: Date.now() })
            .eq('box_code', upper)
            .then(({ error }) => { if (error) console.error('[box-identity] register: background heartbeat failed:', error.message); });
        return { game_code: existing.game_code, status: existing.status };
    }

    const { error: insertError } = await supabaseClient
        .from('box_units')
        .insert({ box_code: upper, status: 'waiting', game_code: null, last_seen: Date.now() });
    if (insertError) console.error('[box-identity] register: insert failed:', insertError.message);
    return { game_code: null, status: 'waiting' };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {string} boxCode
 * @returns {() => void} stop function
 */
export function startBoxHeartbeat(supabaseClient, boxCode) {
    const upper = boxCode.toUpperCase();
    const send = () => {
        supabaseClient
            .from('box_units')
            .update({ last_seen: Date.now() })
            .eq('box_code', upper)
            .then(({ error }) => { if (error) console.error('[box-identity] heartbeat failed:', error.message); });
    };
    send();
    const interval = setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
}

/**
 * Postgres Changes subscription on the box's own row — the BACKUP path.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {string} boxCode
 * @param {(gameCode: string) => void} onGameAssigned
 * @param {() => void} onReset
 * @returns {() => void} unsubscribe
 */
export function subscribeBoxUnit(supabaseClient, boxCode, onGameAssigned, onReset) {
    const upper = boxCode.toUpperCase();
    const channel = supabaseClient
        .channel(`box_unit_${upper}`)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'box_units', filter: `box_code=eq.${upper}` },
            (payload) => {
                if (payload.eventType === 'DELETE') return;
                const row = payload.new;
                if (row.game_code && row.status === 'game_ready') onGameAssigned(row.game_code);
                else if (!row.game_code) onReset();
            },
        )
        .subscribe((_status, err) => {
            if (err) console.error(`[box-identity] postgres_changes subscribe error for ${upper}:`, err);
        });
    return () => { supabaseClient.removeChannel(channel); };
}

/**
 * Broadcast subscription — the FAST (~50ms) path.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {string} boxCode
 * @param {(gameCode: string) => void} onGameAssigned
 * @param {() => void} onReset
 * @returns {() => void} unsubscribe
 */
export function subscribeBoxSignal(supabaseClient, boxCode, onGameAssigned, onReset) {
    const upper = boxCode.toUpperCase();
    const channel = supabaseClient
        .channel(`box-signal:${upper}`)
        .on('broadcast', { event: 'game_assigned' }, (payload) => {
            const gameCode = payload?.payload?.game_code;
            if (gameCode) onGameAssigned(gameCode);
        })
        .on('broadcast', { event: 'reset' }, () => onReset())
        .subscribe((_status, err) => {
            if (err) console.error(`[box-identity] broadcast subscribe error for ${upper}:`, err);
        });
    return () => { supabaseClient.removeChannel(channel); };
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient @param {string} boxCode */
export async function markBoxLive(supabaseClient, boxCode) {
    const { error } = await supabaseClient.from('box_units').update({ status: 'live' }).eq('box_code', boxCode.toUpperCase());
    if (error) console.error('[box-identity] markBoxLive failed:', error.message);
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient @param {string} boxCode */
export async function resetBoxUnit(supabaseClient, boxCode) {
    const { error } = await supabaseClient.from('box_units').update({ game_code: null, status: 'waiting' }).eq('box_code', boxCode.toUpperCase());
    if (error) console.error('[box-identity] resetBoxUnit failed:', error.message);
}
