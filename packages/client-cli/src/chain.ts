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
