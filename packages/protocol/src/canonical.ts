/**
 * Canonical JSON Serialization
 * 
 * CRITICAL: Canonical serialization ensures both Alice and Bob compute the same SID
 * from identical handshake parameters. Without deterministic key ordering, two peers
 * could have matching parameters but different JSON strings, causing SID mismatch.
 * 
 * Rules:
 * - Object keys are sorted lexicographically (Unicode code point order)
 * - Arrays preserve their element order
 * - undefined values are rejected (throw error)
 * - Numbers must be safe integers (no floats for protocol values)
 */

/**
 * Recursively canonicalize a value:
 * - Objects: sort keys lexicographically
 * - Arrays: preserve order, canonicalize elements
 * - Primitives: return as-is (except undefined which throws)
 * - Numbers: must be safe integers
 */
export function canonicalize(value: unknown): unknown {
  // Reject undefined
  if (value === undefined) {
    throw new Error('Canonical serialization does not allow undefined values');
  }

  // Null is allowed
  if (value === null) {
    return null;
  }

  // Check number safety
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Number ${value} is not a safe integer`);
    }
    return value;
  }

  // Primitives (string, boolean)
  if (typeof value !== 'object') {
    return value;
  }

  // Arrays: canonicalize each element, preserve order
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  // Objects: sort keys and canonicalize values
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};

  for (const key of sortedKeys) {
    const v = obj[key];
    // Skip undefined properties (treat as non-existent)
    if (v === undefined) {
      throw new Error(`Canonical serialization does not allow undefined values (key: ${key})`);
    }
    result[key] = canonicalize(v);
  }

  return result;
}

/**
 * Canonicalize and stringify a value.
 * Returns a deterministic JSON string regardless of original key order.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
