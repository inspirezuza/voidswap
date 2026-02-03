import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime,
    type SessionRuntime,
    type SessionEvent,
    type HandshakeParams,
    type Message
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

// Helper to fast-forward to EXECUTION_PLANNED (copied and adapted from previous tests)
function setupExecPlanned(): { alice: SessionRuntime; bob: SessionRuntime } {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // -- Handshake --
    const ah = alice.startHandshake();
    const bh = bob.startHandshake();
    const aHello = getNetOutMsgs(ah)[0];
    const bHello = getNetOutMsgs(bh)[0];
    
    const ae1 = alice.handleIncoming(bHello);
    const be1 = bob.handleIncoming(aHello);
    const aAck = getNetOutMsgs(ae1)[0];
    const bAck = getNetOutMsgs(be1)[0];
    
    // -- Keygen --
    const be2 = bob.handleIncoming(aAck);
    const ae2 = alice.handleIncoming(bAck);
    
    let aliceAnnounce = getNetOutMsgs(ae2).find(m => m.type === 'keygen_announce');
    let bobAnnounce = getNetOutMsgs(be2).find(m => m.type === 'keygen_announce');
    
    const ae3 = alice.handleIncoming(bobAnnounce!);
    const be3 = bob.handleIncoming(aliceAnnounce!);
    
    // -- Capsules --
    const aliceOffer = getNetOutMsgs(ae3).find(m => m.type === 'capsule_offer');
    const bobOffer = getNetOutMsgs(be3).find(m => m.type === 'capsule_offer');
    
    const ae4 = alice.handleIncoming(bobOffer!);
    const be4 = bob.handleIncoming(aliceOffer!);
    
    const aliceAck = getNetOutMsgs(ae4).find(m => m.type === 'capsule_ack');
    const bobAck = getNetOutMsgs(be4).find(m => m.type === 'capsule_ack');
    
    alice.handleIncoming(bobAck!);
    bob.handleIncoming(aliceAck!);
    
    // -- Funding --
    // We cheat here and just assume funding is done
    const mpcA = alice.getMpcAddresses()!;
     const aFundTx = {
        type: 'funding_tx', from: 'alice', seq: 102, sid: alice.getSid()!, 
        payload: { which: 'mpc_Alice', txHash: '0x' + '1'.repeat(64), fromAddress: sampleParams.targetAlice, toAddress: mpcA.mpcAlice, valueWei: sampleParams.vA }
    };
    const bFundTx = {
        type: 'funding_tx', from: 'bob', seq: 102, sid: bob.getSid()!,
        payload: { which: 'mpc_Bob', txHash: '0x' + '2'.repeat(64), fromAddress: sampleParams.targetBob, toAddress: mpcA.mpcBob, valueWei: sampleParams.vB }
    };
    alice.emitFundingTx(aFundTx.payload as any);
    bob.emitFundingTx(bFundTx.payload as any);
    alice.handleIncoming(bFundTx as any);
    bob.handleIncoming(aFundTx as any);
    alice.notifyFundingConfirmed('mpc_Alice');
    alice.notifyFundingConfirmed('mpc_Bob');
    bob.notifyFundingConfirmed('mpc_Alice');
    bob.notifyFundingConfirmed('mpc_Bob');
    
    // -- Exec Prep --
    alice.setLocalNonceReport({ mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' });
    bob.setLocalNonceReport({ mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' });
    
    const aNonceMsg = { type: 'nonce_report', from: 'alice', seq: 103, sid: alice.getSid()!, payload: { mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' } };
    const bNonceMsg = { type: 'nonce_report', from: 'bob', seq: 103, sid: bob.getSid()!, payload: { mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' } };
    alice.handleIncoming(bNonceMsg as any);
    bob.handleIncoming(aNonceMsg as any);
    
    // Fee
    alice.proposeFeeParams({ maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '1', gasLimit: '21000', mode: 'fixed', proposer: 'alice' });
    const feeMsg = { type: 'fee_params', from: 'alice', seq: 104, sid: alice.getSid()!, payload: { maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '1', gasLimit: '21000', mode: 'fixed', proposer: 'alice' } };
    const beFees = bob.handleIncoming(feeMsg as any);
    const feeAck = getNetOutMsgs(beFees)[0];
    
    const aeFees = alice.handleIncoming(feeAck); 
    const aCommit = getNetOutMsgs(aeFees).find(m => m.type === 'tx_template_commit');
    const bCommit = getNetOutMsgs(beFees).find(m => m.type === 'tx_template_commit');
    
    const aeSync = alice.handleIncoming(bCommit!);
    const beSync = bob.handleIncoming(aCommit!);
    
    const aTemplateAck = getNetOutMsgs(aeSync).find(m => m.type === 'tx_template_ack');
    const bTemplateAck = getNetOutMsgs(beSync).find(m => m.type === 'tx_template_ack');
    
    const aePreAdaptor = alice.handleIncoming(bTemplateAck!);
    bob.handleIncoming(aTemplateAck!);
    
    // -- Adaptor Negotiation --
    const adaptorStarts = getNetOutMsgs(aePreAdaptor).filter(m => m.type === 'adaptor_start');
    
    const bobResponses: Message[] = [];
    for (const start of adaptorStarts) {
        const events = bob.handleIncoming(start);
        bobResponses.push(...getNetOutMsgs(events).filter(m => m.type === 'adaptor_resp'));
    }
    
    const aliceAcks: Message[] = [];
    for (const resp of bobResponses) {
        const events = alice.handleIncoming(resp);
        aliceAcks.push(...getNetOutMsgs(events).filter(m => m.type === 'adaptor_ack'));
    }
    
    for (const ack of aliceAcks) {
        bob.handleIncoming(ack);
    }
    
    return { alice, bob };
}

describe('Tx Hash Announcements (Hardened)', () => {
    it('TxB Broadcast: happy, duplicate', () => {
        const { alice, bob } = setupExecPlanned();
        const txHash = '0x' + '9'.repeat(64);
        
        // 1. Happy Path
        const announceEvents = alice.announceTxBHash(txHash);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];
        
        const bobEvents = bob.handleIncoming(broadcastMsg);
        expect(bobEvents.some(e => e.kind === 'TXB_HASH_RECEIVED')).toBe(true);
        expect((bobEvents.find(e => e.kind === 'TXB_HASH_RECEIVED') as any).txBHash).toBe(txHash);

        // 2. Duplicate
        const bobEvents2 = bob.handleIncoming(broadcastMsg);
        expect(bobEvents2.length).toBe(0);
    });

    it('TxB Broadcast: conflict', () => {
        const { alice, bob } = setupExecPlanned();
        const txHash = '0x' + '9'.repeat(64);
        
        // Setup initial state
        const announceEvents = alice.announceTxBHash(txHash);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];
        bob.handleIncoming(broadcastMsg);
        
        // Conflict
        const conflictMsg = { ...broadcastMsg, payload: { txHash: '0x' + '8'.repeat(64) } };
        const bobEvents = bob.handleIncoming(conflictMsg as any);
        const abort = bobEvents.find(e => e.kind === 'ABORTED') as any;
        expect(abort).toBeDefined();
        expect(abort.message).toContain('Conflicting txB hash');
    });

    it('TxB Broadcast: wrong sender', () => {
        const { alice, bob } = setupExecPlanned();
        const txHash = '0x' + '9'.repeat(64);
        const announceEvents = alice.announceTxBHash(txHash);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];

        // Wrong Sender (schema violation -> BAD_MESSAGE)
        const wrongSenderMsg = { ...broadcastMsg, from: 'bob' };
        const bobEvents = bob.handleIncoming(wrongSenderMsg as any);
        const abort = bobEvents.find(e => e.kind === 'ABORTED') as any;
        expect(abort).toBeDefined();
        // Zod validation failure msg 'Parse failed'
        expect(abort.code).toBe('BAD_MESSAGE');
    });

    it('TxA Broadcast: happy, duplicate', () => {
        const { alice, bob } = setupExecPlanned();
        const txHash = '0x' + '7'.repeat(64);
        
        // 1. Happy
        const announceEvents = bob.announceTxAHash(txHash);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];
        
        const aliceEvents = alice.handleIncoming(broadcastMsg);
        expect(aliceEvents.some(e => e.kind === 'TXA_HASH_RECEIVED')).toBe(true);
        expect((aliceEvents.find(e => e.kind === 'TXA_HASH_RECEIVED') as any).txAHash).toBe(txHash);

        // 2. Duplicate
        const aliceEvents2 = alice.handleIncoming(broadcastMsg);
        expect(aliceEvents2.length).toBe(0);
    });

    it('TxA Broadcast: conflict', () => {
        const { alice, bob } = setupExecPlanned();
        const txHash = '0x' + '7'.repeat(64);
        
        const announceEvents = bob.announceTxAHash(txHash);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];
        alice.handleIncoming(broadcastMsg);
        
        // Conflict
        const conflictMsg = { ...broadcastMsg, payload: { txHash: '0x' + '6'.repeat(64) } };
        const aliceEvents = alice.handleIncoming(conflictMsg as any);
        const abort = aliceEvents.find(e => e.kind === 'ABORTED') as any;
        expect(abort).toBeDefined();
        expect(abort.message).toContain('Conflicting txA hash');
    });

    it('TxA Broadcast: wrong sender', () => {
        const { alice, bob } = setupExecPlanned();
        const txHash = '0x' + '7'.repeat(64);
        const announceEvents = bob.announceTxAHash(txHash);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];
        
        // Wrong Sender
        const wrongSenderMsg = { ...broadcastMsg, from: 'alice' };
        const aliceEvents = alice.handleIncoming(wrongSenderMsg as any);
        const abort = aliceEvents.find(e => e.kind === 'ABORTED') as any;
        expect(abort).toBeDefined();
        expect(abort.code).toBe('BAD_MESSAGE');
    });
});
