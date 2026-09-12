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
