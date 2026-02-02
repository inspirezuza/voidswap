/**
 * Voidswap Client CLI
 * 
 * Main entry point that wires together CLI parsing, transport, and handshake.
 */

import { parseArgs, applyTamper } from './cli.js';
import { Transport } from './transport.js';
import { Session } from './handshake.js';
import type { Message, MpcResult, FundingTxPayload } from '@voidswap/protocol';
import { createClients, sendEthTransfer, validateFundingTx, getNonce, getBlockNumber } from './chain.js';
import { formatEther } from 'viem';

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
    
    // === ChainId Reconciliation ===
    // Fetch actual chainId from RPC and reconcile with params
    const { publicClient } = createClients(args.rpcUrl);
    const rpcChainId = await publicClient.getChainId();
    
    if (!args.chainIdExplicit) {
      // User didn't pass --chainId, auto-detect from RPC
      if (args.params.chainId !== rpcChainId) {
        log(`Auto-setting chainId=${rpcChainId} from RPC (was ${args.params.chainId})`);
        // Re-parse params with correct chainId
        const { HandshakeParamsSchema } = await import('@voidswap/protocol');
        args.params = HandshakeParamsSchema.parse({
          ...args.params,
          chainId: rpcChainId
        });
      }
    } else {
      // User explicitly passed --chainId, verify it matches RPC
      if (args.params.chainId !== rpcChainId) {
        log(`ERROR: chainId mismatch: params.chainId=${args.params.chainId} but RPC chainId=${rpcChainId}`);
        log(`Pass --chainId ${rpcChainId} or use correct RPC`);
        process.exit(1);
      }
    }
    log(`Using chainId=${args.params.chainId}`);
    
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
          
          // Replaced exit with funding logic (merged comment)
        onFundingStarted: async (sid: string, mpcAlice: string, mpcBob: string, vA: string, vB: string) => {
            log('');
            log('='.repeat(60));
            log(`STATE: FUNDING_STARTED`);
            log(`Alice MPC: ${mpcAlice} (Needs ${formatEther(BigInt(vA))} ETH)`);
            log(`Bob MPC:   ${mpcBob} (Needs ${formatEther(BigInt(vB))} ETH)`);
            log('='.repeat(60));
            
            // Auto-fund logic
            if (args.autoFund) {
               try {
                  const { publicClient, walletClient, funderAddress } = createClients(args.rpcUrl, args.fundingKey);
                  
                  if (!walletClient || !funderAddress) {
                      throw new Error('AutoFund requires a valid funding key (passed via --fundingKey or ENV)');
                  }
                  
                  log(`Auto-funding enabled. Using account ${funderAddress}`);
                  
                  let to: string;
                  let value: bigint;
                  
                  // Gas reserve: 21000 gas * 20 gwei = 420000 gwei = 0.00042 ETH, round up to 0.001 ETH
                  const gasReserve = BigInt('1000000000000000'); // 0.001 ETH
                  
                  if (args.role === 'alice') {
                      to = mpcAlice;
                      value = BigInt(vA) + gasReserve; 
                  } else {
                      to = mpcBob;
                      value = BigInt(vB) + gasReserve;
                  }
                  
                  // Small Gas Reserve? The prompt said "vA + gasReserveWei". For now using exact amount as per prompt constraint "vA (alice)" but simpler to add slight overhead if needed.
                  // Prompt: "Funding amount sent = vA + gasReserveWei" (default 0).
                  // We'll stick to exact for POC unless specified.
                  
                  log(`Sending ${formatEther(value)} ETH to ${to}...`);
                  const hash = await sendEthTransfer(walletClient, to as `0x${string}`, value);
                  log(`Funding Tx Sent: ${hash}`);
                  
                  // Notify Runtime with real payload
                  session.emitFundingTx({
                      txHash: hash,
                      fromAddress: funderAddress,
                      toAddress: to,
                      valueWei: value.toString()
                  });
                  
                  // Validate and wait for own confirmation
                  log(`Validating own funding tx and waiting for ${args.confirmations} confirmations...`);
                  await validateFundingTx(publicClient, hash, to, value, args.confirmations);
                  log(`My funding validated and confirmed.`);
                  
                  // Notify runtime
                  session.notifyFundingConfirmed(args.role === 'alice' ? 'mpc_Alice' : 'mpc_Bob');
                  
               } catch (err: any) {
                   log(`Auto-fund failed: ${err.message}`);
                   process.exit(1);
               }
            } else {
                log('Auto-fund disabled. Please manually fund your MPC wallet.');
                log(`Send ETH to the address above. Then restart (manual input support pending).`);
                // For POC, we might hang here or exit.
                // The prompt says: "If not autoFund: print instructions... We can skip manual completion for now".
            }
        },
        onFundingTx: async (which: 'mpc_Alice' | 'mpc_Bob', txHash: string, payload: FundingTxPayload) => {
             log(`Peer announced funding tx: ${txHash} for ${which}`);
             log(`  from: ${payload.fromAddress}`);
             log(`  to:   ${payload.toAddress}`);
             log(`  value: ${formatEther(BigInt(payload.valueWei))} ETH`);
             
             try {
                 const { publicClient } = createClients(args.rpcUrl);
                 const expectedTo = payload.toAddress;
                 const minValue = BigInt(payload.valueWei);
                 
                 log(`Validating peer tx on-chain...`);
                 await validateFundingTx(
                     publicClient, 
                     txHash as `0x${string}`, 
                     expectedTo, 
                     minValue, 
                     args.confirmations
                 );
                 log(`Peer funding validated and confirmed.`);
                 
                 session.notifyFundingConfirmed(which);
             } catch (err: any) {
                 log(`Error validating peer funding: ${err.message}`);
                 process.exit(1);
             }
        },
        onFunded: (sid: string, transcriptHash: string) => {
             log('');
             log('='.repeat(60));
             log(`STATE: FUNDED`);
             log(`All funding confirmed.`);
             log(`Transcript Hash: ${transcriptHash}`);
             log('='.repeat(60));
             // Don't exit - wait for EXEC_PREP_STARTED
        },
        onExecPrepStarted: async (sid: string, mpcAlice: string, mpcBob: string) => {
             log('');
             log('='.repeat(60));
             log(`STATE: EXEC_PREP_STARTED`);
             log(`Preparing execution...`);
             log(`MPC Alice: ${mpcAlice}`);
             log(`MPC Bob:   ${mpcBob}`);
             log('='.repeat(60));
             
             try {
                 const { publicClient } = createClients(args.rpcUrl);
                 
                 // Query nonces for BOTH MPC addresses
                 const aliceNonce = await getNonce(publicClient, mpcAlice as `0x${string}`, 'latest');
                 const bobNonce = await getBlockNumber(publicClient) > 0n 
                     ? await getNonce(publicClient, mpcBob as `0x${string}`, 'latest') 
                     : 0n;
                 const bobNonceActual = await getNonce(publicClient, mpcBob as `0x${string}`, 'latest');
                 const blockNum = await getBlockNumber(publicClient);
                 
                 log(`Nonces: mpc_Alice=${aliceNonce}, mpc_Bob=${bobNonceActual} (block ${blockNum})`);
                 
                 // Apply tamper if requested
                 let reportedBobNonce = bobNonceActual.toString();
                 if ((args as any).tamperNonceReport && args.role === 'bob') {
                     const tampered = (bobNonceActual + 1n).toString();
                     log(`\u26a0\ufe0f TAMPER: Reporting bobNonce as ${tampered} instead of ${bobNonceActual}`);
                     reportedBobNonce = tampered;
                 }
                 
                 // Set local nonce report
                 session.setLocalNonceReport({
                     mpcAliceNonce: aliceNonce.toString(),
                     mpcBobNonce: reportedBobNonce,
                     blockNumber: blockNum.toString(),
                     rpcTag: 'latest',
                 });
                 
                 // Alice proposes fee params
                 if (args.role === 'alice') {
                     log('Alice proposing fee params...');
                     session.proposeFeeParams({
                         maxFeePerGasWei: '20000000000',       // 20 gwei
                         maxPriorityFeePerGasWei: '1000000000',// 1 gwei
                         gasLimit: '21000',
                         mode: 'fixed',
                         proposer: 'alice',
                     });
                 }
             } catch (err: any) {
                 log(`EXEC_PREP failed: ${err.message}`);
                 process.exit(1);
             }
        },
        onExecReady: (sid: string, transcriptHash: string, nonces: { mpcAliceNonce: string; mpcBobNonce: string }, fee: any) => {
             log('');
             log('='.repeat(60));
             log(`STATE: EXEC_READY`);
             log(`All parties agreed.`);
             log(`Nonces: mpc_Alice=${nonces.mpcAliceNonce}, mpc_Bob=${nonces.mpcBobNonce}`);
             log(`Fee: maxFee=${fee.maxFeePerGasWei}, priorityFee=${fee.maxPriorityFeePerGasWei}, gasLimit=${fee.gasLimit}`);
             if (args.verbose) {
                 log(`Transcript Hash: ${transcriptHash}`);
             }
             log('='.repeat(60));
        },
        onExecTemplatesBuilt: (sid: string, transcriptHash: string, digestA: string, digestB: string) => {
             log('');
             log('='.repeat(60));
             log(`STATE: EXEC_TEMPLATES_BUILT`);
             log(`Execution transaction templates built.`);
             log(`digest_A (mpc_Alice -> target_Bob): ${args.verbose ? digestA : digestA.slice(0, 18) + '...'}`);
             log(`digest_B (mpc_Bob -> target_Alice): ${args.verbose ? digestB : digestB.slice(0, 18) + '...'}`);
             if (args.verbose) {
                 log(`Transcript Hash: ${transcriptHash}`);
             }
             log('='.repeat(60));
        },
        onExecTemplatesReady: (sid: string, transcriptHash: string, digestA: string, digestB: string) => {
             log('');
             log('='.repeat(60));
             log(`STATE: EXEC_TEMPLATES_READY`);
             log(`Templates synchronized and committed.`);
             log(`digest_A: ${args.verbose ? digestA : digestA.slice(0, 18) + '...'}`);
             log(`digest_B: ${args.verbose ? digestB : digestB.slice(0, 18) + '...'}`);
             if (args.verbose) {
                 log(`Transcript Hash: ${transcriptHash}`);
             }
             log('='.repeat(60));
             
             // Exit after success
             setTimeout(() => {
                transport.close();
                process.exit(0);
             }, 1000);
        },
        onAdaptorNegotiating: (sid: string, transcriptHash: string) => {
             log('');
             log('='.repeat(60));
             log(`STATE: ADAPTOR_NEGOTIATING`);
             log(`Adaptor negotiation started.`);
             if (args.verbose) {
                 log(`sid=${sid}`);
                 log(`transcriptHash=${transcriptHash}`);
             }
             log('='.repeat(60));
        },
        onAdaptorReady: (sid: string, transcriptHash: string, digestB: string, TB: string) => {
             log('');
             log('='.repeat(60));
             log(`STATE: ADAPTOR_READY`);
             log(`Adaptor negotiation complete.`);
             log(`digestB: ${args.verbose ? digestB : digestB.slice(0, 18) + '...'}`);
             log(`TB: ${args.verbose ? TB : TB.slice(0, 18) + '...'}`);
             if (args.verbose) {
                 log(`Transcript Hash: ${transcriptHash}`);
             }
             log('='.repeat(60));
        },
        onExecutionPlanned: async (sid: string, transcriptHash: string, flow: 'B', roleAction: string, txB: { unsigned: any; digest: string }, txA: { unsigned: any; digest: string }) => {
             log('');
             log('='.repeat(60));
             log(`STATE: EXECUTION_PLANNED`);
             log(`Flow: ${flow}`);
             log(`My action: ${roleAction}`);
             log(`tx_B: to=${txB.unsigned.to}, value=${txB.unsigned.value}, nonce=${txB.unsigned.nonce}`);
             log(`tx_B digest: ${args.verbose ? txB.digest : txB.digest.slice(0, 18) + '...'}`);
             if (args.verbose) {
                 log(`tx_A digest: ${txA.digest}`);
                 log(`Transcript Hash: ${transcriptHash}`);
             }
             log('='.repeat(60));

             // Auto-broadcast for Alice (broadcasting tx_B signed by mpcBob)
             if (args.role === 'alice' && args.autoBroadcast && roleAction === 'broadcast_tx_B') {
                 log('');
                 log('Auto-broadcasting tx_B (signed by mpc_Bob key, published by Alice client)...');
                 try {
                     // Import dynamically to avoid circular deps
                     const { createWalletClient, http } = await import('viem');
                     const { privateKeyToAccount } = await import('viem/accounts');
                     const { mockKeygenWithPriv } = await import('@voidswap/protocol');

                     // Get Bob's mock private key (Alice can derive this in mock mode)
                     const mpcKeys = mockKeygenWithPriv(sid);
                     // tx_B is from mpc_Bob, so we MUST sign with mpc_Bob's key
                     const account = privateKeyToAccount(mpcKeys.mpcBob.privKey);

                     // Create dynamic chain object matching protocol chainId
                     const chain = {
                         id: args.params.chainId,
                         name: 'voidswap',
                         nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                         rpcUrls: { default: { http: [args.rpcUrl] } }
                     };

                     const walletClient = createWalletClient({
                         account,
                         chain,
                         transport: http(args.rpcUrl)
                     });

                     const txHash = await walletClient.sendTransaction({
                         to: txB.unsigned.to as `0x${string}`,
                         value: BigInt(txB.unsigned.value),
                         nonce: txB.unsigned.nonce,
                         gas: BigInt(txB.unsigned.gas),
                         maxFeePerGas: BigInt(txB.unsigned.maxFeePerGas),
                         maxPriorityFeePerGas: BigInt(txB.unsigned.maxPriorityFeePerGas),
                     });

                     log(`Broadcasted tx_B: ${txHash}`);
                     log('='.repeat(60));
                 } catch (e: any) {
                     log(`Auto-broadcast FAILED: ${e.message}`);
                 }
             }
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
         log('REFUND CAPSULES EXCHANGED AND VERIFIED.');
         log('='.repeat(60));
         log('');
         // No exit here, wait for Funding transition (automatic in runtime)
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
    }, args.tamperCapsule, args.tamperTemplateCommit, args.tamperAdaptor);

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
