// box-pi/ui/src/lib/setupTypes.ts — shared between MatchSetup and
// RosterSetup, since Roster Setup needs the fields Match Setup collected
// to build the final combined setup_game payload.

import type { GameMode } from './daemonTypes';

export interface MatchFields {
    teamAName: string;
    teamAColor: string;
    teamBName: string;
    teamBColor: string;
    periodMinutes: number;
    shotClockSeconds: number;
    periods: number;
    gameMode: GameMode;
}

// number is a string (jersey numbers are display text) — matches
// state-engine.js's real Player/normalizeRoster types and the corrected
// wire-contract.js SetupGamePayload.roster shape (task 6d).
export interface RosterPlayerDraft {
    id: string;
    name: string;
    number: string;
}

export const DEFAULT_MATCH_FIELDS: MatchFields = {
    teamAName: '',
    teamAColor: '#EF4444',
    teamBName: '',
    teamBColor: '#3B82F6',
    periodMinutes: 10,
    shotClockSeconds: 24,
    periods: 4,
    gameMode: 'quick',
};
