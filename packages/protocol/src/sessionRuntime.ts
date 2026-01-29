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
    type CapsuleOfferMessage,
    type CapsuleAckMessage,
    type MpcResult,
    parseMessage
} from './messages.js';
import { createHandshakeRuntime, type RuntimeEvent as HandshakeEvent } from './handshakeRuntime.js';
import { mockKeygen, mockYShare } from './mockKeygen.js';
import { mockTlockEncrypt } from './mockTlock.js';
import { mockProveCapsule, mockVerifyCapsule } from './mockZkCapsule.js';
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
  | 'CAPSULES_EXCHANGE'
  | 'CAPSULES_VERIFIED'
  | 'ABORTED';

export type SessionEvent =
  | { kind: 'NET_OUT'; msg: Message }
  | { kind: 'SESSION_LOCKED'; sid: string; transcriptHash: string }
  | { kind: 'KEYGEN_COMPLETE'; sid: string; transcriptHash: string; mpcAlice: MpcResult; mpcBob: MpcResult }
  | { kind: 'CAPSULES_VERIFIED'; sid: string; transcriptHash: string }
  | { kind: 'ABORTED'; code: string; message: string };

export interface SessionRuntimeOptions {
  role: Role;
  params: HandshakeParams;
  localNonce: string;
  tamperCapsule?: boolean; // If true, corrupts outgoing capsule proof (for Bob)
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
  const { role, params, localNonce, tamperCapsule } = opts;
  const peerRole = role === 'alice' ? 'bob' : 'alice';

  // Sub-runtime
  const handshake = createHandshakeRuntime(opts); // Validates basic params/nonces

  // State
  let state: SessionState = 'HANDSHAKE';
  let sid: string | null = null;
  
  // Keygen State
  let localMpc: MpcResult | null = null;
  let peerMpc: MpcResult | null = null;
  
  // Capsule State
  let capsuleSent = false;
  let capsuleReceived = false;
  let capsuleAcked = false;

  // Helper to convert HandshakeEvent -> SessionEvent
  function mapEvent(e: HandshakeEvent): SessionEvent[] {
    if (e.kind === 'LOCKED') {
      return [{ kind: 'SESSION_LOCKED', sid: e.sid, transcriptHash: e.transcriptHash }]; // Wrapped in array for consistency with usage
    }
    // NET_OUT and ABORTED map directly (properties match enough or we cast)
    return [e as SessionEvent];
  }

  function abort(code: string, message: string): SessionEvent[] {
    state = 'ABORTED';
    return [{ kind: 'ABORTED', code, message }];
  }

  // Handle transition to KEYGEN when handshake locks
  // ... (handleLock implementation same as before)
  function handleLock(sidValue: string): SessionEvent[] {
    sid = sidValue;
    state = 'KEYGEN';
    
    // Generate local mock keygen data
    localMpc = mockKeygen(sidValue, role);

    // Initial announcement
    const announceMsg: KeygenAnnounceMessage = {
      type: 'keygen_announce',
      from: role,
      seq: 0, 
      sid: sidValue,
      payload: {
        mpcAlice: mockKeygen(sidValue, 'alice'),
        mpcBob: mockKeygen(sidValue, 'bob'),
        note: 'mock-generated',
      },
    };

    return [
      { kind: 'NET_OUT', msg: announceMsg },
    ];
  }
  
  // Handle transition to CAPSULES_EXCHANGE
  function startCapsuleExchange(): SessionEvent[] {
    state = 'CAPSULES_EXCHANGE';
    
    // Construct local capsule offer
    // Alice sends to Bob for Bob's share of MPC_Bob (refund_mpc_Bob) at rBRefund
    // Bob sends to Alice for Alice's share of MPC_Alice (refund_mpc_Alice) at rARefund
    
    let targetCapsuleRole: 'refund_mpc_Alice' | 'refund_mpc_Bob';
    let refundRound: number;
    
    if (role === 'alice') {
      targetCapsuleRole = 'refund_mpc_Bob';
      refundRound = params.rBRefund;
    } else {
      targetCapsuleRole = 'refund_mpc_Alice';
      refundRound = params.rARefund;
    }

    const yShare = mockYShare(sid!, targetCapsuleRole);
    
    // mockTlock input
    const tlockInput = { sid: sid!, role: targetCapsuleRole, refundRound, yShare };
    const { ct } = mockTlockEncrypt(tlockInput);
    
    const proofInput = { ...tlockInput, ct };
    let { proof } = mockProveCapsule(proofInput);
    
    // Tamper hook (Simulate corrupt proof)
    if (tamperCapsule && role === 'bob') {
      proof = proof.replace(/[a-f0-9]$/, 'x'); // Invalid hex or just change char
      if (proof === proofInput.ct) proof = proof + '1'; // Ensure differ if somehow colliding
       // Replace last char with something else hex to keep regex valid but proof invalid
       const last = proof[proof.length - 1];
       const next = last === 'a' ? 'b' : 'a';
       proof = proof.substring(0, proof.length - 1) + next;
    }

    const offerMsg: CapsuleOfferMessage = {
      type: 'capsule_offer',
      from: role,
      seq: 1, // Phase 2 seq
      sid: sid!,
      payload: {
        role: targetCapsuleRole,
        refundRound,
        yShare,
        ct,
        proof,
      }
    };

    capsuleSent = true;
    return [{ kind: 'NET_OUT', msg: offerMsg }];
  }

  function checkKeygenComplete(): SessionEvent[] {
    if (state === 'KEYGEN' && localMpc && peerMpc) {
      // Transition to CAPSULES_EXCHANGE immediately
      const keygenEvent: SessionEvent = {
        kind: 'KEYGEN_COMPLETE',
        sid: sid!,
        transcriptHash: handshake.getTranscriptHash(), 
        mpcAlice: mockKeygen(sid!, 'alice'),
        mpcBob: mockKeygen(sid!, 'bob'),
      };
      
      const capsuleEvents = startCapsuleExchange();
      
      return [keygenEvent, ...capsuleEvents];
    }
    return [];
  }
  
  function checkCapsulesVerified(): SessionEvent[] {
    if (state === 'CAPSULES_EXCHANGE' && capsuleReceived && capsuleAcked) {
      state = 'CAPSULES_VERIFIED';
      return [{
        kind: 'CAPSULES_VERIFIED',
        sid: sid!,
        transcriptHash: handshake.getTranscriptHash(),
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
      sessionEvents.push(...mapEvent(e));
      if (e.kind === 'LOCKED') {
        sessionEvents.push(...handleLock(e.sid));
      }
    }
    return sessionEvents;
  }

  function handleIncoming(rawPayload: unknown): SessionEvent[] {
    if (state === 'ABORTED' || state === 'CAPSULES_VERIFIED') return [];

    let msg: Message;
    try {
      msg = parseMessage(rawPayload);
    } catch {
      return abort('BAD_MESSAGE', 'Parse failed');
    }

    // Handshake Phase
    if (state === 'HANDSHAKE' || state === 'LOCKED') {
      const events = handshake.handleIncoming(rawPayload);
      const sessionEvents: SessionEvent[] = [];
      
      for (const e of events) {
        sessionEvents.push(...mapEvent(e));
        if (e.kind === 'LOCKED') {
          sessionEvents.push(...handleLock(e.sid));
        }
      }
      return sessionEvents;
    }

    // Keygen Phase
    if (state === 'KEYGEN') {
      if (msg.type !== 'keygen_announce') return [];

      if (msg.sid !== sid) return abort('SID_MISMATCH', `Expected ${sid}, got ${msg.sid}`);
      if (msg.from === role) return []; 

      // Idempotency / Conflict check for Keygen (same as before)
      const expectedCanonical = canonicalStringify({ 
        mpcAlice: mockKeygen(sid!, 'alice'), 
        mpcBob: mockKeygen(sid!, 'bob') 
      });
      const receivedCanonical = canonicalStringify({ 
        mpcAlice: msg.payload.mpcAlice, 
        mpcBob: msg.payload.mpcBob 
      });

      if (expectedCanonical !== receivedCanonical) {
        return abort('PROTOCOL_ERROR', 'Conflicting keygen data (determinism check failed)');
      }

      if (peerMpc) return []; // Already done
      peerMpc = role === 'alice' ? msg.payload.mpcBob : msg.payload.mpcAlice; 
      
      return checkKeygenComplete();
    }
    
    // Capsule Exchange Phase
    if (state === 'CAPSULES_EXCHANGE') {
      if (msg.sid !== sid) {
        // We might ignore or abort. Abort is safer for strictness.
        if (msg.type === 'capsule_offer' || msg.type === 'capsule_ack') {
           return abort('SID_MISMATCH', `Expected ${sid}, got ${msg.sid}`);
        }
        return []; // Ignore other types
      }

      if (msg.type === 'capsule_offer') {
        if (msg.from === role) return []; 
        
        // Validate Offer
        // Expect role/refundRound based on PEER
        let expectedRole: 'refund_mpc_Alice' | 'refund_mpc_Bob';
        let expectedRound: number;
        
        if (role === 'alice') {
             // Expect from Bob: refund_mpc_Alice at rARefund
             expectedRole = 'refund_mpc_Alice';
             expectedRound = params.rARefund;
        } else {
             // Expect from Alice: refund_mpc_Bob at rBRefund
             expectedRole = 'refund_mpc_Bob';
             expectedRound = params.rBRefund;
        }
        
        if (msg.payload.role !== expectedRole) {
           return abort('PROTOCOL_ERROR', `Unexpected capsule role: ${msg.payload.role}`);
        }
        if (msg.payload.refundRound !== expectedRound) {
           return abort('PROTOCOL_ERROR', `Unexpected refund round: ${msg.payload.refundRound}`);
        }
        
        // Verify Proof
        const publicInput = {
           sid: sid!,
           role: expectedRole,
           refundRound: expectedRound,
           yShare: msg.payload.yShare, // We trust yShare is correct? 
           // Technically we should valid yShare matches expected deterministic one too?
           // Plan said: "yShare reference ... use deterministic mock"
           // Let's enforce it to be strict.
           ct: msg.payload.ct,
        };
        
        const expectedYShare = mockYShare(sid!, expectedRole);
        if (msg.payload.yShare !== expectedYShare) {
            return abort('PROTOCOL_ERROR', 'Invalid yShare commitment');
        }

        const valid = mockVerifyCapsule(publicInput, msg.payload.proof);
        
        if (!valid) {
            // Send negative Ack then abort? or just abort.
            // Plan: "emit NET_OUT capsule_ack {role, ok:false..} -> ABORT"
            const nack: CapsuleAckMessage = {
              type: 'capsule_ack',
              from: role,
              seq: 2,
              sid: sid!,
              payload: { role: expectedRole, ok: false, reason: 'Invalid Proof' }
            };
            // Return NACK then abort events
            state = 'ABORTED';
            return [
               { kind: 'NET_OUT', msg: nack },
               { kind: 'ABORTED', code: 'PROTOCOL_ERROR', message: 'Invalid capsule proof' }
            ];
        }
        
        // Valid!
        capsuleReceived = true;
        const ack: CapsuleAckMessage = {
           type: 'capsule_ack',
           from: role,
           seq: 2,
           sid: sid!,
           payload: { role: expectedRole, ok: true }
        };
        
        const events: SessionEvent[] = [{ kind: 'NET_OUT', msg: ack }];
        events.push(...checkCapsulesVerified());
        return events;
      }
      
      if (msg.type === 'capsule_ack') {
         if (msg.from === role) return [];
         
         // Ack for OUR offer
         // Check role matches what WE sent
         const myTargetRole = role === 'alice' ? 'refund_mpc_Bob' : 'refund_mpc_Alice';
         
         if (msg.payload.role !== myTargetRole) return []; // Not relevant?
         
         if (!msg.payload.ok) {
            return abort('PROTOCOL_ERROR', `Peer rejected capsule: ${msg.payload.reason}`);
         }
         
         capsuleAcked = true;
         return checkCapsulesVerified();
      }
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
