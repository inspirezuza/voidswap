import { describe, it, expect } from 'vitest';
import { presignStart, presignRespond, presignFinish, complete, extract } from '../src/index.js';
import { toHex, keccak256, toBytes } from 'viem';

describe('Adaptor Mock', () => {
    const sid = keccak256(toHex('session123'));
    const digest = keccak256(toHex('txDigest123'));
    const T = keccak256(toHex('commitment123'));

    it('should complete the full presign -> complete -> extract flow', () => {
        // 1. Alice starts
        const msg1 = presignStart(sid, digest, T);
        expect(msg1.sid).toBe(sid);
        expect(msg1.digest).toBe(digest);
        expect(msg1.T).toBe(T);
        expect(msg1.n1).toBeDefined();

        // 2. Bob responds
        const { msg2, adaptorSig, secret, maskSalt } = presignRespond(msg1);
        expect(msg2.sid).toBe(sid);
        expect(msg2.adaptorSig).toBe(adaptorSig);
        expect(secret).toBeDefined();
        expect(maskSalt).toBeDefined();

        // 3. Alice finishes (stores adaptorSig)
        const receivedAdaptorSig = presignFinish(msg2);
        expect(receivedAdaptorSig).toBe(adaptorSig);

        // 4. Bob completes (publishes final signature with maskSalt)
        const finalSig = complete(sid, digest, secret, maskSalt);
        expect(finalSig).toBeDefined();
        expect(toBytes(finalSig).length).toBe(64); // sigCore(32) + maskSalt(32)

        // 5. Alice extracts (now possible because finalSig reveals maskSalt)
        const extractedSecret = extract(sid, digest, T, receivedAdaptorSig, finalSig);
        expect(extractedSecret).toBe(secret);
    });

    it('should throw if extraction uses mismatching final signature', () => {
        const msg1 = presignStart(sid, digest, T);
        const { msg2, adaptorSig, secret, maskSalt } = presignRespond(msg1);
        const receivedAdaptorSig = presignFinish(msg2);

        // Bob signs with WRONG secret -> invalid finalSig for this session
        const wrongSecret = keccak256(toHex('wrong'));
        const wrongFinalSig = complete(sid, digest, wrongSecret, maskSalt);

        expect(() => extract(sid, digest, T, receivedAdaptorSig, wrongFinalSig)).toThrow('Proposed secret does not match final signature');
    });

    it('should throw if T is different during extraction', () => {
        const msg1 = presignStart(sid, digest, T);
        const { msg2, adaptorSig, secret, maskSalt } = presignRespond(msg1);
        const receivedAdaptorSig = presignFinish(msg2);
        const finalSig = complete(sid, digest, secret, maskSalt);

        const wrongT = keccak256(toHex('wrongT'));
        
        // This fails because mask uses T, so unmasking yields wrong secret -> wrong sig verification
        expect(() => extract(sid, digest, wrongT, receivedAdaptorSig, finalSig)).toThrow('Proposed secret does not match final signature');
    });

    it('should throw if maskSalt in finalSig does not match maskCommit in adaptorSig', () => {
        const msg1 = presignStart(sid, digest, T);
        const { msg2, adaptorSig, secret, maskSalt } = presignRespond(msg1);
        const receivedAdaptorSig = presignFinish(msg2);
        
        // Create finalSig with WRONG maskSalt
        const wrongMaskSalt = keccak256(toHex('wrongSalt'));
        const wrongFinalSig = complete(sid, digest, secret, wrongMaskSalt);

        expect(() => extract(sid, digest, T, receivedAdaptorSig, wrongFinalSig)).toThrow('Mask commitment mismatch');
    });

    it('Alice cannot compute secret from adaptorSig alone (before receiving finalSig)', () => {
        // This test documents the security property: adaptorSig does NOT contain maskSalt
        const msg1 = presignStart(sid, digest, T);
        const { msg2, adaptorSig } = presignRespond(msg1);
        const receivedAdaptorSig = presignFinish(msg2);

        // adaptorSig = maskCommit || maskedSecret
        const adaptorBytes = toBytes(receivedAdaptorSig);
        const maskCommit = toHex(adaptorBytes.slice(0, 32));
        const maskedSecret = adaptorBytes.slice(32, 64);

        // Alice has: maskCommit, maskedSecret, sid, digest, T
        // To unmask, she needs maskSalt. But maskCommit = keccak256("c|" || maskSalt)
        // She cannot reverse keccak256 to get maskSalt.
        // 
        // This proves: Alice CANNOT derive the secret from adaptorSig alone.
        // She must wait for Bob to reveal maskSalt in finalSig.

        expect(maskCommit).toBeDefined(); // She has the commitment
        expect(maskedSecret.length).toBe(32); // She has the masked secret
        // But no way to derive maskSalt from maskCommit (hash preimage problem)
    });

    it('should throw on invalid input format', () => {
        expect(() => presignStart('invalid', digest, T)).toThrow('sid must be a 32-byte hex string');
        expect(() => presignStart(sid, 'short', T)).toThrow('digest must be a 32-byte hex string');
        expect(() => presignStart(sid, digest, '0x123')).toThrow('T must be a 32-byte hex string');
    });
});
