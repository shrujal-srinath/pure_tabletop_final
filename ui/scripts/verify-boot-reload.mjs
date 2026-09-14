// box-pi/ui/scripts/verify-boot-reload.mjs
// Verifies two follow-up fixes reported after real usage:
//   1. A genuine browser reload (F5/Cmd+R) always shows the full paced
//      animation, even within an already-"seen" session — only the app's
//      own internal navigations (window.location.href, e.g. Return to
//      Dashboard) should skip it.
//   2. A safety net: if no real BOOT_PROGRESS ever arrives, the wheel
//      still completes rather than freezing forever at 0%.

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
async function waitForDashboard(page, timeoutMs) {
    await page.waitForFunction(() => document.body.textContent?.includes('Start New Game') || document.body.textContent?.includes('Resume game in progress'), { timeout: timeoutMs });
}

let allOk = true;
function check(label, ok) {
    console.log(`  ${ok ? 'OK' : 'FAIL'} — ${label}`);
    if (!ok) allOk = false;
}

killPort(3001);
killPort(5173);
const dir = path.join(ROOT, 'data-test-boot-reload');
fs.rmSync(dir, { recursive: true, force: true });

console.log('--- booting Vite + daemon ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
if (!(await waitForHttp('http://localhost:5173/', 20000))) throw new Error('vite never came up');
const daemonProc = startDaemon(dir);
if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon never came up');
console.log('both up.\n');

const browser = await chromium.launch();
process.on('exit', () => { try { viteProc.kill('SIGKILL'); } catch {}; try { daemonProc.kill('SIGKILL'); } catch {}; try { browser.close(); } catch {} });

// ═══ Part 1: manual reload always gets the full animation ═══
console.log('=== Part 1: manual reload bypasses session-skip ===');
{
    const context = await browser.newContext();
    const page = await context.newPage({ viewport: { width: 1024, height: 800 } });

    const firstOpenedAt = Date.now();
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await waitForDashboard(page, 10000);
    const firstElapsed = Date.now() - firstOpenedAt;
    console.log(`  first load: ${firstElapsed}ms`);
    check('first load takes the full paced sweep', firstElapsed >= 4500);

    // Confirm session-skip DOES work for internal navigation (unchanged
    // regression check) — simulate via a same-context goto (not a reload).
    const navOpenedAt = Date.now();
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await waitForDashboard(page, 5000);
    const navElapsed = Date.now() - navOpenedAt;
    console.log(`  internal-style navigation (goto, same session): ${navElapsed}ms`);
    check('a same-session goto (not a reload) still skips via session-skip', navElapsed < 1500);

    // Now the actual fix under test: a genuine reload() call.
    const reloadStartedAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboard(page, 10000);
    const reloadElapsed = Date.now() - reloadStartedAt;
    console.log(`  page.reload(), same session (flag already set): ${reloadElapsed}ms`);
    check('a genuine reload gets the full animation even though the session flag is set', reloadElapsed >= 4500);

    await context.close();
}
console.log();

// ═══ Part 2: safety net when no real progress data ever arrives ═══
console.log('=== Part 2: safety net — animation still completes with no BOOT_PROGRESS data ===');
{
    const context = await browser.newContext();
    const page = await context.newPage({ viewport: { width: 1024, height: 800 } });

    // Block the boot_progress websocket frames at the network level to
    // simulate a client that genuinely never receives any — the daemon
    // still sends everything else (state_update etc.) normally.
    await page.routeWebSocket(/.*/, (ws) => {
        const server = ws.connectToServer();
        server.onMessage((msg) => {
            const text = typeof msg === 'string' ? msg : msg.toString();
            if (text.includes('boot_progress')) return; // drop it — never forward to the client
            ws.send(msg);
        });
    });

    const openedAt = Date.now();
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

    // Give it well past NO_PROGRESS_FALLBACK_MS + PRIME to confirm the
    // wheel is genuinely moving despite zero real progress data.
    await sleep(4200);
    const pct = await page.getByTestId('boot-pct').textContent().catch(() => null);
    console.log(`  boot-pct with all real progress data blocked, at ~4.2s: ${pct}%`);
    check('wheel is moving (not frozen at 0) despite no real BOOT_PROGRESS ever arriving', pct !== null && Number(pct) > 0);

    await waitForDashboard(page, 10000);
    const elapsed = Date.now() - openedAt;
    console.log(`  reached Dashboard anyway at ${elapsed}ms`);
    check('the app does not get permanently stuck on the splash screen', elapsed < 10000);

    await context.close();
}

killPort(3001);
killPort(5173);
fs.rmSync(dir, { recursive: true, force: true });

if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('\nALL CHECKS PASSED');
process.exit(0);
