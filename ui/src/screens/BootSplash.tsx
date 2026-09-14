// box-pi/ui/src/screens/BootSplash.tsx
//
// Ported from Claude Design (project "Splash screen refinement for
// Waveshare", file "Splash Screen v8 Turbine.dc.html") — a hand-tuned
// canvas-runtime (x-dc / <sc-for> / {{ }} bindings, driven by support.js)
// that this app does not depend on. This file is a faithful port of the
// WRAPPER only: the animation math (ring rotations, the radial
// oscilloscope wave, the stage-segment fill sequence, ripple timing, the
// comet/pin sweep) is copied unchanged from the source's componentDidMount/
// start/tick/paint/toEnd methods, just driven off refs + requestAnimationFrame
// instead of the source's this.n / querySelector pattern — never pushed
// through React state/re-render (would cost real perf for zero benefit;
// the source already avoids this the right way).
//
// How this screen ends: real boot progress, not a fake timer — but the
// ANIMATION itself (PRIME spin-up, then the LOAD-phase sweep) is driven
// purely by elapsed wall-clock time against fixed durations, exactly like
// the source. This distinction matters and was the root cause of a real
// bug in an earlier version of this fix: that version derived `e` by
// exponentially SMOOTHING toward whatever the real BOOT_PROGRESS percent
// currently was, which meant `e` (and therefore `spin = 360+e*720`, and
// therefore every rotating layer) advanced in discrete jumps timed to
// when each real backend event happened to arrive — visually, the wheel
// "spun several times separately" instead of turning through one smooth,
// continuous sweep. The fix: `e` is now the source's own pure time-based
// formula (`t = loadElapsedMs/LOAD_DURATION_MS` clamped to 1,
// `e = 1-(1-t)^3`, an ease-out cubic — see `LOAD_DURATION_MS` below),
// completely decoupled from real backend timing. The real reported
// percent is used ONLY as a CEILING (`Math.min(pacedE, realCeiling)`) —
// it can hold the sweep back (a genuinely slow boot never gets rushed
// past stages that haven't actually completed) but can never make it
// jump forward faster than the deliberate pace, and — since both the
// paced curve and the real ceiling are individually monotonically
// non-decreasing over time — their min is too, so `e` can never regress
// on its own; no separate floor/clamp needed to guarantee that.
//
// `onReady()` fires — once — when BOTH elapsedMs-since-mount >= MIN_MS
// (now `PRIME_MS + LOAD_DURATION_MS`, i.e. the exact total time the
// animation takes to visually complete — see `MIN_MS`) and the daemon
// has actually reported `ready`; App.tsx unmounts this screen and routes
// to Dashboard in response. `readyFiredRef` gates BOTH `onReady()` and
// the loop's own permanent stop condition (`e >= 0.999 -> toEnd()`) —
// this ordering matters: an earlier version stopped the animation loop
// purely on visual percent reaching ~100%, with no check that real-ready
// + MIN_MS had actually been confirmed — if the visual dial reached 100%
// first, the loop died permanently with nothing left to ever call
// `onReady()` again, stranding the app on this screen forever. Now the
// loop only stops once `onReady()` has already fired.
//
// A repeat view within the SAME browser session (Return-to-Dashboard,
// Start New Game — box-pi navigates via full page reloads, so this
// component genuinely remounts each time) skips the deliberate pacing
// and the MIN_MS floor entirely via a `sessionStorage` flag set the
// first time a real boot sequence completes — see `SPLASH_SEEN_KEY` —
// and just tracks real progress directly (lightly smoothed, not paced),
// landing on Dashboard near-instantly since the daemon's been running
// the whole time. A genuinely NEW session (an actual device/browser
// restart — the real cold boot a kiosk experiences) always gets the
// full paced sweep again, even if the daemon happens to already be
// fully booted by the time the page connects — that's deliberate, not a
// bug: "even if boot finishes in under a second" the sweep still plays
// out, which is exactly why the real-percent ceiling above only ever
// holds the sweep back, never fast-forwards it.
//
// One deliberate exception to the session-skip, via `isBrowserReload()`:
// a manual browser reload (F5/Cmd+R) always gets the full animation too,
// even within an already-"seen" session — the Navigation Timing API
// reports `type: 'reload'` only for an actual reload, never for the
// app's own `window.location.href` navigations, so the two are reliably
// distinguishable. An operator hitting reload is a deliberate "show me
// this again" gesture (or troubleshooting), not the same intent as
// clicking through Return-to-Dashboard mid-session — showing an instant
// flash there reads as broken, not as the feature working.
//
// A separate safety net (`NO_PROGRESS_FALLBACK_MS`) exists for a rare
// failure mode distinct from "a genuinely slow boot": if NO real
// BOOT_PROGRESS has arrived at all for several seconds — data loss, not
// slowness, since a healthy connection reports its first stage within
// milliseconds — the real-percent ceiling stops holding `e` pinned at 0
// and opens fully, so the paced sweep can still complete instead of
// freezing the wheel forever while `ELAPSED` keeps counting up. The
// stall indicator still separately warns if this is happening.
//
// If BOOT_PROGRESS goes quiet for a while, a small stall indicator
// appears — this is a real device that might be waiting on a slow UART
// connection or a cloud-fallback network hiccup, and a silently frozen
// bar is a worse experience than an honest "still starting up".
//
// `opId` (top-right "OP_ID" readout, and the QR caption's ?tv= param):
// the source's own placeholder value, kept as-is. There's no real
// equivalent yet — a box-level device id, not a per-game code — flagged
// rather than invented.

import { useEffect, useRef } from 'react';
import type { BootProgressPayload } from '../lib/daemonTypes';

// PRIME: the fixed local spin-up flourish before any real-progress
// tracking begins — see the source's own tick(). Unchanged across every
// fix so far; ground-truth spec confirms 1100ms is correct.
const PRIME_MS = 1100;
// LOAD: the deliberate visual sweep's duration, per the ground-truth
// spec — `t = loadElapsedMs/LOAD_DURATION_MS` clamped to 1,
// `e = 1-(1-t)^3`. This replaces two earlier guesses (3000, then 4000
// total) with the actual authoritative number.
const LOAD_DURATION_MS = 4400;
// Total mount-to-ready time on a genuine first boot this session —
// DERIVED from the two constants above (not a separately guessed
// number) so it can't drift out of sync with what the animation actually
// takes to visually complete: PRIME_MS to spin up, then LOAD_DURATION_MS
// for the paced sweep to reach 100%. The ready-gate (`onReady()`) can't
// open before this total has elapsed, so it opens right as the sweep
// visually finishes, not before or noticeably after.
const MIN_MS = PRIME_MS + LOAD_DURATION_MS; // 5500ms
const STALL_THRESHOLD_MS = 15000;
// How long to wait for the FIRST real BOOT_PROGRESS payload before
// treating its absence as missing data rather than "still coming" — a
// healthy connection delivers it within milliseconds (see
// daemon/index.js's snapshot-on-connect), so this is a generous margin,
// not a tight one.
const NO_PROGRESS_FALLBACK_MS = 3000;
// Time constant for lightly smoothing the displayed percent on a REPEAT
// session view only (see `skipMinimum` below) — that path tracks real
// progress directly rather than the deliberate paced sweep, and this
// just keeps a rare late stage-jump from looking like a hard cut. The
// paced first-view sweep below does NOT use this — it's driven by the
// pure `e = 1-(1-t)^3` formula instead, deliberately decoupled from real
// backend event timing (see the file header for why that distinction
// is the actual fix here, not a stylistic choice).
const SMOOTH_TAU_MS = 600;
// sessionStorage flag: once the splash has genuinely completed a real
// boot sequence in this browser session, later mounts (Return-to-
// Dashboard, Start New Game — box-pi navigates via full page reloads,
// so this component remounts fresh each time) skip both the deliberate
// pacing and the MIN_MS floor entirely and just track real progress,
// which for an already-running daemon is ready/100 immediately via the
// snapshot-on-connect behavior. Session-scoped (not localStorage) on
// purpose: an actual device/browser restart — the real "cold boot" a
// kiosk experiences — starts a fresh session and gets the full
// animation again.
const SPLASH_SEEN_KEY = 'box-pi-splash-shown';
function hasShownSplashThisSession(): boolean {
    try {
        return sessionStorage.getItem(SPLASH_SEEN_KEY) === '1';
    } catch {
        return false; // storage unavailable (e.g. private mode) — default to the full experience, not a skip
    }
}
// A manual browser reload (F5/Cmd+R) is a real, distinct signal from the
// app's own internal full-page navigations (Return-to-Dashboard/Start
// New Game both use window.location.href) — the Navigation Timing API
// reports `type: 'reload'` ONLY for an actual reload, never for those.
// An operator hitting reload is a deliberate "look at this again"
// gesture (or troubleshooting) and should always get the full show,
// even within the same session — only the app's OWN navigations skip it.
function isBrowserReload(): boolean {
    try {
        const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        return nav?.type === 'reload';
    } catch {
        return false;
    }
}
// The single source of truth for "should this mount skip the deliberate
// pacing/MIN_MS floor" — a repeat view this session, EXCEPT a genuine
// manual reload, which always gets the full animation regardless.
function shouldSkipMinimum(): boolean {
    return hasShownSplashThisSession() && !isBrowserReload();
}
function markSplashShownThisSession(): void {
    try {
        sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
    } catch {
        // ignore — not critical if this can't be persisted
    }
}

// ── Geometry (unchanged from the source's renderVals()) ─────────────────

function polar(r: number, deg: number): [number, number] {
    const a = ((deg - 90) * Math.PI) / 180;
    return [Math.cos(a) * r, Math.sin(a) * r];
}
function arcPath(r: number, s: number, e: number): string {
    const [x1, y1] = polar(r, s);
    const [x2, y2] = polar(r, e);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const ARC_R = 190;
const C_ARC = 2 * Math.PI * ARC_R;
const SEG_R = 168;
const SEG_GAP = 9;
const HUB_R = 94;
const C_HUB = 2 * Math.PI * HUB_R;
const WAVE_N = 168;
const WAVE_BASE = 213;
const WAVE_AMP = 9.5;
// The source's STAGES array also carries label/link/subs per stage, but
// paint() never actually reads them in this version of the design (only
// STAGES.length, for the 6 arc segments) — kept as a plain count rather
// than porting unused fields.
const STAGE_COUNT = 6;

interface Line { x1: number; y1: number; x2: number; y2: number; c: string; w: number }

function computeGeometry() {
    const brackets = [45, 135, 225, 315].map((d) => ({ d: arcPath(250, d - 13, d + 13) }));

    const rivets: { x: number; y: number }[] = [];
    for (let d = 0; d < 360; d += 45) {
        const [x, y] = polar(250, d + 22.5);
        rivets.push({ x: +x.toFixed(2), y: +y.toFixed(2) });
    }

    const housingNums = ([[0, '000'], [90, '090'], [180, '180'], [270, '270']] as const).map(([d, txt]) => {
        const [x, y] = polar(250, d);
        return { x: +x.toFixed(2), y: +y.toFixed(2), txt };
    });

    const ring1: Line[] = [];
    for (let i = 0; i < 180; i++) {
        const deg = i * 2;
        const heavy = i % 15 === 0;
        const mid = i % 5 === 0;
        const r1 = heavy ? 226 : mid ? 230 : 233;
        const [x1, y1] = polar(r1, deg);
        const [x2, y2] = polar(240, deg);
        ring1.push({
            x1: +x1.toFixed(2), y1: +y1.toFixed(2), x2: +x2.toFixed(2), y2: +y2.toFixed(2),
            c: heavy ? 'rgba(255,255,255,0.5)' : mid ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.12)',
            w: heavy ? 1.2 : mid ? 0.8 : 0.5,
        });
    }

    const sweep: { x1: number; y1: number; x2: number; y2: number; o: number }[] = [];
    for (let i = 0; i < 22; i++) {
        const deg = -i * 2.4;
        const [x1, y1] = polar(112, deg);
        const [x2, y2] = polar(238, deg);
        sweep.push({ x1: +x1.toFixed(2), y1: +y1.toFixed(2), x2: +x2.toFixed(2), y2: +y2.toFixed(2), o: +(0.26 * (1 - i / 22)).toFixed(3) });
    }

    const majors: Line[] = [];
    for (let i = 0; i < 24; i++) {
        const deg = i * 15;
        const heavy = i % 6 === 0;
        const [x1, y1] = polar(197, deg);
        const [x2, y2] = polar(heavy ? 208 : 203, deg);
        majors.push({ x1: +x1.toFixed(2), y1: +y1.toFixed(2), x2: +x2.toFixed(2), y2: +y2.toFixed(2), c: heavy ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.2)', w: heavy ? 1.1 : 0.7 });
    }

    const segs: { d: string; num: string; tx1: number; ty1: number; tx2: number; ty2: number; nx: number; ny: number }[] = [];
    for (let i = 0; i < STAGE_COUNT; i++) {
        const start = i * 60 + SEG_GAP / 2;
        const end = (i + 1) * 60 - SEG_GAP / 2;
        const mid = (start + end) / 2;
        const [tx1, ty1] = polar(162, start);
        const [tx2, ty2] = polar(174, start);
        const [nx, ny] = polar(152, mid);
        segs.push({
            d: arcPath(SEG_R, start, end), num: String(i + 1).padStart(2, '0'),
            tx1: +tx1.toFixed(2), ty1: +ty1.toFixed(2), tx2: +tx2.toFixed(2), ty2: +ty2.toFixed(2),
            nx: +nx.toFixed(2), ny: +ny.toFixed(2),
        });
    }

    const orb1: { x: number; y: number; c: string }[] = [];
    for (let i = 0; i < 5; i++) {
        const [x, y] = polar(146, i * 72 + 14);
        orb1.push({ x: +x.toFixed(2), y: +y.toFixed(2), c: i === 0 ? '#ef2b2d' : 'rgba(200,204,210,0.7)' });
    }

    const orb2: { tr: string; c: string }[] = [];
    for (let i = 0; i < 4; i++) {
        const deg = i * 90 + 30;
        const [x, y] = polar(130, deg);
        orb2.push({ tr: `translate(${x.toFixed(2)},${y.toFixed(2)}) rotate(${deg})`, c: i % 2 ? '#4c86ff' : 'rgba(200,204,210,0.55)' });
    }

    const teeth: { x1: number; y1: number; x2: number; y2: number; c: string }[] = [];
    for (let i = 0; i < 72; i++) {
        const deg = i * 5;
        const heavy = i % 6 === 0;
        const [x1, y1] = polar(heavy ? 99 : 103, deg);
        const [x2, y2] = polar(108, deg);
        teeth.push({ x1: +x1.toFixed(2), y1: +y1.toFixed(2), x2: +x2.toFixed(2), y2: +y2.toFixed(2), c: heavy ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.16)' });
    }

    return { brackets, rivets, housingNums, ring1, sweep, majors, segs, orb1, orb2, teeth, trailPath: arcPath(ARC_R, -9, 0) };
}

const GEO = computeGeometry();

interface Ripple { el: SVGCircleElement; t0: number }

export function BootSplash({
    opId = 'K7QM', bootProgress = null, onReady, autoReplay = true,
}: {
    opId?: string;
    bootProgress?: BootProgressPayload | null;
    onReady?: () => void;
    autoReplay?: boolean;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const stallRef = useRef<HTMLDivElement>(null);
    const dialRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const ctaRef = useRef<HTMLDivElement>(null);
    const ulRef = useRef<HTMLDivElement>(null);
    const arcRef = useRef<SVGCircleElement>(null);
    const cometRef = useRef<SVGGElement>(null);
    const pinRef = useRef<SVGGElement>(null);
    const ring1GroupRef = useRef<SVGGElement>(null);
    const sweepGroupRef = useRef<SVGGElement>(null);
    const teethGroupRef = useRef<SVGGElement>(null);
    const orb1GroupRef = useRef<SVGGElement>(null);
    const orb2GroupRef = useRef<SVGGElement>(null);
    const waveRef = useRef<SVGPathElement>(null);
    const wave2Ref = useRef<SVGPathElement>(null);
    const hubringRef = useRef<SVGCircleElement>(null);
    const pctRef = useRef<HTMLSpanElement>(null);
    const captionRef = useRef<HTMLDivElement>(null);
    const metaRef = useRef<HTMLDivElement>(null);
    const trailGroupRef = useRef<SVGGElement>(null);
    const segRefs = useRef<SVGPathElement[]>([]);
    const snumRefs = useRef<SVGTextElement[]>([]);
    const rippleRefs = useRef<SVGCircleElement[]>([]);

    // Real-progress-driven state, read every animation frame but written
    // from outside the frame loop — refs so a new bootProgress payload (or
    // a re-created onReady closure) never has to restart the whole
    // animation effect below (that would reset the ripple pool, replay
    // PRIME, etc. — visibly janky for what should be a smooth update).
    const targetPercentRef = useRef(0);
    const displayedPercentRef = useRef(0);
    const stageRef = useRef<BootProgressPayload['stage'] | null>(null);
    const lastProgressAtRef = useRef(performance.now());
    const readyFiredRef = useRef(false);
    const onReadyRef = useRef(onReady);
    const hasReceivedFirstProgressRef = useRef(false);

    useEffect(() => {
        onReadyRef.current = onReady;
    }, [onReady]);

    useEffect(() => {
        if (!bootProgress) return;
        const clamped = Math.max(0, Math.min(100, bootProgress.percent));
        targetPercentRef.current = clamped;
        stageRef.current = bootProgress.stage;
        lastProgressAtRef.current = performance.now();
        // The very FIRST payload this component ever receives is a
        // snapshot of wherever the daemon already is (see daemon/index.js's
        // io.on('connection', ...) — every socket gets the current stage
        // immediately), not a transition from a previously-observed real
        // stage — smoothing/pacing FROM 0 in that case would take several
        // seconds to visually catch up. Snapping straight to it is only
        // correct on a REPEAT view this session, though (skipMinimum) —
        // that's the "operator already watched the Pi finish booting a
        // minute ago, then hit Start New Game" case, and an instant,
        // accurate readout is exactly right there. On a genuine first
        // view this session, even if the daemon happens to already be
        // fully ready by the time this connects, the deliberate pacing in
        // the animation loop below must still govern the readout — the
        // whole point of this feature is that the sweep plays out over
        // roughly MIN_MS regardless of how fast the real backend was.
        if (!hasReceivedFirstProgressRef.current) {
            hasReceivedFirstProgressRef.current = true;
            if (shouldSkipMinimum()) {
                displayedPercentRef.current = clamped;
            }
        }
    }, [bootProgress]);

    useEffect(() => {
        // wdirs: precomputed unit vectors for the WAVE_N+1 oscilloscope
        // samples — same as the source, computed once per mount.
        const wdirs: [number, number][] = [];
        for (let i = 0; i <= WAVE_N; i++) {
            const a = ((i / WAVE_N) * 360 - 90) * (Math.PI / 180);
            wdirs.push([Math.cos(a), Math.sin(a)]);
        }
        const segLen = ((60 - SEG_GAP) / 360) * 2 * Math.PI * SEG_R;

        // Captured once per mount, not re-checked mid-animation — a flag
        // flip partway through wouldn't make sense to react to live.
        const skipMinimum = shouldSkipMinimum();
        // On a repeat view this session, don't even make the operator sit
        // through the fixed spin-up flourish — PRIME becomes a 0ms no-op
        // and the tick() loop drops straight into real-progress tracking.
        const effectivePrimeMs = skipMinimum ? 0 : PRIME_MS;

        let raf = 0;
        let tEnd: number | undefined;
        let tReplay: number | undefined;
        let t0 = 0;
        let armed = false;
        let pulseAt = 0;
        let lastStage = -1;
        let ripplePool = 0;
        let active: Ripple[] = [];
        let lastFrameAt = performance.now();
        const mountedAt = performance.now();

        function fireRipple(now: number) {
            const ripples = rippleRefs.current;
            if (!ripples.length) return;
            const el = ripples[ripplePool % ripples.length];
            ripplePool++;
            active.push({ el, t0: now });
        }

        function paint(e: number, spin: number, priming: boolean) {
            const now = performance.now();

            const arc = arcRef.current, comet = cometRef.current, pin = pinRef.current, pct = pctRef.current;
            const sweep = sweepGroupRef.current, ring1 = ring1GroupRef.current, teeth = teethGroupRef.current;
            const orb1 = orb1GroupRef.current, orb2 = orb2GroupRef.current;
            if (!arc || !comet || !pin || !pct || !sweep || !ring1 || !teeth || !orb1 || !orb2) return;

            const dash = C_ARC * e;
            arc.setAttribute('stroke-dasharray', `${dash.toFixed(1)} ${(C_ARC - dash + 12).toFixed(1)}`);
            const rot = (e * 360 - 90).toFixed(2);
            comet.setAttribute('transform', `rotate(${rot})`);
            pin.setAttribute('transform', `rotate(${rot})`);
            pct.textContent = String(Math.floor(e * 100)).padStart(2, '0');

            sweep.setAttribute('transform', `rotate(${spin.toFixed(2)})`);
            ring1.setAttribute('transform', `rotate(${(spin * 0.25).toFixed(2)})`);
            teeth.setAttribute('transform', `rotate(${(-spin * 0.6).toFixed(2)})`);
            orb1.setAttribute('transform', `rotate(${(spin * 0.5).toFixed(2)})`);
            orb2.setAttribute('transform', `rotate(${(-spin * 0.75).toFixed(2)})`);

            const si = Math.min(5, Math.floor(e * 6));
            const loc = e * 6 - si;

            if (si !== lastStage) {
                if (lastStage >= 0) { fireRipple(now); pulseAt = now; }
                lastStage = si;
            }
            const kickRaw = pulseAt ? Math.max(0, 1 - (now - pulseAt) / 700) : 0;
            const kick = kickRaw * kickRaw;

            const ph = now / 240;
            const gain = 0.3 + e * 0.7 + kick * 0.85;
            let d = '';
            let d2 = '';
            for (let i = 0; i <= WAVE_N; i++) {
                const s = Math.sin(i * 0.42 + ph) * 0.55 + Math.sin(i * 0.13 - ph * 1.7) * 0.3 + Math.sin(i * 1.31 + ph * 2.3) * 0.15;
                const burst = (i % 21 === 0 ? 0.3 : 0) * Math.sin(ph * 3 + i);
                const rr = WAVE_BASE + (s + burst) * WAVE_AMP * gain;
                const [cx, cy] = wdirs[i];
                d += (i ? 'L' : 'M') + (cx * rr).toFixed(1) + ' ' + (cy * rr).toFixed(1) + ' ';
                const r2 = WAVE_BASE - s * 0.55 * WAVE_AMP * gain;
                d2 += (i ? 'L' : 'M') + (cx * r2).toFixed(1) + ' ' + (cy * r2).toFixed(1) + ' ';
            }
            waveRef.current?.setAttribute('d', d);
            wave2Ref.current?.setAttribute('d', d2);

            if (active.length) {
                active = active.filter((rp) => {
                    const k = (now - rp.t0) / 900;
                    if (k >= 1) { rp.el.setAttribute('opacity', '0'); return false; }
                    rp.el.setAttribute('r', (108 + k * 142).toFixed(1));
                    rp.el.setAttribute('opacity', (0.5 * (1 - k)).toFixed(3));
                    return true;
                });
            }

            const hub = C_HUB * loc;
            const hubring = hubringRef.current;
            if (hubring) {
                hubring.setAttribute('stroke-dasharray', `${hub.toFixed(1)} ${(C_HUB - hub + 8).toFixed(1)}`);
                hubring.setAttribute('stroke', si === 5 ? '#ef2b2d' : '#4c86ff');
            }

            segRefs.current.forEach((p, i) => {
                const L = segLen;
                if (i < si) {
                    p.setAttribute('stroke-dasharray', `${L.toFixed(1)} 0`);
                    p.setAttribute('stroke', '#ef2b2d');
                    p.setAttribute('opacity', '0.85');
                } else if (i === si) {
                    const f = L * loc;
                    p.setAttribute('stroke-dasharray', `${f.toFixed(1)} ${(L - f).toFixed(1)}`);
                    p.setAttribute('stroke', '#4c86ff');
                    p.setAttribute('opacity', '1');
                } else {
                    p.setAttribute('stroke-dasharray', `0 ${L.toFixed(1)}`);
                    p.setAttribute('opacity', '0');
                }
            });
            snumRefs.current.forEach((t, i) => t.setAttribute('fill', i < si ? '#b4b9c0' : i === si ? '#f5f6f7' : '#7b8189'));

            if (captionRef.current) captionRef.current.textContent = priming ? 'CALIBRATING' : 'SYSTEM LOAD';
            if (metaRef.current) metaRef.current.textContent = priming ? 'SPIN-UP' : `ELAPSED ${((now - t0 - effectivePrimeMs) / 1000).toFixed(1)}S`;
            const trail = trailGroupRef.current;
            if (trail) {
                trail.setAttribute('transform', `rotate(${rot})`);
                trail.setAttribute('opacity', (0.15 + kick * 0.45).toFixed(3));
            }
        }

        function tick() {
            const now = performance.now();
            const dt = now - lastFrameAt;
            lastFrameAt = now;

            const el = now - t0;
            if (el < effectivePrimeMs) {
                const p = el / effectivePrimeMs;
                // accelerating spin-up: ends at roughly the load phase's opening
                // angular velocity so the hand-over is continuous, not a stall.
                paint(0, 360 * Math.pow(p, 1.6), true);
                raf = requestAnimationFrame(tick);
                return;
            }
            if (!armed) { armed = true; fireRipple(now); pulseAt = now; }

            let e: number;
            if (skipMinimum) {
                // Repeat view this session — no deliberate pacing, just
                // lightly-smoothed real progress (the late-joiner snap in
                // the other effect above already set displayedPercentRef
                // directly if the first payload was already near-ready;
                // this only matters for the rare case of a real
                // in-progress stage change happening during a repeat view).
                const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
                displayedPercentRef.current += (targetPercentRef.current - displayedPercentRef.current) * alpha;
                // Pure exponential decay asymptotically approaches the
                // target but never exactly reaches it — snap once close so
                // 'ready' (100) actually gets reflected on screen.
                if (Math.abs(targetPercentRef.current - displayedPercentRef.current) < 0.5) {
                    displayedPercentRef.current = targetPercentRef.current;
                }
                e = displayedPercentRef.current / 100;
            } else {
                // THE fix: e is a pure function of elapsed time (ease-out
                // cubic, matching the source exactly), never smoothed
                // toward or chasing the real backend value — that chasing
                // was the actual bug (see file header). The real reported
                // percent is used only as a ceiling: it can hold the sweep
                // back on a genuinely slow boot, never speed it up. Both
                // pacedE and realCeiling are individually monotonically
                // non-decreasing over the life of one boot sequence, so
                // their min is too — e can't regress on its own, no
                // separate floor needed.
                const loadElapsed = el - effectivePrimeMs;
                const t = Math.min(1, loadElapsed / LOAD_DURATION_MS);
                const pacedE = 1 - Math.pow(1 - t, 3);
                // Safety net: if NO real BOOT_PROGRESS has arrived at all
                // for a while (well past PRIME — a healthy connection
                // reports its first stage within milliseconds), the
                // ceiling is left fully open rather than pinning e at 0
                // forever. A hard ceiling on a value that's still its
                // untouched initial default isn't "a genuinely slow boot",
                // it's missing data — a real, if rare, failure mode (e.g.
                // a stale connection surviving a Vite HMR reload in dev)
                // that must never strand the operator on a frozen wheel.
                // The stall indicator (15s) still separately warns if the
                // daemon connection itself is actually the problem.
                let realCeiling: number;
                if (hasReceivedFirstProgressRef.current) {
                    realCeiling = targetPercentRef.current / 100;
                } else if (el < NO_PROGRESS_FALLBACK_MS) {
                    realCeiling = 0; // still within the normal "waiting for the first event" window
                } else {
                    realCeiling = 1; // safety net — no data for a while, don't strand at 0
                }
                e = Math.min(pacedE, realCeiling);
                displayedPercentRef.current = e * 100; // kept in sync for any other reader, not used to derive e itself
            }
            paint(e, 360 + e * 720, false);

            if (stallRef.current) {
                const stalled = stageRef.current !== 'ready' && now - lastProgressAtRef.current > STALL_THRESHOLD_MS;
                stallRef.current.style.opacity = stalled ? '1' : '0';
            }

            // The full MIN_MS floor applies on a genuine first boot this
            // session (skipMinimum false); a repeat view within the same
            // session skips it entirely and moves on the instant the
            // daemon reports ready — which for an already-running daemon
            // arrives near-instantly via the snapshot-on-connect behavior.
            const effectiveMinMs = skipMinimum ? 0 : MIN_MS;
            // Same safety net as the visual ceiling above, applied to the
            // actual navigation gate too: if BOOT_PROGRESS never arrives
            // at all, `stageRef.current` would stay null forever and this
            // gate would never open even once the (uncapped, per the
            // ceiling fallback) wheel visually finishes — a genuinely
            // worse outcome than a frozen wheel, since the operator would
            // see a "complete" animation that just never hands off. Treat
            // a prolonged total absence of data as effectively ready.
            const noRealDataAtAll = !hasReceivedFirstProgressRef.current && now - mountedAt >= NO_PROGRESS_FALLBACK_MS;
            const effectivelyReady = stageRef.current === 'ready' || noRealDataAtAll;
            if (!readyFiredRef.current && effectivelyReady && now - mountedAt >= effectiveMinMs) {
                readyFiredRef.current = true;
                markSplashShownThisSession();
                onReadyRef.current?.();
                // Don't return here — keep animating (holding at/near 100%)
                // in case the parent hasn't unmounted this component on the
                // very next tick; better a held frame than a stalled one.
            }

            // Only allowed to stop the rAF loop once we've already
            // confirmed real-ready + the minimum and called onReady() —
            // this was a real bug: gating purely on the VISUAL percent
            // reaching ~100% (which, before the pacing fix above, could
            // happen well before real-ready/MIN_MS on a fast boot) stopped
            // the loop for good with nothing left to ever call onReady()
            // again, permanently stranding the app on this screen.
            if (readyFiredRef.current && e >= 0.999) { toEnd(); return; }
            raf = requestAnimationFrame(tick);
        }

        function toEnd() {
            const dial = dialRef.current, end = endRef.current, ul = ulRef.current, cta = ctaRef.current;
            if (!dial || !end || !ul || !cta) return;
            dial.style.opacity = '0';
            dial.style.transform = 'scale(0.95)';
            tEnd = window.setTimeout(() => {
                end.style.opacity = '1';
                ul.style.animation = 'ulIn 900ms cubic-bezier(0.2,0.8,0.2,1) 250ms forwards';
                cta.style.animation = 'ctaIn 500ms ease-out 1000ms forwards';
                if (autoReplay) tReplay = window.setTimeout(() => start(), 5400);
            }, 400);
        }

        function stop() {
            cancelAnimationFrame(raf);
            window.clearTimeout(tEnd);
            window.clearTimeout(tReplay);
        }

        function start() {
            stop();
            const dial = dialRef.current, end = endRef.current, cta = ctaRef.current, ul = ulRef.current;
            if (!dial || !end || !cta || !ul) return;
            dial.style.opacity = '1';
            dial.style.transform = 'scale(1)';
            end.style.opacity = '0';
            cta.style.animation = 'none';
            cta.style.opacity = '0';
            ul.style.animation = 'none';
            ul.style.transform = 'scaleX(0)';
            rippleRefs.current.forEach((c) => c.setAttribute('opacity', '0'));
            active = [];
            lastStage = -1;
            armed = false;
            pulseAt = 0;
            t0 = performance.now();
            lastFrameAt = t0;
            raf = requestAnimationFrame(tick);
        }

        start();
        // Clicking the screen (or the "PRESS ANY BUTTON / ENTER" CTA once
        // visible) replays the animation — matches the source's own
        // onClick-triggers-replay interaction exactly; this component
        // doesn't need to do anything else on click, since App.tsx's own
        // state_update subscription is what actually advances past this
        // screen once the daemon is heard from.
        const root = rootRef.current;
        root?.addEventListener('click', start);

        return () => {
            stop();
            root?.removeEventListener('click', start);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoReplay]);

    return (
        <div
            ref={rootRef}
            style={{
                position: 'relative', width: '100%', height: '100vh', background: '#06070a', overflow: 'hidden',
                color: '#f5f6f7', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
        >
            {/* Fixed 1024x600 canvas — the design's own artwork is built entirely
                from fixed-pixel coordinates (this matches the target Waveshare
                panel this design was made for); centering it rather than
                rescaling keeps every ring/segment/tick pixel-identical to the
                source, per this task's fidelity requirement. */}
            <div style={{ position: 'relative', width: 1024, height: 600, flexShrink: 0 }}>
                <style>{`
                    @keyframes ulIn { 0% { transform: scaleX(0) } 100% { transform: scaleX(1) } }
                    @keyframes ctaIn { to { opacity: 1; transform: translateY(0) } }
                    @keyframes keyBlink { 50% { background: rgba(239,43,45,0.14) } }
                    @keyframes blip { 0%,100% { opacity: .25 } 50% { opacity: 1 } }
                `}</style>

                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'linear-gradient(rgba(255,255,255,0.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.018) 1px,transparent 1px)', backgroundSize: '34px 34px', maskImage: 'radial-gradient(circle at 50% 50%,#000 16%,transparent 76%)', WebkitMaskImage: 'radial-gradient(circle at 50% 50%,#000 16%,transparent 76%)' }} />
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(circle at 50% 50%,rgba(239,43,45,0.05) 0%,transparent 36%),radial-gradient(ellipse 92% 92% at 50% 50%,transparent 42%,rgba(0,0,0,0.94) 100%)' }} />

                <div style={{ position: 'absolute', top: 16, left: 16, width: 20, height: 20, borderTop: '2px solid #ef2b2d', borderLeft: '2px solid #ef2b2d' }} />
                <div style={{ position: 'absolute', top: 16, right: 16, width: 20, height: 20, borderTop: '2px solid #ef2b2d', borderRight: '2px solid #ef2b2d' }} />
                <div style={{ position: 'absolute', bottom: 16, left: 16, width: 20, height: 20, borderBottom: '2px solid #ef2b2d', borderLeft: '2px solid #ef2b2d' }} />
                <div style={{ position: 'absolute', bottom: 16, right: 16, width: 20, height: 20, borderBottom: '2px solid #ef2b2d', borderRight: '2px solid #ef2b2d' }} />

                <div style={{ position: 'absolute', top: 28, left: 40, right: 40, display: 'flex', alignItems: 'center', gap: 16, fontSize: 11, letterSpacing: '0.26em', textTransform: 'uppercase', color: '#868d95', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                    <span style={{ width: 7, height: 7, background: '#ef2b2d', flexShrink: 0, animation: 'blip 1.6s ease-in-out infinite' }} />
                    <span style={{ color: '#f5f6f7', fontWeight: 700, letterSpacing: '0.2em' }}>THE BOX</span>
                    <span>SYS · INIT</span>
                    <span style={{ flex: 1, height: 1, background: '#1f2126' }} />
                    <span>OP_ID&nbsp;<span style={{ color: '#f5f6f7', fontWeight: 700 }}>{opId}</span></span>
                    <span>v3.0_FIELD</span>
                </div>

                <div style={{ position: 'absolute', bottom: 28, left: 40, right: 40, display: 'flex', alignItems: 'center', gap: 16, fontSize: 11, letterSpacing: '0.26em', textTransform: 'uppercase', color: '#868d95', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                    <span style={{ width: 7, height: 7, background: '#4c86ff', flexShrink: 0 }} />
                    <span>BMSCE · SPORTS DEPT &amp; ROBOTICS LAB</span>
                    <span style={{ flex: 1, height: 1, background: '#1f2126' }} />
                    <span>theboxbybmsce.in</span>
                </div>

                <div ref={dialRef} style={{ position: 'absolute', inset: 0, transition: 'opacity 480ms ease, transform 480ms ease' }}>
                    <div style={{ position: 'absolute', left: '50%', top: '50%', width: 500, height: 500, transform: 'translate(-50%,-50%)' }}>
                        <svg viewBox="-256 -256 512 512" style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
                            <g>
                                <circle r={250} fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth={1} />
                                {GEO.brackets.map((b, i) => <path key={i} d={b.d} fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth={2.4} strokeLinecap="butt" />)}
                                {GEO.rivets.map((r, i) => <circle key={i} cx={r.x} cy={r.y} r={2.6} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} />)}
                                {GEO.housingNums.map((d, i) => (
                                    <text key={i} x={d.x} y={d.y} textAnchor="middle" dominantBaseline="middle" fill="#7b8189" fontFamily="JetBrains Mono, monospace" fontSize={10} letterSpacing={1.5}>{d.txt}</text>
                                ))}
                            </g>

                            <g ref={ring1GroupRef}>
                                {GEO.ring1.map((t, i) => <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.c} strokeWidth={t.w} />)}
                            </g>

                            <g ref={sweepGroupRef}>
                                {GEO.sweep.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="#ef2b2d" strokeOpacity={s.o} strokeWidth={1.2} />)}
                            </g>

                            <g>
                                <circle r={214} fill="none" stroke="rgba(255,255,255,0.035)" strokeWidth={1} />
                                <path ref={wave2Ref} d="" fill="none" stroke="rgba(76,134,255,0.35)" strokeWidth={1} strokeLinejoin="round" />
                                <path ref={waveRef} d="" fill="none" stroke="rgba(239,43,45,0.7)" strokeWidth={1.2} strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 5px rgba(239,43,45,0.35))' }} />
                            </g>

                            <g>
                                <circle ref={(el) => { if (el) rippleRefs.current[0] = el; }} r={0} fill="none" stroke="#ef2b2d" strokeWidth={1.4} opacity={0} />
                                <circle ref={(el) => { if (el) rippleRefs.current[1] = el; }} r={0} fill="none" stroke="#ef2b2d" strokeWidth={1.4} opacity={0} />
                                <circle ref={(el) => { if (el) rippleRefs.current[2] = el; }} r={0} fill="none" stroke="#4c86ff" strokeWidth={1.4} opacity={0} />
                            </g>

                            <g>
                                <circle r={190} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={9} />
                                {GEO.majors.map((m, i) => <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke={m.c} strokeWidth={m.w} />)}
                                <circle ref={arcRef} r={190} fill="none" stroke="#ef2b2d" strokeWidth={9} strokeLinecap="butt" strokeDasharray="0 1204" transform="rotate(-90)" style={{ filter: 'drop-shadow(0 0 12px rgba(239,43,45,0.45))' }} />
                                <g ref={pinRef} transform="rotate(-90)">
                                    <line x1={200} y1={0} x2={236} y2={0} stroke="rgba(239,43,45,0.5)" strokeWidth={1.2} strokeDasharray="3 4" />
                                    <polygon points="244,0 236,-4.5 236,4.5" fill="#ef2b2d" />
                                </g>
                                <g ref={trailGroupRef} transform="rotate(-90)" opacity={0.15}>
                                    <path d={GEO.trailPath} fill="none" stroke="#f5f6f7" strokeWidth={9} strokeLinecap="butt" />
                                </g>
                                <g ref={cometRef} transform="rotate(-90)">
                                    <circle cx={190} cy={0} r={13} fill="none" stroke="#ef2b2d" strokeOpacity={0.3} strokeWidth={1} />
                                    <circle cx={190} cy={0} r={5} fill="#ef2b2d" />
                                    <line x1={171} y1={0} x2={209} y2={0} stroke="#f5f6f7" strokeWidth={1} />
                                </g>
                            </g>

                            <g>
                                {GEO.segs.map((s, i) => <path key={i} d={s.d} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={6} strokeLinecap="butt" />)}
                                {GEO.segs.map((s, i) => (
                                    <path key={i} ref={(el) => { if (el) segRefs.current[i] = el; }} d={s.d} fill="none" stroke="#4c86ff" strokeWidth={6} strokeLinecap="butt" strokeDasharray="0 158" opacity={0} />
                                ))}
                                {GEO.segs.map((s, i) => <line key={i} x1={s.tx1} y1={s.ty1} x2={s.tx2} y2={s.ty2} stroke="rgba(255,255,255,0.26)" strokeWidth={0.8} />)}
                                {GEO.segs.map((s, i) => (
                                    <text key={i} ref={(el) => { if (el) snumRefs.current[i] = el; }} x={s.nx} y={s.ny} textAnchor="middle" dominantBaseline="middle" fill="#7b8189" fontFamily="JetBrains Mono, monospace" fontSize={11} letterSpacing={1}>{s.num}</text>
                                ))}
                            </g>

                            <g>
                                <circle r={146} fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth={0.8} strokeDasharray="2 6" />
                                <circle r={130} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={0.8} />
                                <g ref={orb1GroupRef}>
                                    {GEO.orb1.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={2} fill={s.c} />)}
                                </g>
                                <g ref={orb2GroupRef}>
                                    {GEO.orb2.map((s, i) => (
                                        <g key={i} transform={s.tr}>
                                            <line x1={-4} y1={0} x2={4} y2={0} stroke={s.c} strokeWidth={1.3} />
                                        </g>
                                    ))}
                                </g>
                            </g>

                            <g>
                                <circle r={108} fill="#06070a" stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                                <g ref={teethGroupRef}>
                                    {GEO.teeth.map((t, i) => <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.c} strokeWidth={0.8} />)}
                                </g>
                                <circle r={94} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={2.5} />
                                <circle ref={hubringRef} r={94} fill="none" stroke="#4c86ff" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="0 600" transform="rotate(-90)" />
                                <line x1={-108} y1={0} x2={-96} y2={0} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
                                <line x1={96} y1={0} x2={108} y2={0} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
                                <line x1={0} y1={-108} x2={0} y2={-96} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
                                <line x1={0} y1={96} x2={0} y2={108} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
                            </g>
                        </svg>

                        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                                <div ref={captionRef} style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.42em', color: '#7b8189', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>SYSTEM&nbsp;LOAD</div>
                                <div style={{ fontFamily: "'Archivo',sans-serif", fontStyle: 'italic', fontWeight: 900, fontSize: 80, lineHeight: 0.76, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: '#f5f6f7' }}>
                                    <span ref={pctRef} data-testid="boot-pct">00</span><span style={{ color: '#ef2b2d', fontSize: '0.34em', marginLeft: 4, verticalAlign: '0.55em' }}>%</span>
                                </div>
                                <div style={{ width: 96, height: 1, background: '#232629' }} />
                                <div ref={metaRef} style={{ fontSize: 10, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#7b8189', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>ELAPSED&nbsp;0.0S</div>
                                {/* Not part of the original design — added so an operator staring
                                    at a genuinely slow boot (a stalled UART link, a cloud-fallback
                                    network hiccup) sees an honest "still working" instead of a
                                    silently frozen bar. Hidden by default; shown/hidden every frame
                                    by the animation loop via style.opacity, not React state. */}
                                <div ref={stallRef} style={{ opacity: 0, transition: 'opacity 400ms ease', fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#ef2b2d', whiteSpace: 'nowrap' }}>
                                    still starting up&hellip;
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div ref={endRef} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0, pointerEvents: 'none', transition: 'opacity 500ms ease' }}>
                    <div style={{ position: 'relative' }}>
                        <div style={{ fontFamily: "'Archivo',sans-serif", fontStyle: 'italic', fontWeight: 900, fontSize: 116, lineHeight: 0.84, letterSpacing: '-0.025em', textTransform: 'uppercase', whiteSpace: 'nowrap', color: '#f5f6f7' }}>THE&nbsp;BOX</div>
                        <div ref={ulRef} style={{ position: 'absolute', left: '5%', right: '5%', bottom: -8, height: 5, background: '#ef2b2d', boxShadow: '0 0 22px rgba(239,43,45,0.45)', transform: 'scaleX(0)', transformOrigin: 'left' }} />
                    </div>
                    <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, letterSpacing: '0.36em', textTransform: 'uppercase', color: '#868d95' }}>
                        <span>TABLE-TOP</span>
                        <span style={{ width: 5, height: 5, background: '#ef2b2d', transform: 'rotate(45deg)' }} />
                        <span style={{ color: '#f5f6f7' }}>REFEREE&nbsp;SCORING&nbsp;DEVICE</span>
                        <span style={{ width: 5, height: 5, background: '#ef2b2d', transform: 'rotate(45deg)' }} />
                        <span>BMSCE</span>
                    </div>
                    <div ref={ctaRef} style={{ marginTop: 38, display: 'flex', alignItems: 'center', gap: 46, opacity: 0, transform: 'translateY(8px)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                            <div style={{ position: 'relative', padding: 14, border: '1px solid #1f2126', background: '#0a0b0d' }}>
                                <span style={{ position: 'absolute', top: 0, left: 12, transform: 'translateY(-50%)', background: '#06070a', padding: '0 6px', fontSize: 9, letterSpacing: '0.28em', color: '#4c86ff', textTransform: 'uppercase' }}>CAST_LINK</span>
                                <div style={{ position: 'absolute', top: -8, left: -8, width: 16, height: 16, borderTop: '2px solid #4c86ff', borderLeft: '2px solid #4c86ff' }} />
                                <div style={{ position: 'absolute', top: -8, right: -8, width: 16, height: 16, borderTop: '2px solid #4c86ff', borderRight: '2px solid #4c86ff' }} />
                                <div style={{ position: 'absolute', bottom: -8, left: -8, width: 16, height: 16, borderBottom: '2px solid #4c86ff', borderLeft: '2px solid #4c86ff' }} />
                                <div style={{ position: 'absolute', bottom: -8, right: -8, width: 16, height: 16, borderBottom: '2px solid #4c86ff', borderRight: '2px solid #4c86ff' }} />
                                <div style={{ position: 'relative', width: 132, height: 132, background: '#f5f6f7', backgroundImage: 'repeating-linear-gradient(135deg,#0b0c0e 0 3px,transparent 3px 7px)', display: 'grid', placeItems: 'center' }}>
                                    <div style={{ position: 'absolute', top: 8, left: 8, width: 26, height: 26, border: '5px solid #0b0c0e', background: '#f5f6f7' }} />
                                    <div style={{ position: 'absolute', top: 8, right: 8, width: 26, height: 26, border: '5px solid #0b0c0e', background: '#f5f6f7' }} />
                                    <div style={{ position: 'absolute', bottom: 8, left: 8, width: 26, height: 26, border: '5px solid #0b0c0e', background: '#f5f6f7' }} />
                                    <div style={{ position: 'relative', padding: '3px 5px', background: '#f5f6f7', fontSize: 8, letterSpacing: '0.14em', color: '#0b0c0e', textTransform: 'uppercase' }}>QR AT RUNTIME</div>
                                </div>
                            </div>
                            <div style={{ fontSize: 10, letterSpacing: '0.28em', color: '#4c86ff', textTransform: 'uppercase' }}>SCAN TO CAST A GAME</div>
                            <div style={{ fontSize: 9, letterSpacing: '0.12em', color: '#6a7078' }}>theboxbybmsce.in/cast?tv=<span style={{ color: '#9aa0a8' }}>{opId}</span></div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, alignSelf: 'stretch', padding: '14px 0 38px' }}>
                            <span style={{ flex: 1, width: 1, background: '#232629' }} />
                            <span style={{ fontSize: 10, letterSpacing: '0.28em', color: '#7b8189' }}>OR</span>
                            <span style={{ flex: 1, width: 1, background: '#232629' }} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.26em', textTransform: 'uppercase', color: '#868d95' }}>PRESS ANY BUTTON</div>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 30px', border: '1px solid rgba(239,43,45,0.5)', boxShadow: 'inset 0 -3px 0 rgba(239,43,45,0.22), 0 0 26px rgba(239,43,45,0.08)', fontSize: 15, fontWeight: 700, letterSpacing: '0.22em', color: '#ef2b2d', animation: 'keyBlink 1.4s steps(2) infinite' }}>⏎&nbsp;ENTER</div>
                            <div style={{ fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#6a7078' }}>TO ENTER DASHBOARD</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
