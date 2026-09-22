// box-pi/daemon/cloud-sync.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Cloud Sync
//
// The ONE entry point everything else calls after a reduce(): onStateChange
// (newState, action). It translates state-engine's internal shape into the
// FROZEN wire-contract.js cloud payloads, broadcasts what actually changed
// on `game:{code}`, and durably persists to Supabase (games.data, plus
// game_actions/shot_events rows the old daemon never wrote).
//
// Schema verified live against the real eoowagimooxsqcrrihbw project
// (2026-09-12) before writing this — not assumed. Two things that verify
// changed the design from a literal reading of the task:
//
//   1. game_actions.action_type has no DB CHECK constraint, but it IS a
//      closed de facto vocabulary the website/app actually filter box
//      scores and play-by-play by (GameActionType in shotTypes.ts):
//      rebound/steal/turnover/block/assist/foul/timeout/substitution/
//      jumpball/foul_drawn — there is deliberately NO 'score' word in it.
//      Confirmed against src/services/statsEngine.ts's own header comment:
//      "all basketball scoring (incl. free throws) flows through
//      shot_events" — shot_events, not game_actions, is the canonical
//      scoring record for BOTH stats and advanced mode (unlocated when no
//      x/y is known; that's what "unlocated" zone/null x/y exist for).
//      That's why writeShotEvent below is gated on gameMode !== 'quick',
//      not === 'advanced' — a quick-mode game correctly has NO play-by-play
//      at all beyond the games.data snapshot, matching this ecosystem's
//      own documented mode semantics (CLAUDE.md: "quick — score only. No
//      player tracking, no stats export."), not an oversight. Of
//      state-engine's own action types, only FOUL and TIMEOUT map onto a
//      real game_actions value — writing 'SETUP_GAME', 'CLOCK_START',
//      'UNDO', etc. into this shared, cross-app-read column would inject
//      garbage into every game's play-by-play. (rebound/steal/turnover/
//      block/assist/substitution aren't modeled by state-engine yet at
//      all — a real gap, not silently papered over here.)
//   2. shot_events.client_event_id exists but has NO unique constraint
//      backing it (checked pg_constraint directly), so a DB-level
//      ON CONFLICT DO NOTHING isn't available and adding the constraint is
//      a schema migration out of this repo's scope. insertShotEventIdempotent
//      below is the application-level guard instead: check-then-insert on
//      (game_code, client_event_id) before writing, so a write retried
//      after an ambiguous network failure (request landed, response lost)
//      can't create a duplicate row. Not as airtight as a DB constraint — a
//      second process racing the identical check-then-insert could still
//      slip through — but this daemon is single-process/single-court, so
//      that race isn't a real exposure here.
//
// The games.data JSONB written here is deliberately just wire-contract.js's
// documented GamesDataRow shape (teamA/teamB/gameState/settings) — the real
// table's existing rows also duplicate several top-level columns into the
// JSONB (code/hostId/status/...), but nothing reads those copies over the
// real columns, and reproducing that redundancy would just be carrying the
// old codebase's mess into a fresh one.
// ═══════════════════════════════════════════════════════════════════════

import { CLOUD_EVENTS } from '../shared/wire-contract.js';
import { ACTIONS } from '../shared/state-engine.js';
import { freeThrowLocation, zonePointValue } from '../shared/court-geometry.js';

const CLOCK_BROADCAST_THROTTLE_MS = 1000;
const RETRY_INTERVAL_MS = 15000;

/** @returns {{minutes:number, seconds:number, tenths:number}} */
function msToClockParts(ms) {
    const totalTenths = Math.floor(ms / 100);
    return {
        minutes: Math.floor(totalTenths / 600),
        seconds: Math.floor((totalTenths % 600) / 10),
        tenths: totalTenths % 10,
    };
}

function shallowEqual(a, b) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** @returns {import('../shared/wire-contract.js').ScoreUpdatePayload} */
function buildScoreUpdatePayload(state) {
    return {
        teamA: state.teamA.score,
        teamB: state.teamB.score,
        foulsA: state.teamA.fouls,
        foulsB: state.teamB.fouls,
        timeoutsA: state.teamA.timeouts,
        timeoutsB: state.teamB.timeouts,
        possession: state.possession,
        period: state.clock.period,
        ts: Date.now(),
    };
}

/** @returns {import('../shared/wire-contract.js').ClockTickPayload} */
function buildClockTickPayload(state) {
    const { minutes, seconds, tenths } = msToClockParts(state.clock.gameMs);
    return {
        minutes, seconds, tenths,
        shotClock: Math.ceil(state.clock.shotMs / 1000),
        period: state.clock.period,
        gameRunning: state.clock.isRunning,
        ts: Date.now(),
    };
}

/** @returns {import('../shared/wire-contract.js').ShotclockResetPayload} */
function buildShotclockResetPayload(state) {
    return {
        shotClock: Math.ceil(state.clock.shotMs / 1000),
        shotClockRunning: state.clock.shotClockRunning,
        ts: Date.now(),
    };
}

/** @returns {import('../shared/wire-contract.js').GameSnapshotPayload} */
function buildGameSnapshotPayload(state) {
    const { minutes, seconds, tenths } = msToClockParts(state.clock.gameMs);
    return {
        clock: {
            minutes, seconds, tenths,
            shotClock: Math.ceil(state.clock.shotMs / 1000),
            period: state.clock.period,
            gameRunning: state.clock.isRunning,
        },
        score: {
            teamA: state.teamA.score, teamB: state.teamB.score,
            foulsA: state.teamA.fouls, foulsB: state.teamB.fouls,
            timeoutsA: state.teamA.timeouts, timeoutsB: state.teamB.timeouts,
            possession: state.possession,
        },
        timestamp: Date.now(),
    };
}

/** @returns {import('../shared/wire-contract.js').GamesDataRow} */
function buildGamesDataRow(state) {
    return {
        teamA: { name: state.teamA.name, color: state.teamA.color, score: state.teamA.score, fouls: state.teamA.fouls, timeouts: state.teamA.timeouts },
        teamB: { name: state.teamB.name, color: state.teamB.color, score: state.teamB.score, fouls: state.teamB.fouls, timeouts: state.teamB.timeouts },
        gameState: {
            period: state.clock.period,
            gameRunning: state.clock.isRunning,
            gameTime: msToClockParts(state.clock.gameMs),
            shotClock: Math.ceil(state.clock.shotMs / 1000),
            possession: state.possession,
        },
        settings: {
            gameMode: state.meta.gameMode,
            periods: state.clock.totalPeriods,
            periodDuration: Math.round(state.clock.periodMs / 60000),
            shotClockDuration: Math.round(state.clock.shotClockMs / 1000),
        },
    };
}

/**
 * @param {Object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient A single privileged (service-role) client — used for both the realtime channel and durable table writes. The daemon runs server-side, so there's no browser-key constraint requiring two separate clients the way the website needed.
 * @param {string} opts.gameCode Assumed already valid/decided — generating a fresh unique code is separate daemon glue not built here (mirrors the old createGame()'s uniqueness-checked random-code step).
 * @param {number} [opts.retryIntervalMs] Override for the failed-write retry cadence — defaults to 15s in production; exposed mainly so tests don't have to wait 15 real seconds to observe a retry.
 */
export function createCloudSync({ supabaseClient, gameCode, retryIntervalMs = RETRY_INTERVAL_MS }) {
    let channel = null;
    let lastScoreSnapshot = null; // last broadcast score_update fields (sans ts), for diffing
    let lastTickFlushAt = 0; // shared throttle gate for clock_tick broadcast AND the games.data persist on ticks
    let lastPendingAttribution = null; // what the PREVIOUS onStateChange call saw in state.pendingAttribution, since ATTRIBUTE_SHOT clears it before we see newState
    let hasSentInitialSnapshot = false;
    let writeQueue = [];
    let retryTimer = null;

    function connect() {
        if (channel) return;
        channel = supabaseClient.channel(`game:${gameCode}`);
        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') console.log(`[cloud-sync] channel game:${gameCode} subscribed`);
        });
    }

    function disconnect() {
        if (channel) {
            supabaseClient.removeChannel(channel);
            channel = null;
        }
        if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = null;
        }
    }

    function broadcast(event, payload) {
        if (!channel) return;
        channel.send({ type: 'broadcast', event, payload });
    }

    function ensureRetryTimer() {
        if (retryTimer) return;
        retryTimer = setInterval(async () => {
            if (writeQueue.length === 0) {
                clearInterval(retryTimer);
                retryTimer = null;
                return;
            }
            const remaining = [];
            for (const item of writeQueue) {
                try {
                    await item.doWrite();
                    console.log(`[cloud-sync] retry succeeded: ${item.description}`);
                } catch {
                    remaining.push(item);
                }
            }
            writeQueue = remaining;
        }, retryIntervalMs);
    }

    /** Never throws — failures are queued for retry, never crash the daemon or silently vanish. */
    async function writeWithRetry(description, doWrite) {
        try {
            await doWrite();
        } catch (err) {
            console.warn(`[cloud-sync] write failed, queued for retry: ${description} — ${err.message}`);
            writeQueue.push({ description, doWrite });
            ensureRetryTimer();
        }
    }

    async function insertRow(table, row) {
        const { error } = await supabaseClient.from(table).insert(row);
        if (error) throw new Error(error.message);
    }

    /**
     * shot_events.client_event_id has NO unique constraint backing it (see
     * file header) — a DB-level ON CONFLICT DO NOTHING isn't possible, and
     * adding the constraint is a schema migration out of this repo's scope.
     * This is the application-level guard instead: before inserting, check
     * whether a row with this game_code + client_event_id already exists,
     * and skip if so. It closes the real risk this module's own retry queue
     * creates (an insert whose request landed but whose response was lost
     * gets retried, which without this check would insert twice) — not as
     * strong as a DB constraint (a second daemon process racing the exact
     * same check-then-insert could still slip through), but this daemon is
     * single-process/single-court, so that race isn't a real exposure here.
     */
    async function insertShotEventIdempotent(row) {
        const { data: existing, error: selectError } = await supabaseClient
            .from('shot_events')
            .select('id')
            .eq('game_code', row.game_code)
            .eq('client_event_id', row.client_event_id)
            .maybeSingle();
        if (selectError) throw new Error(selectError.message);
        if (existing) {
            console.log(`[cloud-sync] shot_events already recorded (client_event_id=${row.client_event_id}) — skipping duplicate insert`);
            return;
        }
        const { error } = await supabaseClient.from('shot_events').insert(row);
        if (error) throw new Error(error.message);
    }

    function writeShotEvent({ team, points, playerId, x = null, y = null, zone = 'unlocated', attributes = [], made = true }, newState) {
        // Generated once per logical write, here — NOT inside the retry
        // closure — so every retry of THIS write reuses the same id and the
        // guard above actually recognizes it as "already tried this one",
        // rather than minting a fresh id (and defeating the guard) each retry.
        const clientEventId = crypto.randomUUID();
        const isFreeThrow = points === 1;
        // A free throw has no court location. The ecosystem's convention is
        // zone 'free_throw' with x/y NULL — NOT 'unlocated', which means
        // "a field goal whose location we failed to capture" and is a
        // meaningfully different row to every consumer. The website writes
        // it this way too (shotService normalizes FTs; migration 013
        // back-filled the historical rows it had been faking as mid_top).
        // Normalized here rather than at each call site so no caller can
        // reintroduce a located free throw.
        const location = isFreeThrow ? freeThrowLocation() : { x, y, zone };
        const row = {
            game_code: gameCode,
            player_id: playerId ?? null,
            team_side: team,
            x: location.x, y: location.y, zone: location.zone,
            made,
            points,
            shot_type: isFreeThrow ? 'free_throw' : 'field_goal',
            period: newState.clock.period,
            game_clock_sec: Math.ceil(newState.clock.gameMs / 1000),
            shot_clock_sec: Math.ceil(newState.clock.shotMs / 1000),
            attributes,
            input_method: 'live',
            client_event_id: clientEventId,
        };
        writeWithRetry(`shot_events ${team}+${points}`, () => insertShotEventIdempotent(row));
    }

    function writeGameAction({ team, actionType, playerId = null }, newState) {
        const row = {
            game_code: gameCode,
            player_id: playerId,
            team_side: team,
            action_type: actionType, // 'foul' | 'timeout' only — see file header
            period: newState.clock.period,
            game_clock_sec: Math.ceil(newState.clock.gameMs / 1000),
        };
        writeWithRetry(`game_actions ${actionType} ${team}`, () => insertRow('game_actions', row));
    }

    function persistGamesData(newState, action) {
        const fields = {
            hostId: 'THE-BOX-PI',
            sportId: 'basketball',
            status: action.type === ACTIONS.END_GAME ? 'completed' : 'live',
            gameType: 'local',
            data: buildGamesDataRow(newState),
            lastUpdate: Date.now(),
        };
        const write = action.type === ACTIONS.SETUP_GAME
            // First write for this code — a real INSERT so createdAt is set once.
            ? () => insertRow('games', { code: gameCode, createdAt: Date.now(), ...fields })
            // Every later write is an UPDATE, not an upsert — deliberately, so
            // it never has the chance to clobber createdAt on conflict.
            : async () => {
                  const { error } = await supabaseClient.from('games').update(fields).eq('code', gameCode);
                  if (error) throw new Error(error.message);
              };
        writeWithRetry(`games.data (${action.type})`, write);
    }

    /**
     * @param {Object} newState Task 2's state shape, after reduce() applied `action`.
     * @param {{type:string, payload?:Object}} action The action that produced newState.
     */
    function onStateChange(newState, action) {
        if (!hasSentInitialSnapshot) {
            broadcast(CLOUD_EVENTS.GAME_SNAPSHOT, buildGameSnapshotPayload(newState));
            hasSentInitialSnapshot = true;
        }

        // score_update — diffed, so a FOUL/TIMEOUT/SCORE/PERIOD_ADVANCE/UNDO
        // that actually changed score/fouls/timeouts/possession/period
        // broadcasts, and nothing else does.
        const scorePayload = buildScoreUpdatePayload(newState);
        const { ts: _ts, ...scoreCompare } = scorePayload;
        if (!lastScoreSnapshot || !shallowEqual(scoreCompare, lastScoreSnapshot)) {
            broadcast(CLOUD_EVENTS.SCORE_UPDATE, scorePayload);
            lastScoreSnapshot = scoreCompare;
        }

        // Set true only when a CLOCK_TICK actually clears the throttle below —
        // drives whether this call also persists games.data (see the bottom
        // of this function). An explicit flag instead of re-comparing
        // Date.now() against lastTickFlushAt a second time, which would be a
        // second, easy-to-get-wrong throttle check duplicating the first.
        let tickWasFlushed = false;

        // Discrete clock-transition events — always immediate, never
        // throttled (they're rare state changes by nature, not a 10Hz feed).
        switch (action.type) {
            case ACTIONS.CLOCK_START:
                broadcast(CLOUD_EVENTS.CLOCK_START, buildClockTickPayload(newState));
                lastTickFlushAt = Date.now();
                break;
            case ACTIONS.CLOCK_STOP:
                broadcast(CLOUD_EVENTS.CLOCK_STOP, buildClockTickPayload(newState));
                lastTickFlushAt = Date.now();
                break;
            case ACTIONS.PERIOD_ADVANCE:
                broadcast(CLOUD_EVENTS.PERIOD_CHANGE, buildClockTickPayload(newState));
                lastTickFlushAt = Date.now();
                break;
            case ACTIONS.SHOT_CLOCK_RESET:
                broadcast(CLOUD_EVENTS.SHOTCLOCK_RESET, buildShotclockResetPayload(newState));
                break;
            case ACTIONS.CLOCK_TICK:
                // The ONLY action type allowed to trigger clock_tick, and only
                // at ~1/sec regardless of how often internal ticks arrive.
                if (Date.now() - lastTickFlushAt >= CLOCK_BROADCAST_THROTTLE_MS) {
                    broadcast(CLOUD_EVENTS.CLOCK_TICK, buildClockTickPayload(newState));
                    lastTickFlushAt = Date.now();
                    tickWasFlushed = true;
                }
                break;
            case ACTIONS.FOUL:
                writeGameAction({ team: action.payload.team, actionType: 'foul', playerId: action.payload.playerId }, newState);
                break;
            case ACTIONS.TIMEOUT:
                // A rejected TIMEOUT (no timeouts left) leaves lastError set and
                // nothing actually happened — don't log a timeout that wasn't taken.
                if (!newState.lastError) {
                    writeGameAction({ team: action.payload.team, actionType: 'timeout' }, newState);
                }
                break;
            case ACTIONS.SCORE:
                // Only when this SCORE already carries a playerId — otherwise
                // it set pendingAttribution and the shot_events row is written
                // when the follow-up ATTRIBUTE_SHOT resolves it (see below).
                // x/y/zone/attributes are optional extras Task 2's SCORE payload
                // doesn't formally define — read here if a future touchscreen
                // flow attaches them, defaulting to unlocated otherwise.
                if (newState.meta.gameMode !== 'quick' && action.payload.playerId) {
                    writeShotEvent({
                        team: action.payload.team, points: action.payload.points, playerId: action.payload.playerId,
                        x: action.payload.x ?? null, y: action.payload.y ?? null, zone: action.payload.zone ?? 'unlocated',
                        attributes: action.payload.attributes ?? [],
                    }, newState);
                }
                break;
            case ACTIONS.SHOT_MISS:
                // Nothing is written here. A miss carries no points of its own
                // (its location decides the attempt value), so there is nothing
                // to persist until ATTRIBUTE_SHOT arrives with the tap. A
                // rejected SHOT_MISS (quick mode) leaves lastError set and
                // never reaches that follow-up at all.
                break;
            case ACTIONS.ATTRIBUTE_SHOT:
                if (newState.meta.gameMode !== 'quick' && lastPendingAttribution) {
                    const made = lastPendingAttribution.made !== false;
                    const zone = action.payload.zone ?? 'unlocated';
                    // A make already knows its value — the physical button
                    // reported it. A miss doesn't: resolve the attempt value
                    // from where the shot was taken, preferring the value the
                    // capture UI resolved (it saw the exact tap) and falling
                    // back to the zone's own value if it sent none. An
                    // unlocated miss can only be assumed a 2.
                    const points = lastPendingAttribution.points
                        ?? action.payload.points
                        ?? zonePointValue(zone);
                    writeShotEvent({
                        team: lastPendingAttribution.team, points, made, playerId: action.payload.playerId,
                        x: action.payload.x ?? null, y: action.payload.y ?? null, zone,
                        attributes: action.payload.attributes ?? [],
                    }, newState);
                }
                break;
        }
        lastPendingAttribution = newState.pendingAttribution;

        // games.data persist — immediate for every meaningful action, throttled
        // to ~1/sec (piggybacking the same gate as clock_tick) on raw ticks so
        // it stays reasonably fresh for the resume-on-boot cloud fallback
        // without hammering the table at the internal tick rate.
        if (action.type !== ACTIONS.CLOCK_TICK || tickWasFlushed) {
            persistGamesData(newState, action);
        }
    }

    return { onStateChange, connect, disconnect };
}

/**
 * Reads the current `games` row for a code — the read-side counterpart to
 * persistGamesData's writes, used by daemon/resume.js for the cloud-fallback
 * boot-recovery path (Part B). A standalone function rather than part of
 * createCloudSync's returned object: fetching doesn't need any of that
 * factory's stateful diffing/retry-queue machinery, and resume needs it
 * before a game (and therefore a gameCode-bound createCloudSync instance)
 * necessarily exists yet.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {string} gameCode
 * @returns {Promise<{code:string, status:string, data:Object}|null>}
 */
export async function fetchGameRow(supabaseClient, gameCode) {
    const { data, error } = await supabaseClient.from('games').select('code, status, data').eq('code', gameCode).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
}
