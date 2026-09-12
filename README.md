# box-pi

THE BOX — Pi-only tabletop basketball scoring console. Raspberry Pi 4 (brains) +
Raspberry Pi Pico W (physical buttons over UART) + referee-facing and
spectator-facing touchscreens, syncing to the shared THE BOX Supabase backend so
games it scores show up correctly on the existing website and app.

This is a clean rewrite in its own repo — not a copy of the old `BOXV2-TEST`
pi-daemon. See `shared/wire-contract.js` for the event/data shapes this device
must stay compatible with.

## Progress log
- [2026-09-12] Repo created (`git init`), `.gitignore` added. Started `shared/wire-contract.js` — defines every cloud (Supabase) and LAN (daemon↔touchscreen) event name and payload shape as JSDoc typedefs + constants, no logic yet. Cloud side copies the existing website's event/field names exactly (frozen); LAN side is this project's own design.
- [2026-09-12] Added root `package.json` (`"type": "module"`) — needed so plain `.js` files actually resolve as ES modules when one imports another; without it Node treats them as CommonJS by default and imports fail.
- [2026-09-12] Built `shared/state-engine.js` — the one pure function (`reduce(state, action)`) that owns every game-state change (score, foul, timeout, clock, undo). No I/O, no Date.now(), no mutation — testable by calling it directly. Two rules worth remembering: team fouls reset every period (for the bonus), but a player's personal fouls never reset (foul-out is for the whole game); timeouts are pooled per FIBA half/OT bracket, not per period, so they only refill when the bracket itself changes. Verified with `scripts/test-state-engine.mjs` — confirmed a timeout gets rejected once a bracket's allotment is used up, a player flips `fouledOut` at their 5th foul, and `UNDO` reverts exactly one action with no redo.
- [2026-09-12] Fixed a review note in `state-engine.js`: `CLOCK_TICK` no longer creates its own UNDO point (ticks are automatic, not ref-triggered) — `UNDO` now skips past any number of ticks and reverts the last real action instead of a fraction-of-a-second-old tick. Re-verified with the same test script.
- [2026-09-12] Built `daemon/uart-bridge.js` — turns a line from the Pico into an action object, nothing more (doesn't call the reducer, doesn't touch Socket.io/Supabase). Checked the real firmware (`pico-firmware/main.py`) before writing this: the actual button board only ever sends `SCORE_A1/2/3`, `SCORE_B1/2/3`, `CLOCK_TOGGLE` (one button, not separate start/stop), `SHOT_CLOCK_24`, `UNDO`, `SETTINGS` (touchscreen lock toggle), and `PICO_READY` (boot handshake) — there's no physical foul or timeout button. `CLOCK_TOGGLE` and `SETTINGS` aren't game-state actions (the bridge isn't allowed to know if the clock is running), so they pass through as their own `CLOCK_TOGGLE`/`TOUCH_LOCK_TOGGLE` markers for later daemon glue to resolve. Has a first-class `devMode` that reads fake input from stdin instead of real serial — verified by piping 8 fake lines through it (handshake swallowed silently, 6 real messages mapped correctly, 1 garbage line logged a warning and didn't throw).
- [2026-09-12] Built `daemon/clock.js` — a drift-safe ticker that reports the REAL measured elapsed time between ticks (via `Date.now()`), not the nominal interval, fixing the old codebase's clock-drift-under-load bug. Verified with `scripts/test-clock.mjs`: 5 ticks at ~100ms intervals matched wall-clock time, and restarting after an 800ms idle gap reported ~99ms on the next tick instead of dumping the whole gap into it.
