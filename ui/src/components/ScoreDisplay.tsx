// box-pi/ui/src/components/ScoreDisplay.tsx
//
// One team's score/fouls/timeouts panel — pure display, no interaction.
// Shared by LiveGame (which wraps it with FOUL/TIMEOUT controls alongside)
// and Spectator (which renders it alone, read-only). Factored out so the
// two screens can never visually drift apart by one being edited without
// the other.

import type { CSSProperties } from 'react';
import type { Team } from '../lib/daemonTypes';

export function ScoreDisplay({ team, hasBall, bonus }: { team: Team; hasBall: boolean; bonus: boolean }) {
    return (
        <div style={{ textAlign: 'center', minWidth: 170 }}>
            <div style={{ fontSize: 16, textTransform: 'uppercase', letterSpacing: 1 }}>
                {team.name} {hasBall && <span title="possession">●</span>}
            </div>
            <div style={{ fontSize: 64, fontFamily: 'monospace', color: team.color, lineHeight: 1 }}>{team.score}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
                Fouls: {team.fouls} {bonus && <strong style={bonusStyle}>BONUS</strong>}
            </div>
            <div style={{ fontSize: 13 }}>Timeouts: {team.timeouts}</div>
        </div>
    );
}

const bonusStyle: CSSProperties = { color: '#ff9500', marginLeft: 6 };
