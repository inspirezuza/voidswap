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
pnpm test           # Run unit tests (14 tests)
pnpm example:sid    # Run SID computation example
```

## Protocol Overview

### Relay Protocol
```json
→ {"type":"join","room":"abc123"}
← {"type":"joined","room":"abc123","clientId":"..."}
→ {"type":"msg","room":"abc123","payload":{...}}
← {"type":"msg","room":"abc123","from":"...","payload":{...}}
```

### Handshake Protocol
```json
→ {"type":"hello","from":"alice","seq":0,"payload":{"handshake":{...},"nonce":"0x..."}}
← {"type":"hello_ack","from":"bob","seq":1,"payload":{"nonce":"0x..."}}
```

## Development

```bash
# Install dependencies for all packages
pnpm -C packages/relay install
pnpm -C packages/protocol install

# Run relay server
pnpm -C packages/relay dev

# Run protocol tests
pnpm -C packages/protocol test
```
