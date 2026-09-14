/**
 * The renderer's one seam to local memory (Phase 2, Milestone 8).
 *
 * This is the only file under `src/renderer/memory` permitted to reference
 * `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does, exactly as it already
 * does for `ipc-chat-provider.ts`, `ipc-workspace-client.ts` and
 * `ipc-agent-client.ts`. Every other memory file in the renderer talks to
 * this module, never to the bridge.
 *
 * **Nothing that crossed the boundary is trusted as text.** A failure yields
 * only the bounded `MemoryErrorCode` enum; the sentence a user reads is
 * always one of `memory-controller.ts`'s own reviewed strings, never anything
 * reconstructed from a main-process message. That rule matters more here than
 * anywhere else in the codebase: a message that quoted the record it failed
 * on would be this feature's own content leaking through its error path.
 */

import type {
  MemoryMutationSummary,
  MemoryQueryResult,
  MemoryRecord,
  MemoryRecordInput,
  MemoryRetrievalResult,
  MemoryScopeValue,
} from '../../shared/schemas';
import { isMemoryErrorCode } from '../../shared/memory';
import type { MemoryErrorCode } from '../../shared/memory';

/**
 * Why a request did not produce a value.
 *
 * `'denied'` and `'declined'` are kept apart from every error code for the
 * reason the workspace and agent clients keep them apart: a refusal by the
 * permission engine and a refusal by the user are not failures of the
 * operation, and reporting either as an error would misinform.
 */
export type MemoryFailure =
  | { readonly kind: 'denied' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly code: MemoryErrorCode };

export type MemoryResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: MemoryFailure };

interface OutcomeCarrier {
  readonly outcome: string;
  readonly errorCode?: string | undefined;
}

function failureFrom(response: OutcomeCarrier): MemoryFailure {
  if (response.outcome === 'denied') return { kind: 'denied' };
  // `aborted` is what `execute` returns for a rejected confirmation.
  if (response.outcome === 'aborted') return { kind: 'declined' };
  const code = response.errorCode;
  return {
    kind: 'error',
    // An unrecognised code degrades to the generic store failure rather than
    // being shown, so a value that somehow bypassed the response schema still
    // cannot reach the interface as text.
    code: code !== undefined && isMemoryErrorCode(code) ? code : 'MEMORY_STORE_FAILED',
  };
}

function unwrap<TValue>(response: OutcomeCarrier, value: TValue | undefined): MemoryResult<TValue> {
  if (response.outcome === 'success' && value !== undefined) return { ok: true, value };
  return { ok: false, failure: failureFrom(response) };
}

/**
 * The typed operations `MemoryController` depends on.
 *
 * An interface rather than a direct import so the controller can be tested
 * against a fake with no `window` at all — the same injection every other
 * renderer controller in this codebase uses.
 */
export interface MemoryClient {
  list(scope: MemoryScopeValue): Promise<MemoryResult<MemoryQueryResult>>;
  search(scope: MemoryScopeValue, query: string): Promise<MemoryResult<MemoryQueryResult>>;
  retrieve(objective: string): Promise<MemoryResult<MemoryRetrievalResult>>;
  add(record: MemoryRecordInput): Promise<MemoryResult<MemoryRecord>>;
  update(id: string, record: MemoryRecordInput): Promise<MemoryResult<MemoryRecord>>;
  setPinned(
    id: string,
    scope: MemoryScopeValue,
    pinned: boolean,
  ): Promise<MemoryResult<MemoryRecord>>;
  remove(id: string, scope: MemoryScopeValue): Promise<MemoryResult<MemoryMutationSummary>>;
  clear(scope: MemoryScopeValue): Promise<MemoryResult<MemoryMutationSummary>>;
  exportScope(scope: MemoryScopeValue): Promise<MemoryResult<MemoryMutationSummary>>;
  importScope(scope: MemoryScopeValue): Promise<MemoryResult<MemoryMutationSummary>>;
}

export function createIpcMemoryClient(): MemoryClient {
  return {
    async list(scope) {
      const response = await window.localAgent.memory.list(scope);
      return unwrap(response, response.result);
    },
    async search(scope, query) {
      const response = await window.localAgent.memory.search(scope, query);
      return unwrap(response, response.result);
    },
    async retrieve(objective) {
      const response = await window.localAgent.memory.retrieve(objective);
      return unwrap(response, response.result);
    },
    async add(record) {
      const response = await window.localAgent.memory.add(record);
      return unwrap(response, response.record);
    },
    async update(id, record) {
      const response = await window.localAgent.memory.update(id, record);
      return unwrap(response, response.record);
    },
    async setPinned(id, scope, pinned) {
      const response = await window.localAgent.memory.setPinned(id, scope, pinned);
      return unwrap(response, response.record);
    },
    async remove(id, scope) {
      const response = await window.localAgent.memory.remove(id, scope);
      return unwrap(response, response.summary);
    },
    async clear(scope) {
      const response = await window.localAgent.memory.clear(scope);
      return unwrap(response, response.summary);
    },
    async exportScope(scope) {
      const response = await window.localAgent.memory.exportScope(scope);
      return unwrap(response, response.summary);
    },
    async importScope(scope) {
      const response = await window.localAgent.memory.importScope(scope);
      return unwrap(response, response.summary);
    },
  };
}
