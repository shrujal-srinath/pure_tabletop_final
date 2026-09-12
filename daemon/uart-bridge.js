// box-pi/daemon/uart-bridge.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — UART Bridge
//
// Turns "a line arrived over serial from the Pico" into "here is an
// action object" — nothing more. Does not call the state-engine reducer,
// does not touch Socket.io or Supabase. Whatever wires this to `reduce()`
// is later daemon glue code, not this module's job.
//
// Pico message vocabulary — verified against the real firmware
// (pico-firmware/main.py in the old repo), not guessed. The physical
// controller has 9 buttons + 1 toggle switch, and sends exactly:
//   SCORE_A1 / SCORE_A2 / SCORE_A3 / SCORE_B1 / SCORE_B2 / SCORE_B3
//   CLOCK_TOGGLE     (ONE button — there is no separate start/stop button)
//   SHOT_CLOCK_24    (resets the shot clock to its full duration)
//   UNDO
//   SETTINGS         (the toggle switch — touchscreen lock/unlock, not a
//                      game action at all)
//   PICO_READY       (boot handshake, sent once on power-up)
// There is no physical FOUL or TIMEOUT button — those only ever come
// from the touchscreen UI. Do not invent message strings the real
// firmware doesn't send.
//
// Two mapping wrinkles, both deliberate:
//   - CLOCK_TOGGLE has no single state-engine equivalent — whether it
//     means CLOCK_START or CLOCK_STOP depends on the current
//     `clock.isRunning`, which this module is not allowed to know (no
//     state-engine import, no game state at all). It's passed through
//     as its own `CLOCK_TOGGLE` action; the daemon glue that has the
//     current state resolves it into CLOCK_START/CLOCK_STOP before
//     calling reduce().
//   - SETTINGS isn't a game-state action at all (it toggles the
//     touchscreen lock, a UI concern) — passed through as
//     `TOUCH_LOCK_TOGGLE` so callers can route it to whatever owns that,
//     entirely separate from the reducer.
// ═══════════════════════════════════════════════════════════════════════

import { createInterface } from 'node:readline';

const SCORE_PATTERN = /^SCORE_([AB])([123])$/;

/**
 * @param {string} line
 * @returns {{type:string, payload?:Object}|null} An action-shaped object,
 *   or null for a handshake (PICO_READY) or a genuinely unrecognized line.
 */
export function parsePicoMessage(line) {
    const scoreMatch = SCORE_PATTERN.exec(line);
    if (scoreMatch) {
        return { type: 'SCORE', payload: { team: scoreMatch[1], points: Number(scoreMatch[2]) } };
    }
    switch (line) {
        case 'UNDO':
            return { type: 'UNDO' };
        case 'SHOT_CLOCK_24':
            return { type: 'SHOT_CLOCK_RESET' };
        case 'CLOCK_TOGGLE':
            return { type: 'CLOCK_TOGGLE' }; // not a state-engine action — see file header
        case 'SETTINGS':
            return { type: 'TOUCH_LOCK_TOGGLE' }; // not a state-engine action — see file header
        default:
            return null;
    }
}

/**
 * @param {Object} opts
 * @param {string} [opts.port] Serial device path. Ignored when devMode is true.
 * @param {number} [opts.baudRate] Must match the Pico's UART config (115200).
 * @param {(action: {type:string, payload?:Object}) => void} opts.onAction
 * @param {boolean} [opts.devMode] Read fake input from stdin instead of the
 *   real serial port — same parsing, same onAction calls, only the input
 *   source changes. Not a hack bolted onto the real path: both paths funnel
 *   into the same `handleLine`, so there is exactly one place the Pico
 *   vocabulary is interpreted regardless of where the bytes came from.
 * @returns {{ close: () => void }}
 */
export function createUartBridge({ port = '/dev/serial0', baudRate = 115200, onAction, devMode = false }) {
    function handleLine(raw) {
        const line = raw.trim();
        if (!line) return;

        if (line === 'PICO_READY') {
            console.log('[uart-bridge] PICO_READY — handshake received');
            return;
        }

        const action = parsePicoMessage(line);
        if (!action) {
            console.warn(`[uart-bridge] unrecognized message, ignoring: "${line}"`);
            return;
        }
        onAction(action);
    }

    if (devMode) {
        const rl = createInterface({ input: process.stdin });
        rl.on('line', handleLine);
        console.log('[uart-bridge] devMode — reading fake Pico messages from stdin');
        return { close: () => rl.close() };
    }

    // Real hardware path — lazy-imported so devMode never requires the
    // serialport native module to even be resolvable (e.g. testing this
    // module on a laptop with no serial hardware and no compiled addon).
    let port_, parser;
    const ready = (async () => {
        const { SerialPort } = await import('serialport');
        const { ReadlineParser } = await import('@serialport/parser-readline');
        port_ = new SerialPort({ path: port, baudRate });
        parser = port_.pipe(new ReadlineParser({ delimiter: '\n' }));
        parser.on('data', handleLine);
        port_.on('error', (err) => console.error(`[uart-bridge] serial error: ${err.message}`));
        console.log(`[uart-bridge] listening on ${port} @ ${baudRate} baud`);
    })();

    return {
        close: () => {
            ready.then(() => port_?.close());
        },
    };
}
