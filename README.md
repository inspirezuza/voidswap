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

### [packages/adaptor-mock](./packages/adaptor-mock)
Mock implementation of interactive ECDSA adaptor signatures.

```bash
cd packages/adaptor-mock
pnpm install
pnpm test       # Run unit tests
```

## Quick Start

```bash
# Terminal 1: Start anvil (local Ethereum node)
anvil

# Terminal 2: Start relay
pnpm -C packages/relay dev

# Terminal 3: Run Alice with auto-fund and auto-broadcast
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund --autoBroadcast --rpc http://127.0.0.1:8545 --fundingKey 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Terminal 4: Run Bob with auto-fund
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund --rpc http://127.0.0.1:8545 --fundingKey 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```


Both clients should reach `EXECUTION_PLANNED`. Alice will automatically broadcast `tx_B` (signed by `mpc_Bob` key). Bob will wait for `tx_B` confirmation, extract the secret, and broadcast `tx_A`.

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
├─────────────────────────────────────────────────────────────────┤
│                     TEMPLATE SYNC PHASE                         │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──tx_template_commit──► Bob                              │
│  Alice ◄──tx_template_commit── Bob                              │
│  Alice ──tx_template_ack───► Bob                                │
│  Alice ◄──tx_template_ack─── Bob                                │
│                                                                 │
│                                                                 │
│  [EXEC_TEMPLATES_READY: Execution txs confirmed]                │
├─────────────────────────────────────────────────────────────────┤
│                   ADAPTOR NEGOTIATION PHASE                     │
├─────────────────────────────────────────────────────────────────┤
│  Alice ──adaptor_start──► Bob                                   │
│  Bob   ──adaptor_resp───► Alice                                 │
│  Alice ──adaptor_ack────► Bob                                   │
│                                                                 │
│  [ADAPTOR_READY: Signatures exchanged & verified]               │
├─────────────────────────────────────────────────────────────────┤
│                      EXECUTION PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│  [EXECUTION_PLANNED: Alice broadcasts tx_B, Bob waits]          │
│  Alice ──broadcast_tx_B──► Mempool                              │
│  Alice ──txB_broadcast───► Bob                                  │
│  [TXB_HASH_RECEIVED: Bob watches tx_B]                          │
│  [Bob extracts secret (mock)]                                   │
│  Bob   ──broadcast_tx_A──► Mempool                              │
│  Bob   ──txA_broadcast───► Alice                                │
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

### Execution Flow Verification
```bash
pnpm -C packages/protocol test test/executionFlow.test.ts
```
Verifies the full end-to-end flow from handshake to final transaction broadcast (Alice -> Bob -> Alice).

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
```
Both abort with `Nonce mismatch`.

### Template Tamper Test
```bash
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund ...
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund ... --tamperTemplateCommit
```
Both abort with `Invalid commit hash` or `Template digest mismatch`.

### Adaptor Tamper Test
```bash
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund ...
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund ... --tamperAdaptor
```
Alice aborts with `Invalid adaptor sig` or similar validation error.

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
| Template Sync | ✅ Complete | Deterministic digest verification |
| Adaptor Negotiation | ✅ Complete | Mock adaptor signature exchange |
| Execution Planned | ✅ Complete | EXECUTION_PLANNED state + Alice-first plan |
| Execution Phase | ✅ Complete | Alice broadcasts tx_B -> Bob waits -> Bob extracts -> Bob broadcasts tx_A |
| Refund Phase | ❌ Not Started | Timelock-based refund pending |
| Idempotency | ✅ Complete | Duplicate messages handled safely |
| Transcript Stability | ✅ Complete | Hash unchanged under resend |

### Mock Components (to be replaced with real crypto)

1. **`mockKeygen.ts`** - Deterministic Ethereum addresses via viem (keccak256 → secp256k1)
2. **`mockTlock.ts`** - Deterministic ciphertext/proof using `canonicalStringify`
3. **`mockYShare`** - Deterministic Y-share commitments for capsule exchange

These mocks allow testing the protocol flow without the full cryptographic stack.

### Protocol Robustness

- **Idempotency**: Duplicate resends (same seq) are ignored without aborting
- **Anti-Replay**: Out-of-order messages (seq < lastSeq) are rejected
- **Transcript Stability**: Duplicate messages do not modify the transcript hash
