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
Protocol message types, canonical JSON serialization, and session runtime.

```bash
cd packages/protocol
pnpm install
pnpm test           # Run unit tests (40 tests)
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

### [packages/tx-template](./packages/tx-template)
EIP-1559 transaction template builder and signing digest calculator.

```bash
cd packages/tx-template
pnpm install
pnpm test       # Run unit tests
```

## Quick Start

```bash
# Terminal 1: Start anvil (local Ethereum node)
anvil

# Terminal 2: Start relay
pnpm -C packages/relay dev

# Terminal 3: Run Alice with auto-fund
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund --rpc http://127.0.0.1:8545 --fundingKey 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Terminal 4: Run Bob with auto-fund
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund --rpc http://127.0.0.1:8545 --fundingKey 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

Both clients should reach `EXEC_READY` state.

## Security Features

- **Strict Nonce Validation**: 32-byte 0x-prefixed lowercase hex enforcement.
- **Anti-Replay Protection**: Strict sequence number tracking per sender.
- **Deterministic Transcript**: Canonical sorting ensures consistent `transcriptHash`.
- **On-Chain Validation**: Funding transactions verified before confirmation.
- **Nonce Synchronization**: Both parties agree on MPC address nonces before execution.

## Protocol Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       HANDSHAKE PHASE                           │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──hello──► Relay ──► Bob                                 │
│  Alice ◄──hello── Relay ◄── Bob                                 │
│  Alice ──hello_ack──► Relay ──► Bob                             │
│  Alice ◄──hello_ack── Relay ◄── Bob                             │
│                                                                 │
│  [LOCKED: sid + transcriptHash computed]                        │
├─────────────────────────────────────────────────────────────────┤
│                        KEYGEN PHASE                             │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──keygen_announce──► Bob                                 │
│  Alice ◄──keygen_announce── Bob                                 │
│                                                                 │
│  [KEYGEN_COMPLETE: MPC addresses derived]                       │
├─────────────────────────────────────────────────────────────────┤
│                       CAPSULE PHASE                             │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──capsule_offer──► Bob                                   │
│  Alice ◄──capsule_offer── Bob                                   │
│  Alice ──capsule_ack──► Bob                                     │
│  Alice ◄──capsule_ack── Bob                                     │
│                                                                 │
│  [CAPSULES_VERIFIED: Refund capsules exchanged]                 │
├─────────────────────────────────────────────────────────────────┤
│                       FUNDING PHASE                             │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──funding_tx──► Bob                                      │
│  Alice ◄──funding_tx── Bob                                      │
│  [On-chain validation + confirmation]                           │
│                                                                 │
│  [FUNDED: Both MPC wallets funded]                              │
├─────────────────────────────────────────────────────────────────┤
│                      EXEC_PREP PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──nonce_report──► Bob                                    │
│  Alice ◄──nonce_report── Bob                                    │
│  Alice ──fee_params──► Bob                                      │
│  Alice ◄──fee_params_ack── Bob                                  │
│                                                                 │
│  [EXEC_READY: Nonces + fees agreed, ready for execution]        │
└─────────────────────────────────────────────────────────────────┘
```

## Development

```bash
# Install all dependencies
pnpm install

# Run relay server
pnpm -C packages/relay dev

# Run protocol tests
pnpm -C packages/protocol test

# Run tx-template tests
pnpm -C packages/tx-template test

# Run client (requires relay + anvil running)
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund --rpc http://127.0.0.1:8545 --fundingKey <key>
```

## Testing

### Tamper Test (Param Mismatch)
```bash
pnpm -C packages/client-cli dev -- --role alice --room test
pnpm -C packages/client-cli dev -- --role bob --room test --tamper vA
```
Both abort with `Handshake params mismatch`.

### Capsule Tamper Test (Invalid Proof)
```bash
pnpm -C packages/client-cli dev -- --role alice --room tamper
pnpm -C packages/client-cli dev -- --role bob --room tamper --tamperCapsule
```
Alice aborts with `Invalid capsule proof`.

### Nonce Mismatch Test
```bash
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund ...
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund ... --tamperNonceReport
```
Both abort with `Nonce mismatch`.

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| WebSocket Relay | ✅ Complete | Room-based message forwarding |
| Handshake Protocol | ✅ Complete | SID computation, nonce exchange |
| Keygen | ⚠️ Mock | Deterministic mock MPC |
| Capsule Exchange | ⚠️ Mock | Mock timelock encryption and ZK proofs |
| Funding Phase | ✅ Complete | Auto-funding with viem, on-chain validation |
| EXEC_PREP Phase | ✅ Complete | Nonce sync + fee params agreement |
| TX Template | ✅ Complete | EIP-1559 transaction builder |
| Execution Phase | ❌ Not Started | Actual swap execution pending |
| Refund Phase | ❌ Not Started | Timelock-based refund pending |

### Mock Components (to be replaced with real crypto)

1. **`mockKeygen.ts`** - Deterministic Ethereum addresses (not real 2-of-2 MPC)
2. **`mockTlock.ts`** - Placeholder ciphertext (not real drand encryption)
3. **`mockZkCapsule.ts`** - Always-valid proofs (not real ZK-SNARK)

These mocks allow testing the protocol flow without the full cryptographic stack.
