/**
 * Session Adapter for Client CLI
 * 
 * Wraps the protocol's SessionRuntime for use with the transport layer.
 * Handles event dispatch and provides a callback-based interface.
 */

import { randomBytes } from 'crypto';
import {
  createSessionRuntime,
  type SessionRuntime,
  type SessionEvent,
  type HandshakeParams,
  type Message,
  type Role,
  type SessionState,
  type MpcResult,
  type FundingTxPayload,
  type NonceReportPayload,
  type FeeParamsPayload,
} from '@voidswap/protocol';

export interface SessionCallbacks {
  onSendMessage: (msg: Message) => void;
  onLocked: (sid: string, transcriptHash: string) => void;
  onKeygenComplete: (sid: string, transcriptHash: string, mpcAlice: MpcResult, mpcBob: MpcResult) => void;
  onCapsulesVerified: (sid: string, transcriptHash: string) => void;
  onAbort: (code: string, message: string) => void;
  onFundingStarted: (sid: string, mpcAlice: string, mpcBob: string, vA: string, vB: string) => void;
  onFundingTx: (which: 'mpc_Alice' | 'mpc_Bob', txHash: string, payload: FundingTxPayload) => void;
  onFunded: (sid: string, transcriptHash: string) => void;
  onExecPrepStarted: (sid: string, mpcAlice: string, mpcBob: string) => void;
  onExecReady: (sid: string, transcriptHash: string, nonces: { mpcAliceNonce: string; mpcBobNonce: string }, fee: FeeParamsPayload) => void;
  onExecTemplatesBuilt: (sid: string, transcriptHash: string, digestA: string, digestB: string) => void;
  onExecTemplatesReady: (sid: string, transcriptHash: string, digestA: string, digestB: string) => void;
  onAdaptorNegotiating: (sid: string, transcriptHash: string) => void;
  onAdaptorReady: (sid: string, transcriptHash: string, digestB: string, TB: string) => void;
  onExecutionPlanned: (sid: string, transcriptHash: string, flow: 'B', roleAction: string, txB: { unsigned: any; digest: string }, txA: { unsigned: any; digest: string }) => void;
  onTxBHashReceived: (sid: string, transcriptHash: string, txBHash: string) => void;
  onTxAHashReceived: (sid: string, transcriptHash: string, txAHash: string) => void;
  onLog: (message: string) => void;
}

/**
 * Generate a 32-byte random nonce as hex string (0x + 64 lowercase hex chars)
 */
export function makeNonce32(): string {
  const bytes = randomBytes(32);
  const hex = '0x' + bytes.toString('hex'); // toString('hex') always produces lowercase
  
  // Runtime assertion - strict lowercase validation
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Generated nonce does not match expected format: ${hex}`);
  }
  
  return hex;
}

/**
 * Session adapter that wraps the protocol's SessionRuntime
 */
export class Session {
  private runtime: SessionRuntime;
  private callbacks: SessionCallbacks;
  private role: Role;

  constructor(
    role: Role,
    params: HandshakeParams,
    callbacks: SessionCallbacks,
    tamperCapsule = false, // Optional flag
    tamperTemplateCommit = false, // Optional flag
    tamperAdaptor = false // Optional flag
  ) {
    this.role = role;
    this.callbacks = callbacks;
    
    const localNonce = makeNonce32();

    // Mutator for tampering (Bob only)
    let outboundMutator: ((msg: Message) => Message) | undefined;
    
    if (role === 'bob' && (tamperTemplateCommit || tamperAdaptor)) {
        outboundMutator = (msg: Message) => {
            // Tamper tx_template_commit
            if (tamperTemplateCommit && msg.type === 'tx_template_commit') {
                 // Mutate digestB (Bob's digest) to cause mismatch
                 const original = msg.payload.digestB;
                 const flipped = original[2] === '0' ? '1' : '0'; 
                 const mutated = '0x' + flipped + original.slice(3);
                 return {
                     ...msg,
                     payload: {
                         ...msg.payload,
                         digestB: mutated
                     }
                 };
            }
            
            // Tamper adaptor_resp by truncating signature (causes length validation failure)
            if (tamperAdaptor && msg.type === 'adaptor_resp') {
                 const original = msg.payload.adaptorSig as string;
                 // Truncate by 2 hex chars (1 byte) to trigger length check in presignFinish
                 const truncated = original.slice(0, -2);
                 return {
                     ...msg,
                     payload: {
                         ...msg.payload,
                         adaptorSig: truncated
                     }
                 };
            }
            
            return msg;
        };
    }
    
    this.runtime = createSessionRuntime({
      role,
      params,
      localNonce,
      tamperCapsule,
      outboundMutator,
    });
  }

  /**
   * Start the handshake
   */
  start() {
    this.callbacks.onLog(`Session starting as ${this.role}`);
    const events = this.runtime.startHandshake();
    this.processEvents(events);
  }

  /**
   * Handle incoming message from peer
   */
  handleIncoming(payload: unknown) {
    // No pre-parse spy - let runtime validate and emit FUNDING_TX_SEEN
    const events = this.runtime.handleIncoming(payload);
    this.processEvents(events);
  }

  /**
   * Process runtime events and dispatch to callbacks
   */
  private processEvents(events: SessionEvent[]) {
    for (const event of events) {
      switch (event.kind) {
        case 'NET_OUT':
          if (event.msg.type === 'funding_tx') {
              // Cast payload to any because TypeScript might not infer it perfectly from union
              const p = event.msg.payload as any;
              this.callbacks.onLog(`Sent funding_tx for ${p.which}: ${p.txHash}`);
          } else {
              this.callbacks.onLog(`Sent ${event.msg.type}`);
          }
          this.callbacks.onSendMessage(event.msg);
          break;
        case 'SESSION_LOCKED':
          this.callbacks.onLog(`Computed sid=${event.sid}`);
          this.callbacks.onLocked(event.sid, event.transcriptHash);
          break;
        case 'KEYGEN_COMPLETE':
          this.callbacks.onKeygenComplete(event.sid, event.transcriptHash, event.mpcAlice, event.mpcBob);
          break;
        case 'CAPSULES_VERIFIED':
          this.callbacks.onCapsulesVerified(event.sid, event.transcriptHash);
          break;
        case 'ABORTED':
          this.callbacks.onAbort(event.code, event.message);
          break;
        case 'FUNDING_STARTED':
          this.callbacks.onFundingStarted(event.sid, event.mpcAliceAddr, event.mpcBobAddr, event.vA, event.vB);
          break;
        case 'FUNDING_TX_SEEN':
          this.callbacks.onFundingTx(event.payload.which, event.payload.txHash, event.payload);
          break;
        case 'FUNDED':
          this.callbacks.onFunded(event.sid, event.transcriptHash);
          break;
        case 'EXEC_PREP_STARTED':
          this.callbacks.onExecPrepStarted(event.sid, event.mpcAlice, event.mpcBob);
          break;
        case 'EXEC_READY':
          this.callbacks.onExecReady(event.sid, event.transcriptHash, event.nonces, event.fee);
          break;
        case 'EXEC_TEMPLATES_BUILT':
          this.callbacks.onExecTemplatesBuilt(event.sid, event.transcriptHash, event.digestA, event.digestB);
          break;
        case 'EXEC_TEMPLATES_READY':
          this.callbacks.onExecTemplatesReady(event.sid, event.transcriptHash, event.digestA, event.digestB);
          break;
        case 'ADAPTOR_NEGOTIATING':
          this.callbacks.onAdaptorNegotiating(event.sid, event.transcriptHash);
          break;
        case 'ADAPTOR_READY':
          this.callbacks.onAdaptorReady(event.sid, event.transcriptHash, event.digestB, event.TB);
          break;
        case 'EXECUTION_PLANNED':
          this.callbacks.onExecutionPlanned(event.sid, event.transcriptHash, event.flow, event.roleAction, event.txB, event.txA);
          break;
        case 'TXB_HASH_RECEIVED':
          this.callbacks.onTxBHashReceived(event.sid, event.transcriptHash, event.txBHash);
          break;
        case 'TXA_HASH_RECEIVED':
          this.callbacks.onTxAHashReceived(event.sid, event.transcriptHash, event.txAHash);
          break;
      } // switch
    } // for
  } // processEvents

  getState(): SessionState {
    return this.runtime.getState();
  }

  getSid(): string | null {
    return this.runtime.getSid();
  }

  getTranscriptHash(): string {
    return this.runtime.getTranscriptHash();
  }

  emitFundingTx(tx: { txHash: string; fromAddress: string; toAddress: string; valueWei: string }) {
      // Pass only the required fields - runtime derives "which" from role
      const events = this.runtime.emitFundingTx({
          txHash: tx.txHash,
          fromAddress: tx.fromAddress,
          toAddress: tx.toAddress,
          valueWei: tx.valueWei
      });
      this.processEvents(events);
  }

  notifyFundingConfirmed(which: 'mpc_Alice' | 'mpc_Bob') {
      const events = this.runtime.notifyFundingConfirmed(which);
      this.processEvents(events);
  }

  setLocalNonceReport(payload: NonceReportPayload) {
      const events = this.runtime.setLocalNonceReport(payload);
      this.processEvents(events);
  }

  proposeFeeParams(payload: FeeParamsPayload) {
      const events = this.runtime.proposeFeeParams(payload);
      this.processEvents(events);
  }

  getMpcAddresses(): { mpcAlice: string; mpcBob: string } | null {
      return this.runtime.getMpcAddresses();
  }

  announceTxBHash(txHash: string) {
      const events = this.runtime.announceTxBHash(txHash);
      this.processEvents(events);
  }

  announceTxAHash(txHash: string) {
      const events = this.runtime.announceTxAHash(txHash);
      this.processEvents(events);
  }
}

// Re-export types for convenience
export type { SessionState, NonceReportPayload, FeeParamsPayload };
