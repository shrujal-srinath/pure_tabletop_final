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
// - FLAGGED, NOT FIXED HERE (daemon-side, out of this task's scope):
//   daemon/index.js's dispatch() broadcasts its internal state object as-is
//   (`io.emit(STATE_UPDATE, currentState)`), which still carries
//   `_previousState` — a full nested undo snapshot — on every single
//   broadcast, including every 100ms CLOCK_TICK while the clock runs. That
//   roughly doubles payload size for no reason the UI needs (see
//   daemonTypes.ts). This screen just ignores the field; the actual fix
//   (strip it before broadcasting) belongs in a Task 6a follow-up.
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
// - Court-tap "team confirmation": the team credited for the score is
//   ALREADY fixed the instant the physical button was pressed
//   (pendingAttribution.team) — ATTRIBUTE_SHOT only ever takes a playerId,
//   and cloud-sync.js persists the shot under the ORIGINAL scoring team
//   regardless of what the UI sends. So the confirm-before-commit step here
//   is scoped to what's actually still undecided at tap time: which
//   basket/orientation the tap represents (for x/y storage), and which
//   player on the (fixed) scoring team gets credit. It deliberately does
//   NOT let the operator re-pick a different team's roster — that would
//   silently create a team/player mismatch in shot_events, a worse bug
//   than the one this task is fixing. Full courtZones.ts-accurate zone/arc
//   geometry isn't ported into box-pi yet; the tap surface here is a
//   placeholder good enough to prove the confirm-before-commit flow.

import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { socket, LAN_EVENTS } from '../lib/socket';
import { ACTIONS, isBonus, isFouledOut } from '../../../shared/state-engine.js';
import type { DaemonState, Player, ScorePendingPayload, TouchLockStatusPayload, Team } from '../lib/daemonTypes';
import { ScoreDisplay } from '../components/ScoreDisplay';
import { ClockDisplay } from '../components/ClockDisplay';
import { Overlay } from '../components/Overlay';
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

export function LiveGame() {
    const [state, setState] = useState<DaemonState | null>(null);
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
                <TeamControls team={teamA} onFoul={() => setFoulPickerTeam('A')} onTimeout={() => sendAction(ACTIONS.TIMEOUT, { team: 'A' })} />
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
                <TeamControls team={teamB} onFoul={() => setFoulPickerTeam('B')} onTimeout={() => sendAction(ACTIONS.TIMEOUT, { team: 'B' })} />
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
                <CourtTapFlow pending={pending} team={pending.team === 'A' ? teamA : teamB} onConfirm={confirmAttribution} />
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

function TeamControls({ team, onFoul, onTimeout }: { team: Team; onFoul: () => void; onTimeout: () => void }) {
    const timeoutsLeft = team.timeouts > 0;
    return (
        <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onFoul} style={buttonStyle}>
                FOUL
            </button>
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

function CourtTapFlow({
    pending, team, onConfirm,
}: {
    pending: ScorePendingPayload;
    team: Team;
    onConfirm: (playerId: string | undefined, extra: { x: number; y: number; zone: string }) => void;
}) {
    const secondsLeft = useCountdown(pending.ts, ATTRIBUTION_TIMEOUT_MS);
    const [tapFrac, setTapFrac] = useState<{ x: number; y: number } | null>(null);
    const [mirrored, setMirrored] = useState(false);

    function handleCourtClick(e: MouseEvent<HTMLDivElement>) {
        const rect = e.currentTarget.getBoundingClientRect();
        const xFrac = (e.clientX - rect.left) / rect.width;
        const yFrac = (e.clientY - rect.top) / rect.height;
        setTapFrac({ x: xFrac, y: yFrac });
        // Pre-set guess from tap side — operator can flip it below before
        // anything commits. This is THE fix for the old build's bug: no
        // guess ever reaches the daemon without an explicit confirm step.
        setMirrored(xFrac >= 0.5);
    }

    if (!tapFrac) {
        return (
            <Overlay>
                <h2 style={modalHeadingStyle}>
                    {team.name} +{pending.points} — tap the shot location
                </h2>
                <div style={countdownStyle}>closing in {secondsLeft}s — unattributed if ignored</div>
                <div data-testid="court-tap-surface" onClick={handleCourtClick} style={courtSurfaceStyle}>
                    <div style={{ ...halfLabelStyle, left: 0 }}>NEAR BASKET</div>
                    <div style={{ ...halfLabelStyle, right: 0 }}>FAR BASKET</div>
                </div>
                <p style={{ fontSize: 11, opacity: 0.5, maxWidth: 320 }}>
                    Placeholder court surface — real zone/arc geometry is separate, later work. This proves the
                    confirm-before-commit flow.
                </p>
            </Overlay>
        );
    }

    const x = Math.round((mirrored ? 1 - tapFrac.x : tapFrac.x) * 100);
    const y = Math.round(tapFrac.y * 94);

    return (
        <Overlay>
            <h2 style={modalHeadingStyle}>Confirm shot side</h2>
            <p style={{ fontSize: 13, maxWidth: 320 }}>
                Tap implies the <strong>{mirrored ? 'far' : 'near'}</strong> basket — flip if that's wrong.{' '}
                {team.name} is already credited with the score; nothing else is sent until you pick a player.
            </p>
            <button data-testid="flip-side-button" onClick={() => setMirrored((m) => !m)} style={{ ...buttonStyle, marginBottom: 12 }}>
                Flip side (currently: {mirrored ? 'far' : 'near'} basket)
            </button>
            <PlayerList players={team.players} onPick={(id) => id && onConfirm(id, { x, y, zone: 'unlocated' })} />
            <button onClick={() => setTapFrac(null)} style={{ ...buttonStyle, marginTop: 8, opacity: 0.7 }}>
                Retap
            </button>
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

const undoButtonStyle: CSSProperties = {
    ...buttonStyle,
    alignSelf: 'center',
    opacity: 0.8,
};

const modalHeadingStyle: CSSProperties = { marginTop: 0 };

const countdownStyle: CSSProperties = { fontSize: 13, opacity: 0.7, marginBottom: 14, fontFamily: 'monospace' };

const courtSurfaceStyle: CSSProperties = {
    width: 320,
    height: 280,
    background: '#173a17',
    border: '2px solid #fff',
    margin: '4px auto 12px',
    cursor: 'crosshair',
    position: 'relative',
};

const halfLabelStyle: CSSProperties = {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '50%',
    textAlign: 'center',
    opacity: 0.4,
    fontSize: 12,
};
