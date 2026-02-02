import { createHash } from 'crypto';

export interface MpcResult {
    address: string;
    commitments: {
        local: string;
        peer: string;
    };
}

export interface MpcResultWithPriv extends MpcResult {
    privKey: string; // 0x + 64 hex chars (32 bytes)
}

/**
 * Mock keygen: derives deterministic address from sid+role.
 * Address is SHA-1 based (20 bytes).
 */
export function mockKeygen(sid: string, role: string): MpcResult {
    const seed = sid + role;
    return {
        address: '0x' + createHash('sha1').update(seed).digest('hex'),
        commitments: { 
            local: '0x02' + createHash('sha256').update(seed + 'local').digest('hex'),
            peer: '0x02' + createHash('sha256').update(seed + 'peer').digest('hex')
        }
    };
}

/**
 * Mock keygen with private key derivation for PoC signing.
 * privKey = SHA-256("priv|" + sid + "|" + role)
 * 
 * WARNING: This is for anvil PoC only. Real MPC never exposes private keys.
 */
export function mockKeygenWithPriv(sid: string, role: string): MpcResultWithPriv {
    const base = mockKeygen(sid, role);
    const privKey = '0x' + createHash('sha256').update(`priv|${sid}|${role}`).digest('hex');
    return { ...base, privKey };
}

export function mockYShare(sid: string, role: string): string {
    return '0x02' + createHash('sha256').update(sid + role + 'yshare').digest('hex');
}

