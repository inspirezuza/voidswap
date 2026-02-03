
import { test, expect } from 'vitest';
import { deriveSecretFromSigHash, redactedHex } from '../src/deriveSecret.js';
import { keccak256, concatHex, stringToHex } from 'viem';

test('deriveSecretFromSigHash is deterministic', () => {
  const sid = 'session123';
  const sigHashB = '0x1111111111111111111111111111111111111111111111111111111111111111';

  const s1 = deriveSecretFromSigHash({ sid, sigHashB });
  const s2 = deriveSecretFromSigHash({ sid, sigHashB });
  
  expect(s1).toBe(s2);
  expect(s1.startsWith('0x')).toBe(true);
  expect(s1.length).toBe(66); // 0x + 32 bytes (64 chars)
});

test('deriveSecretFromSigHash changes if input changes', () => {
  const sid = 'session123';
  const sigHashB = '0x1111111111111111111111111111111111111111111111111111111111111111';
  
  const s1 = deriveSecretFromSigHash({ sid, sigHashB });
  const s2 = deriveSecretFromSigHash({ sid: 'session124', sigHashB });
  const s3 = deriveSecretFromSigHash({ sid, sigHashB: '0x2222222222222222222222222222222222222222222222222222222222222222' });
  
  expect(s1).not.toBe(s2);
  expect(s1).not.toBe(s3);
});

test('deriveSecretFromSigHash matches manual computation', () => {
    const sid = 'abc';
    const sigHashB = '0x1234';
    
    // Manual
    const domain = stringToHex("voidswap|secret|");
    const sidHex = stringToHex(sid);
    const input = concatHex([domain, sidHex, sigHashB]);
    const expected = keccak256(input);

    const actual = deriveSecretFromSigHash({ sid, sigHashB });
    expect(actual).toBe(expected);
});

test('redactedHex works', () => {
    expect(redactedHex('0x1234567890', 4)).toBe('0x1234...');
    expect(redactedHex('0x12', 4)).toBe('0x12');
    expect(redactedHex(null)).toBe('(null)');
});
