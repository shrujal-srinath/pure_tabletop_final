import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { io as ioClient } from 'socket.io-client';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const DATA_DIR = path.join(ROOT, 'data-test-livegame-e2e');
const SHOT_DIR = path.join(UI_ROOT, 'livegame-e2e-shots');

function killPort(port) {
    try {
        const pids = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').filter(Boolean);
        for (const pid of pids) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(port, timeoutMs) {
    // Plain HTTP against the Engine.IO handshake endpoint — same reliable
    // fetch-based polling as the Vite readiness check below. A fresh
    // socket.io-client per retry attempt turned out to be flaky here (the
    // daemon was confirmed actually listening via `lsof` while every client
    // handshake attempt still reported failure) — not worth chasing further
    // when a plain fetch is simpler and already proven to work.
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

// Real file, NOT stdio:'pipe' — a spawned child's stdout can sit buffered
// inside Node/libuv indefinitely when it's a genuine OS pipe with a JS-side
// 'data' consumer (confirmed directly during Task 6a: identical code hangs
// with 'pipe' and works instantly with 'inherit' or a real file). Files
// don't have this ambiguity.
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
const readDaemonLog = () => (fs.existsSync(daemonLogPath) ? fs.readFileSync(daemonLogPath, 'utf8') : '');
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

// However this script exits — success, thrown error, whatever — make sure
// the daemon/vite children don't outlive it and squat on :3001/:5173 for
// the next run (this bit us directly: a crashed earlier attempt left a
// daemon process listening, which every later run's readiness check then
// failed against in a way that looked like "the daemon never starts").
process.on('exit', () => {
    try { daemonProc.kill('SIGKILL'); } catch {}
    try { viteProc.kill('SIGKILL'); } catch {}
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('console', (msg) => { if (msg.text().startsWith('[ui]')) console.log('  browser:', msg.text().slice(0, 140)); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await sleep(500);

// A second raw socket used to inject Pico-vocabulary-shaped actions where
// the UI test itself doesn't need to click anything, and to unlock touch
// for scenarios that need interactive controls to work at all.
const admin = ioClient('http://localhost:3001', { transports: ['websocket'] });
await new Promise((resolve) => admin.on('connect', resolve));

function setupGame(gameMode, extra = {}) {
    admin.emit('setup_game', {
        teamAName: 'Rockets', teamAColor: '#EF4444', teamBName: 'Warriors', teamBColor: '#3B82F6',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode,
        roster: { teamA: [{ id: 'pA1', name: 'Arjun', number: '7' }], teamB: [{ id: 'pB1', name: 'Bilal', number: '9' }] },
        ...extra,
    });
}
function unlockTouch() { admin.emit('ui_action', { type: 'UNLOCK_TOUCH' }); }
function sendPico(line) { daemonProc.stdin.write(line + '\n'); }

async function shot(name) {
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
    console.log(`  [screenshot] ${name}.png`);
}

// ═══ Scenario 1: quick mode — instant render, no popup ═══
console.log('\n=== Scenario 1: quick mode ===');
setupGame('quick');
await sleep(300);
unlockTouch();
await sleep(200);
sendPico('SCORE_A2');
await sleep(400);
const scoreText1 = await page.textContent('body');
console.log('teamA score visible immediately:', scoreText1.includes('2'));
console.log('no attribution popup present:', !scoreText1.includes('who scored'));
await shot('01-quick-mode-instant-score');

await page.getByRole('button', { name: 'FOUL' }).first().click();
await sleep(200);
await shot('01b-quick-mode-foul-picker-noplayer-allowed');
await page.getByText('No player (team only)').click();
await sleep(300);
const afterFoul1 = await page.textContent('body');
console.log('foul count incremented (quick mode, no player):', afterFoul1.includes('Fouls: 1'));

await page.getByRole('button', { name: /^TIMEOUT$/ }).first().click();
await sleep(300);
const afterTimeout1 = await page.textContent('body');
console.log('timeout count decremented:', afterTimeout1.includes('Timeouts: 1'));
await shot('01c-quick-mode-after-foul-and-timeout');

// ═══ Scenario 2: stats mode — attribution popup, pick + timeout fallback ═══
console.log('\n=== Scenario 2: stats mode ===');
setupGame('stats');
await sleep(300);
unlockTouch();
await sleep(200);
sendPico('SCORE_A2');
await sleep(400);
await shot('02-stats-mode-attribution-popup');
const popupText = await page.textContent('body');
console.log('popup shows countdown:', /closing in \d+s/.test(popupText));
console.log('popup shows correct team+points:', popupText.includes('Rockets +2'));

console.log('  waiting out the 8s timeout deliberately...');
await sleep(8500);
const afterTimeoutPopup = await page.textContent('body');
console.log('popup gone after timeout (sent nothing):', !afterTimeoutPopup.includes('who scored'));
await shot('02b-stats-mode-after-deliberate-timeout');

sendPico('SCORE_B3');
await sleep(400);
await shot('02c-stats-mode-second-popup-before-pick');
await page.getByText('#9 Bilal').click();
await sleep(300);
const afterPick = await page.textContent('body');
console.log('popup closed immediately after picking a player:', !afterPick.includes('who scored'));
await shot('02d-stats-mode-after-player-pick');

// ═══ Scenario 3: advanced mode — court-tap, confirm-before-commit ═══
console.log('\n=== Scenario 3: advanced mode ===');
const daemonLogBeforeAdvanced = readDaemonLog().length;
setupGame('advanced');
await sleep(300);
unlockTouch();
await sleep(200);
// A+1, deliberately distinct from scenario 2's B+3 — the retry queue can
// re-log an earlier attempt's "shot_events" line on its own 15s timer
// (only the anon key is present, so every write is queued forever), which
// would otherwise make an identical team+points combo ambiguous in the log.
sendPico('SCORE_A1');
await sleep(400);
await shot('03-advanced-mode-court-tap-prompt');

const court = page.getByTestId('court-tap-surface');
const box = await court.boundingBox();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5); // tap near-left
await sleep(300);
await shot('03b-advanced-mode-confirm-side');
const confirmText = await page.textContent('body');
console.log('shows confirm-side step with a flip control:', confirmText.includes('Confirm shot side'));

// Nothing should have reached the daemon yet (no ATTRIBUTE_SHOT-triggered
// shot_events write attempt logged) purely from tapping the court.
const logAfterTapOnly = readDaemonLog().slice(daemonLogBeforeAdvanced);
console.log('daemon received NO shot_events write attempt from the tap alone:', !logAfterTapOnly.includes('shot_events A+1'));

await page.getByTestId('flip-side-button').click();
await sleep(200);
const flippedText = await page.textContent('body');
console.log('flip toggled the displayed side:', flippedText.includes('far basket') || flippedText.includes('currently: far'));
await shot('03c-advanced-mode-after-flip');

const logAfterFlipOnly = readDaemonLog().slice(daemonLogBeforeAdvanced);
console.log('daemon still received nothing after flip alone:', !logAfterFlipOnly.includes('shot_events A+1'));

await page.getByText('#7 Arjun').click();
await sleep(500);
const logAfterConfirm = readDaemonLog().slice(daemonLogBeforeAdvanced);
console.log('daemon attempted a shot_events write ONLY after player confirm:', logAfterConfirm.includes('shot_events A+1'));
await shot('03d-advanced-mode-after-confirm');

// ═══ Scenario 4: timeout button disabled at zero ═══
console.log('\n=== Scenario 4: timeout exhausted ===');
setupGame('quick');
await sleep(300);
unlockTouch();
await sleep(200);
admin.emit('ui_action', { type: 'TIMEOUT', payload: { team: 'A' } });
await sleep(150);
admin.emit('ui_action', { type: 'TIMEOUT', payload: { team: 'A' } });
await sleep(400);
const teamAButtons = page.locator('button', { hasText: 'TIMEOUT' });
const isDisabled = await teamAButtons.first().isDisabled();
console.log('Team A timeout button disabled at 0 remaining:', isDisabled);
await shot('04-timeout-button-disabled');

// ═══ Scenario 5: touch-lock stops interaction immediately ═══
console.log('\n=== Scenario 5: touch-lock ===');
sendPico('SETTINGS'); // toggles TOUCH_LOCK_TOGGLE -> should LOCK (was unlocked)
await sleep(400);
await shot('05-touch-lock-engaged');
const lockedBodyText = await page.textContent('body');
console.log('lock banner visible:', lockedBodyText.includes('LOCKED'));

const foulsBefore = (await page.textContent('body')).match(/Fouls: (\d+)/)[1];
let interceptedError = null;
try {
    await page.getByRole('button', { name: 'FOUL' }).first().click({ timeout: 1500 });
} catch (e) {
    interceptedError = e;
}
console.log('click was blocked by the touch-lock overlay (Playwright refused the click):', Boolean(interceptedError));
await sleep(300);
const foulsAfter = (await page.textContent('body')).match(/Fouls: (\d+)/)[1];
console.log('fouls unchanged after the blocked click:', foulsBefore === foulsAfter);
await shot('05b-touch-lock-click-blocked');

await browser.close();
daemonProc.kill('SIGTERM');
viteProc.kill('SIGTERM');
admin.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log('\nALL SCENARIOS RUN. Screenshots in', SHOT_DIR);
