# WebSocket Relay

A simple WebSocket relay server for room-based message forwarding.

## Features

- Room-based messaging (join/leave rooms)
- Message forwarding to all peers (excludes sender)
- Validation: room names (1-64 chars, `[a-zA-Z0-9_-]`), message size (64KB max)
- Error handling with descriptive codes
- Logging: connect/disconnect/join/forward/error

## Quick Start

```bash
cd packages/relay
pnpm install
pnpm dev
```

Server runs at `ws://localhost:8787`

## Protocol

### Join Room
```json
→ {"type":"join","room":"abc123"}
← {"type":"joined","room":"abc123","clientId":"uuid-here"}
```

### Send Message
```json
→ {"type":"msg","room":"abc123","payload":{"any":"data"}}
← {"type":"msg","room":"abc123","from":"sender-uuid","payload":{"any":"data"}}
```

### Errors
```json
← {"type":"error","code":"NOT_JOINED|BAD_ROOM|BAD_MSG|TOO_LARGE","message":"..."}
```

## Testing

```bash
pnpm test
```

## Project Structure

```
packages/relay/
├── src/
│   ├── server.ts    # Main WebSocket server
│   ├── types.ts     # TypeScript type definitions
│   ├── validate.ts  # Validation utilities
│   └── test.ts      # Smoke test script
├── package.json
└── tsconfig.json
```
