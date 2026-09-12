// Boot/Splash — shown while the daemon is starting up.
// Plain placeholder for now; the real design (Claude Design import) is a
// separate task. Real behavior when it lands: listen for GAME_READY or a
// resumed-active state_update to know when to transition off, not a timer.

export function BootSplash() {
    return (
        <div style={{ padding: 24 }}>
            <h1>BOOT / SPLASH</h1>
            <p>placeholder — waiting for the daemon</p>
        </div>
    );
}
