/**
 * Execution Templates Tests
 * 
 * Tests for deterministic transaction template building and digest computation.
 */

import { describe, it, expect } from 'vitest';
import { buildExecutionTemplates, type ExecutionTemplateInput } from '../src/executionTemplates.js';

describe('Execution Templates', () => {

    const sampleInput: ExecutionTemplateInput = {
        chainId: 31337,
        targets: {
            targetAlice: '0x1111111111111111111111111111111111111111',
            targetBob: '0x2222222222222222222222222222222222222222',
        },
        mpcs: {
            mpcAlice: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            mpcBob: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        },
        values: {
            vAWei: '1000000000000000000', // 1 ETH
            vBWei: '2000000000000000000', // 2 ETH
        },
        nonces: {
            mpcAliceNonce: '5',
            mpcBobNonce: '3',
        },
        fee: {
            maxFeePerGasWei: '20000000000',    // 20 gwei
            maxPriorityFeePerGasWei: '1000000000', // 1 gwei
            gasLimit: '21000',
        },
    };

    it('should produce identical digests for same inputs', () => {
        const result1 = buildExecutionTemplates(sampleInput);
        const result2 = buildExecutionTemplates(sampleInput);

        expect(result1.digestA).toBe(result2.digestA);
        expect(result1.digestB).toBe(result2.digestB);
    });

    it('should produce different digestA when mpcAliceNonce changes', () => {
        const result1 = buildExecutionTemplates(sampleInput);
        const modifiedInput = {
            ...sampleInput,
            nonces: { ...sampleInput.nonces, mpcAliceNonce: '10' },
        };
        const result2 = buildExecutionTemplates(modifiedInput);

        expect(result1.digestA).not.toBe(result2.digestA);
        // digestB should remain the same since mpcBobNonce didn't change
        expect(result1.digestB).toBe(result2.digestB);
    });

    it('should produce different digestB when mpcBobNonce changes', () => {
        const result1 = buildExecutionTemplates(sampleInput);
        const modifiedInput = {
            ...sampleInput,
            nonces: { ...sampleInput.nonces, mpcBobNonce: '10' },
        };
        const result2 = buildExecutionTemplates(modifiedInput);

        // digestA should remain the same since mpcAliceNonce didn't change
        expect(result1.digestA).toBe(result2.digestA);
        expect(result1.digestB).not.toBe(result2.digestB);
    });

    it('should produce different digests when fee params change', () => {
        const result1 = buildExecutionTemplates(sampleInput);
        const modifiedInput = {
            ...sampleInput,
            fee: { ...sampleInput.fee, maxFeePerGasWei: '30000000000' },
        };
        const result2 = buildExecutionTemplates(modifiedInput);

        expect(result1.digestA).not.toBe(result2.digestA);
        expect(result1.digestB).not.toBe(result2.digestB);
    });

    it('should build valid tx_A: mpcAlice -> targetBob', () => {
        const result = buildExecutionTemplates(sampleInput);
        
        expect(result.txA.to).toBe(sampleInput.targets.targetBob.toLowerCase());
        expect(result.txA.value).toBe(BigInt(sampleInput.values.vAWei));
        expect(result.txA.nonce).toBe(Number(sampleInput.nonces.mpcAliceNonce));
    });

    it('should build valid tx_B: mpcBob -> targetAlice', () => {
        const result = buildExecutionTemplates(sampleInput);
        
        expect(result.txB.to).toBe(sampleInput.targets.targetAlice.toLowerCase());
        expect(result.txB.value).toBe(BigInt(sampleInput.values.vBWei));
        expect(result.txB.nonce).toBe(Number(sampleInput.nonces.mpcBobNonce));
    });

    it('should produce 32-byte hex digests', () => {
        const result = buildExecutionTemplates(sampleInput);
        
        expect(result.digestA).toMatch(/^0x[a-f0-9]{64}$/);
        expect(result.digestB).toMatch(/^0x[a-f0-9]{64}$/);
    });
});
