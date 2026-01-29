import { createHash } from 'crypto';
import {
    type Message,
    parseMessage,
    type HandshakeParams,
    type Role,
    type CapsuleAckMessage,
    type FundingTxMessage,
    type FundingTxPayload,
    type MpcResult,
    type NonceReportPayload,
    type FeeParamsPayload
} from './messages.js';
import { createHandshakeRuntime, type RuntimeEvent } from './handshakeRuntime.js';
import { canonicalStringify } from './canonical.js';
import { transcriptHash as computeTranscriptHash, type TranscriptRecord } from './transcript.js';
import { buildExecutionTemplates, type TxTemplateResult } from './executionTemplates.js';
import { mockKeygen, mockYShare } from './mockKeygen.js';
import { mockTlockEncrypt, mockVerifyCapsule } from './mockTlock.js';

export type SessionEvent = 
  | { kind: 'NET_OUT'; msg: Message }
  | { kind: 'SESSION_LOCKED'; sid: string; transcriptHash: string }
  | { kind: 'KEYGEN_COMPLETE'; sid: string; transcriptHash: string; mpcAlice: MpcResult; mpcBob: MpcResult }
  | { kind: 'CAPSULES_VERIFIED'; sid: string; transcriptHash: string }
  | { kind: 'FUNDING_STARTED'; sid: string; mpcAliceAddr: string; mpcBobAddr: string; vA: string; vB: string }
  | { kind: 'FUNDING_TX_SEEN'; sid: string; payload: FundingTxPayload }
  | { kind: 'FUNDED'; sid: string; transcriptHash: string }
  | { kind: 'EXEC_PREP_STARTED'; sid: string; mpcAlice: string; mpcBob: string }
  | { kind: 'EXEC_READY'; sid: string; transcriptHash: string; nonces: { mpcAliceNonce: string; mpcBobNonce: string }; fee: FeeParamsPayload }
  | { kind: 'EXEC_TEMPLATES_BUILT'; sid: string; transcriptHash: string; digestA: string; digestB: string }
  | { kind: 'EXEC_TEMPLATES_READY'; sid: string; transcriptHash: string; digestA: string; digestB: string }
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
  | 'EXEC_PREP'
  | 'EXEC_READY'
  | 'EXEC_TEMPLATES_BUILT'
  | 'EXEC_TEMPLATES_SYNC'
  | 'EXEC_TEMPLATES_READY'
  | 'ABORTED';

export interface SessionRuntime {
  startHandshake(): SessionEvent[];
  handleIncoming(rawPayload: unknown): SessionEvent[];
  notifyFundingConfirmed(which: 'mpc_Alice' | 'mpc_Bob'): SessionEvent[];
  emitFundingTx(tx: { txHash: string; fromAddress: string; toAddress: string; valueWei: string }): SessionEvent[];
  setLocalNonceReport(payload: NonceReportPayload): SessionEvent[];
  proposeFeeParams(payload: FeeParamsPayload): SessionEvent[];
  getState(): SessionState;
  getSid(): string | null;
  getTranscriptHash(): string;
  getMpcAddresses(): { mpcAlice: string; mpcBob: string } | null;
}

export interface SessionRuntimeOptions {
  role: Role;
  params: HandshakeParams;
  localNonce: string; // 32-byte hex
  tamperCapsule?: boolean;
  outboundMutator?: (msg: Message) => Message;
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

  // EXEC_PREP State
  let localNonces: NonceReportPayload | null = null;
  let peerNonces: NonceReportPayload | null = null;
  let feeParams: FeeParamsPayload | null = null;
  let feeAcked = false;
  
  // Execution Templates (computed after EXEC_READY)
  let execTemplates: TxTemplateResult | null = null;
  
  // Template Sync State (EXEC_TEMPLATES_SYNC)
  let localCommitHash: string | null = null;
  let peerCommitHash: string | null = null;
  let localCommitAcked = false;

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
          
          // Emit CAPSULES_VERIFIED event first
          const verifiedEv: SessionEvent = {
              kind: 'CAPSULES_VERIFIED',
              sid: sid!,
              transcriptHash: getFullTranscriptHash()
          };
          
          // Auto-transition to FUNDING
          state = 'FUNDING';
          const fundingEv: SessionEvent = { 
              kind: 'FUNDING_STARTED', 
              sid: sid!,
              mpcAliceAddr: role === 'alice' ? localMpc.address : peerMpc.address,
              mpcBobAddr: role === 'bob' ? localMpc.address : peerMpc.address,
              vA: params.vA,
              vB: params.vB
          };
          return [verifiedEv, fundingEv];
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
          const fundedEvent: SessionEvent = {
              kind: 'FUNDED',
              sid: sid!,
              transcriptHash: getFullTranscriptHash()
          };
          
          // Auto-transition to EXEC_PREP
          state = 'EXEC_PREP';
          const mpcAliceAddr = role === 'alice' ? localMpc.address : peerMpc.address;
          const mpcBobAddr = role === 'bob' ? localMpc.address : peerMpc.address;
          
          const execPrepEvent: SessionEvent = {
              kind: 'EXEC_PREP_STARTED',
              sid: sid!,
              mpcAlice: mpcAliceAddr,
              mpcBob: mpcBobAddr
          };
          
          return [fundedEvent, execPrepEvent];
      }
      return [];
  }

  function checkExecReady(): SessionEvent[] {
      if (state !== 'EXEC_PREP') return [];
      
      // Check nonces agree
      if (!localNonces || !peerNonces) return [];
      
      const noncesAgree = 
          localNonces.mpcAliceNonce === peerNonces.mpcAliceNonce &&
          localNonces.mpcBobNonce === peerNonces.mpcBobNonce;
      
      if (!noncesAgree) {
          return emitAbort('PROTOCOL_ERROR', `Nonce mismatch: local=${JSON.stringify(localNonces)}, peer=${JSON.stringify(peerNonces)}`);
      }
      
      // Check fee params agreed
      if (!feeParams || !feeAcked) return [];
      
      // All conditions met -> EXEC_READY
      state = 'EXEC_READY';
      const execReadyEvent: SessionEvent = {
          kind: 'EXEC_READY',
          sid: sid!,
          transcriptHash: getFullTranscriptHash(),
          nonces: {
              mpcAliceNonce: localNonces.mpcAliceNonce,
              mpcBobNonce: localNonces.mpcBobNonce
          },
          fee: feeParams
      };
      
      // Compute execution templates immediately
      const mpcAliceAddr = role === 'alice' ? localMpc.address : peerMpc.address;
      const mpcBobAddr = role === 'bob' ? localMpc.address : peerMpc.address;
      
      execTemplates = buildExecutionTemplates({
          chainId: params.chainId,
          targets: {
              targetAlice: params.targetAlice,
              targetBob: params.targetBob
          },
          mpcs: {
              mpcAlice: mpcAliceAddr,
              mpcBob: mpcBobAddr
          },
          values: {
              vAWei: params.vA,
              vBWei: params.vB
          },
          nonces: {
              mpcAliceNonce: localNonces.mpcAliceNonce,
              mpcBobNonce: localNonces.mpcBobNonce
          },
          fee: {
              maxFeePerGasWei: feeParams.maxFeePerGasWei,
              maxPriorityFeePerGasWei: feeParams.maxPriorityFeePerGasWei,
              gasLimit: feeParams.gasLimit
          }
      });
      
      // Transition to EXEC_TEMPLATES_BUILT
      state = 'EXEC_TEMPLATES_BUILT';
      const templatesEvent: SessionEvent = {
          kind: 'EXEC_TEMPLATES_BUILT',
          sid: sid!,
          transcriptHash: getFullTranscriptHash(),
          digestA: execTemplates!.digestA,
          digestB: execTemplates!.digestB
      };
      
      // Compute commit hash and send tx_template_commit
      const digestsObj = { digestA: execTemplates!.digestA, digestB: execTemplates!.digestB };
      localCommitHash = createHash('sha256')
          .update(canonicalStringify(digestsObj), 'utf8')
          .digest('hex');
      
      let commitMsg: Message = {
          type: 'tx_template_commit',
          from: role,
          seq: postSeq++,
          sid: sid!,
          payload: {
              digestA: execTemplates!.digestA,
              digestB: execTemplates!.digestB,
              commitHash: localCommitHash
          }
      };
      
      // Apply mutator if present (for tampering tests)
      if (opts.outboundMutator) {
          commitMsg = opts.outboundMutator(commitMsg);
      }
      
      recordPost(commitMsg);
      
      // Transition to EXEC_TEMPLATES_SYNC
      state = 'EXEC_TEMPLATES_SYNC';
      
      return [execReadyEvent, templatesEvent, { kind: 'NET_OUT', msg: commitMsg }];
  }

  function checkTemplatesReady(): SessionEvent[] {
      if (state !== 'EXEC_TEMPLATES_SYNC') return [];
      
      // Both conditions must be met
      if (!peerCommitHash || !localCommitAcked) return [];
      
      // Transition to EXEC_TEMPLATES_READY
      state = 'EXEC_TEMPLATES_READY';
      return [{
          kind: 'EXEC_TEMPLATES_READY',
          sid: sid!,
          transcriptHash: getFullTranscriptHash(),
          digestA: execTemplates!.digestA,
          digestB: execTemplates!.digestB
      }];
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
    if (state === 'ABORTED' || state === 'EXEC_READY') return [];

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
    if (state === 'KEYGEN' || state === 'CAPSULES_EXCHANGE' || state === 'FUNDING' || state === 'CAPSULES_VERIFIED' || state === 'EXEC_PREP') {
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
        
        if (lastSeq !== null && msg.seq < lastSeq) {
             return emitAbort('BAD_MESSAGE', `Replay/out-of-order: seq ${msg.seq} < last ${lastSeq}`);
        }
        if (lastSeq === null || msg.seq > lastSeq) {
            lastPostSeqBySender[msg.from] = msg.seq;
        }
        
        // NOTE: recordPost is called in state-specific handlers AFTER validation
        // to ensure transcript only contains accepted messages
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
            recordPost(msg); // Record AFTER validation
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
      recordPost(msg); // Record AFTER validation
      
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
          
          // Idempotency check
          if (capsuleReceived) {
              return []; // Already received and acked
          }
          
          recordPost(msg); // Record incoming capsule_offer AFTER validation
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
          
          // Idempotency check
          if (capsuleAcked) {
              return []; // Already acked
          }
          
          recordPost(msg); // Record incoming capsule_ack AFTER validation
          capsuleAcked = true;
          return checkCapsulesVerified();
      }
    }

    // EXEC_PREP Logic
    if (state === 'EXEC_PREP') {
        if (msg.type === 'nonce_report') {
            // Validate sid and from
            if (peerNonces) {
                // Idempotency check
                const stored = canonicalStringify(peerNonces);
                const received = canonicalStringify(msg.payload);
                if (stored !== received) {
                    return emitAbort('PROTOCOL_ERROR', 'Conflicting nonce_report');
                }
                return []; // Idempotent
            }
            
            peerNonces = msg.payload;
            recordPost(msg); // Record AFTER validation
            return checkExecReady();
        }
        
        if (msg.type === 'fee_params') {
            // Only Alice proposes (Bob receives)
            if (role !== 'bob') {
                return emitAbort('PROTOCOL_ERROR', 'Only Bob receives fee_params');
            }
            
            if (msg.payload.proposer !== 'alice' || msg.payload.mode !== 'fixed') {
                return emitAbort('PROTOCOL_ERROR', 'Invalid fee_params proposal');
            }
            
            // Idempotency check
            if (feeParams) {
                const stored = canonicalStringify(feeParams);
                const received = canonicalStringify(msg.payload);
                if (stored !== received) {
                    return emitAbort('PROTOCOL_ERROR', 'Conflicting fee_params');
                }
                return []; // Idempotent
            }
            
            // Store and compute hash for ack
            feeParams = msg.payload;
            recordPost(msg); // Record incoming fee_params AFTER validation
            const hash = createHash('sha256')
                .update(canonicalStringify(msg.payload), 'utf8')
                .digest('hex');
            
            // Send ack
            const ackMsg: Message = {
                type: 'fee_params_ack',
                from: role,
                seq: postSeq++,
                sid: sid!,
                payload: {
                    ok: true,
                    feeParamsHash: hash
                }
            };
            recordPost(ackMsg);
            feeAcked = true; // Bob considers it acked when he sends ack
            
            const events: SessionEvent[] = [{ kind: 'NET_OUT', msg: ackMsg }];
            events.push(...checkExecReady());
            return events;
        }
        
        if (msg.type === 'fee_params_ack') {
            // Only Alice receives ack (from Bob)
            if (role !== 'alice') {
                return emitAbort('PROTOCOL_ERROR', 'Only Alice receives fee_params_ack');
            }
            
            if (!feeParams) {
                return emitAbort('PROTOCOL_ERROR', 'Received fee_params_ack before proposing');
            }
            
            const expectedHash = createHash('sha256')
                .update(canonicalStringify(feeParams), 'utf8')
                .digest('hex');
            
            if (msg.payload.feeParamsHash !== expectedHash) {
                return emitAbort('PROTOCOL_ERROR', `Fee params hash mismatch: expected ${expectedHash}, got ${msg.payload.feeParamsHash}`);
            }
            
            if (!msg.payload.ok) {
                return emitAbort('PROTOCOL_ERROR', `Fee params rejected: ${msg.payload.reason}`);
            }
            
            // Idempotency check
            if (feeAcked) {
                return []; // Already acked
            }
            
            recordPost(msg); // Record incoming fee_params_ack AFTER validation
            feeAcked = true;
            return checkExecReady();
        }
    }

    // EXEC_TEMPLATES_SYNC Logic
    if (state === 'EXEC_TEMPLATES_SYNC') {
        // SID Check
        if (msg.sid !== sid) {
            if (msg.type === 'abort') return [{ kind: 'ABORTED', code: (msg.payload as any).code, message: (msg.payload as any).message }];
            return emitAbort('SID_MISMATCH', `Expected ${sid}, got ${msg.sid}`);
        }
        
        // Ignore self
        if (msg.from === role) return [];
        
        // Enforce Seq
        const lastSeq = lastPostSeqBySender[msg.from];
        if (msg.seq < 100) return emitAbort('BAD_MESSAGE', 'Post-handshake seq must be >= 100');
        if (lastSeq !== null && msg.seq < lastSeq) {
            return emitAbort('BAD_MESSAGE', `Replay/out-of-order: seq ${msg.seq} < last ${lastSeq}`);
        }
        if (lastSeq === null || msg.seq > lastSeq) {
            lastPostSeqBySender[msg.from] = msg.seq;
        }
        
        if (msg.type === 'tx_template_commit') {
            const payload = msg.payload;
            
            // Verify commit hash matches
            const expectedHash = createHash('sha256')
                .update(canonicalStringify({ digestA: payload.digestA, digestB: payload.digestB }), 'utf8')
                .digest('hex');
            
            if (payload.commitHash !== expectedHash) {
                return emitAbort('BAD_MESSAGE', `Invalid commit hash: expected ${expectedHash}, got ${payload.commitHash}`);
            }
            
            // Verify digests match local templates
            if (!execTemplates) {
                return emitAbort('PROTOCOL_ERROR', 'No local templates computed');
            }
            
            if (payload.digestA !== execTemplates.digestA || payload.digestB !== execTemplates.digestB) {
                return emitAbort('PROTOCOL_ERROR', `Template digest mismatch: local A=${execTemplates.digestA.slice(0,18)}..., peer A=${payload.digestA.slice(0,18)}...`);
            }
            
            // Idempotency check
            if (peerCommitHash) {
                if (peerCommitHash !== payload.commitHash) {
                    return emitAbort('PROTOCOL_ERROR', 'Conflicting tx_template_commit');
                }
                return []; // Idempotent
            }
            
            // Store peer commit
            peerCommitHash = payload.commitHash;
            recordPost(msg);
            
            // Send ack
            const ackMsg: Message = {
                type: 'tx_template_ack',
                from: role,
                seq: postSeq++,
                sid: sid!,
                payload: {
                    ok: true,
                    commitHash: payload.commitHash
                }
            };
            recordPost(ackMsg);
            
            const events: SessionEvent[] = [{ kind: 'NET_OUT', msg: ackMsg }];
            events.push(...checkTemplatesReady());
            return events;
        }
        
        if (msg.type === 'tx_template_ack') {
            const payload = msg.payload;
            
            // Verify it's for our commit
            if (!localCommitHash) {
                return emitAbort('PROTOCOL_ERROR', 'Received tx_template_ack before sending commit');
            }
            
            if (payload.commitHash !== localCommitHash) {
                return emitAbort('PROTOCOL_ERROR', `Ack hash mismatch: expected ${localCommitHash}, got ${payload.commitHash}`);
            }
            
            if (!payload.ok) {
                return emitAbort('PROTOCOL_ERROR', `Template commit rejected: ${payload.reason}`);
            }
            
            // Idempotency check
            if (localCommitAcked) {
                return []; // Already acked
            }
            
            localCommitAcked = true;
            recordPost(msg);
            return checkTemplatesReady();
        }
    }

    return [];
  }

  function emitFundingTx(tx: { txHash: string; fromAddress: string; toAddress: string; valueWei: string }): SessionEvent[] {
      if (state !== 'FUNDING') {
          return emitAbort('PROTOCOL_ERROR', 'Cannot emit funding tx outside FUNDING state');
      }
      
      // Explicitly destructure to prevent any "which" override from input
      const { txHash, fromAddress, toAddress, valueWei } = tx;
      const which = role === 'alice' ? 'mpc_Alice' : 'mpc_Bob';
      
      const msg: FundingTxMessage = {
          type: 'funding_tx',
          from: role,
          seq: postSeq++,
          sid: sid!,
          payload: {
              which,
              txHash,
              fromAddress,
              toAddress,
              valueWei
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

  function setLocalNonceReport(payload: NonceReportPayload): SessionEvent[] {
      if (state !== 'EXEC_PREP') {
          return emitAbort('PROTOCOL_ERROR', 'Cannot set nonce report outside EXEC_PREP state');
      }
      
      if (localNonces) {
          // Idempotency check
          const stored = canonicalStringify(localNonces);
          const received = canonicalStringify(payload);
          if (stored !== received) {
              return emitAbort('PROTOCOL_ERROR', 'Conflicting local nonce report');
          }
          return []; // Idempotent
      }
      
      localNonces = payload;
      
      // Emit NET_OUT nonce_report
      const msg: Message = {
          type: 'nonce_report',
          from: role,
          seq: postSeq++,
          sid: sid!,
          payload
      };
      recordPost(msg);
      
      const events: SessionEvent[] = [{ kind: 'NET_OUT', msg }];
      events.push(...checkExecReady());
      return events;
  }

  function proposeFeeParams(payload: FeeParamsPayload): SessionEvent[] {
      if (state !== 'EXEC_PREP') {
          return emitAbort('PROTOCOL_ERROR', 'Cannot propose fee params outside EXEC_PREP state');
      }
      
      if (role !== 'alice') {
          return emitAbort('PROTOCOL_ERROR', 'Only Alice can propose fee params');
      }
      
      if (feeParams) {
          // Idempotency check
          const stored = canonicalStringify(feeParams);
          const received = canonicalStringify(payload);
          if (stored !== received) {
              return emitAbort('PROTOCOL_ERROR', 'Conflicting fee params proposal');
          }
          return []; // Idempotent
      }
      
      feeParams = payload;
      
      // Emit NET_OUT fee_params
      const msg: Message = {
          type: 'fee_params',
          from: role,
          seq: postSeq++,
          sid: sid!,
          payload
      };
      recordPost(msg);
      
      return [{ kind: 'NET_OUT', msg }];
  }

  function getMpcAddresses(): { mpcAlice: string; mpcBob: string } | null {
      if (!localMpc || !peerMpc) return null;
      return {
          mpcAlice: role === 'alice' ? localMpc.address : peerMpc.address,
          mpcBob: role === 'bob' ? localMpc.address : peerMpc.address
      };
  }

  return {
    startHandshake,
    handleIncoming,
    notifyFundingConfirmed,
    emitFundingTx,
    setLocalNonceReport,
    proposeFeeParams,
    getState: () => state,
    getSid: () => sid,
    getTranscriptHash: () => {
        if (state !== 'HANDSHAKE' && state !== 'WAIT_PEER') {
            return getFullTranscriptHash();
        }
        return handshake.getTranscriptHash();
    },
    getMpcAddresses,
  };
}

// Local mock helpers removed in favor of imported versions
