
import { createPublicClient, http, type PublicClient } from 'viem';

export interface WaitForTxArgs {
  rpcUrl: string;
  chainId: number;
  txHash: `0x${string}`;
  confirmations: number;
  pollMs?: number;
  timeoutMs?: number;
}

export interface WaitForTxResult {
  blockNumber: bigint;
  status: 'success' | 'reverted';
}

export async function waitForTxConfirmations(args: WaitForTxArgs): Promise<WaitForTxResult> {
  const { rpcUrl, chainId, txHash, confirmations, pollMs = 250, timeoutMs = 60000 } = args;

  // Create client
  const chain = {
      id: chainId,
      name: 'custom-chain',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } }
  };

  const client = createPublicClient({ 
      chain, 
      transport: http(rpcUrl) 
  }) as PublicClient;

  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for tx ${txHash} after ${timeoutMs}ms`);
    }

    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      
      if (receipt) {
        if (receipt.status !== 'success') {
          return { blockNumber: receipt.blockNumber, status: 'reverted' };
        }

        const currentBlock = await client.getBlockNumber();
        const confs = currentBlock - receipt.blockNumber + 1n;

        if (confs >= BigInt(confirmations)) {
          return { blockNumber: receipt.blockNumber, status: 'success' };
        }
      }
    } catch (error) {
       // Ignore "Transaction not found" type errors usually found in getTransactionReceipt if node throws them
       // but typically viem returns null or throws specific error.
       // We'll verify behaviour in tests.
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
