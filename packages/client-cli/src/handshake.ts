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
  onAbort: (code: string, message: string) => void;
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
    callbacks: SessionCallbacks
  ) {
    this.role = role;
    this.callbacks = callbacks;
    
    const localNonce = makeNonce32();
    
    this.runtime = createSessionRuntime({
      role,
      params,
      localNonce,
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
          this.callbacks.onLog(`Sent ${event.msg.type}`);
          this.callbacks.onSendMessage(event.msg);
          break;
        case 'SESSION_LOCKED':
          this.callbacks.onLog(`Computed sid=${event.sid}`);
          this.callbacks.onLocked(event.sid, event.transcriptHash);
          break;
        case 'KEYGEN_COMPLETE':
          this.callbacks.onKeygenComplete(event.sid, event.transcriptHash, event.mpcAlice, event.mpcBob);
          break;
        case 'ABORTED':
          this.callbacks.onAbort(event.code, event.message);
          break;
      }
    }
  }

  getState(): SessionState {
    return this.runtime.getState();
  }

  getSid(): string | null {
    return this.runtime.getSid();
  }

  getTranscriptHash(): string {
    return this.runtime.getTranscriptHash();
  }
}

// Re-export types for convenience
export type { SessionState };
