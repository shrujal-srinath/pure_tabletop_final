// box-pi/ui/src/screens/Dashboard.tsx
//
// The actual landing screen — shown once the daemon's first state_update
// has arrived and this session hasn't (yet) confirmed entering LiveGame.
// Receives `state`/`connected` as props from App.tsx (the single socket
// subscription already lives there, same as PostGame) rather than opening
// a second one here.
//
// Two branches, both driven by the same `state` prop:
//   - state.meta.gameActive already true -> the daemon resumed an active
//     game on boot, before this session did anything (Task 5/6a's boot
//     resume logic). Surfaced as an explicit "resume?" banner, not a
//     silent auto-jump into LiveGame — see App.tsx's `confirmedLive` gate
//     for why that distinction matters and how it's enforced.
//   - otherwise -> the normal start flow, one button into Match Setup.

import type { CSSProperties } from 'react';
import type { DaemonState } from '../lib/daemonTypes';

export function Dashboard({
    connected, state, onStartMatch, onResumeGame,
}: {
    connected: boolean;
    state: DaemonState;
    onStartMatch: () => void;
    onResumeGame: () => void;
}) {
    return (
        <div style={pageStyle}>
            <h1 style={{ marginTop: 0 }}>THE BOX</h1>
            <div data-testid="connection-status" style={{ ...statusStyle, color: connected ? '#4ade80' : '#ff6b6b' }}>
                ● daemon {connected ? 'connected' : 'disconnected'}
            </div>

            {state.meta.gameActive ? (
                <div data-testid="resume-banner" style={resumeCardStyle}>
                    <p style={{ margin: '0 0 4px', fontSize: 13, opacity: 0.7 }}>Resume game in progress</p>
                    <h2 style={{ margin: '0 0 16px' }}>
                        {state.teamA.name} vs {state.teamB.name}, Q{state.clock.period}
                    </h2>
                    <button onClick={onResumeGame} style={primaryButtonStyle}>
                        Resume Live Game →
                    </button>
                </div>
            ) : (
                <div style={{ marginTop: 24 }}>
                    <button onClick={onStartMatch} style={primaryButtonStyle}>
                        Start New Game →
                    </button>
                </div>
            )}
        </div>
    );
}

const pageStyle: CSSProperties = { padding: 24, color: '#fff', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'sans-serif' };
const statusStyle: CSSProperties = { fontSize: 13, marginBottom: 24 };
const resumeCardStyle: CSSProperties = { background: '#161616', border: '1px solid #444', borderRadius: 10, padding: 24, maxWidth: 420, marginTop: 24 };
const primaryButtonStyle: CSSProperties = { padding: '12px 20px', fontSize: 15, background: '#222', color: '#fff', border: '1px solid #555', borderRadius: 6, cursor: 'pointer' };
