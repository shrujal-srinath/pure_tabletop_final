import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { io as ioClient } from 'socket.io-client';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const DATA_DIR = path.join(ROOT, 'data-test-setup-e2e');
const SHOT_DIR = path.join(UI_ROOT, 'setup-e2e-shots');

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

// ═══ Scenario 1: quick mode — sends setup_game immediately, no roster ═══
console.log('=== Scenario 1: quick mode ===');
await page.goto('http://localhost:5173/setup', { waitUntil: 'domcontentloaded' });
await sleep(300);
await page.getByLabel('Name').first().fill('Rockets');
await page.getByLabel('Name').nth(1).fill('Warriors');
// gameMode select already defaults to 'quick' — leave as-is.
const statePromise1 = waitForStateActive(true);
await page.getByRole('button', { name: /Start game/ }).click();
const state1 = await statePromise1;
check('daemon received quick-mode setup_game and went active', state1.meta.gameActive === true);
check('gameMode is quick', state1.meta.gameMode === 'quick');
check('no roster — players arrays empty', state1.teamA.players.length === 0 && state1.teamB.players.length === 0);
await page.screenshot({ path: path.join(SHOT_DIR, '01-quick-mode-livegame.png') });

// End the game so the daemon accepts a fresh setup_game for scenario 2 (the
// gameActive guard in App.tsx would otherwise always route to LiveGame).
unlockTouch();
await sleep(200);
const endedPromise = waitForStateActive(false);
admin.emit('ui_action', { type: 'END_GAME' });
await endedPromise;
console.log();

// ═══ Scenario 2 + 3: stats mode — navigate to roster, block a duplicate
// jersey number, then fix it and submit the combined payload ═══
console.log('=== Scenario 2+3: stats mode, duplicate jersey number, then real submission ===');
await page.goto('http://localhost:5173/setup', { waitUntil: 'domcontentloaded' });
await sleep(300);
await page.getByLabel('Name').first().fill('Rockets');
await page.getByLabel('Name').nth(1).fill('Warriors');
await page.getByLabel('Game mode').selectOption('stats');
await page.getByRole('button', { name: /Continue to roster/ }).click();
await sleep(300);
const onRosterScreen = (await page.textContent('body')).includes('ROSTER SETUP');
check('MatchSetup navigated to RosterSetup instead of sending setup_game', onRosterScreen);
await page.screenshot({ path: path.join(SHOT_DIR, '02-roster-setup-empty.png') });

// Add two Team A players with the SAME jersey number — should be blocked.
async function addPlayer(fieldsetIndex, name, number) {
    const fieldset = page.locator('fieldset').nth(fieldsetIndex);
    await fieldset.getByPlaceholder('Name').fill(name);
    await fieldset.getByPlaceholder('#').fill(number);
    await fieldset.getByRole('button', { name: 'Add' }).click();
}
await addPlayer(0, 'Arjun', '7');
await addPlayer(0, 'Chetan', '7'); // duplicate on purpose
await page.getByRole('button', { name: 'Start game' }).click();
await sleep(300);
const dupText = await page.textContent('body');
check('duplicate jersey number blocked with an inline error', dupText.includes('duplicate jersey number'));
await page.screenshot({ path: path.join(SHOT_DIR, '03-duplicate-number-blocked.png') });

// Fix the duplicate, add a Team B player, submit for real.
await page.locator('fieldset').nth(0).getByRole('button', { name: 'remove' }).last().click(); // remove Chetan (#7 dupe)
await addPlayer(1, 'Bilal', '9');
await sleep(100);
const statePromise2 = waitForStateActive(true);
await page.getByRole('button', { name: 'Start game' }).click();
const state2 = await statePromise2;
check('combined setup_game went active in stats mode', state2.meta.gameActive === true && state2.meta.gameMode === 'stats');
check('teamA.players matches what was entered', state2.teamA.players.length === 1 && state2.teamA.players[0].name === 'Arjun' && state2.teamA.players[0].number === '7');
check('teamB.players matches what was entered', state2.teamB.players.length === 1 && state2.teamB.players[0].name === 'Bilal' && state2.teamB.players[0].number === '9');
await page.screenshot({ path: path.join(SHOT_DIR, '04-stats-mode-livegame.png') });

unlockTouch();
await sleep(200);
const endedPromise2 = waitForStateActive(false);
admin.emit('ui_action', { type: 'END_GAME' });
await endedPromise2;
console.log();

// ═══ Scenario 4: forced setup_error displayed inline ═══
console.log('=== Scenario 4: forced setup_error ===');
await page.goto('http://localhost:5173/setup', { waitUntil: 'domcontentloaded' });
await sleep(300);
// reduce()'s `const { type, payload = {} } = action` only defaults an
// UNDEFINED payload, not null — sending null causes a real TypeError inside
// reduce() (payload.periodMinutes on null), caught by the daemon's
// try/catch around dispatch(), which emits a real setup_error back to
// (only) the connection that sent it. Sent through the PAGE'S OWN live
// socket (via dynamic import of the same module Vite already served it),
// so the actual mounted MatchSetup component's listener receives it —
// not a side-channel probe pretending to be the daemon.
await page.evaluate(async () => {
    const mod = await import('/src/lib/socket.ts');
    mod.socket.emit('setup_game', null);
});
await sleep(400);
const errorText = await page.textContent('body');
check('setup_error displayed inline on MatchSetup', errorText.includes('Daemon rejected setup'));
await page.screenshot({ path: path.join(SHOT_DIR, '05-setup-error-inline.png') });

await page.close();
await browser.close();
admin.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log('\nDONE. Screenshots in', SHOT_DIR);
if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
