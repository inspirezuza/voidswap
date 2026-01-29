/**
 * Mock ZK Capsule Proof (SP4)
 * 
 * Deterministically generates and verifies mock proofs for timelock capsules.
 */

import { createHash } from 'crypto';
import { canonicalStringify } from './canonical.js';

export interface MockCapsuleInput {
  sid: string;
  role: string;
  refundRound: number;
  yShare: string;
  ct: string;
}

function computeProof(input: MockCapsuleInput): string {
  const canonical = canonicalStringify(input);
  // Proof binds all public inputs + ciphertext
  const hash = createHash('sha256').update(canonical + ':proof').digest('hex');
  return '0x' + hash;
}

/**
 * Generate a mock proof.
 */
export function mockProveCapsule(input: MockCapsuleInput): { proof: string } {
  return { proof: computeProof(input) };
}

/**
 * Verify a mock proof.
 * Recomputes the expected proof and checks equality.
 */
export function mockVerifyCapsule(input: MockCapsuleInput, proof: string): boolean {
  const expected = computeProof(input);
  return expected === proof;
}
