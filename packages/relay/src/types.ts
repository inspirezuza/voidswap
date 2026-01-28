import type { WebSocket } from 'ws';

// ============================================
// Client -> Relay Messages
// ============================================

export interface JoinMessage {
  type: 'join';
  room: string;
}

export interface MsgMessage {
  type: 'msg';
  room: string;
  payload: unknown;
}

export type ClientMessage = JoinMessage | MsgMessage;

// ============================================
// Relay -> Client Messages
// ============================================

export interface JoinedResponse {
  type: 'joined';
  room: string;
  clientId: string;
}

export interface MsgBroadcast {
  type: 'msg';
  room: string;
  from: string;
  payload: unknown;
}

export type ErrorCode = 'NOT_JOINED' | 'BAD_ROOM' | 'BAD_MSG' | 'TOO_LARGE';

export interface ErrorResponse {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage = JoinedResponse | MsgBroadcast | ErrorResponse;

// ============================================
// Client State
// ============================================

export interface ClientState {
  clientId: string;
  joinedRoom: string | null;
}

// Extended WebSocket with state
export interface ExtendedWebSocket extends WebSocket {
  state: ClientState;
}
