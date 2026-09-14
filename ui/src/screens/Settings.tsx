// box-pi/ui/src/screens/Settings.tsx
//
// Rendered by LiveGame as an overlay (not a separate route) — reachable
// only when touch is unlocked, which it gets "for free" from LiveGame's
// existing architecture: the touch-lock overlay already sits above every
// element in the tree and blocks clicks while locked, the same as it
// already does for FOUL/TIMEOUT/UNDO. No separate gating needed here.
//
// Deliberately minimal. Considered a manual period-advance override for
// edge cases the physical buttons don't cover, but nothing in this
// project has actually asked for that — left out rather than guessed at,
// per this task's own instruction. If a real need for extra mid-game
// corrections shows up, add them here later.

import { useState } from 'react';
import { socket, LAN_EVENTS } from '../lib/socket';
import { ACTIONS } from '../../../shared/state-engine.js';
import { Overlay } from '../components/Overlay';

export function Settings({ onClose }: { onClose: () => void }) {
    const [confirmingEnd, setConfirmingEnd] = useState(false);

    function endGame() {
        socket.emit(LAN_EVENTS.UI_ACTION, { type: ACTIONS.END_GAME });
        // No local cleanup needed — App.tsx's GAME_ENDED listener takes
        // over and routes to PostGame, unmounting this (and LiveGame)
        // entirely once the daemon confirms.
    }

    return (
        <Overlay>
            <h2 style={{ marginTop: 0 }}>SETTINGS</h2>

            {!confirmingEnd ? (
                <button onClick={() => setConfirmingEnd(true)} style={dangerButtonStyle}>
                    End Game
                </button>
            ) : (
                <div>
                    <p style={{ fontSize: 13, maxWidth: 260 }}>End the game now? This can't be undone.</p>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                        <button onClick={endGame} style={dangerButtonStyle}>
                            Yes, end game
                        </button>
                        <button onClick={() => setConfirmingEnd(false)} style={buttonStyle}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <div style={{ marginTop: 16 }}>
                <button onClick={onClose} style={{ ...buttonStyle, opacity: 0.7 }}>
                    Close
                </button>
            </div>
        </Overlay>
    );
}

const buttonStyle = {
    padding: '10px 16px',
    fontSize: 14,
    background: '#222',
    color: '#fff',
    border: '1px solid #555',
    borderRadius: 6,
} as const;

const dangerButtonStyle = {
    ...buttonStyle,
    border: '1px solid #7a1a1a',
    background: '#3a1414',
} as const;
