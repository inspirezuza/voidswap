import { describe, it, expect } from 'vitest';
import { presignStart, presignRespond, presignFinish, complete, extract } from '../src/index.js';
import { toHex, keccak256 } from 'viem';

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
        const { msg2, adaptorSig, secret } = presignRespond(msg1);
        expect(msg2.sid).toBe(sid);
        expect(msg2.adaptorSig).toBe(adaptorSig);
        expect(secret).toBeDefined();

        // 3. Alice finishes
        const receivedAdaptorSig = presignFinish(msg2);
        expect(receivedAdaptorSig).toBe(adaptorSig);

        // 4. Bob completes (publishes final signature)
        const finalSig = complete(sid, digest, secret);
        expect(finalSig).toBeDefined();

        // 5. Alice extracts
        const extractedSecret = extract(sid, digest, T, receivedAdaptorSig, finalSig);
        expect(extractedSecret).toBe(secret);
    });

    it('should throw if extraction uses mismatching final signature', () => {
        const msg1 = presignStart(sid, digest, T);
        const { msg2, adaptorSig, secret } = presignRespond(msg1);
        const receivedAdaptorSig = presignFinish(msg2);

        // Bob signs WRONG digest or something -> invalid finalSig for this session/secret
        const wrongSecret = keccak256(toHex('wrong'));
        const wrongFinalSig = complete(sid, digest, wrongSecret);

        expect(() => extract(sid, digest, T, receivedAdaptorSig, wrongFinalSig)).toThrow('Proposed secret does not match final signature');
    });

    it('should throw if T is different during extraction', () => {
        const msg1 = presignStart(sid, digest, T);
        const { msg2, adaptorSig, secret } = presignRespond(msg1);
        const receivedAdaptorSig = presignFinish(msg2);
        const finalSig = complete(sid, digest, secret);

        const wrongT = keccak256(toHex('wrongT'));
        
        // This fails because masker uses T, so unmasking yields wrong secret -> wrong sig verification
        expect(() => extract(sid, digest, wrongT, receivedAdaptorSig, finalSig)).toThrow('Proposed secret does not match final signature');
    });
});
