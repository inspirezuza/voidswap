/**
 * Voidswap Protocol Message Schemas
 * 
 * Defines all message types for the handshake protocol using Zod for runtime validation.
 * These schemas ensure both peers speak the same protocol format.
 */

import { z } from 'zod';
import { Hex32Schema } from './hex.js';

// ============================================
// Handshake Parameters
// ============================================

/**
 * Decimal string pattern: one or more digits, no leading "+" or zeros (except "0" itself)
 */
const DecimalStringSchema = z.string().regex(/^\d+$/, 'Must be a decimal string (digits only)');

/**
 * Ethereum address pattern: 0x followed by 40 hex characters
 */
const EthAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address');

/**
 * 32-byte hex nonce: 0x + 64 lowercase hex chars
 * Uses Hex32Schema from hex.ts for strict validation
 */
const NonceSchema = Hex32Schema;

/**
 * HandshakeParams defines the core parameters for a voidswap session.
 * Both Alice and Bob must agree on these values for the SID to match.
 */
export const HandshakeParamsSchema = z.object({
  /** Protocol version identifier */
  version: z.literal('voidswap-v1'),
  
  /** Blockchain chain ID (e.g., 1 for Ethereum mainnet) */
  chainId: z.number().int(),
  
  /** Drand chain identifier for timelock encryption */
  drandChainId: z.string(),
  
  /** Alice's value in the smallest unit (decimal string) */
  vA: DecimalStringSchema,
  
  /** Bob's value in the smallest unit (decimal string) */
  vB: DecimalStringSchema,
  
  /** Alice's destination address */
  targetAlice: EthAddressSchema,
  
  /** Bob's destination address */
  targetBob: EthAddressSchema,
  
  /** Drand round for Bob's refund window */
  rBRefund: z.number().int().nonnegative(),
  
  /** Drand round for Alice's refund window */
  rARefund: z.number().int().nonnegative(),
});

export type HandshakeParams = z.infer<typeof HandshakeParamsSchema>;

/**
 * Validate that refund order is correct: rBRefund < rARefund
 * This is a policy check, not enforced at schema level.
 */
export function validateRefundOrder(params: HandshakeParams): boolean {
  return params.rBRefund < params.rARefund;
}

// ============================================
// Message Envelope
// ============================================

const RoleSchema = z.enum(['alice', 'bob']);

// Base message fields shared by all message types
const BaseMessageSchema = z.object({
  from: RoleSchema,
  seq: z.number().int().nonnegative(),
  sid: z.string().optional(),
});

// ============================================
// Hello Message
// ============================================

export const HelloPayloadSchema = z.object({
  handshake: HandshakeParamsSchema,
  nonce: NonceSchema,
});

export const HelloMessageSchema = BaseMessageSchema.extend({
  type: z.literal('hello'),
  payload: HelloPayloadSchema,
});

export type HelloMessage = z.infer<typeof HelloMessageSchema>;

// ============================================
// HelloAck Message
// ============================================

export const HelloAckPayloadSchema = z.object({
  nonce: NonceSchema,
  /** Include handshake params so both sides can lock even if one misses the initial hello */
  handshake: HandshakeParamsSchema,
  /** Optional SHA-256 of canonical handshake params for debugging */
  handshakeHash: z.string().optional(),
});

export const HelloAckMessageSchema = BaseMessageSchema.extend({
  type: z.literal('hello_ack'),
  payload: HelloAckPayloadSchema,
});

export type HelloAckMessage = z.infer<typeof HelloAckMessageSchema>;

// ============================================
// Abort Message
// ============================================

export const AbortCodeSchema = z.enum(['SID_MISMATCH', 'BAD_MESSAGE', 'PROTOCOL_ERROR']);

export const AbortPayloadSchema = z.object({
  code: AbortCodeSchema,
  message: z.string(),
});

export const AbortMessageSchema = BaseMessageSchema.extend({
  type: z.literal('abort'),
  payload: AbortPayloadSchema,
});

export type AbortMessage = z.infer<typeof AbortMessageSchema>;

// ============================================
// Error Message (protocol-level)
// ============================================

export const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const ErrorMessageSchema = BaseMessageSchema.extend({
  type: z.literal('error'),
  payload: ErrorPayloadSchema,
});

export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

// ============================================
// Keygen Announce Message
// ============================================

export const KeygenAddressSchema = EthAddressSchema;
// Mock commitment: 33 bytes (compressed pubkey) in hex
export const KeygenCommitmentSchema = z.string().regex(/^0x[0-9a-fA-F]{66}$/, 'Must be a valid 33-byte hex commitment');

export const MpcResultSchema = z.object({
  address: KeygenAddressSchema,
  commitments: z.object({
    local: KeygenCommitmentSchema,
    peer: KeygenCommitmentSchema,
  }),
});

export type MpcResult = z.infer<typeof MpcResultSchema>;

export const KeygenAnnouncePayloadSchema = z.object({
  mpcAlice: MpcResultSchema.optional(),
  mpcBob: MpcResultSchema.optional(),
  note: z.string().optional(),
});

export const KeygenAnnounceMessageSchema = BaseMessageSchema.extend({
  type: z.literal('keygen_announce'),
  // SID is strictly required for this message type
  sid: z.string(),
  payload: KeygenAnnouncePayloadSchema,
});

export type KeygenAnnounceMessage = z.infer<typeof KeygenAnnounceMessageSchema>;

// ============================================
// Capsule Offer Message (Mock SP3/SP4)
// ============================================

export const CapsuleRoleSchema = z.enum(['refund_mpc_Alice', 'refund_mpc_Bob']);

// Mock yShare: 33 bytes (compressed pubkey) in hex
export const YShareSchema = z.string().regex(/^0x[0-9a-fA-F]{66}$/, 'Must be a valid 33-byte hex yShare');
// Mock Ciphertext/Proof: hex string >= 1 byte
export const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]{2,}$/, 'Must be a valid hex string');

export const CapsuleOfferPayloadSchema = z.object({
  role: CapsuleRoleSchema,
  refundRound: z.number().int().nonnegative(),
  yShare: YShareSchema,
  ct: HexStringSchema,
  proof: HexStringSchema,
});

export const CapsuleOfferMessageSchema = BaseMessageSchema.extend({
  type: z.literal('capsule_offer'),
  sid: z.string(), // Required
  payload: CapsuleOfferPayloadSchema,
});

export type CapsuleOfferMessage = z.infer<typeof CapsuleOfferMessageSchema>;

// ============================================
// Capsule Ack Message
// ============================================

export const CapsuleAckPayloadSchema = z.object({
  role: CapsuleRoleSchema,
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const CapsuleAckMessageSchema = BaseMessageSchema.extend({
  type: z.literal('capsule_ack'),
  sid: z.string(), // Required
  payload: CapsuleAckPayloadSchema,
});

export type CapsuleAckMessage = z.infer<typeof CapsuleAckMessageSchema>;

// ============================================
// Funding Tx Message
// ============================================

export const FundingTxPayloadSchema = z.object({
  which: z.enum(['mpc_Alice', 'mpc_Bob']),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a valid 32-byte hex tx hash'),
  fromAddress: EthAddressSchema,
  toAddress: EthAddressSchema,
  valueWei: DecimalStringSchema,
});

export type FundingTxPayload = z.infer<typeof FundingTxPayloadSchema>;

export const FundingTxMessageSchema = BaseMessageSchema.extend({
  type: z.literal('funding_tx'),
  sid: z.string(), // Required
  payload: FundingTxPayloadSchema,
});

export type FundingTxMessage = z.infer<typeof FundingTxMessageSchema>;

// ============================================
// Nonce Report Message (EXEC_PREP)
// ============================================

export const NonceReportPayloadSchema = z.object({
  mpcAliceNonce: DecimalStringSchema,
  mpcBobNonce: DecimalStringSchema,
  blockNumber: DecimalStringSchema,
  rpcTag: z.enum(['latest', 'pending']).optional().default('latest'),
});

export type NonceReportPayload = z.infer<typeof NonceReportPayloadSchema>;

export const NonceReportMessageSchema = BaseMessageSchema.extend({
  type: z.literal('nonce_report'),
  sid: z.string(), // Required
  payload: NonceReportPayloadSchema,
});

export type NonceReportMessage = z.infer<typeof NonceReportMessageSchema>;

// ============================================
// Fee Params Message (EXEC_PREP - Alice proposes)
// ============================================

export const FeeParamsPayloadSchema = z.object({
  maxFeePerGasWei: DecimalStringSchema,
  maxPriorityFeePerGasWei: DecimalStringSchema,
  gasLimit: DecimalStringSchema,
  mode: z.literal('fixed'), // PoC only supports fixed mode
  proposer: z.literal('alice'), // PoC only Alice proposes
});

export type FeeParamsPayload = z.infer<typeof FeeParamsPayloadSchema>;

export const FeeParamsMessageSchema = BaseMessageSchema.extend({
  type: z.literal('fee_params'),
  sid: z.string(), // Required
  payload: FeeParamsPayloadSchema,
});

export type FeeParamsMessage = z.infer<typeof FeeParamsMessageSchema>;

// ============================================
// Fee Params Ack Message (EXEC_PREP - Bob acks)
// ============================================

export const FeeParamsAckPayloadSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  feeParamsHash: z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char hex hash'),
});

export type FeeParamsAckPayload = z.infer<typeof FeeParamsAckPayloadSchema>;

export const FeeParamsAckMessageSchema = BaseMessageSchema.extend({
  type: z.literal('fee_params_ack'),
  sid: z.string(), // Required
  payload: FeeParamsAckPayloadSchema,
});

export type FeeParamsAckMessage = z.infer<typeof FeeParamsAckMessageSchema>;

// ============================================
// Tx Template Commit Message (EXEC_TEMPLATES_SYNC)
// ============================================

const DigestHex64Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a 32-byte hex digest');
const CommitHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char lowercase hex hash');

export const TxTemplateCommitPayloadSchema = z.object({
  digestA: DigestHex64Schema,
  digestB: DigestHex64Schema,
  commitHash: CommitHashSchema,
  note: z.string().optional(),
});

export type TxTemplateCommitPayload = z.infer<typeof TxTemplateCommitPayloadSchema>;

export const TxTemplateCommitMessageSchema = BaseMessageSchema.extend({
  type: z.literal('tx_template_commit'),
  sid: z.string(), // Required
  payload: TxTemplateCommitPayloadSchema,
});

export type TxTemplateCommitMessage = z.infer<typeof TxTemplateCommitMessageSchema>;

// ============================================
// Tx Template Ack Message (EXEC_TEMPLATES_SYNC)
// ============================================

export const TxTemplateAckPayloadSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  commitHash: CommitHashSchema, // Must match peer's commit hash
});

export type TxTemplateAckPayload = z.infer<typeof TxTemplateAckPayloadSchema>;

export const TxTemplateAckMessageSchema = BaseMessageSchema.extend({
  type: z.literal('tx_template_ack'),
  sid: z.string(), // Required
  payload: TxTemplateAckPayloadSchema,
});

export type TxTemplateAckMessage = z.infer<typeof TxTemplateAckMessageSchema>;

// ============================================
// Union Message Type
// ============================================

export const MessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  HelloAckMessageSchema,
  KeygenAnnounceMessageSchema,
  CapsuleOfferMessageSchema,
  CapsuleAckMessageSchema,
  FundingTxMessageSchema,
  NonceReportMessageSchema,
  FeeParamsMessageSchema,
  FeeParamsAckMessageSchema,
  TxTemplateCommitMessageSchema,
  TxTemplateAckMessageSchema,
  AbortMessageSchema,
  ErrorMessageSchema,
]);

export type Message = z.infer<typeof MessageSchema>;

/**
 * Parse and validate a JSON value as a protocol message.
 * Throws ZodError if validation fails.
 */
export function parseMessage(json: unknown): Message {
  return MessageSchema.parse(json);
}

// Re-export types for convenience
export type Role = z.infer<typeof RoleSchema>;
export type AbortCode = z.infer<typeof AbortCodeSchema>;

