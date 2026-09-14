// box-pi/ui/src/components/RemoteGamePopup.tsx
//
// The one confirmation popup for a remotely-assigned game — reachable
// from Dashboard, Match Setup, and Roster Setup (App.tsx mounts this
// once, globally, rather than each pre-game screen owning its own copy).
// Single rule (per the box-identity task spec): a REMOTE_GAME_AVAILABLE
// event always shows this confirm popup, never auto-switches silently.
//
// "Load" sends ACCEPT_REMOTE_GAME and lets the daemon do the actual
// reconstruction (Task 5's cloud-fallback logic, reused, not duplicated
// here) — this component has no state of its own beyond the two button
// handlers. "Continue manual setup" sends DISMISS_REMOTE_GAME — the
// daemon needs to be TOLD a dismissal happened (it can't infer it from
// silence), so it can mark this gameCode resolved and never re-prompt
// for it again, including on a later reconnect (box-pi's screens
// navigate via full page reloads, so "reconnect" is routine here, not a
// rare edge case).

import { Overlay } from './Overlay';
import { socket, LAN_EVENTS } from '../lib/socket';

export function RemoteGamePopup({ gameCode, onDismiss }: { gameCode: string; onDismiss: () => void }) {
    function handleLoad() {
        socket.emit(LAN_EVENTS.UI_ACTION, { type: 'ACCEPT_REMOTE_GAME', payload: { gameCode } });
        // No local state to flip — once the daemon reconstructs and
        // broadcasts state_update with gameActive:true, App.tsx's own
        // routing takes it from there (same as any other resumed game).
        onDismiss();
    }

    function handleDismiss() {
        socket.emit(LAN_EVENTS.UI_ACTION, { type: 'DISMISS_REMOTE_GAME', payload: { gameCode } });
        onDismiss();
    }

    return (
        <Overlay>
            <h2 style={{ marginTop: 0 }}>REMOTE GAME AVAILABLE</h2>
            <p style={{ fontSize: 14, maxWidth: 320, margin: '0 0 20px' }}>
                A game was set up remotely (Code: <strong>{gameCode}</strong>) — load it now?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={handleLoad} style={primaryButtonStyle}>
                    Load
                </button>
                <button onClick={handleDismiss} style={secondaryButtonStyle}>
                    Continue manual setup
                </button>
            </div>
        </Overlay>
    );
}

const primaryButtonStyle = {
    padding: '10px 16px',
    fontSize: 14,
    background: '#222',
    color: '#fff',
    border: '1px solid #4c86ff',
    borderRadius: 6,
} as const;

const secondaryButtonStyle = {
    padding: '10px 16px',
    fontSize: 14,
    background: '#222',
    color: '#fff',
    border: '1px solid #555',
    borderRadius: 6,
    opacity: 0.8,
} as const;
