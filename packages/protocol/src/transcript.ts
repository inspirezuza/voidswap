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
 * Compute SHA-256 hash of the entire transcript.
 * Useful for verifying both parties have identical message history.
 * 
 * @returns 64-character lowercase hex string
 */
export function transcriptHash(records: TranscriptRecord[]): string {
  const canonical = canonicalStringify(records);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
