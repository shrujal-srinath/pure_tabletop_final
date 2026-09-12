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
//      jumpball/foul_drawn. Of state-engine's own action types, only FOUL
//      and TIMEOUT map onto a real value in that vocabulary — writing
//      'SETUP_GAME', 'CLOCK_START', 'UNDO', etc. into this shared,
//      cross-app-read column would inject garbage into every game's
//      play-by-play. So this module writes game_actions rows for FOUL and
//      TIMEOUT only, not "every action" literally. (rebound/steal/
//      turnover/block/assist/substitution aren't modeled by state-engine
//      yet at all — a real gap, not silently papered over here.)
//   2. shot_events.client_event_id exists but has NO unique constraint
//      backing it (checked pg_constraint directly) — so it cannot provide
//      real dedup/idempotency yet. This module does NOT populate it or
//      pretend retries are exactly-once: a retried write after an
//      ambiguous network failure (request landed, response lost) could in
//      rare cases produce a duplicate row. Fixing that for real needs a
//      migration adding a unique constraint on client_event_id plus using
//      it here — out of this task's scope, flagged rather than faked.
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
 */
export function createCloudSync({ supabaseClient, gameCode }) {
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
        }, RETRY_INTERVAL_MS);
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

    function writeShotEvent({ team, points, playerId, x = null, y = null, zone = 'unlocated', attributes = [] }, newState) {
        const row = {
            game_code: gameCode,
            player_id: playerId ?? null,
            team_side: team,
            x, y, zone,
            made: true, // state-engine only models made shots today — no miss action exists yet, a known continued gap
            points,
            shot_type: points === 1 ? 'free_throw' : 'field_goal',
            period: newState.clock.period,
            game_clock_sec: Math.ceil(newState.clock.gameMs / 1000),
            shot_clock_sec: Math.ceil(newState.clock.shotMs / 1000),
            attributes,
            input_method: 'live',
        };
        writeWithRetry(`shot_events ${team}+${points}`, () => insertRow('shot_events', row));
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
            case ACTIONS.ATTRIBUTE_SHOT:
                if (newState.meta.gameMode !== 'quick' && lastPendingAttribution) {
                    writeShotEvent({
                        team: lastPendingAttribution.team, points: lastPendingAttribution.points, playerId: action.payload.playerId,
                        x: action.payload.x ?? null, y: action.payload.y ?? null, zone: action.payload.zone ?? 'unlocated',
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
