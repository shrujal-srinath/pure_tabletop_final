// box-pi/shared/state-engine.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Game State Engine
//
// A pure reducer: reduce(state, action) -> newState. This is the ONLY
// place "what happens when you score / foul / call timeout" is defined.
// Every module that changes game state (daemon, tests, a future replay
// tool) goes through this function instead of mutating state by hand —
// that's what prevents the old codebase's bug class of several scoring
// implementations quietly disagreeing with each other.
//
// Pure means: no Date.now(), no setTimeout, no I/O, no serialport/
// socket.io/supabase imports, no randomness, no mutation of the input
// state. Time and wall-clock timestamps only enter via fields an action
// carries in explicitly (CLOCK_TICK's `deltaMs`, SCORE's optional `ts`) —
// this module never reads the clock itself, which is what makes it
// testable by calling it with plain objects, no hardware involved.
//
// This module's state shape is its own — it is NOT one of the frozen
// wire-contract.js shapes. A later stage (cloud-sync) translates this
// state into GamesDataRow / ScoreUpdatePayload etc. Where a field here
// is meant to end up inside a wire-contract payload unchanged, its type
// is imported from wire-contract.js rather than redefined — see
// `pendingAttribution` below, which mirrors ScorePendingPayload.
// ═══════════════════════════════════════════════════════════════════════

/** @typedef {import('./wire-contract.js').ScorePendingPayload} ScorePendingPayload */

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} name
 * @property {string} number
 * @property {number} fouls Cumulative personal fouls for the whole game — never reset by PERIOD_ADVANCE (FIBA foul-out is a game-long total, not a per-period one).
 * @property {boolean} fouledOut
 */

/**
 * @typedef {Object} Team
 * @property {string} name
 * @property {string} color
 * @property {number} score
 * @property {number} fouls Team fouls THIS PERIOD only — reset by PERIOD_ADVANCE. This is deliberately per-period, not cumulative: it's what `isBonus` reads, and FIBA bonus resets every period.
 * @property {number} timeouts Timeouts remaining in the current bracket (see `timeoutAllotmentForPeriod`).
 * @property {Player[]} players
 */

/**
 * @typedef {Object} ClockState
 * @property {number} gameMs
 * @property {number} shotMs
 * @property {boolean} isRunning
 * @property {boolean} shotClockRunning
 * @property {number} period
 * @property {number} totalPeriods
 * @property {number} periodMs
 * @property {number} shotClockMs
 */

/**
 * @typedef {Object} GameMeta
 * @property {string|null} gameCode Assigned by the daemon once Supabase issues a code — this module never invents one (no randomness).
 * @property {boolean} gameActive
 * @property {'quick'|'stats'|'advanced'} gameMode
 */

/**
 * @typedef {Object} PendingAttribution
 * @property {'A'|'B'} team
 * @property {1|2|3|null} points Null ONLY for a miss: nothing scored, so no button reported a value and the shot's location decides whether it was a 2pt or 3pt attempt. Always set for a make.
 * @property {boolean} made False for a SHOT_MISS, true for a SCORE. Decides `shot_events.made`, which is what makes FG% and every shot-quality number possible — a makes-only dataset inflates all of them.
 * @property {number|null} ts Caller-supplied (e.g. Date.now()) when the action is dispatched — this module never reads the clock itself.
 */

/**
 * @typedef {Object} State
 * @property {Team} teamA
 * @property {Team} teamB
 * @property {ClockState} clock
 * @property {'A'|'B'} possession
 * @property {GameMeta} meta
 * @property {PendingAttribution|null} pendingAttribution
 * @property {string|null} lastError Set when an action is rejected; read once and cleared by the caller (or superseded by the next action's own lastError, which is always reset to null on every non-rejected action).
 * @property {State|null} _previousState Single-level UNDO snapshot. Not a wire shape — internal to this module.
 */

/**
 * @typedef {Object} Action
 * @property {string} type One of the ACTIONS values below.
 * @property {Object} [payload]
 */

export const ACTIONS = {
    SETUP_GAME: 'SETUP_GAME',
    SCORE: 'SCORE',
    SHOT_MISS: 'SHOT_MISS',
    ATTRIBUTE_SHOT: 'ATTRIBUTE_SHOT',
    FOUL: 'FOUL',
    TIMEOUT: 'TIMEOUT',
    PERIOD_ADVANCE: 'PERIOD_ADVANCE',
    CLOCK_TICK: 'CLOCK_TICK',
    CLOCK_START: 'CLOCK_START',
    CLOCK_STOP: 'CLOCK_STOP',
    SHOT_CLOCK_RESET: 'SHOT_CLOCK_RESET',
    UNDO: 'UNDO',
    END_GAME: 'END_GAME',
};

// ── Empty team / initial state ───────────────────────────────────────

/** @returns {Team} */
function emptyTeam(name, color) {
    return { name, color, score: 0, fouls: 0, timeouts: 0, players: [] };
}

/**
 * The state to hold before the first SETUP_GAME — pass this to `reduce`
 * as the starting point, not `undefined`/`null`.
 * @returns {State}
 */
export function createEmptyState() {
    return {
        teamA: emptyTeam('Team A', '#3B82F6'),
        teamB: emptyTeam('Team B', '#EF4444'),
        clock: {
            gameMs: 0,
            shotMs: 0,
            isRunning: false,
            shotClockRunning: false,
            period: 1,
            totalPeriods: 4,
            periodMs: 0,
            shotClockMs: 0,
        },
        possession: 'A',
        meta: { gameCode: null, gameActive: false, gameMode: 'quick' },
        pendingAttribution: null,
        lastError: null,
        _previousState: null,
    };
}

/** @param {Array<{id:string,name:string,number:string}>} [roster] @returns {Player[]} */
function normalizeRoster(roster) {
    if (!Array.isArray(roster)) return [];
    return roster.map((p) => ({ id: p.id, name: p.name, number: p.number, fouls: 0, fouledOut: false }));
}

// ── FIBA timeout brackets ────────────────────────────────────────────
// "2 timeouts across Q1+Q2 combined, 3 for Q3+Q4, 1 per OT" is a POOLED
// allotment per half, not per period — the count must carry over from
// Q1 to Q2 unchanged and only reset when the bracket itself changes.

/** @returns {string} */
function timeoutBracketKey(period, totalPeriods) {
    const half = Math.ceil(totalPeriods / 2);
    if (period <= half) return 'H1';
    if (period <= totalPeriods) return 'H2';
    return `OT${period - totalPeriods}`;
}

/** @returns {number} */
function timeoutAllotmentForBracket(bracketKey) {
    if (bracketKey === 'H1') return 2;
    if (bracketKey === 'H2') return 3;
    return 1; // OT*
}

// ── Derived values (functions, not stored fields) ────────────────────

/**
 * True if `team`'s OPPONENT has committed enough fouls this period to
 * put `team` in the bonus (FIBA: opponent's 5th team foul in the period).
 * @param {State} state @param {'A'|'B'} team @returns {boolean}
 */
export function isBonus(state, team) {
    const opponent = team === 'A' ? state.teamB : state.teamA;
    return opponent.fouls >= 5;
}

/** @param {Player} player @returns {boolean} */
export function isFouledOut(player) {
    return player.fouls >= 5;
}

// ── UNDO snapshot helper ─────────────────────────────────────────────

/**
 * Single-level only: the snapshot itself never carries a `_previousState`,
 * so a second UNDO in a row has nothing to restore (no redo stack).
 * @param {State} state @returns {State}
 */
function snapshotForUndo(state) {
    const { _previousState, ...rest } = state;
    return structuredClone(rest);
}

/** Reject an action without changing anything observable except lastError. */
function reject(state, message) {
    return { ...state, lastError: message };
}

// ── The reducer ───────────────────────────────────────────────────────

/**
 * @param {State} state
 * @param {Action} action
 * @returns {State}
 */
export function reduce(state, action) {
    const { type, payload = {} } = action;

    switch (type) {
        case ACTIONS.SETUP_GAME: {
            const periodMs = payload.periodMinutes * 60 * 1000;
            const shotClockMs = payload.shotClockSeconds * 1000;
            const totalPeriods = payload.periods;
            const bracket = timeoutBracketKey(1, totalPeriods);
            const timeouts = timeoutAllotmentForBracket(bracket);

            return {
                teamA: {
                    name: payload.teamAName,
                    color: payload.teamAColor,
                    score: 0,
                    fouls: 0,
                    timeouts,
                    players: normalizeRoster(payload.roster?.teamA),
                },
                teamB: {
                    name: payload.teamBName,
                    color: payload.teamBColor,
                    score: 0,
                    fouls: 0,
                    timeouts,
                    players: normalizeRoster(payload.roster?.teamB),
                },
                clock: {
                    gameMs: periodMs,
                    shotMs: shotClockMs,
                    isRunning: false,
                    shotClockRunning: false,
                    period: 1,
                    totalPeriods,
                    periodMs,
                    shotClockMs,
                },
                possession: 'A',
                // gameCode is assigned later by the daemon (Supabase owns code
                // generation) — this module never invents one.
                meta: { gameCode: null, gameActive: true, gameMode: payload.gameMode },
                pendingAttribution: null,
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.SCORE: {
            const teamKey = payload.team === 'A' ? 'teamA' : 'teamB';
            const needsAttribution =
                (state.meta.gameMode === 'stats' || state.meta.gameMode === 'advanced') && !payload.playerId;

            return {
                ...state,
                [teamKey]: { ...state[teamKey], score: state[teamKey].score + payload.points },
                pendingAttribution: needsAttribution
                    ? { team: payload.team, points: payload.points, made: true, ts: payload.ts ?? null }
                    : state.pendingAttribution,
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.SHOT_MISS: {
            // A miss changes NOTHING about the game: no score, no fouls, no
            // clock. Its entire purpose is to open a shot-attribution prompt
            // so a `shot_events` row with made:false gets written — which is
            // what makes FG% and shot-quality analytics mean anything. A
            // makes-only dataset reports every player as a 100% shooter.
            //
            // Quick mode has no play-by-play at all, so there is nothing for
            // a miss to produce there — rejected rather than silently swallowed
            // so a mis-wired UI surfaces instead of dropping data.
            if (state.meta.gameMode === 'quick') {
                return reject(state, 'Misses are not recorded in quick mode.');
            }
            // Unlike SCORE, `points` is deliberately absent: nothing was
            // scored, so no button reported a value. The shot's LOCATION
            // decides whether it was a 2pt or 3pt attempt, resolved when
            // ATTRIBUTE_SHOT arrives with the tap.
            return {
                ...state,
                pendingAttribution: { team: payload.team, points: null, made: false, ts: payload.ts ?? null },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.ATTRIBUTE_SHOT: {
            if (!state.pendingAttribution) {
                return reject(state, 'No pending shot attribution to resolve.');
            }
            // This module tracks only the mechanics of clearing the prompt —
            // crediting a player's points/makes is a stats-table concern for
            // a later stage (shot_events), not this in-memory game state.
            return {
                ...state,
                pendingAttribution: null,
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.FOUL: {
            const teamKey = payload.team === 'A' ? 'teamA' : 'teamB';
            const team = state[teamKey];
            const trackPersonalFoul =
                (state.meta.gameMode === 'stats' || state.meta.gameMode === 'advanced') && payload.playerId;

            const players = trackPersonalFoul
                ? team.players.map((p) => {
                      if (p.id !== payload.playerId) return p;
                      const fouls = p.fouls + 1;
                      return { ...p, fouls, fouledOut: isFouledOut({ ...p, fouls }) };
                  })
                : team.players;

            return {
                ...state,
                [teamKey]: { ...team, fouls: team.fouls + 1, players },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.TIMEOUT: {
            const teamKey = payload.team === 'A' ? 'teamA' : 'teamB';
            const team = state[teamKey];
            if (team.timeouts <= 0) {
                return reject(state, `Team ${payload.team} has no timeouts remaining in this bracket.`);
            }
            return {
                ...state,
                [teamKey]: { ...team, timeouts: team.timeouts - 1 },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.PERIOD_ADVANCE: {
            const oldPeriod = state.clock.period;
            const newPeriod = oldPeriod + 1;
            const oldBracket = timeoutBracketKey(oldPeriod, state.clock.totalPeriods);
            const newBracket = timeoutBracketKey(newPeriod, state.clock.totalPeriods);
            const bracketChanged = oldBracket !== newBracket;
            const freshTimeouts = timeoutAllotmentForBracket(newBracket);

            return {
                ...state,
                // Team fouls are THIS-PERIOD counters (see Team typedef / isBonus)
                // — they reset every period. Personal fouls (players[].fouls) are
                // a game-long total and are untouched here.
                teamA: {
                    ...state.teamA,
                    fouls: 0,
                    timeouts: bracketChanged ? freshTimeouts : state.teamA.timeouts,
                },
                teamB: {
                    ...state.teamB,
                    fouls: 0,
                    timeouts: bracketChanged ? freshTimeouts : state.teamB.timeouts,
                },
                clock: {
                    ...state.clock,
                    period: newPeriod,
                    gameMs: state.clock.periodMs,
                    shotMs: state.clock.shotClockMs,
                    isRunning: false,
                },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.CLOCK_TICK: {
            return {
                ...state,
                clock: {
                    ...state.clock,
                    gameMs: state.clock.isRunning ? Math.max(0, state.clock.gameMs - payload.deltaMs) : state.clock.gameMs,
                    shotMs: state.clock.shotClockRunning
                        ? Math.max(0, state.clock.shotMs - payload.deltaMs)
                        : state.clock.shotMs,
                },
                lastError: null,
                // Deliberately NOT snapshotForUndo(state) — ticks are automatic,
                // not human-triggered, so they must not create an UNDO point.
                // Carry the existing snapshot forward so UNDO still reverts to
                // the last real ref action, not to a fraction-of-a-second-ago
                // tick. (Review fix, task 3.)
                _previousState: state._previousState,
            };
        }

        case ACTIONS.CLOCK_START: {
            return {
                ...state,
                clock: { ...state.clock, isRunning: true },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.CLOCK_STOP: {
            return {
                ...state,
                clock: { ...state.clock, isRunning: false },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.SHOT_CLOCK_RESET: {
            return {
                ...state,
                clock: { ...state.clock, shotMs: state.clock.shotClockMs, shotClockRunning: true },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        case ACTIONS.UNDO: {
            if (!state._previousState) return { ...state };
            return { ...state._previousState };
        }

        case ACTIONS.END_GAME: {
            return {
                ...state,
                meta: { ...state.meta, gameActive: false },
                lastError: null,
                _previousState: snapshotForUndo(state),
            };
        }

        default:
            return { ...state };
    }
}
