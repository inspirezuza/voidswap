import type { ClientMessage, JoinMessage, MsgMessage } from './types.js';

// Max message size: 64KB
export const MAX_MESSAGE_SIZE = 64 * 1024;

// Room name pattern: 1-64 chars, alphanumeric + underscore + hyphen
const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate room name format
 */
export function isValidRoom(room: unknown): room is string {
  return typeof room === 'string' && ROOM_PATTERN.test(room);
}

/**
 * Parse and validate incoming message
 */
export function parseMessage(data: string): ClientMessage | null {
  try {
    const msg = JSON.parse(data) as Record<string, unknown>;
    
    if (typeof msg !== 'object' || msg === null) {
      return null;
    }

    if (msg.type === 'join') {
      if (isValidRoom(msg.room)) {
        return msg as JoinMessage;
      }
      return null;
    }

    if (msg.type === 'msg') {
      if (isValidRoom(msg.room) && 'payload' in msg) {
        return msg as MsgMessage;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if message size exceeds limit
 */
export function isMessageTooLarge(data: string): boolean {
  return Buffer.byteLength(data, 'utf8') > MAX_MESSAGE_SIZE;
}
