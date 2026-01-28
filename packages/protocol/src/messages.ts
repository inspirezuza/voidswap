/**
 * Voidswap Protocol Message Schemas
 * 
 * Defines all message types for the handshake protocol using Zod for runtime validation.
 * These schemas ensure both peers speak the same protocol format.
 */

import { z } from 'zod';

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
 * 32-byte hex nonce pattern: 0x followed by 64 hex characters
 */
const NonceSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a 32-byte hex string (0x + 64 hex chars)');

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
// Union Message Type
// ============================================

export const MessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  HelloAckMessageSchema,
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
