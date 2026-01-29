/**
 * Execution Templates Module
 * 
 * Builds deterministic transaction templates and signing digests
 * for the swap execution phase.
 */

import {
    buildEip1559TransferTx,
    signingDigestEip1559,
    type UnsignedEip1559Tx
} from '@voidswap/tx-template';

// Re-export for convenience
export { type UnsignedEip1559Tx };

export type FeeParams = {
    maxFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    gasLimit: string;
};

export type Nonces = {
    mpcAliceNonce: string;
    mpcBobNonce: string;
};

export type TxTemplateResult = {
    txA: UnsignedEip1559Tx;
    txB: UnsignedEip1559Tx;
    digestA: string; // Hex32 (0x + 64 hex chars)
    digestB: string; // Hex32 (0x + 64 hex chars)
};

export interface ExecutionTemplateInput {
    chainId: number;
    targets: { targetAlice: string; targetBob: string };
    mpcs: { mpcAlice: string; mpcBob: string };
    values: { vAWei: string; vBWei: string };
    nonces: Nonces;
    fee: FeeParams;
}

/**
 * Normalize an Ethereum address to lowercase 0x-prefixed format.
 */
function normalizeAddress(addr: string): `0x${string}` {
    return addr.toLowerCase() as `0x${string}`;
}

/**
 * Build execution transaction templates and compute their signing digests.
 * 
 * Creates two transactions:
 * - tx_A: from mpc_Alice -> targetBob, value=vA, nonce=mpcAliceNonce
 * - tx_B: from mpc_Bob -> targetAlice, value=vB, nonce=mpcBobNonce
 * 
 * Note: "from" is not included in unsigned tx encoding; the signer is
 * determined by who signs the digest. The "from" is for semantics only.
 * 
 * @param input - All required fields for building templates
 * @returns Transaction templates and their signing digests
 */
export function buildExecutionTemplates(input: ExecutionTemplateInput): TxTemplateResult {
    const { chainId, targets, values, nonces, fee } = input;
    
    // tx_A: mpc_Alice -> targetBob (Alice pays Bob)
    const txA = buildEip1559TransferTx({
        chainId,
        nonce: BigInt(nonces.mpcAliceNonce),
        to: normalizeAddress(targets.targetBob),
        valueWei: BigInt(values.vAWei),
        gas: BigInt(fee.gasLimit),
        maxFeePerGas: BigInt(fee.maxFeePerGasWei),
        maxPriorityFeePerGas: BigInt(fee.maxPriorityFeePerGasWei),
    });
    
    // tx_B: mpc_Bob -> targetAlice (Bob pays Alice)
    const txB = buildEip1559TransferTx({
        chainId,
        nonce: BigInt(nonces.mpcBobNonce),
        to: normalizeAddress(targets.targetAlice),
        valueWei: BigInt(values.vBWei),
        gas: BigInt(fee.gasLimit),
        maxFeePerGas: BigInt(fee.maxFeePerGasWei),
        maxPriorityFeePerGas: BigInt(fee.maxPriorityFeePerGasWei),
    });
    
    // Compute signing digests
    const digestA = signingDigestEip1559(txA);
    const digestB = signingDigestEip1559(txB);
    
    return { txA, txB, digestA, digestB };
}
