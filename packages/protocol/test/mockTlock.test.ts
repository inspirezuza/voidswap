/**
 * Mock Tlock Determinism Tests
 * 
 * Verifies that mock tlock encryption/verification produces deterministic outputs
 * and that verification correctly accepts/rejects proofs.
 */

import { describe, it, expect } from 'vitest';
import { mockTlockEncrypt, mockVerifyCapsule } from '../src/mockTlock.js';

describe('mockTlock Determinism', () => {
    const sampleInput = {
        sid: 'test-sid-12345',
        role: 'refund_mpc_Alice' as const,
        refundRound: 1000,
        yShare: '0x02abcd1234567890'
    };

    it('same input produces same ct/proof', () => {
        const result1 = mockTlockEncrypt(sampleInput);
        const result2 = mockTlockEncrypt(sampleInput);
        
        expect(result1.ct).toBe(result2.ct);
        expect(result1.proof).toBe(result2.proof);
    });

    it('different sid produces different ct/proof', () => {
        const result1 = mockTlockEncrypt(sampleInput);
        const result2 = mockTlockEncrypt({ ...sampleInput, sid: 'different-sid' });
        
        expect(result1.ct).not.toBe(result2.ct);
        expect(result1.proof).not.toBe(result2.proof);
    });

    it('different role produces different ct/proof', () => {
        const result1 = mockTlockEncrypt(sampleInput);
        const result2 = mockTlockEncrypt({ ...sampleInput, role: 'refund_mpc_Bob' });
        
        expect(result1.ct).not.toBe(result2.ct);
        expect(result1.proof).not.toBe(result2.proof);
    });

    it('different refundRound produces different ct/proof', () => {
        const result1 = mockTlockEncrypt(sampleInput);
        const result2 = mockTlockEncrypt({ ...sampleInput, refundRound: 2000 });
        
        expect(result1.ct).not.toBe(result2.ct);
        expect(result1.proof).not.toBe(result2.proof);
    });

    it('different yShare produces different ct/proof', () => {
        const result1 = mockTlockEncrypt(sampleInput);
        const result2 = mockTlockEncrypt({ ...sampleInput, yShare: '0x02deadbeef' });
        
        expect(result1.ct).not.toBe(result2.ct);
        expect(result1.proof).not.toBe(result2.proof);
    });

    it('ct and proof have 0x prefix and are hex', () => {
        const result = mockTlockEncrypt(sampleInput);
        
        expect(result.ct).toMatch(/^0x[0-9a-f]{64}$/);
        expect(result.proof).toMatch(/^0x[0-9a-f]{64}$/);
    });
});

describe('mockVerifyCapsule', () => {
    const sampleInput = {
        sid: 'test-sid-12345',
        role: 'refund_mpc_Alice' as const,
        refundRound: 1000,
        yShare: '0x02abcd1234567890'
    };

    it('returns true for correct proof', () => {
        const { ct, proof } = mockTlockEncrypt(sampleInput);
        const result = mockVerifyCapsule({ ...sampleInput, ct }, proof);
        
        expect(result).toBe(true);
    });

    it('returns false for tampered proof', () => {
        const { ct, proof } = mockTlockEncrypt(sampleInput);
        const tamperedProof = proof.slice(0, -2) + 'ff'; // Change last byte
        
        const result = mockVerifyCapsule({ ...sampleInput, ct }, tamperedProof);
        
        expect(result).toBe(false);
    });

    it('returns false for different sid', () => {
        const { ct, proof } = mockTlockEncrypt(sampleInput);
        
        const result = mockVerifyCapsule({ ...sampleInput, sid: 'wrong-sid', ct }, proof);
        
        expect(result).toBe(false);
    });

    it('returns false for different role', () => {
        const { ct, proof } = mockTlockEncrypt(sampleInput);
        
        const result = mockVerifyCapsule({ ...sampleInput, role: 'refund_mpc_Bob', ct }, proof);
        
        expect(result).toBe(false);
    });
});
