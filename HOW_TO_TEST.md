# Testing Guide

This document provides instructions for running unit tests and performing manual end-to-end verification of the Voidswap protocol.

## Prerequisites

Ensure all dependencies are installed:
```bash
pnpm install
```

## Unit Tests

Run the full suite of protocol tests:
```bash
pnpm -C packages/protocol test
```

Run specific package tests:
```bash
pnpm -C packages/tx-template test
pnpm -C packages/adaptor-mock test
```

## Manual Verification (End-to-End)

To manually verify the protocol execution flow (specifically the Alice-first execution plan), follow these steps:

### 1. Start Infrastructure
Open two terminals to start the required services.

**Terminal 1: Anvil (Local Blockchain)**
```bash
anvil
```

**Terminal 2: Relay Server**
```bash
pnpm -C packages/relay dev
```

### 2. Run Clients (Alice & Bob)
Open two more terminals for the clients.

**Terminal 3: Alice (Broadcaster)**
Currently, Alice is responsible for broadcasting `tx_B` first. We use `--autoBroadcast` to automate this.
```bash
pnpm -C packages/client-cli dev -- \
  --role alice \
  --room test \
  --autoFund \
  --autoBroadcast \
  --rpc http://127.0.0.1:8545 \
  --fundingKey 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

**Terminal 4: Bob (Listener)**
Bob will negotiate adaptors and then wait for `tx_B` to be confirmed on-chain.
```bash
pnpm -C packages/client-cli dev -- \
  --role bob \
  --room test \
  --autoFund \
  --rpc http://127.0.0.1:8545 \
  --fundingKey 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

### 3. Expected Output

**Alice**:
- Should reach `STATE: EXECUTION_PLANNED`.
- Should log: `Auto-broadcasting tx_B (signed by mpc_Bob key, published by Alice client)...`
- Should log: `Broadcasted tx_B: 0x...`

**Bob**:
- Should reach `STATE: EXECUTION_PLANNED`.
- Should log: `My action: wait_tx_B_confirm_then_extract_then_broadcast_tx_A`.
- Should stay waiting (extraction logic is next step in development).

## Advanced Testing (Tamper)

You can test security mechanisms by simulating malicious behavior using tamper flags:

**Simulate Alice param mismatch:**
```bash
pnpm -C packages/client-cli dev -- --role bob ... --tamper vA
```

**Simulate Bob invalid signature:**
```bash
pnpm -C packages/client-cli dev -- --role bob ... --tamperAdaptor
```
Alice should abort with `PROTOCOL_ERROR`.
