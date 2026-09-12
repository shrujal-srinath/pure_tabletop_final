// box-pi/daemon/clock.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Drift-safe ticker
//
// The old codebase's clock assumed each tick represented exactly
// `intervalMs` of real time. JS timers aren't that precise — under load
// a "100ms" interval can fire late, and assuming it was exactly 100ms
// silently loses real seconds off the game clock. This module measures
// the ACTUAL elapsed wall-clock time between ticks (via Date.now()) and
// reports that instead of the nominal interval.
//
// Knows nothing about game state, `isRunning`, or the reducer — it is
// purely "call me back with real elapsed time, repeatedly, until told to
// stop." Whether the game clock or shot clock is currently running is a
// decision for whatever wires this to state-engine later; state-engine
// already tracks that itself, so this module doesn't need to.
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {Object} opts
 * @param {number} [opts.intervalMs] Nominal tick interval — the ACTUAL
 *   elapsed time reported to onTick may differ from this.
 * @param {(actualDeltaMs: number) => void} opts.onTick
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createTicker({ intervalMs = 100, onTick }) {
    let timer = null;
    let lastTickAt = null;

    function tick() {
        const now = Date.now();
        const actualDeltaMs = now - lastTickAt;
        lastTickAt = now;
        onTick(actualDeltaMs);
    }

    function start() {
        if (timer) return; // already running
        lastTickAt = Date.now();
        timer = setInterval(tick, intervalMs);
    }

    function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
        // Reset the reference so a later start() measures from its own
        // fresh Date.now(), not from before the stopped gap — otherwise
        // the first tick after a restart would report the entire idle
        // gap as elapsed time.
        lastTickAt = null;
    }

    return { start, stop };
}
