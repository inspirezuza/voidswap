# Voidswap

A trustless atomic swap protocol using timelock encryption.

## Packages

### [packages/relay](./packages/relay)
WebSocket relay server for room-based message forwarding between peers.

```bash
cd packages/relay
pnpm install
pnpm dev        # Start server at ws://localhost:8787
pnpm test       # Run smoke tests
```

### [packages/protocol](./packages/protocol)
Protocol message types, canonical JSON serialization, and SID computation.

```bash
cd packages/protocol
pnpm install
pnpm test           # Run unit tests
pnpm example:sid    # Run SID computation example
```

### [packages/client-cli](./packages/client-cli)
CLI client for voidswap handshake over WebSocket relay.

```bash
cd packages/client-cli
pnpm install
pnpm dev -- --role alice --room test
pnpm dev -- --role bob --room test
```

## Quick Start

```bash
# Terminal 1: Start relay
pnpm -C packages/relay dev

# Terminal 2: Run Alice
pnpm -C packages/client-cli dev -- --role alice --room test

# Terminal 3: Run Bob
pnpm -C packages/client-cli dev -- --role bob --room test
```

Both clients should print `state` transitions without repetitive hashes (unless `--verbose` is used).

## Security Features

This protocol implementation includes:
- **Strict Nonce Validation**: 32-byte 0x-prefixed lowercase hex enforcement.
- **Anti-Replay Protection**: Strict sequence number tracking per sender.
- **Deterministic Transcript**: Canonical sorting of message history ensures consistent `transcriptHash`.
- **Peer Readiness**: Clients wait for peers to be present before starting handshake to prevent lost messages.

## Protocol Overview

### Handshake Flow
```
Alice                         Relay                           Bob
  |                            |                               |
  |--- (Waiting for peer) ---->|                               |
  |                            |<--- (Waiting for peer) -------|
  |                            |                               |
  |<--- (Peer Joined) ---------+--------- (Peer Joined) ------>|
  |                            |                               |
  |-------- hello ------------>|                               |
  |                            |                               |
  |                            |<--------- hello --------------|
  |                            |                               |
  |<------- hello (relay) -----|                               |
  |                            |-------- hello (relay) ------->|
  |                            |                               |
  |-------- hello_ack -------->|                               |
  |                            |-------- hello_ack (relay) --->|
  |                            |                               |
  |                            |<------- hello_ack ------------|
  |<----- hello_ack (relay) ---|                               |
  |                            |                               |
  [LOCKED sid=x transcript=y]     [LOCKED sid=x transcript=y]
  |                            |                               |
  |--- keygen_announce ------->|                               |
  |                            |--- keygen_announce ---------->|
  |                            |                               |
  |                            |<------- keygen_announce ------|
  |<--- keygen_announce -------|                               |
  |                            |                               |
  |                            |                               |
  [KEYGEN_COMPLETE mpc=OK]          [KEYGEN_COMPLETE mpc=OK]
  |                            |                               |
  |--- capsule_offer --------->|                               |
  |                            |--- capsule_offer ------------>|
  |                            |                               |
  |                            |<------- capsule_offer --------|
  |<--- capsule_offer ---------|                               |
  |                            |                               |
  |--- capsule_ack ----------->|                               |
  |                            |--- capsule_ack -------------->|
  |                            |                               |
  |                            |<------- capsule_ack ----------|
  |<--- capsule_ack -----------|                               |
  |                            |                               |
  [CAPSULES_VERIFIED]              [CAPSULES_VERIFIED]
```

### Nonce Format
Nonces must be exactly 32 bytes in 0x-prefixed lowercase hex:
- Format: `0x` + 64 lowercase hex characters
- Example: `0xa1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4`
- Generated using `crypto.randomBytes(32)`

## Development

```bash
# Install all dependencies
pnpm install

# Run relay server
pnpm -C packages/relay dev

# Run protocol tests
pnpm -C packages/protocol test

# Run client (requires relay running)
pnpm -C packages/client-cli dev -- --role alice --room test
```

## Tamper Test

Test that param mismatch is detected:

```bash
# Alice (normal)
pnpm -C packages/client-cli dev -- --role alice --room test

# Bob (tampered vA)
pnpm -C packages/client-cli dev -- --role bob --room test --tamper vA
```

Both should abort with `Handshake params mismatch`.

## Capsule Tamper Test

Test that invalid proof is detected:

```bash
# Bob (tamper capsule fake proof)
pnpm -C packages/client-cli dev -- --role bob --room tamper --tamperCapsule

# Alice (verifies)
pnpm -C packages/client-cli dev -- --role alice --room tamper
```

Alice should abort with `PROTOCOL_ERROR: Invalid capsule proof`.

## Auto-Funding with Anvil

For end-to-end testing with on-chain funding:

```bash
# Terminal 1: Start anvil (local Ethereum node)
anvil

# Terminal 2: Start relay
pnpm -C packages/relay dev

# Terminal 3: Alice with auto-fund
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund --rpc http://127.0.0.1:8545 --fundingKey 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Terminal 4: Bob with auto-fund
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund --rpc http://127.0.0.1:8545 --fundingKey 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| WebSocket Relay | ✅ Complete | Room-based message forwarding |
| Handshake Protocol | ✅ Complete | SID computation, nonce exchange |
| Keygen | ⚠️ **Mock** | Uses deterministic mock MPC, not real 2-of-2 ECDSA |
| Capsule Exchange | ⚠️ **Mock** | Mock timelock encryption and ZK proofs |
| Funding Phase | ✅ Complete | Auto-funding with viem, confirmation watching |
| Execution Phase | ❌ Not Started | Actual swap execution pending |
| Refund Phase | ❌ Not Started | Timelock-based refund pending |

### Mock Components (to be replaced with real crypto)

1. **`mockKeygen.ts`** - Generates deterministic Ethereum addresses instead of real 2-of-2 MPC keygen
2. **`mockTlock.ts`** - Returns placeholder ciphertext instead of real drand timelock encryption
3. **`mockZkCapsule.ts`** - Always returns valid proofs instead of real ZK-SNARK verification

These mocks allow testing the protocol flow without requiring the full cryptographic stack.

