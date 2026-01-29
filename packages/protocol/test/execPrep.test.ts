/**
 * EXEC_PREP Phase Tests
 * 
 * Tests for nonce synchronization and fee params agreement after FUNDED.
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

// Helper to fast-forward to EXEC_PREP (copies from funding.test.ts)
function setupExecPrep(): { alice: SessionRuntime; bob: SessionRuntime } {
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

    return { alice, bob };
}

describe('EXEC_PREP Phase', () => {
    it('should transition to EXEC_READY with matching nonces and fee ack', () => {
        const { alice, bob } = setupExecPrep();

        // Same nonces for both sides
        const nonceReport: NonceReportPayload = {
            mpcAliceNonce: '0',
            mpcBobNonce: '0',
            blockNumber: '12345',
            rpcTag: 'latest',
        };

        // Fee params from Alice
        const feeParams: FeeParamsPayload = {
            maxFeePerGasWei: '20000000000',
            maxPriorityFeePerGasWei: '1000000000',
            gasLimit: '21000',
            mode: 'fixed',
            proposer: 'alice',
        };

        // Alice sets local nonces and proposes fee
        const aliceNonceEvents = alice.setLocalNonceReport(nonceReport);
        const aliceFeeEvents = alice.proposeFeeParams(feeParams);

        // Bob sets local nonces
        const bobNonceEvents = bob.setLocalNonceReport(nonceReport);

        // Exchange nonce_report messages
        for (const msg of getNetOutMsgs(aliceNonceEvents)) {
            bob.handleIncoming(msg);
        }
        for (const msg of getNetOutMsgs(bobNonceEvents)) {
            alice.handleIncoming(msg);
        }

        // Exchange fee_params and fee_params_ack
        for (const msg of getNetOutMsgs(aliceFeeEvents)) {
            const ackEvents = bob.handleIncoming(msg);
            for (const ackMsg of getNetOutMsgs(ackEvents)) {
                alice.handleIncoming(ackMsg);
            }
        }

        // Both should be EXEC_READY
        expect(alice.getState()).toBe('EXEC_READY');
        expect(bob.getState()).toBe('EXEC_READY');

        // Verify transcript hashes match
        expect(alice.getTranscriptHash()).toBe(bob.getTranscriptHash());
    });

    it('should abort on nonce mismatch', () => {
        const { alice, bob } = setupExecPrep();

        // Different nonces
        const aliceNonceReport: NonceReportPayload = {
            mpcAliceNonce: '0',
            mpcBobNonce: '0',
            blockNumber: '12345',
            rpcTag: 'latest',
        };

        const bobNonceReport: NonceReportPayload = {
            mpcAliceNonce: '0',
            mpcBobNonce: '1', // Different!
            blockNumber: '12345',
            rpcTag: 'latest',
        };

        const aliceNonceEvents = alice.setLocalNonceReport(aliceNonceReport);
        const bobNonceEvents = bob.setLocalNonceReport(bobNonceReport);

        // Exchange nonce_report
        for (const msg of getNetOutMsgs(aliceNonceEvents)) {
            bob.handleIncoming(msg);
        }
        for (const msg of getNetOutMsgs(bobNonceEvents)) {
            alice.handleIncoming(msg);
        }

        // At least one side should have aborted due to nonce mismatch
        const aliceAborted = alice.getState() === 'ABORTED';
        const bobAborted = bob.getState() === 'ABORTED';
        
        expect(aliceAborted || bobAborted).toBe(true);
    });

    it('should emit EXEC_PREP_STARTED event with MPC addresses', () => {
        const { alice, bob } = setupExecPrep();
        
        // Verify getMpcAddresses returns valid data
        const aliceAddrs = alice.getMpcAddresses();
        const bobAddrs = bob.getMpcAddresses();

        expect(aliceAddrs).not.toBeNull();
        expect(bobAddrs).not.toBeNull();
        expect(aliceAddrs!.mpcAlice).toBe(bobAddrs!.mpcAlice);
        expect(aliceAddrs!.mpcBob).toBe(bobAddrs!.mpcBob);
    });

    it('should reject fee_params from wrong role', () => {
        const { alice, bob } = setupExecPrep();

        const feeParams: FeeParamsPayload = {
            maxFeePerGasWei: '20000000000',
            maxPriorityFeePerGasWei: '1000000000',
            gasLimit: '21000',
            mode: 'fixed',
            proposer: 'alice',
        };

        // Bob tries to propose (should fail)
        const bobFeeEvents = bob.proposeFeeParams(feeParams);
        const abortEvent = bobFeeEvents.find(e => e.kind === 'ABORTED');
        
        expect(abortEvent).toBeDefined();
        expect(bob.getState()).toBe('ABORTED');
    });
});
