// box-pi/ui/src/components/Overlay.tsx
//
// The modal backdrop + centered box shared by every popup-style surface:
// LiveGame's attribution/court-tap/player-picker popups, and now Settings.
// Factored out (task 6e) rather than duplicated a third time — same
// reasoning as ScoreDisplay/ClockDisplay in Task 6c.

import type { CSSProperties, ReactNode } from 'react';

export function Overlay({ children }: { children: ReactNode }) {
    return (
        <div style={overlayBackdropStyle}>
            <div style={modalStyle}>{children}</div>
        </div>
    );
}

const overlayBackdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 5000,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
};

const modalStyle: CSSProperties = {
    background: '#161616',
    border: '1px solid #444',
    borderRadius: 10,
    padding: 24,
    textAlign: 'center',
};
