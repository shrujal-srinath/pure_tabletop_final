// box-pi/shared/wire-contract.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Wire Contract
//
// The single shared vocabulary for every event name and payload shape this
// device speaks. No other module invents an event name or a field name —
// everything imports it from here instead.
//
// Two contracts, two different rules:
//   Contract A (CLOUD) — FROZEN. Consumed by the existing website + app
//                         over the shared Supabase backend. Copy names
//                         exactly; never rename for style.
//   Contract B (LAN)   — internal to this device (daemon <-> its own
//                         touchscreen UI, over Socket.io). Ours to design.
//
// Plain JS + JSDoc on purpose: the daemon is plain Node with no build
// step, and JSDoc still gives full type-checking/autocomplete on both the
// daemon and a Vite+TS frontend later, from this one file.
// ═══════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// CONTRACT A — CLOUD (Supabase Realtime Broadcast, channel `game:{code}`)
// FROZEN — matches the live website + app exactly. Do not rename anything
// here, even where it looks inconsistent with Contract B's style.
// ─────────────────────────────────────────────────────────────────────────

export const CLOUD_EVENTS = {
    SCORE_UPDATE: 'score_update',
    CLOCK_TICK: 'clock_tick',
    CLOCK_START: 'clock_start',
    CLOCK_STOP: 'clock_stop',
    PERIOD_CHANGE: 'period_change',
    SHOTCLOCK_RESET: 'shotclock_reset',
    GAME_SNAPSHOT: 'game_snapshot',
};

/**
 * Broadcast on `score_update`.
 * @typedef {Object} ScoreUpdatePayload
 * @property {number} teamA
 * @property {number} teamB
 * @property {number} foulsA
 * @property {number} foulsB
 * @property {number} timeoutsA
 * @property {number} timeoutsB
 * @property {'A'|'B'|null} possession
 * @property {number} period
 * @property {number} ts
 */

/**
 * Broadcast on `clock_tick` (running or not), `clock_start`
 * (gameRunning: true), and `clock_stop` (gameRunning: false) — same shape
 * for all three.
 * @typedef {Object} ClockTickPayload
 * @property {number} minutes
 * @property {number} seconds
 * @property {number} tenths
 * @property {number} shotClock
 * @property {number} period
 * @property {boolean} gameRunning
 * @property {number} ts
 */

/**
 * Broadcast on `period_change`.
 * @typedef {Object} PeriodChangePayload
 * @property {number} period
 * @property {number} minutes
 * @property {number} seconds
 * @property {number} tenths
 * @property {number} shotClock
 * @property {boolean} gameRunning
 * @property {number} ts
 */

/**
 * Broadcast on `shotclock_reset`.
 * @typedef {Object} ShotclockResetPayload
 * @property {number} shotClock
 * @property {boolean} shotClockRunning
 * @property {number} ts
 */

/**
 * Broadcast on `game_snapshot`.
 * @typedef {Object} GameSnapshotPayload
 * @property {Object} clock
 * @property {number} clock.minutes
 * @property {number} clock.seconds
 * @property {number} clock.tenths
 * @property {number} clock.shotClock
 * @property {number} clock.period
 * @property {boolean} clock.gameRunning
 * @property {Object} score
 * @property {number} score.teamA
 * @property {number} score.teamB
 * @property {number} score.foulsA
 * @property {number} score.foulsB
 * @property {number} score.timeoutsA
 * @property {number} score.timeoutsB
 * @property {'A'|'B'|null} score.possession
 * @property {number} timestamp
 */

/**
 * `games.data` — the persisted JSONB snapshot column, written on every
 * meaningful change. FROZEN shape, nested field names included.
 * @typedef {Object} GamesDataRow
 * @property {GamesDataTeam} teamA
 * @property {GamesDataTeam} teamB
 * @property {GamesDataGameState} gameState
 * @property {GamesDataSettings} settings
 */

/**
 * @typedef {Object} GamesDataTeam
 * @property {string} name
 * @property {string} color
 * @property {number} score
 * @property {number} fouls
 * @property {number} timeouts
 */

/**
 * @typedef {Object} GamesDataGameTime
 * @property {number} minutes
 * @property {number} seconds
 * @property {number} tenths
 */

/**
 * @typedef {Object} GamesDataGameState
 * @property {number} period
 * @property {boolean} gameRunning
 * @property {GamesDataGameTime} gameTime
 * @property {number} shotClock
 * @property {'A'|'B'} possession
 */

/**
 * NOTE (added 2026-09-12, task 5): live prod rows show real drift here —
 * different game-creation paths over the site's history wrote different
 * settings shapes (e.g. one older path used periodCount/hasShotClock/
 * shotClockSec/timeoutsPerHalf/periodDurationMin instead). This typedef is
 * NOT a claim that every historical row matches it — it's the shape THIS
 * codebase (box-pi) always writes and always reads back, which is all that
 * matters for its own resume-from-cloud path (it only ever resumes a game
 * it created itself). shotClockDuration was missing from the original
 * version of this typedef and had to be added — without it there was no
 * way to recover the configured shot-clock length on a cloud-fallback
 * resume.
 * @typedef {Object} GamesDataSettings
 * @property {'quick'|'stats'|'advanced'} gameMode
 * @property {number} periods
 * @property {number} periodDuration
 * @property {number} shotClockDuration
 */

// ─────────────────────────────────────────────────────────────────────────
// CONTRACT B — LAN (Socket.io, daemon <-> this device's own touchscreen UI)
// Internal only — nothing outside this device depends on these names.
// Kept in the same camelCase / `ts`-for-timestamp style as Contract A so
// the two contracts read as one system, not two conventions.
// ─────────────────────────────────────────────────────────────────────────

export const LAN_EVENTS = {
    // daemon → UI
    STATE_UPDATE: 'state_update',
    SCORE_PENDING: 'score_pending',
    UNDO_TRIGGERED: 'undo_triggered',
    PICO_STATUS: 'pico_status',
    TOUCH_LOCK_STATUS: 'touch_lock_status', // added task 6a — touch-lock is daemon-local state, not part of state-engine's State, so it needed its own event rather than riding inside STATE_UPDATE
    GAME_READY: 'game_ready',
    GAME_ENDED: 'game_ended',
    SETUP_ERROR: 'setup_error',
    // UI → daemon
    SETUP_GAME: 'setup_game',
    UI_ACTION: 'ui_action',
};

/**
 * daemon → UI, on `state_update`. The full current game state, sent after
 * every change so the UI can just render it rather than track deltas.
 * @typedef {Object} StateUpdatePayload
 * @property {GamesDataTeam} teamA
 * @property {GamesDataTeam} teamB
 * @property {LanClockState} clock
 * @property {'A'|'B'|null} possession
 * @property {LanGameMeta} meta
 */

/**
 * @typedef {Object} LanClockState
 * @property {number} gameMs
 * @property {number} shotMs
 * @property {boolean} isRunning
 * @property {number} period
 * @property {number} totalPeriods
 * @property {number} periodMinutes
 * @property {number} shotClockSeconds
 */

/**
 * @typedef {Object} LanGameMeta
 * @property {string|null} gameCode
 * @property {boolean} gameActive
 * @property {'quick'|'stats'|'advanced'} gameMode
 */

/**
 * daemon → UI, on `score_pending`. A transient prompt — a score just
 * landed and the UI should run its shot-attribution flow. Deliberately its
 * own event rather than a field on StateUpdatePayload: it's a one-shot
 * instruction to show a popup, not persistent state, so the UI must not
 * re-trigger it just because a later state_update replays the same score.
 * @typedef {Object} ScorePendingPayload
 * @property {'A'|'B'} team
 * @property {1|2|3} points
 * @property {number} ts
 */

/**
 * daemon → UI, on `pico_status`.
 * @typedef {Object} PicoStatusPayload
 * @property {boolean} connected
 * @property {string|null} source
 */

/**
 * daemon → UI, on `touch_lock_status` — added task 6a. Fired whenever the
 * physical settings toggle (or a UI-initiated unlock) changes touch-lock
 * state. Never bundled into StateUpdatePayload: touch-lock isn't game state,
 * it's a UI-input gate the daemon orchestrator owns separately.
 * @typedef {Object} TouchLockStatusPayload
 * @property {boolean} unlocked
 */

/**
 * daemon → UI, on `game_ready` — sent once `setup_game` succeeds.
 * @typedef {Object} GameReadyPayload
 * @property {string} gameCode
 * @property {boolean} resumed
 */

/**
 * daemon → UI, on `game_ended`.
 * @typedef {Object} GameEndedPayload
 * @property {string} finalCode
 */

/**
 * daemon → UI, on `setup_error` — `setup_game` failed.
 * @typedef {Object} SetupErrorPayload
 * @property {string} message
 */

/**
 * UI → daemon, on `setup_game`. Operator-submitted match configuration.
 * `roster` was always accepted by state-engine.js's SETUP_GAME action
 * (Task 2) but missing from this typedef until task 6d — added here
 * additively, Contract A untouched.
 * @typedef {Object} SetupGamePayload
 * @property {string} teamAName
 * @property {string} teamBName
 * @property {string} teamAColor
 * @property {string} teamBColor
 * @property {number} periodMinutes
 * @property {number} shotClockSeconds
 * @property {number} periods
 * @property {'quick'|'stats'|'advanced'} gameMode
 * @property {string} [existingGameCode] Resume path — set to recover a game the daemon already created.
 * @property {Object} [roster] stats/advanced mode only — omitted entirely for quick mode.
 * @property {Array<{id:string,name:string,number:string}>} [roster.teamA] `number` is a string (jersey numbers are display text, e.g. "00") — matches state-engine.js's real Player/normalizeRoster types exactly; the task text that originally asked for this field said `number:number`, which doesn't match the actual reducer and wasn't followed. Only id/name/number are submitted; fouls/fouledOut are initialized by the reducer itself.
 * @property {Array<{id:string,name:string,number:string}>} [roster.teamB]
 */

/**
 * UI → daemon, on `ui_action`. Any touchscreen-originated button press.
 * `type` names the action; the shape of `payload` depends on `type` and is
 * owned by whichever module handles that action, not by this contract.
 * @typedef {Object} UiActionPayload
 * @property {string} type
 * @property {Object} [payload]
 */
