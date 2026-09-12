// box-pi/scripts/test-clock.mjs
// Throwaway verification for daemon/clock.js — confirms onTick reports real
// measured elapsed time, and that a stop/start cycle doesn't dump the idle
// gap into the next tick's delta.

import { createTicker } from '../daemon/clock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tickCount = 0;
let summedDeltas = 0;
const deltas = [];

const ticker = createTicker({
    intervalMs: 100,
    onTick: (deltaMs) => {
        tickCount += 1;
        summedDeltas += deltaMs;
        deltas.push(deltaMs);
        console.log(`tick #${tickCount}: actualDeltaMs=${deltaMs}`);
    },
});

console.log('─── phase 1: start, run ~5 ticks, stop ───');
const wallStart = Date.now();
ticker.start();
await sleep(560); // ~5.6 ticks at 100ms
ticker.stop();
const wallElapsedPhase1 = Date.now() - wallStart;

console.log(`\nticks fired: ${tickCount}`);
console.log(`sum of reported deltas: ${summedDeltas}ms`);
console.log(`independently measured wall-clock elapsed: ${wallElapsedPhase1}ms`);
console.log(`difference: ${Math.abs(wallElapsedPhase1 - summedDeltas)}ms (should be small — just setInterval jitter)`);

console.log('\n─── phase 2: idle for 800ms while stopped ───');
await sleep(800);

console.log('\n─── phase 3: start again, check the FIRST tick after restart ───');
tickCount = 0;
const restartAt = Date.now();
ticker.start();
await new Promise((resolve) => {
    const check = setInterval(() => {
        if (tickCount >= 1) {
            clearInterval(check);
            resolve();
        }
    }, 10);
});
ticker.stop();

console.log(`first tick's reported delta: ${deltas[deltas.length - 1]}ms`);
console.log('expected: ~100ms (the nominal interval), NOT ~800-900ms (the idle gap) — confirms no drift carries across stop/start');
