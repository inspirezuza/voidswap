import {
    createPublicClient,
    createWalletClient,
    http, type Hex,
    type PublicClient,
    type WalletClient, type Chain
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, localhost } from 'viem/chains';

// Use localhost for default, but can override
const lookupChain = (chainId: number): Chain => {
  if (chainId === 1) return mainnet;
  return localhost;
};

export interface ChainClients {
    publicClient: PublicClient;
    walletClient?: WalletClient;
    funderAddress?: Hex;
}

export function createClients(rpcUrl: string, fundingKey?: string): ChainClients {
    const transport = http(rpcUrl);
    
    // Determine chain? Ideally we'd fetch chainId from RPC, but for now we default to localhost transport
    // or we can just pass the transport to client without strict chain if we are just sending raw txs?
    // Viem wants a chain. Let's assume localhost for Anvil/Dev.
    
    const publicClient = createPublicClient({
        transport,
        chain: localhost // TODO: Make configurable if needed, or fetch from net_version
    });

    let walletClient: WalletClient | undefined;
    let funderAddress: Hex | undefined;

    if (fundingKey) {
        const account = privateKeyToAccount(fundingKey as Hex);
        funderAddress = account.address;
        
        walletClient = createWalletClient({
            account,
            chain: localhost,
            transport
        });
    }

    return { publicClient, walletClient, funderAddress };
}

export async function sendEthTransfer(
    walletClient: WalletClient, 
    to: Hex, 
    valueWei: bigint
): Promise<Hex> {
    if (!walletClient.account) throw new Error('No account in wallet client');
    
    const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        chain: null,
        to,
        value: valueWei,
        // EIP-1559 defaults usually work fine with anvil
    });
    
    return hash;
}

export async function waitConfirmations(
    publicClient: PublicClient, 
    hash: Hex, 
    confirmations: number = 1
) {
    const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations
    });
    return receipt;
}

/**
 * Validate an on-chain funding transaction before confirming.
 * Checks: to address, minimum value, no calldata, successful status.
 */
export async function validateFundingTx(
    publicClient: PublicClient,
    txHash: Hex,
    expectedTo: string,
    minValueWei: bigint,
    confirmations: number = 1
): Promise<void> {
    // Get transaction details
    const tx = await publicClient.getTransaction({ hash: txHash });
    if (!tx) {
        throw new Error(`Transaction ${txHash} not found on-chain`);
    }
    
    // Validate recipient
    if (tx.to?.toLowerCase() !== expectedTo.toLowerCase()) {
        throw new Error(`TX 'to' mismatch: expected ${expectedTo}, got ${tx.to}`);
    }
    
    // Validate value
    if (tx.value < minValueWei) {
        throw new Error(`TX value too low: expected >= ${minValueWei}, got ${tx.value}`);
    }
    
    // Validate no calldata (simple ETH transfer)
    if (tx.input !== '0x') {
        throw new Error(`TX has calldata (${tx.input}), expected simple ETH transfer`);
    }
    
    // Wait for confirmations and check status
    const receipt = await publicClient.waitForTransactionReceipt({ 
        hash: txHash, 
        confirmations 
    });
    
    if (receipt.status !== 'success') {
        throw new Error(`TX failed: status=${receipt.status}`);
    }
}

