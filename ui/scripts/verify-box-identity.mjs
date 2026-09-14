// box-pi/ui/scripts/verify-box-identity.mjs
// Verification for the box-identity / online QR setup / remote-assignment
// task — real daemon (BOX_PI_TEST_ENABLE_BOX_IDENTITY=1, so it genuinely
// registers/heartbeats/subscribes against the live box_units table — see
// daemon/index.js's own header comment for why that flag exists: box_units,
// unlike games/game_actions, has RLS open to the anon key, so an
// un-gated daemon would otherwise write a real junk row on every ordinary
// test run), real Vite, real headless Chromium.
//
// What this script covers automatically, safely, with only the anon key
// (no service-role access needed): box code persistence across a
// restart, live registration + real 8s heartbeat against box_units,
// Dashboard's QR rendering, a simulated remote assignment via the real
// broadcast channel (box-signal:{code}, event game_assigned — exactly
// what the website's real assignGameToBox() sends), the confirm popup
// appearing without disrupting an in-progress Match Setup form, "Continue
// manual setup" correctly dismissing without side effects, duplicate
// delivery not re-prompting, and the active-game guardrail.
//
// What this script does NOT cover (and why): a genuinely successful
// "Load" — reconstructing real score/roster/clock data from a `games`
// row — requires a service-role SQL insert into `games` (RLS blocks the
// anon key from writing games.data at all, same as every other cloud
// write in this codebase). That path WAS verified live this session,
// with cleanup, via direct SQL (this repo's daemon has no service-role
// credentials to embed in a committed script for it) — same category of
// gap as Task 5's own live write-path test. This script instead uses a
// gameCode with NO matching games row for its assignment scenarios,
// which is sufficient to exercise the popup/guardrail/dedup machinery
// and doubles as the "malformed assignment fails gracefully" check.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const ROOT = '/Users/shrujalsrinath/Desktop/box-pi';
const UI_ROOT = path.join(ROOT, 'ui');
const SHOT_DIR = path.join(UI_ROOT, 'box-identity-e2e-shots');

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
function startDaemon(dataDir, extraEnv = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const proc = spawn('node', ['daemon/index.js', '--dev'], {
        cwd: ROOT,
        env: { ...process.env, BOX_PI_DATA_DIR: dataDir, BOX_PI_TEST_ENABLE_BOX_IDENTITY: '1', ...extraEnv },
        stdio: ['pipe', logFd, logFd],
    });
    fs.closeSync(logFd);
    proc.logPath = logPath;
    proc.dataDir = dataDir;
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
function readBoxCode(proc) { return fs.readFileSync(path.join(proc.dataDir, 'box-code.txt'), 'utf8').trim(); }
async function waitForLog(proc, pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pattern.test(fs.readFileSync(proc.logPath, 'utf8'))) return true;
        await sleep(200);
    }
    return false;
}
function logContent(proc) { return fs.readFileSync(proc.logPath, 'utf8'); }

// Real anon-key client (same credentials the daemon itself uses) — only
// ever used here to send broadcasts (unrestricted) or read box_units
// (RLS-permitted for anon). Never writes to `games`.
const supabase = createClient(
    'https://eoowagimooxsqcrrihbw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvb3dhZ2ltb294c3FjcnJpaGJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MDIwOTAsImV4cCI6MjA4Njk3ODA5MH0.goB7TMo3Sv3RQhez4kjvGLzikBz37XB3OZV-cRmUXn0',
    { auth: { persistSession: false } },
);
async function sendAssignmentBroadcast(boxCode, gameCode) {
    const channel = supabase.channel(`box-signal:${boxCode}`);
    await channel.subscribe();
    await sleep(400);
    await channel.send({ type: 'broadcast', event: 'game_assigned', payload: { game_code: gameCode } });
    await sleep(300);
    await supabase.removeChannel(channel);
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
const dir = path.join(ROOT, 'data-test-box-identity');
fs.rmSync(dir, { recursive: true, force: true });

console.log('--- booting Vite dev server ---');
const viteProc = spawn('npx', ['vite', '--port', '5173'], { cwd: UI_ROOT, stdio: 'ignore' });
if (!(await waitForHttp('http://localhost:5173/', 20000))) throw new Error('vite never came up');
console.log('vite up.\n');

const browser = await chromium.launch();
let daemonProc = null;
let testBoxCode = null;
process.on('exit', () => {
    try { viteProc.kill('SIGKILL'); } catch {}
    try { daemonProc?.kill('SIGKILL'); } catch {}
    try { browser.close(); } catch {}
    // Best-effort live cleanup even on an early throw — a box code
    // generated by this script has no reason to linger in production.
    if (testBoxCode) {
        supabase.from('box_units').delete().eq('box_code', testBoxCode).then(() => {}, () => {});
    }
});

// ═══ Part 1: box code persists across a restart; live registration + heartbeat ═══
console.log('=== Part 1: box code persistence + live registration + 8s heartbeat ===');
daemonProc = startDaemon(dir);
if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon (first boot) never came up');
const boxCodeFirst = readBoxCode(daemonProc);
testBoxCode = boxCodeFirst;
console.log(`  generated box code: ${boxCodeFirst}`);
check('box code is 4 uppercase alphanumeric chars from the real game-code alphabet', /^[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{4}$/.test(boxCodeFirst));
check('registration against the live box_units table succeeded', await waitForLog(daemonProc, /\[box-identity\] registered as/, 10000));

const { data: row1 } = await supabase.from('box_units').select('box_code, game_code, status, last_seen').eq('box_code', boxCodeFirst).maybeSingle();
check('row exists in the live box_units table with the expected shape', !!row1 && row1.status === 'waiting' && row1.game_code === null);
const lastSeenAt1 = row1?.last_seen;

await sleep(9000); // past one full 8s heartbeat interval
const { data: row2 } = await supabase.from('box_units').select('last_seen').eq('box_code', boxCodeFirst).maybeSingle();
check('last_seen advanced by roughly one real heartbeat interval (~8s)', row2 && lastSeenAt1 && row2.last_seen - lastSeenAt1 >= 6000);

daemonProc.kill('SIGKILL');
await sleep(500);
killPort(3001);
daemonProc = startDaemon(dir);
if (!(await waitForDaemonReady(daemonProc, 20000))) throw new Error('daemon (restart) never came up');
const boxCodeSecond = readBoxCode(daemonProc);
check('box code is identical across a restart (never regenerated)', boxCodeFirst === boxCodeSecond);
console.log();

// ═══ Part 2: Dashboard QR ═══
console.log('=== Part 2: Dashboard QR encodes the real box code ===');
{
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="online-setup-qr"]', { timeout: 15000 });
    const text = await page.getByTestId('online-setup-qr').textContent();
    check('QR panel shows the real box code', text.includes(boxCodeFirst));
    check('QR panel shows the real setup base URL', text.includes('theboxbybmsce.in/setup'));
    check('an actual SVG QR code rendered (not placeholder text)', (await page.locator('[data-testid="online-setup-qr"] svg').count()) > 0);
    await page.screenshot({ path: path.join(SHOT_DIR, '01-dashboard-qr.png') });
    await page.close();
}
console.log();

// ═══ Part 3: malformed assignment while idle — popup, graceful failure, dedup ═══
console.log('=== Part 3: malformed assignment (no matching games row) — graceful failure + dedup ===');
{
    const BAD_CODE = 'ZZFK';
    await sendAssignmentBroadcast(boxCodeFirst, BAD_CODE);
    check('daemon surfaced the assignment', await waitForLog(daemonProc, new RegExp(`remote game available: ${BAD_CODE}`), 5000));

    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h2:has-text("REMOTE GAME AVAILABLE")', { timeout: 10000 });
    const popupText = await page.textContent('body');
    check('popup shows the correct gameCode', popupText.includes(BAD_CODE));
    await page.screenshot({ path: path.join(SHOT_DIR, '02-popup.png') });

    await page.getByRole('button', { name: 'Load' }).click();
    await sleep(1000);
    check('daemon logged the missing-row failure, did not crash', await waitForLog(daemonProc, new RegExp(`no games row found for ${BAD_CODE}`), 5000));
    const bodyAfterLoad = await page.textContent('body');
    check('local UI still functional after the failed load (not crashed/blank)', bodyAfterLoad.includes('THE BOX'));
    await page.close();

    // Dedup — a fresh connection must not see the same (already-resolved) assignment again.
    const page2 = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page2.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const body2 = await page2.textContent('body');
    check('a fresh connection after resolution does not re-see the same assignment (dedup)', !body2.includes('REMOTE GAME AVAILABLE'));
    await page2.close();
}
console.log();

// ═══ Part 4: mid-Match-Setup — popup doesn't disrupt the form ═══
console.log('=== Part 4: assignment mid-Match-Setup — form preserved, dismiss is clean ===');
{
    const MID_CODE = 'ZZFL';
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.goto('http://localhost:5173/setup', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    await page.getByLabel('Name').first().fill('MidSetupTeamA');
    await page.getByLabel('Name').nth(1).fill('MidSetupTeamB');

    await sendAssignmentBroadcast(boxCodeFirst, MID_CODE);
    await page.waitForSelector('h2:has-text("REMOTE GAME AVAILABLE")', { timeout: 10000 });
    check('form field untouched while the popup is showing', (await page.getByLabel('Name').first().inputValue()) === 'MidSetupTeamA');
    await page.screenshot({ path: path.join(SHOT_DIR, '03-midsetup-popup.png') });

    await page.getByRole('button', { name: 'Continue manual setup' }).click();
    await sleep(300);
    const bodyAfterDismiss = await page.textContent('body');
    check('popup gone after "Continue manual setup"', !bodyAfterDismiss.includes('REMOTE GAME AVAILABLE'));
    check('form field STILL untouched after dismiss', (await page.getByLabel('Name').first().inputValue()) === 'MidSetupTeamA');
    await page.close();
}
console.log();

// ═══ Part 5: active-game guardrail ═══
console.log('=== Part 5: a stray assignment never interrupts an active local game ===');
{
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.goto('http://localhost:5173/setup', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    await page.getByLabel('Name').first().fill('GuardrailTeamA');
    await page.getByLabel('Name').nth(1).fill('GuardrailTeamB');
    await page.getByRole('button', { name: /Start game/ }).click();
    await page.waitForSelector('[data-testid="scoreboard"]', { timeout: 10000 });

    const STRAY_CODE = 'ZZFM';
    await sendAssignmentBroadcast(boxCodeFirst, STRAY_CODE);
    await sleep(1500);
    check('daemon explicitly ignored the stray assignment (guardrail)', await waitForLog(daemonProc, new RegExp(`ignoring remote assignment ${STRAY_CODE} — already in an active game`), 4000));
    const body = await page.textContent('body');
    check('the active game is still showing — not interrupted', body.includes('GuardrailTeamA') || (await page.getByTestId('scoreboard').count()) > 0);
    await page.screenshot({ path: path.join(SHOT_DIR, '04-guardrail-livegame-untouched.png') });
    await page.close();
}

await browser.close();
killPort(3001);
killPort(5173);
fs.rmSync(dir, { recursive: true, force: true });
await supabase.from('box_units').delete().eq('box_code', boxCodeFirst);
console.log(`\ncleaned up live box_units row ${boxCodeFirst}.`);

console.log('\nDONE. Screenshots in', SHOT_DIR);
if (!allOk) { console.error('SOME CHECKS FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
