// box-pi/ui/src/lib/socket.ts
//
// The one Socket.io connection to the daemon (box-pi/daemon/index.js,
// :3001). Event names come straight from shared/wire-contract.js's
// LAN_EVENTS — imported directly, not copied, so this UI can never drift
// from the daemon's actual vocabulary.

import { io } from 'socket.io-client';
import { LAN_EVENTS } from '../../../shared/wire-contract.js';

const DAEMON_URL = 'http://localhost:3001';

export const socket = io(DAEMON_URL, {
    transports: ['websocket'],
});

export { LAN_EVENTS };
