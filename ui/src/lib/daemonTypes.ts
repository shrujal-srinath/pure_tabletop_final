// box-pi/ui/src/lib/daemonTypes.ts
//
// Hand-written TS mirror of shared/state-engine.js's JSDoc State shape —
// TypeScript can't consume JSDoc typedefs from a plain .js file as real
// types, so these exist purely for UI-side type safety. shared/state-engine.js
// remains the actual source of truth; if its shape changes, these must be
// updated to match (they are not generated/derived automatically).

export interface Player {
    id: string;
    name: string;
    number: string;
    fouls: number;
    fouledOut: boolean;
}

export interface Team {
    name: string;
    color: string;
    score: number;
    fouls: number;
    timeouts: number;
    players: Player[];
}

export interface ClockState {
    gameMs: number;
    shotMs: number;
    isRunning: boolean;
    shotClockRunning: boolean;
    period: number;
    totalPeriods: number;
    periodMs: number;
    shotClockMs: number;
}

export type GameMode = 'quick' | 'stats' | 'advanced';

export interface GameMeta {
    gameCode: string | null;
    gameActive: boolean;
    gameMode: GameMode;
}

export interface PendingAttribution {
    team: 'A' | 'B';
    points: 1 | 2 | 3;
    ts: number | null;
}

export interface DaemonState {
    teamA: Team;
    teamB: Team;
    clock: ClockState;
    possession: 'A' | 'B';
    meta: GameMeta;
    pendingAttribution: PendingAttribution | null;
    lastError: string | null;
    // Present on the real wire payload today — daemon/index.js broadcasts
    // its internal state object as-is and never strips this before
    // io.emit(). It's an internal single-level undo snapshot, not something
    // the UI should ever read; typed here only so this interface matches
    // what's actually sent, not what "should" be sent. See LiveGame.tsx's
    // top comment for the flagged daemon-side inefficiency this implies
    // (a full nested snapshot re-sent on every broadcast, including ticks).
    _previousState: DaemonState | null;
}

export interface ScorePendingPayload {
    team: 'A' | 'B';
    points: 1 | 2 | 3;
    ts: number;
}

export interface TouchLockStatusPayload {
    unlocked: boolean;
}

export type BootStage = 'resuming_state' | 'starting_server' | 'connecting_uart' | 'starting_clock' | 'ready';

export interface BootProgressPayload {
    stage: BootStage;
    percent: number;
    detail?: string;
}
