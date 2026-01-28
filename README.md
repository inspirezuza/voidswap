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

Both clients should print `SESSION_LOCKED` with identical SID.

## Protocol Overview

### Handshake Flow
```
Alice                         Relay                           Bob
  |-------- hello ------------>|                               |
  |                            |                               |
  |                            |<--------- hello --------------|
  |<------- hello (relay) -----|                               |
  |                            |-------- hello (relay) ------->|
  |                            |                               |
  |-------- hello_ack -------->|                               |
  |                            |-------- hello_ack (relay) --->|
  |                            |                               |
  |                            |<------- hello_ack ------------|
  |<----- hello_ack (relay) ---|                               |
  |                            |                               |
  [SESSION_LOCKED sid=xxx]                        [SESSION_LOCKED sid=xxx]
```

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
