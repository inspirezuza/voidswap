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
    tamperCapsule = false // Optional flag
  ) {
    this.role = role;
    this.callbacks = callbacks;
    
    const localNonce = makeNonce32();
    
    this.runtime = createSessionRuntime({
      role,
      params,
      localNonce,
      tamperCapsule,
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
}

// Re-export types for convenience
export type { SessionState, NonceReportPayload, FeeParamsPayload };
