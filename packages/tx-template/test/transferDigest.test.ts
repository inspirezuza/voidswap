/**
 * Transfer Digest Tests
 * 
 * Tests that verify the signing digest is computed correctly by:
 * 1. Signing a transaction with viem
 * 2. Recovering the signer from our computed digest + signature
 * 3. Asserting recovered address matches expected
 */

import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, recoverAddress } from 'viem';
import {
    buildEip1559TransferTx,
    serializeUnsignedEip1559,
    signingDigestEip1559,
    Eip1559TransferTemplateSchema,
} from '../src/index.js';

// Test private key (anvil account 0)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

describe('Transfer Digest', () => {

    it('should compute correct digest recoverable by signature', async () => {
        // 1. Create account from known private key
        const account = privateKeyToAccount(TEST_PRIVATE_KEY);
        
        // 2. Build transaction
        const tx = buildEip1559TransferTx({
            chainId: 31337, // anvil chain id
            nonce: 0n,
            to: TEST_RECIPIENT,
            valueWei: 1000000000000000000n, // 1 ETH
            gas: 21000n,
            maxFeePerGas: 1_000_000_000n, // 1 gwei
            maxPriorityFeePerGas: 1_000_000_000n,
        });
        
        // 3. Compute our digest
        const digest = signingDigestEip1559(tx);
        expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
        
        // 4. Sign transaction with viem
        const signedSerialized = await account.signTransaction(tx);
        
        // 5. Parse signed transaction to extract signature
        const parsed = parseTransaction(signedSerialized);
        
        // Extract signature components
        const r = parsed.r;
        const s = parsed.s;
        // viem uses yParity for EIP-1559
        const yParity = parsed.yParity;
        
        expect(r).toBeDefined();
        expect(s).toBeDefined();
        expect(yParity).toBeDefined();
        
        // 6. Recover address from our digest + signature
        const recovered = await recoverAddress({
            hash: digest,
            signature: { r: r!, s: s!, yParity: yParity! },
        });
        
        // 7. Assert recovered address matches account
        expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    });

    it('should produce serialization starting with 0x02', () => {
        const tx = buildEip1559TransferTx({
            chainId: 1,
            nonce: 0n,
            to: TEST_RECIPIENT,
            valueWei: 0n,
            gas: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
        });
        
        const serialized = serializeUnsignedEip1559(tx);
        expect(serialized.startsWith('0x02')).toBe(true);
    });

    it('should have correct tx invariants', () => {
        const tx = buildEip1559TransferTx({
            chainId: 1,
            nonce: 5n,
            to: TEST_RECIPIENT,
            valueWei: 1000n,
            gas: 21000n,
            maxFeePerGas: 100n,
            maxPriorityFeePerGas: 50n,
        });
        
        expect(tx.type).toBe('eip1559');
        expect(tx.data).toBe('0x');
        expect(tx.accessList).toEqual([]);
        expect(tx.nonce).toBe(5);
        expect(tx.value).toBe(1000n);
    });

    it('should reject invalid address', () => {
        expect(() => {
            Eip1559TransferTemplateSchema.parse({
                chainId: 1,
                nonce: 0n,
                to: 'not-an-address',
                valueWei: 0n,
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n,
            });
        }).toThrow();
    });

    it('should reject negative nonce', () => {
        expect(() => {
            Eip1559TransferTemplateSchema.parse({
                chainId: 1,
                nonce: -1n,
                to: TEST_RECIPIENT,
                valueWei: 0n,
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n,
            });
        }).toThrow();
    });

    it('should reject uppercase address and normalize', () => {
        const upperAddr = '0x70997970C51812DC3A010C7D01B50E0D17DC79C8';
        
        // Schema should reject uppercase
        expect(() => {
            Eip1559TransferTemplateSchema.parse({
                chainId: 1,
                nonce: 0n,
                to: upperAddr,
                valueWei: 0n,
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n,
            });
        }).toThrow();
    });

    it('should use default gas of 21000', () => {
        const tx = buildEip1559TransferTx({
            chainId: 1,
            nonce: 0n,
            to: TEST_RECIPIENT,
            valueWei: 0n,
            // gas not provided
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
        });
        
        expect(tx.gas).toBe(21000n);
    });

    it('should produce same digest for same inputs', () => {
        const template = {
            chainId: 1,
            nonce: 10n,
            to: TEST_RECIPIENT,
            valueWei: 5000n,
            gas: 21000n,
            maxFeePerGas: 100n,
            maxPriorityFeePerGas: 50n,
        };
        
        const tx1 = buildEip1559TransferTx(template);
        const tx2 = buildEip1559TransferTx(template);
        
        const digest1 = signingDigestEip1559(tx1);
        const digest2 = signingDigestEip1559(tx2);
        
        expect(digest1).toBe(digest2);
    });
});
