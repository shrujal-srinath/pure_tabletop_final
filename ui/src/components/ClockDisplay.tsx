// box-pi/ui/src/components/ClockDisplay.tsx
//
// Period/game-clock/shot-clock/mode readout — pure display, no interaction.
// Shared by LiveGame and Spectator; see ScoreDisplay.tsx for why this is
// factored out rather than duplicated between the two screens.

import type { ClockState, GameMode } from '../lib/daemonTypes';
import { msToClock } from '../lib/format';

export function ClockDisplay({ clock, gameMode }: { clock: ClockState; gameMode: GameMode }) {
    return (
        <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, opacity: 0.7, letterSpacing: 2 }}>PERIOD {clock.period}</div>
            <div style={{ fontSize: 48, fontFamily: 'monospace' }}>{msToClock(clock.gameMs)}</div>
            <div style={{ fontSize: 20, fontFamily: 'monospace', opacity: 0.8 }}>shot {Math.ceil(clock.shotMs / 1000)}</div>
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>{gameMode.toUpperCase()} MODE</div>
        </div>
    );
}
