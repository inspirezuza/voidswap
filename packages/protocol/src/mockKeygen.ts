import { createHash } from 'crypto';

export interface MpcResult {
    address: string;
    commitments: {
        local: string;
        peer: string;
    };
}

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

export function mockYShare(sid: string, role: string): string {
    return '0x02' + createHash('sha256').update(sid + role + 'yshare').digest('hex');
}
