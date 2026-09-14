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
    // state-engine.js's own State typedef declares this as required (the
    // reducer's real internal state always carries it — needed for UNDO
    // to work at all), and shared state-engine.js functions like isBonus/
    // isFouledOut are typed against State, so this interface keeps it
    // required too for structural compatibility with those. In reality it
    // no longer arrives over the wire at all (daemon/index.js strips it
    // from every state_update broadcast — flagged in Task 6b, closed as a
    // follow-up: roughly doubled payload size for no reason the UI ever
    // needed) — App.tsx's onStateUpdate is the one place that patches an
    // incoming payload back to `_previousState: null` so every other
    // consumer of DaemonState can keep treating it as always-present,
    // never `undefined`.
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

export interface BoxIdentityPayload {
    boxCode: string;
}

export interface RemoteGameAvailablePayload {
    gameCode: string;
}
