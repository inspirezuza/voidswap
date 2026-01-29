/**
 * CLI Argument Parsing
 * 
 * Parses command line arguments for the voidswap client.
 */

import { HandshakeParamsSchema, type HandshakeParams } from '@voidswap/protocol';

export type Role = 'alice' | 'bob';
export type TamperField = 'vA' | 'targetAlice' | 'none';

export interface CliArgs {
  role: Role;
  room: string;
  relay: string;
  params: HandshakeParams;
  tamper: TamperField;
  tamperCapsule: boolean;
  verbose: boolean;
}

/**
 * Parse command line arguments
 */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  
  // Defaults
  let role: Role | undefined;
  let room: string | undefined;
  let relay = 'ws://localhost:8787';
  let chainId = 1;
  let drandChainId = 'fastnet';
  let vA = '1000000000000000000';
  let vB = '2000000000000000000';
  let targetAlice = '0x1234567890123456789012345678901234567890';
  let targetBob = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  let rBRefund = 1000;
  let rARefund = 2000;
  let tamper: TamperField = 'none';

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--role':
        if (next !== 'alice' && next !== 'bob') {
          throw new Error('--role must be "alice" or "bob"');
        }
        role = next;
        i++;
        break;
      case '--room':
        room = next;
        i++;
        break;
      case '--relay':
        relay = next;
        i++;
        break;
      case '--chainId':
        chainId = parseInt(next, 10);
        i++;
        break;
      case '--drandChainId':
        drandChainId = next;
        i++;
        break;
      case '--vA':
        vA = next;
        i++;
        break;
      case '--vB':
        vB = next;
        i++;
        break;
      case '--targetAlice':
        targetAlice = next;
        i++;
        break;
      case '--targetBob':
        targetBob = next;
        i++;
        break;
      case '--rBRefund':
        rBRefund = parseInt(next, 10);
        i++;
        break;
      case '--rARefund':
        rARefund = parseInt(next, 10);
        i++;
        break;
      case '--tamper':
        if (next !== 'vA' && next !== 'targetAlice' && next !== 'none') {
          throw new Error('--tamper must be "vA", "targetAlice", or "none"');
        }
        tamper = next;
        i++;
        break;
    }
  }

  // Validate required args
  if (!role) {
    throw new Error('--role is required (alice or bob)');
  }
  if (!room) {
    throw new Error('--room is required');
  }

  // Check for specialized flags
  const tamperCapsule = argv.includes('--tamperCapsule');
  const verbose = argv.includes('--verbose');

  // Build and validate HandshakeParams
  const params = HandshakeParamsSchema.parse({
    version: 'voidswap-v1',
    chainId,
    drandChainId,
    vA,
    vB,
    targetAlice,
    targetBob,
    rBRefund,
    rARefund,
  });

  return { role, room, relay, params, tamper, tamperCapsule, verbose };
}

/**
 * Apply tamper mutation to params (for testing mismatch)
 */
export function applyTamper(params: HandshakeParams, tamper: TamperField): HandshakeParams {
  if (tamper === 'none') {
    return params;
  }

  const mutated = { ...params };

  switch (tamper) {
    case 'vA':
      // Modify vA to cause mismatch
      mutated.vA = '999999999999999999';
      break;
    case 'targetAlice':
      // Modify targetAlice to cause mismatch
      mutated.targetAlice = '0x0000000000000000000000000000000000000001';
      break;
  }

  return mutated;
}
