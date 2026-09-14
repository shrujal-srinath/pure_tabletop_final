import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { io as ioClient } from 'socket.io-client';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const DATA_DIR = path.join(ROOT, 'data-test-spectator-e2e');
const SHOT_DIR = path.join(UI_ROOT, 'spectator-e2e-shots');

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

killPort(3001);
killPort(5173);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const daemonLogPath = path.join(DATA_DIR, 'daemon.log');
fs.mkdirSync(DATA_DIR, { recursive: true });
const daemonLogFd = fs.openSync(daemonLogPath, 'a');

console.log('--- booting real daemon ---');
const daemonProc = spawn('node', ['daemon/index.js', '--dev'], {
    cwd: ROOT,
    env: { ...process.env, BOX_PI_DATA_DIR: DATA_DIR },
    stdio: ['pipe', daemonLogFd, daemonLogFd],
});
fs.closeSync(daemonLogFd);
if (!(await waitForSocket(3001, 15000))) throw new Error('daemon never came up');
console.log('daemon up.\n');

console.log('--- booting Vite dev server ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
{
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline) {
        try { if ((await fetch('http://localhost:5173/')).ok) { up = true; break; } } catch {}
        await sleep(300);
    }
    if (!up) throw new Error('vite never came up');
}
console.log('vite up.\n');

process.on('exit', () => {
    try { daemonProc.kill('SIGKILL'); } catch {}
    try { viteProc.kill('SIGKILL'); } catch {}
});

const browser = await chromium.launch();

// Two SEPARATE pages, exactly like two separate physical monitors would be
// two separate browser windows — each opens its own Socket.io connection
// to the daemon (there's no way, or need, for two different windows to
// literally share one JS socket object). "Same source of truth" means both
// listen to the SAME daemon broadcast, not that they share a connection.
const liveGamePage = await browser.newPage({ viewport: { width: 900, height: 500 } });
const spectatorPage = await browser.newPage({ viewport: { width: 900, height: 500 } });

await liveGamePage.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await spectatorPage.goto('http://localhost:5173/spectator', { waitUntil: 'domcontentloaded' });
await sleep(500);

const admin = ioClient('http://localhost:3001', { transports: ['websocket'] });
await new Promise((resolve) => admin.on('connect', resolve));

function setupGame(gameMode) {
    admin.emit('setup_game', {
        teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode,
        roster: { teamA: [{ id: 'pA1', name: 'Arjun', number: '7' }], teamB: [{ id: 'pB1', name: 'Bilal', number: '9' }] },
    });
}
function unlockTouch() { admin.emit('ui_action', { type: 'UNLOCK_TOUCH' }); }
function sendPico(line) { daemonProc.stdin.write(line + '\n'); }

// The `scoreboard` testid wraps the EXACT SAME ScoreDisplay/ClockDisplay
// components on both screens — comparing its text content directly is a
// precise, non-fragile proof the two screens render identically, not just
// "look similar".
async function scoreboardText(page) {
    return (await page.getByTestId('scoreboard').textContent()).replace(/\s+/g, ' ').trim();
}
async function shotBoth(name) {
    await liveGamePage.screenshot({ path: path.join(SHOT_DIR, `${name}-livegame.png`) });
    await spectatorPage.screenshot({ path: path.join(SHOT_DIR, `${name}-spectator.png`) });
    console.log(`  [screenshots] ${name}-livegame.png / ${name}-spectator.png`);
}

console.log('=== Scenario 1: side-by-side sync across a sequence of actions ===');
setupGame('quick');
await sleep(400);
unlockTouch();
await sleep(200);

const steps = [
    ['SCORE_A2', () => sendPico('SCORE_A2')],
    ['SCORE_B3', () => sendPico('SCORE_B3')],
    ['FOUL A', () => admin.emit('ui_action', { type: 'FOUL', payload: { team: 'A' } })],
    ['TIMEOUT B', () => admin.emit('ui_action', { type: 'TIMEOUT', payload: { team: 'B' } })],
    ['CLOCK_TOGGLE (start)', () => sendPico('CLOCK_TOGGLE')],
];

let allMatched = true;
for (let i = 0; i < steps.length; i++) {
    const [label, trigger] = steps[i];
    trigger();
    await sleep(400);
    const liveText = await scoreboardText(liveGamePage);
    const specText = await scoreboardText(spectatorPage);
    const matched = liveText === specText;
    console.log(`  step ${i + 1} (${label}): identical scoreboard text on both screens: ${matched}`);
    if (!matched) {
        allMatched = false;
        console.log('    LIVE:', liveText);
        console.log('    SPEC:', specText);
    }
    await shotBoth(`sync-step-${i + 1}`);
}
console.log('ALL steps matched between LiveGame and Spectator:', allMatched);

// Stop the clock first — step 5 left it running, and its own CLOCK_TICK
// broadcasts would otherwise confound "did tapping cause a state_update"
// with "the clock is just still ticking on its own".
sendPico('CLOCK_TOGGLE');
await sleep(300);

console.log('\n=== Scenario 2: Spectator has zero interactive elements ===');
const buttonCount = await spectatorPage.locator('button').count();
const clickableCount = await spectatorPage.locator('[onclick], [role="button"]').count();
console.log('buttons on Spectator:', buttonCount, '(expect 0)');
console.log('other clickable-role elements on Spectator:', clickableCount, '(expect 0)');

// Attempt a "tap" at the center of the page and confirm it causes no
// state_update — nothing on this screen is wired to send anything.
let stateUpdateFired = false;
const specSocketProbe = ioClient('http://localhost:3001', { transports: ['websocket'] });
await new Promise((resolve) => specSocketProbe.on('connect', resolve));
// Every fresh connection gets ONE unsolicited state_update immediately on
// connect (daemon/index.js's io.on('connection', ...) — by design, so a
// reconnecting UI has current state right away). Drain that one before
// listening for "did the tap cause one" — otherwise the connection's own
// freebie broadcast is what trips this check, not the tap.
await new Promise((resolve) => specSocketProbe.once('state_update', resolve));
specSocketProbe.on('state_update', () => { stateUpdateFired = true; });
await spectatorPage.mouse.click(450, 250);
await sleep(500);
console.log('a state_update fired purely from tapping the spectator page:', stateUpdateFired, '(expect false)');
specSocketProbe.close();
await shotBoth('final');

await liveGamePage.close();
await spectatorPage.close();
await browser.close();
admin.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log('\nDONE. Screenshots in', SHOT_DIR);
if (!allMatched) { console.error('FAILED: LiveGame and Spectator diverged at some step.'); process.exit(1); }
if (buttonCount !== 0 || clickableCount !== 0) { console.error('FAILED: Spectator has interactive elements.'); process.exit(1); }
if (stateUpdateFired) { console.error('FAILED: tapping Spectator caused a state_update.'); process.exit(1); }
console.log('ALL CHECKS PASSED');
