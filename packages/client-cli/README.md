# Voidswap Client CLI

CLI client for voidswap handshake over WebSocket relay.

## Quick Start

### 1. Start the relay server

```bash
pnpm -C packages/relay dev
```

### 2. Run Alice (Terminal 2)

```bash
pnpm -C packages/client-cli dev -- --role alice --room test123
```

### 3. Run Bob (Terminal 3)

```bash
pnpm -C packages/client-cli dev -- --role bob --room test123
```

> **Note**: Both clients will display "Waiting for peer..." until the second client joins the room. The handshake starts automatically once two peers are present.

Both clients should print:
```
STATE: SESSION_LOCKED
sid=<same-64-char-hex>
transcriptHash=<same-64-char-hex>

STATE: KEYGEN_COMPLETE
sid=<same-64-char-hex>
transcriptHash=<same-64-char-hex>
------------------------------------------------------------
Alice Address: 0x...
Bob Address:   0x...
============================================================

STATE: CAPSULES_VERIFIED
sid=<same-64-char-hex>
transcriptHash=<same-64-char-hex>
============================================================
REFUND CAPSULES EXCHANGED AND VERIFIED. SECURE TO FUND.
```

## Tamper Test (Mismatch Detection)

To test that param mismatch is detected:

```bash
# Terminal 2: Alice (normal)
pnpm -C packages/client-cli dev -- --role alice --room test123

# Terminal 3: Bob (tampered vA)
pnpm -C packages/client-cli dev -- --role bob --room test123 --tamper vA
```

Expected: Both abort with `Handshake params mismatch`

## CLI Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--role` | Yes | - | `alice` or `bob` |
| `--room` | Yes | - | Room name to join |
| `--relay` | No | `ws://localhost:8787` | Relay WebSocket URL |
| `--chainId` | No | `1` | Blockchain chain ID |
| `--drandChainId` | No | `fastnet` | Drand chain ID |
| `--vA` | No | `1000000000000000000` | Alice's value |
| `--vB` | No | `2000000000000000000` | Bob's value |
| `--targetAlice` | No | `0x1234...` | Alice's target address |
| `--targetBob` | No | `0xabcd...` | Bob's target address |
| `--rBRefund` | No | `1000` | Bob's refund round |
| `--rARefund` | No | `2000` | Alice's refund round |
| `--tamper` | No | `none` | Tamper field for testing: `vA`, `targetAlice`, `none` |
| `--tamperCapsule` | No | `false` | Corrupts outgoing capsule proof (security test) |
| `--rpc` | No | `http://127.0.0.1:8545` | Ethereum RPC URL |
| `--autoFund` | No | `false` | Auto-fund MPC wallet |
| `--fundingKey` | No | ENV var | Private key for funding (or use `VOIDSWAP_ALICE_FUNDING_KEY`/`VOIDSWAP_BOB_FUNDING_KEY`) |
| `--confirmations` | No | `1` | Number of block confirmations to wait |

## Auto-Funding with Anvil

```bash
# Start anvil
anvil

# Set funding keys (anvil defaults)
set VOIDSWAP_ALICE_FUNDING_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
set VOIDSWAP_BOB_FUNDING_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

# Run Alice with auto-funding
pnpm -C packages/client-cli dev -- --role alice --room test --autoFund --rpc http://127.0.0.1:8545

# Run Bob with auto-funding (another terminal)
pnpm -C packages/client-cli dev -- --role bob --room test --autoFund --rpc http://127.0.0.1:8545
```
