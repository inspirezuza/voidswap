/**
 * Voidswap Client CLI
 * 
 * Main entry point that wires together CLI parsing, transport, and handshake.
 */

import { parseArgs, applyTamper } from './cli.js';
import { Transport } from './transport.js';
import { Session } from './handshake.js';
import type { Message, MpcResult } from '@voidswap/protocol';

function log(message: string) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${message}`);
}

async function main() {
  try {
    // Parse CLI arguments
    const args = parseArgs(process.argv);
    
    log(`Role: ${args.role}`);
    log(`Room: ${args.room}`);
    log(`Relay: ${args.relay}`);
    
    // Apply tamper if bob and tamper is set
    let params = args.params;
    if (args.role === 'bob' && args.tamper !== 'none') {
      log(`⚠️ TAMPER MODE: Mutating ${args.tamper}`);
      params = applyTamper(params, args.tamper);
    }

    // Track if handshake has started (wait for peer)
    let handshakeStarted = false;

    // Create handshake handler
    let transport: Transport;
    
    const session = new Session(args.role, params, {
      onSendMessage: (msg: Message) => {
        transport.sendPayload(msg);
      },
      onLocked: (sid: string, transcriptHash: string) => {
        log('');
        log('='.repeat(60));
        log(`STATE: SESSION_LOCKED`);
        log(`sid=${sid}`);
        log(`transcriptHash=${transcriptHash}`);
        log('='.repeat(60));
        log('');
      },
      onKeygenComplete: (sid: string, transcriptHash: string, mpcAlice: MpcResult, mpcBob: MpcResult) => {
        log('');
        log('='.repeat(60));
        log(`STATE: KEYGEN_COMPLETE`);
        if (args.verbose) {
           log(`sid=${sid}`);
           log(`transcriptHash=${transcriptHash}`);
           log('-'.repeat(60));
        }
        log(`Alice Address: ${mpcAlice.address}`);
        log(`Bob Address:   ${mpcBob.address}`);
        log('='.repeat(60));
        log('');
      },
      onCapsulesVerified: (sid: string, transcriptHash: string) => {
        log('');
        log('='.repeat(60));
        log(`STATE: CAPSULES_VERIFIED`);
        if (args.verbose) {
           log(`sid=${sid}`);
           log(`transcriptHash=${transcriptHash}`);
           log('-'.repeat(60));
        }
        log('REFUND CAPSULES EXCHANGED AND VERIFIED. SECURE TO FUND.');
        log('='.repeat(60));
        log('');

        // Exit after a short delay
        setTimeout(() => {
          transport.close();
          process.exit(0);
        }, 500);
      },
      onAbort: (code: string, message: string) => {
        log('');
        log('='.repeat(60));
        log(`STATE: ABORTED`);
        log(`code=${code}`);
        log(`message=${message}`);
        log('='.repeat(60));
        log('');
        
        transport.close();
        process.exit(1);
      },
      onLog: (message: string) => {
        log(message);
      },
    }, args.tamperCapsule);

    // Helper: start handshake if not already started
    function tryStartHandshake(memberCount: number) {
      if (handshakeStarted) {
        return;
      }

      if (memberCount >= 2) {
        handshakeStarted = true;
        session.start();
      } else {
        log(`Waiting for peer... (memberCount=${memberCount})`);
      }
    }

    // Create transport
    transport = new Transport(args.relay, args.room, {
      onJoined: (clientId: string, memberCount: number) => {
        log(`Connected to relay, clientId=${clientId}`);
        log(`Joined room: ${args.room} (members=${memberCount})`);
        
        // Only start handshake if peer is already present
        tryStartHandshake(memberCount);
      },
      onPeerJoined: (peerId: string, memberCount: number) => {
        log(`Peer joined: ${peerId} (members=${memberCount})`);
        
        // Start handshake when peer arrives
        tryStartHandshake(memberCount);
      },
      onPeerPayload: (payload: unknown) => {
        session.handleIncoming(payload);
      },
      onError: (error: Error) => {
        log(`Error: ${error.message}`);
        process.exit(1);
      },
      onClose: () => {
        log('Connection closed');
      },
    });

  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    console.error('');
    console.error('Usage: pnpm dev -- --role <alice|bob> --room <room-name> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --role          Required. alice or bob');
    console.error('  --room          Required. Room name to join');
    console.error('  --relay         Relay URL (default: ws://localhost:8787)');
    console.error('  --chainId       Chain ID (default: 1)');
    console.error('  --drandChainId  Drand chain ID (default: fastnet)');
    console.error('  --vA            Alice value (default: 1000000000000000000)');
    console.error('  --vB            Bob value (default: 2000000000000000000)');
    console.error('  --targetAlice   Alice target address');
    console.error('  --targetBob     Bob target address');
    console.error('  --rBRefund      Bob refund round (default: 1000)');
    console.error('  --rARefund      Alice refund round (default: 2000)');
    console.error('  --tamper        For testing: vA, targetAlice, or none (default: none)');
    process.exit(1);
  }
}

main();
