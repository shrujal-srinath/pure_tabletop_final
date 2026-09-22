// box-pi/shared/court-geometry.js
// ═══════════════════════════════════════════════════════════════════════════
// THE BOX — Court geometry & shot-location engine
//
// This file is a BEHAVIORAL MIRROR of the existing ecosystem's court law, not
// a fresh design. The same numbers live in three other places and every one of
// them reads the same `shot_events` rows this daemon writes:
//
//   • website   BOXV2-TEST  src/components/shotchart/courtZones.ts   (portrait law)
//   • website   BOXV2-TEST  src/components/refereebox/court/CourtGeometry.ts
//                                                       (landscape/Pi + hex grid)
//   • Flutter   the_box_app lib/models/shot_models.dart  (portrait, 1:1 mirror)
//
// Verified against BOXV2-TEST @ 3188b59 before writing. Changing a constant or
// a classification boundary here WITHOUT changing it there silently re-bins
// every shot this device records — the website would render our shots in
// different zones than it recorded them in. Treat the numbers as frozen; the
// website's `courtZones.test.ts` / `CourtGeometry.test.ts` goldens are the law,
// and `scripts/test-court-geometry.mjs` re-pins the same cases here.
//
// ── The two coordinate frames ──────────────────────────────────────────────
//
// PORTRAIT (canonical — the ONLY thing ever persisted)
//   0–100 (x, width) × 0–94 (y, depth) half-court, measured from the shooting
//   team's OWN basket. (0,0) = left corner of the baseline, (50,0) = baseline
//   center, (50,94) = center of the half-court line. Basket at (50, 10.5).
//   Scale: 1 unit = 0.15 m on both axes (FIBA half-court 15m × 14m).
//
// LANDSCAPE (display only — NEVER persisted)
//   188 (lx, full-court depth) × 100 (ly, width). Exists only because the Pi's
//   panel is mounted landscape and shows both baskets. Left basket (10.5, 50),
//   right basket (177.5, 50), half-court line at lx = 94. Convert at the
//   display boundary via the named functions below — never hand-roll the swap.
//
// ── Why depth is measured from the NEARER basket ───────────────────────────
// `landscapeToDepth` folds the far half onto the near half, so classification
// always happens in the near basket's own frame. That makes capture robust to
// which end the teams are attacking (they swap at halftime and this device has
// no notion of that — see `resolveTap`'s `attackingHalf` note). The ONE rule it
// depends on is that the ref taps the half where the shot physically happened.
// Rendering persisted shots back onto a full court is the opposite direction
// and IS team-aware — use `portraitToLandscape(x, y, side)`, never round-trip
// team B data through the team-less direction.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {'at_rim'|'restricted'|'paint_left'|'paint_right'
 *   |'mid_baseline_left'|'mid_baseline_right'|'mid_elbow_left'|'mid_elbow_right'|'mid_top'
 *   |'three_corner_left'|'three_corner_right'|'three_wing_left'|'three_wing_right'
 *   |'three_top_left'|'three_top_right'|'three_top_center'|'unlocated'} ShotZoneId
 */

/**
 * What `shot_events.zone` actually holds: a ShotZoneId, OR 'free_throw' for FT
 * rows, which have no court location at all (x/y NULL). The Pi path has always
 * written 'free_throw'; the website joined it on 2026-07-08 (migration 013).
 * @typedef {ShotZoneId|'free_throw'} PersistedZone
 */

const M_TO_U = 6.667; // metres → units (1 m = 100/15 = 6.667 units)

/** Metres per court unit. 1 unit = 15 cm. */
export const M_PER_UNIT = 0.15;

// ── Court geometry constants (FIBA 2024) ───────────────────────────────────
// FIBA, not NBA: the arc is 6.75 m (NBA 7.24 m top / 6.7 m corner) and the
// corner segment sits 0.9 m off the sideline. Never mix the two rulesets in
// one calculation, including when citing NBA-sourced efficiency baselines.

export const COURT = Object.freeze({
    width: 100,
    height: 94,
    basketX: 50,
    basketY: 10.5,          // 1.575 m from the endline
    restrictedRadius: 8.33, // 1.25 m no-charge semicircle
    paintLeft: 33.67,       // centre − 2.45 m (4.9 m lane)
    paintRight: 66.33,      // centre + 2.45 m
    paintTop: 38.67,        // FT line, 5.8 m from the endline
    ftCircleRadius: 12,     // 1.8 m
    threePointRadius: 45,   // 6.75 m from basket centre
    threeCornerX: 6,        // 0.9 m from the sideline
    threeCornerMaxY: 19.93, // depth where the arc goes tangent to the corner line
    backboardY: 8,          // 1.2 m from the endline
    centerCircleRadius: 12, // 1.8 m
    laneMarks: [11.67, 17.0, 22.33, 27.67],
});

// ── Landscape (display) constants ──────────────────────────────────────────

export const LS_W = 188;
export const LS_H = 100;
export const HALF = LS_W / 2;

export const BX_L = COURT.basketY;        // 10.5  — team attacking the left basket
export const BX_R = LS_W - COURT.basketY; // 177.5 — team attacking the right basket
export const BY = COURT.basketX;          // 50

export const PD = COURT.paintTop;
export const PT = COURT.paintLeft;
export const PB = COURT.paintRight;
export const FTR = COURT.ftCircleRadius;
export const R3 = COURT.threePointRadius;
export const TX = COURT.threeCornerMaxY;
export const TYT = COURT.threeCornerX;    // 6  — top-sideline corner stripe
export const TYB = LS_H - TYT;            // 94 — bottom-sideline corner stripe
export const RA = COURT.restrictedRadius;
export const BK_X = COURT.backboardY;
export const BK_H = 6;                    // backboard half-height (1.8 m / 2)
export const CC_R = COURT.centerCircleRadius;

// FIBA: 7 hash marks per lane side at 0.4 m intervals from 1.75 m off the
// baseline. `laneMarks` is the 4 wider neutral-zone blocks; LANE_BLOCKS is the
// full 7-tick pattern. Both are render-only.
export const LANE_MARKS = COURT.laneMarks;
export const LANE_MARK_LEN = 1.2;
export const LANE_BLOCKS = [11.67, 14.33, 17.0, 19.67, 22.33, 25.0, 27.67];
export const LANE_BLOCK_LEN = 0.6;

// FIBA line width 5 cm = 0.33 units; these are the drawing weights the Pi court
// uses so a new component doesn't invent its own.
export const LINE_HEAVY = 0.55;
export const LINE_THIN = 0.40;
export const LINE_FAINT = 0.32;

/** Rim-snap radius: a tap this close to the basket commits as `at_rim`. */
export const RIM_SNAP_RADIUS = 1.6;

// ── Zone definitions ───────────────────────────────────────────────────────
// Centroids are HAND-PLACED, not geometric centres. The invariant that makes
// them load-bearing: a centroid MUST classify back to its own zone, because the
// website backfills x/y from `ZONES[zone]` for zone-only captures and then
// re-derives the zone from those coords. A drifted centroid silently re-bins
// shots — that really happened (wing 3s landing as top 3s, fixed 2026-07-07).
// `scripts/test-court-geometry.mjs` enforces self-classification.

/**
 * @typedef {Object} ZoneDefinition
 * @property {ShotZoneId} id
 * @property {string} label
 * @property {string} shortLabel
 * @property {2|3} pointValue
 * @property {number} cx
 * @property {number} cy
 */

/** @type {Record<ShotZoneId, ZoneDefinition>} */
export const ZONES = Object.freeze({
    at_rim: { id: 'at_rim', label: 'At rim / Dunk', shortLabel: 'RIM', pointValue: 2, cx: 50, cy: 10.5 },
    // cy 16 (not 12): within 1.6u of the basket classifyZone returns at_rim,
    // and a centroid must self-classify.
    restricted: { id: 'restricted', label: 'Restricted area', shortLabel: 'RA', pointValue: 2, cx: 50, cy: 16 },
    paint_left: { id: 'paint_left', label: 'Paint left', shortLabel: 'PL', pointValue: 2, cx: 40, cy: 26 },
    paint_right: { id: 'paint_right', label: 'Paint right', shortLabel: 'PR', pointValue: 2, cx: 60, cy: 26 },
    mid_baseline_left: { id: 'mid_baseline_left', label: 'Mid baseline left', shortLabel: 'MBL', pointValue: 2, cx: 20, cy: 14 },
    mid_baseline_right: { id: 'mid_baseline_right', label: 'Mid baseline right', shortLabel: 'MBR', pointValue: 2, cx: 80, cy: 14 },
    // cy 42 (not 38): the elbow band starts ABOVE the FT line; at y=38 this
    // point classifies as mid_baseline_left.
    mid_elbow_left: { id: 'mid_elbow_left', label: 'Left elbow', shortLabel: 'LEL', pointValue: 2, cx: 24, cy: 42 },
    mid_elbow_right: { id: 'mid_elbow_right', label: 'Right elbow', shortLabel: 'REL', pointValue: 2, cx: 76, cy: 42 },
    mid_top: { id: 'mid_top', label: 'Mid top of key', shortLabel: 'MT', pointValue: 2, cx: 50, cy: 46 },
    three_corner_left: { id: 'three_corner_left', label: 'Left corner 3', shortLabel: 'LC3', pointValue: 3, cx: 3, cy: 10 },
    three_corner_right: { id: 'three_corner_right', label: 'Right corner 3', shortLabel: 'RC3', pointValue: 3, cx: 97, cy: 10 },
    // (6.5, 28) not (10, 40): the old centroid sat at 143.6° from the basket,
    // inside the three_top_left angular band.
    three_wing_left: { id: 'three_wing_left', label: 'Left wing 3', shortLabel: 'LW3', pointValue: 3, cx: 6.5, cy: 28 },
    three_wing_right: { id: 'three_wing_right', label: 'Right wing 3', shortLabel: 'RW3', pointValue: 3, cx: 93.5, cy: 28 },
    three_top_left: { id: 'three_top_left', label: 'Top left 3', shortLabel: 'TL3', pointValue: 3, cx: 25, cy: 60 },
    three_top_right: { id: 'three_top_right', label: 'Top right 3', shortLabel: 'TR3', pointValue: 3, cx: 75, cy: 60 },
    three_top_center: { id: 'three_top_center', label: 'Top center 3', shortLabel: 'TC3', pointValue: 3, cx: 50, cy: 64 },
    unlocated: { id: 'unlocated', label: 'Unlocated', shortLabel: '??', pointValue: 2, cx: 50, cy: 70 },
});

/** Every real court zone — `unlocated` excluded, since it is not a place. */
export const ZONE_LIST = Object.values(ZONES).filter((z) => z.id !== 'unlocated');

/**
 * The persisted zone for a free throw. FTs have NO court location: x and y are
 * NULL, not a fake FT-line point. Every spatial consumer in the ecosystem
 * filters `shot_type === 'free_throw'` before touching x/y/zone.
 * @type {'free_throw'}
 */
export const FREE_THROW_ZONE = 'free_throw';

// ── Classification (portrait) ──────────────────────────────────────────────

/**
 * THE canonical zone classifier. Order matters — first match wins.
 * @param {number} x 0–100, width
 * @param {number} y 0–94, depth from the shooting team's basket
 * @returns {ShotZoneId}
 */
export function classifyZone(x, y) {
    const {
        basketX, basketY, restrictedRadius, paintLeft, paintRight, paintTop,
        threePointRadius, threeCornerX, threeCornerMaxY,
    } = COURT;

    const dx = x - basketX;
    const dist = Math.sqrt(dx * dx + (y - basketY) * (y - basketY));

    // 1. At-rim (dunk / tip radius)
    if (dist <= RIM_SNAP_RADIUS) return 'at_rim';

    // 2. Paint, with the restricted semicircle carved out of it
    if (x >= paintLeft && x <= paintRight && y <= paintTop) {
        if (dist <= restrictedRadius) return 'restricted';
        return x < basketX ? 'paint_left' : 'paint_right';
    }
    // The semicircle bulges past the lane edges — catch those points too.
    if (dist <= restrictedRadius && y <= basketY + restrictedRadius) return 'restricted';

    // 3. Corner 3 — a STRAIGHT boundary, not an arc distance, because FIBA's
    //    arc runs tangent-straight below the tangent depth. No fudge factor.
    if (y <= threeCornerMaxY) {
        if (x <= threeCornerX) return 'three_corner_left';
        if (x >= 100 - threeCornerX) return 'three_corner_right';
    }

    // 4. Beyond the arc — split by ANGLE from the basket, not x-position, so
    //    the zone seams stay radial around the rim instead of vertical.
    if (dist >= threePointRadius) {
        const ang = (Math.atan2(y - basketY, x - basketX) * 180) / Math.PI;
        if (ang < 25) return 'three_wing_right';
        if (ang < 65) return 'three_top_right';
        if (ang <= 115) return 'three_top_center';
        if (ang <= 155) return 'three_top_left';
        return 'three_wing_left';
    }

    // 5. Mid-range fallback
    if (y <= paintTop) {
        return x < basketX ? 'mid_baseline_left' : 'mid_baseline_right';
    }
    if (y <= paintTop + 10) {
        if (x < paintLeft) return 'mid_elbow_left';
        if (x > paintRight) return 'mid_elbow_right';
    }
    return 'mid_top';
}

/**
 * THE canonical distance-to-rim, in metres and feet. Don't re-derive
 * `Math.hypot` locally in a component — a previous version of this was
 * duplicated in the web court and drifted.
 * @param {number} x
 * @param {number} y
 * @returns {{meters: number, feet: number}}
 */
export function rimDistance(x, y) {
    const du = Math.hypot(x - COURT.basketX, y - COURT.basketY);
    const meters = du / M_TO_U;
    return { meters, feet: meters * 3.28084 };
}

/**
 * Point value implied by a zone's LOCATION. Note this is not automatically the
 * points that get scored: the physical button press is authoritative for the
 * score, and a line-foot disagreement is possible and legal. The engine trusts
 * recorded points for scoring and the zone for spatial work.
 * @param {ShotZoneId} zoneId
 * @returns {2|3}
 */
export function zonePointValue(zoneId) {
    return ZONES[zoneId]?.pointValue ?? 2;
}

// ── Landscape ↔ portrait ───────────────────────────────────────────────────

/**
 * Fold a landscape depth onto the near basket's half-court frame.
 * @param {number} lx
 * @returns {number} portrait depth, 0–94
 */
export function landscapeToDepth(lx) {
    return Math.min(lx <= HALF ? lx : LS_W - lx, 94);
}

/**
 * Landscape tap → portrait coords for persistence. Team-less by design: depth
 * comes from whichever basket is nearer.
 * @param {number} lx
 * @param {number} ly
 * @returns {{portX: number, portY: number}}
 */
export function landscapeToPortrait(lx, ly) {
    return { portX: ly, portY: landscapeToDepth(lx) };
}

/**
 * Persisted portrait coords → landscape, TEAM-AWARE. Convention: side 'A'
 * renders on the left basket, 'B' on the right. Required for drawing stored
 * shots back onto a full court — the team-less inverse cannot do this.
 * @param {number} portX
 * @param {number} portY
 * @param {'A'|'B'} side
 * @returns {{lx: number, ly: number}}
 */
export function portraitToLandscape(portX, portY, side) {
    return { lx: side === 'B' ? LS_W - portY : portY, ly: portX };
}

/**
 * Classify a landscape point by delegating to the ONE portrait classifier.
 * There is deliberately no second classification implementation.
 * @param {number} lx
 * @param {number} ly
 * @returns {ShotZoneId}
 */
export function classifyLandscape(lx, ly) {
    return classifyZone(ly, landscapeToDepth(lx));
}

/**
 * Is this landscape point in 3-point territory? Same two-part rule as
 * `classifyZone`'s corner logic, phrased in landscape terms: inside the corner
 * column it is a straight sideline-stripe test, elsewhere an arc distance.
 * @param {number} lx
 * @param {number} ly
 * @returns {boolean}
 */
export function isBeyondArc(lx, ly) {
    const isLeft = lx <= HALF;
    const baseX = isLeft ? BX_L : BX_R;
    const portDepth = isLeft ? lx : LS_W - lx;
    if (portDepth <= TX) {
        return ly <= TYT || ly >= TYB;
    }
    return Math.hypot(lx - baseX, ly - BY) >= R3;
}

/**
 * Which half of the landscape court a point falls in.
 * @param {number} lx
 * @returns {'left'|'right'}
 */
export function halfOf(lx) {
    return lx <= HALF ? 'left' : 'right';
}

// ── Hex grid (the Pi's tap surface) ────────────────────────────────────────
// The hex grid is a VISUAL affordance and a zone-preview aid. It is NOT what
// gets committed: `resolveTap` persists the raw pointer position, never the
// cell centre. (The website had the snap-to-centre bug and fixed it on
// 2026-07-07 — snapping quantises every shot to the grid and destroys exactly
// the precision this whole flow exists to capture.)

/** @typedef {'hex'|'rim'} HexKind */

/**
 * @typedef {Object} HexCell
 * @property {string} id
 * @property {number} row
 * @property {number} col
 * @property {number} cx landscape centre x
 * @property {number} cy landscape centre y
 * @property {HexKind} kind
 * @property {'inside'|'outside'|'split'} split
 * @property {ShotZoneId|null} insideZone
 * @property {ShotZoneId|null} outsideZone
 * @property {ShotZoneId} zone
 */

const SQRT3 = Math.sqrt(3);

/**
 * Pointy-top hex grid covering the landscape court, with the two rim areas
 * carved out and replaced by synthetic always-tappable rim cells — so there is
 * a guaranteed at-rim target regardless of how the grid happens to align.
 * @param {number} R
 * @returns {HexCell[]}
 */
export function buildHexGrid(R) {
    const dx = SQRT3 * R;
    const dy = 1.5 * R;
    /** @type {HexCell[]} */
    const cells = [];
    const rows = Math.ceil((LS_H + 2 * R) / dy) + 2;
    const cols = Math.ceil((LS_W + 2 * R) / dx) + 2;

    for (let row = 0; row < rows; row++) {
        const cy = -R + row * dy;
        const xOff = (row % 2) * (dx / 2);
        for (let col = 0; col < cols; col++) {
            const cx = -dx / 2 + xOff + col * dx;
            if (cx < R * 0.4 || cx > LS_W - R * 0.4) continue;
            if (cy < R * 0.4 || cy > LS_H - R * 0.4) continue;
            if (Math.hypot(cx - BX_L, cy - BY) < R * 0.75) continue;
            if (Math.hypot(cx - BX_R, cy - BY) < R * 0.75) continue;
            cells.push({
                id: `r${row}c${col}`,
                row, col, cx, cy, kind: 'hex',
                split: 'inside', insideZone: 'unlocated', outsideZone: null, zone: 'unlocated',
            });
        }
    }
    cells.push({ id: 'rim_l', row: -1, col: -1, cx: BX_L, cy: BY, kind: 'rim', split: 'inside', insideZone: 'at_rim', outsideZone: null, zone: 'at_rim' });
    cells.push({ id: 'rim_r', row: -1, col: -2, cx: BX_R, cy: BY, kind: 'rim', split: 'inside', insideZone: 'at_rim', outsideZone: null, zone: 'at_rim' });
    return cells;
}

/**
 * @param {number} cx
 * @param {number} cy
 * @param {number} R
 * @returns {[number, number][]}
 */
export function hexVertices(cx, cy, R) {
    /** @type {[number, number][]} */
    const v = [];
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        v.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
    return v;
}

/**
 * SVG path for a closed pointy-top hex.
 * @param {number} cx
 * @param {number} cy
 * @param {number} R
 * @returns {string}
 */
export function hexPath(cx, cy, R) {
    let s = '';
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        s += (i === 0 ? 'M' : 'L') + (cx + R * Math.cos(a)).toFixed(3) + ',' + (cy + R * Math.sin(a)).toFixed(3);
    }
    return s + 'Z';
}

/**
 * Does this hex sit wholly inside the arc, wholly outside, or straddle it?
 * Samples all 6 vertices plus the centre; unanimous or it's a split.
 * @param {HexCell} cell
 * @param {number} hexR
 * @returns {'inside'|'outside'|'split'}
 */
export function splitHexAtArc(cell, hexR) {
    const verts = hexVertices(cell.cx, cell.cy, hexR);
    let inside = 0;
    let outside = 0;
    for (const [vx, vy] of verts) {
        if (isBeyondArc(vx, vy)) outside++;
        else inside++;
    }
    if (isBeyondArc(cell.cx, cell.cy)) outside++;
    else inside++;
    if (outside === 0) return 'inside';
    if (inside === 0) return 'outside';
    return 'split';
}

/**
 * Fill in a cell's zone fields. A cell straddling the arc gets BOTH a 2-point
 * and a 3-point zone, so the exact position within that cell still decides —
 * the arc is never rounded to whichever side the cell centre happens to land.
 * @param {HexCell} cell
 * @param {number} hexR
 */
export function annotateCell(cell, hexR) {
    if (cell.kind === 'rim') {
        cell.split = 'inside';
        cell.insideZone = 'at_rim';
        cell.outsideZone = null;
        cell.zone = 'at_rim';
        return;
    }
    const baseZone = classifyLandscape(cell.cx, cell.cy);
    cell.zone = baseZone;
    const split = splitHexAtArc(cell, hexR);
    cell.split = split;
    if (split === 'inside') {
        cell.insideZone = baseZone;
        cell.outsideZone = null;
    } else if (split === 'outside') {
        cell.insideZone = null;
        cell.outsideZone = baseZone;
    } else {
        const isLeft = cell.cx <= HALF;
        const baseX = isLeft ? BX_L : BX_R;
        const dirX = baseX - cell.cx;
        const dirY = BY - cell.cy;
        const len = Math.hypot(dirX, dirY) || 1;
        const ux = dirX / len;
        const uy = dirY / len;
        let iz = classifyLandscape(cell.cx + ux * hexR * 1.2, cell.cy + uy * hexR * 1.2);
        if (iz.startsWith('three_')) iz = 'mid_top';
        cell.insideZone = iz;
        let oz = classifyLandscape(cell.cx - ux * hexR * 1.2, cell.cy - uy * hexR * 1.2);
        if (!oz.startsWith('three_')) oz = 'three_top_center';
        cell.outsideZone = oz;
    }
}

/**
 * @param {number} R
 * @param {number} hexR
 * @returns {HexCell[]}
 */
export function buildAndAnnotateGrid(R, hexR) {
    const cells = buildHexGrid(R);
    for (const c of cells) annotateCell(c, hexR);
    return cells;
}

// ── Arc region paths (SVG clip geometry) ───────────────────────────────────

/** The 2-point region of the landscape court (inside both arcs). */
export function buildInsidePath() {
    const left = `M 0 ${TYT} L ${TX} ${TYT} A ${R3} ${R3} 0 0 1 ${TX} ${TYB} L 0 ${TYB} Z`;
    const right = `M ${LS_W} ${TYT} L ${LS_W - TX} ${TYT} A ${R3} ${R3} 0 0 0 ${LS_W - TX} ${TYB} L ${LS_W} ${TYB} Z`;
    return `${left} ${right}`;
}

/** The 3-point region — full rect minus the two inside-arc regions (even-odd). */
export function buildOutsidePath() {
    return `M 0 0 L ${LS_W} 0 L ${LS_W} ${LS_H} L 0 ${LS_H} Z ${buildInsidePath()}`;
}

// ── Spatial index ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} HexIndex
 * @property {HexCell} rimL
 * @property {HexCell} rimR
 * @property {Map<number, HexCell[]>} rowMap
 * @property {number} R
 * @property {HexCell[]} cells
 */

/**
 * O(N) build, O(1) amortised lookup — for hover/tap highlighting at 60fps.
 * @param {HexCell[]} cells
 * @param {number} R
 * @returns {HexIndex}
 */
export function buildSpatialIndex(cells, R) {
    /** @type {Map<number, HexCell[]>} */
    const rowMap = new Map();
    let rimL;
    let rimR;
    for (const c of cells) {
        if (c.kind === 'rim') {
            if (c.id === 'rim_l') rimL = c;
            else rimR = c;
            continue;
        }
        const bucket = rowMap.get(c.row);
        if (bucket) bucket.push(c);
        else rowMap.set(c.row, [c]);
    }
    return { rimL, rimR, rowMap, R, cells };
}

/**
 * Nearest cell to a landscape point. Always returns something (possibly a rim
 * cell). Visual only — see the note above `buildHexGrid`.
 * @param {HexIndex} idx
 * @param {number} lx
 * @param {number} ly
 * @returns {HexCell}
 */
export function nearest(idx, lx, ly) {
    if (Math.hypot(lx - idx.rimL.cx, ly - idx.rimL.cy) <= RIM_SNAP_RADIUS) return idx.rimL;
    if (Math.hypot(lx - idx.rimR.cx, ly - idx.rimR.cy) <= RIM_SNAP_RADIUS) return idx.rimR;

    const dy = 1.5 * idx.R;
    const guessRow = Math.round((ly + idx.R) / dy);
    /** @type {HexCell[]} */
    const candidates = [];
    for (let dr = -2; dr <= 2; dr++) {
        const arr = idx.rowMap.get(guessRow + dr);
        if (arr) candidates.push(...arr);
    }
    if (candidates.length === 0) {
        candidates.push(...idx.cells.filter((c) => c.kind === 'hex'));
    }
    let best = candidates[0];
    let bestD = (best.cx - lx) ** 2 + (best.cy - ly) ** 2;
    for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        const d = (c.cx - lx) ** 2 + (c.cy - ly) ** 2;
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return best;
}

// ── Quick spots ────────────────────────────────────────────────────────────
// One-tap entry for the spots that dominate a real game. Coordinates are
// authoritative (not approximations of a tap) and are given on the LEFT half;
// mirror with `mirrorQuickSpot` for the right basket.

/**
 * @typedef {Object} QuickSpot
 * @property {string} id
 * @property {string} label
 * @property {string} short
 * @property {number} lx
 * @property {number} ly
 * @property {ShotZoneId} zone
 */

/** @type {QuickSpot[]} */
export const QUICK_SPOTS = Object.freeze([
    { id: 'rim', label: 'AT RIM', short: 'RIM', lx: BX_L, ly: BY, zone: 'at_rim' },
    { id: 'ft', label: 'FT LINE', short: 'FT', lx: 40, ly: 50, zone: 'mid_top' },
    { id: 'tok3', label: 'TOP KEY 3', short: 'TOP3', lx: 56, ly: 50, zone: 'three_top_center' },
    { id: 'lc3', label: 'L CORNER 3', short: 'LC3', lx: 5, ly: 3, zone: 'three_corner_left' },
    { id: 'rc3', label: 'R CORNER 3', short: 'RC3', lx: 5, ly: 97, zone: 'three_corner_right' },
    { id: 'lw3', label: 'L WING 3', short: 'LW3', lx: 20, ly: 5, zone: 'three_wing_left' },
    { id: 'rw3', label: 'R WING 3', short: 'RW3', lx: 20, ly: 95, zone: 'three_wing_right' },
]);

/**
 * Mirror a left-half quick spot onto the right basket.
 * @param {QuickSpot} spot
 * @param {'left'|'right'} half
 * @returns {{lx: number, ly: number}}
 */
export function mirrorQuickSpot(spot, half) {
    return half === 'right' ? { lx: LS_W - spot.lx, ly: spot.ly } : { lx: spot.lx, ly: spot.ly };
}

// ── The capture entry point ────────────────────────────────────────────────

/**
 * @typedef {Object} ResolvedTap
 * @property {boolean} ok            False when the tap is rejected; nothing should be committed.
 * @property {ShotZoneId} zone       Canonical zone for the committed point.
 * @property {number} x              Portrait x (width), 0–100 — what gets persisted.
 * @property {number} y              Portrait y (depth), 0–94 — what gets persisted.
 * @property {number} lx             Landscape x actually committed (post rim-snap).
 * @property {number} ly             Landscape y actually committed.
 * @property {2|3} impliedPoints     Point value the LOCATION implies.
 * @property {number} distanceM      Distance to the basket in metres.
 * @property {number} distanceFt     Distance to the basket in feet.
 * @property {boolean} rimSnapped    Whether the tap was snapped to the rim.
 * @property {'off_half'|'points_mismatch'|null} rejectReason
 */

/**
 * THE single capture function — the one place a finger position becomes a
 * persisted shot location. Both the UI (to preview/validate live while the
 * finger is down) and the commit path call this, so what the ref sees under
 * their finger and what lands in `shot_events` can never disagree.
 *
 * Three things it enforces, in the order they matter:
 *
 *  1. RAW POSITION, never the hex centre. The hex grid is decoration; snapping
 *     to it would quantise every shot to the grid.
 *  2. RIM SNAP. Inside `RIM_SNAP_RADIUS` of a basket the tap commits exactly at
 *     the rim — layups and dunks are the most common shot in the game and the
 *     most useless to record as "somewhere near the basket".
 *  3. POINTS AGREEMENT. The physical button already told us 2 or 3. If the tap
 *     lands on the other side of the arc, that is a real capture error, and
 *     it is the single most damaging one (a 3 recorded inside the arc corrupts
 *     both the shot chart and every efficiency number derived from it). The
 *     tap is REJECTED rather than silently trusted — the caller shows the
 *     "that's a 2, not a 3" bounce and the ref adjusts.
 *
 * `attackingHalf` is optional because the data is correct either way: depth is
 * measured from whichever basket is nearer, so a tap on the half where the shot
 * actually happened always resolves correctly. Passing it only adds the
 * error-prevention lock. NOTE: box-pi's state engine has no notion of which
 * basket a team attacks (teams switch at halftime under FIBA), so nothing can
 * supply this today — it is here for when that state exists.
 *
 * @param {Object} tap
 * @param {number} tap.lx Landscape x, 0–188.
 * @param {number} tap.ly Landscape y, 0–100.
 * @param {1|2|3} [tap.points] Points from the physical button. Omit to skip the agreement check.
 * @param {'left'|'right'|null} [tap.attackingHalf] Lock capture to one half, or null for no lock.
 * @returns {ResolvedTap}
 */
export function resolveTap({ lx, ly, points, attackingHalf = null }) {
    const clampedX = Math.min(Math.max(lx, 0), LS_W);
    const clampedY = Math.min(Math.max(ly, 0), LS_H);

    let cx = clampedX;
    let cy = clampedY;

    // 2. Rim snap — do this before anything reads the position.
    let rimSnapped = false;
    if (Math.hypot(cx - BX_L, cy - BY) <= RIM_SNAP_RADIUS) {
        cx = BX_L;
        cy = BY;
        rimSnapped = true;
    } else if (Math.hypot(cx - BX_R, cy - BY) <= RIM_SNAP_RADIUS) {
        cx = BX_R;
        cy = BY;
        rimSnapped = true;
    }

    const { portX, portY } = landscapeToPortrait(cx, cy);
    const zone = classifyZone(portX, portY);
    const impliedPoints = ZONES[zone].pointValue;
    const { meters, feet } = rimDistance(portX, portY);

    const base = {
        zone, x: portX, y: portY, lx: cx, ly: cy,
        impliedPoints, distanceM: meters, distanceFt: feet, rimSnapped,
    };

    if (attackingHalf && halfOf(cx) !== attackingHalf) {
        return { ...base, ok: false, rejectReason: 'off_half' };
    }
    // Free throws never reach here (they have no location), so a 1 is only ever
    // a caller error — treat it as "no check" rather than inventing a rule.
    if (points === 2 || points === 3) {
        if (impliedPoints !== points) {
            return { ...base, ok: false, rejectReason: 'points_mismatch' };
        }
    }
    return { ...base, ok: true, rejectReason: null };
}

/**
 * The persisted shape for a free throw: no location at all. Matches migration
 * 013 and what every spatial consumer expects.
 * @returns {{x: null, y: null, zone: 'free_throw'}}
 */
export function freeThrowLocation() {
    return { x: null, y: null, zone: FREE_THROW_ZONE };
}

/**
 * The persisted shape when a shot's location was never captured (the ref let
 * the prompt time out). `unlocated` rows carry NULL coords from this device —
 * the website backfills a fake centroid on its own write path, which is why
 * every spatial consumer must exclude `zone === 'unlocated'` from spatial math.
 * @returns {{x: null, y: null, zone: 'unlocated'}}
 */
export function unlocatedLocation() {
    return { x: null, y: null, zone: 'unlocated' };
}
