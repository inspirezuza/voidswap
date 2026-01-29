/**
 * Handshake State Machine
 * 
 * Manages the voidswap handshake protocol:
 * 1. Both parties send hello with their nonce
 * 2. Both parties send hello_ack
 * 3. Both compute the same SID from params + nonces
 * 4. Session is locked when SID is computed
 */

import { randomBytes } from 'crypto';
import {
    parseMessage,
    computeSid,
    hashHandshake,
    canonicalStringify,
    type HandshakeParams,
    type Message,
    type Role,
} from '@voidswap/protocol';

// Handshake states
export type HandshakeState = 
  | 'INIT'
  | 'SENT_HELLO'
  | 'GOT_PEER_HELLO'
  | 'SENT_ACK'
  | 'LOCKED'
  | 'ABORTED';

export interface HandshakeCallbacks {
  onSendMessage: (msg: Message) => void;
  onLocked: (sid: string) => void;
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

export class Handshake {
  private state: HandshakeState = 'INIT';
  private localRole: Role;
  private localParams: HandshakeParams;
  private localNonce: string;
  private peerParams: HandshakeParams | null = null;
  private peerNonce: string | null = null;
  private seq = 0;
  private sid: string | null = null;
  private callbacks: HandshakeCallbacks;

  constructor(
    role: Role,
    params: HandshakeParams,
    callbacks: HandshakeCallbacks
  ) {
    this.localRole = role;
    this.localParams = params;
    this.localNonce = makeNonce32();
    this.callbacks = callbacks;
  }

  /**
   * Start the handshake by sending hello
   */
  start() {
    this.callbacks.onLog(`Handshake starting as ${this.localRole}`);
    this.sendHello();
  }

  /**
   * Handle incoming message from peer
   */
  handleIncoming(payload: unknown) {
    if (this.state === 'LOCKED' || this.state === 'ABORTED') {
      return; // Ignore messages after terminal states
    }

    try {
      const msg = parseMessage(payload);
      
      // Ignore our own messages (shouldn't happen with relay, but safety check)
      if (msg.from === this.localRole) {
        return;
      }

      this.callbacks.onLog(`Received ${msg.type} from ${msg.from}`);

      switch (msg.type) {
        case 'hello':
          this.handleHello(msg);
          break;
        case 'hello_ack':
          this.handleHelloAck(msg);
          break;
        case 'abort':
          this.handleAbort(msg);
          break;
        case 'error':
          this.callbacks.onLog(`Peer error: [${msg.payload.code}] ${msg.payload.message}`);
          break;
      }
    } catch (err) {
      this.abort('BAD_MESSAGE', `Failed to parse message: ${err}`);
    }
  }

  private sendHello() {
    const msg: Message = {
      type: 'hello',
      from: this.localRole,
      seq: this.seq++,
      payload: {
        handshake: this.localParams,
        nonce: this.localNonce,
      },
    };

    this.callbacks.onSendMessage(msg);
    this.state = 'SENT_HELLO';
    this.callbacks.onLog('Sent hello');
  }

  private handleHello(msg: Message & { type: 'hello' }) {
    // Store peer's params and nonce
    this.peerParams = msg.payload.handshake;
    this.peerNonce = msg.payload.nonce;
    this.state = 'GOT_PEER_HELLO';

    // Validate params match
    if (!this.validateParamsMatch()) {
      return;
    }

    // Send hello_ack
    this.sendHelloAck();

    // Try to lock session
    this.tryLock();
  }

  private handleHelloAck(msg: Message & { type: 'hello_ack' }) {
    // Store peer params and nonce if not already stored (from hello)
    if (!this.peerParams) {
      this.peerParams = msg.payload.handshake;
    }
    if (!this.peerNonce) {
      this.peerNonce = msg.payload.nonce;
    }

    // Validate params match
    if (!this.validateParamsMatch()) {
      return;
    }

    // Try to lock session
    this.tryLock();
  }

  private handleAbort(msg: Message & { type: 'abort' }) {
    this.state = 'ABORTED';
    this.callbacks.onAbort(msg.payload.code, msg.payload.message);
  }

  private sendHelloAck() {
    const msg: Message = {
      type: 'hello_ack',
      from: this.localRole,
      seq: this.seq++,
      payload: {
        nonce: this.localNonce,
        handshake: this.localParams,
        handshakeHash: hashHandshake(this.localParams),
      },
    };

    this.callbacks.onSendMessage(msg);
    this.state = 'SENT_ACK';
    this.callbacks.onLog('Sent hello_ack');
  }

  private validateParamsMatch(): boolean {
    if (!this.peerParams) {
      return false;
    }

    const localCanonical = canonicalStringify(this.localParams);
    const peerCanonical = canonicalStringify(this.peerParams);

    if (localCanonical !== peerCanonical) {
      this.abort('PROTOCOL_ERROR', 'Handshake params mismatch');
      return false;
    }

    return true;
  }

  private tryLock() {
    // Can only lock if we have all required data
    if (!this.peerParams || !this.peerNonce) {
      return;
    }

    // Already locked?
    if (this.state === 'LOCKED') {
      return;
    }

    // Validate params one more time
    if (!this.validateParamsMatch()) {
      return;
    }

    // Determine nonce order based on role
    let nonceAlice: string;
    let nonceBob: string;

    if (this.localRole === 'alice') {
      nonceAlice = this.localNonce;
      nonceBob = this.peerNonce;
    } else {
      nonceAlice = this.peerNonce;
      nonceBob = this.localNonce;
    }

    // Compute SID
    this.sid = computeSid(this.localParams, nonceAlice, nonceBob);
    this.state = 'LOCKED';
    
    this.callbacks.onLog(`Computed sid=${this.sid}`);
    this.callbacks.onLocked(this.sid);
  }

  private abort(code: string, message: string) {
    if (this.state === 'ABORTED') {
      return;
    }

    const msg: Message = {
      type: 'abort',
      from: this.localRole,
      seq: this.seq++,
      payload: { code: code as 'SID_MISMATCH' | 'BAD_MESSAGE' | 'PROTOCOL_ERROR', message },
    };

    this.callbacks.onSendMessage(msg);
    this.state = 'ABORTED';
    this.callbacks.onAbort(code, message);
  }

  getState(): HandshakeState {
    return this.state;
  }

  getSid(): string | null {
    return this.sid;
  }
}
