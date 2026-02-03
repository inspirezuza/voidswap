
import { keccak256, concatHex, padHex, toHex } from "viem";

export type SigFingerprint = { 
  r: `0x${string}`; 
  s: `0x${string}`; 
  v: bigint; 
  sigHash: `0x${string}` 
};

/**
 * Computes a deterministic fingerprint of the signature (r, s, v).
 * 
 * Rules:
 * - r, s: padded to 32 bytes (left pad with zeros)
 * - v: normalized to 0n or 1n (if 27/28), then encoded as 32 bytes for hashing
 * - sigHash: keccak256( pad32(r) || pad32(s) || pad32(v) )
 */
export function computeSigFingerprint(args: {
  r: `0x${string}`,
  s: `0x${string}`,
  v: bigint,
}): SigFingerprint {
  const { r, s, v } = args;

  // Normalize v: if 27/28 -> shift to 0/1. If already 0/1, keep it.
  // We assume standard Ethereum EIP-155 recovery IDs or pre-EIP-155.
  // However, for consistency with on-chain recovery, we usually want 27/28 for legacy
  // and yParity (0/1) for EIP-1559.
  // The goal is a STABLE secret.
  // PROMPT SAYS: "v normalized: accept 0/1 or 27/28; store as bigint; encode as 32 bytes for hashing"
  // Let's normalize to 0 or 1 for the hash input to be chain-agnostic regarding replay protection offsets?
  // Actually commonly v is used as the recovery id (0 or 1).
  // Let's standardise: if v >= 27, v = v - 27. If v > 1 after that (e.g. EIP-155 chainId replay), 
  // we might need more complex logic, but for "extracting secret", usually we care about the y-parity.
  // Viem transactions usually give 'v' as the raw value.
  // Let's check if the prompt provided specific logic?
  // "v normalized: accept 0/1 or 27/28"
  
  let vNorm = v;
  if (vNorm === 27n || vNorm === 28n) {
      vNorm -= 27n;
  }
  // If it was some EIP-155 chainID based v, it would be much larger. 
  // For this task, we assume simple 27/28 or 0/1 inputs as per prompt.

  const r32 = padHex(r, { size: 32 });
  const s32 = padHex(s, { size: 32 });
  const v32 = padHex(toHex(vNorm), { size: 32 });

  const sigHash = keccak256(concatHex([r32, s32, v32]));

  return {
    r: r32,
    s: s32,
    v: vNorm,
    sigHash
  };
}
