import { keccak256, toHex, toBytes, concatHex, type Hex, encodePacked, isHex } from 'viem';
import { randomBytes } from 'crypto';

export type AdaptorSig = Hex; // hex encoded {maskCommit(32), maskedSecret(32)}
export type FinalSig = Hex;   // hex encoded {sigCore(32), maskSalt(32)}

// Validation: assert 32-byte hex string (0x + 64 hex chars)
function assertHex32(value: unknown, name: string): asserts value is Hex {
    if (!value || typeof value !== 'string' || !isHex(value) || toBytes(value).length !== 32) {
        throw new Error(`${name} must be a 32-byte hex string (0x + 64 hex chars)`);
    }
}

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

export interface BoundAdaptor {
    adaptorSig: AdaptorSig;
    expectedSecret: Hex;
}

/**
 * Binds an expected secret to an adaptor signature (Mock only).
 * This simulates that the adaptor signature was created with a specific secret in mind.
 */
export function bindExpectedSecret(adaptorSig: AdaptorSig, expectedSecret: Hex): BoundAdaptor {
    assertHex32(expectedSecret, 'expectedSecret');
    return {
        adaptorSig,
        expectedSecret
    };
}

/**
 * Completes the "adaptor" by unlocking it with the secret.
 * In this Mock/Phase 2A, it simply verifies the secret matches the expectation.
 */
export function completeWithSecret(bound: BoundAdaptor, secret: Hex): { ok: true } {
    assertHex32(secret, 'secret');
    if (secret !== bound.expectedSecret) {
        throw new Error('BAD_SECRET');
    }
    return { ok: true };
}

/**
 * Alice starts the presign flow.
 */
export function presignStart(sid: Hex, digest: Hex, T: Hex): Msg1 {
    assertHex32(sid, 'sid');
    assertHex32(digest, 'digest');
    assertHex32(T, 'T');
    
    const n1 = randomHex32();
    return { sid, digest, T, n1 };
}

/**
 * Bob responds to Alice's presign request.
 * Computes deterministic secret, creates adaptor signature, and returns msg2.
 * 
 * SECURITY: adaptorSig contains maskCommit (commitment to maskSalt), NOT maskSalt itself.
 * Alice cannot derive secret until she receives finalSig which reveals maskSalt.
 */
export function presignRespond(msg1: Msg1): { msg2: Msg2; adaptorSig: AdaptorSig; secret: Hex; maskSalt: Hex } {
    const { sid, digest, T, n1 } = msg1;
    const n2 = randomHex32();

    // secret = keccak256("sec" | sid | digest | T | n1 | n2)
    const secret = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        ['sec', sid, digest, T, n1, n2]
    ));

    // maskSalt = random (kept secret by Bob until complete())
    const maskSalt = randomHex32();

    // maskCommit = keccak256("c|" | maskSalt) - commitment to salt
    const maskCommit = keccak256(encodePacked(
        ['string', 'bytes32'],
        ['c|', maskSalt]
    ));

    // mask = keccak256("mask" | sid | digest | T | maskSalt)
    const mask = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        ['mask', sid, digest, T, maskSalt]
    ));

    // maskedSecret = secret XOR mask
    const maskedSecretBytes = xor32(toBytes(secret), toBytes(mask));
    const maskedSecret = toHex(maskedSecretBytes);

    // adaptorSig = maskCommit || maskedSecret (Alice cannot derive secret without maskSalt)
    const adaptorSig = concatHex([maskCommit, maskedSecret]);

    const msg2: Msg2 = {
        sid,
        digest,
        T,
        adaptorSig
    };

    return { msg2, adaptorSig, secret, maskSalt };
}

/**
 * Alice processes Bob's response and verifies the adaptor signature structure (mock validation).
 */
export function presignFinish(msg2: Msg2): AdaptorSig {
    // In real crypto, Alice would verify the adaptor signature against T and digest.
    // In mock, we just check structure (64 bytes: 32 maskCommit + 32 maskedSecret).
    const bytes = toBytes(msg2.adaptorSig);
    if (bytes.length !== 64) throw new Error('Invalid adaptor signature length');
    
    return msg2.adaptorSig;
}

/**
 * Bob completes the signature using the secret and maskSalt.
 * Returns finalSig = sigCore || maskSalt
 * 
 * SECURITY: This is the first time maskSalt is revealed, allowing Alice to extract.
 */
export function complete(sid: Hex, digest: Hex, secret: Hex, maskSalt: Hex): FinalSig {
    assertHex32(sid, 'sid');
    assertHex32(digest, 'digest');
    assertHex32(secret, 'secret');
    assertHex32(maskSalt, 'maskSalt');
    
    // sigCore = keccak256("sig" | sid | digest | secret)
    const sigCore = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32'],
        ['sig', sid, digest, secret]
    ));
    
    // finalSig = sigCore || maskSalt (reveals maskSalt for extraction)
    return concatHex([sigCore, maskSalt]);
}

/**
 * Alice extracts the secret from the adaptor signature and final signature.
 * 
 * SECURITY: Only possible after receiving finalSig which contains maskSalt.
 */
export function extract(sid: Hex, digest: Hex, T: Hex, adaptorSig: AdaptorSig, finalSig: FinalSig): Hex {
    assertHex32(sid, 'sid');
    assertHex32(digest, 'digest');
    assertHex32(T, 'T');
    
    // Parse adaptorSig -> maskCommit, maskedSecret
    const adaptorBytes = toBytes(adaptorSig);
    if (adaptorBytes.length !== 64) throw new Error('Invalid adaptor signature length');
    
    const maskCommit = toHex(adaptorBytes.slice(0, 32));
    const maskedSecret = adaptorBytes.slice(32, 64);

    // Parse finalSig -> sigCore, maskSalt
    const finalBytes = toBytes(finalSig);
    if (finalBytes.length !== 64) throw new Error('Invalid final signature length');
    
    const sigCore = toHex(finalBytes.slice(0, 32));
    const maskSalt = toHex(finalBytes.slice(32, 64)) as Hex;

    // Verify maskCommit matches keccak256("c|" | maskSalt)
    const expectedCommit = keccak256(encodePacked(
        ['string', 'bytes32'],
        ['c|', maskSalt]
    ));
    if (maskCommit !== expectedCommit) {
        throw new Error('Mask commitment mismatch');
    }

    // Recompute mask
    const mask = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        ['mask', sid, digest, T, maskSalt]
    ));

    // Unmask secret = maskedSecret XOR mask
    const secretBytes = xor32(maskedSecret, toBytes(mask));
    const secret = toHex(secretBytes);

    // Verify secret against sigCore
    const computedSigCore = keccak256(encodePacked(
        ['string', 'bytes32', 'bytes32', 'bytes32'],
        ['sig', sid, digest, secret]
    ));

    if (computedSigCore !== sigCore) {
        throw new Error('Proposed secret does not match final signature');
    }

    return secret;
}
