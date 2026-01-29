# @voidswap/tx-template

EIP-1559 transfer transaction template builder and signing digest computation.

## Overview

This package provides utilities for building unsigned EIP-1559 transfer transactions and computing their signing digests. It's designed to be deterministic and canonical, making it suitable for protocols that need to pre-compute transaction hashes.

## Installation

```bash
pnpm add @voidswap/tx-template
```

## Usage

### Building a Transaction

```typescript
import { 
    buildEip1559TransferTx, 
    signingDigestEip1559 
} from '@voidswap/tx-template';

// Build unsigned transaction
const tx = buildEip1559TransferTx({
    chainId: 1,                          // Ethereum mainnet
    nonce: 0n,                           // Transaction nonce
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    valueWei: 1000000000000000000n,      // 1 ETH
    gas: 21000n,                         // Standard transfer gas
    maxFeePerGas: 20_000_000_000n,       // 20 gwei
    maxPriorityFeePerGas: 1_000_000_000n // 1 gwei
});

// Compute signing digest
const digest = signingDigestEip1559(tx);
console.log('Digest:', digest);
// => 0x... (32-byte hex)
```

### What is a Signing Digest?

The signing digest is the keccak256 hash of the RLP-encoded unsigned transaction. This is the value that needs to be signed by the sender's private key to create a valid transaction signature.

For EIP-1559 transactions:
```
digest = keccak256(0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList]))
```

### Serialization

```typescript
import { serializeUnsignedEip1559 } from '@voidswap/tx-template';

const serialized = serializeUnsignedEip1559(tx);
console.log(serialized);
// => 0x02... (RLP-encoded hex)
```

## API

### `buildEip1559TransferTx(template)`

Builds an unsigned EIP-1559 transfer transaction.

**Parameters:**
- `template.chainId: number` - Chain ID
- `template.nonce: bigint` - Transaction nonce (≥0)
- `template.to: string` - Recipient address (0x + 40 lowercase hex)
- `template.valueWei: bigint` - Value in wei (≥0)
- `template.gas?: bigint` - Gas limit (default: 21000n)
- `template.maxFeePerGas: bigint` - Max fee per gas in wei
- `template.maxPriorityFeePerGas: bigint` - Max priority fee per gas in wei

**Returns:** `UnsignedEip1559Tx` - Transaction object with `type: 'eip1559'`, `data: '0x'`, `accessList: []`

### `serializeUnsignedEip1559(tx)`

Serializes an unsigned transaction to RLP-encoded hex.

**Returns:** `Hex` - String starting with `0x02`

### `signingDigestEip1559(tx)`

Computes the keccak256 hash of the serialized unsigned transaction.

**Returns:** `Hex` - 32-byte hex string (0x + 64 chars)

## Constraints

This package enforces standard ETH transfers only:
- `data` is always `'0x'` (no calldata)
- `accessList` is always `[]` (no access list)
- Addresses must be lowercase

## Testing

```bash
pnpm test
```

The test suite verifies digest correctness by:
1. Signing a transaction with a known private key
2. Recovering the signer address from our computed digest + signature
3. Asserting the recovered address matches the expected account
