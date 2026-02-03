
import { keccak256, concatHex, stringToHex } from "viem";

/**
 * Derives a deterministic secret from the session ID and the on-chain signature fingerprint.
 * 
 * Formula: secret = keccak256( "voidswap|secret|" || sid || sigHashB )
 */
export function deriveSecretFromSigHash(args: {
  sid: string,
  sigHashB: `0x${string}`,
}): `0x${string}` {
  const { sid, sigHashB } = args;

  const domain = stringToHex("voidswap|secret|");
  const sidHex = stringToHex(sid);
  
  // input = domain || sidHex || sigHashB
  const input = concatHex([domain, sidHex, sigHashB]);
  
  return keccak256(input);
}

/**
 * Returns a redacted version of a hex string for safe logging.
 * e.g. 0x12345678...
 */
export function redactedHex(h: string | null | undefined, n = 8): string {
  if (!h) return '(null)';
  if (h.length <= n + 2) return h;
  return `${h.slice(0, n + 2)}...`;
}
