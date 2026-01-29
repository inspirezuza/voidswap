/**
 * Hex Validation Utilities
 * 
 * Provides strict validation for 32-byte hex nonces used in the protocol.
 * Nonces must be:
 * - 0x-prefixed
 * - Lowercase hex only (0-9a-f)
 * - Exactly 32 bytes (64 hex chars, 66 total with prefix)
 */

import { z } from 'zod';

/**
 * Regex for valid 32-byte hex string: 0x + 64 lowercase hex chars
 */
const HEX32_REGEX = /^0x[0-9a-f]{64}$/;

/**
 * Check if a string starts with 0x prefix
 */
export function isHexPrefixed(s: string): boolean {
  return s.startsWith('0x') || s.startsWith('0X');
}

/**
 * Assert that a string is a valid 32-byte hex value.
 * Throws with a descriptive error if validation fails.
 * 
 * @param name - Name of the field (for error messages)
 * @param value - The value to validate
 */
export function assertHex32(name: string, value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string, got ${typeof value}`);
  }

  if (!isHexPrefixed(value)) {
    throw new Error(`${name} must start with 0x prefix`);
  }

  if (value.length !== 66) {
    const actualBytes = (value.length - 2) / 2;
    throw new Error(
      `${name} must be exactly 32 bytes (0x + 64 hex chars), got ${actualBytes} bytes`
    );
  }

  if (!HEX32_REGEX.test(value)) {
    throw new Error(
      `${name} must be lowercase hex (0-9a-f) only, got: ${value.slice(0, 20)}...`
    );
  }
}

/**
 * Zod schema for 32-byte hex nonce.
 * Use this in message schemas for automatic validation.
 */
export const Hex32Schema = z
  .string()
  .length(66, 'Nonce must be exactly 66 characters (0x + 64 hex chars)')
  .regex(HEX32_REGEX, 'Nonce must be 0x + 64 lowercase hex chars (32 bytes)');

/**
 * Type alias for a validated 32-byte hex string
 */
export type Hex32 = z.infer<typeof Hex32Schema>;
