/**
 * Session Runtime
 * 
 * Orchestrates the full session lifecycle:
 * 1. Handshake (locks session)
 * 2. Keygen (mock addresses/commitments)
 * 
 * Wraps HandshakeRuntime to manage transitions and session-scoped state.
 */

import {
    type Message,
    type Role,
    type HandshakeParams,
    type KeygenAnnounceMessage,
    type MpcResult,
    parseMessage
} from './messages.js';
import { createHandshakeRuntime, type RuntimeEvent as HandshakeEvent } from './handshakeRuntime.js';
import { mockKeygen } from './mockKeygen.js';
import { canonicalStringify } from './canonical.js';

// ============================================
// Types
// ============================================

export type SessionState = 
  | 'WAIT_PEER' // Implicit initial state before handshake starts (managed by client)
  | 'HANDSHAKE' 
  | 'LOCKED' 
  | 'KEYGEN' 
  | 'KEYGEN_COMPLETE' 
  | 'ABORTED';

export type SessionEvent =
  | { kind: 'NET_OUT'; msg: Message }
  | { kind: 'SESSION_LOCKED'; sid: string; transcriptHash: string }
  | { kind: 'KEYGEN_COMPLETE'; sid: string; transcriptHash: string; mpcAlice: MpcResult; mpcBob: MpcResult }
  | { kind: 'ABORTED'; code: string; message: string };

export interface SessionRuntimeOptions {
  role: Role;
  params: HandshakeParams;
  localNonce: string;
}

export interface SessionRuntime {
  startHandshake(): SessionEvent[];
  handleIncoming(rawPayload: unknown): SessionEvent[];
  getState(): SessionState;
  getSid(): string | null;
  getTranscriptHash(): string;
}

// ============================================
// Implementation
// ============================================

export function createSessionRuntime(opts: SessionRuntimeOptions): SessionRuntime {
  const { role, params, localNonce } = opts;
  const peerRole = role === 'alice' ? 'bob' : 'alice';

  // Sub-runtime
  const handshake = createHandshakeRuntime(opts); // Validates basic params/nonces

  // State
  let state: SessionState = 'HANDSHAKE';
  let sid: string | null = null;
  
  // Keygen State
  let localMpc: MpcResult | null = null;
  let peerMpc: MpcResult | null = null;
  // We keep track if we announced to avoid resending endlessly if we wanted to
  // But strictly we just follow the state transitions.

  // Helper to convert HandshakeEvent -> SessionEvent
  function mapEvent(e: HandshakeEvent): SessionEvent {
    if (e.kind === 'LOCKED') {
      return { kind: 'SESSION_LOCKED', sid: e.sid, transcriptHash: e.transcriptHash };
    }
    // NET_OUT and ABORTED map directly (properties match enough or we cast)
    return e;
  }

  function abort(code: string, message: string): SessionEvent[] {
    state = 'ABORTED';
    return [{ kind: 'ABORTED', code, message }];
  }

  // Handle transition to KEYGEN when handshake locks
  function handleLock(sidValue: string): SessionEvent[] {
    sid = sidValue;
    state = 'KEYGEN';
    
    // Generate local mock keygen data
    localMpc = mockKeygen(sidValue, role);

    // Initial announcement
    const announceMsg: KeygenAnnounceMessage = {
      type: 'keygen_announce',
      from: role,
      seq: 0, // Keygen phase could reset seq or continue? 
              // HandshakeRuntime manages 'seq' for its messages. 
              // We need our own seq tracking for session-level messages if we aren't using HandshakeRuntime to send them.
              // BUT: HandshakeRuntime.handleIncoming filters by seq.
              // We should probably implement logic to send message using common seq if we wanted to reuse that.
              // However, HandshakeRuntime is internal. 
              // Simplification: Use a fixed high seq or just 0 if we assume separate phase tracking?
              // The `messages.ts` schema requires seq. 
              // Let's rely on the fact that HandshakeRuntime ignores 'keygen_announce', so we don't need to coordinate seq with it strictly
              // UNLESS we want a global transcript order.
              // To maintain a single linear transcript, we should probably stick to one seq source.
              // But HandshakeRuntime doesn't expose its 'seq' counter.
              
              // Refactor idea: HandshakeRuntime could expose `nextSeq()`?
              // Or we just use a new seq counter for Keygen phase starting at 1000? 
              // Let's use 0 for Keygen phase and assume standard "phase 2" separation.
              // NOTE: Anti-replay in HandshakeRuntime only tracks 'hello'/'hello_ack' logic basically. 
              // We need our own anti-replay for Keygen if we care.
      sid: sidValue,
      payload: {
        // Since it's deterministic, both must agree.
        mpcAlice: mockKeygen(sidValue, 'alice'),
        mpcBob: mockKeygen(sidValue, 'bob'),
        note: 'mock-generated',
      },
    };

    return [
      { kind: 'NET_OUT', msg: announceMsg },
    ];
  }

  function checkKeygenComplete(): SessionEvent[] {
    if (state === 'KEYGEN' && localMpc && peerMpc) {
      state = 'KEYGEN_COMPLETE';
      return [{
        kind: 'KEYGEN_COMPLETE',
        sid: sid!,
        transcriptHash: handshake.getTranscriptHash(), // Transcript hasn't changed in keygen yet? 
        // Wait, if we exchange messages, they should be in transcript.
        // HandshakeRuntime doesn't add `keygen_announce` to its transcript because it ignores them.
        // We technically need to append to the SAME transcript to really secure the history.
        // But `HandshakeRuntime` owns the transcript.
        // We might need to extend `HandshakeRuntime` to allow "external record append".
        // Or just accept that transcript covers handshake only, and Keygen is verified by the determinism check.
        // For this task: "transcriptHash (matches)".
        // Keygen messages verifying the SID is sufficient binding to the handshake.
        mpcAlice: mockKeygen(sid!, 'alice'),
        mpcBob: mockKeygen(sid!, 'bob'),
      }];
    }
    return [];
  }

  function startHandshake(): SessionEvent[] {
    if (state !== 'HANDSHAKE') return [];
    
    // Delegate to handshake
    const events = handshake.start();
    
    // Map events
    const sessionEvents: SessionEvent[] = [];
    for (const e of events) {
      sessionEvents.push(mapEvent(e));
      if (e.kind === 'LOCKED') {
        sessionEvents.push(...handleLock(e.sid));
      }
    }
    return sessionEvents;
  }

  function handleIncoming(rawPayload: unknown): SessionEvent[] {
    if (state === 'ABORTED' || state === 'KEYGEN_COMPLETE') return [];

    let msg: Message;
    try {
      msg = parseMessage(rawPayload);
    } catch {
      return abort('BAD_MESSAGE', 'Parse failed');
    }

    if (state === 'HANDSHAKE' || state === 'LOCKED') {
      // Forward to handshake runtime
      const events = handshake.handleIncoming(rawPayload);
      const sessionEvents: SessionEvent[] = [];
      
      for (const e of events) {
        sessionEvents.push(mapEvent(e));
        if (e.kind === 'LOCKED') {
          sessionEvents.push(...handleLock(e.sid));
        }
      }
      return sessionEvents;
    }

    if (state === 'KEYGEN') {
      if (msg.type !== 'keygen_announce') {
         // Ignore non-keygen messages in this phase (or strictly abort?)
         // Ignore is safer for race conditions vs late hello_acks
         return [];
      }

      // Validate SID
      if (msg.sid !== sid) {
        return abort('SID_MISMATCH', `Expected ${sid}, got ${msg.sid}`);
      }

      if (msg.from === role) return []; // Ignore self
      
      // Store peer result
      // Validate that peer's announced data matches our deterministic expectation
      // (Since this is a MOCK, we enforce determinism strictly)
      const expectedAlice = mockKeygen(sid!, 'alice');
      const expectedBob = mockKeygen(sid!, 'bob');
      const expectedCanonical = canonicalStringify({ mpcAlice: expectedAlice, mpcBob: expectedBob });
      
      // We strip 'note' before comparing for rigour, or just compare what matters
      // Simply check the mpcAlice/mpcBob parts
      const received = { mpcAlice: msg.payload.mpcAlice, mpcBob: msg.payload.mpcBob };
      const receivedCanonical = canonicalStringify(received);

      if (expectedCanonical !== receivedCanonical) {
        return abort('PROTOCOL_ERROR', 'Conflicting keygen data (determinism check failed)');
      }

      // Verify idempotency
      if (peerMpc) {
        // Already received? matching check above covers conflicting data.
        // Just return empty.
        return [];
      }

      peerMpc = role === 'alice' ? msg.payload.mpcBob : msg.payload.mpcAlice; 
      // Actually we validated the WHOLE payload matches expectation.
      // So effectively we have everything.
      
      // Check completeness
      return checkKeygenComplete();
    }

    return [];
  }

  return {
    startHandshake,
    handleIncoming,
    getState: () => state,
    getSid: () => sid,
    getTranscriptHash: () => handshake.getTranscriptHash(),
  };
}
