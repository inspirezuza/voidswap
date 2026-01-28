/**
 * Unit tests for SID computation and canonical serialization
 */

import { describe, it, expect } from 'vitest';
import {
    canonicalize,
    canonicalStringify,
    computeSid,
    hashHandshake,
    type HandshakeParams,
} from '../src/index.js';

// Sample handshake params for testing
const sampleParams: HandshakeParams = {
  version: 'voidswap-v1',
  chainId: 1,
  drandChainId: 'fastnet',
  vA: '1000000000000000000',
  vB: '2000000000000000000',
  targetAlice: '0x1234567890123456789012345678901234567890',
  targetBob: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  rBRefund: 1000,
  rARefund: 2000,
};

const aliceNonce = '0x' + 'a'.repeat(64);
const bobNonce = '0x' + 'b'.repeat(64);

describe('canonicalize', () => {
  it('should sort object keys lexicographically', () => {
    const obj1 = { z: 1, a: 2, m: 3 };
    const obj2 = { a: 2, m: 3, z: 1 };
    
    expect(canonicalStringify(obj1)).toBe(canonicalStringify(obj2));
    expect(canonicalStringify(obj1)).toBe('{"a":2,"m":3,"z":1}');
  });

  it('should handle nested objects', () => {
    const obj1 = { outer: { z: 1, a: 2 }, b: 3 };
    const obj2 = { b: 3, outer: { a: 2, z: 1 } };
    
    expect(canonicalStringify(obj1)).toBe(canonicalStringify(obj2));
  });

  it('should preserve array order', () => {
    const arr = [3, 1, 2];
    expect(canonicalStringify(arr)).toBe('[3,1,2]');
  });

  it('should reject undefined values', () => {
    expect(() => canonicalize(undefined)).toThrow('undefined');
    expect(() => canonicalize({ a: undefined })).toThrow('undefined');
  });

  it('should reject non-safe integers', () => {
    expect(() => canonicalize(1.5)).toThrow('not a safe integer');
    expect(() => canonicalize(Number.MAX_SAFE_INTEGER + 1)).toThrow('not a safe integer');
  });

  it('should allow null values', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify({ a: null })).toBe('{"a":null}');
  });
});

describe('computeSid', () => {
  it('should return deterministic SID for same inputs', () => {
    const sid1 = computeSid(sampleParams, aliceNonce, bobNonce);
    const sid2 = computeSid(sampleParams, aliceNonce, bobNonce);
    
    expect(sid1).toBe(sid2);
    expect(sid1).toHaveLength(64);
    expect(sid1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be sensitive to vA changes', () => {
    const modifiedParams = { ...sampleParams, vA: '999999999999999999' };
    
    const sid1 = computeSid(sampleParams, aliceNonce, bobNonce);
    const sid2 = computeSid(modifiedParams, aliceNonce, bobNonce);
    
    expect(sid1).not.toBe(sid2);
  });

  it('should be sensitive to targetAlice changes', () => {
    const modifiedParams = { 
      ...sampleParams, 
      targetAlice: '0x0000000000000000000000000000000000000001' 
    };
    
    const sid1 = computeSid(sampleParams, aliceNonce, bobNonce);
    const sid2 = computeSid(modifiedParams, aliceNonce, bobNonce);
    
    expect(sid1).not.toBe(sid2);
  });

  it('should be sensitive to nonce changes', () => {
    const differentAliceNonce = '0x' + 'c'.repeat(64);
    
    const sid1 = computeSid(sampleParams, aliceNonce, bobNonce);
    const sid2 = computeSid(sampleParams, differentAliceNonce, bobNonce);
    
    expect(sid1).not.toBe(sid2);
  });

  it('should produce different SIDs when nonces are swapped', () => {
    const sid1 = computeSid(sampleParams, aliceNonce, bobNonce);
    const sid2 = computeSid(sampleParams, bobNonce, aliceNonce);
    
    expect(sid1).not.toBe(sid2);
  });
});

describe('hashHandshake', () => {
  it('should return deterministic hash', () => {
    const hash1 = hashHandshake(sampleParams);
    const hash2 = hashHandshake(sampleParams);
    
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('should be stable regardless of key order in source', () => {
    // Create params with different key insertion order
    const params1: HandshakeParams = {
      version: 'voidswap-v1',
      chainId: 1,
      drandChainId: 'fastnet',
      vA: '100',
      vB: '200',
      targetAlice: '0x1234567890123456789012345678901234567890',
      targetBob: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      rBRefund: 1000,
      rARefund: 2000,
    };

    const params2: HandshakeParams = {
      rARefund: 2000,
      rBRefund: 1000,
      targetBob: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      targetAlice: '0x1234567890123456789012345678901234567890',
      vB: '200',
      vA: '100',
      drandChainId: 'fastnet',
      chainId: 1,
      version: 'voidswap-v1',
    };

    expect(hashHandshake(params1)).toBe(hashHandshake(params2));
  });

  it('should change when any field changes', () => {
    const modified = { ...sampleParams, chainId: 42 };
    
    expect(hashHandshake(sampleParams)).not.toBe(hashHandshake(modified));
  });
});
