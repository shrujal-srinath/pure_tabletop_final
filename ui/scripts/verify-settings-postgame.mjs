import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { io as ioClient } from 'socket.io-client';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const DATA_DIR = path.join(ROOT, 'data-test-settings-postgame-e2e');
const SHOT_DIR = path.join(UI_ROOT, 'settings-postgame-e2e-shots');

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
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.on('console', (msg) => { if (msg.text().startsWith('[ui]')) console.log('  browser:', msg.text().slice(0, 140)); });

const admin = ioClient('http://localhost:3001', { transports: ['websocket'] });
await new Promise((resolve) => admin.on('connect', resolve));
function unlockTouch() { admin.emit('ui_action', { type: 'UNLOCK_TOUCH' }); }
function sendPico(line) { daemonProc.stdin.write(line + '\n'); }

async function waitForStateActive(active) {
    return new Promise((resolve) => {
        const check = (s) => { if (s.meta.gameActive === active) { admin.off('state_update', check); resolve(s); } };
        admin.on('state_update', check);
    });
}

let allOk = true;
function check(label, ok) {
    console.log(`  ${ok ? 'OK' : 'FAIL'} — ${label}`);
    if (!ok) allOk = false;
}

// ── Get a live quick-mode game going ────────────────────────────────────
console.log('=== Setup: start a quick-mode game ===');
await page.goto('http://localhost:5173/setup', { waitUntil: 'domcontentloaded' });
await sleep(300);
await page.getByLabel('Name').first().fill('Rockets');
await page.getByLabel('Name').nth(1).fill('Warriors');
await page.getByRole('button', { name: /Start game/ }).click();
// Wait for the BROWSER's own LiveGame to actually be mounted (scoreboard
// present) before unlocking — not the admin probe's independent
// state_update, which can resolve before the browser has additionally
// received and processed the separately-sent game_ready event. Racing
// ahead on the admin socket's copy can catch the browser mid-transition
// (briefly still showing Setup, since App.tsx's LiveGame condition needs
// both gameActive AND confirmedLive/game_ready) and unlock a screen that
// hasn't mounted yet — its real mount moments later starts fresh with
// touchUnlocked back at its default `false`, silently relocking.
await page.waitForSelector('[data-testid="scoreboard"]', { timeout: 5000 });
unlockTouch();
// Wait for the browser's own socket to actually receive touch_lock_status
// and drop the overlay, rather than a fixed sleep that can race under load.
await page.waitForSelector('[data-testid="touch-lock-overlay"]', { state: 'detached', timeout: 5000 });
sendPico('SCORE_A2');
await sleep(300);
sendPico('SCORE_B3');
await sleep(300);
console.log();

// ═══ Scenario 1: open/close Settings has no side effects ═══
console.log('=== Scenario 1: open + close Settings, Live Game unaffected ===');
const beforeOpen = await page.getByTestId('scoreboard').textContent();
await page.getByRole('button', { name: '⚙ SETTINGS' }).click();
await sleep(200);
await page.screenshot({ path: path.join(SHOT_DIR, '01-settings-open.png') });
// Note: the "⚙ SETTINGS" button itself always contains the substring
// "SETTINGS" on the page, open or closed — checking for the heading
// specifically (not a body-text substring) is what actually distinguishes
// overlay-open from overlay-closed.
const settingsVisible = (await page.getByRole('heading', { name: 'SETTINGS' }).count()) > 0;
check('Settings overlay visible after clicking the button', settingsVisible);

await page.getByRole('button', { name: 'Close' }).click();
await sleep(200);
const afterClose = await page.getByTestId('scoreboard').textContent();
check('scoreboard unchanged after opening+closing Settings', beforeOpen === afterClose);
const settingsGone = (await page.getByRole('heading', { name: 'SETTINGS' }).count()) === 0;
check('Settings overlay gone after Close', settingsGone);
await page.screenshot({ path: path.join(SHOT_DIR, '02-settings-closed.png') });
console.log();

// ═══ Scenario 2: End Game requires explicit confirmation ═══
console.log('=== Scenario 2: End Game requires confirmation, not a single tap ===');
await page.getByRole('button', { name: '⚙ SETTINGS' }).click();
await sleep(200);
await page.getByRole('button', { name: 'End Game', exact: true }).click();
await sleep(200);
await page.screenshot({ path: path.join(SHOT_DIR, '03-end-game-confirm-step.png') });
const confirmStepShown = (await page.textContent('body')).includes("can't be undone");
check('a confirm step is shown, game not ended by the first tap alone', confirmStepShown);

// Confirm the game is STILL active — the single tap on "End Game" (opening
// the confirm step) must not itself have ended anything.
const stillActiveAfterFirstTap = await page.getByTestId('scoreboard').count(); // LiveGame still mounted
check('Live Game still mounted after the first End Game tap (not yet ended)', stillActiveAfterFirstTap > 0);

const endedPromise = waitForStateActive(false);
await page.getByRole('button', { name: 'Yes, end game' }).click();
const endedState = await endedPromise;
console.log();

// ═══ Scenario 3: Post-Game shows the correct final numbers ═══
console.log('=== Scenario 3: Post-Game shows accurate final data ===');
await sleep(500);
await page.screenshot({ path: path.join(SHOT_DIR, '04-post-game.png') });
const postGameText = await page.getByTestId('final-scoreboard').textContent();
check('Post-Game shown (FINAL heading present)', (await page.textContent('body')).includes('FINAL'));
check(`final teamA score (${endedState.teamA.score}) shown on Post-Game`, postGameText.includes(String(endedState.teamA.score)));
check(`final teamB score (${endedState.teamB.score}) shown on Post-Game`, postGameText.includes(String(endedState.teamB.score)));
console.log(`  (last known state before game_ended: teamA=${endedState.teamA.score} teamB=${endedState.teamB.score}, period ${endedState.clock.period})`);
console.log();

// ═══ Scenario 4: Return to Dashboard leads into a genuinely clean new game ═══
console.log('=== Scenario 4: Return to Dashboard -> clean new game, no leftover state ===');
await page.getByRole('button', { name: 'Return to Dashboard' }).click();
// Task 6f made Dashboard the real landing screen — Return to Dashboard
// navigates to `/` (Dashboard itself), not directly to `/setup` anymore;
// reaching Match Setup from there is Dashboard's own "Start New Game" button.
await page.waitForFunction(() => document.body.textContent?.includes('Start New Game'), { timeout: 8000 });
await page.getByRole('button', { name: /Start New Game/ }).click();
await page.waitForURL('**/setup', { timeout: 5000 });
await sleep(300);
const setupFieldsEmpty = (await page.getByLabel('Name').first().inputValue()) === '';
check('MatchSetup fields are empty (not pre-filled from the previous game)', setupFieldsEmpty);

// Start a genuinely new game and confirm it has a fresh score (0-0), not
// anything bled over from the previous game.
await page.getByLabel('Name').first().fill('Celtics');
await page.getByLabel('Name').nth(1).fill('Lakers');
const freshActivePromise = waitForStateActive(true);
await page.getByRole('button', { name: /Start game/ }).click();
const freshState = await freshActivePromise;
check('new game starts at 0-0 (no leftover score)', freshState.teamA.score === 0 && freshState.teamB.score === 0);
check('new game has the new team names, not the old ones', freshState.teamA.name === 'Celtics' && freshState.teamB.name === 'Lakers');
check('new game is a fresh period 1', freshState.clock.period === 1);
await page.screenshot({ path: path.join(SHOT_DIR, '05-fresh-game-after-return.png') });

await page.close();
await browser.close();
admin.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log('\nDONE. Screenshots in', SHOT_DIR);
if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
