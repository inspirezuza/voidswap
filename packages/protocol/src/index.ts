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

// Handshake runtime
export {
  createHandshakeRuntime,
  type HandshakeRuntime,
  type HandshakeRuntimeOptions,
  type HandshakeState,
  type RuntimeEvent,
} from './handshakeRuntime.js';

// Keygen helpers
export { mockKeygen, mockYShare } from './mockKeygen.js';

// Session runtime (Handshake + Keygen + Capsules)
export {
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeOptions,
  type SessionState,
  type SessionEvent,
} from './sessionRuntime.js';

export {
  type MpcResult,
  type KeygenAnnounceMessage,
  type CapsuleOfferMessage,
  type CapsuleAckMessage,
  type FundingTxMessage,
  type FundingTxPayload,
  type NonceReportMessage,
  type NonceReportPayload,
  type FeeParamsMessage,
  type FeeParamsPayload,
  type FeeParamsAckMessage,
  type FeeParamsAckPayload,
} from './messages.js';

// Mock Crypto (for testing or advanced usage)
export { mockTlockEncrypt } from './mockTlock.js';
export { mockProveCapsule, mockVerifyCapsule } from './mockZkCapsule.js';

// Execution Templates
export {
  buildExecutionTemplates,
  type FeeParams,
  type Nonces,
  type TxTemplateResult,
  type ExecutionTemplateInput,
  type UnsignedEip1559Tx,
} from './executionTemplates.js';
