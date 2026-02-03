
import { test, expect } from 'vitest';
import { computeSigFingerprint } from '../src/sigFingerprint.js';
import { keccak256, concatHex, padHex } from 'viem';

test('computeSigFingerprint pads r and s to 32 bytes', () => {
  const r = '0x1';
  const s = '0x2';
  const v = 27n;
  
  const result = computeSigFingerprint({ r, s, v });
  
  expect(result.r).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
  expect(result.s).toBe('0x0000000000000000000000000000000000000000000000000000000000000002');
});

test('computeSigFingerprint normalizes v (27/28 -> 0/1)', () => {
    // 27 -> 0
    const res1 = computeSigFingerprint({ r: '0x1', s: '0x1', v: 27n });
    expect(res1.v).toBe(0n);

    // 28 -> 1
    const res2 = computeSigFingerprint({ r: '0x1', s: '0x1', v: 28n });
    expect(res2.v).toBe(1n);

    // 0 -> 0
    const res3 = computeSigFingerprint({ r: '0x1', s: '0x1', v: 0n });
    expect(res3.v).toBe(0n);

    // 1 -> 1
    const res4 = computeSigFingerprint({ r: '0x1', s: '0x1', v: 1n });
    expect(res4.v).toBe(1n);
});

test('computeSigFingerprint produces correct sigHash', () => {
    const r = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const s = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const v = 27n; // -> 0

    const result = computeSigFingerprint({ r, s, v });
    
    // Manual check
    const expectedV = padHex('0x0', { size: 32 });
    const expectedHash = keccak256(concatHex([r, s, expectedV]));
    
    expect(result.sigHash).toBe(expectedHash);
});
