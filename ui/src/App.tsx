import { useEffect, useState } from 'react';
import { socket, LAN_EVENTS } from './lib/socket';
import { BootSplash } from './screens/BootSplash';
import { LiveGame } from './screens/LiveGame';
import type { DaemonState } from './lib/daemonTypes';

// Minimal routing, NOT the real 8-screen router (Dashboard/Match Setup/
// Roster Setup/Settings/Post-Game are separate later tasks) — just enough
// to actually reach LiveGame once a game goes active, since a screen with
// no way to render is a screen that can't be tested against the real
// daemon. Boot/Splash otherwise.
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

    if (state?.meta.gameActive) {
        return <LiveGame />;
    }
    return <BootSplash />;
}

export default App;
