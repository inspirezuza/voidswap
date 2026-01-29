
import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime, HandshakeParams,
    SessionEvent,
    Message
} from '../src/index.js';

// Test Helpers
const sampleParams: HandshakeParams = {
  version: 'voidswap-v1',
  chainId: 1,
  drandChainId: 'fastnet',
  vA: '1000',
  vB: '2000',
  targetAlice: '0x1234000000000000000000000000000000000000',
  targetBob: '0xabcd000000000000000000000000000000000000',
  rBRefund: 1000,
  rARefund: 2000,
};

const aliceNonce = '0x1111111111111111111111111111111111111111111111111111111111111111';
const bobNonce = '0x2222222222222222222222222222222222222222222222222222222222222222';

function getNetOutMsgs(events: SessionEvent[]): Message[] {
  return events
    .filter(e => e.kind === 'NET_OUT')
    .map(e => (e as any).msg);
}

// Helper to quickly reach KEYGEN_COMPLETE
function setupKeygenComplete(tamperCapsule = false) {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce, tamperCapsule });

    const bobStart = bob.startHandshake();
    const aliceStart = alice.startHandshake(); // Alice doesn't send first usually, but `start` sends hello
    
    // Handshake Exchange
    const bobHello = getNetOutMsgs(bobStart)[0];
    const aliceHello = getNetOutMsgs(aliceStart)[0];

    const aliceRecv1 = alice.handleIncoming(bobHello);
    const bobRecv1 = bob.handleIncoming(aliceHello);

    const aliceAck = getNetOutMsgs(aliceRecv1)[0]; 
    const bobAck = getNetOutMsgs(bobRecv1)[0]; 

    // Alice processes Bob's ack -> locks -> announce
    const aliceRecv2 = alice.handleIncoming(bobAck);
    // Bob processes Alice's ack -> locks -> announce
    const bobRecv2 = bob.handleIncoming(aliceAck); 
    
    // Debug
    // console.log('Alice events after ack:', aliceRecv2.map(e => e.kind));
    // console.log('Bob events after ack:', bobRecv2.map(e => e.kind));

    const aliceAnnounce = getNetOutMsgs(aliceRecv2).find(m => m.type === 'keygen_announce');
    const bobAnnounce = getNetOutMsgs(bobRecv2).find(m => m.type === 'keygen_announce');
    
    if (!aliceAnnounce || !bobAnnounce) {
       console.log('Alice msgs:', getNetOutMsgs(aliceRecv2));
       console.log('Bob msgs:', getNetOutMsgs(bobRecv2));
       throw new Error(`Keygen announce missing: A=${!!aliceAnnounce} B=${!!bobAnnounce}`);
    }

    // Verify events
    const aliceLocked = aliceRecv2.find(e => e.kind === 'SESSION_LOCKED');
    if (!aliceLocked) throw new Error('Alice failed to lock');

    // Deliver Keygen Announcements
    // Alice receives Bob's announce -> KEYGEN_COMPLETE -> CAPSULES_EXCHANGE -> Sends Offer
    const aliceRecv3 = alice.handleIncoming(bobAnnounce); 
    // Bob receives Alice's announce -> KEYGEN_COMPLETE -> CAPSULES_EXCHANGE -> Sends Offer
    const bobRecv3 = bob.handleIncoming(aliceAnnounce);

    return { alice, bob, aliceRecv3, bobRecv3, aliceLocked };
}

describe('Capsule Exchange', () => {
    
  it('should complete capsule exchange (Happy Path)', () => {
      const { alice, bob, aliceRecv3, bobRecv3, aliceLocked } = setupKeygenComplete();

      expect(alice.getState()).toBe('CAPSULES_EXCHANGE');
      expect(bob.getState()).toBe('CAPSULES_EXCHANGE');

      // Extract Offers
      const aliceOffer = getNetOutMsgs(aliceRecv3).find(m => m.type === 'capsule_offer');
      const bobOffer = getNetOutMsgs(bobRecv3).find(m => m.type === 'capsule_offer');
      
      expect(aliceOffer).toBeDefined();
      expect(bobOffer).toBeDefined();

      // Alice receives Bob's offer
      const aliceRecv4 = alice.handleIncoming(bobOffer);
      const aliceAck = getNetOutMsgs(aliceRecv4).find(m => m.type === 'capsule_ack');
      expect(aliceAck).toBeDefined();
      expect((aliceAck as any).payload.ok).toBe(true);

      // Bob receives Alice's offer
      const bobRecv4 = bob.handleIncoming(aliceOffer);
      const bobAck = getNetOutMsgs(bobRecv4).find(m => m.type === 'capsule_ack');
      expect(bobAck).toBeDefined();
      expect((bobAck as any).payload.ok).toBe(true);

      // Deliver Acks
      const aliceRecv5 = alice.handleIncoming(bobAck);
      const bobRecv5 = bob.handleIncoming(aliceAck);
      
      // Check Final State
      expect(alice.getState()).toBe('CAPSULES_VERIFIED');
      expect(bob.getState()).toBe('CAPSULES_VERIFIED');
      
      // Check Events
      const aliceFinal = aliceRecv5.find(e => e.kind === 'CAPSULES_VERIFIED');
      const bobFinal = bobRecv5.find(e => e.kind === 'CAPSULES_VERIFIED');
      expect(aliceFinal).toBeDefined();
      expect(bobFinal).toBeDefined();
      
      expect(bobFinal).toBeDefined();
      
      const hashLocked = (aliceLocked as any).transcriptHash;
      const hashFinal = (aliceFinal as any).transcriptHash;
      
      // Hash should evolve
      expect(hashFinal).not.toBe(hashLocked);
      
      // Peers should agree
      expect((aliceFinal as any).transcriptHash).toBe((bobFinal as any).transcriptHash);
  });

  it('should abort if capsule proof is invalid (Tamper)', () => {
      // Setup with Bob tampering his capsule
      const { alice, bob, aliceRecv3, bobRecv3 } = setupKeygenComplete(true);

      const bobOffer = getNetOutMsgs(bobRecv3).find(m => m.type === 'capsule_offer');
      expect(bobOffer).toBeDefined();

      // Alice receives tampered offer
      const aliceRecv4 = alice.handleIncoming(bobOffer);
      
      expect(alice.getState()).toBe('ABORTED');
      
      const nack = getNetOutMsgs(aliceRecv4).find(m => m.type === 'capsule_ack');
      expect(nack).toBeDefined();
      expect((nack as any).payload.ok).toBe(false);
      
      const abortEvent = aliceRecv4.find(e => e.kind === 'ABORTED');
      expect((abortEvent as any).code).toBe('PROTOCOL_ERROR');
  });

});
