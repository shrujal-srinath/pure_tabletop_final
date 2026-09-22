// box-pi/ui/scripts/verify-shot-capture.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Real end-to-end verification of the shot-location flow: real daemon, real
// Vite server, real headless Chromium, real Socket.io traffic.
//
// The load-bearing check is SCENARIO 2. It taps a known PIXEL on the rendered
// court and asserts the coordinates that actually leave the browser on the
// wire match what shared/court-geometry.js says that point is. That is the one
// thing unit tests cannot cover: the engine can be perfect and the capture
// still wrong if the pixel→court mapping is off, and the failure would be
// invisible (every shot lands somewhere plausible, just not where the ref
// tapped). Frames are read off the WebSocket itself rather than from
// instrumented app code, so this observes what the daemon really receives.
//
// Run: node ui/scripts/verify-shot-capture.mjs
// Requires daemon/.env to exist (any SUPABASE_URL — cloud writes are expected
// to fail and queue here; this verifies the LAN path, not persistence).
// ═══════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { io as ioClient } from 'socket.io-client';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, '..');
const ROOT = path.resolve(UI_ROOT, '..');
const DATA_DIR = path.join(ROOT, 'data-test-shot-capture');
const SHOT_DIR = path.join(UI_ROOT, 'shot-capture-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) return true;
        } catch { /* not up yet */ }
        await sleep(300);
    }
    return false;
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Child stdout/stderr must go to real files — Node can buffer pipe writes
// internally and never flush them while the process stays alive.
const daemonLog = fs.openSync(path.join(DATA_DIR, 'daemon.log'), 'a');
const viteLog = fs.openSync(path.join(DATA_DIR, 'vite.log'), 'a');

console.log('--- booting real daemon ---');
const daemon = spawn('node', ['daemon/index.js', '--dev'], {
    cwd: ROOT,
    env: { ...process.env, BOX_PI_DATA_DIR: DATA_DIR },
    stdio: ['pipe', daemonLog, daemonLog],
});
const vite = spawn('npx', ['vite', '--port', '5178', '--strictPort'], {
    cwd: UI_ROOT, env: process.env, stdio: ['ignore', viteLog, viteLog],
});

let browser;
let failures = 0;
function ok(label) { console.log(`  ✓ ${label}`); }
function bad(label, detail) { failures++; console.log(`  ✗ ${label}\n      ${detail}`); }

async function cleanup() {
    if (browser) await browser.close().catch(() => {});
    daemon.kill('SIGKILL');
    vite.kill('SIGKILL');
    await sleep(200);
}

try {
    assert.ok(await waitForHttp('http://localhost:3001/socket.io/?EIO=4&transport=polling', 25000), 'daemon never came up');
    assert.ok(await waitForHttp('http://localhost:5178/', 40000), 'vite never came up');
    console.log('daemon + vite up\n');

    // Admin probe: sets the game up and unlocks touch, the way the physical
    // settings switch would.
    const probe = ioClient('http://localhost:3001');
    await new Promise((r) => probe.on('connect', r));

    // Use an already-installed Chromium when the environment provides one
    // whose build doesn't match what this Playwright version would fetch.
    const localChrome = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    browser = await chromium.launch(
        fs.existsSync(localChrome) ? { executablePath: localChrome } : {},
    );
    // The real panel size — precision behaviour depends on it.
    const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });

    page.on('pageerror', (err) => console.log('  [page error]', err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console error]', msg.text()); });

    // Read the actual Socket.io frames the browser sends.
    const sent = [];
    page.on('websocket', (ws) => {
        ws.on('framesent', (f) => {
            const payload = typeof f.payload === 'string' ? f.payload : f.payload.toString();
            const m = payload.match(/^42(.*)$/s);
            if (!m) return;
            try { sent.push(JSON.parse(m[1])); } catch { /* not a JSON event frame */ }
        });
    });
    const lastUiAction = (type) => [...sent].reverse().find((e) => e[0] === 'ui_action' && e[1]?.type === type)?.[1];

    await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
    // BootSplash holds for its full animation on a fresh session before the
    // app routes anywhere — wait it out rather than racing it.
    await page.waitForSelector('[data-testid="connection-status"]', { timeout: 40000 });
    console.log('booted to dashboard');

    // Set the game up only now, so the browser receives a real game_ready and
    // routes itself into LiveGame the way it does for an operator.
    probe.emit('setup_game', {
        teamAName: 'BMSCE', teamAColor: '#EF2B2D', teamBName: 'RVCE', teamBColor: '#4C86FF',
        periodMinutes: 10, shotClockSeconds: 24, periods: 4, gameMode: 'advanced',
        roster: {
            teamA: [{ id: 'p4', name: 'M. Carter', number: '4' }, { id: 'p7', name: 'D. Ruiz', number: '7' }],
            teamB: [{ id: 'b2', name: 'T. Novak', number: '2' }],
        },
    });
    // GAME_READY is emitted only to the socket that sent setup_game (here, the
    // probe), so this browser correctly treats the game as one it didn't start
    // and offers Dashboard's resume banner. Click through it — that is the
    // real operator path for a game started elsewhere.
    await page.waitForSelector('[data-testid="resume-banner"]', { timeout: 20000 });
    await page.click('[data-testid="resume-banner"] button');
    await page.waitForSelector('[data-testid="scoreboard"]', { timeout: 20000 });

    // Unlock touch only NOW. LiveGame mounts with touchUnlocked=false and
    // learns the real value only from a TOUCH_LOCK_STATUS broadcast, and the
    // daemon suppresses a no-op unlock (`if (touchUnlocked === next) return`),
    // so unlocking before this screen existed would leave its full-screen lock
    // overlay swallowing every tap.
    probe.emit('ui_action', { type: 'UNLOCK_TOUCH' });
    await page.waitForSelector('[data-testid="touch-lock-overlay"]', { state: 'detached', timeout: 8000 });
    console.log('live game mounted, touch unlocked\n');

    // Geometry of the rendered court, so we can convert court units → pixels
    // exactly the way the component converts the other way.
    async function courtBox() {
        return page.evaluate(() => {
            const el = document.querySelector('[data-testid="shot-court"]');
            const r = el.getBoundingClientRect();
            const LS_W = 188, LS_H = 100;
            const scale = Math.min(r.width / LS_W, r.height / LS_H);
            return {
                originX: r.left + (r.width - LS_W * scale) / 2,
                originY: r.top + (r.height - LS_H * scale) / 2,
                scale,
            };
        });
    }
    const toPixel = (box, lx, ly) => ({ x: box.originX + lx * box.scale, y: box.originY + ly * box.scale });

    // ── Scenario 1: a physical +2 opens the court ──────────────────────────
    console.log('─── 1. a physical score button opens the court ───');
    daemon.stdin.write('SCORE_A2\n');
    await page.waitForSelector('[data-testid="shot-capture"]', { timeout: 8000 });
    await page.waitForSelector('[data-testid="shot-court"]', { timeout: 4000 });
    ok('SCORE_A2 from the Pico opened the capture flow with a full court');
    await page.screenshot({ path: path.join(SHOT_DIR, '1-court-open.png') });

    // ── Scenario 2: the pixel→court→wire pipeline ─────────────────────────
    console.log('\n─── 2. tapped pixel → persisted coordinates ───');
    const box = await courtBox();
    // A deliberate, checkable spot: left-side paint, well inside the arc.
    const TARGET = { lx: 26, ly: 38 };
    const px = toPixel(box, TARGET.lx, TARGET.ly);

    await page.mouse.move(px.x, px.y);
    await page.mouse.down();
    await sleep(120);
    const readout = await page.textContent('[data-testid="zone-readout"]').catch(() => null);
    if (readout) ok(`live readout under the finger: "${readout.trim()}"`);
    else bad('live readout', 'no zone readout appeared while dragging');
    await page.screenshot({ path: path.join(SHOT_DIR, '2-loupe-drag.png') });
    await page.mouse.up();

    await page.waitForSelector('[data-testid="capture-player-p4"]', { timeout: 4000 });
    ok('release advanced to the player step');
    await page.click('[data-testid="capture-player-p4"]');
    await sleep(400);

    const attributed = lastUiAction('ATTRIBUTE_SHOT');
    if (!attributed) {
        bad('ATTRIBUTE_SHOT', 'no ATTRIBUTE_SHOT frame was sent');
    } else {
        // What the engine says that exact court point is.
        const { resolveTap } = await import(path.join(ROOT, 'shared/court-geometry.js'));
        const expected = resolveTap({ lx: TARGET.lx, ly: TARGET.ly, points: 2 });
        console.log(`    engine says (${TARGET.lx}, ${TARGET.ly}) → zone ${expected.zone}, x ${expected.x}, y ${expected.y}`);
        console.log(`    wire carried                → zone ${attributed.payload.zone}, x ${attributed.payload.x}, y ${attributed.payload.y}`);

        if (attributed.payload.zone === expected.zone) ok('zone on the wire matches the engine');
        else bad('zone mismatch', `expected ${expected.zone}, wire had ${attributed.payload.zone}`);

        // Sub-unit tolerance: 1 unit is 15 cm, so this asserts the mapping is
        // accurate to better than a tenth of a metre.
        const dx = Math.abs(attributed.payload.x - expected.x);
        const dy = Math.abs(attributed.payload.y - expected.y);
        if (dx < 0.5 && dy < 0.5) ok(`coordinates match within ${Math.max(dx, dy).toFixed(3)} units (<7.5 cm)`);
        else bad('coordinate drift', `off by x ${dx.toFixed(3)}, y ${dy.toFixed(3)} units`);

        if (attributed.payload.playerId === 'p4') ok('player credited correctly');
        else bad('player', `expected p4, got ${attributed.payload.playerId}`);
    }

    // ── Scenario 3: arc-side validation ───────────────────────────────────
    console.log('\n─── 3. a +3 tapped INSIDE the arc is rejected ───');
    const beforeReject = sent.filter((e) => e[0] === 'ui_action' && e[1]?.type === 'ATTRIBUTE_SHOT').length;
    daemon.stdin.write('SCORE_A3\n');
    await page.waitForSelector('[data-testid="shot-capture"]', { timeout: 8000 });

    const box3 = await courtBox();
    const insideArc = toPixel(box3, 30, 50); // squarely inside the left arc
    await page.mouse.move(insideArc.x, insideArc.y);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await sleep(300);

    const bounce = await page.textContent('[data-testid="capture-bounce"]').catch(() => null);
    if (bounce) ok(`bounced with: "${bounce.trim()}"`);
    else bad('arc validation', 'no bounce message appeared for a 3 tapped inside the arc');

    const stillOnCourt = await page.isVisible('[data-testid="shot-court"]');
    if (stillOnCourt) ok('stayed on the court instead of advancing');
    else bad('arc validation', 'advanced past the court despite an invalid tap');

    const afterReject = sent.filter((e) => e[0] === 'ui_action' && e[1]?.type === 'ATTRIBUTE_SHOT').length;
    if (afterReject === beforeReject) ok('nothing was sent to the daemon');
    else bad('arc validation', 'an ATTRIBUTE_SHOT was sent despite the rejection');
    await page.screenshot({ path: path.join(SHOT_DIR, '3-arc-rejected.png') });

    // The same shot beyond the arc is accepted.
    const beyondArc = toPixel(box3, 56, 50);
    await page.mouse.move(beyondArc.x, beyondArc.y);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await page.waitForSelector('[data-testid="capture-player-p4"]', { timeout: 4000 });
    ok('the same +3 beyond the arc is accepted');
    await page.click('[data-testid="capture-player-p4"]');
    await sleep(300);
    const three = lastUiAction('ATTRIBUTE_SHOT');
    if (three?.payload.zone?.startsWith('three_')) ok(`recorded as ${three.payload.zone}`);
    else bad('3pt zone', `expected a three_* zone, got ${three?.payload.zone}`);

    // ── Scenario 4: MISS ──────────────────────────────────────────────────
    console.log('\n─── 4. MISS capture ───');
    const scoreBefore = await page.textContent('[data-testid="scoreboard"]');
    await page.click('[data-testid="miss-BMSCE"]');
    await page.waitForSelector('[data-testid="shot-capture"]', { timeout: 6000 });

    const missSent = lastUiAction('SHOT_MISS');
    if (missSent) ok('SHOT_MISS reached the daemon');
    else bad('SHOT_MISS', 'no SHOT_MISS frame was sent');

    const bannerText = await page.textContent('[data-testid="shot-capture"]');
    if (bannerText.includes('MISS')) ok('capture shows MISS language, not a score');
    else bad('miss banner', 'the flow did not identify itself as a miss');
    await page.screenshot({ path: path.join(SHOT_DIR, '4-miss-court.png') });

    // A miss has no button value, so its location must decide: tap beyond the
    // arc and expect a 3-point ATTEMPT.
    const box4 = await courtBox();
    const missSpot = toPixel(box4, 56, 50);
    await page.mouse.move(missSpot.x, missSpot.y);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await page.waitForSelector('[data-testid="capture-player-p7"]', { timeout: 4000 });
    await page.click('[data-testid="capture-player-p7"]');
    await sleep(400);

    const missAttr = lastUiAction('ATTRIBUTE_SHOT');
    if (missAttr?.payload.points === 3) ok('the miss was recorded as a 3-point attempt, derived from its location');
    else bad('miss attempt value', `expected points 3 from the location, got ${missAttr?.payload.points}`);

    const scoreAfter = await page.textContent('[data-testid="scoreboard"]');
    if (scoreAfter === scoreBefore) ok('the score did not change');
    else bad('miss scoring', 'the scoreboard changed when recording a miss');

    // ── Scenario 5: on-court quick spots snap ─────────────────────────────
    console.log('\n─── 5. quick spots snap on the court ───');
    daemon.stdin.write('SCORE_B2\n');
    await page.waitForSelector('[data-testid="shot-capture"]', { timeout: 8000 });
    const box5 = await courtBox();
    // Tap NEAR the rim but not exactly on it — the snap should still land it
    // at the basket rather than "somewhere near the basket".
    const nearRim = toPixel(box5, 13, 53);
    await page.mouse.move(nearRim.x, nearRim.y);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await page.waitForSelector('[data-testid="capture-player-b2"]', { timeout: 4000 });
    await page.click('[data-testid="capture-player-b2"]');
    await sleep(300);
    const rimShot = lastUiAction('ATTRIBUTE_SHOT');
    if (rimShot?.payload.zone === 'at_rim') ok('a tap near the basket snapped to at_rim');
    else bad('rim snap', `expected at_rim, got ${rimShot?.payload.zone}`);

    // ── Scenario 6: the corner 3 must be reachable ────────────────────────
    // This is the regression that the first screenshots exposed: the chip bar
    // was floating over the bottom of the court, and ly 94–100 — which is
    // exactly where corner 3s live — sat underneath it. The tap hit the bar,
    // not the court, so a bottom corner 3 was physically uncapturable.
    console.log('\n─── 6. the bottom corner 3 is reachable ───');
    daemon.stdin.write('SCORE_A3\n');
    await page.waitForSelector('[data-testid="shot-capture"]', { timeout: 8000 });
    const box6 = await courtBox();
    const bottomCorner = toPixel(box6, 5, 97); // left basket, bottom corner stripe
    await page.mouse.move(bottomCorner.x, bottomCorner.y);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();

    const reachedPlayer = await page.waitForSelector('[data-testid="capture-player-p4"]', { timeout: 4000 }).then(() => true).catch(() => false);
    if (reachedPlayer) {
        ok('the bottom corner is tappable — nothing is covering the court');
        await page.click('[data-testid="capture-player-p4"]');
        await sleep(300);
        const corner = lastUiAction('ATTRIBUTE_SHOT');
        if (corner?.payload.zone === 'three_corner_right') ok(`recorded as ${corner.payload.zone}`);
        else bad('corner 3 zone', `expected three_corner_right, got ${corner?.payload.zone}`);
    } else {
        bad('corner 3 reachability', 'the bottom corner tap never reached the court');
    }
    await page.screenshot({ path: path.join(SHOT_DIR, '5-corner-reachable.png') });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(failures === 0 ? 'ALL SCENARIOS PASSED' : `${failures} CHECK(S) FAILED`);
    console.log(`screenshots: ${SHOT_DIR}`);
    console.log('═'.repeat(60));
} catch (err) {
    failures++;
    console.error('\nFATAL:', err.message);
    try { console.error('--- daemon log tail ---\n' + fs.readFileSync(path.join(DATA_DIR, 'daemon.log'), 'utf8').split('\n').slice(-25).join('\n')); } catch {}
} finally {
    await cleanup();
}
process.exit(failures === 0 ? 0 : 1);
