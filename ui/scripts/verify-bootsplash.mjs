// box-pi/ui/scripts/verify-bootsplash.mjs
// Task 6g (Boot/Splash) verification — real daemon + real Vite + real
// headless Chromium, same pattern as every prior Task 6 script.
//
// Confirms the actual behavior this task cares about (not pixel fidelity,
// which was checked visually via screenshots during the port): BootSplash
// shows while there is genuinely no daemon connection yet, and the app
// transitions off it the instant a real state_update arrives — with no
// fixed timer involved on either side.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const SHOT_DIR = path.join(UI_ROOT, 'bootsplash-e2e-shots');

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

killPort(3001);
killPort(5173);
fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const dataDir = path.join(ROOT, 'data-test-bootsplash');
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('--- booting Vite dev server (daemon deliberately NOT started yet) ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
if (!(await waitForHttp('http://localhost:5173/', 20000))) throw new Error('vite never came up');
console.log('vite up.\n');

let daemonProc = null;
process.on('exit', () => {
    try { viteProc.kill('SIGKILL'); } catch {}
    try { daemonProc?.kill('SIGKILL'); } catch {}
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });

console.log('=== Part 1: no daemon running yet — BootSplash shows ===');
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await sleep(500);
const showsSplash = (await page.textContent('body')).includes('SYS · INIT');
check('BootSplash renders (SYS · INIT status line present) with no daemon connection', showsSplash);
await page.screenshot({ path: path.join(SHOT_DIR, '01-splash-no-daemon.png') });

// Hold here well past the animation's own ~5.5s dial cycle to confirm it
// keeps looping rather than erroring or getting stuck — the "if the daemon
// takes unusually long" requirement.
await sleep(6000);
const stillSplash = (await page.textContent('body')).includes('SYS · INIT');
check('BootSplash is still showing (looping, not stuck/errored) after outlasting one full animation cycle with no daemon', stillSplash);
await page.screenshot({ path: path.join(SHOT_DIR, '02-splash-still-looping.png') });
console.log();

console.log('=== Part 2: daemon comes up — screen transitions off automatically ===');
fs.mkdirSync(dataDir, { recursive: true });
const logFd = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
daemonProc = spawn('node', ['daemon/index.js', '--dev'], {
    cwd: ROOT,
    env: { ...process.env, BOX_PI_DATA_DIR: dataDir },
    stdio: ['pipe', logFd, logFd],
});
fs.closeSync(logFd);

await page.waitForFunction(
    () => !document.body.textContent?.includes('SYS · INIT'),
    { timeout: 20000 },
);
await sleep(300);
const transitioned = !(await page.textContent('body')).includes('SYS · INIT');
const onDashboard = (await page.textContent('body')).includes('Start New Game');
check('BootSplash unmounts once the real daemon connects (no fixed timer)', transitioned);
check('lands on Dashboard, not some intermediate/blank state', onDashboard);
await page.screenshot({ path: path.join(SHOT_DIR, '03-transitioned-to-dashboard.png') });

await page.close();
await browser.close();
killPort(3001);
killPort(5173);
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('\nDONE. Screenshots in', SHOT_DIR);
if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
