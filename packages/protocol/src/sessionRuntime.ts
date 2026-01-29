import { createHash } from 'crypto';
import {
    type Message,
    parseMessage,
    type HandshakeParams,
    type Role,
    type CapsuleAckMessage,
    type FundingTxMessage,
    type FundingTxPayload,
    type MpcResult
} from './messages.js';
import { createHandshakeRuntime, type RuntimeEvent } from './handshakeRuntime.js';
import { canonicalStringify } from './canonical.js';
import { transcriptHash as computeTranscriptHash, type TranscriptRecord } from './transcript.js';

export type SessionEvent = 
  | { kind: 'NET_OUT'; msg: Message }
  | { kind: 'SESSION_LOCKED'; sid: string; transcriptHash: string }
  | { kind: 'KEYGEN_COMPLETE'; sid: string; transcriptHash: string; mpcAlice: MpcResult; mpcBob: MpcResult }
  | { kind: 'CAPSULES_VERIFIED'; sid: string; transcriptHash: string }
  | { kind: 'FUNDING_STARTED'; sid: string; mpcAliceAddr: string; mpcBobAddr: string; vA: string; vB: string }
  | { kind: 'FUNDING_TX_SEEN'; sid: string; payload: FundingTxPayload }
  | { kind: 'FUNDED'; sid: string; transcriptHash: string }
  | { kind: 'ABORTED'; code: string; message: string };

export type SessionState = 
  | 'WAIT_PEER' 
  | 'HANDSHAKE' 
  | 'LOCKED' 
  | 'KEYGEN' 
  | 'KEYGEN_COMPLETE' 
  | 'CAPSULES_EXCHANGE' 
  | 'CAPSULES_VERIFIED' 
  | 'FUNDING' 
  | 'FUNDED'
  | 'ABORTED';

export interface SessionRuntime {
  startHandshake(): SessionEvent[];
  handleIncoming(rawPayload: unknown): SessionEvent[];
  notifyFundingConfirmed(which: 'mpc_Alice' | 'mpc_Bob'): SessionEvent[];
  emitFundingTx(tx: { txHash: string; fromAddress: string; toAddress: string; valueWei: string }): SessionEvent[];
  getState(): SessionState;
  getSid(): string | null;
  getTranscriptHash(): string;
}

export interface SessionRuntimeOptions {
  role: Role;
  params: HandshakeParams;
  localNonce: string; // 32-byte hex
  tamperCapsule?: boolean;
}

export function createSessionRuntime(opts: SessionRuntimeOptions): SessionRuntime {
  const { role, params } = opts;
  
  // Internal State
  let state: SessionState = 'HANDSHAKE'; // Start in handshake immediately? Or Wait? The runtime starts ready.
  let sid: string | null = null;
  
  // Handshake Runtime
  const handshake = createHandshakeRuntime(opts);
  
  // Session Transcripts (for Post-Handshake)
  const postHandshakeTranscript: Message[] = [];
  let postSeq = 100; // distinct from handshake seq
  const lastPostSeqBySender: Record<Role, number | null> = { alice: null, bob: null };

  // Keygen State
  let localMpc: any = null;
  let peerMpc: any = null; // Stored when we receive keygen_announce

  // Capsule State
  let capsuleReceived = false;
  let capsuleAcked = false;

  // Funding State
  const fundingTxByWhich: Record<string, FundingTxPayload> = {}; // 'mpc_Alice' -> payload
  const fundingConfirmed: Record<string, boolean> = { mpc_Alice: false, mpc_Bob: false };

  function emitAbort(code: string, message: string): SessionEvent[] {
    const abortMsg: Message = {
      type: 'abort',
      from: role,
      seq: postSeq++,
      payload: { code: code as any, message },
    };
    if (sid) (abortMsg as any).sid = sid;

    state = 'ABORTED';
    return [
      { kind: 'NET_OUT', msg: abortMsg },
      { kind: 'ABORTED', code, message }
    ];
  }

  // Post-handshake transcript as TranscriptRecords (for proper hashing)
  const postHandshakeRecords: TranscriptRecord[] = [];

  // Helper to strip undefined values from objects (canonicalize doesn't allow undefined)
  function stripUndefined(obj: unknown): unknown {
    if (obj === null || obj === undefined) return null;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripUndefined);
    
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== undefined) {
        result[k] = stripUndefined(v);
      }
    }
    return result;
  }

  function recordPost(msg: Message) {
    postHandshakeTranscript.push(msg);
    // Also record as TranscriptRecord for hashing (strip undefined values)
    postHandshakeRecords.push({
      from: msg.from,
      seq: msg.seq,
      type: msg.type,
      payload: stripUndefined(msg.payload)
    });
  }

  function getFullTranscriptHash(): string {
    // Combine handshake transcript hash with post-handshake transcript hash
    const hHandshake = handshake.getTranscriptHash();
    const hPost = computeTranscriptHash(postHandshakeRecords);
    
    // Compute combined hash
    const combined = canonicalStringify({ hHandshake, hPost });
    return createHash('sha256').update(combined, 'utf8').digest('hex');
  }

  function handleLock(sidValue: string): SessionEvent[] {
    sid = sidValue;
    state = 'KEYGEN';
    
    // Simulate Keygen immediately (mock)
    localMpc = mockKeygen(sidValue, role);
    
    const announceMsg: Message = {
        type: 'keygen_announce',
        from: role,
        seq: postSeq++,
        sid: sid!,
        payload: {
            mpcAlice: role === 'alice' ? localMpc : undefined, // Alice sends hers
            mpcBob: role === 'bob' ? localMpc : undefined,     // Bob sends his
            note: 'mock-generated'
        }
    };
    
    // Correct payload adjustment based on role:
    if (role === 'alice') {
        announceMsg.payload = { mpcAlice: localMpc, mpcBob: undefined as any, note: 'mock-generated' };
    } else {
        announceMsg.payload = { mpcAlice: undefined as any, mpcBob: localMpc, note: 'mock-generated' };
    }
    // Ideally we'd send only our part, but for mock simplicity let's stick to the protocol schema.
    // The protocol likely expects us to fill our slot.
    
    recordPost(announceMsg);
    
    return [{ kind: 'NET_OUT', msg: announceMsg }];
  }

  function checkKeygenComplete(): SessionEvent[] {
      if (peerMpc) {
          // Emit completion event
          const event: SessionEvent = {
              kind: 'KEYGEN_COMPLETE',
              sid: sid!,
              transcriptHash: getFullTranscriptHash(),
              mpcAlice: role === 'alice' ? localMpc : peerMpc,
              mpcBob: role === 'bob' ? localMpc : peerMpc,
          };

          state = 'KEYGEN_COMPLETE';
          
          // Auto-transition to CAPSULES_EXCHANGE
          state = 'CAPSULES_EXCHANGE';
          
          // Generate Capsule
          // ... (Mock capsule generation) ...
          
          // Determine parameters based on role
          let targetRole: 'refund_mpc_Alice' | 'refund_mpc_Bob';
          let refundRound: number;
          let yShareRole: 'refund_mpc_Alice' | 'refund_mpc_Bob'; 
          
          if (role === 'alice') {
              // Alice creates capsule for Bob to refund? No, Alice creates capsule GIVING key to Bob?
              // The capsule contains "yShare" for the other party?
              // Standard: Alice encrypts key for Bob.
              targetRole = 'refund_mpc_Bob'; // Bob is the decryptor?
              refundRound = params.rBRefund; 
              // Wait, yShare is MY share or THEIR share?
              // Alice sends Enc(yAlice). Bob decrypts yAlice.
              yShareRole = 'refund_mpc_Alice';
          } else {
              targetRole = 'refund_mpc_Alice';
              refundRound = params.rARefund;
              yShareRole = 'refund_mpc_Bob';
          }
          
          const yShare = mockYShare(sid!, yShareRole); 
          const tlock = mockTlockEncrypt({ 
              sid: sid!, 
              role: targetRole, 
              refundRound, 
              yShare 
          });
          
          const offerMsg: Message = {
              type: 'capsule_offer',
              from: role,
              seq: postSeq++,
              sid: sid!,
              payload: {
                  role: targetRole,
                  refundRound: refundRound,
                  yShare: yShare, // Mock logic: we send the plaintext too for verification/mocking? 
                                  // In real protocol, yShare is HIDDEN or commitment?
                                  // Mock uses yShare as commitment.
                  ct: tlock.ct,
                  proof: tlock.proof
              }
          };
          
          recordPost(offerMsg);
          return [event, { kind: 'NET_OUT', msg: offerMsg }];
      }
      return [];
  }

  function checkCapsulesVerified(): SessionEvent[] {
      if (capsuleReceived && capsuleAcked) {
          state = 'CAPSULES_VERIFIED';
          
          // Auto-transition to FUNDING
          state = 'FUNDING';
          const ev: SessionEvent = { 
              kind: 'FUNDING_STARTED', 
              sid: sid!,
              mpcAliceAddr: role === 'alice' ? localMpc.address : peerMpc.address,
              mpcBobAddr: role === 'bob' ? localMpc.address : peerMpc.address,
              vA: params.vA,
              vB: params.vB
          };
          return [ev];
      }
      return [];
  }

  function checkFundingComplete(): SessionEvent[] {
      if (state !== 'FUNDING') return [];
      
      const aliceConf = fundingConfirmed['mpc_Alice'];
      const bobConf = fundingConfirmed['mpc_Bob'];
      
      // We also need the TX data to be present
      const aliceTx = fundingTxByWhich['mpc_Alice'];
      const bobTx = fundingTxByWhich['mpc_Bob'];
      
      if (aliceConf && bobConf && aliceTx && bobTx) {
          state = 'FUNDED';
          return [{
              kind: 'FUNDED',
              sid: sid!,
              transcriptHash: getFullTranscriptHash()
          }];
      }
      return [];
  }

  function mapEvent(e: RuntimeEvent): SessionEvent[] {
    if (e.kind === 'NET_OUT') return [e];
    if (e.kind === 'ABORTED') {
        state = 'ABORTED';
        return [e];
    }
    if (e.kind === 'LOCKED') {
        // We handle LOCK internally to transition to Keygen
        return [{ kind: 'SESSION_LOCKED', sid: e.sid, transcriptHash: e.transcriptHash }];
    }
    return [];
  }

  function startHandshake(): SessionEvent[] {
      return handshake.start().flatMap(mapEvent);
  }

  function handleIncoming(rawPayload: unknown): SessionEvent[] {
    if (state === 'ABORTED' || state === 'FUNDED') return [];

    let msg: Message;
    try {
      msg = parseMessage(rawPayload);
    } catch (err) {
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
    if (state === 'KEYGEN' || state === 'CAPSULES_EXCHANGE' || state === 'FUNDING' || state === 'CAPSULES_VERIFIED') {
        // SID Check
        if (msg.sid !== sid) {
             if (msg.type === 'abort') return [{ kind: 'ABORTED', code: (msg.payload as any).code, message: (msg.payload as any).message }];
             return emitAbort('SID_MISMATCH', `Expected ${sid}, got ${msg.sid}`);
        }
        
        // Ignore self
        if (msg.from === role) return [];
        
        // Enforce Seq
        const lastSeq = lastPostSeqBySender[msg.from]; // Should use postSeq logic for post-handshake msgs?
        // Note: Handshake msgs use 0/1. Post-handshake use 100+. 
        // We should ensure seq >= 100.
        if (msg.seq < 100) return emitAbort('BAD_MESSAGE', 'Post-handshake seq must be >= 100');
        
        if (lastSeq !== null && msg.seq <= lastSeq) {
             return emitAbort('BAD_MESSAGE', `Replay/out-of-order: seq ${msg.seq} <= last ${lastSeq}`);
        }
        lastPostSeqBySender[msg.from] = msg.seq;
        
        recordPost(msg);
    }

    // Global Keygen Consistency Check
    if (msg.type === 'keygen_announce' && peerMpc) {
        const receivedPayload = msg.payload;
        const peerMpcData = role === 'alice' ? receivedPayload.mpcBob : receivedPayload.mpcAlice;
        
        if (!peerMpcData) {
            return emitAbort('PROTOCOL_ERROR', 'Missing peer MPC data keygen_announce');
        }

        const stored = canonicalStringify(peerMpc);
        const received = canonicalStringify(peerMpcData);

        if (stored !== received) {
             return emitAbort('PROTOCOL_ERROR', 'Conflicting keygen data');
        }
        
        // If matches, ignore (idempotent)
        if (state !== 'KEYGEN') return [];
    }

    // Funding Logic
    if (state === 'FUNDING') {
        if (msg.type === 'funding_tx') {
            const which = msg.payload.which;
            const expectedWhich = msg.from === 'alice' ? 'mpc_Alice' : 'mpc_Bob';
            
            if (which !== expectedWhich) {
                return emitAbort('PROTOCOL_ERROR', `Invalid funding target for role ${msg.from}`);
            }

            if (fundingTxByWhich[which]) {
                 const stored = canonicalStringify(fundingTxByWhich[which]);
                 const received = canonicalStringify(msg.payload);
                 if (stored !== received) {
                     return emitAbort('PROTOCOL_ERROR', 'Conflicting funding_tx');
                 }
                 return []; // Idempotent
            }
            
            fundingTxByWhich[which] = msg.payload;
            // Emit FUNDING_TX_SEEN event before checking completion
            const events: SessionEvent[] = [{ kind: 'FUNDING_TX_SEEN', sid: sid!, payload: msg.payload }];
            events.push(...checkFundingComplete());
            return events;
        }
    }

    // Keygen Logic
    if (state === 'KEYGEN') {
      if (msg.type !== 'keygen_announce') {
          // If we receive future messages (e.g. capsule_offer) while in KEYGEN?
          // For now strict state machine.
          return [];
      }

      const receivedPayload = msg.payload;
      // In mock, we trust the payload contents for the peer
      const peerMpcData = role === 'alice' ? receivedPayload.mpcBob : receivedPayload.mpcAlice;
      
      if (!peerMpcData) {
          return emitAbort('PROTOCOL_ERROR', 'Missing peer MPC data keygen_announce');
      }

      // Check conflict if already set?
      if (peerMpc) {
          const stored = canonicalStringify(peerMpc);
          const received = canonicalStringify(peerMpcData);
          if (stored !== received) return emitAbort('PROTOCOL_ERROR', 'Conflicting keygen data');
          return [];
      }
      
      peerMpc = peerMpcData; 
      
      return checkKeygenComplete();
    }
    
    if (state === 'CAPSULES_EXCHANGE') {
      if (msg.type === 'capsule_offer') {
          let expectedRole: 'refund_mpc_Alice' | 'refund_mpc_Bob';
          let expectedRound: number;
          let expectedYShareRole: 'refund_mpc_Alice' | 'refund_mpc_Bob';
          
          if (role === 'alice') {
               expectedRole = 'refund_mpc_Alice';
               expectedYShareRole = 'refund_mpc_Bob';
               expectedRound = params.rARefund;
          } else {
               expectedRole = 'refund_mpc_Bob';
               expectedYShareRole = 'refund_mpc_Alice';
               expectedRound = params.rBRefund;
          }
          
          if (msg.payload.role !== expectedRole || msg.payload.refundRound !== expectedRound) {
             return emitAbort('PROTOCOL_ERROR', 'Unexpected capsule params');
          }
          
          const expectedYShare = mockYShare(sid!, expectedYShareRole);
          if (msg.payload.yShare !== expectedYShare) {
              return emitAbort('PROTOCOL_ERROR', 'Invalid yShare commitment');
          }
          
          // tlockInput uses the Target Role and Round, but arguably encrypts the yShare?
          const tlockInput = { sid: sid!, role: expectedRole, refundRound: expectedRound, yShare: expectedYShare };
          const expectedCt = mockTlockEncrypt(tlockInput).ct;
          
          if (msg.payload.ct !== expectedCt) {
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
  
          // Mock Verify
          const valid = mockVerifyCapsule({ ...tlockInput, ct: msg.payload.ct }, msg.payload.proof);
          if (!valid) {
              return emitAbort('PROTOCOL_ERROR', 'Invalid capsule proof');
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

  function emitFundingTx(tx: { txHash: string; fromAddress: string; toAddress: string; valueWei: string }): SessionEvent[] {
      if (state !== 'FUNDING') {
          return emitAbort('PROTOCOL_ERROR', 'Cannot emit funding tx outside FUNDING state');
      }
      
      const which = role === 'alice' ? 'mpc_Alice' : 'mpc_Bob';
      const msg: FundingTxMessage = {
          type: 'funding_tx',
          from: role,
          seq: postSeq++,
          sid: sid!,
          payload: {
              which,
              ...tx
          }
      };
      
      fundingTxByWhich[which] = msg.payload;
      recordPost(msg);
      
      const events: SessionEvent[] = [{ kind: 'NET_OUT', msg }];
      events.push(...checkFundingComplete());
      return events;
  }

  function notifyFundingConfirmed(which: 'mpc_Alice' | 'mpc_Bob'): SessionEvent[] {
      if (state !== 'FUNDING') return [];
      fundingConfirmed[which] = true;
      return checkFundingComplete();
  }

  return {
    startHandshake,
    handleIncoming,
    notifyFundingConfirmed,
    emitFundingTx,
    getState: () => state,
    getSid: () => sid,
    getTranscriptHash: () => {
        if (state !== 'HANDSHAKE' && state !== 'WAIT_PEER') {
            return getFullTranscriptHash();
        }
        return handshake.getTranscriptHash();
    },
  };
}

// ==========================================
// Mock Crypto Helpers
// ==========================================

function mockKeygen(sid: string, role: string) {
    const seed = sid + role;
    return {
        address: '0x' + createHash('sha1').update(seed).digest('hex'),
        commitments: { 
            local: '0x02' + createHash('sha256').update(seed + 'local').digest('hex'),
            peer: '0x02' + createHash('sha256').update(seed + 'peer').digest('hex')
        }
    };
}

function mockYShare(sid: string, role: string) {
    return '0x02' + createHash('sha256').update(sid + role + 'yshare').digest('hex');
}

function mockTlockEncrypt(input: any) {
    // Deterministic mock encryption
    const json = JSON.stringify(input); // canonical enough for mock
    return {
        ct: '0x' + createHash('sha256').update(json + 'ct').digest('hex'),
        proof: '0x' + createHash('sha256').update(json + 'proof').digest('hex')
    };
}

function mockVerifyCapsule(ctx: any, proof: string) {
    // Recompute expected proof for this context
    const json = JSON.stringify(ctx); 
    // Note: ctx contains ct, but mockTlockEncrypt computed ct and proof from input.
    // Here we are verifying the proof matches the CT/Context?
    // In real SP4, proof proves decryption of CT yields correct result or similar.
    // For mock, let's just assert the proof matches the mockTlockEncrypt output for the SAME input?
    // But we don't have the original input (yShare) here easily? 
    // Actually we passed yShare in tlockInput in sessionRuntime.ts before calling this.
    
    // sessionRuntime.ts calls: 
    // const tlockInput = { sid, role, refundRound, yShare };
    // mockVerifyCapsule({ ...tlockInput, ct }, proof);
    
    // So 'ctx' has yShare.
    // So we can re-run mockTlockEncrypt(ctx) (stripping ct?) and check if proof matches.
    const { proof: expectedProof } = mockTlockEncrypt({
        sid: ctx.sid,
        role: ctx.role,
        refundRound: ctx.refundRound,
        yShare: ctx.yShare
    });
    
    if (proof !== expectedProof) {
        return false;
    }
    return true;
}
