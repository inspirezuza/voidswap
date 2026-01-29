/**
 * Handshake Adapter for Client CLI
 * 
 * Wraps the protocol's HandshakeRuntime for use with the transport layer.
 * Handles event dispatch and provides a callback-based interface.
 */

import { randomBytes } from 'crypto';
import {
  createHandshakeRuntime,
  type HandshakeRuntime,
  type RuntimeEvent,
  type HandshakeParams,
  type Message,
  type Role,
  type HandshakeState,
} from '@voidswap/protocol';

export interface HandshakeCallbacks {
  onSendMessage: (msg: Message) => void;
  onLocked: (sid: string, transcriptHash: string) => void;
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
 * Handshake adapter that wraps the protocol's HandshakeRuntime
 */
export class Handshake {
  private runtime: HandshakeRuntime;
  private callbacks: HandshakeCallbacks;
  private role: Role;

  constructor(
    role: Role,
    params: HandshakeParams,
    callbacks: HandshakeCallbacks
  ) {
    this.role = role;
    this.callbacks = callbacks;
    
    const localNonce = makeNonce32();
    
    this.runtime = createHandshakeRuntime({
      role,
      params,
      localNonce,
    });
  }

  /**
   * Start the handshake by sending hello
   */
  start() {
    this.callbacks.onLog(`Handshake starting as ${this.role}`);
    const events = this.runtime.start();
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
  private processEvents(events: RuntimeEvent[]) {
    for (const event of events) {
      switch (event.kind) {
        case 'NET_OUT':
          this.callbacks.onLog(`Sent ${event.msg.type}`);
          this.callbacks.onSendMessage(event.msg);
          break;
        case 'LOCKED':
          this.callbacks.onLog(`Computed sid=${event.sid}`);
          this.callbacks.onLocked(event.sid, event.transcriptHash);
          break;
        case 'ABORTED':
          this.callbacks.onAbort(event.code, event.message);
          break;
      }
    }
  }

  getState(): HandshakeState {
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
export type { HandshakeState };
