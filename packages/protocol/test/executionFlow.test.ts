import { describe, it, expect } from 'vitest';
import {
    createSessionRuntime, type SessionEvent,
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

describe('Full Execution Flow', () => {
    it('should complete full exchange announcement cycle', () => {
        // -- Setup --
        const alice = createSessionRuntime({ role: 'alice', params: sampleParams, localNonce: aliceNonce });
        const bob = createSessionRuntime({ role: 'bob', params: sampleParams, localNonce: bobNonce });
        
        // Handshake
        const ah = alice.startHandshake();
        const bh = bob.startHandshake();
        const aHello = getNetOutMsgs(ah)[0];
        const bHello = getNetOutMsgs(bh)[0];
        
        const ae1 = alice.handleIncoming(bHello);
        const be1 = bob.handleIncoming(aHello);
        
        const aAckEvt = getNetOutMsgs(ae1)[0]; 
        const bAck = getNetOutMsgs(be1)[0];
        
        // Keygen
        const ae2 = alice.handleIncoming(bAck);
        const be2 = bob.handleIncoming(aAckEvt);
        
        let msgsA = getNetOutMsgs(ae2);
        let msgsB = getNetOutMsgs(be2);
        
        let aAnnounce = msgsA.find(m => m.type === 'keygen_announce');
        let bAnnounce = msgsB.find(m => m.type === 'keygen_announce');
        
        const ae3 = alice.handleIncoming(bAnnounce!);
        const be3 = bob.handleIncoming(aAnnounce!);
        
        // Capsule
        const aOffer = getNetOutMsgs(ae3).find(m => m.type === 'capsule_offer');
        const bOffer = getNetOutMsgs(be3).find(m => m.type === 'capsule_offer');
        
        const ae4 = alice.handleIncoming(bOffer!);
        const be4 = bob.handleIncoming(aOffer!);
        
        const aCapAck = getNetOutMsgs(ae4).find(m => m.type === 'capsule_ack');
        const bCapAck = getNetOutMsgs(be4).find(m => m.type === 'capsule_ack');
        
        alice.handleIncoming(bCapAck!);
        bob.handleIncoming(aCapAck!);
        
        // Funding
        const mpcA = alice.getMpcAddresses()!;
        const valAliceEmit = alice.emitFundingTx({ txHash: '0x' + '1'.repeat(64), fromAddress: sampleParams.targetAlice, toAddress: mpcA.mpcAlice, valueWei: sampleParams.vA });
        const valBobEmit = bob.emitFundingTx({ txHash: '0x' + '2'.repeat(64), fromAddress: sampleParams.targetBob, toAddress: mpcA.mpcBob, valueWei: sampleParams.vB });
        
        const aFundTx = getNetOutMsgs(valAliceEmit).find(m => m.type === 'funding_tx');
        const bFundTx = getNetOutMsgs(valBobEmit).find(m => m.type === 'funding_tx');
        
        alice.handleIncoming(bFundTx!);
        bob.handleIncoming(aFundTx!);
        
        alice.notifyFundingConfirmed('mpc_Alice');
        alice.notifyFundingConfirmed('mpc_Bob');
        bob.notifyFundingConfirmed('mpc_Alice');
        bob.notifyFundingConfirmed('mpc_Bob');
        
        // Exec Prep
        const aSetNonce = alice.setLocalNonceReport({ mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' });
        const bSetNonce = bob.setLocalNonceReport({ mpcAliceNonce: '0', mpcBobNonce: '0', blockNumber: '1', rpcTag: 'latest' });
        
        const bNonceMsg = getNetOutMsgs(bSetNonce).find(m => m.type === 'nonce_report');
        const aNonceMsg = getNetOutMsgs(aSetNonce).find(m => m.type === 'nonce_report');
        
        alice.handleIncoming(bNonceMsg!);
        bob.handleIncoming(aNonceMsg!);
        
        const aPropose = alice.proposeFeeParams({ maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '1', gasLimit: '21', mode: 'fixed', proposer: 'alice' });
        const fMsg = getNetOutMsgs(aPropose).find(m => m.type === 'fee_params');
        
        const beFees = bob.handleIncoming(fMsg!);
        const feeAck = getNetOutMsgs(beFees)[0];
        
        const aeFees = alice.handleIncoming(feeAck);
        const aCommit = getNetOutMsgs(aeFees).find(m => m.type === 'tx_template_commit');
        const bCommit = getNetOutMsgs(beFees).find(m => m.type === 'tx_template_commit');
        
        const aeSync = alice.handleIncoming(bCommit!);
        const beSync = bob.handleIncoming(aCommit!);
        
        const aTempAck = getNetOutMsgs(aeSync).find(m => m.type === 'tx_template_ack');
        const bTempAck = getNetOutMsgs(beSync).find(m => m.type === 'tx_template_ack');
        
        bob.handleIncoming(aTempAck!);
        const aeAdapt = alice.handleIncoming(bTempAck!); 
        
        // Adaptor Neg
        const adaptorStarts = getNetOutMsgs(aeAdapt).filter(m => m.type === 'adaptor_start');
        
        let bobResps: Message[] = [];
        for (const start of adaptorStarts) {
            const evs = bob.handleIncoming(start);
            bobResps.push(...getNetOutMsgs(evs).filter(m => m.type === 'adaptor_resp'));
        }
        
        let aliceAcks: Message[] = [];
        for (const resp of bobResps) {
            const evs = alice.handleIncoming(resp);
            aliceAcks.push(...getNetOutMsgs(evs).filter(m => m.type === 'adaptor_ack'));
        }
        
        for (const ack of aliceAcks) {
            bob.handleIncoming(ack);
        }
        
        expect(alice.getState()).toBe('EXECUTION_PLANNED');
        expect(bob.getState()).toBe('EXECUTION_PLANNED');
        
        const txB = '0x' + 'b'.repeat(64);
        const txA = '0x' + 'a'.repeat(64); 
        
        // 1. Alice Announces txB
        const aAnnEvents = alice.announceTxBHash(txB);
        const txBMsg = getNetOutMsgs(aAnnEvents).find(m => m.type === 'txB_broadcast');
        expect(txBMsg).toBeDefined();
        
        // 2. Bob Receives txB
        const bRxEvents = bob.handleIncoming(txBMsg!);
        expect(bRxEvents.some(e => e.kind === 'TXB_HASH_RECEIVED' && e.txBHash === txB)).toBe(true);
        expect(bob.getState()).toBe('EXECUTION_PLANNED'); 
        
        // 3. Bob Announces txA
        const bAnnEvents = bob.announceTxAHash(txA);
        const txAMsg = getNetOutMsgs(bAnnEvents).find(m => m.type === 'txA_broadcast');
        expect(txAMsg).toBeDefined();
        expect(txAMsg!.payload.txHash).toBe(txA);
        
        // 4. Alice Receives txA
        const aRxEvents = alice.handleIncoming(txAMsg!);
        expect(aRxEvents.some(e => e.kind === 'TXA_HASH_RECEIVED' && e.txAHash === txA)).toBe(true);
        
        // 5. Conflict Checks
        const badTxB = { ...txBMsg!, payload: { ...txBMsg!.payload, txHash: '0x' + 'c'.repeat(64) } };
        expect(bob.handleIncoming(badTxB).some(e => e.kind === 'ABORTED')).toBe(true);
        
        const badTxA = { ...txAMsg!, payload: { ...txAMsg!.payload, txHash: '0x' + 'd'.repeat(64) } };
        expect(alice.handleIncoming(badTxA).some(e => e.kind === 'ABORTED')).toBe(true);
    });
});
