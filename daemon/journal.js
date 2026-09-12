// box-pi/daemon/journal.js
// ═══════════════════════════════════════════════════════════════════════
// THE BOX — Local Crash-Recovery Journal
//
// An append-only action log plus periodic full-state snapshots, so a Pi
// crash or power blip mid-game doesn't lose the game: reload the latest
// snapshot, replay whatever actions happened since it through Task 2's
// reduce(), and you're back to exactly where the game was.
//
// LOCAL ONLY — no Supabase, no network. Writing individual actions to the
// cloud game_actions table (so website/app stats stay accurate) is a
// separate later stage, not this module's job.
//
// This module does I/O by design (unlike state-engine, which must stay
// pure) — but its scope stays narrow: it only reads/writes its own two
// files (journal.ndjson, snapshot.json) and calls reduce()/
// createEmptyState() to reconstruct state. No UART, no Socket.io, no
// Supabase, and it never decides *when* a game starts or ends — it only
// durably records what already happened and rebuilds state on request.
//
// Durability: every write goes through a real fd with fs.*Sync calls and
// an explicit fsyncSync — the data is on stable storage by the time
// recordAction() returns, so a process kill (or the power blip this
// module exists for) immediately after can't lose it.
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { reduce, createEmptyState } from '../shared/state-engine.js';

/** @returns {number} */
function countJournalLines(journalPath) {
    if (!fs.existsSync(journalPath)) return 0;
    return fs
        .readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0).length;
}

/** Full synchronous overwrite + fsync — for the (infrequent) snapshot writes. */
function writeFileDurable(filePath, content) {
    const fd = fs.openSync(filePath, 'w');
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.dir]
 * @param {number} [opts.snapshotEveryNActions]
 */
export function createJournal({ dir = './data', snapshotEveryNActions = 50 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const journalPath = path.join(dir, 'journal.ndjson');
    const snapshotPath = path.join(dir, 'snapshot.json');

    // O_APPEND semantics mean every write lands at the CURRENT end of file
    // as of that write — so ftruncateSync-ing this same fd during rotation
    // and then continuing to write on it correctly starts a fresh file,
    // no reopen needed.
    let journalFd = fs.openSync(journalPath, 'a');

    // Recovered on construction so a fresh process (simulated restart)
    // picks up exactly where the last process left off, mid-bracket.
    let actionsSinceSnapshot = countJournalLines(journalPath);
    let nextSeq = actionsSinceSnapshot + 1;

    /**
     * Appends one action to the journal, durably. May trigger a snapshot +
     * journal rotation once `snapshotEveryNActions` is reached.
     * @param {{type:string, payload?:Object}} action
     * @param {Object} resultingState The state after applying `action` — what gets written into the snapshot if this call triggers one.
     */
    function recordAction(action, resultingState) {
        const line = JSON.stringify({ seq: nextSeq, ts: Date.now(), action }) + '\n';
        fs.writeSync(journalFd, line);
        fs.fsyncSync(journalFd);
        nextSeq += 1;
        actionsSinceSnapshot += 1;

        if (actionsSinceSnapshot >= snapshotEveryNActions) {
            writeFileDurable(snapshotPath, JSON.stringify(resultingState));
            fs.ftruncateSync(journalFd, 0);
            actionsSinceSnapshot = 0;
            nextSeq = 1;
        }
    }

    /**
     * Raw materials, no replay. @returns {{snapshot: Object|null, actionsSinceSnapshot: Array}}
     */
    function loadLatest() {
        const snapshot = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;

        const actions = fs.existsSync(journalPath)
            ? fs
                  .readFileSync(journalPath, 'utf8')
                  .split('\n')
                  .filter((line) => line.trim().length > 0)
                  .map((line) => JSON.parse(line).action)
            : [];

        return { snapshot, actionsSinceSnapshot: actions };
    }

    /** Replays the journal on top of the snapshot (or a fresh empty state). @returns {Object} */
    function reconstructState() {
        const { snapshot, actionsSinceSnapshot: actions } = loadLatest();
        let state = snapshot ?? createEmptyState();
        for (const action of actions) {
            state = reduce(state, action);
        }
        return state;
    }

    /** Wipes both files — call on a clean game end so a fresh boot has nothing to "recover". */
    function clear() {
        fs.closeSync(journalFd);
        if (fs.existsSync(journalPath)) fs.rmSync(journalPath);
        if (fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath);
        journalFd = fs.openSync(journalPath, 'a');
        actionsSinceSnapshot = 0;
        nextSeq = 1;
    }

    return { recordAction, loadLatest, reconstructState, clear };
}
