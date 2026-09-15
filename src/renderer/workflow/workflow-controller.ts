/**
 * Workflow Dashboard state management (Phase 2, Milestone 9).
 *
 * Framework-independent, exactly like the chat, workspace, agent and memory
 * controllers, and for the same reason: React Testing Library and jsdom are
 * not part of this project's toolchain (`docs/security-model.md`, known
 * limitation 18), so every behaviour worth testing — loading, empty, error,
 * retry, staleness, live progress, awaiting-confirmation, pause, cancel —
 * lives here, where plain Vitest can drive it.
 *
 * Four properties this module is responsible for:
 *
 *  - **One operation at a time, and the last one wins.** Every request takes
 *    a sequence number; a response whose number is no longer current is
 *    discarded rather than applied over newer state.
 *  - **No message from the main process is ever displayed.** Failures arrive
 *    as a bounded `WorkflowErrorCode`, and the sentence the user reads comes
 *    from {@link FAILURE_MESSAGES} below — this file's own reviewed strings.
 *  - **Declining is not failing.** Answering "no" to a native confirmation
 *    comes back as an ordinary activity note rather than an error banner, and
 *    so does pausing or cancelling a run on purpose.
 *  - **Progress is advisory and never authoritative.** A progress event moves
 *    the on-screen step counter and nothing else. The run record that
 *    `run()` resolves with is what the interface reports, so a dropped or
 *    reordered event can make the counter stale but can never make the
 *    interface claim a run ended differently than it did.
 *
 * It holds **no authority of its own.** Nothing here decides what a workflow
 * may do: the stored definition does, the selected agent profile is its
 * ceiling, the permission engine decides every action, and the native dialogs
 * the main process owns are what a person actually approves.
 *
 * Never imports Electron, never touches `window.localAgent` (that is
 * `ipc-workflow-client.ts`'s single job), and never reaches the filesystem or
 * the network.
 */

import type { WorkflowClient, WorkflowFailure } from './ipc-workflow-client';
import type { WorkflowErrorCode } from '../../shared/workflow';
import type {
  Workflow,
  WorkflowInput,
  WorkflowProgressEvent,
  WorkflowRun,
} from '../../shared/schemas';

/** Which request is in flight, for the interface's own status line. */
export type WorkflowOperation =
  'list' | 'create' | 'update' | 'duplicate' | 'delete' | 'set-enabled' | 'run';

export interface WorkflowUiError {
  readonly message: string;
  /** True when re-running the same request could plausibly succeed. */
  readonly retryable: boolean;
}

/** What the dashboard shows about a run in flight. */
export interface WorkflowRunProgressView {
  readonly runId: string;
  readonly phase: WorkflowProgressEvent['phase'];
  readonly stepIndex: number | null;
  readonly attempt: number;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly tool: string | null;
  /** True while the run is stopped at a checkpoint waiting for an answer. */
  readonly awaitingConfirmation: boolean;
}

export interface WorkflowState {
  readonly workflows: readonly Workflow[];
  /** True once the first `list` call has answered, whatever it said. */
  readonly initialized: boolean;
  readonly busy: WorkflowOperation | null;
  /** The most recent run's record, or `null`. */
  readonly run: WorkflowRun | null;
  /** The id of the run currently in flight, so pause and cancel have an address. */
  readonly runningRunId: string | null;
  readonly progress: WorkflowRunProgressView | null;
  readonly activity: string | null;
  readonly error: WorkflowUiError | null;
}

export type WorkflowListener = (state: WorkflowState) => void;

/**
 * One user-facing sentence per normalized failure code.
 *
 * Written here, in the renderer, deliberately: the main process's own
 * messages never cross the IPC boundary, so these are the only workflow error
 * strings a person ever sees, and they are reviewable in one place.
 */
const FAILURE_MESSAGES: Readonly<Record<WorkflowErrorCode, string>> = {
  WORKFLOW_NOT_FOUND: 'That workflow no longer exists.',
  WORKFLOW_EXISTS: 'That identifier is already taken. Choose another.',
  WORKFLOW_INVALID: 'That workflow is not valid, so nothing was saved.',
  WORKFLOW_LIMIT_REACHED: 'There is no room for another workflow. Delete one first.',
  WORKFLOW_STORE_FAILED: 'The workflow could not be saved. Nothing was changed.',
  WORKFLOW_DISABLED: 'That workflow is disabled. Enable it before running it.',
  WORKFLOW_RUNNING: 'That workflow is running. Wait for it to finish, or cancel it first.',
  WORKFLOW_RUN_ALREADY_RUNNING: 'A run is already in progress. Wait for it, or cancel it first.',
  WORKFLOW_AGENT_NOT_FOUND: 'The agent this workflow uses no longer exists. Choose another.',
  WORKFLOW_AGENT_DISABLED: 'The agent this workflow uses is disabled. Enable it first.',
  WORKFLOW_TOOL_NOT_ALLOWED:
    'A step asks for a tool the selected agent does not allow. A workflow can only narrow what its agent already permits.',
  WORKFLOW_WORKSPACE_NOT_ALLOWED:
    'A step asks for a part of the project the selected agent does not cover.',
  WORKFLOW_NO_PROJECT: 'No project is open. Select one in the Workspace before running a workflow.',
  WORKFLOW_LIMIT_EXCEEDED: 'The run reached one of its own limits and stopped.',
  WORKFLOW_RUN_CANCELLED: 'The run was stopped.',
  WORKFLOW_EMERGENCY_STOPPED: 'The emergency stop was engaged, so the run stopped.',
  WORKFLOW_VERIFICATION_FAILED: 'The run finished, but its success criteria were not met.',
  WORKFLOW_RUN_FAILED: 'The run did not complete.',
};

const DENIED_MESSAGE =
  'This action was refused. The emergency stop may be engaged, or the permission policy does not allow it.';

const DECLINED_MESSAGE = 'You declined the confirmation, so nothing was changed.';

/**
 * Codes that mean "trying again might help" rather than "the answer will be
 * the same next time".
 *
 * A taken identifier, an invalid definition and a step outside the agent's
 * allowlist will not become different on a second attempt, so offering Retry
 * for those would be misleading.
 */
const RETRYABLE_CODES: readonly WorkflowErrorCode[] = [
  'WORKFLOW_STORE_FAILED',
  'WORKFLOW_RUN_FAILED',
  'WORKFLOW_RUN_ALREADY_RUNNING',
  'WORKFLOW_RUNNING',
];

const INITIAL_STATE: WorkflowState = {
  workflows: [],
  initialized: false,
  busy: null,
  run: null,
  runningRunId: null,
  progress: null,
  activity: null,
  error: null,
};

export interface WorkflowControllerDeps {
  readonly client: WorkflowClient;
  /** Injectable for deterministic tests. Defaults to `crypto.randomUUID()`. */
  readonly newRunId?: () => string;
}

export class WorkflowController {
  private readonly client: WorkflowClient;
  private readonly newRunId: () => string;
  private readonly listeners = new Set<WorkflowListener>();

  private state: WorkflowState = INITIAL_STATE;

  /**
   * Incremented for every request. A response carrying a stale sequence is
   * discarded rather than applied over newer state — the same staleness guard
   * every other controller in this renderer uses.
   */
  private sequence = 0;
  private disposed = false;
  private unsubscribeProgress: (() => void) | null = null;

  /** The last operation, so Retry has something to repeat. */
  private lastAttempt: (() => Promise<void>) | null = null;

  constructor(deps: WorkflowControllerDeps) {
    this.client = deps.client;
    this.newRunId = deps.newRunId ?? (() => crypto.randomUUID());
  }

  getState(): WorkflowState {
    return this.state;
  }

  subscribe(listener: WorkflowListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = null;
    this.listeners.clear();
  }

  async initialize(): Promise<void> {
    if (this.state.initialized) return;
    this.unsubscribeProgress ??= this.client.onProgress((event) => {
      this.applyProgress(event);
    });
    await this.refresh();
  }

  refresh(): Promise<void> {
    return this.runListOperation('list', () => this.client.list(), null);
  }

  createWorkflow(workflow: WorkflowInput): Promise<void> {
    return this.runListOperation('create', () => this.client.create(workflow), 'Workflow created.');
  }

  updateWorkflow(workflowId: string, workflow: WorkflowInput): Promise<void> {
    return this.runListOperation(
      'update',
      () => this.client.update(workflowId, workflow),
      'Workflow saved.',
    );
  }

  duplicateWorkflow(workflowId: string, newId: string): Promise<void> {
    return this.runListOperation(
      'duplicate',
      () => this.client.duplicate(workflowId, newId),
      'Workflow duplicated. The copy is disabled.',
    );
  }

  deleteWorkflow(workflowId: string): Promise<void> {
    return this.runListOperation(
      'delete',
      () => this.client.remove(workflowId),
      'Workflow deleted.',
    );
  }

  setWorkflowEnabled(workflowId: string, enabled: boolean): Promise<void> {
    return this.runListOperation(
      'set-enabled',
      () => this.client.setEnabled(workflowId, enabled),
      enabled ? 'Workflow enabled.' : 'Workflow disabled.',
    );
  }

  /**
   * Starts one manual run.
   *
   * The workflow id and the objective are the only things sent. What the run
   * may do comes from the stored definition and the stored agent profile,
   * read in the main process — this controller cannot widen a run, and
   * deliberately has no field through which it could try.
   */
  async startRun(workflowId: string, objective: string): Promise<void> {
    if (this.state.busy !== null) return;

    const runId = this.newRunId();
    this.lastAttempt = async (): Promise<void> => {
      await this.startRun(workflowId, objective);
    };

    const sequence = this.beginOperation('run');
    this.patch({ runningRunId: runId, run: null, progress: null });

    const result = await this.client.run(runId, workflowId, objective);
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        runningRunId: null,
        progress: null,
        run: result.value,
        activity: describeRun(result.value),
        error: null,
      });
      return;
    }

    this.patch({
      busy: null,
      runningRunId: null,
      progress: null,
      ...this.failurePatch(result.failure),
    });
  }

  /**
   * Asks the run in flight to stop cleanly at the next step boundary.
   *
   * Best effort and idempotent: the `workflow:run` call already in flight is
   * what ultimately answers, with a record whose `stopReason` says it was
   * paused. Nothing is patched here beyond noting that the request was sent,
   * so the interface never claims a run stopped before it actually did.
   */
  async pauseRun(): Promise<void> {
    const runId = this.state.runningRunId;
    if (runId === null) return;
    await this.client.pause(runId);
    if (this.disposed) return;
    this.patch({ activity: 'Asked the run to stop after the current step.' });
  }

  /** Asks the main process to abort the run in flight, killing any child process. */
  async cancelRun(): Promise<void> {
    const runId = this.state.runningRunId;
    if (runId === null) return;
    await this.client.cancel(runId);
    if (this.disposed) return;
    this.patch({ activity: 'Asked the run to stop.' });
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

  /**
   * Applies one advisory progress event.
   *
   * Ignored unless it belongs to the run this controller started, so an event
   * for a stale run cannot move the counter for a newer one. It updates the
   * progress view and nothing else — never the run record, never the error,
   * never the workflow list.
   */
  private applyProgress(event: WorkflowProgressEvent): void {
    if (this.disposed) return;
    if (event.runId !== this.state.runningRunId) return;

    this.patch({
      progress: {
        runId: event.runId,
        phase: event.phase,
        stepIndex: event.stepIndex,
        attempt: event.attempt,
        totalSteps: event.totalSteps,
        completedSteps: event.completedSteps,
        tool: event.tool,
        awaitingConfirmation: event.phase === 'awaiting-confirmation',
      },
    });
  }

  private async runListOperation(
    operation: WorkflowOperation,
    request: () => Promise<
      { ok: true; value: readonly Workflow[] } | { ok: false; failure: WorkflowFailure }
    >,
    successActivity: string | null,
  ): Promise<void> {
    if (this.state.busy !== null) return;

    this.lastAttempt = async (): Promise<void> => {
      await this.runListOperation(operation, request, successActivity);
    };

    const sequence = this.beginOperation(operation);
    const result = await request();
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        initialized: true,
        workflows: result.value,
        ...(successActivity === null ? {} : { activity: successActivity }),
        error: null,
      });
      return;
    }

    this.patch({ busy: null, initialized: true, ...this.failurePatch(result.failure) });
  }

  private failurePatch(failure: WorkflowFailure): Partial<WorkflowState> {
    if (failure.kind === 'denied') {
      return { error: { message: DENIED_MESSAGE, retryable: false }, activity: null };
    }
    if (failure.kind === 'declined') {
      // A deliberate refusal is an activity note, never an error banner:
      // telling someone their own "no" had gone wrong is its own
      // misinformation.
      return { activity: DECLINED_MESSAGE, error: null };
    }
    return {
      error: {
        message: FAILURE_MESSAGES[failure.code],
        retryable: RETRYABLE_CODES.includes(failure.code),
      },
      activity: null,
    };
  }

  private beginOperation(operation: WorkflowOperation): number {
    this.sequence += 1;
    this.patch({ busy: operation, error: null });
    return this.sequence;
  }

  private isStale(sequence: number): boolean {
    return this.disposed || sequence !== this.sequence;
  }

  private patch(changes: Partial<WorkflowState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.state);
  }
}

/**
 * One plain sentence describing how a run ended.
 *
 * Built from the record's own bounded enums and counts, never from a step's
 * text, so this cannot become a way for main-process wording to reach the
 * screen indirectly.
 */
export function describeRun(run: WorkflowRun): string {
  const verified =
    run.verification.required.length === 0
      ? 'no success criteria'
      : run.verification.passed
        ? 'criteria met'
        : `criteria not met (${String(run.verification.satisfied.length)}/${String(run.verification.required.length)})`;
  const rollback =
    run.rollback.result === 'not-configured' ? '' : `, rollback ${run.rollback.result}`;
  return `${run.status} after ${String(run.totals.steps)} step(s) — ${run.stopReason}, ${verified}${rollback}.`;
}
