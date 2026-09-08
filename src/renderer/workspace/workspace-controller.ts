/**
 * Coding-workspace state management (Phase 2, Milestone 5).
 *
 * Framework-independent, exactly like `chat/conversation-controller.ts` and
 * for the same reason: React Testing Library and jsdom are not part of this
 * project's toolchain (`docs/security-model.md`, known limitation 18), so
 * every behaviour worth testing — loading, empty, error, retry, staleness,
 * the approval gate — lives here, where plain Vitest can drive it, rather
 * than inside a component nothing can render.
 *
 * Three properties this module is responsible for:
 *
 *  - **One operation at a time, and the last one wins.** Every request takes
 *    a sequence number; a response whose number is no longer current is
 *    discarded rather than applied over newer state. This is the same
 *    staleness guard `ConversationController` implements with its
 *    `AbortController` identity check.
 *  - **No message from the main process is ever displayed.** Failures arrive
 *    as a bounded `WorkspaceErrorCode`, and the sentence the user reads comes
 *    from {@link FAILURE_MESSAGES} below — this file's own reviewed strings.
 *  - **Approval is recorded, never acted on.** {@link WorkspaceController.approvePlan}
 *    sets a flag and does nothing else. There is no modification function for
 *    it to unlock, in this module or anywhere else in this milestone; the
 *    gate exists so that whichever milestone adds one has to pass through it.
 *
 * Never imports Electron, never touches `window.localAgent` (that is
 * `ipc-workspace-client.ts`'s single job), and never reaches the filesystem
 * or the network.
 */

import type { WorkspaceClient, WorkspaceFailure } from './ipc-workspace-client';
import type {
  CodingPlan,
  WorkspaceFile,
  WorkspaceProjectSummary,
  WorkspaceSearchResult,
  WorkspaceTree,
} from '../../shared/schemas';
import type { WorkspaceErrorCode } from '../../shared/workspace';

/** Which request is in flight, for the interface's own status line. */
export type WorkspaceOperation = 'status' | 'select' | 'tree' | 'file' | 'search' | 'plan';

export interface WorkspaceUiError {
  readonly message: string;
  /** True when re-running the same request could plausibly succeed. */
  readonly retryable: boolean;
}

export interface WorkspaceState {
  /** `null` until the user approves a project in the native picker. */
  readonly project: WorkspaceProjectSummary | null;
  /** True once the first `status` call has answered, whatever it said. */
  readonly initialized: boolean;
  readonly busy: WorkspaceOperation | null;
  readonly tree: WorkspaceTree | null;
  readonly openFile: WorkspaceFile | null;
  readonly search: WorkspaceSearchResult | null;
  readonly plan: CodingPlan | null;
  /**
   * Whether the user has approved the current plan.
   *
   * Reset to `false` whenever a new plan is generated, so approval is never
   * inherited by a plan the user has not seen. It unlocks nothing today —
   * see this module's header.
   */
  readonly planApproved: boolean;
  /** A short description of the last operation that completed. */
  readonly activity: string | null;
  readonly error: WorkspaceUiError | null;
}

export type WorkspaceListener = (state: WorkspaceState) => void;

/**
 * One user-facing sentence per normalized failure code.
 *
 * Written here, in the renderer, deliberately: the main process's own
 * messages never cross the IPC boundary, so these are the only workspace
 * error strings a person ever sees, and they are reviewable in one place.
 * None of them names a path — the code that produced them never had one to
 * give.
 */
const FAILURE_MESSAGES: Readonly<Record<WorkspaceErrorCode, string>> = {
  WORKSPACE_NO_PROJECT: 'No project is open. Select one to start inspecting it.',
  WORKSPACE_SELECTION_CANCELLED: 'Project selection was cancelled.',
  WORKSPACE_INVALID_PROJECT:
    'That location cannot be opened as a project. Choose a directory outside the application’s own data folder.',
  WORKSPACE_INVALID_PATH: 'That path is not a valid location inside this project.',
  WORKSPACE_PATH_OUTSIDE_PROJECT:
    'That path leads outside the approved project, so it was not opened.',
  WORKSPACE_PATH_EXCLUDED:
    'That path is excluded from inspection. Dependencies, build output and credential files are never read.',
  WORKSPACE_NOT_FOUND: 'Nothing exists at that path any more.',
  WORKSPACE_ACCESS_DENIED: 'Windows refused access to that path.',
  WORKSPACE_UNSUPPORTED_ENTRY: 'That entry is not a file or folder this viewer can open.',
  WORKSPACE_FILE_TOO_LARGE: 'That file is too large for the read-only viewer to open.',
  WORKSPACE_BINARY_FILE: 'That file is not text, so it is not shown.',
  WORKSPACE_READ_FAILED: 'That path could not be read.',
};

const DENIED_MESSAGE =
  'This action was refused. The emergency stop may be engaged, or the permission policy does not allow it.';

/**
 * Codes that mean "the request failed and trying again might help" as opposed
 * to "the answer will be the same next time".
 *
 * An excluded path or an oversized file will not become readable on a second
 * attempt, so offering Retry for those would be misleading.
 */
const RETRYABLE_CODES: readonly WorkspaceErrorCode[] = [
  'WORKSPACE_ACCESS_DENIED',
  'WORKSPACE_READ_FAILED',
  'WORKSPACE_NOT_FOUND',
];

function describeFailure(failure: WorkspaceFailure): WorkspaceUiError {
  if (failure.kind === 'denied') return { message: DENIED_MESSAGE, retryable: true };
  return {
    message: FAILURE_MESSAGES[failure.code],
    retryable: RETRYABLE_CODES.includes(failure.code),
  };
}

/** What `retry()` would re-run. */
type Attempt =
  | { readonly operation: 'status' }
  | { readonly operation: 'select' }
  | { readonly operation: 'tree'; readonly path: string }
  | { readonly operation: 'file'; readonly path: string }
  | { readonly operation: 'search'; readonly query: string; readonly path: string }
  | { readonly operation: 'plan'; readonly objective: string };

function initialState(): WorkspaceState {
  return {
    project: null,
    initialized: false,
    busy: null,
    tree: null,
    openFile: null,
    search: null,
    plan: null,
    planApproved: false,
    activity: null,
    error: null,
  };
}

export interface WorkspaceControllerDeps {
  readonly client: WorkspaceClient;
}

export class WorkspaceController {
  private readonly client: WorkspaceClient;
  private readonly listeners = new Set<WorkspaceListener>();
  private state: WorkspaceState = initialState();
  private sequence = 0;
  private lastAttempt: Attempt | null = null;
  private disposed = false;

  constructor(deps: WorkspaceControllerDeps) {
    this.client = deps.client;
  }

  getState(): WorkspaceState {
    return this.state;
  }

  /** True while no request is in flight, so a new one may start. */
  get canAct(): boolean {
    return this.state.busy === null;
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: WorkspaceState): void {
    this.state = next;
    if (this.disposed) return;
    for (const listener of this.listeners) listener(next);
  }

  /**
   * Marks a request as started and claims a sequence number.
   *
   * The number is what makes a late response harmless: by the time it
   * arrives, a newer request may already have moved the state on, and
   * {@link isCurrent} will refuse to apply it.
   */
  private begin(operation: WorkspaceOperation, attempt: Attempt): number {
    this.lastAttempt = attempt;
    this.sequence += 1;
    this.setState({ ...this.state, busy: operation, error: null });
    return this.sequence;
  }

  private isCurrent(sequence: number): boolean {
    return !this.disposed && this.sequence === sequence;
  }

  private fail(sequence: number, failure: WorkspaceFailure): void {
    if (!this.isCurrent(sequence)) return;
    // Cancelling the native picker is the user declining, not an error: the
    // interface simply returns to what it was showing.
    if (failure.kind === 'error' && failure.code === 'WORKSPACE_SELECTION_CANCELLED') {
      this.setState({ ...this.state, busy: null, activity: 'Project selection cancelled.' });
      return;
    }
    this.setState({ ...this.state, busy: null, error: describeFailure(failure) });
  }

  /** Reads which project, if any, this session already approved. */
  async initialize(): Promise<void> {
    const sequence = this.begin('status', { operation: 'status' });
    const result = await this.client.status();
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      if (!this.isCurrent(sequence)) return;
      this.setState({ ...this.state, initialized: true });
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      initialized: true,
      busy: null,
      project: result.value,
      activity: result.value === null ? null : `Opened ${result.value.name}.`,
    });

    if (result.value !== null) await this.refreshTree('');
  }

  /**
   * Asks the main process to put the native picker in front of the user.
   *
   * Sends no path — there is no path to send. Everything shown to the user in
   * that dialog is chosen by them.
   */
  async selectProject(): Promise<void> {
    const sequence = this.begin('select', { operation: 'select' });
    const result = await this.client.select();
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    // A new project invalidates everything that described the previous one.
    this.setState({
      ...this.state,
      busy: null,
      project: result.value,
      tree: null,
      openFile: null,
      search: null,
      plan: null,
      planApproved: false,
      error: null,
      activity: result.value === null ? null : `Opened ${result.value.name}.`,
    });

    if (result.value !== null) await this.refreshTree('');
  }

  /** Lists one directory of the approved project; `''` is its root. */
  async refreshTree(path: string): Promise<void> {
    const sequence = this.begin('tree', { operation: 'tree', path });
    const result = await this.client.tree(path);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      tree: result.value,
      activity: `Listed ${String(result.value.entries.length)} entr${result.value.entries.length === 1 ? 'y' : 'ies'}${result.value.truncated ? ' (truncated)' : ''}.`,
    });
  }

  /** Opens one text file in the read-only viewer. */
  async openFile(path: string): Promise<void> {
    const sequence = this.begin('file', { operation: 'file', path });
    const result = await this.client.file(path);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      openFile: result.value,
      activity: `Read ${result.value.metadata.name} (${String(result.value.metadata.size)} bytes).`,
    });
  }

  /**
   * Searches the approved project for a literal substring.
   *
   * A blank query is a no-op rather than a full-project scan with an empty
   * needle; the schema's own minimum length is the real boundary, this is
   * only the interface declining to ask.
   */
  async search(query: string, path = ''): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    const sequence = this.begin('search', { operation: 'search', query: trimmed, path });
    const result = await this.client.search(trimmed, path);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      search: result.value,
      activity: `Found ${String(result.value.matches.length)} match${result.value.matches.length === 1 ? '' : 'es'} in ${String(result.value.filesScanned)} file(s)${result.value.truncated ? ' (truncated)' : ''}.`,
    });
  }

  /** Produces one inert coding plan. Approval starts over for each new plan. */
  async createPlan(objective: string): Promise<void> {
    const trimmed = objective.trim();
    if (trimmed.length === 0) return;

    const sequence = this.begin('plan', { operation: 'plan', objective: trimmed });
    const result = await this.client.plan(trimmed);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      plan: result.value,
      planApproved: false,
      activity: `Planned ${String(result.value.steps.length)} step(s) across ${String(result.value.relevantFiles.length)} file(s).`,
    });
  }

  /**
   * Records that the user approved the current plan.
   *
   * This is the whole approval gate, and it deliberately unlocks nothing: no
   * function in this milestone modifies a file, so there is nothing for an
   * approval to authorize. It exists so the requirement — explicit approval
   * before any future modification — is a real, tested state transition
   * rather than a promise, and so whichever milestone adds a modification has
   * a gate already in place to route through rather than one to invent.
   *
   * A no-op unless a plan is actually on screen.
   */
  approvePlan(): void {
    if (this.state.plan === null) return;
    if (this.state.planApproved) return;
    this.setState({
      ...this.state,
      planApproved: true,
      activity: 'Plan approved. No modification capability exists in this milestone.',
    });
  }

  /** Clears a standing error without re-running anything. */
  dismissError(): void {
    if (this.state.error === null) return;
    this.setState({ ...this.state, error: null });
  }

  /**
   * Re-runs the request that failed.
   *
   * A no-op unless idle with a standing error and a remembered attempt, so
   * retry can never fire concurrently with another request or with itself.
   */
  async retry(): Promise<void> {
    if (!this.canAct) return;
    if (this.state.error === null) return;
    const attempt = this.lastAttempt;
    if (attempt === null) return;

    switch (attempt.operation) {
      case 'status':
        await this.initialize();
        return;
      case 'select':
        await this.selectProject();
        return;
      case 'tree':
        await this.refreshTree(attempt.path);
        return;
      case 'file':
        await this.openFile(attempt.path);
        return;
      case 'search':
        await this.search(attempt.query, attempt.path);
        return;
      case 'plan':
        await this.createPlan(attempt.objective);
        return;
    }
  }

  /**
   * Stops delivering state updates.
   *
   * Called from `useWorkspace.ts`'s unmount cleanup. In-flight requests are
   * not cancellable — the preload bridge exposes no cancel for the workspace,
   * because every workspace operation is short and bounded by construction —
   * so instead their results are discarded on arrival, which is what
   * {@link isCurrent} already guarantees for a superseded request.
   */
  dispose(): void {
    this.disposed = true;
  }
}
