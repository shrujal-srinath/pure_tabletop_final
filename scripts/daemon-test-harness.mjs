// box-pi/scripts/daemon-test-harness.mjs
// Shared helper for the daemon/index.js verification scripts — spawns the
// REAL daemon as a child process (not an import — index.js is a boot
// script with real side effects, not a reusable module) and drives it
// exactly the way real hardware/UI would: write Pico-style lines to its
// stdin (devMode), talk to it over a real Socket.io client.

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DAEMON_PORT = 3001;

/**
 * A daemon left over from a killed/crashed prior test run (e.g. this
 * process itself got interrupted before its `finally { stop() }` ran) will
 * otherwise make the next spawn crash on EADDRINUSE — and that crash can
 * happen fast enough that its own log lines never get flushed to disk,
 * which looks confusingly like "the daemon produced no output at all"
 * rather than "the port was already taken". Clear the port first, always.
 */
function killAnythingOnDaemonPort() {
    try {
        const pids = execSync(`lsof -ti:${DAEMON_PORT} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim().split('\n').filter(Boolean);
        for (const pid of pids) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch {
        // lsof exits non-zero when nothing matches — nothing to clean up.
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Object} opts
 * @param {string} opts.dataDir Absolute path — isolates this run's journal/breadcrumb from other tests.
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, socket: import('socket.io-client').Socket, stop: () => Promise<void> }>}
 */
export async function startDaemon({ dataDir }) {
    killAnythingOnDaemonPort();
    fs.mkdirSync(dataDir, { recursive: true });

    // stdout/stderr go to real files, NOT 'pipe'. Node buffers writes to a
    // genuine OS pipe internally and won't flush them while the process
    // stays alive (confirmed directly: identical code logs instantly with
    // stdio:'inherit' or a real file, and never arrives with stdio:'pipe' +
    // a 'data' listener) — a real Node/libuv quirk, not a daemon bug. Files
    // don't have this ambiguity, so read the log back from disk instead.
    const logPath = path.join(dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const proc = spawn('node', ['daemon/index.js', '--dev'], {
        cwd: ROOT,
        env: { ...process.env, BOX_PI_DATA_DIR: dataDir },
        stdio: ['pipe', logFd, logFd],
    });
    fs.closeSync(logFd); // the child holds its own duplicated fd now

    const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');

    // Wait for the real "listening" log line rather than a fixed sleep.
    const deadline = Date.now() + 10000;
    while (!readLog().includes('[daemon] listening on') && Date.now() < deadline) {
        await sleep(50);
    }
    if (!readLog().includes('[daemon] listening on')) {
        throw new Error(`daemon did not start in time. Output so far:\n${readLog()}`);
    }

    const socket = ioClient('http://localhost:3001', { transports: ['websocket'] });
    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    });

    // The daemon always emits one unsolicited state_update right on connect
    // (real, correct behavior — a reconnecting UI needs current state
    // immediately). Drain it here so every later nextStateUpdate() call in a
    // test is guaranteed to catch the broadcast ITS trigger caused, not this
    // one racing against the first listener registration.
    await new Promise((resolve) => socket.once('state_update', resolve));

    function sendPico(line) {
        proc.stdin.write(line + '\n');
    }

    async function stop() {
        socket.close();
        proc.kill('SIGTERM');
        await new Promise((resolve) => proc.once('exit', resolve));
    }

    return { proc, socket, sendPico, getOutput: readLog, stop };
}

/**
 * Waits for the next `state_update` after calling `trigger()`, with a
 * timeout. ONLY safe when nothing else could be independently broadcasting
 * state_update at the same time (e.g. clock stopped, so no CLOCK_TICK
 * broadcasts racing your trigger's own broadcast) — once the clock is
 * running, use waitForState() instead.
 */
export function nextStateUpdate(socket, trigger, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for state_update')), timeoutMs);
        socket.once('state_update', (state) => {
            clearTimeout(timer);
            resolve(state);
        });
        trigger();
    });
}

/**
 * Waits for a state_update satisfying `predicate`, ignoring any that don't
 * (e.g. CLOCK_TICK broadcasts arriving independently while waiting for a
 * specific transition). Safe to use regardless of whether the clock is
 * running.
 */
export function waitForState(socket, trigger, predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('state_update', handler);
            reject(new Error('timed out waiting for a matching state_update'));
        }, timeoutMs);
        function handler(state) {
            if (!predicate(state)) return;
            clearTimeout(timer);
            socket.off('state_update', handler);
            resolve(state);
        }
        socket.on('state_update', handler);
        trigger();
    });
}
