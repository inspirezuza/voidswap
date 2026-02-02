/**
 * Unit tests for SessionRuntime
 */

import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime,
    type SessionEvent,
    type HandshakeParams, type MpcResult
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

    // Both should complete KEYGEN and move to CAPSULES_EXCHANGE
    expect(alice.getState()).toBe('CAPSULES_EXCHANGE');
    expect(bob.getState()).toBe('CAPSULES_EXCHANGE');

    const aliceComplete = findKeygenCompleteEvent(aliceRecv3);
    const bobComplete = findKeygenCompleteEvent(bobRecv3);

    expect(aliceComplete).toBeTruthy();
    expect(bobComplete).toBeTruthy();

    // Verify consistency
    expect(aliceComplete?.sid).toBe(sid);
    expect(aliceComplete?.transcriptHash).toBe(bobComplete?.transcriptHash);
    expect(aliceComplete?.mpcAlice).toEqual(bobComplete?.mpcAlice);
    expect(aliceComplete?.mpcBob).toEqual(bobComplete?.mpcBob);

    // Verify address format (checksummed Ethereum address from viem)
    const aliceMpc = aliceComplete?.mpcAlice;
    expect(aliceMpc?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(aliceMpc?.commitments.local).toMatch(/^0x02[0-9a-f]{64}$/);
    expect(aliceMpc?.commitments.peer).toMatch(/^0x02[0-9a-f]{64}$/);
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
    bob.handleIncoming(aliceAnnounce);
    
    // Now Bob has stored peerMpc.
    // We want to test conflict. So let's send a SECOND announce with tamper.
    const conflictingAnnounce = JSON.parse(JSON.stringify(aliceAnnounce));
    conflictingAnnounce.seq += 1; // Increment seq to avoid replay check (though replay check happens before global check? No, global check is after? Wait.)
    // Replay check is in checking Post-Handshake Validation.
    // If we use same seq, it hits Replay check?
    // Let's verify sessionRuntime logic.
    // If state > KEYGEN (which it is now CAPSULES_EXCHANGE), it checks strict increasing seq.
    // So we MUST increment seq for it to be processed at all.
    
    // Actually, conflictingAnnounce.seq is currently 100 (same as aliceAnnounce).
    // The runtime checks `msg.seq <= lastSeq`. So it would be rejected as Replay.
    // We want it to pass Replay check but fail Consistency check.
    conflictingAnnounce.seq = aliceAnnounce.seq + 1;
    conflictingAnnounce.payload.mpcAlice.address = '0x' + 'f'.repeat(40); // Tampered address

    const bobEvents = bob.handleIncoming(conflictingAnnounce);
    
    expect(bob.getState()).toBe('ABORTED');
    const abortEvent = bobEvents.find(e => e.kind === 'ABORTED') as { kind: 'ABORTED'; code: string } | undefined;
    expect(abortEvent?.code).toBe('PROTOCOL_ERROR');
  });

  it('should ignore replay (idempotent) but reject outdated seq', () => {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // Setup: complete everything
    const aliceStart = alice.startHandshake();
    const bobStart = bob.startHandshake();
    const aliceRecv1 = alice.handleIncoming(getNetOutMsgs(bobStart)[0]);
    const bobRecv1 = bob.handleIncoming(getNetOutMsgs(aliceStart)[0]);
    const aliceRecv2 = alice.handleIncoming(getNetOutMsgs(bobRecv1)[0]); 
    const bobRecv2 = bob.handleIncoming(getNetOutMsgs(aliceRecv1)[0]);
    const aliceAnnounce = getNetOutMsgs(aliceRecv2)[0];
    
    // Bob receives Alice announce 1st time (OK)
    bob.handleIncoming(aliceAnnounce);
    expect(bob.getState()).toBe('CAPSULES_EXCHANGE'); // Advanced

    // Bob receives SAME announce 2nd time (Duplicate)
    const bobEvents2 = bob.handleIncoming(aliceAnnounce);
    
    // Expect Idempotency (ignore)
    expect(bob.getState()).toBe('CAPSULES_EXCHANGE');
    expect(bobEvents2).toEqual([]); 

    // Verify true out-of-order is rejected (seq < current)
    // NOTE: Current implementation checks msg.seq < lastSeq. lastSeq is 100 (from aliceAnnounce).
    // So seq 99 should abort.
    // However, our code also strictly enforces seq >= 100 for post-handshake.
    // So let's construct a message that passes >= 100 but fails < lastSeq.
    // Or just check that modifying seq triggers abort.
    
    const oldAnnounce = JSON.parse(JSON.stringify(aliceAnnounce));
    oldAnnounce.seq = 100; // Same as lastSeq? Logic: if (msg.seq > lastSeq) update.
    // If msg.seq == lastSeq (100 == 100), guard passes, duplicate check logic handles it.
    // We want OUT-OF-ORDER.
    // But since seq is strictly increasing, we can't really have "out of order" that is also >= 100 
    // unless we had received 101, then receive 100.
    // But here we only received 100.
    // So we can't test "out of order" > 100 unless we advance state first.
    
    // Let's assume we advance to 101.
    // But for this unit test, let's just create a dummy message with seq 99
    // (which hits the <100 check, still validating rejection).
    
    oldAnnounce.seq = 99;
    const bobEvents3 = bob.handleIncoming(oldAnnounce);
    expect(bob.getState()).toBe('ABORTED');
    const abort = bobEvents3.find(e => e.kind === 'ABORTED') as any;
    expect(abort.code).toBe('BAD_MESSAGE');
  });
});

