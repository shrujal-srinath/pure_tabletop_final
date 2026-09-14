// box-pi/ui/scripts/verify-boot-continuity.mjs
// Verifies the specific bug just fixed: the wheel used to advance in
// discrete jumps tied to when each real BOOT_PROGRESS event arrived
// ("spins 5 times separately") instead of one smooth, continuous sweep.
// This samples the percent readout at tight, regular intervals through
// the whole LOAD phase and asserts the deltas between consecutive
// samples are small and roughly consistent with the pure ease-out-cubic
// formula — not big stepwise jumps.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');

function killPort(port) {
    try {
        const pids = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').filter(Boolean);
        for (const pid of pids) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(url)).ok) return true; } catch {}
        await sleep(300);
    }
    return false;
}
function startDaemon(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const proc = spawn('node', ['daemon/index.js', '--dev'], { cwd: ROOT, env: { ...process.env, BOX_PI_DATA_DIR: dataDir }, stdio: ['pipe', logFd, logFd] });
    fs.closeSync(logFd);
    proc.logPath = logPath;
    return proc;
}
async function waitForDaemonReady(proc, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const readLog = () => { try { return fs.readFileSync(proc.logPath, 'utf8'); } catch { return ''; } };
    while (Date.now() < deadline) {
        if (readLog().includes('[daemon] listening on')) return true;
        await sleep(150);
    }
    return false;
}

let allOk = true;
function check(label, ok) {
    console.log(`  ${ok ? 'OK' : 'FAIL'} — ${label}`);
    if (!ok) allOk = false;
}

killPort(3001);
killPort(5173);
const dir = path.join(ROOT, 'data-test-boot-continuity');
fs.rmSync(dir, { recursive: true, force: true });

console.log('--- booting Vite + daemon ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
if (!(await waitForHttp('http://localhost:5173/', 20000))) throw new Error('vite never came up');
const daemonProc = startDaemon(dir);
if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon never came up');
console.log('both up — daemon already fully booted before the page connects (the exact condition that triggered the old bug).\n');

const browser = await chromium.launch();
process.on('exit', () => { try { viteProc.kill('SIGKILL'); } catch {}; try { daemonProc.kill('SIGKILL'); } catch {}; try { browser.close(); } catch {} });

const context = await browser.newContext(); // fresh sessionStorage
const page = await context.newPage({ viewport: { width: 1024, height: 800 } });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

// Sample every 200ms from just past PRIME (1100ms) through the full
// LOAD_DURATION_MS (4400ms) window, i.e. roughly 1.3s -> 5.4s post-mount.
const samples = [];
const t0 = Date.now();
await sleep(1300);
for (let i = 0; i < 20; i++) {
    const txt = await page.getByTestId('boot-pct').textContent().catch(() => null);
    samples.push({ t: Date.now() - t0, pct: txt === null ? null : Number(txt) });
    await sleep(200);
}

console.log('  samples (ms, %):', samples.map((s) => `${s.t}:${s.pct}`).join('  '));

const values = samples.map((s) => s.pct).filter((v) => v !== null);
check('collected enough samples through the sweep', values.length >= 15);

// The old bug: big discrete jumps (tens of percent in one 200ms tick)
// separated by flat stretches. The fix: small, steady deltas throughout.
let maxDelta = 0;
let flatStretches = 0;
let inFlat = false;
for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    maxDelta = Math.max(maxDelta, delta);
    if (delta === 0 && values[i] < 99) {
        if (!inFlat) { flatStretches++; inFlat = true; }
    } else {
        inFlat = false;
    }
}
console.log(`  max single-step delta across 200ms samples: ${maxDelta}%`);
console.log(`  flat (unchanged) stretches before reaching ~100%: ${flatStretches}`);
check('no single 200ms step jumps by more than ~15% (the "separate spins" symptom)', maxDelta <= 15);
check('at most one brief flat stretch (near the very end, not several stop-start jumps)', flatStretches <= 1);

// Monotonic — should never regress.
let monotonic = true;
for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1]) monotonic = false;
check('readout is monotonically non-decreasing throughout', monotonic);

await page.waitForFunction(() => document.body.textContent?.includes('Start New Game'), { timeout: 10000 });
console.log('  reached Dashboard successfully.');

await context.close();
killPort(3001);
killPort(5173);
fs.rmSync(dir, { recursive: true, force: true });

if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
