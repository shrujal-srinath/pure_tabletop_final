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
import { createCloudSync } from './cloud-sync.js';
import { resumeGameState } from './resume.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// Overridable so tests can point separate daemon instances at isolated
// directories without touching the real data/ dir.
const DATA_DIR = process.env.BOX_PI_DATA_DIR || path.join(__dirname, '..', 'data');
const GAME_CODE_FILE = path.join(DATA_DIR, 'current-game-code.txt');
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

// ── Boot ──────────────────────────────────────────────────────────────
const journal = createJournal({ dir: DATA_DIR });
const breadcrumbGameCode = readGameCodeBreadcrumb();

const resumeResult = await resumeGameState({ journal, supabaseClient, gameCode: breadcrumbGameCode });
let currentState = resumeResult.state;
console.log(`[daemon] boot resume source: ${resumeResult.source}`);

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

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

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
    }

    journal.recordAction(action, newState);
    if (cloudSync) cloudSync.onStateChange(newState, action);
    currentState = newState;

    io.emit(LAN_EVENTS.STATE_UPDATE, currentState);

    // Only broadcast score_pending when this dispatch is what CREATED the
    // pending attribution — not on every later action while it's still
    // sitting there unresolved (that would re-trigger the UI's popup).
    const justBecamePending = !previousState.pendingAttribution && newState.pendingAttribution;
    if (justBecamePending) {
        io.emit(LAN_EVENTS.SCORE_PENDING, {
            team: newState.pendingAttribution.team,
            points: newState.pendingAttribution.points,
            ts: newState.pendingAttribution.ts ?? Date.now(),
        });
    }

    if (action.type === ACTIONS.END_GAME) {
        if (cloudSync) { cloudSync.disconnect(); cloudSync = null; }
        journal.clear();
        writeGameCodeBreadcrumb(null);
        currentGameCode = null;
    }

    return newState;
}

function setTouchUnlocked(next) {
    if (touchUnlocked === next) return;
    touchUnlocked = next;
    io.emit(LAN_EVENTS.TOUCH_LOCK_STATUS, { unlocked: touchUnlocked });
    console.log(`[daemon] touch ${touchUnlocked ? 'UNLOCKED' : 'LOCKED'}`);
}

// ── UART bridge (Pico) ───────────────────────────────────────────────
const uartBridge = createUartBridge({
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

// ── Clock ticker ──────────────────────────────────────────────────────
const ticker = createTicker({
    intervalMs: CLOCK_TICK_INTERVAL_MS,
    onTick: (deltaMs) => {
        if (currentState.clock.isRunning || currentState.clock.shotClockRunning) {
            dispatch({ type: ACTIONS.CLOCK_TICK, payload: { deltaMs } });
        }
    },
});
ticker.start();

// ── Socket.io (the touchscreen UI) ───────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[daemon] UI connected: ${socket.id}`);
    socket.emit(LAN_EVENTS.STATE_UPDATE, currentState);
    socket.emit(LAN_EVENTS.TOUCH_LOCK_STATUS, { unlocked: touchUnlocked });

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
        if (!touchUnlocked) {
            console.log(`[daemon] UI action rejected — touch locked: ${uiAction.type}`);
            return;
        }
        dispatch({ type: uiAction.type, payload: uiAction.payload });
    });

    socket.on('disconnect', () => console.log(`[daemon] UI disconnected: ${socket.id}`));
});

httpServer.listen(PORT, () => {
    console.log(`[daemon] listening on :${PORT} (uart devMode=${process.argv.includes('--dev')})`);
});

export { dispatch, setTouchUnlocked };
