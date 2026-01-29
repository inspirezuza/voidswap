/**
 * Transcript Helper
 * 
 * Maintains an ordered record of protocol messages for debugging and audit.
 * The transcript can be hashed to verify both parties saw the same messages.
 */

import { createHash } from 'crypto';
import { canonicalStringify } from './canonical.js';

/**
 * A single record in the transcript.
 */
export interface TranscriptRecord {
  seq: number;
  from: 'alice' | 'bob';
  type: string;
  payload: unknown;
}

/**
 * Append a record to the transcript, returning a new array.
 * The original array is not modified (immutable pattern).
 */
export function appendRecord(
  records: TranscriptRecord[],
  record: TranscriptRecord
): TranscriptRecord[] {
  return [...records, record];
}

/**
 * Sort transcript records for deterministic hashing.
 * Sort key: from (alice < bob), seq (ascending), type (lexicographic)
 */
function sortRecords(records: TranscriptRecord[]): TranscriptRecord[] {
  return [...records].sort((a, b) => {
    // Primary: from (alice before bob)
    if (a.from !== b.from) {
      return a.from === 'alice' ? -1 : 1;
    }
    // Secondary: seq (ascending)
    if (a.seq !== b.seq) {
      return a.seq - b.seq;
    }
    // Tertiary: type (lexicographic)
    return a.type.localeCompare(b.type);
  });
}

/**
 * Compute SHA-256 hash of the entire transcript.
 * Records are SORTED before hashing to ensure determinism regardless of append order.
 * 
 * @returns 64-character lowercase hex string
 */
export function transcriptHash(records: TranscriptRecord[]): string {
  const sorted = sortRecords(records);
  const canonical = canonicalStringify(sorted);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
