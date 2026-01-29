/**
 * Mock Keygen Utility (Updated for Capsule Exchange)
 * 
 * Deterministically generates mock MPC addresses AND yShare commitments.
 */

import { createHash } from 'crypto';
import type { Role, MpcResult } from './messages.js';

/**
 * Generate a determinstic mock MPC result for a given role and SID.
 */
export function mockKeygen(sid: string, targetRole: Role): MpcResult {
  // Helper to generate deterministic hex string
  function deriveHex(discriminator: string, length: number): string {
    const hash = createHash('sha256')
      .update(`${sid}:${targetRole}:${discriminator}`)
      .digest('hex');
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

/**
 * Generate a deterministic yShare commitment for Capsule Exchange.
 * 
 * yShare is the public key share that the capsule is encrypted against.
 * 
 * which: 
 * - 'Y_Ab': Bob's share of MPC_Alice (Alice holds key, Bob verifies) - Wait, protocol logic:
 *   Refund MPC for Alice (mpc_Alice) is controlled by Alice + Bob.
 *   If protocol aborts, Bob sends capsule to Alice.
 *   Capsule encrypts "Bob's share secret" towards "Alice's share pubkey"? 
 *   No, usually capsule is encrypted towards a public key.
 *   
 *   Let's keep it abstract:
 *   mockYShare(sid, "refund_mpc_Alice") -> returns the Y share relevant for refunding Alice.
 */
export function mockYShare(sid: string, purpose: 'refund_mpc_Alice' | 'refund_mpc_Bob'): string {
   const hash = createHash('sha256')
     .update(`${sid}:yShare:${purpose}`)
     .digest('hex');
   // Extend to 66 chars
   const hash2 = createHash('sha256').update(hash).digest('hex');
   return '0x' + (hash + hash2).substring(0, 66);
}
