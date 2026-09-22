// box-pi/ui/src/components/ShotCapture.tsx
//
// The shot-location flow: a physical score button (or the MISS button) fires,
// this takes over the screen, and the ref answers WHERE and WHO in about three
// seconds while play continues.
//
// ── Why it works the way it does ───────────────────────────────────────────
//
// PRECISION IS THE WHOLE PROBLEM. On a 7" 1024×600 panel the full court is
// ~5.3 px per court unit, and a fingertip covers roughly 10 units — about 1.5 m
// of real floor. A plain tap therefore CANNOT be accurate, on any design. The
// accuracy comes from four things, in descending order of how often they save
// a shot:
//
//   1. RIM SNAP — layups and dunks are the most common shot in basketball and
//      the least useful to record as "somewhere near the basket". Inside 1.6
//      units the engine commits exactly at the rim.
//   2. DRAG TO ADJUST, with a magnifier above the finger. Press anywhere, slide
//      to the exact spot while watching the loupe (the finger itself covers the
//      target — that's the entire reason the loupe exists), lift to commit.
//   3. QUICK SPOTS — one tap for the handful of positions that dominate a real
//      game, with authoritative coordinates rather than an approximated tap.
//   4. ARC-SIDE VALIDATION — the physical button already said 2 or 3, so a tap
//      on the wrong side of the line is a known error and gets bounced instead
//      of silently recorded. This is the one that protects the data most: a 3
//      logged inside the arc corrupts the shot chart and every efficiency
//      number derived from it.
//
// The honest target is zone-correct always, metre-accurate when the ref spends
// the extra half-second dragging. That is also all any real analytics system
// reports on — NBA, Synergy and FIBA all bucket into zones for their headline
// numbers.
//
// THE COURT IS A REAL FULL COURT, both baskets live. Depth is measured from
// whichever basket the shot happened at, so the ref taps what they see and the
// engine converts. Nothing is dimmed or locked off: making the ref work out
// "which half am I allowed to use" costs more time and more errors than it
// saves, and the conversion is correct from either end.
//
// EVERY COORDINATE DECISION GOES THROUGH resolveTap(). The preview under the
// finger and the value that reaches shot_events come from the same call, so
// what the ref sees confirmed and what gets stored cannot disagree.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
    LS_W, LS_H, BX_L, BX_R, BY, RIM_SNAP_RADIUS, QUICK_SPOT_SNAP_RADIUS,
    ZONES, resolveTap, allQuickSpots, snapToQuickSpot,
} from '../../../shared/court-geometry.js';
import type { Player, ScorePendingPayload, Team } from '../lib/daemonTypes';
import { CourtMarkings } from './CourtMarkings';

/** What a committed shot hands back to the caller. */
export interface CapturedShot {
    playerId?: string;
    x: number | null;
    y: number | null;
    zone: string;
    /** The attempt's value — from the button for a make, from the location for a miss. */
    points: number;
}

type ResolvedTap = ReturnType<typeof resolveTap>;
/** A resolved tap plus which quick spot (if any) it snapped to, for the readout. */
type Probe = ResolvedTap & { snappedSpot: string | null };

const LOUPE_R = 17;      // loupe radius, court units
const LOUPE_ZOOM = 2.4;  // magnification — matches the old build's proven value
const LOUPE_LIFT = 24;   // how far above the finger the loupe floats

const COLOR_MAKE = '#4ade80';
const COLOR_MISS = '#ef2b2d';
const COLOR_BAD = '#f5a623';

export function ShotCapture({
    pending, team, onCommit, onSkipLocation, onCancel, timeoutMs = 12000,
}: {
    pending: ScorePendingPayload;
    team: Team;
    onCommit: (shot: CapturedShot) => void;
    onSkipLocation: () => void;
    onCancel: () => void;
    timeoutMs?: number;
}) {
    const made = pending.made !== false;
    const accent = made ? (team.color || COLOR_MAKE) : COLOR_MISS;

    const svgRef = useRef<SVGSVGElement | null>(null);
    const [probe, setProbe] = useState<Probe | null>(null); // live, while the finger is down
    const [located, setLocated] = useState<Probe | null>(null); // committed location
    const [bounce, setBounce] = useState<string | null>(null);
    const [step, setStep] = useState<'court' | 'player'>('court');

    // ── Deadline ──────────────────────────────────────────────────────────
    // The game does not stop for this screen. If the ref is busy, the flow
    // gives up on its own rather than blocking the next score — but it gives
    // up by recording an UNLOCATED shot, never by discarding the shot itself.
    const [msLeft, setMsLeft] = useState(timeoutMs);
    const onSkipRef = useRef(onSkipLocation);
    onSkipRef.current = onSkipLocation;
    useEffect(() => {
        const start = Date.now();
        const id = window.setInterval(() => {
            const left = timeoutMs - (Date.now() - start);
            setMsLeft(left);
            if (left <= 0) {
                window.clearInterval(id);
                onSkipRef.current();
            }
        }, 100);
        return () => window.clearInterval(id);
    }, [timeoutMs, pending.ts]);

    // ── Pointer → court units ─────────────────────────────────────────────
    // The SVG uses preserveAspectRatio="xMidYMid meet", so the viewBox is
    // letterboxed inside the element. Mapping through the rendered box rather
    // than assuming it fills the element is what keeps the tap aligned with
    // the painted lines at any screen size.
    const toCourt = useCallback((clientX: number, clientY: number) => {
        const el = svgRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const scale = Math.min(r.width / LS_W, r.height / LS_H);
        const drawnW = LS_W * scale;
        const drawnH = LS_H * scale;
        const originX = r.left + (r.width - drawnW) / 2;
        const originY = r.top + (r.height - drawnH) / 2;
        return { lx: (clientX - originX) / scale, ly: (clientY - originY) / scale };
    }, []);

    const probeAt = useCallback((clientX: number, clientY: number) => {
        const pt = toCourt(clientX, clientY);
        if (!pt) return null;
        // Quick spots snap like the rim does, and for the same reason: their
        // coordinates are authoritative while a finger near them is only an
        // approximation, so snapping makes the record MORE accurate. (Snapping
        // to a hex grid would do the opposite — replace a real position with
        // an arbitrary one — which is why the grid is not a capture target.)
        const spot = snapToQuickSpot(pt.lx, pt.ly);
        const at = spot ?? pt;
        // `points` is only passed for a make: a miss has no button value to
        // check against, so its location is authoritative instead.
        const tap = resolveTap({ lx: at.lx, ly: at.ly, points: made ? (pending.points ?? undefined) : undefined });
        return { ...tap, snappedSpot: spot ? spot.short : null };
    }, [toCourt, made, pending.points]);

    function handleDown(e: ReactPointerEvent<SVGSVGElement>) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setBounce(null);
        setProbe(probeAt(e.clientX, e.clientY));
    }

    function handleMove(e: ReactPointerEvent<SVGSVGElement>) {
        if (!probe) return;
        setProbe(probeAt(e.clientX, e.clientY));
    }

    function handleUp() {
        if (!probe) return;
        if (!probe.ok) {
            // Don't commit, and say why — the ref learns the rule instead of
            // just watching the tap fail.
            setBounce(
                probe.rejectReason === 'points_mismatch'
                    ? `That's a ${probe.impliedPoints}-pointer — the button said ${pending.points}. Tap ${probe.impliedPoints === 2 ? 'beyond' : 'inside'} the arc.`
                    : 'Tap the end where the shot was taken.',
            );
            setProbe(null);
            return;
        }
        setLocated(probe);
        setProbe(null);
        setStep('player');
    }

    function commitWithPlayer(playerId?: string) {
        if (!located) return;
        onCommit({
            playerId,
            x: located.x,
            y: located.y,
            zone: located.zone,
            // A make's value came from the button; a miss's comes from where it
            // was taken. `impliedPoints` is the location's answer either way.
            points: made ? (pending.points ?? located.impliedPoints) : located.impliedPoints,
        });
    }

    const active = probe ?? located;
    const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000));
    const urgent = secondsLeft <= 3;

    return (
        <div style={backdropStyle} data-testid="shot-capture">
            {/* ── Banner ─────────────────────────────────────────────────── */}
            <div style={{ ...bannerStyle, borderColor: accent }}>
                <span style={{ width: 10, height: 10, background: accent, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, letterSpacing: '0.12em' }}>{team.name}</span>
                <span style={{ fontFamily: "'Archivo',sans-serif", fontStyle: 'italic', fontWeight: 900, fontSize: 22, color: accent }}>
                    {made ? `+${pending.points}` : 'MISS'}
                </span>
                <span style={{ color: '#7b8189', letterSpacing: '0.16em', fontSize: 11 }}>
                    {step === 'court' ? 'WHERE WAS THE SHOT?' : 'WHO SHOT IT?'}
                </span>
                <span style={{ flex: 1 }} />
                {active && (
                    <span data-testid="zone-readout" style={{ fontSize: 11, letterSpacing: '0.1em', color: '#9aa0a8' }}>
                        {ZONES[active.zone as keyof typeof ZONES]?.label ?? active.zone}
                        {' · '}
                        {active.distanceM.toFixed(1)} m
                        {active.rimSnapped && ' · RIM'}
                        {active.snappedSpot && ` · ${active.snappedSpot}`}
                    </span>
                )}
                {step === 'court' && (
                    <button onClick={onSkipLocation} style={ghostButtonStyle}>SKIP LOCATION</button>
                )}
                <span
                    data-testid="capture-countdown"
                    style={{ fontSize: 12, fontWeight: 700, color: urgent ? COLOR_MISS : '#7b8189', minWidth: 28, textAlign: 'right' }}
                >
                    {secondsLeft}s
                </span>
                <button onClick={onCancel} style={ghostButtonStyle} aria-label="Dismiss without recording">✕</button>
            </div>

            {step === 'court' ? (
                // The court gets its OWN box rather than sitting under the
                // chrome. It used to be absolutely positioned behind a floating
                // banner and chip bar, which put the bottom corner-3 stripe
                // (ly 94–100) underneath the bar — the ref literally could not
                // tap a bottom corner 3, and the arc's own geometry says that
                // is exactly where corner 3s live.
                <div style={courtAreaStyle}>
                    <svg
                        ref={svgRef}
                        data-testid="shot-court"
                        viewBox={`0 0 ${LS_W} ${LS_H}`}
                        preserveAspectRatio="xMidYMid meet"
                        style={{ width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair', display: 'block' }}
                        onPointerDown={handleDown}
                        onPointerMove={handleMove}
                        onPointerUp={handleUp}
                        onPointerCancel={() => setProbe(null)}
                    >
                        <rect x={0} y={0} width={LS_W} height={LS_H} fill="#0a0b0d" />
                        <CourtMarkings />

                        {/* Rim-snap targets — drawn so the ref can see the
                            basket is a real target, not a guess. */}
                        {[BX_L, BX_R].map((bx) => (
                            <circle key={bx} cx={bx} cy={BY} r={RIM_SNAP_RADIUS} fill={accent} fillOpacity={0.2} stroke={accent} strokeOpacity={0.55} strokeWidth={0.3} />
                        ))}

                        {/* Quick spots live ON the court, at their real
                            positions, instead of in a row of near-identical
                            chips that made the ref translate "LC3 ◀" into a
                            place. Tapping near one snaps to it. */}
                        {allQuickSpots().map((spot) => {
                            const isThree = ZONES[spot.zone as keyof typeof ZONES].pointValue === 3;
                            if (spot.id === 'rim') return null; // the rim already has its own target
                            return (
                                <g key={spot.key} data-testid={`quick-${spot.key}`} pointerEvents="none">
                                    <circle cx={spot.lx} cy={spot.ly} r={QUICK_SPOT_SNAP_RADIUS} fill={isThree ? '#4c86ff' : '#8a9099'} fillOpacity={0.08} />
                                    <circle cx={spot.lx} cy={spot.ly} r={1.3} fill={isThree ? '#4c86ff' : '#8a9099'} fillOpacity={0.9} />
                                    <text
                                        x={spot.lx}
                                        // Corner spots sit within a few units
                                        // of the sideline, so a label above
                                        // them would render off the court —
                                        // flip it inward there.
                                        y={spot.ly < LS_H / 2 ? spot.ly + 5.5 : spot.ly - 3}
                                        textAnchor="middle"
                                        fontSize={3.4}
                                        fontFamily="'JetBrains Mono',monospace"
                                        fill={isThree ? '#4c86ff' : '#8a9099'}
                                        fillOpacity={0.85}
                                    >
                                        {spot.short}
                                    </text>
                                </g>
                            );
                        })}

                        {probe && <Marker tap={probe} accent={accent} />}
                        {probe && <Loupe tap={probe} accent={accent} />}
                    </svg>

                    {bounce && (
                        <div data-testid="capture-bounce" style={bounceStyle}>
                            {bounce}
                        </div>
                    )}
                </div>
            ) : (
                <PlayerStep
                    players={team.players}
                    accent={accent}
                    located={located!}
                    made={made}
                    onPick={commitWithPlayer}
                    onBack={() => { setLocated(null); setStep('court'); }}
                />
            )}
        </div>
    );
}

// ── The marker under the finger ────────────────────────────────────────────

function Marker({ tap, accent }: { tap: ResolvedTap; accent: string }) {
    const color = tap.ok ? accent : COLOR_BAD;
    const basketX = tap.lx <= LS_W / 2 ? BX_L : BX_R;
    return (
        <g pointerEvents="none">
            {/* Line to the rim the shot is measured from — makes the distance
                readout something the ref can sanity-check at a glance. */}
            <line x1={tap.lx} y1={tap.ly} x2={basketX} y2={BY} stroke={color} strokeOpacity={0.35} strokeWidth={0.3} strokeDasharray="1.5 1.5" />
            <circle cx={tap.lx} cy={tap.ly} r={2.6} fill="none" stroke={color} strokeWidth={0.6} />
            <circle cx={tap.lx} cy={tap.ly} r={0.9} fill={color} />
        </g>
    );
}

// ── The magnifier ──────────────────────────────────────────────────────────
// The finger covers the target, so the loupe shows the court around it
// magnified and offset above the touch point. Flips below the finger near the
// top edge, so it never renders off-screen exactly when it is needed most.

function Loupe({ tap, accent }: { tap: ResolvedTap; accent: string }) {
    const above = tap.ly > LOUPE_LIFT + LOUPE_R;
    const cx = Math.min(Math.max(tap.lx, LOUPE_R + 1), LS_W - LOUPE_R - 1);
    const cy = above ? tap.ly - LOUPE_LIFT : tap.ly + LOUPE_LIFT;
    const clipId = 'loupe-clip';
    const color = tap.ok ? accent : COLOR_BAD;

    return (
        <g pointerEvents="none">
            <defs>
                <clipPath id={clipId}>
                    <circle cx={cx} cy={cy} r={LOUPE_R} />
                </clipPath>
            </defs>
            <circle cx={cx} cy={cy} r={LOUPE_R} fill="#0a0b0d" />
            <g clipPath={`url(#${clipId})`}>
                {/* Re-render the court, scaled about the touch point and moved
                    under the loupe. Same source component as the real court, so
                    the magnified view can never drift from what's underneath. */}
                <g transform={`translate(${cx} ${cy}) scale(${LOUPE_ZOOM}) translate(${-tap.lx} ${-tap.ly})`}>
                    <CourtMarkings color="#565c66" />
                    <circle cx={tap.lx} cy={tap.ly} r={0.6} fill={color} />
                </g>
            </g>
            {/* Crosshair at the exact committed point */}
            <line x1={cx - 3} y1={cy} x2={cx + 3} y2={cy} stroke={color} strokeWidth={0.35} />
            <line x1={cx} y1={cy - 3} x2={cx} y2={cy + 3} stroke={color} strokeWidth={0.35} />
            <circle cx={cx} cy={cy} r={LOUPE_R} fill="none" stroke={color} strokeWidth={0.6} />
        </g>
    );
}

// ── Player step ────────────────────────────────────────────────────────────

function PlayerStep({
    players, accent, located, made, onPick, onBack,
}: {
    players: Player[];
    accent: string;
    located: ResolvedTap;
    made: boolean;
    onPick: (playerId?: string) => void;
    onBack: () => void;
}) {
    const zoneLabel = ZONES[located.zone as keyof typeof ZONES]?.label ?? located.zone;
    return (
        <div style={playerStepStyle}>
            <div style={{ fontSize: 12, letterSpacing: '0.18em', color: '#7b8189', textTransform: 'uppercase' }}>
                {made ? 'Made' : 'Missed'} from <span style={{ color: accent, fontWeight: 700 }}>{zoneLabel}</span>
                {' · '}{located.distanceM.toFixed(1)} m
            </div>

            {players.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', maxWidth: 820 }}>
                    {players.map((p) => (
                        <button
                            key={p.id}
                            data-testid={`capture-player-${p.id}`}
                            disabled={p.fouledOut}
                            onClick={() => onPick(p.id)}
                            style={{ ...playerTileStyle, borderColor: p.fouledOut ? '#2a2c31' : accent, opacity: p.fouledOut ? 0.3 : 1 }}
                        >
                            <span style={{ fontFamily: "'Archivo',sans-serif", fontStyle: 'italic', fontWeight: 900, fontSize: 26 }}>{p.number}</span>
                            <span style={{ fontSize: 11, color: '#9aa0a8' }}>{p.name}</span>
                        </button>
                    ))}
                </div>
            ) : (
                <div style={{ fontSize: 13, color: '#7b8189' }}>No roster for this team.</div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={onBack} style={chipStyle}>← RETAP LOCATION</button>
                {/* Not a dead end: the location is already captured and worth
                    keeping even when nobody can say who took the shot. */}
                <button data-testid="capture-unattributed" onClick={() => onPick(undefined)} style={chipStyle}>
                    UNATTRIBUTED
                </button>
            </div>
        </div>
    );
}

// ── Styles ─────────────────────────────────────────────────────────────────

// Flex column, not overlays: the banner takes the height it needs and the
// court gets everything that's left, so no part of the playing surface is
// ever hidden behind chrome.
const backdropStyle: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 6000, background: '#07080b',
    color: '#f5f6f7', fontFamily: "'JetBrains Mono',monospace", overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
};

const bannerStyle: CSSProperties = {
    flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
    background: '#0a0b0d', borderBottom: '1px solid', fontSize: 13,
};

const courtAreaStyle: CSSProperties = {
    position: 'relative', flex: 1, minHeight: 0, padding: 6,
};

const chipStyle: CSSProperties = {
    padding: '10px 12px', minHeight: 44, background: 'transparent', border: '1px solid #2a2c31',
    color: '#f5f6f7', fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
    letterSpacing: '0.08em', cursor: 'pointer',
};

const ghostButtonStyle: CSSProperties = {
    ...chipStyle, padding: '6px 10px', minHeight: 0, borderColor: '#1f2126', color: '#7b8189',
};

const bounceStyle: CSSProperties = {
    position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 3,
    padding: '10px 18px', background: 'rgba(245,166,35,0.12)', border: `1px solid ${COLOR_BAD}`,
    color: COLOR_BAD, fontSize: 12, letterSpacing: '0.06em', whiteSpace: 'nowrap',
};

const playerStepStyle: CSSProperties = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 22, padding: 24,
};

const playerTileStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
    minWidth: 92, minHeight: 72, padding: '10px 14px',
    background: '#0a0b0d', border: '1px solid', color: '#f5f6f7',
    fontFamily: "'JetBrains Mono',monospace", cursor: 'pointer',
};
