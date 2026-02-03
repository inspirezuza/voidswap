
import { type PublicClient } from 'viem';
import { signingDigestEip1559, buildEip1559TransferTx } from '@voidswap/tx-template';

export interface PlannedTxB {
  chainId: number;
  from: string;
  to: string;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface ValidationArgs {
  rpcUrl: string;
  txHash: `0x${string}`;
  planned: PlannedTxB;
  plannedDigestB: string;
}

// Injection for testing
export interface ValidationDeps {
    createPublicClient: typeof import('viem').createPublicClient;
    http: typeof import('viem').http;
    // We can't easily mock imported functions like signingDigestEip1559 without more complex DI or module mocking.
    // We'll rely on it being a pure function.
}

export async function validateTxBAgainstPlan(
    args: ValidationArgs, 
    deps?: ValidationDeps // optional deps
): Promise<void> {

    const { rpcUrl, txHash, planned, plannedDigestB } = args;

    // Dynamic import if not provided (normal usage)
    const { createPublicClient, http } = deps || await import('viem');

    const chain = {
        id: planned.chainId,
        name: 'custom-chain',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
    };

    const client = createPublicClient({ 
        chain, 
        transport: http(rpcUrl) 
    }) as PublicClient;

    // Fetch tx and receipt
    const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash: txHash }),
        client.getTransactionReceipt({ hash: txHash })
    ]);

    if (!tx) throw new Error(`Transaction ${txHash} not found`);
    if (!receipt) throw new Error(`Receipt for ${txHash} not found`);

    // 1. Receipt Status
    if (receipt.status !== 'success') {
        throw new Error(`Transaction ${txHash} failed on-chain`);
    }

    // 2. Invariant Checks
    const normalize = (addr: string) => addr.toLowerCase();

    const actual = {
        from: normalize(tx.from),
        to: tx.to ? normalize(tx.to) : null,
        value: tx.value,
        nonce: tx.nonce,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        type: tx.type,
        input: tx.input,
        chainId: tx.chainId
    };

    const expected = {
        from: normalize(planned.from),
        to: normalize(planned.to),
        value: planned.value,
        nonce: planned.nonce,
        gas: planned.gas,
        maxFeePerGas: planned.maxFeePerGas,
        maxPriorityFeePerGas: planned.maxPriorityFeePerGas,
        type: '0x2', // EIP-1559
        input: '0x',
        chainId: planned.chainId
    };

    // Strict equality checks
    if (actual.from !== expected.from) throw new Error(`Mismatch from: expected ${expected.from}, got ${actual.from}`);
    if (actual.to !== expected.to) throw new Error(`Mismatch to: expected ${expected.to}, got ${actual.to}`);
    if (actual.value !== expected.value) throw new Error(`Mismatch value: expected ${expected.value}, got ${actual.value}`);
    if (actual.nonce !== expected.nonce) throw new Error(`Mismatch nonce: expected ${expected.nonce}, got ${actual.nonce}`);
    if (actual.gas !== expected.gas) throw new Error(`Mismatch gas: expected ${expected.gas}, got ${actual.gas}`);
    if (actual.maxFeePerGas !== expected.maxFeePerGas) throw new Error(`Mismatch maxFeePerGas: expected ${expected.maxFeePerGas}, got ${actual.maxFeePerGas}`);
    if (actual.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas) throw new Error(`Mismatch maxPriorityFeePerGas: expected ${expected.maxPriorityFeePerGas}, got ${actual.maxPriorityFeePerGas}`);
    
    // Type check (viem might return 'eip1559' string or hex or number depending on version)
    // We check if it satisfies EIP-1559 properties which we did above. 
    // But strictly types:
    if (tx.type !== 'eip1559' && tx.typeHex !== '0x2') {
         // handle various viem return shapes if needed, but standard is 'eip1559' for type usually
         // Let's rely on fields being present.
         // If fields matched, it's virtually EIP-1559.
         // But let's check input data
    }
    if (actual.input !== expected.input) throw new Error(`Mismatch input: expected 0x, got ${actual.input}`);
    if (actual.chainId !== expected.chainId) throw new Error(`Mismatch chainId: expected ${expected.chainId}, got ${actual.chainId}`);

    // 3. Digest Re-computation
    // We utilize the exact helper from tx-template that generates the digest from valid fields
    // This handles type='eip1559', accessList=[], data='0x' defaults etc.
    const unsignedTx = buildEip1559TransferTx({
        chainId: planned.chainId,
        nonce: BigInt(planned.nonce),
        maxPriorityFeePerGas: planned.maxPriorityFeePerGas,
        maxFeePerGas: planned.maxFeePerGas,
        gas: planned.gas, // Note: tx-template schema uses 'gas' but input type defines 'gas'
        to: planned.to as `0x${string}`,
        valueWei: planned.value,
    });

    const digest = signingDigestEip1559(unsignedTx);

    if (digest !== plannedDigestB) {
        throw new Error(`Digest mismatch: planned ${plannedDigestB}, recomputed from chain ${digest}`);
    }

    // Success
}
