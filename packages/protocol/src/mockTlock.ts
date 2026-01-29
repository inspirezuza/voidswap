/**
 * Mock Timelock Encryption (SP3)
 * 
 * Deterministically generates mock ciphertext for testing binding properties.
 */

import { createHash } from 'crypto';
import { canonicalStringify } from './canonical.js';

export interface MockTlockInput {
  sid: string;
  role: string;
  refundRound: number;
  yShare: string;
}

/**
 * Generate deterministic mock ciphertext.
 * Any change to input params changes the ciphertext.
 */
export function mockTlockEncrypt(input: MockTlockInput): { ct: string } {
  const canonical = canonicalStringify(input);
  const hash = createHash('sha256').update(canonical + ':ciphertext').digest('hex');
  
  // Return mock CT (just a hash)
  return { ct: '0x' + hash };
}
