/**
 * Adaptor Negotiation Tests (ADAPTOR_NEGOTIATING -> ADAPTOR_READY)
 * 
 * Tests for the adaptor_start / adaptor_resp / adaptor_ack message exchange.
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

// Helper to fast-forward to ADAPTOR_NEGOTIATING
function setupAdaptor(tamperAdaptor = false): { alice: SessionRuntime; bob: SessionRuntime; adaptorStartMsg: Message } {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ 
        role: 'bob', 
        params: sampleParams, 
        localNonce: bobNonce,
        outboundMutator: tamperAdaptor ? (msg) => {
             if (msg.type === 'adaptor_resp') {
                 // Tamper signature by truncation to trigger length check failure in AdaptorMock
                 const original = msg.payload.adaptorSigB as string;
                 return { ...msg, payload: { ...msg.payload, adaptorSigB: original.slice(0, -2) } };
             }
             return msg;
        } : undefined
    });

    // Handshake
    const aliceHandshake = alice.startHandshake();
    const bobHandshake = bob.startHandshake();

    // Exchange Hellos
    const aliceHelloEvents = alice.handleIncoming(getNetOutMsgs(bobHandshake)[0]);
    const bobHelloEvents = bob.handleIncoming(getNetOutMsgs(aliceHandshake)[0]);

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

    // Set nonces and exchange
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
    
    const bobCommit = getNetOutMsgs(bobFeeAckEvents).find(m => m.type === 'tx_template_commit');
    
    // Alice receives Bob's fee_params_ack, triggers her transition to EXEC_TEMPLATES_SYNC
    let aliceReadyEvents: SessionEvent[] = [];
    for (const msg of getNetOutMsgs(bobFeeAckEvents)) {
        if (msg.type === 'fee_params_ack') {
            aliceReadyEvents.push(...alice.handleIncoming(msg));
        }
    }
    
    const aliceCommit = getNetOutMsgs(aliceReadyEvents).find(m => m.type === 'tx_template_commit');

    // Exchange Commits (EXEC_TEMPLATES_SYNC)
    const aliceAckTxEvents = alice.handleIncoming(bobCommit!);
    const bobAckTxEvents = bob.handleIncoming(aliceCommit!);

    const aliceTermAck = getNetOutMsgs(aliceAckTxEvents).find(m => m.type === 'tx_template_ack');
    const bobTermAck = getNetOutMsgs(bobAckTxEvents).find(m => m.type === 'tx_template_ack');
    
    // Finalize Template Sync -> Transitions to ADAPTOR_NEGOTIATING
    // Alice receives Bob's Ack
    let aliceFinalEvents = alice.handleIncoming(bobTermAck!);
    
    // Bob receives Alice's Ack
    let bobFinalEvents = bob.handleIncoming(aliceTermAck!);

    // Alice should have emitted 'ADAPTOR_NEGOTIATING' and 'adaptor_start'
    const adaptorStartMsg = getNetOutMsgs(aliceFinalEvents).find(m => m.type === 'adaptor_start');
    
    if (!adaptorStartMsg) {
        throw new Error('Alice did not emit adaptor_start');
    }
    
    // Verify States
    expect(alice.getState()).toBe('ADAPTOR_NEGOTIATING');
    expect(bob.getState()).toBe('ADAPTOR_NEGOTIATING'); // Bob transitions when he receives Ack from Alice

    return { alice, bob, adaptorStartMsg };
}

describe('Adaptor Negotiation (ADAPTOR_NEGOTIATING -> ADAPTOR_READY)', () => {
    
    it('should complete adaptor negotiation successfully', () => {
        const { alice, bob, adaptorStartMsg } = setupAdaptor(false);
        
        // Bob receives adaptor_start -> sends adaptor_resp
        const bobEvents = bob.handleIncoming(adaptorStartMsg);
        const bobResp = getNetOutMsgs(bobEvents).find(m => m.type === 'adaptor_resp');
        
        expect(bobResp).toBeDefined();
        expect(bob.getState()).toBe('ADAPTOR_NEGOTIATING'); // Bob waits for ack
        
        // Alice receives adaptor_resp -> sends adaptor_ack
        const aliceEvents = alice.handleIncoming(bobResp!);
        const aliceAck = getNetOutMsgs(aliceEvents).find(m => m.type === 'adaptor_ack');
        
        expect(aliceAck).toBeDefined();
        
        // Alice should emit ADAPTOR_READY then EXECUTION_PLANNED
        expect(aliceEvents.some(e => e.kind === 'ADAPTOR_READY')).toBe(true);
        expect(aliceEvents.some(e => e.kind === 'EXECUTION_PLANNED')).toBe(true);
        expect(alice.getState()).toBe('EXECUTION_PLANNED');
        
        // Check Alice's roleAction
        const alicePlan = aliceEvents.find(e => e.kind === 'EXECUTION_PLANNED') as any;
        expect(alicePlan.roleAction).toBe('wait_for_tx_B_confirm');
        expect(alicePlan.flow).toBe('B');
        expect(alicePlan.txB).toBeDefined();
        expect(alicePlan.txA).toBeDefined();
        
        // Bob receives adaptor_ack -> emits ADAPTOR_READY then EXECUTION_PLANNED
        const bobFinalEvents = bob.handleIncoming(aliceAck!);
        expect(bobFinalEvents.some(e => e.kind === 'ADAPTOR_READY')).toBe(true);
        expect(bobFinalEvents.some(e => e.kind === 'EXECUTION_PLANNED')).toBe(true);
        expect(bob.getState()).toBe('EXECUTION_PLANNED');
        
        // Check Bob's roleAction
        const bobPlan = bobFinalEvents.find(e => e.kind === 'EXECUTION_PLANNED') as any;
        expect(bobPlan.roleAction).toBe('broadcast_tx_B');
        expect(bobPlan.flow).toBe('B');
        
        // Verify transcript hashes (should match if implemented correctly)
        expect(alice.getTranscriptHash()).toBe(bob.getTranscriptHash());
    });

    it('should abort if Bob sends invalid signature (Tamper)', () => {
        const { alice, bob, adaptorStartMsg } = setupAdaptor(true); // Tamper enabled
        
        // Bob receives adaptor_start -> sends TAMPERED adaptor_resp (via outboundMutator)
        const bobEvents = bob.handleIncoming(adaptorStartMsg);
        const bobResp = getNetOutMsgs(bobEvents).find(m => m.type === 'adaptor_resp');
        
        expect(bobResp).toBeDefined();
        
        // Verify that it IS tampered (optional, but good sanity check)
        // We know logical check: 
        // Alice receives tampered resp -> should abort
        const aliceEvents = alice.handleIncoming(bobResp!);
        
        expect(alice.getState()).toBe('ABORTED');
        const abortEvent = aliceEvents.find(e => e.kind === 'ABORTED');
        expect(abortEvent).toBeDefined();
        expect((abortEvent as any).message).toContain('Invalid adaptor sig');
    });

});
