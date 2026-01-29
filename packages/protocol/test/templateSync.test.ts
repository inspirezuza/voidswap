/**
 * Template Sync Tests (EXEC_TEMPLATES_SYNC -> EXEC_TEMPLATES_READY)
 * 
 * Tests for the tx_template_commit/ack message exchange.
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

    // Exchange Hellos
    const aliceHelloEvents = alice.handleIncoming(getNetOutMsgs(bobStart)[0]);
    const bobHelloEvents = bob.handleIncoming(getNetOutMsgs(aliceStart)[0]);

    // Exchange Acks
    const aliceAckEvents = alice.handleIncoming(getNetOutMsgs(bobHelloEvents)[0]);
    const bobAckEvents = bob.handleIncoming(getNetOutMsgs(aliceHelloEvents)[0]);

    // Keygen Exchange
    const aliceAnnounce = getNetOutMsgs(aliceAckEvents).find(m => m.type === 'keygen_announce');
    const bobAnnounce = getNetOutMsgs(bobAckEvents).find(m => m.type === 'keygen_announce');

    // Deliver Keygen -> Keygen Complete -> Capsule Offer
    const aliceCapsuleEvents = alice.handleIncoming(bobAnnounce!);
    const bobCapsuleEvents = bob.handleIncoming(aliceAnnounce!);

    // Capsule Exchange
    const aliceOffer = getNetOutMsgs(aliceCapsuleEvents).find(m => m.type === 'capsule_offer');
    const bobOffer = getNetOutMsgs(bobCapsuleEvents).find(m => m.type === 'capsule_offer');

    // Verify Capsules -> Ack
    const aliceAckEvents2 = alice.handleIncoming(bobOffer!);
    const bobAckEvents2 = bob.handleIncoming(aliceOffer!);

    const aliceAck = getNetOutMsgs(aliceAckEvents2).find(m => m.type === 'capsule_ack');
    const bobAck = getNetOutMsgs(bobAckEvents2).find(m => m.type === 'capsule_ack');

    // Deliver Ack -> Verified -> Auto-transition to FUNDING
    alice.handleIncoming(bobAck!);
    bob.handleIncoming(aliceAck!);

    // Now in FUNDING state
    expect(alice.getState()).toBe('FUNDING');
    expect(bob.getState()).toBe('FUNDING');

    // Emit and exchange funding transactions
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

    // Exchange funding_tx
    for (const msg of getNetOutMsgs(aliceFundingEvents)) {
        if (msg.type === 'funding_tx') bob.handleIncoming(msg);
    }
    for (const msg of getNetOutMsgs(bobFundingEvents)) {
        if (msg.type === 'funding_tx') alice.handleIncoming(msg);
    }

    // Confirm funding
    alice.notifyFundingConfirmed('mpc_Alice');
    alice.notifyFundingConfirmed('mpc_Bob');
    bob.notifyFundingConfirmed('mpc_Alice');
    bob.notifyFundingConfirmed('mpc_Bob');

    // Now should be EXEC_PREP
    expect(alice.getState()).toBe('EXEC_PREP');
    expect(bob.getState()).toBe('EXEC_PREP');

    // Set nonces and exchange
    const nonceReport: NonceReportPayload = {
        mpcAliceNonce: '0',
        mpcBobNonce: '0',
        blockNumber: '12345',
        rpcTag: 'latest',
    };

    const aliceNonceEvents = alice.setLocalNonceReport(nonceReport);
    const bobNonceEvents = bob.setLocalNonceReport(nonceReport);

    // Exchange nonce reports
    for (const msg of getNetOutMsgs(aliceNonceEvents)) {
        bob.handleIncoming(msg);
    }
    for (const msg of getNetOutMsgs(bobNonceEvents)) {
        alice.handleIncoming(msg);
    }

    // Alice proposes fee params
    const feeParams: FeeParamsPayload = {
        maxFeePerGasWei: '1000000000',
        maxPriorityFeePerGasWei: '100000000',
        gasLimit: '21000',
        mode: 'fixed',
        proposer: 'alice',
    };

    let aliceFeeEvents = alice.proposeFeeParams(feeParams);

    // Bob receives fee_params and sends ack, which triggers EXEC_TEMPLATES_SYNC transition
    let bobFeeAckEvents: SessionEvent[] = [];
    for (const msg of getNetOutMsgs(aliceFeeEvents)) {
        bobFeeAckEvents.push(...bob.handleIncoming(msg));
    }
    
    // Capture Bob's commit message (emitted when transitioning to EXEC_TEMPLATES_SYNC)
    const bobCommit = getNetOutMsgs(bobFeeAckEvents).find(m => m.type === 'tx_template_commit');
    
    // Alice receives Bob's fee_params_ack, triggers her transition to EXEC_TEMPLATES_SYNC
    let aliceReadyEvents: SessionEvent[] = [];
    for (const msg of getNetOutMsgs(bobFeeAckEvents)) {
        if (msg.type === 'fee_params_ack') {
            aliceReadyEvents.push(...alice.handleIncoming(msg));
        }
    }
    
    // Capture Alice's commit message
    const aliceCommit = getNetOutMsgs(aliceReadyEvents).find(m => m.type === 'tx_template_commit');

    // Now both should be in EXEC_TEMPLATES_SYNC
    expect(alice.getState()).toBe('EXEC_TEMPLATES_SYNC');
    expect(bob.getState()).toBe('EXEC_TEMPLATES_SYNC');

    return { alice, bob, aliceCommit: aliceCommit!, bobCommit: bobCommit! };
}

describe('Template Sync (EXEC_TEMPLATES_SYNC)', () => {
    it('should reach EXEC_TEMPLATES_READY after exchanging commit and ack', () => {
        const { alice, bob, aliceCommit, bobCommit } = setupTemplateSync();

        // Exchange commits
        // Alice receives Bob's commit -> sends ack
        const aliceAckEvents = alice.handleIncoming(bobCommit);
        expect(aliceAckEvents.some(e => e.kind === 'NET_OUT' && (e.msg as any).type === 'tx_template_ack')).toBe(true);

        // Bob receives Alice's commit -> sends ack
        const bobAckEvents = bob.handleIncoming(aliceCommit);
        expect(bobAckEvents.some(e => e.kind === 'NET_OUT' && (e.msg as any).type === 'tx_template_ack')).toBe(true);

        // Get the ack messages
        const aliceAck = getNetOutMsgs(aliceAckEvents).find(m => m.type === 'tx_template_ack');
        const bobAck = getNetOutMsgs(bobAckEvents).find(m => m.type === 'tx_template_ack');

        // Bob receives Alice's ack -> should transition to EXEC_TEMPLATES_READY
        const bobReadyEvents = bob.handleIncoming(aliceAck!);
        
        // Alice receives Bob's ack -> should transition to EXEC_TEMPLATES_READY
        const aliceReadyEvents = alice.handleIncoming(bobAck!);

        // Both should be EXEC_TEMPLATES_READY
        expect(alice.getState()).toBe('EXEC_TEMPLATES_READY');
        expect(bob.getState()).toBe('EXEC_TEMPLATES_READY');

        // Verify EXEC_TEMPLATES_READY events were emitted
        expect(aliceReadyEvents.some(e => e.kind === 'EXEC_TEMPLATES_READY')).toBe(true);
        expect(bobReadyEvents.some(e => e.kind === 'EXEC_TEMPLATES_READY')).toBe(true);

        // Verify transcript hashes match
        expect(alice.getTranscriptHash()).toBe(bob.getTranscriptHash());
    });

    it('should abort on digest mismatch in commit', () => {
        const { alice, bob, aliceCommit, bobCommit } = setupTemplateSync();

        // Tamper with Bob's commit (flip a nibble in digestA)
        const tamperedCommit = JSON.parse(JSON.stringify(bobCommit));
        tamperedCommit.payload.digestA = tamperedCommit.payload.digestA.slice(0, -2) + 'ff';

        // Alice receives tampered commit -> should abort
        const aliceEvents = alice.handleIncoming(tamperedCommit);
        
        expect(alice.getState()).toBe('ABORTED');
        expect(aliceEvents.some(e => e.kind === 'ABORTED')).toBe(true);
    });

    it('should abort on commitHash mismatch', () => {
        const { alice, bob, aliceCommit, bobCommit } = setupTemplateSync();

        // Tamper with Bob's commitHash (doesn't match digests)
        const tamperedCommit = JSON.parse(JSON.stringify(bobCommit));
        tamperedCommit.payload.commitHash = 'ff'.repeat(32);

        // Alice receives tampered commit -> should abort due to hash mismatch
        const aliceEvents = alice.handleIncoming(tamperedCommit);
        
        expect(alice.getState()).toBe('ABORTED');
        expect(aliceEvents.some(e => e.kind === 'ABORTED')).toBe(true);
    });
});
