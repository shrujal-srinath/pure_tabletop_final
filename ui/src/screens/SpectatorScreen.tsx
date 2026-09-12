// Spectator screen (second display) — clean read-only render of
// score/clock/fouls, no operator controls, no popups. Same state_update
// feed as the referee screen, different render — never a separate poll.
// Placeholder.

export function SpectatorScreen() {
    return (
        <div style={{ padding: 24 }}>
            <h1>SPECTATOR</h1>
            <p>placeholder — read-only scoreboard render</p>
        </div>
    );
}
