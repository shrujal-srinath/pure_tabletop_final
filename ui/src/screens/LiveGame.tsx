// box-pi/ui/src/screens/LiveGame.tsx
//
// The main screen, shown throughout an actual game. Holds NO independent
// game logic — everything rendered comes from the daemon's state_update
// broadcasts; every operator action is sent back as a LAN event and the
// daemon's own dispatch()/reduce() is the only place that decides what
// actually happens.
//
// Design notes worth keeping in mind when touching this file:
//
// - Payload-bloat cleanup closed: daemon/index.js's broadcasts used to
//   carry state-engine.js's internal `_previousState` UNDO snapshot on
//   every single state_update, including every 100ms CLOCK_TICK while the
//   clock runs — roughly doubling payload size for no reason this screen
//   (or any client) ever needed. Flagged here originally; fixed via a
//   toPublicState() helper at every daemon-side broadcast site. See
//   daemonTypes.ts's own comment for the full story.
//
// - Score always renders straight from `state.teamA/teamB.score` with no
//   gating — the attribution popup and court-tap flow are overlays on TOP
//   of an already-updated scoreboard, never blockers in front of it.
// - Touch-lock is enforced by ONE full-screen overlay near the end of the
//   render tree (z-index above everything), not per-button `disabled`
//   checks — so a button added later can't accidentally skip the lock.
// - Timeout on the attribution popup sends nothing to the daemon. Verified
//   against the real reducer (shared/state-engine.js): nothing auto-clears
//   `pendingAttribution` on a timer — it just sits there until an
//   ATTRIBUTE_SHOT resolves it, or the NEXT non-quick-mode SCORE silently
//   overwrites it (state-engine.js's SCORE case always replaces
//   pendingAttribution when a new one is needed — a pre-existing reducer
//   behavior, not something this screen introduces or works around).
//   Dismissing the popup after 8s is therefore a purely local UI concern.
// - Shot location (advanced mode) is ShotCapture's job, not this screen's.
//   The placeholder green-rectangle "near/far basket" tap surface that used
//   to live here is gone: box-pi now carries the ecosystem's real court law
//   in shared/court-geometry.js (a verified mirror of the website's
//   courtZones.ts), so the capture surface is a true FIBA full court and
//   every coordinate decision goes through resolveTap(). See ShotCapture.tsx
//   for why it works the way it does.
// - The team credited for a score is ALREADY fixed the instant the physical
//   button was pressed (pendingAttribution.team), and cloud-sync.js persists
//   the shot under that team regardless of what this screen sends. The
//   capture flow therefore never offers the other team's roster — that would
//   silently create a team/player mismatch in shot_events.
// - MISS has no physical button (the Pico has no such key), so it is
//   initiated here. Unlike a score it opens the capture prompt locally, since
//   the daemon only emits SCORE_PENDING for an actual SCORE — see recordMiss.

import { useEffect, useState, type CSSProperties } from 'react';
import { socket, LAN_EVENTS } from '../lib/socket';
import { ACTIONS, isBonus, isFouledOut } from '../../../shared/state-engine.js';
import type { DaemonState, Player, ScorePendingPayload, TouchLockStatusPayload, Team } from '../lib/daemonTypes';
import { ScoreDisplay } from '../components/ScoreDisplay';
import { ClockDisplay } from '../components/ClockDisplay';
import { Overlay } from '../components/Overlay';
import { ShotCapture } from '../components/ShotCapture';
import { Settings } from './Settings';

const ATTRIBUTION_TIMEOUT_MS = 8000;

function useCountdown(resetKey: unknown, totalMs: number): number {
    const [secondsLeft, setSecondsLeft] = useState(Math.ceil(totalMs / 1000));
    useEffect(() => {
        const start = Date.now();
        setSecondsLeft(Math.ceil(totalMs / 1000));
        const id = window.setInterval(() => {
            setSecondsLeft(Math.max(0, Math.ceil((totalMs - (Date.now() - start)) / 1000)));
        }, 200);
        return () => window.clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey]);
    return secondsLeft;
}

export function LiveGame({ initialState = null }: { initialState?: DaemonState | null }) {
    // Starting from `initialState` (App.tsx already has the current state
    // by the time it decides to mount LiveGame — see App.tsx's central
    // state_update subscription) rather than always null matters: the
    // daemon only pushes a fresh state_update on a NEW socket connection or
    // an actual state change, not on request, and this component reuses
    // the app-wide already-connected `socket` singleton rather than opening
    // its own connection. Without this, LiveGame could sit on "waiting for
    // state" indefinitely after mounting with nothing to trigger a new
    // broadcast — a real gap only surfaced by Task 6f's resume flow
    // (Dashboard -> LiveGame with no intervening score/foul/etc. to mask
    // it), not by earlier tasks, which always exercised a subsequent action
    // first.
    const [state, setState] = useState<DaemonState | null>(initialState);
    const [touchUnlocked, setTouchUnlocked] = useState(false);
    const [pending, setPending] = useState<ScorePendingPayload | null>(null);
    const [foulPickerTeam, setFoulPickerTeam] = useState<'A' | 'B' | null>(null);
    const [showSettings, setShowSettings] = useState(false);

    useEffect(() => {
        let dismissTimer: number | null = null;

        function onState(s: DaemonState) {
            setState(s);
        }
        function onTouchLock(p: TouchLockStatusPayload) {
            setTouchUnlocked(p.unlocked);
        }
        function onScorePending(p: ScorePendingPayload) {
            setPending(p);
            if (dismissTimer) window.clearTimeout(dismissTimer);
            dismissTimer = window.setTimeout(() => setPending(null), ATTRIBUTION_TIMEOUT_MS);
        }

        socket.on(LAN_EVENTS.STATE_UPDATE, onState);
        socket.on(LAN_EVENTS.TOUCH_LOCK_STATUS, onTouchLock);
        socket.on(LAN_EVENTS.SCORE_PENDING, onScorePending);
        return () => {
            socket.off(LAN_EVENTS.STATE_UPDATE, onState);
            socket.off(LAN_EVENTS.TOUCH_LOCK_STATUS, onTouchLock);
            socket.off(LAN_EVENTS.SCORE_PENDING, onScorePending);
            if (dismissTimer) window.clearTimeout(dismissTimer);
        };
    }, []);

    function sendAction(type: string, payload?: object) {
        socket.emit(LAN_EVENTS.UI_ACTION, { type, payload });
    }

    function confirmAttribution(playerId: string | undefined, extra?: { x: number; y: number; zone: string }) {
        sendAction(ACTIONS.ATTRIBUTE_SHOT, { playerId, ...(extra ?? {}) });
        setPending(null);
    }

    // A miss produces no score, so the daemon has no reason to emit
    // SCORE_PENDING for it the way a physical score button does — that event
    // is gated on ACTIONS.SCORE. The capture prompt is therefore opened
    // locally, and the daemon's own SHOT_MISS keeps the reducer's
    // pendingAttribution in step so the follow-up ATTRIBUTE_SHOT resolves
    // against a miss (made:false) rather than being rejected as unsolicited.
    function recordMiss(team: 'A' | 'B') {
        const ts = Date.now();
        sendAction(ACTIONS.SHOT_MISS, { team, ts });
        setPending({ team, points: null, made: false, ts });
    }

    if (!state) {
        return <div style={{ padding: 24, color: '#fff', background: '#0a0a0a', minHeight: '100vh' }}>LIVE GAME — waiting for state…</div>;
    }

    const { teamA, teamB, clock, possession, meta } = state;

    return (
        <div style={{ position: 'relative', minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'sans-serif' }}>
            <div data-testid="scoreboard" style={{ display: 'flex', justifyContent: 'space-around', padding: 24 }}>
                <ScoreDisplay team={teamA} hasBall={possession === 'A'} bonus={isBonus(state, 'A')} />
                <ClockDisplay clock={clock} gameMode={meta.gameMode} />
                <ScoreDisplay team={teamB} hasBall={possession === 'B'} bonus={isBonus(state, 'B')} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '0 24px 24px' }}>
                <TeamControls
                    team={teamA}
                    canMiss={meta.gameMode !== 'quick'}
                    onFoul={() => setFoulPickerTeam('A')}
                    onTimeout={() => sendAction(ACTIONS.TIMEOUT, { team: 'A' })}
                    onMiss={() => recordMiss('A')}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => sendAction(ACTIONS.UNDO)} style={undoButtonStyle} title="Single-level undo — reverts only the last ref action, no further history">
                        ↺ UNDO LAST ACTION
                    </button>
                    {/* No extra gating needed here beyond this button existing at
                        all — the touch-lock overlay below already sits above
                        everything in z-order and blocks clicks while locked,
                        exactly the same as it already does for FOUL/TIMEOUT/UNDO. */}
                    <button onClick={() => setShowSettings(true)} style={undoButtonStyle}>
                        ⚙ SETTINGS
                    </button>
                </div>
                <TeamControls
                    team={teamB}
                    canMiss={meta.gameMode !== 'quick'}
                    onFoul={() => setFoulPickerTeam('B')}
                    onTimeout={() => sendAction(ACTIONS.TIMEOUT, { team: 'B' })}
                    onMiss={() => recordMiss('B')}
                />
            </div>

            {foulPickerTeam && (
                <PlayerPickerOverlay
                    title={`FOUL — ${(foulPickerTeam === 'A' ? teamA : teamB).name}`}
                    players={(foulPickerTeam === 'A' ? teamA : teamB).players}
                    allowNoPlayer={meta.gameMode === 'quick'}
                    onPick={(playerId) => {
                        sendAction(ACTIONS.FOUL, { team: foulPickerTeam, playerId });
                        setFoulPickerTeam(null);
                    }}
                    onCancel={() => setFoulPickerTeam(null)}
                />
            )}

            {pending && meta.gameMode === 'stats' && (
                <AttributionPopup pending={pending} team={pending.team === 'A' ? teamA : teamB} onPick={(id) => confirmAttribution(id)} />
            )}
            {pending && meta.gameMode === 'advanced' && (
                <ShotCapture
                    // Remounted per pending shot so a second score arriving
                    // mid-flow starts a clean capture rather than inheriting
                    // the previous one's half-finished location.
                    key={pending.ts}
                    pending={pending}
                    team={pending.team === 'A' ? teamA : teamB}
                    onCommit={(shot) => {
                        sendAction(ACTIONS.ATTRIBUTE_SHOT, {
                            playerId: shot.playerId, x: shot.x, y: shot.y, zone: shot.zone, points: shot.points,
                        });
                        setPending(null);
                    }}
                    // The shot is never discarded just because its location
                    // wasn't captured — it lands as `unlocated`, which is a
                    // real, reportable value, not a dropped row.
                    onSkipLocation={() => {
                        sendAction(ACTIONS.ATTRIBUTE_SHOT, { zone: 'unlocated' });
                        setPending(null);
                    }}
                    onCancel={() => setPending(null)}
                />
            )}

            {/* Opening/closing this has no side effects on its own — it only
                ever sends anything to the daemon if the operator explicitly
                confirms End Game inside it. */}
            {showSettings && <Settings onClose={() => setShowSettings(false)} />}

            {/* Touch-lock guard — the ONLY gate. One overlay above every other
                element in the tree, not a per-button disabled check, so a
                control added later can't accidentally bypass it. */}
            {!touchUnlocked && (
                <>
                    <div data-testid="touch-lock-overlay" style={{ position: 'fixed', inset: 0, zIndex: 9999 }} />
                    <div style={{ position: 'fixed', top: 8, right: 8, zIndex: 10000, background: '#7a1a1a', color: '#fff', padding: '4px 10px', fontSize: 12, borderRadius: 4 }}>
                        🔒 LOCKED — physical settings switch to unlock
                    </div>
                </>
            )}
        </div>
    );
}

// ── Presentational pieces ────────────────────────────────────────────

function TeamControls({ team, canMiss, onFoul, onTimeout, onMiss }: {
    team: Team;
    canMiss: boolean;
    onFoul: () => void;
    onTimeout: () => void;
    onMiss: () => void;
}) {
    const timeoutsLeft = team.timeouts > 0;
    return (
        <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onFoul} style={buttonStyle}>
                FOUL
            </button>
            {/* Misses have no physical button — there is nothing on the Pico
                for "a shot that didn't go in" — so this is the only way FG%
                and shot quality become computable at all. Hidden in quick
                mode, which records no play-by-play for it to land in. */}
            {canMiss && (
                <button data-testid={`miss-${team.name}`} onClick={onMiss} style={missButtonStyle}>
                    MISS
                </button>
            )}
            <button
                onClick={onTimeout}
                disabled={!timeoutsLeft}
                style={{ ...buttonStyle, opacity: timeoutsLeft ? 1 : 0.35, cursor: timeoutsLeft ? 'pointer' : 'not-allowed' }}
                title={timeoutsLeft ? undefined : 'No timeouts remaining in this bracket'}
            >
                TIMEOUT{!timeoutsLeft ? ' (none left)' : ''}
            </button>
        </div>
    );
}

function PlayerPickerOverlay({
    title, players, allowNoPlayer, onPick, onCancel,
}: {
    title: string;
    players: Player[];
    allowNoPlayer: boolean;
    onPick: (playerId?: string) => void;
    onCancel: () => void;
}) {
    return (
        <Overlay>
            <h2 style={modalHeadingStyle}>{title}</h2>
            <PlayerList players={players} onPick={onPick} />
            {allowNoPlayer && (
                <button onClick={() => onPick(undefined)} style={{ ...buttonStyle, marginTop: 8 }}>
                    No player (team only)
                </button>
            )}
            <button onClick={onCancel} style={{ ...buttonStyle, marginTop: 8, opacity: 0.7 }}>
                Cancel
            </button>
        </Overlay>
    );
}

function AttributionPopup({ pending, team, onPick }: { pending: ScorePendingPayload; team: Team; onPick: (playerId: string) => void }) {
    const secondsLeft = useCountdown(pending.ts, ATTRIBUTION_TIMEOUT_MS);
    return (
        <Overlay>
            <h2 style={modalHeadingStyle}>
                {team.name} +{pending.points} — who scored?
            </h2>
            <div style={countdownStyle}>closing in {secondsLeft}s — unattributed if ignored</div>
            <PlayerList players={team.players} onPick={(id) => id && onPick(id)} />
        </Overlay>
    );
}


function PlayerList({ players, onPick }: { players: Player[]; onPick: (playerId?: string) => void }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
            {players.map((p) => {
                const disabled = isFouledOut(p);
                return (
                    <button
                        key={p.id}
                        disabled={disabled}
                        onClick={() => !disabled && onPick(p.id)}
                        style={{ ...buttonStyle, opacity: disabled ? 0.3 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
                        title={disabled ? 'Fouled out' : undefined}
                    >
                        #{p.number} {p.name}
                        {disabled ? ' (FOULED OUT)' : ''}
                    </button>
                );
            })}
        </div>
    );
}

// ── Styles ────────────────────────────────────────────────────────────

const buttonStyle: CSSProperties = {
    padding: '10px 16px',
    fontSize: 14,
    background: '#222',
    color: '#fff',
    border: '1px solid #555',
    borderRadius: 6,
};

const missButtonStyle: CSSProperties = {
    ...buttonStyle,
    border: '1px solid #7a1a1a',
    background: '#2a1010',
};

const undoButtonStyle: CSSProperties = {
    ...buttonStyle,
    alignSelf: 'center',
    opacity: 0.8,
};

const modalHeadingStyle: CSSProperties = { marginTop: 0 };

const countdownStyle: CSSProperties = { fontSize: 13, opacity: 0.7, marginBottom: 14, fontFamily: 'monospace' };

