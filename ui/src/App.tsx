import { useEffect, useState } from 'react';
import { socket, LAN_EVENTS } from './lib/socket';
import { BootSplash } from './screens/BootSplash';
import { LiveGame } from './screens/LiveGame';
import { Spectator } from './screens/Spectator';
import { Setup } from './screens/Setup';
import type { DaemonState } from './lib/daemonTypes';

// Minimal routing, NOT the real 8-screen router (Dashboard/Settings/
// Post-Game are still separate later tasks) — just enough to actually
// reach each screen, since a screen with no way to render is a screen
// that can't be tested against the real daemon.
//
// Order matters:
//   1. /spectator always wins — the second display has no reason to ever
//      show the boot animation or the setup/live flow.
//   2. An active game always wins over being parked on /setup — once
//      setup_game succeeds (from either MatchSetup or RosterSetup),
//      meta.gameActive flips true and this should move to LiveGame even
//      if the browser is still sitting on the /setup URL.
//   3. /setup reaches the Match Setup -> Roster Setup flow.
//   4. Otherwise, BootSplash.
function App() {
    const [state, setState] = useState<DaemonState | null>(null);

    useEffect(() => {
        function onConnect() {
            console.log('[ui] connected to daemon');
        }
        function onDisconnect() {
            console.log('[ui] disconnected from daemon');
        }
        function onStateUpdate(s: DaemonState) {
            console.log('[ui] state_update:', s);
            setState(s);
        }
        function onGameReady(payload: unknown) {
            console.log('[ui] game_ready:', payload);
        }

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on(LAN_EVENTS.STATE_UPDATE, onStateUpdate);
        socket.on(LAN_EVENTS.GAME_READY, onGameReady);

        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            socket.off(LAN_EVENTS.STATE_UPDATE, onStateUpdate);
            socket.off(LAN_EVENTS.GAME_READY, onGameReady);
        };
    }, []);

    if (window.location.pathname === '/spectator') {
        return <Spectator />;
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
