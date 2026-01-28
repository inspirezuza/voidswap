/**
 * WebSocket Transport Layer
 * 
 * Handles connection to the relay server, joining rooms,
 * and sending/receiving peer messages.
 */

import WebSocket from 'ws';

export interface RelayJoinedMessage {
  type: 'joined';
  room: string;
  clientId: string;
}

export interface RelayMsgMessage {
  type: 'msg';
  room: string;
  from: string;
  payload: unknown;
}

export interface RelayErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

type RelayMessage = RelayJoinedMessage | RelayMsgMessage | RelayErrorMessage;

export interface TransportCallbacks {
  onJoined: (clientId: string) => void;
  onPeerPayload: (payload: unknown) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export class Transport {
  private ws: WebSocket;
  private room: string;
  private callbacks: TransportCallbacks;
  private clientId: string | null = null;

  constructor(relayUrl: string, room: string, callbacks: TransportCallbacks) {
    this.room = room;
    this.callbacks = callbacks;
    this.ws = new WebSocket(relayUrl);

    this.ws.on('open', () => this.handleOpen());
    this.ws.on('message', (data) => this.handleMessage(data.toString()));
    this.ws.on('error', (err) => this.callbacks.onError(err));
    this.ws.on('close', () => this.callbacks.onClose());
  }

  private handleOpen() {
    // Join the room
    const joinMsg = { type: 'join', room: this.room };
    this.ws.send(JSON.stringify(joinMsg));
  }

  private handleMessage(data: string) {
    try {
      const msg = JSON.parse(data) as RelayMessage;

      switch (msg.type) {
        case 'joined':
          this.clientId = msg.clientId;
          this.callbacks.onJoined(msg.clientId);
          break;

        case 'msg':
          // Forward payload to handler
          this.callbacks.onPeerPayload(msg.payload);
          break;

        case 'error':
          this.callbacks.onError(new Error(`Relay error [${msg.code}]: ${msg.message}`));
          break;
      }
    } catch (err) {
      this.callbacks.onError(new Error(`Failed to parse relay message: ${err}`));
    }
  }

  /**
   * Send a payload to all peers in the room
   */
  sendPayload(payload: unknown) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    const msg = {
      type: 'msg',
      room: this.room,
      payload,
    };

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Close the connection
   */
  close() {
    this.ws.close();
  }

  /**
   * Get the client ID assigned by the relay
   */
  getClientId(): string | null {
    return this.clientId;
  }
}
