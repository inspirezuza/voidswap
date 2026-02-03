
import { test, expect, vi } from 'vitest';
import { validateTxBAgainstPlan, type PlannedTxB } from '../src/validateTx.js';
import { signingDigestEip1559, buildEip1559TransferTx } from '@voidswap/tx-template';

test('validateTxBAgainstPlan passes on perfect match', async () => {
  const planned: PlannedTxB = {
    chainId: 31337,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: 1000n,
    nonce: 5,
    gas: 21000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 2n
  };

  // Precompute valid digest
  const unsignedTx = buildEip1559TransferTx({
      chainId: planned.chainId,
      nonce: BigInt(planned.nonce),
      to: planned.to as `0x${string}`,
      valueWei: planned.value,
      gas: planned.gas, 
      maxFeePerGas: planned.maxFeePerGas,
      maxPriorityFeePerGas: planned.maxPriorityFeePerGas
  });
  const digest = signingDigestEip1559(unsignedTx);

  const mockClient = {
    getTransaction: vi.fn().mockResolvedValue({
        hash: '0xhash',
        from: planned.from,
        to: planned.to,
        value: planned.value,
        nonce: planned.nonce,
        gas: planned.gas,
        maxFeePerGas: planned.maxFeePerGas,
        maxPriorityFeePerGas: planned.maxPriorityFeePerGas,
        input: '0x',
        type: 'eip1559',
        chainId: planned.chainId,
        blockNumber: 100n
    }),
    getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        blockNumber: 100n
    })
  };

  const mockDeps: any = {
    createPublicClient: () => mockClient,
    http: () => ({})
  };

  await expect(validateTxBAgainstPlan({
    rpcUrl: 'http://localhost:8545',
    txHash: '0xhash',
    planned,
    plannedDigestB: digest
  }, mockDeps)).resolves.not.toThrow();
});

test('validateTxBAgainstPlan throws on value mismatch', async () => {
    const planned: PlannedTxB = {
      chainId: 31337,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: 1000n,
      nonce: 5,
      gas: 21000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n
    };
  
    const unsignedTx = buildEip1559TransferTx({
        chainId: planned.chainId,
        nonce: BigInt(planned.nonce),
        to: planned.to as `0x${string}`,
        valueWei: planned.value,
        gas: planned.gas,
        maxFeePerGas: planned.maxFeePerGas,
        maxPriorityFeePerGas: planned.maxPriorityFeePerGas
    });
    const digest = signingDigestEip1559(unsignedTx);
  
    const mockClient = {
      getTransaction: vi.fn().mockResolvedValue({
          hash: '0xhash',
          from: planned.from,
          to: planned.to,
          value: 999n, // Mismatch
          nonce: planned.nonce,
          gas: planned.gas,
          maxFeePerGas: planned.maxFeePerGas,
          maxPriorityFeePerGas: planned.maxPriorityFeePerGas,
          input: '0x',
          type: 'eip1559',
          chainId: planned.chainId,
          blockNumber: 100n
      }),
      getTransactionReceipt: vi.fn().mockResolvedValue({
          status: 'success',
          blockNumber: 100n
      })
    };
  
    const mockDeps: any = {
      createPublicClient: () => mockClient,
      http: () => ({})
    };
  
    await expect(validateTxBAgainstPlan({
      rpcUrl: 'http://localhost:8545',
      txHash: '0xhash',
      planned,
      plannedDigestB: digest
    }, mockDeps)).rejects.toThrow('Mismatch value');
});

test('validateTxBAgainstPlan throws on digest mismatch (even if fields match)', async () => {
    const planned: PlannedTxB = {
      chainId: 31337,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: 1000n,
      nonce: 5,
      gas: 21000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n
    };
  
    // Digest that DOESN'T match
    const wrongDigest = '0x1234567890123456789012345678901234567890123456789012345678901234';
  
    const mockClient = {
      getTransaction: vi.fn().mockResolvedValue({
          hash: '0xhash',
          from: planned.from,
          to: planned.to,
          value: planned.value,
          nonce: planned.nonce,
          gas: planned.gas,
          maxFeePerGas: planned.maxFeePerGas,
          maxPriorityFeePerGas: planned.maxPriorityFeePerGas,
          input: '0x',
          type: 'eip1559',
          chainId: planned.chainId,
          blockNumber: 100n
      }),
      getTransactionReceipt: vi.fn().mockResolvedValue({
          status: 'success',
          blockNumber: 100n
      })
    };
  
    const mockDeps: any = {
      createPublicClient: () => mockClient,
      http: () => ({})
    };
  
    await expect(validateTxBAgainstPlan({
      rpcUrl: 'http://localhost:8545',
      txHash: '0xhash',
      planned,
      plannedDigestB: wrongDigest
    }, mockDeps)).rejects.toThrow('Digest mismatch');
});
