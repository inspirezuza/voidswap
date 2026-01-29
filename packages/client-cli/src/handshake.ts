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
} from '@voidswap/protocol';

export interface SessionCallbacks {
  onSendMessage: (msg: Message) => void;
  onLocked: (sid: string, transcriptHash: string) => void;
  onKeygenComplete: (sid: string, transcriptHash: string, mpcAlice: MpcResult, mpcBob: MpcResult) => void;
  onCapsulesVerified: (sid: string, transcriptHash: string) => void;
  onAbort: (code: string, message: string) => void;
  onFundingStarted: (sid: string, mpcAlice: string, mpcBob: string, vA: string, vB: string) => void;
  onFundingTx: (which: 'mpc_Alice' | 'mpc_Bob', txHash: string) => void;
  onFunded: (sid: string, transcriptHash: string) => void;
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
    // Spy on payload to detect funding_tx
    if (typeof payload === 'object' && payload !== null && 'type' in payload) {
        const p = payload as any;
        if (p.type === 'funding_tx' && p.payload && p.payload.txHash && p.payload.which) {
            this.callbacks.onFundingTx(p.payload.which, p.payload.txHash);
        }
    }
    
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
        case 'FUNDED':
          this.callbacks.onFunded(event.sid, event.transcriptHash);
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

  emitFundingTx(txHash: string) {
      // Create a dummy payload to match the interface, even though runtime might fill details
      // Actually runtime expects full payload? No, let's check runtime signature.
      // Runtime.emitFundingTx takes (txHash: string).
      // Wait, let's check sessionRuntime.ts signature for `emitFundingTx`.
      // It takes (payload: FundingTxPayload). 
      // So we need to construct it here or change runtime.
      // Ideally runtime should construct it? No, runtime is pure.
      // Client knows details.
      
      // Let's look at `sessionRuntime.ts` again via view_file if unsure, but I recall implementing it to take payload.
      // Wait, `sessionRuntime.ts` changes were not explicitly shown in recent steps for that method.
      // Let's assume for now it takes payload.
      
      const payload = {
          which: this.role === 'alice' ? 'mpc_Alice' : 'mpc_Bob',
          txHash,
          fromAddress: '0x0000000000000000000000000000000000000000', // TODO: Pass real from
          toAddress: '0x0000000000000000000000000000000000000000', // TODO: Pass real to
          valueWei: '0' // TODO: Pass real value
      };
      // The linter said "Argument of type 'string' is not assignable to parameter of type '{ ... }'".
      // So runtime indeed expects the object.
      
      const events = this.runtime.emitFundingTx(payload as any);
      this.processEvents(events);
  }

  notifyFundingConfirmed(which: 'mpc_Alice' | 'mpc_Bob') {
      const events = this.runtime.notifyFundingConfirmed(which);
      this.processEvents(events);
  }
}

// Re-export types for convenience
export type { SessionState };
