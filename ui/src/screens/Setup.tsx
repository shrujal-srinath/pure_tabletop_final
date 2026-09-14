// box-pi/ui/src/screens/Setup.tsx
//
// Not a "screen" in the Task 6 sense — a small stateful wrapper owning the
// two-step Match Setup -> Roster Setup flow, since something has to hold
// "which step" and "the fields Match Setup already collected" between the
// two actual screen components. Kept out of App.tsx to keep that file's
// routing switch a plain lookup, not flow logic.

import { useState } from 'react';
import { MatchSetup } from './MatchSetup';
import { RosterSetup } from './RosterSetup';
import type { MatchFields } from '../lib/setupTypes';

export function Setup() {
    const [heldFields, setHeldFields] = useState<MatchFields | null>(null);

    if (heldFields) {
        return <RosterSetup matchFields={heldFields} onBack={() => setHeldFields(null)} />;
    }
    return <MatchSetup onContinueToRoster={setHeldFields} />;
}
