import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHash } from 'crypto';

export interface MpcResult {
    address: string;
    commitments: {
        local: string;
        peer: string;
    };
}

export interface MpcKeyPair {
    address: string; // checksummed Ethereum address
    privKey: `0x${string}`; // 0x + 64 hex chars (32 bytes)
}

export interface MpcKeygenResult {
    mpcAlice: MpcKeyPair;
    mpcBob: MpcKeyPair;
}

/**
 * Derive a deterministic private key for MPC address.
 * privKey = keccak256("voidswap|mpc|{which}|{sid}")
 */
export function derivePrivKey(sid: string, which: 'mpc_Alice' | 'mpc_Bob'): `0x${string}` {
    const seed = `voidswap|mpc|${which}|${sid}`;
    return keccak256(toBytes(seed));
}

/**
 * Mock keygen with proper Ethereum address derivation from private key.
 * This ensures the address can be signed from using the corresponding private key.
 * 
 * WARNING: This exposes private keys - for anvil PoC only. Real MPC never exposes private keys.
 */
export function mockKeygenWithPriv(sid: string): MpcKeygenResult {
    const alicePriv = derivePrivKey(sid, 'mpc_Alice');
    const bobPriv = derivePrivKey(sid, 'mpc_Bob');
    
    const aliceAccount = privateKeyToAccount(alicePriv);
    const bobAccount = privateKeyToAccount(bobPriv);
    
    return {
        mpcAlice: { address: aliceAccount.address, privKey: alicePriv },
        mpcBob: { address: bobAccount.address, privKey: bobPriv }
    };
}

/**
 * Legacy mock keygen for backward compatibility.
 * Returns addresses derived from private keys (same as mockKeygenWithPriv).
 * 
 * @deprecated Use mockKeygenWithPriv for new code.
 */
export function mockKeygen(sid: string, role: string): MpcResult {
    const result = mockKeygenWithPriv(sid);
    const mpc = role === 'alice' ? result.mpcAlice : result.mpcBob;
    const seed = sid + role;
    
    return {
        address: mpc.address,
        commitments: { 
            local: '0x02' + createHash('sha256').update(seed + 'local').digest('hex'),
            peer: '0x02' + createHash('sha256').update(seed + 'peer').digest('hex')
        }
    };
}

export function mockYShare(sid: string, role: string): string {
    return '0x02' + createHash('sha256').update(sid + role + 'yshare').digest('hex');
}
