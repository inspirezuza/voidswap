/**
 * Session ID (SID) Computation
 * 
 * The SID uniquely identifies a voidswap session. It is computed from:
 * - Handshake parameters (agreed upon by both parties)
 * - Alice's nonce (random, contributed by Alice)
 * - Bob's nonce (random, contributed by Bob)
 * 
 * By including both nonces, neither party can predict or control the SID alone.
 * The canonical serialization ensures both parties compute identical SIDs.
 */

import { createHash } from 'crypto';
import { canonicalStringify } from './canonical.js';
import { assertHex32 } from './hex.js';
import type { HandshakeParams } from './messages.js';

/**
 * Compute SHA-256 hash of a string, returning lowercase hex (64 chars).
 */
function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Compute the Session ID from handshake parameters and both parties' nonces.
 * 
 * @param params - Agreed handshake parameters
 * @param nonceAlice - Alice's 32-byte hex nonce (0x + 64 lowercase hex chars)
 * @param nonceBob - Bob's 32-byte hex nonce (0x + 64 lowercase hex chars)
 * @returns 64-character lowercase hex string (no 0x prefix)
 * @throws Error if nonces are not valid 32-byte lowercase hex
 */
export function computeSid(
  params: HandshakeParams,
  nonceAlice: string,
  nonceBob: string
): string {
  // Validate nonces are proper 32-byte lowercase hex
  assertHex32('nonceAlice', nonceAlice);
  assertHex32('nonceBob', nonceBob);

  const sidInput = {
    version: 'voidswap-sid-v1',
    handshake: params,
    nonceAlice,
    nonceBob,
  };

  const canonical = canonicalStringify(sidInput);
  return sha256Hex(canonical);
}

/**
 * Compute SHA-256 hash of canonical handshake parameters.
 * Useful for quick comparison and debugging.
 * 
 * @param params - Handshake parameters
 * @returns 64-character lowercase hex string (no 0x prefix)
 */
export function hashHandshake(params: HandshakeParams): string {
  const canonical = canonicalStringify(params);
  return sha256Hex(canonical);
}
