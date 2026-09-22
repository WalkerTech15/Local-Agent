/**
 * Barrel for the memory layer (Phase 2, Milestone 8).
 *
 * Everything exported here is pure: no I/O, no Node built-in, no Electron, no
 * network, no clock. The rules live here so that the main process, which
 * holds the records, and the renderer, which displays them, apply the
 * identical rule rather than two implementations that can drift.
 */

export {
  MEMORY_ERROR_CODES,
  MEMORY_ERROR_MESSAGES,
  MemoryError,
  isMemoryErrorCode,
} from './errors';
export type { MemoryErrorCode } from './errors';

export { MEMORY_SECRET_HINTS, findLikelySecret, looksLikeSecret } from './secret-scan';
export type { MemorySecretHint } from './secret-scan';

export {
  activeMemories,
  dedupeMemories,
  isMemoryExpired,
  orderMemories,
  retrieveMemories,
  searchMemories,
} from './retrieval';
export type { MemoryRetrievalOutcome, MemorySearchOutcome } from './retrieval';
