/**
 * Example: Compute SID for a sample handshake
 * 
 * Run with: pnpm -C packages/protocol example:sid
 */

import {
    computeSid,
    hashHandshake,
    validateRefundOrder,
    type HandshakeParams,
} from '../src/index.js';

// Sample handshake parameters
const handshake: HandshakeParams = {
  version: 'voidswap-v1',
  chainId: 1, // Ethereum mainnet
  drandChainId: 'fastnet',
  vA: '1000000000000000000', // 1 ETH in wei
  vB: '2000000000000000000', // 2 ETH in wei
  targetAlice: '0x1234567890123456789012345678901234567890',
  targetBob: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  rBRefund: 1000, // Bob's refund round
  rARefund: 2000, // Alice's refund round
};

// Sample nonces (in real usage, these would be cryptographically random)
const aliceNonce = '0x' + 'a1b2c3d4e5f6'.repeat(10) + 'a1b2c3d4';
const bobNonce = '0x' + 'f6e5d4c3b2a1'.repeat(10) + 'f6e5d4c3';

console.log('='.repeat(60));
console.log('Voidswap SID Computation Example');
console.log('='.repeat(60));

console.log('\n📋 Handshake Parameters:');
console.log(JSON.stringify(handshake, null, 2));

console.log('\n🎲 Nonces:');
console.log(`  Alice: ${aliceNonce}`);
console.log(`  Bob:   ${bobNonce}`);

console.log('\n🔐 Computed Values:');
console.log(`  Handshake Hash: ${hashHandshake(handshake)}`);
console.log(`  Session ID:     ${computeSid(handshake, aliceNonce, bobNonce)}`);

console.log('\n✅ Refund Order Valid:', validateRefundOrder(handshake));
console.log('   (rBRefund < rARefund):', handshake.rBRefund, '<', handshake.rARefund);

console.log('\n' + '='.repeat(60));
