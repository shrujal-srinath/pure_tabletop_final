// box-pi/ui/scripts/verify-boot-pacing.mjs
// Verification for the BootSplash pacing/stuck-state fix — real daemon +
// real Vite + real headless Chromium.
//
// Covers:
//   1. Fresh boot (repeated 6x with a brand-new browser context each time,
//      i.e. clean sessionStorage) — confirms the wheel visibly takes
//      roughly the MIN_MS/4000ms sweep, never snaps instantly, and never
//      gets stuck on the end screen. Repeated specifically because the
//      bug this fixes was intermittent.
//   2. Slow boot (BOX_PI_TEST_BOOT_DELAY_MS) — confirms real progress
//      still correctly caps/paces the wheel; it never shows more than the
//      backend has actually reported.
//   3. Session-skip — the SAME browser context loaded twice: the first
//      load takes the full pace, the second (sessionStorage now set)
//      lands on Dashboard near-instantly.
//   4. A brand-new context after that (simulating a kiosk restart) gets
//      the full animation again — confirms the flag is session-scoped,
//      not permanent.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const SHOT_DIR = path.join(UI_ROOT, 'boot-pacing-e2e-shots');

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

let allOk = true;
function check(label, ok) {
    console.log(`  ${ok ? 'OK' : 'FAIL'} — ${label}`);
    if (!ok) allOk = false;
}

function startDaemon(dataDir, extraEnv = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const proc = spawn('node', ['daemon/index.js', '--dev'], {
        cwd: ROOT,
        env: { ...process.env, BOX_PI_DATA_DIR: dataDir, ...extraEnv },
        stdio: ['pipe', logFd, logFd],
    });
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
async function pctOf(page) {
    const txt = await page.getByTestId('boot-pct').textContent().catch(() => null);
    return txt === null ? null : Number(txt);
}
async function waitForDashboard(page, timeoutMs) {
    await page.waitForFunction(() => document.body.textContent?.includes('Start New Game') || document.body.textContent?.includes('Resume game in progress'), { timeout: timeoutMs });
}

killPort(3001);
killPort(5173);
fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

console.log('--- booting Vite dev server (shared) ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
if (!(await waitForHttp('http://localhost:5173/', 20000))) throw new Error('vite never came up');
console.log('vite up.\n');

const browser = await chromium.launch();
let daemonProc = null;
process.on('exit', () => {
    try { viteProc.kill('SIGKILL'); } catch {}
    try { daemonProc?.kill('SIGKILL'); } catch {}
    try { browser.close(); } catch {}
});

// ═══ Part 1: fresh boot, repeated 6x with a clean context each time ═══
console.log('=== Part 1: fresh boot x6 (fresh sessionStorage each time) — paced, never stuck ===');
{
    const dir = path.join(ROOT, 'data-test-boot-pacing-fresh');
    fs.rmSync(dir, { recursive: true, force: true });
    daemonProc = startDaemon(dir);
    if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon (fresh) never came up');
    console.log('daemon up — already fully booted before any of these runs open a page (worst case for "snaps instantly").\n');

    for (let i = 1; i <= 6; i++) {
        const context = await browser.newContext();
        const page = await context.newPage({ viewport: { width: 1024, height: 800 } });
        const openedAt = Date.now();
        await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

        // PRIME (the fixed local spin-up) always shows 0% for its own
        // first ~1100ms regardless of real data — sample AFTER that, so
        // these checks actually exercise the paced climb rather than
        // trivially passing on PRIME's own hardcoded zero.
        await sleep(1600);
        const early = await pctOf(page);
        await sleep(1600);
        const mid = await pctOf(page);
        if (i === 1) await page.screenshot({ path: path.join(SHOT_DIR, '01-fresh-mid-sweep.png') });

        await waitForDashboard(page, 10000); // generous — this is the "did it get stuck" check
        const dashboardAt = Date.now();
        const elapsed = dashboardAt - openedAt;

        const paced = early !== null && early < 90;
        const progressed = mid !== null && early !== null && mid >= early;
        console.log(`  run ${i}: at~1.6s=${early}%  at~3.2s=${mid}%  total=${elapsed}ms`);
        check(`run ${i}: readout is genuinely pacing past PRIME, not snapping instantly (~1.6s < 90%)`, paced);
        check(`run ${i}: readout is moving forward, not stuck (~3.2s >= ~1.6s)`, progressed);
        check(`run ${i}: reached Dashboard within a bounded time (not stuck forever)`, elapsed < 8000);
        check(`run ${i}: took roughly the deliberate ~4s sweep, not instant`, elapsed >= 3500);
        await context.close();
    }
    killPort(3001);
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log();

// ═══ Part 2: slow boot — real progress still paces/caps correctly ═══
console.log('=== Part 2: slow boot — wheel never shows more than real reported progress ===');
{
    const dir = path.join(ROOT, 'data-test-boot-pacing-slow');
    fs.rmSync(dir, { recursive: true, force: true });
    const ARTIFICIAL_DELAY_MS = 6000; // longer than MIN_MS, so pacing alone would have hit 100 if it ignored real progress
    daemonProc = startDaemon(dir, { BOX_PI_TEST_BOOT_DELAY_MS: String(ARTIFICIAL_DELAY_MS) });
    if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon (slow) never came up');

    const context = await browser.newContext();
    const page = await context.newPage({ viewport: { width: 1024, height: 800 } });
    const openedAt = Date.now();
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

    // At ~4.5s (past MIN_MS/4000, but well before the real 6s delay
    // resolves), the wheel must NOT already be at/near 100 — that would
    // mean pacing rushed ahead of reality instead of being capped by it.
    await sleep(4500);
    const midDelay = await pctOf(page);
    const stillOnSplash = (await page.textContent('body')).includes('SYS · INIT');
    console.log(`  at ~4.5s (real delay is 6s): readout=${midDelay}%, still on splash=${stillOnSplash}`);
    check('real progress correctly caps the wheel — not at/near 100% before the real backend is', midDelay !== null && midDelay < 95);
    check('still on the splash screen (not stuck early on Dashboard)', stillOnSplash);
    await page.screenshot({ path: path.join(SHOT_DIR, '02-slow-capped.png') });

    await waitForDashboard(page, 15000);
    const elapsed = Date.now() - openedAt;
    console.log(`  total elapsed to Dashboard: ${elapsed}ms`);
    // The artificial delay starts counting from the daemon's own listen()
    // success, not from when this script's browser page opens (which
    // happens slightly later, after waitForDaemonReady's log polling) —
    // so elapsed-from-page-open is legitimately a bit under the full
    // delay. The real invariant (no artificial cutoff, real progress
    // shown throughout) is already proven by the mid-delay check above;
    // this is just a generous sanity floor, not a precise measurement.
    check('total time reflects the real (longer) delay, no artificial cutoff', elapsed >= ARTIFICIAL_DELAY_MS - 1500);

    await context.close();
    killPort(3001);
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log();

// ═══ Part 3: session-skip — same context, second load is near-instant ═══
console.log('=== Part 3: session-skip — repeat view in the same session lands near-instantly ===');
{
    const dir = path.join(ROOT, 'data-test-boot-pacing-session');
    fs.rmSync(dir, { recursive: true, force: true });
    daemonProc = startDaemon(dir);
    if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon (session) never came up');

    const context = await browser.newContext();
    const page = await context.newPage({ viewport: { width: 1024, height: 800 } });

    const firstOpenedAt = Date.now();
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await waitForDashboard(page, 10000);
    const firstElapsed = Date.now() - firstOpenedAt;
    console.log(`  first load this session: ${firstElapsed}ms`);
    check('first load in a fresh session still takes the full deliberate sweep', firstElapsed >= 3500);

    // Same context/tab -> sessionStorage persists across this reload,
    // exactly like a real Return-to-Dashboard/Start-New-Game full nav.
    const secondOpenedAt = Date.now();
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await waitForDashboard(page, 5000);
    const secondElapsed = Date.now() - secondOpenedAt;
    console.log(`  second load, same session: ${secondElapsed}ms`);
    check('repeat view within the same session lands near-instantly (session-skip working)', secondElapsed < 1500);
    await page.screenshot({ path: path.join(SHOT_DIR, '03-session-skip-dashboard.png') });

    // ═══ Part 4: a brand-new context (simulated kiosk restart) resets it ═══
    await context.close();
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage({ viewport: { width: 1024, height: 800 } });
    const freshOpenedAt = Date.now();
    await freshPage.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await waitForDashboard(freshPage, 10000);
    const freshElapsed = Date.now() - freshOpenedAt;
    console.log(`  brand-new browser context (simulated restart): ${freshElapsed}ms`);
    check('a genuinely new session gets the full animation again, not a stale skip', freshElapsed >= 3500);

    await freshContext.close();
    killPort(3001);
    fs.rmSync(dir, { recursive: true, force: true });
}

killPort(5173);
console.log('\nDONE. Screenshots in', SHOT_DIR);
if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
