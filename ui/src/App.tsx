import { useEffect, useState } from 'react';
import { socket, LAN_EVENTS } from './lib/socket';
import { BootSplash } from './screens/BootSplash';

// Scaffold-stage App: proves the Socket.io connection to the real daemon
// works end to end (connect status + the latest state_update, both logged
// to console and shown on screen). Real screen routing (Boot -> Dashboard
// -> Match Setup -> ... ) is later work — this always renders BootSplash
// for now, with a debug panel underneath so the connection is visible
// without opening devtools.
// Loose on purpose — this is just the scaffold-stage connection proof.
// A real typed mirror of shared/state-engine.js's State shape is later work.
type DaemonState = Record<string, unknown>;

function App() {
    const [connected, setConnected] = useState(socket.connected);
    const [lastEvent, setLastEvent] = useState<string | null>(null);
    const [lastState, setLastState] = useState<DaemonState | null>(null);

    useEffect(() => {
        function onConnect() {
            setConnected(true);
            console.log('[ui] connected to daemon');
        }
        function onDisconnect() {
            setConnected(false);
            console.log('[ui] disconnected from daemon');
        }
        function onStateUpdate(state: DaemonState) {
            console.log('[ui] state_update:', state);
            setLastEvent(LAN_EVENTS.STATE_UPDATE);
            setLastState(state);
        }
        function onGameReady(payload: unknown) {
            console.log('[ui] game_ready:', payload);
            setLastEvent(LAN_EVENTS.GAME_READY);
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

    return (
        <>
            <BootSplash />
            <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: 12, background: '#111', color: '#0f0', fontFamily: 'monospace', fontSize: 12 }}>
                <div>daemon: {connected ? 'CONNECTED' : 'disconnected'} — last event: {lastEvent ?? 'none yet'}</div>
                <pre style={{ maxHeight: 160, overflow: 'auto', margin: '6px 0 0' }}>{lastState ? JSON.stringify(lastState, null, 2) : '(no state_update received yet)'}</pre>
            </div>
        </>
    );
}

export default App;
