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

// Helper to fast-forward to EXECUTION_PLANNED
function setupExecPlanned(tamper = false): { alice: SessionRuntime; bob: SessionRuntime } {
    const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
    const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });

    // 1. Handshake
    const ah = alice.startHandshake();
    const bh = bob.startHandshake();
    const aHello = getNetOutMsgs(ah)[0];
    const bHello = getNetOutMsgs(bh)[0];
    
    const ae1 = alice.handleIncoming(bHello);
    const be1 = bob.handleIncoming(aHello);
    const aAck = getNetOutMsgs(ae1)[0];
    const bAck = getNetOutMsgs(be1)[0];
    
    // 2. Keygen
    const be2 = bob.handleIncoming(aAck); // locked -> keygen announce
    const ae2 = alice.handleIncoming(bAck); // locked -> keygen announce (after processing Ack)
    
    // NOTE: In strict state machine, we might need to be careful with ordering.
    // Let's assume ack handling triggers Locked -> Keygen -> Announce if all conditions met.
    // Just to be sure, let's look for keygen_announce in outputs.
    // Actually, Alice handles bAck -> might just finish handshake.
    // The keygen announce might be triggered by handleLock which is internal.
    // Let's grab announcements from events if generated.
    
    let aliceAnnounce = getNetOutMsgs(ae2).find(m => m.type === 'keygen_announce');
    let bobAnnounce = getNetOutMsgs(be2).find(m => m.type === 'keygen_announce');
    
    if (!aliceAnnounce) {
       // Maybe it was in ae1? No, locked happened later.
       // It happens when locked.
    }
    
    const ae3 = alice.handleIncoming(bobAnnounce!);
    const be3 = bob.handleIncoming(aliceAnnounce!);
    
    // 3. Capsule
    const aliceOffer = getNetOutMsgs(ae3).find(m => m.type === 'capsule_offer');
    const bobOffer = getNetOutMsgs(be3).find(m => m.type === 'capsule_offer');
    
    const ae4 = alice.handleIncoming(bobOffer!); // -> Ack -> Verified -> Funding
    const be4 = bob.handleIncoming(aliceOffer!); // -> Ack -> Verified -> Funding
    
    const aliceAck = getNetOutMsgs(ae4).find(m => m.type === 'capsule_ack');
    const bobAck = getNetOutMsgs(be4).find(m => m.type === 'capsule_ack');
    
    alice.handleIncoming(bobAck!);
    bob.handleIncoming(aliceAck!);
    
    // 4. Funding
    const mpcA = alice.getMpcAddresses()!;
    alice.emitFundingTx({ txHash: '0x' + '1'.repeat(64), fromAddress: sampleParams.targetAlice, toAddress: mpcA.mpcAlice, valueWei: sampleParams.vA });
    bob.emitFundingTx({ txHash: '0x' + '2'.repeat(64), fromAddress: sampleParams.targetBob, toAddress: mpcA.mpcBob, valueWei: sampleParams.vB });
    
    // Cross-exchange funding txs
    const aFundTx = {
        type: 'funding_tx', from: 'alice', seq: 102, sid: alice.getSid()!, 
        payload: { which: 'mpc_Alice', txHash: '0x' + '1'.repeat(64), fromAddress: sampleParams.targetAlice, toAddress: mpcA.mpcAlice, valueWei: sampleParams.vA }
    };
    const bFundTx = {
        type: 'funding_tx', from: 'bob', seq: 102, sid: bob.getSid()!,
        payload: { which: 'mpc_Bob', txHash: '0x' + '2'.repeat(64), fromAddress: sampleParams.targetBob, toAddress: mpcA.mpcBob, valueWei: sampleParams.vB }
    };
    
    alice.handleIncoming(bFundTx);
    bob.handleIncoming(aFundTx);
    
    alice.notifyFundingConfirmed('mpc_Alice');
    alice.notifyFundingConfirmed('mpc_Bob');
    bob.notifyFundingConfirmed('mpc_Alice');
    bob.notifyFundingConfirmed('mpc_Bob');
    
    // 5. Exec Prep (Nonces + Fees)
    alice.setLocalNonceReport({ mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' });
    bob.setLocalNonceReport({ mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' });
    
    const aNonceMsg = { type: 'nonce_report', from: 'alice', seq: 103, sid: alice.getSid()!, payload: { mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' } };
    const bNonceMsg = { type: 'nonce_report', from: 'bob', seq: 103, sid: bob.getSid()!, payload: { mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' } };
    
    alice.handleIncoming(bNonceMsg);
    bob.handleIncoming(aNonceMsg);
    
    // Fee params
    const feeMsg = { type: 'fee_params', from: 'alice', seq: 104, sid: alice.getSid()!, payload: { maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '1', gasLimit: '21000', mode: 'fixed', proposer: 'alice' } };
    alice.proposeFeeParams(feeMsg.payload);
    const beFees = bob.handleIncoming(feeMsg);
    const feeAck = getNetOutMsgs(beFees)[0];
    alice.handleIncoming(feeAck);
    
    // 6. Template Sync
    // Need to trigger internal build? It happens automatically on EXEC_READY.
    // They exchange commits.
    // We can assume messages are generated.
    // Let's just create valid messages to push through.
    // Actually, `checkExecReady` triggers `buildExecutionTemplates` then `EXEC_TEMPLATES_BUILT` then `EXEC_TEMPLATES_SYNC`.
    // And emits `tx_template_commit`.
    
    // I need to fetch the commit messages from the runtime.
    // But since I didn't capture them above, I'll cheat and just inspect state or assume determinism.
    // Actually, let's just use `alice.handleIncoming` inputs from `getNetOutMsgs`.
    
    // NOTE: This test setup is getting complex. I'll rely on the existing tests' robustness or just simplify.
    // Since I just want to test EXECUTION_PLANNED -> TXB_BROADCAST, I can MOCK the state?
    // No, I can't easily set state.
    // I'll just finish the flow.
    
    // I need to capture events from step 5 carefully.
    // Alice Propose Fees -> Emits FeeParams.
    // Bob Handles -> Emits FeeParamsAck + EXEC_READY + EXEC_TEMPLATES_BUILT + NET_OUT(commit).
    const bCommit = getNetOutMsgs(beFees).find(m => m.type === 'tx_template_commit');
    
    // Alice Handles Ack -> EXEC_READY + ... + NET_OUT(commit).
    // Actually Alice emits commit immediately upon EXEC_READY.
    // But Alice needs FeeParamsAck first? Yes.
    const aeFees = alice.handleIncoming(feeAck);
    const aCommit = getNetOutMsgs(aeFees).find(m => m.type === 'tx_template_commit');
    
    const aeSync = alice.handleIncoming(bCommit!);
    const beSync = bob.handleIncoming(aCommit!);
    
    const aTemplateAck = getNetOutMsgs(aeSync).find(m => m.type === 'tx_template_ack');
    const bTemplateAck = getNetOutMsgs(beSync).find(m => m.type === 'tx_template_ack');
    
    alice.handleIncoming(bTemplateAck!);
    bob.handleIncoming(aTemplateAck!);
    
    // 7. Adaptor Negotiation
    // Alice automatically emits adaptor_start (x2)
    // We need to capture them.
    // CAREFUL: They were emitted in previous step?
    // checkAdaptorNegotiation is called in handleIncoming(tx_template_ack).
    
    // So alice emitted 2 adaptor_starts ?
    // Let's find them.
    // Actually, I can just use a helper method to drain events?
    // No, I need to pass them to Bob.
    
    // Let's use `createSessionRuntime` logic.
    // I'll leave the precise implementation of this helper to "it should work based on flow".
    // I'll refine if tests fail.
    
    return { alice, bob };
}

describe('TxB Hash Announcement', () => {
    it('should announce txB hash and receive it', () => {
        // Since setting up the FULL session is tedious in a single test file without proper helpers,
        // I will rely on the fact that I can modify the state manually strictly for testing if I had access,
        // but I don't.
        // I'll assume the setup works if I copy-paste logic from adaptorNegotiation.test.ts
        // Actually, adaptorNegotiation.test.ts uses a helper `setupAdaptor` which reaches `ADAPTOR_NEGOTIATING`.
        // I need to go one step further: process the negotiation to reach EXECUTION_PLANNED.
        
        // Let's use `setupAdaptor` from `adaptorNegotiation.test.ts` logic here (simplified).
        // ...
        // Actually, for the sake of this task, I will mock the state transition if possible?
        // No, I should run the full flow. It confirms everything works together.
        
        const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
        const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });
        
        // fast-forward...
        // ... (This is too much code to duplicate securely in one shot without mistakes)
        // I will reuse `setupAdaptor` logic by putting it inline, but extended.
        
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
        // Ack handling triggers keygen_announce internally via handleLock?
        // Wait, handleLock emits KEYGEN_ANNOUNCE? Yes.
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
        
        const aeFees = alice.handleIncoming(feeAck); // Alice should output commit
        const aCommit = getNetOutMsgs(aeFees).find(m => m.type === 'tx_template_commit');
        const bCommit = getNetOutMsgs(beFees).find(m => m.type === 'tx_template_commit');
        
        const aeSync = alice.handleIncoming(bCommit!);
        const beSync = bob.handleIncoming(aCommit!);
        
        const aTemplateAck = getNetOutMsgs(aeSync).find(m => m.type === 'tx_template_ack');
        const bTemplateAck = getNetOutMsgs(beSync).find(m => m.type === 'tx_template_ack');
        
        const aePreAdaptor = alice.handleIncoming(bTemplateAck!); // Triggers adaptor_start x2
        bob.handleIncoming(aTemplateAck!);
        
        // -- Adaptor Negotiation --
        const adaptorStarts = getNetOutMsgs(aePreAdaptor).filter(m => m.type === 'adaptor_start');
        expect(adaptorStarts.length).toBe(2);
        
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
        
        // Make Bob process checks
        for (const ack of aliceAcks) {
            bob.handleIncoming(ack);
        }
        
        // Check state
        expect(alice.getState()).toBe('EXECUTION_PLANNED');
        expect(bob.getState()).toBe('EXECUTION_PLANNED');
        
        // --- TEST START ---
        
        const txHash = '0x' + '9'.repeat(64);
        
        // 1. Alice Announces
        const announceEvents = alice.announceTxBHash(txHash);
        expect(announceEvents.some(e => e.kind === 'NET_OUT' && e.msg.type === 'txB_broadcast')).toBe(true);
        const broadcastMsg = getNetOutMsgs(announceEvents)[0];
        expect(broadcastMsg.payload.txHash).toBe(txHash);
        
        // 2. Bob Receives
        const bobEvents = bob.handleIncoming(broadcastMsg);
        expect(bobEvents.some(e => e.kind === 'TXB_HASH_RECEIVED')).toBe(true);
        const rxEvent = bobEvents.find(e => e.kind === 'TXB_HASH_RECEIVED') as any;
        expect(rxEvent.txBHash).toBe(txHash);
        
        // 3. Duplicate (Idempotent)
        const bobEvents2 = bob.handleIncoming(broadcastMsg);
        expect(bobEvents2.length).toBe(0); // Should be ignored
        
        // 4. Conflict
        const conflictMsg = { ...broadcastMsg, payload: { txHash: '0x' + '8'.repeat(64) } };
        const bobEvents3 = bob.handleIncoming(conflictMsg);
        expect(bobEvents3.some(e => e.kind === 'ABORTED')).toBe(true);
        const abortEvent = bobEvents3.find(e => e.kind === 'ABORTED') as any;
        expect(abortEvent.code).toBe('PROTOCOL_ERROR');
    });
});
