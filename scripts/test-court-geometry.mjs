// box-pi/scripts/test-court-geometry.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Golden tests for shared/court-geometry.js — the most load-bearing math this
// device owns. Shot capture, persistence, the website's stats engine, its
// heatmaps and the Flutter app all depend on classifyZone behaving EXACTLY
// like this.
//
// These cases are ported from the website's own golden suites
// (BOXV2-TEST @ 3188b59: src/components/shotchart/courtZones.test.ts and
// src/components/refereebox/court/CourtGeometry.test.ts) so a drift between
// the two repos fails HERE rather than silently re-binning live shots.
//
// If one of these fails you changed shot-analytics semantics — don't "fix"
// the test, fix the code (or change both repos deliberately, together).
//
// Run: node scripts/test-court-geometry.mjs
// ═══════════════════════════════════════════════════════════════════════════

import {
    COURT, ZONES, LS_W, LS_H, BX_L, BX_R, BY, QUICK_SPOTS,
    classifyZone, classifyLandscape, rimDistance,
    landscapeToPortrait, portraitToLandscape, landscapeToDepth,
    isBeyondArc, buildAndAnnotateGrid, buildSpatialIndex, nearest,
    resolveTap, freeThrowLocation, unlocatedLocation, mirrorQuickSpot,
} from '../shared/court-geometry.js';

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
    const ok = actual === expected;
    if (ok) {
        passed++;
    } else {
        failed++;
        console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function checkClose(label, actual, expected, tol = 0.05) {
    const ok = Math.abs(actual - expected) <= tol;
    if (ok) {
        passed++;
    } else {
        failed++;
        console.log(`  ✗ ${label}\n      expected ≈${expected} (±${tol}), got ${actual}`);
    }
}

function section(name) {
    console.log(`\n─── ${name} ───`);
}

// ── 1. classifyZone goldens (portrait half-court) ──────────────────────────
section('classifyZone goldens (portrait 0-100 × 0-94)');

const zoneCases = [
    [50, 10.5, 'at_rim'],            // basket centre
    [50, 11.9, 'at_rim'],            // within the 1.6u dunk radius
    [50, 16, 'restricted'],          // inside the no-charge arc
    [40, 26, 'paint_left'],
    [60, 26, 'paint_right'],
    [20, 14, 'mid_baseline_left'],
    [80, 14, 'mid_baseline_right'],
    [24, 42, 'mid_elbow_left'],      // just above the FT line, outside the lane
    [76, 42, 'mid_elbow_right'],
    [50, 46, 'mid_top'],
    [3, 10, 'three_corner_left'],    // corner column, x ≤ 6
    [97, 10, 'three_corner_right'],
    [6.5, 28, 'three_wing_left'],    // beyond the arc, >155° from the basket
    [93.5, 28, 'three_wing_right'],  // beyond the arc, <25°
    [25, 60, 'three_top_left'],
    [75, 60, 'three_top_right'],
    [50, 64, 'three_top_center'],
    [6.5, 15, 'mid_baseline_left'],  // 0.975m off the sideline but INSIDE the arc: a long 2
    [50, 2, 'paint_right'],          // directly behind the backboard
];
for (const [x, y, zone] of zoneCases) {
    check(`(${x}, ${y})`, classifyZone(x, y), zone);
}

checkClose(
    'FIBA corner-3 tangent depth = basketY + √(45² − 44²)',
    COURT.threeCornerMaxY,
    10.5 + Math.sqrt(45 ** 2 - 44 ** 2),
    0.05,
);

// ── 2. Centroid self-classification ────────────────────────────────────────
// A centroid MUST classify back to its own zone: the website backfills x/y
// from ZONES[zone] for zone-only captures and then re-derives the zone from
// those coords. A drifted centroid silently re-bins shots.
section('ZONES centroids self-classify');

for (const z of Object.values(ZONES)) {
    if (z.id === 'unlocated') continue;
    check(`${z.id} centroid (${z.cx}, ${z.cy})`, classifyZone(z.cx, z.cy), z.id);
}

// ── 3. rimDistance ─────────────────────────────────────────────────────────
section('rimDistance');

checkClose('0 m at the basket', rimDistance(COURT.basketX, COURT.basketY).meters, 0, 1e-6);
// The FIBA arc is 6.75 m from the basket centre — a point exactly on the arc
// straight out from the rim must measure 6.75 m.
checkClose('6.75 m on the arc, straight out', rimDistance(50, 10.5 + 45).meters, 6.75, 0.01);
checkClose('feet conversion', rimDistance(50, 10.5 + 45).feet, 6.75 * 3.28084, 0.01);

// ── 4. Landscape ↔ portrait round-trip, both teams ─────────────────────────
section('portrait ↔ landscape round-trip identity');

const roundTripPoints = [
    [50, 10.5], [3, 10], [97, 10], [50, 64], [25, 60], [6.5, 28], [76, 42], [50, 46],
];
for (const [px, py] of roundTripPoints) {
    for (const side of ['A', 'B']) {
        const { lx, ly } = portraitToLandscape(px, py, side);
        const back = landscapeToPortrait(lx, ly);
        checkClose(`side ${side} (${px}, ${py}) → landscape → portrait x`, back.portX, px, 1e-9);
        checkClose(`side ${side} (${px}, ${py}) → landscape → portrait y`, back.portY, py, 1e-9);
    }
}

check('team A attacks the left basket', portraitToLandscape(50, 10.5, 'A').lx < LS_W / 2, true);
check('team B attacks the right basket', portraitToLandscape(50, 10.5, 'B').lx > LS_W / 2, true);
checkClose('depth folds from the nearer basket (far half mirrors)', landscapeToDepth(LS_W - 30), 30, 1e-9);
checkClose('depth clamps at the half-court line', landscapeToDepth(94), 94, 1e-9);

// ── 5. classifyLandscape ≡ classifyZone ────────────────────────────────────
section('classifyLandscape ≡ classifyZone (both halves)');

for (const [px, py] of roundTripPoints) {
    for (const side of ['A', 'B']) {
        const { lx, ly } = portraitToLandscape(px, py, side);
        check(`side ${side} (${px}, ${py})`, classifyLandscape(lx, ly), classifyZone(px, py));
    }
}

// ── 6. isBeyondArc ≡ zone.startsWith('three_') ─────────────────────────────
// The arc test and the zone classifier are two phrasings of one rule; if they
// ever disagree, a hex could offer a 3pt target that persists as a 2.
section("isBeyondArc ≡ zone.startsWith('three_')");

let arcMismatches = 0;
let arcSamples = 0;
for (let lx = 1; lx < LS_W; lx += 1) {
    for (let ly = 1; ly < LS_H; ly += 1) {
        arcSamples++;
        const beyond = isBeyondArc(lx, ly);
        const isThree = classifyLandscape(lx, ly).startsWith('three_');
        if (beyond !== isThree) arcMismatches++;
    }
}
check(`agree across all ${arcSamples} sampled landscape points`, arcMismatches, 0);

// ── 7. Quick spots classify to their declared zones ────────────────────────
section('quick spots classify to their declared zones');

for (const spot of QUICK_SPOTS) {
    check(`${spot.label} (left)`, classifyLandscape(spot.lx, spot.ly), spot.zone);
}
// Mirrored onto the right basket, a quick spot must keep its zone — the zone
// is defined relative to the team's own basket, not to the arena.
for (const spot of QUICK_SPOTS) {
    const m = mirrorQuickSpot(spot, 'right');
    check(`${spot.label} (mirrored right)`, classifyLandscape(m.lx, m.ly), spot.zone);
}

// ── 8. Hex grid + arc splitting ────────────────────────────────────────────
section('hex grid');

const cells = buildAndAnnotateGrid(6, 6);
check('grid is non-empty', cells.length > 50, true);
check('both synthetic rim cells exist', cells.filter((c) => c.kind === 'rim').length, 2);
check('rim cells are at_rim', cells.filter((c) => c.kind === 'rim').every((c) => c.zone === 'at_rim'), true);
check('no cell is left unclassified', cells.some((c) => c.zone === 'unlocated'), false);

const splitCells = cells.filter((c) => c.split === 'split');
check('some cells straddle the arc', splitCells.length > 0, true);
check(
    'every straddling cell offers a 2pt AND a 3pt zone',
    splitCells.every((c) => c.insideZone && !c.insideZone.startsWith('three_') && c.outsideZone && c.outsideZone.startsWith('three_')),
    true,
);

const idx = buildSpatialIndex(cells, 6);
check('nearest() snaps to the left rim', nearest(idx, BX_L, BY).id, 'rim_l');
check('nearest() snaps to the right rim', nearest(idx, BX_R, BY).id, 'rim_r');
check('nearest() always returns a cell', typeof nearest(idx, 90, 50).id, 'string');

// ── 9. resolveTap — the capture entry point ────────────────────────────────
section('resolveTap');

// Raw position is preserved — never quantised to a hex centre.
const raw = resolveTap({ lx: 33.3, ly: 61.7 });
checkClose('commits the raw landscape x', raw.lx, 33.3, 1e-9);
checkClose('commits the raw landscape y', raw.ly, 61.7, 1e-9);
checkClose('persists portrait x = landscape y', raw.x, 61.7, 1e-9);
checkClose('persists portrait y = depth from the near basket', raw.y, 33.3, 1e-9);
check('raw tap is accepted', raw.ok, true);

// Rim snap.
const nearRim = resolveTap({ lx: BX_L + 1.0, ly: BY + 0.5 });
check('snaps to the rim inside the snap radius', nearRim.rimSnapped, true);
check('rim snap classifies at_rim', nearRim.zone, 'at_rim');
checkClose('rim snap commits exactly at the basket', nearRim.lx, BX_L, 1e-9);

const justOutsideRim = resolveTap({ lx: BX_L + 5, ly: BY });
check('does not snap outside the snap radius', justOutsideRim.rimSnapped, false);

// Points agreement — the highest-value guard in the engine.
const threeTappedInside = resolveTap({ lx: 40, ly: 50, points: 3 });
check('a 3 tapped inside the arc is rejected', threeTappedInside.ok, false);
check('  with reason points_mismatch', threeTappedInside.rejectReason, 'points_mismatch');
check('  and still reports what the location implies', threeTappedInside.impliedPoints, 2);

const twoTappedOutside = resolveTap({ lx: 56, ly: 50, points: 2 });
check('a 2 tapped beyond the arc is rejected', twoTappedOutside.ok, false);
check('  with reason points_mismatch', twoTappedOutside.rejectReason, 'points_mismatch');

check('a 3 tapped beyond the arc is accepted', resolveTap({ lx: 56, ly: 50, points: 3 }).ok, true);
check('a 2 tapped inside the arc is accepted', resolveTap({ lx: 40, ly: 50, points: 2 }).ok, true);
check('omitting points skips the check', resolveTap({ lx: 40, ly: 50 }).ok, true);

// Corner 3 is the case a naive arc-distance test gets wrong — pin it.
const cornerTap = resolveTap({ lx: 5, ly: 3, points: 3 });
check('corner 3 accepted at 0.45m off the sideline', cornerTap.ok, true);
check('  classified as a corner 3', cornerTap.zone, 'three_corner_left');
const longTwoTap = resolveTap({ lx: 15, ly: 6.5, points: 2 });
check('the long 2 just inside the corner stripe stays a 2', longTwoTap.ok, true);
check('  classified as mid_baseline_left', longTwoTap.zone, 'mid_baseline_left');

// Half lock.
check('off-half tap rejected when locked', resolveTap({ lx: 150, ly: 50, attackingHalf: 'left' }).ok, false);
check('  with reason off_half', resolveTap({ lx: 150, ly: 50, attackingHalf: 'left' }).rejectReason, 'off_half');
check('same tap accepted when unlocked', resolveTap({ lx: 150, ly: 50 }).ok, true);
check('on-half tap accepted when locked', resolveTap({ lx: 40, ly: 50, attackingHalf: 'left' }).ok, true);

// Out-of-bounds input is clamped, never NaN.
const clamped = resolveTap({ lx: -50, ly: 900 });
check('clamps out-of-range input', clamped.x >= 0 && clamped.x <= LS_H && clamped.y >= 0 && clamped.y <= 94, true);
check('clamped result is still a real zone', typeof clamped.zone, 'string');

// Distance sanity: a top-of-key 3 is further from the rim than a rim tap.
check(
    'distance grows with depth',
    resolveTap({ lx: 56, ly: 50 }).distanceM > resolveTap({ lx: BX_L, ly: BY }).distanceM,
    true,
);

// ── 10. Location-less shapes ───────────────────────────────────────────────
section('free throw / unlocated shapes');

const ft = freeThrowLocation();
check('free throw zone', ft.zone, 'free_throw');
check('free throw x is null', ft.x, null);
check('free throw y is null', ft.y, null);

const un = unlocatedLocation();
check('unlocated zone', un.zone, 'unlocated');
check('unlocated x is null', un.x, null);

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));
process.exit(failed === 0 ? 0 : 1);
