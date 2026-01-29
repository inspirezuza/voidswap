/**
 * Unit tests for SessionRuntime
 */

import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime,
    type SessionEvent,
    type HandshakeParams, type MpcResult,
    mockKeygen
} from '../src/index.js';

// Sample params (reused)
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

function getNetOutMsgs(events: SessionEvent[]) {
  return events.filter(e => e.kind === 'NET_OUT').map(e => (e as { kind: 'NET_OUT'; msg: any }).msg);
}

function findLockedEvent(events: SessionEvent[]) {
  return events.find(e => e.kind === 'SESSION_LOCKED') as { kind: 'SESSION_LOCKED'; sid: string; transcriptHash: string } | undefined;
}

function findKeygenCompleteEvent(events: SessionEvent[]) {
  return events.find(e => e.kind === 'KEYGEN_COMPLETE') as { 
    kind: 'KEYGEN_COMPLETE'; 
    sid: string; 
    transcriptHash: string;
    mpcAlice: MpcResult;
    mpcBob: MpcResult;
  } | undefined;
}

describe('SessionRuntime', () => {
  it('should complete handshake and keygen (Happy Path)', () => {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // 1. Handshake
    const aliceStart = alice.startHandshake();
    const bobStart = bob.startHandshake();
    const aliceHello = getNetOutMsgs(aliceStart)[0];
    const bobHello = getNetOutMsgs(bobStart)[0];

    const aliceRecv1 = alice.handleIncoming(bobHello);
    const aliceAck = getNetOutMsgs(aliceRecv1)[0];

    const bobRecv1 = bob.handleIncoming(aliceHello);
    const bobAck = getNetOutMsgs(bobRecv1)[0];

    // Deliver acks -> SESSION LOCKED
    const aliceRecv2 = alice.handleIncoming(bobAck);
    const bobRecv2 = bob.handleIncoming(aliceAck);

    const aliceLocked = findLockedEvent(aliceRecv2);
    const bobLocked = findLockedEvent(bobRecv2);

    expect(aliceLocked).toBeTruthy();
    expect(bobLocked).toBeTruthy();
    expect(aliceLocked?.sid).toBe(bobLocked?.sid);
    const sid = aliceLocked!.sid;

    expect(alice.getState()).toBe('KEYGEN');
    expect(bob.getState()).toBe('KEYGEN');

    // 2. Keygen
    // Both should have emitted keygen_announce immediately upon locking
    const aliceKeygenAnnounce = getNetOutMsgs(aliceRecv2)[0];
    const bobKeygenAnnounce = getNetOutMsgs(bobRecv2)[0];

    expect(aliceKeygenAnnounce.type).toBe('keygen_announce');
    expect(bobKeygenAnnounce.type).toBe('keygen_announce');
    expect(aliceKeygenAnnounce.sid).toBe(sid);

    // Deliver keygen announcements crosswise
    const aliceRecv3 = alice.handleIncoming(bobKeygenAnnounce);
    const bobRecv3 = bob.handleIncoming(aliceKeygenAnnounce);

    // Both should complete
    expect(alice.getState()).toBe('KEYGEN_COMPLETE');
    expect(bob.getState()).toBe('KEYGEN_COMPLETE');

    const aliceComplete = findKeygenCompleteEvent(aliceRecv3);
    const bobComplete = findKeygenCompleteEvent(bobRecv3);

    expect(aliceComplete).toBeTruthy();
    expect(bobComplete).toBeTruthy();

    // Verify consistency
    expect(aliceComplete?.sid).toBe(sid);
    expect(aliceComplete?.transcriptHash).toBe(bobComplete?.transcriptHash);
    expect(aliceComplete?.mpcAlice).toEqual(bobComplete?.mpcAlice);
    expect(aliceComplete?.mpcBob).toEqual(bobComplete?.mpcBob);

    // Verify determinism against mockKeygen
    const expectedAliceMpc = mockKeygen(sid, 'alice');
    expect(aliceComplete?.mpcAlice).toEqual(expectedAliceMpc);
  });

  it('should abort on conflicting keygen announce', () => {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // Fast forward to locked state (simplifying test setup)
    // Actually we need to run handshake to get correct SID and internal state
    const aliceStart = alice.startHandshake();
    const bobStart = bob.startHandshake();
    const aliceHello = getNetOutMsgs(aliceStart)[0];
    const bobHello = getNetOutMsgs(bobStart)[0];
    const aliceMsg1 = alice.handleIncoming(bobHello);
    const bobMsg1 = bob.handleIncoming(aliceHello);
    const aliceAck = getNetOutMsgs(aliceMsg1)[0];
    const bobAck = getNetOutMsgs(bobMsg1)[0];
    
    // Alice locks and emits announce
    const aliceLockEvents = alice.handleIncoming(bobAck);
    const aliceAnnounce = getNetOutMsgs(aliceLockEvents)[0];
    
    // Bob locks
    bob.handleIncoming(aliceAck); 
    const sid = bob.getSid();

    // Bob receives clean announce from Alice -> completes (since he already emitted his own)
    // But we want to test conflict. So let's tamper with the announce.
    const conflictingAnnounce = JSON.parse(JSON.stringify(aliceAnnounce));
    conflictingAnnounce.payload.mpcAlice.address = '0x' + 'f'.repeat(40); // Tampered address

    const bobEvents = bob.handleIncoming(conflictingAnnounce);
    
    expect(bob.getState()).toBe('ABORTED');
    const abortEvent = bobEvents.find(e => e.kind === 'ABORTED') as { kind: 'ABORTED'; code: string } | undefined;
    expect(abortEvent?.code).toBe('PROTOCOL_ERROR');
  });

  it('should ignore idempotent keygen announce', () => {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // Setup: complete everything
    const aliceStart = alice.startHandshake();
    const bobStart = bob.startHandshake();
    
    // Alice processes Bob's hello
    const aliceRecv1 = alice.handleIncoming(getNetOutMsgs(bobStart)[0]);
    // Bob processes Alice's hello
    const bobRecv1 = bob.handleIncoming(getNetOutMsgs(aliceStart)[0]);
    
    // Alice processes Bob's ack -> locks
    const aliceRecv2 = alice.handleIncoming(getNetOutMsgs(bobRecv1)[0]); 
    // Bob processes Alice's ack -> locks
    const bobRecv2 = bob.handleIncoming(getNetOutMsgs(aliceRecv1)[0]);

    const aliceAnnounce = getNetOutMsgs(aliceRecv2)[0];
    
    // Bob receives Alice announce 1st time
    const eventsPhase1 = bob.handleIncoming(aliceAnnounce);
    const abort1 = eventsPhase1.find(e => e.kind === 'ABORTED');
    if (abort1) {
      console.error('Idempotency Test - Phase 1 Abort:', abort1);
    }
    expect(bob.getState()).toBe('KEYGEN_COMPLETE');

    // Bob receives SAME announce 2nd time
    const bobEvents2 = bob.handleIncoming(aliceAnnounce);
    expect(bob.getState()).toBe('KEYGEN_COMPLETE'); // Still complete, didn't abort
    expect(bobEvents2).toHaveLength(0); // No new events
  });
});
