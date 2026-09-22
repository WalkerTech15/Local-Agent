/**
 * Memory Centre state management (Phase 2, Milestone 8).
 *
 * Framework-independent, exactly like `chat/conversation-controller.ts`,
 * `workspace/workspace-controller.ts` and `agent/agent-controller.ts`, and
 * for the same reason: React Testing Library and jsdom are not part of this
 * project's toolchain (`docs/security-model.md`, known limitation 18), so
 * every behaviour worth testing — loading, empty, error, retry, staleness,
 * scope switching — lives here, where plain Vitest can drive it.
 *
 * Four properties this module is responsible for:
 *
 *  - **One operation at a time, and the last one wins.** Every request takes
 *    a sequence number; a response whose number is no longer current is
 *    discarded rather than applied over newer state.
 *  - **No message from the main process is ever displayed.** Failures arrive
 *    as a bounded `MemoryErrorCode`, and the sentence the user reads comes
 *    from {@link FAILURE_MESSAGES} below — this file's own reviewed strings.
 *  - **Declining is not failing.** Answering "no" to a native confirmation,
 *    or dismissing the export or import file dialog, comes back as an
 *    ordinary activity note rather than an error banner.
 *  - **Switching scope discards what was shown.** Records from the previous
 *    scope are cleared before the new request goes out, so a project's notes
 *    are never left on screen under a personal heading while a load is in
 *    flight.
 *
 * It holds **no authority of its own.** Nothing here decides what may be
 * stored or where: the scope decides which file the main process opens, the
 * permission engine decides every operation, and the native dialogs the main
 * process owns are what a person actually approves.
 *
 * Never imports Electron, never touches `window.localAgent` (that is
 * `ipc-memory-client.ts`'s single job), and never reaches the filesystem or
 * the network.
 */

import type { MemoryClient, MemoryFailure } from './ipc-memory-client';
import type { MemoryErrorCode } from '../../shared/memory';
import type { MemoryRecord, MemoryRecordInput, MemoryScopeValue } from '../../shared/schemas';

/** Which request is in flight, for the interface's own status line. */
export type MemoryOperation =
  'list' | 'search' | 'add' | 'update' | 'set-pinned' | 'delete' | 'clear' | 'export' | 'import';

export interface MemoryUiError {
  readonly message: string;
  /** True when re-running the same request could plausibly succeed. */
  readonly retryable: boolean;
}

export interface MemoryState {
  readonly scope: MemoryScopeValue;
  readonly records: readonly MemoryRecord[];
  /** How many records the scope holds in total, after expiry filtering. */
  readonly total: number;
  /** True when the list shown is a capped view of a larger scope. */
  readonly truncated: boolean;
  /** The query the shown list was produced by, or `''` for a plain list. */
  readonly query: string;
  /** True once the first request for the current scope has answered. */
  readonly initialized: boolean;
  readonly busy: MemoryOperation | null;
  readonly activity: string | null;
  readonly error: MemoryUiError | null;
}

export type MemoryListener = (state: MemoryState) => void;

/**
 * One user-facing sentence per normalized failure code.
 *
 * Written here, in the renderer, deliberately: the main process's own
 * messages never cross the IPC boundary, so these are the only memory error
 * strings a person ever sees, and they are reviewable in one place. None of
 * them interpolates anything — not a record, not a count, not a path.
 */
const FAILURE_MESSAGES: Readonly<Record<MemoryErrorCode, string>> = {
  MEMORY_NOT_FOUND: 'That memory no longer exists.',
  MEMORY_INVALID: 'That memory is not valid, so nothing was saved.',
  MEMORY_LIMIT_REACHED: 'This scope is full. Delete something before adding more.',
  MEMORY_STORE_FAILED: 'The memory could not be saved. Nothing was changed.',
  MEMORY_NO_PROJECT: 'No project is open. Select one in the Workspace before using project memory.',
  MEMORY_SCOPE_MISMATCH: 'That memory belongs to a different scope, so it was not changed.',
  MEMORY_SECRET_REJECTED:
    'That text looks like a key, token or password. Local Agent will not store credentials in memory — keep them in the encrypted key store instead.',
  MEMORY_IMPORT_INVALID: 'That file is not a Local Agent memory export for this scope.',
  MEMORY_IMPORT_TOO_LARGE: 'That file is too large to import.',
  MEMORY_EXPORT_FAILED: 'The export could not be written. No file was left behind.',
  MEMORY_FILE_SELECTION_CANCELLED: 'No file was chosen, so nothing happened.',
  MEMORY_READ_FAILED: 'The memory could not be read.',
};

const DENIED_MESSAGE =
  'This action was refused. The emergency stop may be engaged, or the permission policy does not allow it.';

const DECLINED_MESSAGE = 'You declined the confirmation, so nothing was changed.';

/**
 * Codes that mean "trying again might help" rather than "the answer will be
 * the same next time".
 *
 * A rejected credential, an invalid record and a file that is not an export
 * will not become different on a second attempt, so offering Retry for those
 * would be misleading. A cancelled dialog is deliberately absent too: the
 * answer was the user's, and re-opening the dialog for them is not a retry.
 */
const RETRYABLE_CODES: readonly MemoryErrorCode[] = [
  'MEMORY_STORE_FAILED',
  'MEMORY_READ_FAILED',
  'MEMORY_EXPORT_FAILED',
];

const INITIAL_STATE: MemoryState = {
  scope: 'personal',
  records: [],
  total: 0,
  truncated: false,
  query: '',
  initialized: false,
  busy: null,
  activity: null,
  error: null,
};

export interface MemoryControllerDeps {
  readonly client: MemoryClient;
  /** The scope shown first. Personal by default — the one always available. */
  readonly initialScope?: MemoryScopeValue;
}

export class MemoryController {
  private readonly client: MemoryClient;
  private readonly listeners = new Set<MemoryListener>();

  private state: MemoryState;

  /**
   * Incremented for every request. A response carrying a stale sequence is
   * discarded rather than applied over newer state — the same staleness guard
   * every other controller in this renderer uses.
   */
  private sequence = 0;
  private disposed = false;

  /** The last operation, so Retry has something to repeat. */
  private lastAttempt: (() => Promise<void>) | null = null;

  constructor(deps: MemoryControllerDeps) {
    this.client = deps.client;
    this.state =
      deps.initialScope === undefined
        ? INITIAL_STATE
        : { ...INITIAL_STATE, scope: deps.initialScope };
  }

  getState(): MemoryState {
    return this.state;
  }

  subscribe(listener: MemoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  async initialize(): Promise<void> {
    if (this.state.initialized) return;
    await this.refresh();
  }

  /** Re-runs whichever view is current: the plain list, or the last search. */
  refresh(): Promise<void> {
    const { scope, query } = this.state;
    if (query.length === 0) return this.loadList(scope);
    return this.search(query);
  }

  /**
   * Shows a different scope.
   *
   * The previous scope's records are cleared *before* the request goes out,
   * so nothing from one scope is ever displayed under another's heading —
   * which for the project scope would mean showing one project's notes while
   * another is loading.
   */
  async setScope(scope: MemoryScopeValue): Promise<void> {
    if (this.state.busy !== null) return;
    this.patch({
      scope,
      records: [],
      total: 0,
      truncated: false,
      query: '',
      initialized: false,
      activity: null,
      error: null,
    });
    await this.loadList(scope);
  }

  search(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return this.loadList(this.state.scope);

    const scope = this.state.scope;
    return this.runQuery('search', () => this.client.search(scope, trimmed), trimmed);
  }

  clearSearch(): Promise<void> {
    return this.loadList(this.state.scope);
  }

  addMemory(record: MemoryRecordInput): Promise<void> {
    return this.runMutation('add', () => this.client.add(record), 'Memory saved.');
  }

  updateMemory(id: string, record: MemoryRecordInput): Promise<void> {
    return this.runMutation('update', () => this.client.update(id, record), 'Memory updated.');
  }

  setPinned(id: string, pinned: boolean): Promise<void> {
    const scope = this.state.scope;
    return this.runMutation(
      'set-pinned',
      () => this.client.setPinned(id, scope, pinned),
      pinned ? 'Memory pinned.' : 'Memory unpinned.',
    );
  }

  deleteMemory(id: string): Promise<void> {
    const scope = this.state.scope;
    return this.runMutation('delete', () => this.client.remove(id, scope), 'Memory deleted.');
  }

  clearScope(): Promise<void> {
    const scope = this.state.scope;
    return this.runMutation('clear', () => this.client.clear(scope), 'Scope cleared.');
  }

  exportScope(): Promise<void> {
    const scope = this.state.scope;
    return this.runMutation('export', () => this.client.exportScope(scope), 'Memory exported.');
  }

  importScope(): Promise<void> {
    const scope = this.state.scope;
    return this.runMutation('import', () => this.client.importScope(scope), 'Memory imported.');
  }

  async retry(): Promise<void> {
    const attempt = this.lastAttempt;
    if (attempt === null) return;
    await attempt();
  }

  dismissError(): void {
    this.patch({ error: null });
  }

  // -------------------------------------------------------------------------

  private loadList(scope: MemoryScopeValue): Promise<void> {
    return this.runQuery('list', () => this.client.list(scope), '');
  }

  /**
   * Runs a read and replaces the shown list with its answer.
   *
   * `query` is recorded alongside the records so the interface can say
   * whether it is showing a search or the whole scope, and so `refresh` can
   * repeat whichever it was.
   */
  private async runQuery(
    operation: MemoryOperation,
    request: () => Promise<
      | { ok: true; value: { records: readonly MemoryRecord[]; total: number; truncated: boolean } }
      | { ok: false; failure: MemoryFailure }
    >,
    query: string,
  ): Promise<void> {
    if (this.state.busy !== null) return;

    this.lastAttempt = async (): Promise<void> => {
      await this.runQuery(operation, request, query);
    };

    const sequence = this.beginOperation(operation);
    const result = await request();
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        initialized: true,
        records: result.value.records,
        total: result.value.total,
        truncated: result.value.truncated,
        query,
        error: null,
      });
      return;
    }

    this.patch({ busy: null, initialized: true, ...this.failurePatch(result.failure) });
  }

  /**
   * Runs a write, then reloads the current view.
   *
   * The reload is what makes the list authoritative: this controller never
   * patches a record into the shown list from a write's own answer, so what
   * is displayed is always what the store reported on a subsequent read,
   * never an optimistic guess that could disagree with disk.
   */
  private async runMutation(
    operation: MemoryOperation,
    request: () => Promise<{ ok: true; value: unknown } | { ok: false; failure: MemoryFailure }>,
    successActivity: string,
  ): Promise<void> {
    if (this.state.busy !== null) return;

    this.lastAttempt = async (): Promise<void> => {
      await this.runMutation(operation, request, successActivity);
    };

    const sequence = this.beginOperation(operation);
    const result = await request();
    if (this.isStale(sequence)) return;

    if (!result.ok) {
      this.patch({ busy: null, ...this.failurePatch(result.failure) });
      return;
    }

    this.patch({ busy: null, activity: successActivity, error: null });
    await this.refresh();
    if (this.disposed) return;
    // `refresh` clears `activity` on success, so the outcome of the write is
    // restated afterwards — otherwise a successful save would report only
    // that a list was loaded.
    this.patch({ activity: successActivity });
  }

  private failurePatch(failure: MemoryFailure): Partial<MemoryState> {
    if (failure.kind === 'denied') {
      return { error: { message: DENIED_MESSAGE, retryable: false }, activity: null };
    }
    if (failure.kind === 'declined') {
      // A deliberate refusal is an activity note, never an error banner:
      // telling someone their own "no" had gone wrong is its own
      // misinformation.
      return { activity: DECLINED_MESSAGE, error: null };
    }
    if (failure.code === 'MEMORY_FILE_SELECTION_CANCELLED') {
      // Dismissing a file dialog is the same kind of answer as declining a
      // confirmation, and is reported the same way.
      return { activity: FAILURE_MESSAGES.MEMORY_FILE_SELECTION_CANCELLED, error: null };
    }
    return {
      error: {
        message: FAILURE_MESSAGES[failure.code],
        retryable: RETRYABLE_CODES.includes(failure.code),
      },
      activity: null,
    };
  }

  private beginOperation(operation: MemoryOperation): number {
    this.sequence += 1;
    this.patch({ busy: operation, error: null });
    return this.sequence;
  }

  private isStale(sequence: number): boolean {
    return this.disposed || sequence !== this.sequence;
  }

  private patch(changes: Partial<MemoryState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.state);
  }
}
