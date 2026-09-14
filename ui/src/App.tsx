import { useEffect, useRef, useState } from 'react';
import { socket, LAN_EVENTS } from './lib/socket';
import { BootSplash } from './screens/BootSplash';
import { LiveGame } from './screens/LiveGame';
import { Spectator } from './screens/Spectator';
import { Setup } from './screens/Setup';
import { PostGame } from './screens/PostGame';
import type { DaemonState } from './lib/daemonTypes';

// Minimal routing, NOT the real 8-screen router (Dashboard is still a
// separate later task) — just enough to actually reach each screen, since
// a screen with no way to render is a screen that can't be tested against
// the real daemon.
//
// Order matters:
//   1. /spectator always wins — the second display has no reason to ever
//      show the boot animation or the setup/live/post-game flow.
//   2. A just-finished game (GAME_ENDED received) wins over everything
//      below — shows PostGame with the captured final state.
//   3. An active game wins over being parked on /setup — once setup_game
//      succeeds (from either MatchSetup or RosterSetup), meta.gameActive
//      flips true and this should move to LiveGame even if the browser is
//      still sitting on the /setup URL.
//   4. /setup reaches the Match Setup -> Roster Setup flow.
//   5. Otherwise, BootSplash.
function App() {
    const [state, setState] = useState<DaemonState | null>(null);
    const [finalState, setFinalState] = useState<DaemonState | null>(null);
    // Always holds the latest state_update, read from GAME_ENDED's handler
    // — that handler is registered once (empty deps) so `state` itself
    // would be a stale closure there; a ref sidesteps that.
    const latestStateRef = useRef<DaemonState | null>(null);

    useEffect(() => {
        function onConnect() {
            console.log('[ui] connected to daemon');
        }
        function onDisconnect() {
            console.log('[ui] disconnected from daemon');
        }
        function onStateUpdate(s: DaemonState) {
            console.log('[ui] state_update:', s);
            latestStateRef.current = s;
            setState(s);
        }
        function onGameReady(payload: unknown) {
            console.log('[ui] game_ready:', payload);
            setFinalState(null); // a fresh game starting clears any stale post-game snapshot
        }
        function onGameEnded(payload: unknown) {
            console.log('[ui] game_ended:', payload);
            // dispatch() broadcasts the normal STATE_UPDATE (with the frozen
            // final score) BEFORE emitting GAME_ENDED — verified directly in
            // daemon/index.js, not assumed — so latestStateRef.current here
            // is guaranteed to already be that final snapshot.
            setFinalState(latestStateRef.current);
        }

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on(LAN_EVENTS.STATE_UPDATE, onStateUpdate);
        socket.on(LAN_EVENTS.GAME_READY, onGameReady);
        socket.on(LAN_EVENTS.GAME_ENDED, onGameEnded);

        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            socket.off(LAN_EVENTS.STATE_UPDATE, onStateUpdate);
            socket.off(LAN_EVENTS.GAME_READY, onGameReady);
            socket.off(LAN_EVENTS.GAME_ENDED, onGameEnded);
        };
    }, []);

    if (window.location.pathname === '/spectator') {
        return <Spectator />;
    }
    if (finalState) {
        return (
            <PostGame
                finalState={finalState}
                onReturnToDashboard={() => {
                    // Dashboard itself isn't built yet (separate later task) —
                    // /setup is the real entry point for starting a new game
                    // today, and a full navigation (not a state reset) guarantees
                    // every screen's local state is genuinely gone, not just
                    // hidden — the exact "no leftover state bleeding into a new
                    // game" this task's own verification asks for.
                    window.location.href = '/setup';
                }}
            />
        );
    }
    if (state?.meta.gameActive) {
        return <LiveGame />;
    }
    if (window.location.pathname === '/setup') {
        return <Setup />;
    }
    return <BootSplash />;
}

export default App;
