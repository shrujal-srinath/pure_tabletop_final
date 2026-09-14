// box-pi/ui/src/lib/format.ts — small display-formatting helpers shared
// across screens. Pure functions only, no state.

export function msToClock(ms: number): string {
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}
