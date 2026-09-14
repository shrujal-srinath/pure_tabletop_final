import { useEffect, useRef, useState } from 'react';
import { socket, LAN_EVENTS } from './lib/socket';
import { BootSplash } from './screens/BootSplash';
import { Dashboard } from './screens/Dashboard';
import { LiveGame } from './screens/LiveGame';
import { Spectator } from './screens/Spectator';
import { Setup } from './screens/Setup';
import { PostGame } from './screens/PostGame';
import type { BootProgressPayload, DaemonState } from './lib/daemonTypes';

// Minimal routing, NOT the real 8-screen router — just enough to actually
// reach each screen, since a screen with no way to render is a screen that
// can't be tested against the real daemon.
//
// Order matters:
//   1. /spectator always wins — the second display has no reason to ever
//      show the boot animation or the setup/live/post-game flow.
//   2. A just-finished game (GAME_ENDED received) wins over everything
//      below — shows PostGame with the captured final state.
//   3. An active game this SESSION explicitly caused (started via
//      Setup/RosterSetup, or confirmed via Dashboard's resume banner) goes
//      straight to LiveGame, even if the browser is still sitting on the
//      /setup URL.
//   4. /setup reaches the Match Setup -> Roster Setup flow.
//   5. Once BootSplash itself has decided the daemon is genuinely ready
//      (real BOOT_PROGRESS reaching 'ready', not just the early
//      state_update every connection gets for free — see `bootReady`'s
//      own comment below), show Dashboard — which itself branches on
//      gameActive (task 6f: a daemon that resumed an already-active game
//      on boot, before this app ever had a session, must not be silently
//      dropped straight into LiveGame — see the "confirmedLive" gate
//      below for why that's not step 3).
//   6. Otherwise, BootSplash — driven by real BOOT_PROGRESS data, not a
//      fixed timer (task: real boot progress on the Splash screen).
function App() {
    const [state, setState] = useState<DaemonState | null>(null);
    const [finalState, setFinalState] = useState<DaemonState | null>(null);
    const [connected, setConnected] = useState(socket.connected);
    // True once THIS session has explicitly caused/confirmed entering
    // LiveGame — either by starting a fresh game (GAME_READY) or by the
    // operator tapping through Dashboard's "resume" banner. Deliberately
    // NOT the same thing as `state?.meta.gameActive`: a daemon can boot
    // with gameActive already true (Task 5/6a's resume-on-boot), and that
    // case must land on Dashboard's resume banner first, not silently jump
    // straight to LiveGame — the whole point of Task 6f's resume UX. Without
    // this gate, Dashboard could never actually render that banner, since
    // gameActive alone would already have routed away from it.
    const [confirmedLive, setConfirmedLive] = useState(false);
    const [bootProgress, setBootProgress] = useState<BootProgressPayload | null>(null);
    // Flips true once BootSplash itself decides the daemon is genuinely
    // ready AND its own minimum-display-time gate is satisfied (see
    // BootSplash's onReady prop) — only then does Dashboard become
    // reachable. Deliberately NOT based on `state` truthiness: the daemon
    // already emits an initial state_update on connect before it has
    // actually finished starting its uart-bridge/clock (see
    // daemon/index.js's boot sequence), so `state` alone arrives too early
    // to mean "safe to show Dashboard and start driving the daemon".
    const [bootReady, setBootReady] = useState(false);
    // Always holds the latest state_update, read from GAME_ENDED's handler
    // — that handler is registered once (empty deps) so `state` itself
    // would be a stale closure there; a ref sidesteps that.
    const latestStateRef = useRef<DaemonState | null>(null);

    useEffect(() => {
        function onConnect() {
            setConnected(true);
            console.log('[ui] connected to daemon');
        }
        function onDisconnect() {
            setConnected(false);
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
            setConfirmedLive(true); // this session started it — go straight to LiveGame
        }
        function onBootProgress(payload: BootProgressPayload) {
            console.log('[ui] boot_progress:', payload);
            setBootProgress(payload);
        }
        function onGameEnded(payload: unknown) {
            console.log('[ui] game_ended:', payload);
            // dispatch() broadcasts the normal STATE_UPDATE (with the frozen
            // final score) BEFORE emitting GAME_ENDED — verified directly in
            // daemon/index.js, not assumed — so latestStateRef.current here
            // is guaranteed to already be that final snapshot.
            setFinalState(latestStateRef.current);
            setConfirmedLive(false);
        }

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on(LAN_EVENTS.STATE_UPDATE, onStateUpdate);
        socket.on(LAN_EVENTS.GAME_READY, onGameReady);
        socket.on(LAN_EVENTS.BOOT_PROGRESS, onBootProgress);
        socket.on(LAN_EVENTS.GAME_ENDED, onGameEnded);

        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            socket.off(LAN_EVENTS.STATE_UPDATE, onStateUpdate);
            socket.off(LAN_EVENTS.GAME_READY, onGameReady);
            socket.off(LAN_EVENTS.BOOT_PROGRESS, onBootProgress);
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
                    // Full navigation (not a state reset) guarantees every
                    // screen's local state is genuinely gone, not just
                    // hidden — the exact "no leftover state bleeding into a
                    // new game" Task 6e's own verification asked for.
                    window.location.href = '/';
                }}
            />
        );
    }
    if (state?.meta.gameActive && confirmedLive) {
        return <LiveGame initialState={state} />;
    }
    if (window.location.pathname === '/setup') {
        return <Setup />;
    }
    if (bootReady && state) {
        return (
            <Dashboard
                connected={connected}
                state={state}
                onStartMatch={() => {
                    window.location.href = '/setup';
                }}
                onResumeGame={() => setConfirmedLive(true)}
            />
        );
    }
    return <BootSplash bootProgress={bootProgress} onReady={() => setBootReady(true)} />;
}

export default App;
