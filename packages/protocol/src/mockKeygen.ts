/**
 * Mock Keygen Utility
 * 
 * Deterministically generates mock MPC addresses and commitments based on the session ID.
 * This simulates a real MPC keygen process for protocol testing purposes.
 */

import { createHash } from 'crypto';
import type { Role, MpcResult } from './messages.js';

/**
 * Generate a determinstic mock MPC result for a given role and SID.
 * 
 * The output depends on ANY change to SID, ensuring that different sessions
 * yield different addresses/keys.
 */
export function mockKeygen(sid: string, targetRole: Role): MpcResult {
  // Helper to generate deterministic hex string
  function deriveHex(discriminator: string, length: number): string {
    const hash = createHash('sha256')
      .update(`${sid}:${targetRole}:${discriminator}`)
      .digest('hex');
    // Ensure we fill the requested length (repeat hash if needed, but for now 64 chars is enough for 40/66)
    // Actually valid addresses are 40 chars, commitments 66.
    // SHA256 is 64 chars (32 bytes).
    // Let's chain hashes for longer strings if needed, or just use simpler logic since it's a mock.
    
    // For 33 byte commitment (66 hex chars), we need more than one SHA256 (64 hex).
    // Let's just extend it.
    const hash2 = createHash('sha256').update(hash).digest('hex');
    return (hash + hash2).substring(0, length);
  }

  return {
    // 0x + 40 hex chars
    address: '0x' + deriveHex('address', 40),
    commitments: {
      // 0x + 66 hex chars (33 bytes)
      local: '0x' + deriveHex('comm_local', 66),
      peer: '0x' + deriveHex('comm_peer', 66),
    },
  };
}
