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
