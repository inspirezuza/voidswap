/**
 * Transcript Stability Tests
 * 
 * Verifies that transcript hash remains stable when duplicate messages are received.
 * Duplicate resend (same seq) should be idempotent and NOT modify the transcript.
 */

import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime,
    type SessionRuntime,
    type SessionEvent,
    type HandshakeParams,
    type Message,
    type NonceReportPayload,
    type FeeParamsPayload
} from '../src/index.js';

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

// Helper to fast-forward to EXEC_TEMPLATES_SYNC
function setupTemplateSync(): { alice: SessionRuntime; bob: SessionRuntime; aliceCommit: Message; bobCommit: Message } {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // Handshake
    const aliceStart = alice.startHandshake();
    const bobStart = bob.startHandshake();

    const aliceHelloEvents = alice.handleIncoming(getNetOutMsgs(bobStart)[0]);
    const bobHelloEvents = bob.handleIncoming(getNetOutMsgs(aliceStart)[0]);

    const aliceAckEvents = alice.handleIncoming(getNetOutMsgs(bobHelloEvents)[0]);
    const bobAckEvents = bob.handleIncoming(getNetOutMsgs(aliceHelloEvents)[0]);

    // Keygen
    const aliceAnnounce = getNetOutMsgs(aliceAckEvents).find(m => m.type === 'keygen_announce');
    const bobAnnounce = getNetOutMsgs(bobAckEvents).find(m => m.type === 'keygen_announce');

    const aliceCapsuleEvents = alice.handleIncoming(bobAnnounce!);
    const bobCapsuleEvents = bob.handleIncoming(aliceAnnounce!);

    // Capsules
    const aliceOffer = getNetOutMsgs(aliceCapsuleEvents).find(m => m.type === 'capsule_offer');
    const bobOffer = getNetOutMsgs(bobCapsuleEvents).find(m => m.type === 'capsule_offer');

    const aliceAckEvents2 = alice.handleIncoming(bobOffer!);
    const bobAckEvents2 = bob.handleIncoming(aliceOffer!);

    const aliceAck = getNetOutMsgs(aliceAckEvents2).find(m => m.type === 'capsule_ack');
    const bobAck = getNetOutMsgs(bobAckEvents2).find(m => m.type === 'capsule_ack');

    alice.handleIncoming(bobAck!);
    bob.handleIncoming(aliceAck!);

    // Funding
    const mpcAddrs = alice.getMpcAddresses()!;
    
    const aliceFundingEvents = alice.emitFundingTx({
        txHash: '0x' + '1'.repeat(64),
        fromAddress: sampleParams.targetAlice,
        toAddress: mpcAddrs.mpcAlice,
        valueWei: sampleParams.vA,
    });
    const bobFundingEvents = bob.emitFundingTx({
        txHash: '0x' + '2'.repeat(64),
        fromAddress: sampleParams.targetBob,
        toAddress: mpcAddrs.mpcBob,
        valueWei: sampleParams.vB,
    });

    for (const msg of getNetOutMsgs(aliceFundingEvents)) {
        if (msg.type === 'funding_tx') bob.handleIncoming(msg);
    }
    for (const msg of getNetOutMsgs(bobFundingEvents)) {
        if (msg.type === 'funding_tx') alice.handleIncoming(msg);
    }

    alice.notifyFundingConfirmed('mpc_Alice');
    alice.notifyFundingConfirmed('mpc_Bob');
    bob.notifyFundingConfirmed('mpc_Alice');
    bob.notifyFundingConfirmed('mpc_Bob');

    // Nonces
    const nonceReport: NonceReportPayload = {
        mpcAliceNonce: '0',
        mpcBobNonce: '0',
        blockNumber: '12345',
        rpcTag: 'latest',
    };

    const aliceNonceEvents = alice.setLocalNonceReport(nonceReport);
    const bobNonceEvents = bob.setLocalNonceReport(nonceReport);

    for (const msg of getNetOutMsgs(aliceNonceEvents)) {
        bob.handleIncoming(msg);
    }
    for (const msg of getNetOutMsgs(bobNonceEvents)) {
        alice.handleIncoming(msg);
    }

    // Fees
    const feeParams: FeeParamsPayload = {
        maxFeePerGasWei: '1000000000',
        maxPriorityFeePerGasWei: '100000000',
        gasLimit: '21000',
        mode: 'fixed',
        proposer: 'alice',
    };

    let aliceFeeEvents = alice.proposeFeeParams(feeParams);

    let bobFeeAckEvents: SessionEvent[] = [];
    for (const msg of getNetOutMsgs(aliceFeeEvents)) {
        bobFeeAckEvents.push(...bob.handleIncoming(msg));
    }
    
    const bobCommit = getNetOutMsgs(bobFeeAckEvents).find(m => m.type === 'tx_template_commit');
    
    let aliceReadyEvents: SessionEvent[] = [];
    for (const msg of getNetOutMsgs(bobFeeAckEvents)) {
        if (msg.type === 'fee_params_ack') {
            aliceReadyEvents.push(...alice.handleIncoming(msg));
        }
    }
    
    const aliceCommit = getNetOutMsgs(aliceReadyEvents).find(m => m.type === 'tx_template_commit');

    return { alice, bob, aliceCommit: aliceCommit!, bobCommit: bobCommit! };
}

describe('Transcript Stability', () => {
    it('transcript hash unchanged after duplicate tx_template_commit', () => {
        const { alice, bobCommit } = setupTemplateSync();
        
        expect(alice.getState()).toBe('EXEC_TEMPLATES_SYNC');
        
        // First delivery
        alice.handleIncoming(bobCommit);
        const hashAfterFirst = alice.getTranscriptHash();
        
        // Second delivery (duplicate)
        alice.handleIncoming(bobCommit);
        const hashAfterSecond = alice.getTranscriptHash();
        
        // Hash must be unchanged
        expect(hashAfterSecond).toBe(hashAfterFirst);
        expect(alice.getState()).not.toBe('ABORTED');
    });

    it('transcript hash unchanged after duplicate tx_template_ack', () => {
        const { alice, bob, aliceCommit, bobCommit } = setupTemplateSync();
        
        // Exchange commits
        alice.handleIncoming(bobCommit);
        const bobAckEvents = bob.handleIncoming(aliceCommit);
        const bobAck = getNetOutMsgs(bobAckEvents).find(m => m.type === 'tx_template_ack')!;
        
        // First ack delivery
        alice.handleIncoming(bobAck);
        const hashAfterFirst = alice.getTranscriptHash();
        
        // Second ack delivery (duplicate)
        alice.handleIncoming(bobAck);
        const hashAfterSecond = alice.getTranscriptHash();
        
        // Hash must be unchanged
        expect(hashAfterSecond).toBe(hashAfterFirst);
        expect(alice.getState()).not.toBe('ABORTED');
    });
});
