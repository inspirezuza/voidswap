
import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime, HandshakeParams,
    SessionEvent,
    Message,
    FundingTxMessage
} from '../src/index.js';

// Test Helpers
const sampleParams: HandshakeParams = {
  version: 'voidswap-v1',
  chainId: 1,
  drandChainId: 'fastnet',
  vA: '1000',
  vB: '2000',
  targetAlice: '0x1111111111111111111111111111111111111111',
  targetBob: '0x2222222222222222222222222222222222222222',
  rBRefund: 1000,
  rARefund: 2000,
};

const aliceNonce = '0x' + 'a'.repeat(64);
const bobNonce = '0x' + 'b'.repeat(64);

function getNetOutMsgs(events: SessionEvent[]): Message[] {
  return events
    .filter(e => e.kind === 'NET_OUT')
    .map(e => (e as any).msg);
}

// Helper to fast-forward to CAPSULES_VERIFIED
function setupCapsulesVerified() {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // Handshake
    // Handshake
    const aliceStart = alice.startHandshake();
    const bobStart = bob.startHandshake();

    // Exchange Hellos
    // Alice processes Bob's Hello -> Emits Ack
    const aliceHelloEvents = alice.handleIncoming(getNetOutMsgs(bobStart)[0]);
    // Bob processes Alice's Hello -> Emits Ack
    const bobHelloEvents = bob.handleIncoming(getNetOutMsgs(aliceStart)[0]);

    // Exchange Acks
    // Alice processes Bob's Ack -> Emits Keygen Announce (if locked)
    const aliceAckEvents = alice.handleIncoming(getNetOutMsgs(bobHelloEvents)[0]);
    // Bob processes Alice's Ack -> Emits Keygen Announce (if locked)
    const bobAckEvents = bob.handleIncoming(getNetOutMsgs(aliceHelloEvents)[0]);

    if (alice.getState() === 'ABORTED') console.log('Alice aborted after Handshake Ack');
    if (bob.getState() === 'ABORTED') console.log('Bob aborted after Handshake Ack');

    // Keygen Exchange
    const aliceAnnounce = getNetOutMsgs(aliceAckEvents).find(m => m.type === 'keygen_announce');
    const bobAnnounce = getNetOutMsgs(bobAckEvents).find(m => m.type === 'keygen_announce');

    // Deliver Keygen -> Keygen Complete -> Capsule Offer
    const aliceCapsuleEvents = alice.handleIncoming(bobAnnounce!);
    const bobCapsuleEvents = bob.handleIncoming(aliceAnnounce!);
    
    if (alice.getState() === 'ABORTED') console.log('Alice aborted after keygen receive:', JSON.stringify(aliceCapsuleEvents, null, 2));
    if (bob.getState() === 'ABORTED') console.log('Bob aborted after keygen receive:', JSON.stringify(bobCapsuleEvents, null, 2));

    // Capsule Exchange
    const aliceOffer = getNetOutMsgs(aliceCapsuleEvents).find(m => m.type === 'capsule_offer');
    const bobOffer = getNetOutMsgs(bobCapsuleEvents).find(m => m.type === 'capsule_offer');
    
    if (!aliceOffer) console.log('Alice did not produce capsule offer');
    if (!bobOffer) console.log('Bob did not produce capsule offer');

    // Verify Capsules -> Ack
    const aliceAckEvents2 = alice.handleIncoming(bobOffer!);
    const bobAckEvents2 = bob.handleIncoming(aliceOffer!);

    if (alice.getState() === 'ABORTED') {
        console.log('Alice aborted on capsule offer', aliceAckEvents2); // Likely validation fail
    }
    if (bob.getState() === 'ABORTED') {
         console.log('Bob aborted on capsule offer', bobAckEvents2);
    }

    const aliceAck = getNetOutMsgs(aliceAckEvents2).find(m => m.type === 'capsule_ack');
    const bobAck = getNetOutMsgs(bobAckEvents2).find(m => m.type === 'capsule_ack');

    // Deliver Ack -> Verified -> Auto-transition to FUNDING
    const aliceFundingEvents = alice.handleIncoming(bobAck!);
    const bobFundingEvents = bob.handleIncoming(aliceAck!);

    return { alice, bob, aliceFundingEvents, bobFundingEvents };
}

describe('Funding Phase', () => {

    it('should transition to FUNDING after capsules verified', () => {
        const { alice, bob, aliceFundingEvents, bobFundingEvents } = setupCapsulesVerified();

        const aliceStart = aliceFundingEvents.find(e => e.kind === 'FUNDING_STARTED');
        const bobStart = bobFundingEvents.find(e => e.kind === 'FUNDING_STARTED');

        if (alice.getState() === 'ABORTED') {
             const abortEvent = aliceFundingEvents.find(e => e.kind === 'ABORTED') || 
                                alice.handleIncoming((bobFundingEvents[0] as any)?.msg).find(e => e.kind === 'ABORTED');
             console.log('Alice Aborted:', abortEvent);
        }
        if (bob.getState() === 'ABORTED') {
             console.log('Bob Aborted');
        }

        expect(alice.getState()).toBe('FUNDING');
        expect(bob.getState()).toBe('FUNDING');

        expect(aliceStart).toBeDefined();
        expect(bobStart).toBeDefined();
        expect((aliceStart as any).mpcAliceAddr).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it('should complete funding when both tx confirmed', () => {
        const { alice, bob } = setupCapsulesVerified();

        // 1. Emit Funding Tx locally
        const txAlice = '0x' + '1'.repeat(64);
        const txBob = '0x' + '2'.repeat(64);

        const aliceMsgEvents = alice.emitFundingTx({
            txHash: txAlice,
            fromAddress: sampleParams.targetAlice,
            toAddress: '0x0000000000000000000000000000000000000000', // mpc addr mock
            valueWei: '1000',
        });
        const bobMsgEvents = bob.emitFundingTx({
            txHash: txBob,
            fromAddress: sampleParams.targetBob,
            toAddress: '0x0000000000000000000000000000000000000000',
            valueWei: '2000',
        });

        const aliceFundingMsg = getNetOutMsgs(aliceMsgEvents)[0] as FundingTxMessage;
        const bobFundingMsg = getNetOutMsgs(bobMsgEvents)[0] as FundingTxMessage;

        expect(aliceFundingMsg.type).toBe('funding_tx');
        expect(bobFundingMsg.type).toBe('funding_tx');

        // 2. Exchange Funding Tx
        alice.handleIncoming(bobFundingMsg);
        bob.handleIncoming(aliceFundingMsg);

        // 3. Confirm txs
        // Alice confirms Alice (self) and Bob (peer)
        alice.notifyFundingConfirmed('mpc_Alice');
        const aliceFinal = alice.notifyFundingConfirmed('mpc_Bob');

        // Bob confirms Alice (peer) and Bob (self)
        bob.notifyFundingConfirmed('mpc_Alice');
        const bobFinal = bob.notifyFundingConfirmed('mpc_Bob');

        // 4. Verify FUNDED state
        expect(alice.getState()).toBe('FUNDED');
        expect(bob.getState()).toBe('FUNDED');

        const aliceFundedEvent = aliceFinal.find(e => e.kind === 'FUNDED');
        const bobFundedEvent = bobFinal.find(e => e.kind === 'FUNDED');

        expect(aliceFundedEvent).toBeDefined();
        expect(bobFundedEvent).toBeDefined(); 
    });
});
