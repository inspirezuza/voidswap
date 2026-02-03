
import { test, expect } from 'vitest';
import { bindExpectedSecret, completeWithSecret, type AdaptorSig } from '../src/mockAdaptor.js';
import { padHex } from 'viem';

test('completeWithSecret accepts correct secret', () => {
    const sig: AdaptorSig = padHex('0x1', { size: 64 }); // 64 bytes
    const secret = padHex('0xbeef', { size: 32 });
    
    const bound = bindExpectedSecret(sig, secret);
    
    expect(completeWithSecret(bound, secret)).toEqual({ ok: true });
});

test('completeWithSecret throws BAD_SECRET on mismatch', () => {
    const sig: AdaptorSig = padHex('0x1', { size: 64 });
    const secret = padHex('0xbeef', { size: 32 });
    const wrong = padHex('0xdead', { size: 32 });
    
    const bound = bindExpectedSecret(sig, secret);
    
    expect(() => completeWithSecret(bound, wrong)).toThrow('BAD_SECRET');
});
