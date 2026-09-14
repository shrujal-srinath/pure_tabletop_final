// box-pi/ui/src/screens/MatchSetup.tsx
//
// Collects match configuration. Branches on gameMode:
//   - 'quick'            -> sends setup_game immediately, no roster.
//   - 'stats'/'advanced' -> does NOT send anything here — hands the
//                           collected fields to onContinueToRoster and lets
//                           RosterSetup send the combined payload once
//                           rosters are done.
// Owns its own socket wiring for the quick-mode path only (send +
// setup_error/game_ready listeners) — same "each screen owns its own
// socket interaction" pattern as LiveGame/Spectator, not routed through App.

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { socket, LAN_EVENTS } from '../lib/socket';
import { DEFAULT_MATCH_FIELDS, type MatchFields } from '../lib/setupTypes';
import type { GameMode } from '../lib/daemonTypes';

function validate(fields: MatchFields): string[] {
    const errors: string[] = [];
    if (!fields.teamAName.trim()) errors.push('Team A needs a name.');
    if (!fields.teamBName.trim()) errors.push('Team B needs a name.');
    if (!Number.isFinite(fields.periodMinutes) || fields.periodMinutes < 1 || fields.periodMinutes > 60) {
        errors.push('Period length must be between 1 and 60 minutes.');
    }
    if (!Number.isFinite(fields.shotClockSeconds) || fields.shotClockSeconds < 1 || fields.shotClockSeconds > 60) {
        errors.push('Shot clock must be between 1 and 60 seconds.');
    }
    if (!Number.isFinite(fields.periods) || fields.periods < 1 || fields.periods > 8) {
        errors.push('Number of periods must be between 1 and 8.');
    }
    return errors;
}

export function MatchSetup({ onContinueToRoster }: { onContinueToRoster: (fields: MatchFields) => void }) {
    const [fields, setFields] = useState<MatchFields>(DEFAULT_MATCH_FIELDS);
    const [touched, setTouched] = useState(false);
    const [setupError, setSetupError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

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

    const errors = validate(fields);
    const canSubmit = errors.length === 0 && !submitting;

    function update<K extends keyof MatchFields>(key: K, value: MatchFields[K]) {
        setFields((f) => ({ ...f, [key]: value }));
    }

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setTouched(true);
        if (!canSubmit) return;
        setSetupError(null);

        if (fields.gameMode === 'quick') {
            setSubmitting(true);
            // No `roster` key at all for quick mode — omitted entirely, not
            // sent as an empty object (see wire-contract.js's SetupGamePayload).
            socket.emit(LAN_EVENTS.SETUP_GAME, { ...fields });
            // App.tsx's top-level state_update subscription flips to LiveGame
            // automatically once meta.gameActive becomes true — no separate
            // "success" callback needed here.
        } else {
            onContinueToRoster(fields);
        }
    }

    return (
        <div style={pageStyle}>
            <h1 style={{ marginTop: 0 }}>MATCH SETUP</h1>
            <form onSubmit={handleSubmit} style={formStyle}>
                <div style={rowStyle}>
                    <TeamFields
                        label="Team A"
                        name={fields.teamAName}
                        color={fields.teamAColor}
                        onName={(v) => update('teamAName', v)}
                        onColor={(v) => update('teamAColor', v)}
                    />
                    <TeamFields
                        label="Team B"
                        name={fields.teamBName}
                        color={fields.teamBColor}
                        onName={(v) => update('teamBName', v)}
                        onColor={(v) => update('teamBColor', v)}
                    />
                </div>

                <label style={labelStyle}>
                    Period length (minutes)
                    <input
                        type="number"
                        value={fields.periodMinutes}
                        onChange={(e) => update('periodMinutes', Number(e.target.value))}
                        style={inputStyle}
                    />
                </label>
                <label style={labelStyle}>
                    Shot clock (seconds)
                    <input
                        type="number"
                        value={fields.shotClockSeconds}
                        onChange={(e) => update('shotClockSeconds', Number(e.target.value))}
                        style={inputStyle}
                    />
                </label>
                <label style={labelStyle}>
                    Periods
                    <input
                        type="number"
                        value={fields.periods}
                        onChange={(e) => update('periods', Number(e.target.value))}
                        style={inputStyle}
                    />
                </label>
                <label style={labelStyle}>
                    Game mode
                    <select value={fields.gameMode} onChange={(e) => update('gameMode', e.target.value as GameMode)} style={inputStyle}>
                        <option value="quick">Quick — score only</option>
                        <option value="stats">Stats — box score, no locations</option>
                        <option value="advanced">Advanced — box score + shot locations</option>
                    </select>
                </label>

                {touched && errors.length > 0 && (
                    <ul style={errorListStyle}>
                        {errors.map((err) => (
                            <li key={err}>{err}</li>
                        ))}
                    </ul>
                )}
                {setupError && <div style={setupErrorStyle}>Daemon rejected setup: {setupError}</div>}

                {/* NOT disabled by validation errors — a disabled button can't be
                    clicked, which would mean the operator can never trigger the
                    "reveal why" error list below. Only genuinely in-flight
                    submission (already sent, awaiting daemon response) disables it. */}
                <button type="submit" disabled={submitting} style={{ ...submitButtonStyle, opacity: submitting ? 0.4 : 1, cursor: submitting ? 'not-allowed' : 'pointer' }}>
                    {fields.gameMode === 'quick' ? 'Start game' : 'Continue to roster →'}
                </button>
            </form>
        </div>
    );
}

function TeamFields({
    label, name, color, onName, onColor,
}: {
    label: string;
    name: string;
    color: string;
    onName: (v: string) => void;
    onColor: (v: string) => void;
}) {
    return (
        <fieldset style={fieldsetStyle}>
            <legend>{label}</legend>
            <label style={labelStyle}>
                Name
                <input type="text" value={name} onChange={(e) => onName(e.target.value)} style={inputStyle} />
            </label>
            <label style={labelStyle}>
                Color
                <input type="color" value={color} onChange={(e) => onColor(e.target.value)} style={{ ...inputStyle, height: 36, padding: 2 }} />
            </label>
        </fieldset>
    );
}

// ── Styles ────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = { padding: 24, color: '#fff', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'sans-serif' };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 };
const rowStyle: CSSProperties = { display: 'flex', gap: 16 };
const fieldsetStyle: CSSProperties = { flex: 1, border: '1px solid #444', borderRadius: 6, padding: 12 };
const labelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 };
const inputStyle: CSSProperties = { background: '#161616', color: '#fff', border: '1px solid #555', borderRadius: 4, padding: '6px 8px', fontSize: 14 };
const errorListStyle: CSSProperties = { color: '#ff6b6b', fontSize: 13, margin: 0, paddingLeft: 18 };
const setupErrorStyle: CSSProperties = { color: '#ff6b6b', fontSize: 13, border: '1px solid #7a1a1a', borderRadius: 4, padding: 8 };
const submitButtonStyle: CSSProperties = { padding: '10px 16px', fontSize: 14, background: '#222', color: '#fff', border: '1px solid #555', borderRadius: 6, marginTop: 8 };
