// box-pi/ui/src/components/CourtMarkings.tsx
//
// The FIBA court, drawn entirely from shared/court-geometry.js's constants.
// Nothing in here hardcodes a position — if a constant moves, the drawing
// moves with it, and the drawing can never disagree with the classifier that
// decides which zone a tap landed in. (A court whose painted arc sits a few
// units off from the arc the engine tests against is the worst possible bug
// here: the ref would tap exactly where they see the line and get the other
// side's point value.)
//
// Drawn in LANDSCAPE full-court space (188 × 100) — a real full court with two
// live baskets, not one half mirrored. Both ends are drawn identically because
// both ends are genuinely usable: the ref taps the end where the shot actually
// happened and the engine measures depth from that end's basket.

import {
    LS_W, LS_H, HALF, BX_L, BX_R, BY, PD, PT, PB, FTR, R3, TX, TYT, TYB, RA,
    BK_X, BK_H, CC_R, LANE_BLOCKS, LANE_BLOCK_LEN, LINE_HEAVY, LINE_THIN, LINE_FAINT,
} from '../../../shared/court-geometry.js';

/** One end of the court. `side` picks which basket; geometry is mirrored. */
function CourtEnd({ side, color }: { side: 'left' | 'right'; color: string }) {
    const isLeft = side === 'left';
    // `s` maps a depth measured from this end's baseline into landscape x.
    const s = (depth: number) => (isLeft ? depth : LS_W - depth);
    const basketX = isLeft ? BX_L : BX_R;
    // SVG arc sweep flips when the geometry mirrors.
    const sweep = isLeft ? 1 : 0;

    return (
        <g stroke={color} fill="none" strokeLinecap="butt">
            {/* Paint / key */}
            <rect
                x={Math.min(s(0), s(PD))}
                y={PT}
                width={PD}
                height={PB - PT}
                strokeWidth={LINE_HEAVY}
            />

            {/* Free-throw circle: solid away from the basket, dashed toward it
                (the FIBA convention — the dashed half is inside the lane). */}
            <path
                d={`M ${s(PD)} ${BY - FTR} A ${FTR} ${FTR} 0 0 ${sweep} ${s(PD)} ${BY + FTR}`}
                strokeWidth={LINE_THIN}
            />
            <path
                d={`M ${s(PD)} ${BY - FTR} A ${FTR} ${FTR} 0 0 ${1 - sweep} ${s(PD)} ${BY + FTR}`}
                strokeWidth={LINE_FAINT}
                strokeDasharray="1.6 1.6"
            />

            {/* Restricted (no-charge) semicircle */}
            <path
                d={`M ${basketX} ${BY - RA} A ${RA} ${RA} 0 0 ${sweep} ${basketX} ${BY + RA}`}
                strokeWidth={LINE_THIN}
            />

            {/* Three-point line: two straight corner segments plus the arc that
                runs tangent to them at depth TX. Drawing it as one path is what
                keeps the corner from looking like a rounded-off arc. */}
            <path
                d={
                    `M ${s(0)} ${TYT} L ${s(TX)} ${TYT} ` +
                    `A ${R3} ${R3} 0 0 ${sweep} ${s(TX)} ${TYB} ` +
                    `L ${s(0)} ${TYB}`
                }
                strokeWidth={LINE_HEAVY}
            />

            {/* Backboard + rim */}
            <line x1={s(BK_X)} y1={BY - BK_H} x2={s(BK_X)} y2={BY + BK_H} strokeWidth={LINE_HEAVY} />
            <circle cx={basketX} cy={BY} r={1.5} strokeWidth={LINE_THIN} />

            {/* Lane blocks — the 7 FIBA hash marks on each side of the key */}
            {LANE_BLOCKS.map((d) => (
                <g key={`${side}-${d}`}>
                    <line x1={s(d)} y1={PT} x2={s(d)} y2={PT - LANE_BLOCK_LEN} strokeWidth={LINE_THIN} />
                    <line x1={s(d)} y1={PB} x2={s(d)} y2={PB + LANE_BLOCK_LEN} strokeWidth={LINE_THIN} />
                </g>
            ))}
        </g>
    );
}

export function CourtMarkings({ color = '#3c4149' }: { color?: string }) {
    return (
        <g>
            {/* Boundary + halfway line + centre circle */}
            <rect x={0} y={0} width={LS_W} height={LS_H} stroke={color} fill="none" strokeWidth={LINE_HEAVY} />
            <line x1={HALF} y1={0} x2={HALF} y2={LS_H} stroke={color} strokeWidth={LINE_THIN} />
            <circle cx={HALF} cy={BY} r={CC_R} stroke={color} fill="none" strokeWidth={LINE_THIN} />

            <CourtEnd side="left" color={color} />
            <CourtEnd side="right" color={color} />
        </g>
    );
}
