import { createHash } from 'crypto';
import { canonicalStringify } from './canonical.js';

export function mockTlockEncrypt(input: any) {
    // Deterministic mock encryption
    const json = canonicalStringify(input); // Use canonicalStringify for determinism
    return {
        ct: '0x' + createHash('sha256').update(json + 'ct').digest('hex'),
        proof: '0x' + createHash('sha256').update(json + 'proof').digest('hex')
    };
}

export function mockVerifyCapsule(ctx: any, proof: string) {
    // Recompute expected proof for this context
    const input = {
        sid: ctx.sid,
        role: ctx.role,
        refundRound: ctx.refundRound,
        yShare: ctx.yShare
    };
    
    const { proof: expectedProof } = mockTlockEncrypt(input);
    
    return proof === expectedProof;
}
