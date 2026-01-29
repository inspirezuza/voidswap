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

// ... imports ...
import { createHash } from 'crypto';
import { transcriptHash, appendRecord, type TranscriptRecord } from './transcript.js';

// ... Types ...

export function createSessionRuntime(opts: SessionRuntimeOptions): SessionRuntime {
  const { role, params, localNonce, tamperCapsule } = opts;
  const peerRole = role === 'alice' ? 'bob' : 'alice';

  // Sub-runtime
  const handshake = createHandshakeRuntime(opts); // Validates basic params/nonces

  // State
  let state: SessionState = 'HANDSHAKE';
  let sid: string | null = null;
  
  // Post-Handshake Transcript & Sequencing
  let postTranscript: TranscriptRecord[] = [];
  let postSeq = 100; // Start high to distinguish from handshake
  const lastPostSeqBySender: Record<Role, number | null> = {
    alice: null,
    bob: null,
  };

  // Keygen State
  let localMpc: MpcResult | null = null;
  let peerMpc: MpcResult | null = null;
  
  // Capsule State
  let capsuleSent = false;
  let capsuleReceived = false;
  let capsuleAcked = false;

  // Helper to append valid messages to post-handshake transcript
  function recordPost(msg: Message) {
    postTranscript = appendRecord(postTranscript, {
       seq: msg.seq,
       from: msg.from,
       type: msg.type,
       payload: msg.payload,
    });
  }

  // Helper to compute full transcript hash (Handshake + Post)
  function getFullTranscriptHash(): string {
     const handshakeHash = handshake.getTranscriptHash();
     const postHash = transcriptHash(postTranscript);
     
     // full = sha256(canonical({ handshakeHash, postHash }))
     const canonical = canonicalStringify({ handshakeHash, postHash });
     return '0x' + createHash('sha256').update(canonical).digest('hex');
  }

  // Helper to convert HandshakeEvent -> SessionEvent
  function mapEvent(e: HandshakeEvent): SessionEvent[] {
    if (e.kind === 'LOCKED') {
      return [{ kind: 'SESSION_LOCKED', sid: e.sid, transcriptHash: e.transcriptHash }]; 
    }
    return [e as SessionEvent];
  }

  function emitAbort(code: string, message: string): SessionEvent[] {
    state = 'ABORTED';
    
    // Construct abort message if possible (with SID and post-seq if locked)
    if (sid) { 
        const abortMsg: Message = {
            type: 'abort',
            from: role,
            seq: postSeq++,
            sid: sid,
            payload: { code: code as any, message }
        };
        recordPost(abortMsg);
        return [
            { kind: 'NET_OUT', msg: abortMsg },
            { kind: 'ABORTED', code, message }
        ];
    }

    return [{ kind: 'ABORTED', code, message }];
  }

  // Handle transition to KEYGEN when handshake locks
  function handleLock(sidValue: string): SessionEvent[] {
    sid = sidValue;
    state = 'KEYGEN';
    
    // Generate local mock keygen data
    localMpc = mockKeygen(sidValue, role);

    // Initial announcement with tracked seq
    const announceMsg: KeygenAnnounceMessage = {
      type: 'keygen_announce',
      from: role,
      seq: postSeq++, 
      sid: sidValue,
      payload: {
        mpcAlice: mockKeygen(sidValue, 'alice'),
        mpcBob: mockKeygen(sidValue, 'bob'),
        note: 'mock-generated',
      },
    };
    
    recordPost(announceMsg);

    return [
      { kind: 'NET_OUT', msg: announceMsg },
    ];
  }
  
  // Handle transition to CAPSULES_EXCHANGE
  function startCapsuleExchange(): SessionEvent[] {
    state = 'CAPSULES_EXCHANGE';
    
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
    
    // Tamper hook
    if (tamperCapsule && role === 'bob') {
      const last = proof[proof.length - 1];
      const next = last === 'a' ? 'b' : 'a';
      proof = proof.substring(0, proof.length - 1) + next;
    }

    const offerMsg: CapsuleOfferMessage = {
      type: 'capsule_offer',
      from: role,
      seq: postSeq++,
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
    recordPost(offerMsg);
    
    return [{ kind: 'NET_OUT', msg: offerMsg }];
  }

  function checkKeygenComplete(): SessionEvent[] {
    if (state === 'KEYGEN' && localMpc && peerMpc) {
      // Use FULL transcript hash now? No, at KEYGEN_COMPLETE we only have keygen messages.
      // But we should use the evolving hash.
      
      const keygenEvent: SessionEvent = {
        kind: 'KEYGEN_COMPLETE',
        sid: sid!,
        transcriptHash: getFullTranscriptHash(), 
        mpcAlice: role === 'alice' ? localMpc! : peerMpc!,
        mpcBob: role === 'bob' ? localMpc! : peerMpc!,
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
        transcriptHash: getFullTranscriptHash(),
      }];
    }
    return [];
  }

  function startHandshake(): SessionEvent[] {
    if (state !== 'HANDSHAKE') return [];
    
    const events = handshake.start();
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
      return emitAbort('BAD_MESSAGE', 'Parse failed');
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

    // Post-Handshake Validation (Anti-Replay)
    if (state === 'KEYGEN' || state === 'CAPSULES_EXCHANGE') {
        // Must have SID
        if (msg.sid !== sid) {
             // If implicit abort, we might just ignore
             if (msg.type === 'abort') return [{ kind: 'ABORTED', code: (msg.payload as any).code, message: (msg.payload as any).message }];
             return emitAbort('SID_MISMATCH', `Expected ${sid}, got ${msg.sid}`);
        }
        
        // Ignore self
        if (msg.from === role) return [];
        
        // Enforce Seq
        const lastSeq = lastPostSeqBySender[msg.from];
        if (msg.seq < 100) return emitAbort('BAD_MESSAGE', 'Post-handshake seq must be >= 100');
        if (lastSeq !== null && msg.seq <= lastSeq) {
             return emitAbort('BAD_MESSAGE', `Replay/out-of-order: seq ${msg.seq} <= last ${lastSeq}`);
        }
        lastPostSeqBySender[msg.from] = msg.seq;
        
        // Record It
        recordPost(msg);
    }

    // Keygen Logic
    if (state === 'KEYGEN') {
      if (msg.type !== 'keygen_announce') return [];

      const expectedCanonical = canonicalStringify({ 
        mpcAlice: mockKeygen(sid!, 'alice'), 
        mpcBob: mockKeygen(sid!, 'bob') 
      });
      const receivedCanonical = canonicalStringify({ 
        mpcAlice: msg.payload.mpcAlice, 
        mpcBob: msg.payload.mpcBob 
      });

      if (expectedCanonical !== receivedCanonical) {
        return emitAbort('PROTOCOL_ERROR', 'Conflicting keygen data');
      }

      if (peerMpc) return []; // Idempotent ignore (seq check already passed so this is a new message with duplicated payload? or redundant logic?)
      // Actually seq check ensures we don't process exact SAME message. 
      // But peer could send new message with same payload? 
      // Safe to just process.

      peerMpc = role === 'alice' ? msg.payload.mpcBob : msg.payload.mpcAlice; 
      
      return checkKeygenComplete();
    }
    
    // Capsule Phase
    if (state === 'CAPSULES_EXCHANGE') {
      if (msg.type === 'capsule_offer') {
        let expectedRole: 'refund_mpc_Alice' | 'refund_mpc_Bob';
        let expectedRound: number;
        
        if (role === 'alice') {
             expectedRole = 'refund_mpc_Alice';
             expectedRound = params.rARefund;
        } else {
             expectedRole = 'refund_mpc_Bob';
             expectedRound = params.rBRefund;
        }
        
        if (msg.payload.role !== expectedRole || msg.payload.refundRound !== expectedRound) {
           return emitAbort('PROTOCOL_ERROR', 'Unexpected capsule params');
        }
        
        const expectedYShare = mockYShare(sid!, expectedRole);
        if (msg.payload.yShare !== expectedYShare) {
            return emitAbort('PROTOCOL_ERROR', 'Invalid yShare commitment');
        }
        
        // Strict CT Validation
        const tlockInput = { sid: sid!, role: expectedRole, refundRound: expectedRound, yShare: expectedYShare };
        const expectedCt = mockTlockEncrypt(tlockInput).ct;
        
        if (msg.payload.ct !== expectedCt) {
            // NACK then Abort
            const nack: CapsuleAckMessage = {
                type: 'capsule_ack',
                from: role,
                seq: postSeq++,
                sid: sid!,
                payload: { role: expectedRole, ok: false, reason: 'Invalid Ciphertext' }
            };
            recordPost(nack);
            state = 'ABORTED';
            return [
                { kind: 'NET_OUT', msg: nack },
                { kind: 'ABORTED', code: 'PROTOCOL_ERROR', message: 'Invalid capsule ciphertext' }
            ];
        }

        const valid = mockVerifyCapsule({ ...tlockInput, ct: msg.payload.ct }, msg.payload.proof);
        
        if (!valid) {
            const nack: CapsuleAckMessage = {
              type: 'capsule_ack',
              from: role,
              seq: postSeq++,
              sid: sid!,
              payload: { role: expectedRole, ok: false, reason: 'Invalid Proof' }
            };
            recordPost(nack);
            state = 'ABORTED';
            return [
               { kind: 'NET_OUT', msg: nack },
               { kind: 'ABORTED', code: 'PROTOCOL_ERROR', message: 'Invalid capsule proof' }
            ];
        }
        
        capsuleReceived = true;
        const ack: CapsuleAckMessage = {
           type: 'capsule_ack',
           from: role,
           seq: postSeq++,
           sid: sid!,
           payload: { role: expectedRole, ok: true }
        };
        recordPost(ack);
        
        const events: SessionEvent[] = [{ kind: 'NET_OUT', msg: ack }];
        events.push(...checkCapsulesVerified());
        return events;
      }
      
      if (msg.type === 'capsule_ack') {
         const myTargetRole = role === 'alice' ? 'refund_mpc_Bob' : 'refund_mpc_Alice';
         if (msg.payload.role !== myTargetRole) return []; 
         
         if (!msg.payload.ok) {
            return emitAbort('PROTOCOL_ERROR', `Peer rejected capsule: ${msg.payload.reason}`);
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
    getTranscriptHash: () => {
        // If locked/post-handshake, use full hash
        if (state !== 'HANDSHAKE' && state !== 'WAIT_PEER') {
            return getFullTranscriptHash();
        }
        return handshake.getTranscriptHash();
    },
  };
}
