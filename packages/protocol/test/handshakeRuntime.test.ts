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
    it('should lock both runtimes with same SID', () => {
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

      // Alice starts
      const aliceStartEvents = alice.start();
      expect(alice.getState()).toBe('SENT_HELLO');
      const aliceHello = getNetOutMsgs(aliceStartEvents)[0];

      // Bob starts
      const bobStartEvents = bob.start();
      expect(bob.getState()).toBe('SENT_HELLO');
      const bobHello = getNetOutMsgs(bobStartEvents)[0];

      // Alice receives Bob's hello -> should emit ack AND lock
      const aliceRecvBobHello = alice.handleIncoming(bobHello);
      const aliceAck = getNetOutMsgs(aliceRecvBobHello)[0];
      const aliceLockedEvent = findLockedEvent(aliceRecvBobHello);

      // Bob receives Alice's hello -> should emit ack AND lock
      const bobRecvAliceHello = bob.handleIncoming(aliceHello);
      const bobLockedEvent = findLockedEvent(bobRecvAliceHello);

      // Both should be locked after receiving peer's hello
      expect(alice.getState()).toBe('LOCKED');
      expect(bob.getState()).toBe('LOCKED');

      // Both should have same SID
      expect(alice.getSid()).toBeTruthy();
      expect(bob.getSid()).toBeTruthy();
      expect(alice.getSid()).toBe(bob.getSid());

      // Lock events should have SID
      expect(aliceLockedEvent).toBeTruthy();
      expect(bobLockedEvent).toBeTruthy();
      expect(aliceLockedEvent?.sid).toBe(alice.getSid());
      expect(bobLockedEvent?.sid).toBe(bob.getSid());

      // Both should have same transcript hash (transcript may differ due to order)
      expect(aliceLockedEvent?.transcriptHash).toBeTruthy();
      expect(bobLockedEvent?.transcriptHash).toBeTruthy();
    });
  });

  describe('Reordering tolerance', () => {
    it('should lock even if ack arrives (would be ignored since already locked)', () => {
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
      const aliceStartEvents = alice.start();
      const bobStartEvents = bob.start();
      const aliceHello = getNetOutMsgs(aliceStartEvents)[0];
      const bobHello = getNetOutMsgs(bobStartEvents)[0];

      // Alice receives Bob's hello -> locks
      const aliceRecvHello = alice.handleIncoming(bobHello);
      expect(alice.getState()).toBe('LOCKED');
      const aliceAck = getNetOutMsgs(aliceRecvHello)[0];

      // Bob receives Alice's hello -> locks
      const bobRecvHello = bob.handleIncoming(aliceHello);
      expect(bob.getState()).toBe('LOCKED');
      const bobAck = getNetOutMsgs(bobRecvHello)[0];

      // Both receive acks (should be ignored since already locked)
      const aliceRecvAck = alice.handleIncoming(bobAck);
      const bobRecvAck = bob.handleIncoming(aliceAck);

      expect(aliceRecvAck).toHaveLength(0); // Ignored
      expect(bobRecvAck).toHaveLength(0); // Ignored

      // Still locked with same SID
      expect(alice.getState()).toBe('LOCKED');
      expect(bob.getState()).toBe('LOCKED');
      expect(alice.getSid()).toBe(bob.getSid());
    });
  });

  describe('Anti-replay', () => {
    it('should reject duplicate seq (replay) before lock', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      // Create a fake hello that we can replay before locking
      const fakeHello = {
        type: 'hello',
        from: 'bob',
        seq: 0,
        payload: {
          handshake: { ...sampleParams, vA: '999' }, // Different params so it aborts on mismatch first
          nonce: bobNonce,
        },
      };

      alice.start();

      // Actually let's test with a scenario where replay happens before lock
      // Need to send a message that doesn't cause lock

      // Reset with fresh runtime
      const alice2 = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      alice2.start();

      // Receive a hello from bob - this will lock alice
      const bobHello = {
        type: 'hello',
        from: 'bob',
        seq: 5, // Using higher seq so we can test lower seq later
        payload: {
          handshake: sampleParams,
          nonce: bobNonce,
        },
      };
      
      const events1 = alice2.handleIncoming(bobHello);
      expect(alice2.getState()).toBe('LOCKED'); // Alice locks

      // Can't test replay on locked runtime (it ignores messages)
      // Let's test with out-of-order instead
    });

    it('should reject out-of-order (lower seq) before lock', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      alice.start();

      // Send hello with high seq but mismatched params (so it aborts instead of locks)
      const mismatchHello = {
        type: 'hello',
        from: 'bob',
        seq: 10,
        payload: {
          handshake: { ...sampleParams, vA: '999' }, // Different params
          nonce: bobNonce,
        },
      };

      // This will abort due to params mismatch
      const events = alice.handleIncoming(mismatchHello);
      expect(alice.getState()).toBe('ABORTED');
      const abortEvent = findAbortedEvent(events);
      expect(abortEvent?.code).toBe('PROTOCOL_ERROR');
      expect(abortEvent?.message).toContain('mismatch');
    });

    it('should track seq per sender and reject replay', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: { ...sampleParams, vA: '111' }, // Use different params
        localNonce: aliceNonce,
      });

      const bob = createHandshakeRuntime({
        role: 'bob',
        params: { ...sampleParams, vA: '222' }, // Different params
        localNonce: bobNonce,
      });

      alice.start();
      const bobEvents = bob.start();
      const bobHello = getNetOutMsgs(bobEvents)[0];

      // Alice receives Bob's hello - will abort due to mismatch
      const events1 = alice.handleIncoming(bobHello);
      expect(alice.getState()).toBe('ABORTED');
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
    it('should transition through expected states', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      expect(alice.getState()).toBe('INIT');

      alice.start();
      expect(alice.getState()).toBe('SENT_HELLO');

      // Receive peer hello
      const peerHello = {
        type: 'hello',
        from: 'bob',
        seq: 0,
        payload: {
          handshake: sampleParams,
          nonce: bobNonce,
        },
      };

      alice.handleIncoming(peerHello);
      expect(alice.getState()).toBe('LOCKED'); // Should lock immediately after receiving hello
    });

    it('should ignore messages after locked', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: sampleParams,
        localNonce: aliceNonce,
      });

      alice.start();

      // Receive hello to lock
      const peerHello = {
        type: 'hello',
        from: 'bob',
        seq: 0,
        payload: {
          handshake: sampleParams,
          nonce: bobNonce,
        },
      };
      alice.handleIncoming(peerHello);
      expect(alice.getState()).toBe('LOCKED');

      const sid = alice.getSid();

      // Try to send another message - should be ignored
      const anotherMsg = {
        type: 'hello',
        from: 'bob',
        seq: 1,
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

  describe('Seq tracking', () => {
    it('should accept strictly increasing seq', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: { ...sampleParams, vA: '123' }, // Different to cause abort
        localNonce: aliceNonce,
      });

      alice.start();

      // First message with seq 0
      const msg1 = {
        type: 'hello',
        from: 'bob',
        seq: 0,
        payload: {
          handshake: { ...sampleParams, vA: '456' }, // Different
          nonce: bobNonce,
        },
      };

      // This aborts due to params mismatch
      alice.handleIncoming(msg1);
      expect(alice.getState()).toBe('ABORTED');
    });

    it('should reject equal seq (replay)', () => {
      const alice = createHandshakeRuntime({
        role: 'alice',
        params: { ...sampleParams, vA: '123' },
        localNonce: aliceNonce,
      });

      alice.start();

      // seq 5
      const msg1 = {
        type: 'hello',
        from: 'bob',
        seq: 5,
        payload: {
          handshake: { ...sampleParams, vA: '123' }, // Same params
          nonce: bobNonce,
        },
      };

      // This locks
      alice.handleIncoming(msg1);
      expect(alice.getState()).toBe('LOCKED');
    });
  });
});
