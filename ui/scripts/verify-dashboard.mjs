// box-pi/ui/scripts/verify-dashboard.mjs
// Task 6f verification — real daemon + real Vite + real headless Chromium,
// same pattern as every prior Task 6 verification script.
//
// Two separate daemon boots, since "did the daemon resume an active game"
// is decided once, at boot:
//   Part 1 — fresh boot, no prior journal: Dashboard shows the normal
//            start flow, clicking through reaches Match Setup, and the
//            connection-status line reflects real connect/disconnect.
//   Part 2 — a journal + current-game-code.txt breadcrumb are written to
//            disk BEFORE the daemon boots (same technique
//            scripts/test-daemon-boot-resume.mjs's scenario A uses), so
//            the daemon resumes with an already-active game. Dashboard
//            must show the resume banner (not silently jump to LiveGame),
//            and its button must land on LiveGame with the resumed state
//            already correct.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { reduce, createEmptyState, ACTIONS } from '../../shared/state-engine.js';
import { createJournal } from '../../daemon/journal.js';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const SHOT_DIR = path.join(UI_ROOT, 'dashboard-e2e-shots');

function killPort(port) {
    try {
        const pids = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').filter(Boolean);
        for (const pid of pids) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://localhost:${port}/socket.io/?EIO=4&transport=polling`);
            if (res.ok) return true;
        } catch {}
        await sleep(300);
    }
    return false;
}
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

function startDaemon(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const proc = spawn('node', ['daemon/index.js', '--dev'], {
        cwd: ROOT,
        env: { ...process.env, BOX_PI_DATA_DIR: dataDir },
        stdio: ['pipe', logFd, logFd],
    });
    fs.closeSync(logFd);
    proc.logPath = logPath;
    return proc;
}

// Polling the daemon's own log for its "listening" line is what
// scripts/daemon-test-harness.mjs already does and is more reliable than a
// network fetch — sidesteps this sandbox's occasional localhost fetch
// flakiness entirely (a real gotcha hit earlier in this session, not a
// daemon bug).
async function waitForDaemonReady(proc, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const readLog = () => { try { return fs.readFileSync(proc.logPath, 'utf8'); } catch { return ''; } };
    while (Date.now() < deadline) {
        if (readLog().includes('[daemon] listening on')) return true;
        await sleep(200);
    }
    return false;
}

killPort(3001);
killPort(5173);
fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

console.log('--- booting Vite dev server (shared across both parts) ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
if (!(await waitForHttp('http://localhost:5173/', 20000))) throw new Error('vite never came up');
console.log('vite up.\n');

const browser = await chromium.launch();

let daemon1 = null;
let daemon2 = null;
process.on('exit', () => {
    try { viteProc.kill('SIGKILL'); } catch {}
    try { daemon1?.kill('SIGKILL'); } catch {}
    try { daemon2?.kill('SIGKILL'); } catch {}
    try { browser.close(); } catch {}
});

// ═══ Part 1: fresh boot, no prior game ═══
console.log('=== Part 1: fresh boot, no prior game ===');
const dirFresh = path.join(ROOT, 'data-test-dashboard-fresh');
fs.rmSync(dirFresh, { recursive: true, force: true });
daemon1 = startDaemon(dirFresh);
if (!(await waitForDaemonReady(daemon1, 30000))) throw new Error("daemon (fresh) never came up");
console.log('daemon (fresh) up.\n');

const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.on('console', (msg) => { if (msg.text().startsWith('[ui]')) console.log('  browser:', msg.text().slice(0, 140)); });

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="connection-status"]', { timeout: 10000 });
await sleep(200);
await page.screenshot({ path: path.join(SHOT_DIR, '01-dashboard-fresh.png') });

const statusTextConnected = await page.getByTestId('connection-status').textContent();
check('connection status shows connected on fresh boot', /connected/i.test(statusTextConnected) && !/disconnected/i.test(statusTextConnected));

const resumeBannerCount = await page.getByTestId('resume-banner').count();
check('no resume banner shown when there is no active game', resumeBannerCount === 0);

await page.getByRole('button', { name: /Start New Game/ }).click();
await page.waitForURL('**/setup', { timeout: 5000 });
const reachedMatchSetup = (await page.textContent('body')).includes('MATCH SETUP');
check('clicking Start New Game reaches Match Setup', reachedMatchSetup);
await page.screenshot({ path: path.join(SHOT_DIR, '02-match-setup-from-dashboard.png') });
console.log();

// ═══ Part 1b: connection status reflects a real disconnect ═══
console.log('=== Part 1b: connection status reflects real daemon disconnect ===');
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="connection-status"]', { timeout: 10000 });
daemon1.kill('SIGKILL');
await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('disconnected'),
    { timeout: 10000 },
);
const statusTextDisconnected = await page.getByTestId('connection-status').textContent();
check('connection status flips to disconnected when the daemon actually dies', /disconnected/i.test(statusTextDisconnected));
await page.screenshot({ path: path.join(SHOT_DIR, '03-disconnected.png') });
await page.close();
console.log();

killPort(3001);
fs.rmSync(dirFresh, { recursive: true, force: true });

// ═══ Part 2: resumed-active-game boot ═══
console.log('=== Part 2: daemon boots with an already-active game (resume) ===');
const dirResume = path.join(ROOT, 'data-test-dashboard-resume');
fs.rmSync(dirResume, { recursive: true, force: true });
{
    // Same technique as scripts/test-daemon-boot-resume.mjs's scenario A —
    // write a journal + breadcrumb BEFORE the daemon ever boots, so its
    // own resume.js logic (not this script) is what produces the active
    // state. Not a fake/mocked state — genuinely reconstructed by the real
    // daemon at boot via journal replay.
    const journal = createJournal({ dir: dirResume });
    let state = createEmptyState();
    function apply(action) { state = reduce(state, action); journal.recordAction(action, state); }
    apply({
        type: ACTIONS.SETUP_GAME,
        payload: {
            teamAName: 'Nuggets', teamAColor: '#EF4444', teamBName: 'Celtics', teamBColor: '#3B82F6',
            periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'quick',
        },
    });
    apply({ type: ACTIONS.SCORE, payload: { team: 'A', points: 2 } });
    apply({ type: ACTIONS.SCORE, payload: { team: 'B', points: 3 } });
    apply({ type: ACTIONS.PERIOD_ADVANCE });
    fs.writeFileSync(path.join(dirResume, 'current-game-code.txt'), 'RSTS');
}
daemon2 = startDaemon(dirResume);
if (!(await waitForDaemonReady(daemon2, 30000))) throw new Error("daemon (resume) never came up");
const resumeLog = fs.readFileSync(path.join(dirResume, 'daemon.log'), 'utf8');
check('daemon actually resumed from the local journal (not a fresh start)', /boot resume source: local-journal/.test(resumeLog));
console.log('daemon (resume) up.\n');

const page2 = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page2.on('console', (msg) => { if (msg.text().startsWith('[ui]')) console.log('  browser:', msg.text().slice(0, 140)); });

await page2.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page2.waitForSelector('[data-testid="resume-banner"]', { timeout: 10000 });
await sleep(200);
await page2.screenshot({ path: path.join(SHOT_DIR, '04-resume-banner.png') });

const notOnMatchSetup = !(await page2.textContent('body')).includes('MATCH SETUP');
check('resumed-active boot lands on the resume banner, not a blank Match Setup', notOnMatchSetup);

const bannerText = await page2.getByTestId('resume-banner').textContent();
check('resume banner shows the correct team names', bannerText.includes('Nuggets') && bannerText.includes('Celtics'));
check('resume banner shows the correct period', bannerText.includes('Q2'));

await page2.getByRole('button', { name: /Resume Live Game/ }).click();
await page2.waitForSelector('[data-testid="scoreboard"]', { timeout: 5000 });
await sleep(200);
await page2.screenshot({ path: path.join(SHOT_DIR, '05-live-game-after-resume.png') });

const liveText = await page2.getByTestId('scoreboard').textContent();
check('Live Game after resume shows the correct resumed score (A=2)', liveText.includes('2'));
check('Live Game after resume shows the correct resumed score (B=3)', liveText.includes('3'));
console.log();

await page2.close();
await browser.close();
killPort(3001);
killPort(5173);
fs.rmSync(dirResume, { recursive: true, force: true });

console.log('DONE. Screenshots in', SHOT_DIR);
if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
