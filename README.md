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
