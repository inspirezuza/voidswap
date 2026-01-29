/**
 * Handshake Runtime
 * 
 * A shared, reusable handshake state machine that:
 * - Validates incoming messages and enforces anti-replay via seq tracking
 * - Locks session when params match and both nonces are exchanged
 * - Maintains a transcript of all accepted messages
 * - Emits deterministic events for network output, lock, or abort
 */

import { parseMessage, type Message, type HandshakeParams, type Role } from './messages.js';
import { canonicalStringify } from './canonical.js';
import { computeSid, hashHandshake } from './sid.js';
import { assertHex32 } from './hex.js';
import { appendRecord, transcriptHash, type TranscriptRecord } from './transcript.js';

// ============================================
// Types
// ============================================

export type HandshakeState = 
  | 'INIT'
  | 'SENT_HELLO'
  | 'GOT_PEER_HELLO'
  | 'SENT_ACK'
  | 'LOCKED'
  | 'ABORTED';

export type RuntimeEvent =
  | { kind: 'NET_OUT'; msg: Message }
  | { kind: 'LOCKED'; sid: string; transcriptHash: string }
  | { kind: 'ABORTED'; code: string; message: string };

export interface HandshakeRuntimeOptions {
  role: Role;
  params: HandshakeParams;
  localNonce: string;
}

export interface HandshakeRuntime {
  /** Start the handshake by emitting HELLO */
  start(): RuntimeEvent[];
  
  /** Handle an incoming message from peer */
  handleIncoming(rawPayload: unknown): RuntimeEvent[];
  
  /** Get the computed SID (null if not locked) */
  getSid(): string | null;
  
  /** Get the transcript hash */
  getTranscriptHash(): string;
  
  /** Get the current state */
  getState(): HandshakeState;
}

// ============================================
// Implementation
// ============================================

export function createHandshakeRuntime(opts: HandshakeRuntimeOptions): HandshakeRuntime {
  const { role, params, localNonce } = opts;
  const peerRole: Role = role === 'alice' ? 'bob' : 'alice';

  // Validate local nonce
  assertHex32('localNonce', localNonce);

  // State
  let state: HandshakeState = 'INIT';
  let seq = 0;
  let sid: string | null = null;
  let transcript: TranscriptRecord[] = [];
  
  // Peer data
  let peerParams: HandshakeParams | null = null;
  let peerNonce: string | null = null;
  
  // Anti-replay: track last seq per sender
  const lastSeqBySender: Record<Role, number | null> = {
    alice: null,
    bob: null,
  };

  // Helper: add to transcript
  function recordMessage(msg: { seq: number; from: Role; type: string; payload: unknown }) {
    transcript = appendRecord(transcript, {
      seq: msg.seq,
      from: msg.from,
      type: msg.type,
      payload: msg.payload,
    });
  }

  // Helper: create abort event and message
  function abort(code: string, message: string): RuntimeEvent[] {
    if (state === 'ABORTED') {
      return [{ kind: 'ABORTED', code, message }];
    }

    const abortMsg: Message = {
      type: 'abort',
      from: role,
      seq: seq++,
      payload: { code: code as 'SID_MISMATCH' | 'BAD_MESSAGE' | 'PROTOCOL_ERROR', message },
    };

    if (sid) {
      (abortMsg as Message & { sid: string }).sid = sid;
    }

    recordMessage(abortMsg);
    state = 'ABORTED';

    return [
      { kind: 'NET_OUT', msg: abortMsg },
      { kind: 'ABORTED', code, message },
    ];
  }

  // Helper: try to lock session
  function tryLock(): RuntimeEvent[] {
    if (state === 'LOCKED' || state === 'ABORTED') {
      return [];
    }

    if (!peerParams || !peerNonce) {
      return [];
    }

    // Validate params match
    const localCanonical = canonicalStringify(params);
    const peerCanonical = canonicalStringify(peerParams);

    if (localCanonical !== peerCanonical) {
      return abort('PROTOCOL_ERROR', 'Handshake params mismatch');
    }

    // Validate nonces
    try {
      assertHex32('localNonce', localNonce);
      assertHex32('peerNonce', peerNonce);
    } catch (err) {
      return abort('BAD_MESSAGE', `Invalid nonce: ${err}`);
    }

    // Compute SID with role-based nonce mapping
    let nonceAlice: string;
    let nonceBob: string;

    if (role === 'alice') {
      nonceAlice = localNonce;
      nonceBob = peerNonce;
    } else {
      nonceAlice = peerNonce;
      nonceBob = localNonce;
    }

    sid = computeSid(params, nonceAlice, nonceBob);
    state = 'LOCKED';

    return [{
      kind: 'LOCKED',
      sid,
      transcriptHash: transcriptHash(transcript),
    }];
  }

  // Start: emit HELLO
  function start(): RuntimeEvent[] {
    if (state !== 'INIT') {
      return [];
    }

    const helloMsg: Message = {
      type: 'hello',
      from: role,
      seq: seq++,
      payload: {
        handshake: params,
        nonce: localNonce,
      },
    };

    recordMessage(helloMsg);
    state = 'SENT_HELLO';

    return [{ kind: 'NET_OUT', msg: helloMsg }];
  }

  // Handle incoming message
  function handleIncoming(rawPayload: unknown): RuntimeEvent[] {
    if (state === 'LOCKED' || state === 'ABORTED') {
      return [];
    }

    // Parse message
    let msg: Message;
    try {
      msg = parseMessage(rawPayload);
    } catch (err) {
      return abort('BAD_MESSAGE', `Failed to parse message: ${err}`);
    }

    // Validate sender is peer role (not ourselves)
    if (msg.from === role) {
      // Ignore our own messages (shouldn't happen via relay)
      return [];
    }

    if (msg.from !== peerRole) {
      return abort('PROTOCOL_ERROR', `Expected message from ${peerRole}, got ${msg.from}`);
    }

    // Anti-replay: check seq is strictly increasing for this sender
    const lastSeq = lastSeqBySender[msg.from];
    if (lastSeq !== null && msg.seq <= lastSeq) {
      return abort('BAD_MESSAGE', `Replay or out-of-order: seq ${msg.seq} <= last ${lastSeq}`);
    }
    lastSeqBySender[msg.from] = msg.seq;

    // SID validation: before LOCKED, messages should not include sid
    // (We already returned early if state is LOCKED or ABORTED)
    if (msg.sid) {
      return abort('PROTOCOL_ERROR', 'Unexpected sid in message before session locked');
    }

    // Record message
    recordMessage(msg);

    // Handle by type
    const events: RuntimeEvent[] = [];

    switch (msg.type) {
      case 'hello':
        return handleHello(msg);
      case 'hello_ack':
        return handleHelloAck(msg);
      case 'abort':
        state = 'ABORTED';
        return [{ kind: 'ABORTED', code: msg.payload.code, message: msg.payload.message }];
      case 'error':
        // Just log, don't abort
        return [];
    }

  }

  function handleHello(msg: Message & { type: 'hello' }): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];

    // Store peer data
    peerParams = msg.payload.handshake;
    peerNonce = msg.payload.nonce;
    
    if (state === 'SENT_HELLO') {
      state = 'GOT_PEER_HELLO';
    }

    // Send hello_ack
    const ackMsg: Message = {
      type: 'hello_ack',
      from: role,
      seq: seq++,
      payload: {
        nonce: localNonce,
        handshake: params,
        handshakeHash: hashHandshake(params),
      },
    };

    recordMessage(ackMsg);
    events.push({ kind: 'NET_OUT', msg: ackMsg });
    state = 'SENT_ACK';

    // Try to lock
    events.push(...tryLock());

    return events;
  }

  function handleHelloAck(msg: Message & { type: 'hello_ack' }): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];

    // Store peer nonce if not already known
    if (!peerNonce) {
      peerNonce = msg.payload.nonce;
    } else if (peerNonce !== msg.payload.nonce) {
      return abort('BAD_MESSAGE', 'Nonce mismatch in hello_ack');
    }

    // Store peer params if not already known
    if (!peerParams) {
      peerParams = msg.payload.handshake;
    }

    // Try to lock
    events.push(...tryLock());

    return events;
  }

  return {
    start,
    handleIncoming,
    getSid: () => sid,
    getTranscriptHash: () => transcriptHash(transcript),
    getState: () => state,
  };
}
