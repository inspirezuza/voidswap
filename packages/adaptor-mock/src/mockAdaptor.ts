import { keccak256, toHex, toBytes, concat, type Hex, encodePacked } from 'viem';
import { randomBytes } from 'crypto';

export type AdaptorSig = Hex; // hex encoded {maskSalt, maskedSecret}
export type FinalSig = Hex;   // hex encoded {sigCore}

// Helper: XOR two 32-byte arrays
function xor32(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== 32 || b.length !== 32) throw new Error('xor32 expects 32-byte arrays');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        out[i] = a[i] ^ b[i];
    }
    return out;
}

// Generate random 32-byte hex
function randomHex32(): Hex {
    return toHex(randomBytes(32));
}

export interface Msg1 {
    sid: Hex;
    digest: Hex;
    T: Hex;
    n1: Hex;
}

export interface Msg2 {
    sid: Hex;
    digest: Hex;
    T: Hex;
    adaptorSig: AdaptorSig;
}

/**
 * Alice starts the presign flow.
 */
export function presignStart(sid: Hex, digest: Hex, T: Hex): Msg1 {
    const n1 = randomHex32();
    return { sid, digest, T, n1 };
}

/**
 * Bob responds to Alice's presign request.
 * Computes deterministic secret, creates adaptor signature, and returns msg2.
 * WARNING: secret is returned for testing/internal use but MUST NOT be sent to Alice.
 */
export function presignRespond(msg1: Msg1): { msg2: Msg2; adaptorSig: AdaptorSig; secret: Hex } {
    const { sid, digest, T, n1 } = msg1;
    const n2 = randomHex32();

    // secret = keccak256("sec" | sid | digest | T | n1 | n2)
    const secret = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        ['sec', sid, digest, T, n1, n2]
    ));

    // maskSalt = random
    const maskSalt = randomHex32();

    // mask = keccak256("mask" | sid | digest | T | maskSalt)
    const mask = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        ['mask', sid, digest, T, maskSalt]
    ));

    // maskedSecret = secret XOR mask
    const maskedSecretBytes = xor32(toBytes(secret), toBytes(mask));
    const maskedSecret = toHex(maskedSecretBytes);

    // adaptorSig = maskSalt || maskedSecret
    const adaptorSig = concat([maskSalt, maskedSecret]);

    const msg2: Msg2 = {
        sid,
        digest,
        T,
        adaptorSig
    };

    return { msg2, adaptorSig, secret };
}

/**
 * Alice processes Bob's response and verifies the adaptor signature structure (mock validation).
 */
export function presignFinish(msg2: Msg2): AdaptorSig {
    // In real crypto, Alice would verify the adaptor signature against T and digest.
    // In mock, we just check structure (64 bytes: 32 salt + 32 masked).
    const bytes = toBytes(msg2.adaptorSig);
    if (bytes.length !== 64) throw new Error('Invalid adaptor signature length');
    
    return msg2.adaptorSig;
}

/**
 * Bob completes the signature using the secret.
 * verification: sigCore = keccak256("sig" | sid | digest | secret)
 */
export function complete(sid: Hex, digest: Hex, secret: Hex): FinalSig {
    // sigCore = keccak256("sig" | sid | digest | secret)
    const sigCore = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32'],
        ['sig', sid, digest, secret]
    ));
    return sigCore;
}

/**
 * Alice extracts the secret from the adaptor signature and final signature.
 */
export function extract(sid: Hex, digest: Hex, T: Hex, adaptorSig: AdaptorSig, finalSig: FinalSig): Hex {
    // Parse adaptorSig -> maskSalt, maskedSecret
    const sigBytes = toBytes(adaptorSig);
    if (sigBytes.length !== 64) throw new Error('Invalid adaptor signature length');
    
    const maskSalt = toHex(sigBytes.slice(0, 32));
    const maskedSecret = sigBytes.slice(32, 64);

    // Recompute mask
    const mask = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        ['mask', sid, digest, T, maskSalt]
    ));

    // Unmask secret = maskedSecret XOR mask
    const secretBytes = xor32(maskedSecret, toBytes(mask));
    const secret = toHex(secretBytes);

    // Verify secret against finalSig
    const computedSigCore = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32'],
        ['sig', sid, digest, secret]
    ));

    if (computedSigCore !== finalSig) {
        throw new Error('Proposed secret does not match final signature');
    }

    return secret;
}
