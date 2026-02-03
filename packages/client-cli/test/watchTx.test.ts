
import { test, expect, vi, describe } from 'vitest';
import { waitForTxConfirmations } from '../src/watchTx.js';

// Mock viem
const mockGetTransactionReceipt = vi.fn();
const mockGetBlockNumber = vi.fn();

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: mockGetTransactionReceipt,
      getBlockNumber: mockGetBlockNumber,
    }),
    http: () => ({})
  };
});

describe('waitForTxConfirmations', () => {
    test('resolves when confirmations met immediately', async () => {
        mockGetTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n });
        mockGetBlockNumber.mockResolvedValue(100n); // 1 confirmation

        const result = await waitForTxConfirmations({
            rpcUrl: 'http://localhost',
            chainId: 1,
            txHash: '0x123',
            confirmations: 1,
            pollMs: 10
        });

        expect(result).toEqual({ blockNumber: 100n, status: 'success' });
    });

    test('waits for confirmations', async () => {
        mockGetTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n });
        
        // First check: current block 99 (should usually not happen if receipt is 100, but logic wise confs < 1)
        // Let's say current block 100 (1 conf), we want 2 confs.
        mockGetBlockNumber
          .mockResolvedValueOnce(100n) // 100 - 100 + 1 = 1 conf
          .mockResolvedValueOnce(101n); // 101 - 100 + 1 = 2 confs

        const result = await waitForTxConfirmations({
            rpcUrl: 'http://localhost',
            chainId: 1,
            txHash: '0x123',
            confirmations: 2,
            pollMs: 10
        });

        expect(result).toEqual({ blockNumber: 100n, status: 'success' });
    });

    test('returns reverted status', async () => {
        mockGetTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 100n });
        
        const result = await waitForTxConfirmations({
            rpcUrl: 'http://localhost',
            chainId: 1,
            txHash: '0x123',
            confirmations: 1,
            pollMs: 10
        });

        expect(result).toEqual({ blockNumber: 100n, status: 'reverted' });
    });

    test('throws on timeout', async () => {
        mockGetTransactionReceipt.mockRejectedValue(new Error('not found')); // Simulate not found for a while

        await expect(waitForTxConfirmations({
            rpcUrl: 'http://localhost',
            chainId: 1,
            txHash: '0x123',
            confirmations: 1,
            pollMs: 10,
            timeoutMs: 50 // Short timeout
        })).rejects.toThrow('Timeout');
    });
});
