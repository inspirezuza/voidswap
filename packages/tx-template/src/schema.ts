/**
 * EIP-1559 Transfer Template Schema
 * 
 * Zod schema for validating transaction template inputs.
 */

import { z } from 'zod';

/**
 * Ethereum address schema (0x + 40 hex chars, lowercase)
 */
export const EthAddressSchema = z.string()
    .regex(/^0x[0-9a-f]{40}$/, 'Must be a valid Ethereum address (0x + 40 lowercase hex chars)')
    .transform(s => s.toLowerCase() as `0x${string}`);

/**
 * Positive bigint schema
 */
export const PositiveBigIntSchema = z.bigint().nonnegative();

/**
 * Chain ID schema (positive safe integer)
 */
export const ChainIdSchema = z.number().int().positive().safe();

/**
 * EIP-1559 Transfer Template Schema
 * 
 * All fields required for building an unsigned EIP-1559 transfer transaction.
 */
export const Eip1559TransferTemplateSchema = z.object({
    /** Chain ID (e.g., 1 for mainnet, 31337 for anvil) */
    chainId: ChainIdSchema,
    
    /** Transaction nonce (must be >= 0) */
    nonce: PositiveBigIntSchema,
    
    /** Recipient address (0x + 40 lowercase hex) */
    to: EthAddressSchema,
    
    /** Value to transfer in wei */
    valueWei: PositiveBigIntSchema,
    
    /** Gas limit (default 21000 for standard transfers) */
    gas: PositiveBigIntSchema.optional().default(21000n),
    
    /** Max fee per gas in wei */
    maxFeePerGas: PositiveBigIntSchema,
    
    /** Max priority fee per gas in wei */
    maxPriorityFeePerGas: PositiveBigIntSchema,
});

/**
 * Inferred type from the schema
 */
export type Eip1559TransferTemplate = z.infer<typeof Eip1559TransferTemplateSchema>;

/**
 * Unsigned EIP-1559 transaction object (compatible with viem)
 */
export interface UnsignedEip1559Tx {
    type: 'eip1559';
    chainId: number;
    nonce: number;
    to: `0x${string}`;
    value: bigint;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    data: `0x${string}`;
    accessList: readonly [];
}
