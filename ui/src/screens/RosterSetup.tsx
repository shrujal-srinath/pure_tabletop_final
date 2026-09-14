// box-pi/ui/src/screens/RosterSetup.tsx
//
// Only reached from MatchSetup when gameMode is 'stats'/'advanced'.
// Collects per-team rosters, then combines them with the MatchFields
// MatchSetup already gathered into ONE setup_game send — this screen owns
// that send (and the setup_error/game_ready listening for it), MatchSetup
// never touches the socket for this path at all.

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { socket, LAN_EVENTS } from '../lib/socket';
import type { MatchFields, RosterPlayerDraft } from '../lib/setupTypes';

const MIN_PLAYERS_PER_TEAM = 1;

function duplicateNumbers(players: RosterPlayerDraft[]): Set<string> {
    const seen = new Map<string, number>();
    for (const p of players) {
        const n = p.number.trim();
        if (!n) continue;
        seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([n]) => n));
}

export function RosterSetup({ matchFields, onBack }: { matchFields: MatchFields; onBack: () => void }) {
    const [rosterA, setRosterA] = useState<RosterPlayerDraft[]>([]);
    const [rosterB, setRosterB] = useState<RosterPlayerDraft[]>([]);
    const [setupError, setSetupError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [touched, setTouched] = useState(false);

    useEffect(() => {
        function onError(payload: { message: string }) {
            setSetupError(payload.message);
            setSubmitting(false);
        }
        socket.on(LAN_EVENTS.SETUP_ERROR, onError);
        return () => {
            socket.off(LAN_EVENTS.SETUP_ERROR, onError);
        };
    }, []);

    const dupA = duplicateNumbers(rosterA);
    const dupB = duplicateNumbers(rosterB);
    const errors: string[] = [];
    if (rosterA.length < MIN_PLAYERS_PER_TEAM) errors.push(`${matchFields.teamAName} needs at least ${MIN_PLAYERS_PER_TEAM} player.`);
    if (rosterB.length < MIN_PLAYERS_PER_TEAM) errors.push(`${matchFields.teamBName} needs at least ${MIN_PLAYERS_PER_TEAM} player.`);
    if (dupA.size > 0) errors.push(`${matchFields.teamAName} has duplicate jersey number(s): ${[...dupA].join(', ')}.`);
    if (dupB.size > 0) errors.push(`${matchFields.teamBName} has duplicate jersey number(s): ${[...dupB].join(', ')}.`);

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setTouched(true);
        if (errors.length > 0 || submitting) return;
        setSetupError(null);
        setSubmitting(true);
        socket.emit(LAN_EVENTS.SETUP_GAME, {
            ...matchFields,
            roster: {
                teamA: rosterA.map(({ id, name, number }) => ({ id, name, number })),
                teamB: rosterB.map(({ id, name, number }) => ({ id, name, number })),
            },
        });
        // App.tsx's top-level state_update subscription flips to LiveGame
        // automatically once meta.gameActive becomes true.
    }

    return (
        <div style={pageStyle}>
            <h1 style={{ marginTop: 0 }}>ROSTER SETUP</h1>
            <form onSubmit={handleSubmit}>
                <div style={rowStyle}>
                    <RosterEditor teamName={matchFields.teamAName} players={rosterA} setPlayers={setRosterA} duplicates={dupA} />
                    <RosterEditor teamName={matchFields.teamBName} players={rosterB} setPlayers={setRosterB} duplicates={dupB} />
                </div>

                {touched && errors.length > 0 && (
                    <ul style={errorListStyle}>
                        {errors.map((err) => (
                            <li key={err}>{err}</li>
                        ))}
                    </ul>
                )}
                {setupError && <div style={setupErrorStyle}>Daemon rejected setup: {setupError}</div>}

                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                    <button type="button" onClick={onBack} style={{ ...buttonStyle, opacity: 0.7 }}>
                        ← Back
                    </button>
                    <button type="submit" disabled={submitting} style={{ ...buttonStyle, opacity: submitting ? 0.4 : 1, cursor: submitting ? 'not-allowed' : 'pointer' }}>
                        Start game
                    </button>
                </div>
            </form>
        </div>
    );
}

function RosterEditor({
    teamName, players, setPlayers, duplicates,
}: {
    teamName: string;
    players: RosterPlayerDraft[];
    setPlayers: (fn: (prev: RosterPlayerDraft[]) => RosterPlayerDraft[]) => void;
    duplicates: Set<string>;
}) {
    const [draftName, setDraftName] = useState('');
    const [draftNumber, setDraftNumber] = useState('');

    function addPlayer() {
        if (!draftName.trim() || !draftNumber.trim()) return;
        setPlayers((prev) => [...prev, { id: crypto.randomUUID(), name: draftName.trim(), number: draftNumber.trim() }]);
        setDraftName('');
        setDraftNumber('');
    }

    function removePlayer(id: string) {
        setPlayers((prev) => prev.filter((p) => p.id !== id));
    }

    return (
        <fieldset style={fieldsetStyle}>
            <legend>{teamName || 'Team'}</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {players.map((p) => {
                    const isDupe = duplicates.has(p.number.trim());
                    return (
                        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, color: isDupe ? '#ff6b6b' : undefined }}>
                            <span style={{ flex: 1 }}>
                                #{p.number} {p.name} {isDupe && '(duplicate number)'}
                            </span>
                            <button type="button" onClick={() => removePlayer(p.id)} style={smallButtonStyle}>
                                remove
                            </button>
                        </div>
                    );
                })}
                {players.length === 0 && <div style={{ opacity: 0.5, fontSize: 13 }}>No players yet.</div>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
                <input placeholder="Name" value={draftName} onChange={(e) => setDraftName(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                <input placeholder="#" value={draftNumber} onChange={(e) => setDraftNumber(e.target.value)} style={{ ...inputStyle, width: 50 }} />
                <button type="button" onClick={addPlayer} style={smallButtonStyle}>
                    Add
                </button>
            </div>
        </fieldset>
    );
}

// ── Styles ────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = { padding: 24, color: '#fff', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'sans-serif' };
const rowStyle: CSSProperties = { display: 'flex', gap: 16, maxWidth: 600 };
const fieldsetStyle: CSSProperties = { flex: 1, border: '1px solid #444', borderRadius: 6, padding: 12 };
const inputStyle: CSSProperties = { background: '#161616', color: '#fff', border: '1px solid #555', borderRadius: 4, padding: '6px 8px', fontSize: 14 };
const buttonStyle: CSSProperties = { padding: '10px 16px', fontSize: 14, background: '#222', color: '#fff', border: '1px solid #555', borderRadius: 6 };
const smallButtonStyle: CSSProperties = { ...buttonStyle, padding: '4px 10px', fontSize: 12 };
const errorListStyle: CSSProperties = { color: '#ff6b6b', fontSize: 13, margin: '12px 0 0', paddingLeft: 18 };
const setupErrorStyle: CSSProperties = { color: '#ff6b6b', fontSize: 13, border: '1px solid #7a1a1a', borderRadius: 4, padding: 8, marginTop: 12 };
