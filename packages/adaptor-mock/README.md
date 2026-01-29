# @voidswap/adaptor-mock

A standalone mock implementation of interactive ECDSA adaptor signatures (Simulaton Proof 2).

This package provides a deterministic, secure-mock simulation of the presigning and extraction flow used in Voidswap, using standard hash primitives (`sha256`, `keccak256`) instead of elliptic curve operations.

## Features

- **Interactive Presign Flow**:
  1. `presignStart` (Alice): Generates initial message.
  2. `presignRespond` (Bob): Derives deterministic secret, creates adaptor signature (masked secret), returns response.
  3. `presignFinish` (Alice): Validates response.
- **Completion**: `complete` (Bob) generates a "final signature" using his secret.
- **Extraction**: `extract` (Alice) recovers the secret from the adaptor signature and the final signature.
- **Determinism**: Secret is cryptographically bound to the session ID, message digest, and adaptor commitment.

## Usage

```typescript
import { presignStart, presignRespond, presignFinish, complete, extract } from '@voidswap/adaptor-mock';
import { keccak256, toHex } from 'viem';

// Constants
const sid = keccak256(toHex('session1'));
const digest = keccak256(toHex('txDigest'));
const T = keccak256(toHex('commitment'));

// 1. Alice starts
const msg1 = presignStart(sid, digest, T);

// 2. Bob responds (internal secret generated)
const { msg2, adaptorSig, secret } = presignRespond(msg1);

// 3. Alice verifies struct
const aliceAdaptorSig = presignFinish(msg2);

// 4. Bob broadcasts final signature
const finalSig = complete(sid, digest, secret);

// 5. Alice extracts secret
const extractedSecret = extract(sid, digest, T, aliceAdaptorSig, finalSig);
// extractedSecret === secret
```
