/**
 * Unit tests for HandshakeRuntime
 */

import { describe, it, expect } from 'vitest';
import {
    createHandshakeRuntime,
    type RuntimeEvent,
    type HandshakeParams,
} from '../src/index.js';

// Sample handshake params
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

// Valid 32-byte nonces
const aliceNonce = '0x' + 'a'.repeat(64);
const bobNonce = '0x' + 'b'.repeat(64);

// Helper: extract NET_OUT messages from events
function getNetOutMsgs(events: RuntimeEvent[]) {
  return events.filter(e => e.kind === 'NET_OUT').map(e => (e as { kind: 'NET_OUT'; msg: unknown }).msg);
}

// Helper: find LOCKED event
function findLockedEvent(events: RuntimeEvent[]) {
  return events.find(e => e.kind === 'LOCKED') as { kind: 'LOCKED'; sid: string; transcriptHash: string } | undefined;
}

// Helper: find ABORTED event
function findAbortedEvent(events: RuntimeEvent[]) {
  return events.find(e => e.kind === 'ABORTED') as { kind: 'ABORTED'; code: string; message: string } | undefined;
}

describe('HandshakeRuntime', () => {
  describe('Happy path', () => {
    it('should lock both runtimes with same SID and transcriptHash', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      const bob = createHandshakeRuntime({
        role: 'bob',
        params: sampleParams,
        localNonce: bobNonce,
      });

      // Both start (send hello)
      const aliceStartEvents = alice.start();
      const bobStartEvents = bob.start();
      expect(alice.getState()).toBe('SENT_HELLO');
      expect(bob.getState()).toBe('SENT_HELLO');
      const aliceHello = getNetOutMsgs(aliceStartEvents)[0];
      const bobHello = getNetOutMsgs(bobStartEvents)[0];

      // Alice receives Bob's hello -> emits alice ack, but NOT locked yet (no seenPeerAck)
      const aliceRecvBobHello = alice.handleIncoming(bobHello);
      const aliceAck = getNetOutMsgs(aliceRecvBobHello)[0];
      expect(aliceAck).toBeTruthy();
      expect(findLockedEvent(aliceRecvBobHello)).toBeUndefined(); // NOT locked yet

      // Bob receives Alice's hello -> emits bob ack, but NOT locked yet
      const bobRecvAliceHello = bob.handleIncoming(aliceHello);
      const bobAck = getNetOutMsgs(bobRecvAliceHello)[0];
      expect(bobAck).toBeTruthy();
      expect(findLockedEvent(bobRecvAliceHello)).toBeUndefined(); // NOT locked yet

      // Alice receives Bob's ack -> should LOCK now
      const aliceRecvBobAck = alice.handleIncoming(bobAck);
      const aliceLockedEvent = findLockedEvent(aliceRecvBobAck);
      expect(aliceLockedEvent).toBeTruthy();
      expect(alice.getState()).toBe('LOCKED');

      // Bob receives Alice's ack -> should LOCK now
      const bobRecvAliceAck = bob.handleIncoming(aliceAck);
      const bobLockedEvent = findLockedEvent(bobRecvAliceAck);
      expect(bobLockedEvent).toBeTruthy();
      expect(bob.getState()).toBe('LOCKED');

      // Both should have same SID
      expect(alice.getSid()).toBeTruthy();
      expect(bob.getSid()).toBeTruthy();
      expect(alice.getSid()).toBe(bob.getSid());

      // Both should have same transcriptHash (now deterministic due to sorting)
      expect(aliceLockedEvent?.transcriptHash).toBe(bobLockedEvent?.transcriptHash);
    });
  });

  describe('Reordering tolerance', () => {
    it('should not lock when ack arrives before hello', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      const bob = createHandshakeRuntime({
        role: 'bob',
        params: sampleParams,
        localNonce: bobNonce,
      });

      // Both start
      alice.start();
      bob.start();

      // Create a fake bob ack (simulating receiving ack before hello)
      const fakeBobAck = {
        type: 'hello_ack',
        from: 'bob',
        seq: 1,
        payload: {
          nonce: bobNonce,
          handshake: sampleParams,
          handshakeHash: 'somehash',
        },
      };

      // Alice receives Bob's ack BEFORE hello
      const events1 = alice.handleIncoming(fakeBobAck);
      expect(findLockedEvent(events1)).toBeUndefined(); // Should NOT lock
      expect(alice.getState()).not.toBe('LOCKED');
    });

    it('should lock after receiving both hello and ack (complete exchange)', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      const bob = createHandshakeRuntime({
        role: 'bob',
        params: sampleParams,
        localNonce: bobNonce,
      });

      // Both start
      const aliceStart = alice.start();
      const bobStart = bob.start();
      const aliceHello = getNetOutMsgs(aliceStart)[0];
      const bobHello = getNetOutMsgs(bobStart)[0];

      // Alice receives Bob's hello -> sends ack, NOT locked yet
      const aliceRecvBobHello = alice.handleIncoming(bobHello);
      const aliceAck = getNetOutMsgs(aliceRecvBobHello)[0];
      expect(findLockedEvent(aliceRecvBobHello)).toBeUndefined();

      // Bob receives Alice's hello -> sends ack, NOT locked yet
      const bobRecvAliceHello = bob.handleIncoming(aliceHello);
      const bobAck = getNetOutMsgs(bobRecvAliceHello)[0];
      expect(findLockedEvent(bobRecvAliceHello)).toBeUndefined();

      // Alice receives Bob's ack -> LOCKED
      const aliceRecvBobAck = alice.handleIncoming(bobAck);
      expect(alice.getState()).toBe('LOCKED');

      // Bob receives Alice's ack -> LOCKED
      const bobRecvAliceAck = bob.handleIncoming(aliceAck);
      expect(bob.getState()).toBe('LOCKED');

      // Same SID and transcriptHash
      expect(alice.getSid()).toBe(bob.getSid());
      expect(alice.getTranscriptHash()).toBe(bob.getTranscriptHash());
    });
  });

  describe('Anti-replay', () => {
    it('should reject out-of-order (lower seq)', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      alice.start();

      // Send hello with high seq
      const msg1 = {
        type: 'hello',
        from: 'bob',
        seq: 5,
        payload: {
          handshake: sampleParams,
          nonce: bobNonce,
        },
      };

      alice.handleIncoming(msg1);
      expect(alice.getState()).not.toBe('ABORTED');

      // Now try a lower seq (should fail)
      const msg2 = {
        type: 'hello_ack',
        from: 'bob',
        seq: 3,
        payload: {
          nonce: bobNonce,
          handshake: sampleParams,
        },
      };

      const events = alice.handleIncoming(msg2);
      expect(alice.getState()).toBe('ABORTED');
      const abortEvent = findAbortedEvent(events);
      expect(abortEvent?.code).toBe('BAD_MESSAGE');
      expect(abortEvent?.message).toContain('out-of-order');
    });
  });

  describe('Params mismatch', () => {
    it('should abort on params mismatch', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      const differentParams = { ...sampleParams, vA: '9999999' };
      const bob = createHandshakeRuntime({
        role: 'bob',
        params: differentParams,
        localNonce: bobNonce,
      });

      const aliceStartEvents = alice.start();
      const aliceHello = getNetOutMsgs(aliceStartEvents)[0];
      bob.start();

      // Bob receives Alice's hello with different params
      const bobRecv = bob.handleIncoming(aliceHello);

      expect(bob.getState()).toBe('ABORTED');
      const abortEvent = findAbortedEvent(bobRecv);
      expect(abortEvent?.code).toBe('PROTOCOL_ERROR');
      expect(abortEvent?.message).toContain('mismatch');
    });
  });

  describe('Invalid message', () => {
    it('should abort on unparseable message', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      alice.start();

      const events = alice.handleIncoming({ garbage: true });
      expect(alice.getState()).toBe('ABORTED');
      const abortEvent = findAbortedEvent(events);
      expect(abortEvent?.code).toBe('BAD_MESSAGE');
    });

    it('should reject message with unexpected sid before lock', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      alice.start();

      const msgWithSid = {
        type: 'hello',
        from: 'bob',
        seq: 0,
        sid: 'some-fake-sid',
        payload: {
          handshake: sampleParams,
          nonce: bobNonce,
        },
      };

      const events = alice.handleIncoming(msgWithSid);
      expect(alice.getState()).toBe('ABORTED');
      const abortEvent = findAbortedEvent(events);
      expect(abortEvent?.code).toBe('PROTOCOL_ERROR');
      expect(abortEvent?.message).toContain('sid');
    });
  });

  describe('State transitions', () => {
    it('should ignore messages after locked', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      const bob = createHandshakeRuntime({
        role: 'bob',
        params: sampleParams,
        localNonce: bobNonce,
      });

      // Complete handshake
      const aliceStart = alice.start();
      const bobStart = bob.start();
      const aliceHello = getNetOutMsgs(aliceStart)[0];
      const bobHello = getNetOutMsgs(bobStart)[0];

      const aliceRecvBobHello = alice.handleIncoming(bobHello);
      const bobRecvAliceHello = bob.handleIncoming(aliceHello);
      const aliceAck = getNetOutMsgs(aliceRecvBobHello)[0];
      const bobAck = getNetOutMsgs(bobRecvAliceHello)[0];

      alice.handleIncoming(bobAck);
      bob.handleIncoming(aliceAck);

      expect(alice.getState()).toBe('LOCKED');
      const sid = alice.getSid();

      // Try to send another message - should be ignored
      const anotherMsg = {
        type: 'hello',
        from: 'bob',
        seq: 99,
        payload: {
          handshake: sampleParams,
          nonce: '0x' + 'c'.repeat(64),
        },
      };

      const events = alice.handleIncoming(anotherMsg);
      expect(events).toHaveLength(0);
      expect(alice.getState()).toBe('LOCKED');
      expect(alice.getSid()).toBe(sid); // SID unchanged
    });
  });
});
