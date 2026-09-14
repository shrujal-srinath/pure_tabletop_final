// box-pi/daemon/index.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Daemon Orchestrator
//
// The one thing that turns five independently-tested modules into an
// actual running daemon: boots by resuming (or starting fresh), runs a
// Socket.io server speaking wire-contract.js's LAN_EVENTS, and funnels
// EVERY state-changing action — whether it came from the Pico over UART
// or from the touchscreen UI over Socket.io — through one `dispatch()`
// path. There is no second version of "what happens when an action
// arrives" anywhere in this file.
//
// Two things this file resolves that deliberately don't belong anywhere
// else (see the modules' own headers for why they were deferred here):
//   - CLOCK_TOGGLE (the Pico's one physical clock button) needs to know
//     the CURRENT clock.isRunning to decide whether it means start or
//     stop. uart-bridge.js can't know that (no state-engine import
//     allowed there) — only the orchestrator, which holds currentState,
//     can make that call.
//   - TOUCH_LOCK_TOGGLE isn't game state at all (state-engine's State
//     has no `ui` field), so it's tracked here as a small separate
//     daemon-local flag and broadcast on its own wire event
//     (TOUCH_LOCK_STATUS, added to wire-contract.js Contract B for this).
//
// Two small pieces of plumbing this file adds that weren't specified by
// name in any earlier task, both flagged rather than silently invented:
//   1. Game-code assignment. state-engine's reduce() deliberately never
//      sets meta.gameCode (see state-engine.js's own comment — "assigned
//      later by the daemon"), and no task built real uniqueness-checked
//      code generation (old supabaseSync.js's generateGameCode() query
//      against the games table). This file accepts an optional
//      `gameCode` on the incoming setup_game payload (the caller/UI
//      supplies one) and falls back to a NON-uniqueness-checked random
//      code if omitted — a placeholder good enough to wire and verify
//      this orchestrator, not a real generator. Real generation belongs
//      in a later task.
//   2. A tiny local breadcrumb file (data/current-game-code.txt) recording
//      the active game's code. Without this, a cloud-fallback boot resume
//      would have no way to know WHICH cloud game to check — Task 5's
//      resumeGameState() takes a gameCode but nothing before this task
//      persisted one anywhere durable outside the journal itself (which,
//      in the fallback scenario, is exactly what's missing).
// ═══════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

import { reduce, createEmptyState, ACTIONS } from '../shared/state-engine.js';
import { LAN_EVENTS } from '../shared/wire-contract.js';
import { createUartBridge } from './uart-bridge.js';
import { createTicker } from './clock.js';
import { createJournal } from './journal.js';
import { createCloudSync, fetchGameRow } from './cloud-sync.js';
import { resumeGameState, cloudRowToState } from './resume.js';
import {
    getOrCreateBoxCode, registerBoxUnit, startBoxHeartbeat,
    subscribeBoxUnit, subscribeBoxSignal, markBoxLive, resetBoxUnit,
} from './box-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// Overridable so tests can point separate daemon instances at isolated
// directories without touching the real data/ dir.
const DATA_DIR = process.env.BOX_PI_DATA_DIR || path.join(__dirname, '..', 'data');
const GAME_CODE_FILE = path.join(DATA_DIR, 'current-game-code.txt');

// Part A (box-identity task) — persisted once, ever; never regenerated on
// later boots (see box-identity.js's own header for why). Pure local file
// I/O, no network dependency, so this can happen before the Supabase
// client below even exists.
const boxCode = getOrCreateBoxCode(DATA_DIR);
const PORT = 3001;
const CLOCK_TICK_INTERVAL_MS = 100;

// Matches the website's game-code alphabet (excludes visually-ambiguous
// characters) so codes this daemon mints look like any other THE BOX
// game code in the shared `games` table. NOT uniqueness-checked against
// Supabase — see file header. Real generation is later work.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
function generatePlaceholderGameCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    return code;
}

function readGameCodeBreadcrumb() {
    if (!fs.existsSync(GAME_CODE_FILE)) return null;
    const code = fs.readFileSync(GAME_CODE_FILE, 'utf8').trim();
    return code || null;
}
function writeGameCodeBreadcrumb(code) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GAME_CODE_FILE, code ?? '');
}

// ── Supabase client ──────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
if (!process.env.SUPABASE_SERVICE_KEY) {
    console.warn('[daemon] No SUPABASE_SERVICE_KEY in daemon/.env — falling back to the anon key. Cloud writes will fail RLS checks and queue for retry indefinitely until the real service key is added.');
}
const supabaseClient = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

// httpServer/io are created BEFORE boot-resume runs (not at their old spot
// further down) specifically so boot progress can be tracked from the very
// first real stage — resumeGameState()'s cloud-fallback path can take real
// network time, and emitBootProgress() needs `io` to exist to broadcast to
// anyone already connected (nobody can be, this early, but late joiners
// still need the CURRENT stage handed to them on connect — see
// io.on('connection', ...) below).
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

let bootStage = null;
let bootPercent = 0;
function emitBootProgress(stage, percent, detail) {
    bootStage = stage;
    bootPercent = percent;
    io.emit(LAN_EVENTS.BOOT_PROGRESS, detail !== undefined ? { stage, percent, detail } : { stage, percent });
}

// Test-only hook (mirrors BOX_PI_DATA_DIR's existing pattern for isolated
// test runs) — artificially delays the boot sequence just before the
// uart-bridge stage, so a verification script can exercise "boot takes
// longer than Splash's 3s minimum" without a real slow UART/network link.
const BOOT_DELAY_MS = Number(process.env.BOX_PI_TEST_BOOT_DELAY_MS || 0);

// ── Boot ──────────────────────────────────────────────────────────────
emitBootProgress('resuming_state', 0);
const journal = createJournal({ dir: DATA_DIR });
const breadcrumbGameCode = readGameCodeBreadcrumb();

const resumeResult = await resumeGameState({ journal, supabaseClient, gameCode: breadcrumbGameCode });
let currentState = resumeResult.state;
console.log(`[daemon] boot resume source: ${resumeResult.source}`);
emitBootProgress('starting_server', 25, `resumed from ${resumeResult.source}`);

// Authoritative game-code source going forward is the breadcrumb, not
// currentState.meta.gameCode — a journal replay runs actions through the
// pure reduce() only, which never sets meta.gameCode (see header), so a
// resumed state's own gameCode field is not reliable. Enrich the in-memory
// copy purely for anything reading currentState (UI broadcasts, logs).
let currentGameCode = breadcrumbGameCode;
let cloudSync = null;
if (currentState.meta.gameActive && currentGameCode) {
    currentState = { ...currentState, meta: { ...currentState.meta, gameCode: currentGameCode } };
    cloudSync = createCloudSync({ supabaseClient, gameCode: currentGameCode });
    cloudSync.connect();
}

let touchUnlocked = false;

// ── Box identity (online QR setup / remote game assignment) ───────────
// Tracks gameCodes the operator has already CONSCIOUSLY resolved this run
// (dismissed via "Continue manual setup", or attempted "Load" whether it
// succeeded or failed) — daemon-side, in-memory only (per the task's own
// spec: a restart re-presenting an already-resolved assignment once is an
// acceptable, rare edge case, not one worth persisting for).
const presentedGameCodes = new Set();
// The one still-open assignment, if any — distinct from presentedGameCodes
// above. box-pi navigates between screens via full page reloads
// (Return-to-Dashboard, Start New Game), so "a new socket connects while
// an assignment is still pending" is a routine occurrence here, not a rare
// edge case — this needs the SAME snapshot-on-connect treatment every
// other daemon->UI event already gets (state_update, boot_progress,
// box_identity), or an operator whose screen happens to reload in that
// window would simply never see the popup at all. Cleared once the
// operator actually resolves it (DISMISS_REMOTE_GAME or ACCEPT_REMOTE_GAME).
let pendingRemoteAssignment = null;

function handleRemoteAssignment(gameCode) {
    if (!gameCode) return;
    // Guardrail (Part B): a live game is never interrupted by a stray or
    // duplicate remote assignment — not even surfaced, let alone loaded.
    if (currentState.meta.gameActive) {
        console.log(`[box-identity] ignoring remote assignment ${gameCode} — already in an active game`);
        return;
    }
    if (presentedGameCodes.has(gameCode)) return; // already resolved once — don't re-prompt
    pendingRemoteAssignment = gameCode;
    console.log(`[box-identity] remote game available: ${gameCode}`);
    io.emit(LAN_EVENTS.REMOTE_GAME_AVAILABLE, { gameCode });
}
function handleRemoteReset() {
    console.log('[box-identity] remote reset signal received (no local action taken)');
}
/** Marks a gameCode as resolved (dismissed, or an attempted Load — success or failure) so it never re-prompts again this run. */
function resolveRemoteAssignment(gameCode) {
    presentedGameCodes.add(gameCode);
    if (pendingRemoteAssignment === gameCode) pendingRemoteAssignment = null;
}

// box_units, unlike games/game_actions, has RLS open to the anon key for
// INSERT/UPDATE (registration has to work with no auth session at all —
// see box-identity.js's header) — meaning, unlike the rest of this
// file's cloud writes, a registration call here doesn't just get
// silently rejected under the anon key, it actually succeeds and writes
// a real row into the LIVE shared box_units table. Every isolated test
// run (BOX_PI_DATA_DIR set) would otherwise mint and register a fresh
// junk box code against production on every single invocation — this
// module is skipped entirely for those, unless a test explicitly opts
// in via BOX_PI_TEST_ENABLE_BOX_IDENTITY (the one dedicated box-identity
// verification script that actually needs live behavior sets this).
const BOX_IDENTITY_ENABLED = !process.env.BOX_PI_DATA_DIR || process.env.BOX_PI_TEST_ENABLE_BOX_IDENTITY === '1';

// Fire-and-forget, deliberately not top-level-awaited: registration is a
// network call, and nothing about the daemon's own boot sequence (or
// BOOT_PROGRESS) should ever wait on it or be able to fail because of it.
(async function initBoxIdentity() {
    if (!BOX_IDENTITY_ENABLED) {
        console.log('[box-identity] disabled for this run (BOX_PI_DATA_DIR set, no BOX_PI_TEST_ENABLE_BOX_IDENTITY opt-in) — no live box_units writes');
        return;
    }
    try {
        const existing = await registerBoxUnit(supabaseClient, boxCode);
        console.log(`[box-identity] registered as ${boxCode} (existing assignment: ${existing.game_code ?? 'none'}, status: ${existing.status})`);
        startBoxHeartbeat(supabaseClient, boxCode);
        subscribeBoxSignal(supabaseClient, boxCode, handleRemoteAssignment, handleRemoteReset);
        subscribeBoxUnit(supabaseClient, boxCode, handleRemoteAssignment, handleRemoteReset);
        // A game may already have been remotely assigned before this boot
        // ever ran (e.g. assigned while the Pi was off) — surface it the
        // same way a live signal would, subject to the same guardrail.
        if (existing.game_code && existing.status === 'game_ready') {
            handleRemoteAssignment(existing.game_code);
        }
    } catch (err) {
        console.error('[box-identity] init failed (Dashboard QR / remote assignment unavailable this run):', err.message);
    }
})();

/**
 * UI → daemon, on ui_action `ACCEPT_REMOTE_GAME`. Reconstructs state from
 * the remote game's existing cloud row — reuses Task 5's cloud-fallback
 * logic (resume.js's cloudRowToState/cloud-sync.js's fetchGameRow)
 * verbatim rather than duplicating it, just triggered on-demand instead
 * of only at boot. Robustness requirement from the task spec: ANY
 * failure here (network error, malformed row, anything) must never
 * block, crash, or interrupt whatever the operator is doing locally —
 * hence the blanket try/catch with nothing re-thrown.
 * @param {string} gameCode
 */
async function acceptRemoteGame(gameCode) {
    if (!gameCode) return;
    if (currentState.meta.gameActive) {
        console.log('[box-identity] ACCEPT_REMOTE_GAME ignored — a game is already active locally');
        return;
    }
    // Resolved regardless of outcome below — a failed Load shouldn't keep
    // re-prompting the same broken assignment forever either.
    resolveRemoteAssignment(gameCode);
    try {
        const row = await fetchGameRow(supabaseClient, gameCode);
        if (!row) {
            console.warn(`[box-identity] ACCEPT_REMOTE_GAME: no games row found for ${gameCode} — manual setup unaffected`);
            return;
        }
        const state = cloudRowToState(row);

        currentGameCode = gameCode;
        writeGameCodeBreadcrumb(gameCode);
        if (cloudSync) cloudSync.disconnect();
        cloudSync = createCloudSync({ supabaseClient, gameCode });
        cloudSync.connect();
        currentState = { ...state, meta: { ...state.meta, gameCode } };

        io.emit(LAN_EVENTS.STATE_UPDATE, currentState);
        console.log(`[box-identity] accepted remote game ${gameCode} — ${currentState.teamA.name} ${currentState.teamA.score}-${currentState.teamB.score} ${currentState.teamB.name}, period ${currentState.clock.period}`);
        if (currentState.meta.gameActive && BOX_IDENTITY_ENABLED) markBoxLive(supabaseClient, boxCode).catch((err) => console.error('[box-identity] markBoxLive failed:', err.message));
    } catch (err) {
        console.error('[box-identity] ACCEPT_REMOTE_GAME failed (local manual flow unaffected):', err.message);
    }
}

// ── The one dispatch path ────────────────────────────────────────────
function dispatch(action) {
    // Nothing but SETUP_GAME is meaningful before a game exists — mirrors
    // the old daemon's exact guard, prevents stray Pico/UI noise from
    // mutating state when there's nothing active to mutate.
    if (!currentState.meta.gameActive && action.type !== ACTIONS.SETUP_GAME) {
        console.log(`[daemon] ignoring ${action.type} — no active game`);
        return currentState;
    }

    const previousState = currentState;
    let newState = reduce(previousState, action);

    if (action.type === ACTIONS.SETUP_GAME) {
        // See file header — gameCode assignment placeholder.
        currentGameCode = action.payload.gameCode || generatePlaceholderGameCode();
        writeGameCodeBreadcrumb(currentGameCode);
        newState = { ...newState, meta: { ...newState.meta, gameCode: currentGameCode } };
        if (cloudSync) cloudSync.disconnect();
        cloudSync = createCloudSync({ supabaseClient, gameCode: currentGameCode });
        cloudSync.connect();
        // box-identity lifecycle bookend — every SETUP_GAME necessarily
        // activates a game (state-engine's SETUP_GAME always does), so this
        // is unconditional here, unlike acceptRemoteGame's own check.
        if (BOX_IDENTITY_ENABLED) markBoxLive(supabaseClient, boxCode).catch((err) => console.error('[box-identity] markBoxLive failed:', err.message));
    }

    journal.recordAction(action, newState);
    if (cloudSync) cloudSync.onStateChange(newState, action);
    currentState = newState;

    io.emit(LAN_EVENTS.STATE_UPDATE, currentState);

    // Broadcast score_pending exactly when THIS dispatch's own SCORE action
    // needed attribution — gated on action.type, not on a null->non-null
    // diff against previousState. The diff version missed a real case: the
    // reducer never clears pendingAttribution on its own (a popup timeout is
    // a UI-local dismissal only — see LiveGame.tsx), so if a team scores
    // again before an earlier attribution was ever resolved,
    // previousState.pendingAttribution is already truthy and a null->non-null
    // diff never fires, silently dropping the second score's popup even
    // though the reducer correctly recorded a fresh pendingAttribution.
    // Found by exercising box-pi/ui's real Task 6b verification (timeout,
    // then score again), not a hypothetical.
    const justBecamePending = action.type === ACTIONS.SCORE && Boolean(newState.pendingAttribution);
    if (justBecamePending) {
        io.emit(LAN_EVENTS.SCORE_PENDING, {
            team: newState.pendingAttribution.team,
            points: newState.pendingAttribution.points,
            ts: newState.pendingAttribution.ts ?? Date.now(),
        });
    }

    if (action.type === ACTIONS.END_GAME) {
        // wire-contract.js has defined GAME_ENDED/GameEndedPayload since
        // Task 1 but nothing ever emitted it — added here (task 6e) so
        // Post-Game has something concrete to trigger on rather than
        // inferring end-of-game from gameActive flipping false in the
        // regular STATE_UPDATE stream.
        const finalCode = currentGameCode;
        if (cloudSync) { cloudSync.disconnect(); cloudSync = null; }
        journal.clear();
        writeGameCodeBreadcrumb(null);
        currentGameCode = null;
        io.emit(LAN_EVENTS.GAME_ENDED, { finalCode });
        // box-identity lifecycle bookend — mirrors the source's own
        // "Pi resets after game ends" (resetBoxUnit).
        if (BOX_IDENTITY_ENABLED) resetBoxUnit(supabaseClient, boxCode).catch((err) => console.error('[box-identity] resetBoxUnit failed:', err.message));
    }

    return newState;
}

function setTouchUnlocked(next) {
    if (touchUnlocked === next) return;
    touchUnlocked = next;
    io.emit(LAN_EVENTS.TOUCH_LOCK_STATUS, { unlocked: touchUnlocked });
    console.log(`[daemon] touch ${touchUnlocked ? 'UNLOCKED' : 'LOCKED'}`);
}

// ── Clock ticker ──────────────────────────────────────────────────────
// createTicker() only builds the object here — .start() (which is what
// actually begins ticking) is deferred to the listen() callback below, so
// its completion can mark the real 'starting_clock' -> 'ready' transition
// instead of firing before the server (or the uart-bridge) even exists.
const ticker = createTicker({
    intervalMs: CLOCK_TICK_INTERVAL_MS,
    onTick: (deltaMs) => {
        if (currentState.clock.isRunning || currentState.clock.shotClockRunning) {
            dispatch({ type: ACTIONS.CLOCK_TICK, payload: { deltaMs } });
        }
    },
});

// ── Socket.io (the touchscreen UI) ───────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[daemon] UI connected: ${socket.id}`);
    socket.emit(LAN_EVENTS.STATE_UPDATE, currentState);
    socket.emit(LAN_EVENTS.TOUCH_LOCK_STATUS, { unlocked: touchUnlocked });
    // Same "hand a late joiner the current snapshot, not just future
    // broadcasts" pattern as the two lines above — a tab opened after boot
    // already finished must see `ready`/100 immediately, not a stuck 0%.
    socket.emit(LAN_EVENTS.BOOT_PROGRESS, { stage: bootStage, percent: bootPercent });
    // Same pattern again — boxCode never changes at runtime, but a late
    // joiner still needs it handed over on connect, not just derivable
    // from some future event.
    socket.emit(LAN_EVENTS.BOX_IDENTITY, { boxCode });
    // Same pattern once more — a still-open, not-yet-resolved remote
    // assignment must reach a NEW connection too, not just whichever
    // socket happened to be connected the instant it was first surfaced
    // (see pendingRemoteAssignment's own comment for why this genuinely
    // matters here, unlike in the source this was ported from).
    if (pendingRemoteAssignment) socket.emit(LAN_EVENTS.REMOTE_GAME_AVAILABLE, { gameCode: pendingRemoteAssignment });

    socket.on(LAN_EVENTS.SETUP_GAME, (payload) => {
        try {
            dispatch({ type: ACTIONS.SETUP_GAME, payload });
            socket.emit(LAN_EVENTS.GAME_READY, { gameCode: currentGameCode, resumed: !!payload.existingGameCode });
        } catch (err) {
            socket.emit(LAN_EVENTS.SETUP_ERROR, { message: err.message });
        }
    });

    socket.on(LAN_EVENTS.UI_ACTION, (uiAction) => {
        if (uiAction.type === 'UNLOCK_TOUCH') {
            setTouchUnlocked(true);
            return;
        }
        if (uiAction.type === 'ACCEPT_REMOTE_GAME') {
            // Same tier as SETUP_GAME/UNLOCK_TOUCH — bypasses touchUnlocked
            // deliberately. This is a pre-game Dashboard action; touch-lock
            // exists to gate the LIVE GAME screen (the physical settings
            // toggle), and defaults LOCKED, so gating this the same way
            // would make the popup's own "Load" button silently do nothing
            // on real hardware before the operator ever unlocks anything.
            acceptRemoteGame(uiAction.payload?.gameCode);
            return;
        }
        if (uiAction.type === 'DISMISS_REMOTE_GAME') {
            // "Continue manual setup" — same tier as ACCEPT_REMOTE_GAME,
            // same reasoning (pre-game Dashboard action, must work while
            // touch is locked). Marks it resolved so it never re-prompts,
            // including on a later reconnect — the explicit
            // "reconnects/re-renders don't keep re-popping" requirement.
            const code = uiAction.payload?.gameCode;
            if (code) resolveRemoteAssignment(code);
            return;
        }
        if (!touchUnlocked) {
            console.log(`[daemon] UI action rejected — touch locked: ${uiAction.type}`);
            return;
        }
        dispatch({ type: uiAction.type, payload: uiAction.payload });
    });

    socket.on('disconnect', () => console.log(`[daemon] UI disconnected: ${socket.id}`));
});

httpServer.listen(PORT, async () => {
    console.log(`[daemon] listening on :${PORT} (uart devMode=${process.argv.includes('--dev')})`);
    emitBootProgress('connecting_uart', 50);

    if (BOOT_DELAY_MS > 0) {
        console.log(`[daemon] test hook: delaying ${BOOT_DELAY_MS}ms before uart-bridge (BOX_PI_TEST_BOOT_DELAY_MS)`);
        await new Promise((resolve) => setTimeout(resolve, BOOT_DELAY_MS));
    }

    // ── UART bridge (Pico) ───────────────────────────────────────────
    // Created here (not at module scope) so its completion is what the
    // 'connecting_uart' -> 'starting_clock' transition is actually tied
    // to, not a timer. Real vs devMode both return synchronously (see
    // uart-bridge.js's own header) — the real hardware path's actual
    // serial handshake happens after this call returns, but this module
    // doesn't currently expose a "port actually opened" promise to wait
    // on; this stage marks "the bridge is wired up and listening for
    // input", which is accurate for devMode and the practical signal
    // available today for real hardware.
    createUartBridge({
        devMode: process.argv.includes('--dev'),
        onAction: (action) => {
            // Resolved here, and only here — see file header.
            if (action.type === 'CLOCK_TOGGLE') {
                dispatch({ type: currentState.clock.isRunning ? ACTIONS.CLOCK_STOP : ACTIONS.CLOCK_START });
                return;
            }
            if (action.type === 'TOUCH_LOCK_TOGGLE') {
                setTouchUnlocked(!touchUnlocked);
                return;
            }
            dispatch(action);
        },
    });
    emitBootProgress('starting_clock', 75);

    ticker.start();
    emitBootProgress('ready', 100);
});

export { dispatch, setTouchUnlocked };
