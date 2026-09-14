// box-pi/ui/src/screens/PostGame.tsx
//
// Shown after LAN_EVENTS.GAME_ENDED. Takes the final state as a prop
// (captured by App.tsx from the LAST state_update it saw before
// game_ended arrived) rather than subscribing to state_update itself —
// state-engine.js's END_GAME case only flips meta.gameActive to false and
// leaves score/fouls/clock untouched (verified directly, not assumed), so
// that captured snapshot IS the final result, not a guess.

import type { CSSProperties } from 'react';
import type { DaemonState } from '../lib/daemonTypes';
import { ScoreDisplay } from '../components/ScoreDisplay';
import { isBonus } from '../../../shared/state-engine.js';

export function PostGame({ finalState, onReturnToDashboard }: { finalState: DaemonState; onReturnToDashboard: () => void }) {
    const { teamA, teamB, clock } = finalState;
    const tie = teamA.score === teamB.score;
    const winner = tie ? null : teamA.score > teamB.score ? teamA : teamB;

    return (
        <div style={pageStyle}>
            <h1 style={{ marginTop: 0 }}>FINAL</h1>
            <p style={{ fontSize: 18, marginBottom: 24 }}>{tie ? 'Tie game' : `${winner!.name} wins`}</p>

            <div data-testid="final-scoreboard" style={{ display: 'flex', justifyContent: 'space-around', maxWidth: 600 }}>
                {/* possession is meaningless once the game has ended — never
                    show a "has the ball" indicator here */}
                <ScoreDisplay team={teamA} hasBall={false} bonus={isBonus(finalState, 'A')} />
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 13, opacity: 0.7 }}>FINAL — PERIOD {clock.period}</div>
                </div>
                <ScoreDisplay team={teamB} hasBall={false} bonus={isBonus(finalState, 'B')} />
            </div>

            <button onClick={onReturnToDashboard} style={buttonStyle}>
                Return to Dashboard
            </button>
        </div>
    );
}

const pageStyle: CSSProperties = { padding: 24, color: '#fff', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'sans-serif' };
const buttonStyle: CSSProperties = { marginTop: 32, padding: '10px 16px', fontSize: 14, background: '#222', color: '#fff', border: '1px solid #555', borderRadius: 6 };
