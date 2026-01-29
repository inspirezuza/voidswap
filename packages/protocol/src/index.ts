/**
 * Voidswap Protocol Package
 * 
 * Exports all public APIs for protocol message handling, canonical serialization,
 * SID computation, and transcript management.
 */

// Message schemas and types
export {
  HandshakeParamsSchema,
  HelloMessageSchema,
  HelloAckMessageSchema,
  AbortMessageSchema,
  ErrorMessageSchema,
  MessageSchema,
  parseMessage,
  validateRefundOrder,
  type HandshakeParams,
  type HelloMessage,
  type HelloAckMessage,
  type AbortMessage,
  type ErrorMessage,
  type Message,
  type Role,
  type AbortCode,
} from './messages.js';

// Canonical serialization
export {
  canonicalize,
  canonicalStringify,
} from './canonical.js';

// SID computation
export {
  computeSid,
  hashHandshake,
} from './sid.js';

// Hex validation
export {
  isHexPrefixed,
  assertHex32,
  Hex32Schema,
  type Hex32,
} from './hex.js';

// Transcript helpers
export {
  appendRecord,
  transcriptHash,
  type TranscriptRecord,
} from './transcript.js';
