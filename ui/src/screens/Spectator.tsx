// box-pi/ui/src/screens/Spectator.tsx
//
// The second display — what the arena/audience sees. Fully read-only: no
// attribution popup, no court-tap, no undo, no settings, no touch-lock
// awareness (there's nothing tappable here to lock). Same state_update
// feed as LiveGame, via the same socket module — not a separate
// subscription, not a poll, so the two screens can never show different
// values for longer than one network round-trip apart.
//
// Reuses ScoreDisplay/ClockDisplay from LiveGame rather than duplicating
// their JSX — if the visual language for score/clock changes, both
// screens pick it up from one place.

import { useEffect, useState } from 'react';
import { socket, LAN_EVENTS } from '../lib/socket';
import { isBonus } from '../../../shared/state-engine.js';
import type { DaemonState } from '../lib/daemonTypes';
import { ScoreDisplay } from '../components/ScoreDisplay';
import { ClockDisplay } from '../components/ClockDisplay';

export function Spectator() {
    const [state, setState] = useState<DaemonState | null>(null);

    useEffect(() => {
        function onState(s: DaemonState) {
            setState(s);
        }
        socket.on(LAN_EVENTS.STATE_UPDATE, onState);
        return () => {
            socket.off(LAN_EVENTS.STATE_UPDATE, onState);
        };
    }, []);

    if (!state) {
        return <div style={{ padding: 24, color: '#fff', background: '#0a0a0a', minHeight: '100vh' }}>SPECTATOR — waiting for state…</div>;
    }

    const { teamA, teamB, clock, possession, meta } = state;

    return (
        <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'sans-serif' }}>
            <div data-testid="scoreboard" style={{ display: 'flex', justifyContent: 'space-around', padding: 24 }}>
                <ScoreDisplay team={teamA} hasBall={possession === 'A'} bonus={isBonus(state, 'A')} />
                <ClockDisplay clock={clock} gameMode={meta.gameMode} />
                <ScoreDisplay team={teamB} hasBall={possession === 'B'} bonus={isBonus(state, 'B')} />
            </div>
            {/* Deliberately nothing else — no buttons, no overlays, no
                touch-lock banner. lastError is intentionally never read or
                shown here; it's operator-only, internal-error information a
                spectator has no use for. */}
        </div>
    );
}
