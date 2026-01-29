/**
 * EIP-1559 Transfer Transaction Builder
 * 
 * Builds unsigned EIP-1559 transfer transactions and computes signing digests.
 */

import { serializeTransaction, keccak256, type Hex } from 'viem';
import type { z } from 'zod';
import {
    Eip1559TransferTemplateSchema,
    type UnsignedEip1559Tx
} from './schema.js';

/** Input type for buildEip1559TransferTx (before validation) */
export type Eip1559TransferTemplateInput = z.input<typeof Eip1559TransferTemplateSchema>;

/**
 * Build an unsigned EIP-1559 transfer transaction from a template.
 * 
 * @param template - Transaction template with all required fields
 * @returns Unsigned transaction object compatible with viem
 * @throws ZodError if template validation fails
 */
export function buildEip1559TransferTx(template: Eip1559TransferTemplateInput): UnsignedEip1559Tx {
    // Validate and parse template
    const parsed = Eip1559TransferTemplateSchema.parse(template);
    
    return {
        type: 'eip1559',
        chainId: parsed.chainId,
        nonce: Number(parsed.nonce), // viem expects number for nonce
        to: parsed.to,
        value: parsed.valueWei,
        gas: parsed.gas,
        maxFeePerGas: parsed.maxFeePerGas,
        maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
        data: '0x', // Standard transfer: no calldata
        accessList: [] as const, // Standard transfer: no access list
    };
}

/**
 * Serialize an unsigned EIP-1559 transaction to RLP-encoded hex.
 * 
 * @param tx - Unsigned transaction object
 * @returns Hex string starting with "0x02" (EIP-1559 type prefix)
 */
export function serializeUnsignedEip1559(tx: UnsignedEip1559Tx): Hex {
    // Serialize without signature
    const serialized = serializeTransaction(tx);
    
    // Verify it's EIP-1559 (type 2)
    if (!serialized.startsWith('0x02')) {
        throw new Error(`Expected EIP-1559 serialization (0x02 prefix), got: ${serialized.slice(0, 6)}`);
    }
    
    return serialized;
}

/**
 * Compute the signing digest (keccak256 hash) for an EIP-1559 transaction.
 * 
 * This is the 32-byte hash that needs to be signed by the sender's private key.
 * 
 * @param tx - Unsigned transaction object
 * @returns 32-byte hex digest (0x + 64 hex chars)
 */
export function signingDigestEip1559(tx: UnsignedEip1559Tx): Hex {
    const serialized = serializeUnsignedEip1559(tx);
    return keccak256(serialized);
}
