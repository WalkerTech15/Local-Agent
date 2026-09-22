/**
 * Automation panel state management (Phase 2, Milestone 10).
 *
 * Framework-independent, exactly like the workflow, chat, workspace, agent
 * and memory controllers, and for the same reason (`docs/security-model.md`,
 * known limitation 18: no React Testing Library in this toolchain) — every
 * behaviour worth testing lives here, where plain Vitest can drive it.
 *
 * The same two guarantees the workflow controller holds:
 *
 *  - **One operation at a time, and the last one wins.** Every request takes
 *    a sequence number; a response whose number is no longer current is
 *    discarded rather than applied over newer state.
 *  - **No message from the main process is ever displayed.** Failures arrive
 *    as a bounded `AutomationErrorCode`, and the sentence the user reads
 *    comes from {@link FAILURE_MESSAGES} below — this file's own reviewed
 *    strings.
 *
 * It holds **no authority of its own.** Nothing here decides which tool may
 * run: the fixed registry does, the permission engine decides the one action
 * type every tool routes through, and the native dialog the main process owns
 * is what a person actually approves.
 *
 * Never imports Electron, never touches `window.localAgent` (that is
 * `ipc-automation-client.ts`'s single job), and never reaches the filesystem
 * or the network.
 */

import type { AutomationClient, AutomationFailure } from './ipc-automation-client';
import type { AutomationErrorCode } from '../../shared/automation';
import type { AutomationRunResult, AutomationTool } from '../../shared/schemas';

export type AutomationOperation = 'list' | 'run';

export interface AutomationUiError {
  readonly message: string;
  readonly retryable: boolean;
}

export interface AutomationState {
  readonly tools: readonly AutomationTool[];
  /** True once the first `list` call has answered, whatever it said. */
  readonly initialized: boolean;
  /** True when the main process reports an action already running. */
  readonly remoteBusy: boolean;
  readonly busy: AutomationOperation | null;
  /** The id of the tool currently running, so Cancel has an address. */
  readonly runningToolId: string | null;
  readonly runningRunId: string | null;
  /** The most recent run's record, or `null`. */
  readonly lastRun: AutomationRunResult | null;
  readonly activity: string | null;
  readonly error: AutomationUiError | null;
}

export type AutomationListener = (state: AutomationState) => void;

/**
 * One user-facing sentence per normalized failure code.
 *
 * Written here, in the renderer, deliberately: the main process's own
 * messages never cross the IPC boundary, so these are the only automation
 * error strings a person ever sees.
 */
const FAILURE_MESSAGES: Readonly<Record<AutomationErrorCode, string>> = {
  AUTOMATION_TOOL_NOT_FOUND: 'That tool is not registered.',
  AUTOMATION_NO_PROJECT: 'This action needs an approved project. Open one in the Workspace first.',
  AUTOMATION_ALREADY_RUNNING: 'Another automation action is already running.',
  AUTOMATION_LAUNCH_FAILED: 'The action could not be started.',
  AUTOMATION_VERIFICATION_FAILED: 'The action ran, but Local Agent could not confirm it succeeded.',
  AUTOMATION_TIMEOUT: 'The action did not finish in time and was stopped.',
  AUTOMATION_CANCELLED: 'The action was cancelled.',
  AUTOMATION_EMERGENCY_STOPPED: 'The emergency stop was engaged, so the action stopped.',
  AUTOMATION_RUN_FAILED: 'The action did not complete.',
};

const DENIED_MESSAGE =
  'This action was refused. The emergency stop may be engaged, or the permission policy does not allow it.';

const DECLINED_MESSAGE = 'You declined the confirmation, so nothing was done.';

/** Codes that mean "trying again might help" rather than "the answer will be the same next time". */
const RETRYABLE_CODES: readonly AutomationErrorCode[] = [
  'AUTOMATION_LAUNCH_FAILED',
  'AUTOMATION_VERIFICATION_FAILED',
  'AUTOMATION_TIMEOUT',
  'AUTOMATION_ALREADY_RUNNING',
  'AUTOMATION_RUN_FAILED',
];

const INITIAL_STATE: AutomationState = {
  tools: [],
  initialized: false,
  remoteBusy: false,
  busy: null,
  runningToolId: null,
  runningRunId: null,
  lastRun: null,
  activity: null,
  error: null,
};

export interface AutomationControllerDeps {
  readonly client: AutomationClient;
  /** Injectable for deterministic tests. Defaults to `crypto.randomUUID()`. */
  readonly newRunId?: () => string;
}

export class AutomationController {
  private readonly client: AutomationClient;
  private readonly newRunId: () => string;
  private readonly listeners = new Set<AutomationListener>();

  private state: AutomationState = INITIAL_STATE;

  /** Incremented for every request. A stale response is discarded. */
  private sequence = 0;
  private disposed = false;

  /** The last operation, so Retry has something to repeat. */
  private lastAttempt: (() => Promise<void>) | null = null;

  constructor(deps: AutomationControllerDeps) {
    this.client = deps.client;
    this.newRunId = deps.newRunId ?? (() => crypto.randomUUID());
  }

  getState(): AutomationState {
    return this.state;
  }

  subscribe(listener: AutomationListener): () => void {
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

  async refresh(): Promise<void> {
    if (this.state.busy !== null) return;

    this.lastAttempt = async (): Promise<void> => {
      await this.refresh();
    };

    const sequence = this.beginOperation('list');
    const result = await this.client.list();
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        initialized: true,
        tools: result.value.tools,
        remoteBusy: result.value.busy,
        error: null,
      });
      return;
    }

    this.patch({ busy: null, initialized: true, ...this.failurePatch(result.failure) });
  }

  /**
   * Runs one registered tool.
   *
   * `toolId` is the only thing sent. What the tool actually does comes from
   * the fixed registry the main process reads — this controller cannot name a
   * path, a URL or a command, and has no field through which it could try.
   */
  async runTool(toolId: string): Promise<void> {
    if (this.state.busy !== null) return;

    const runId = this.newRunId();
    this.lastAttempt = async (): Promise<void> => {
      await this.runTool(toolId);
    };

    const sequence = this.beginOperation('run');
    this.patch({ runningToolId: toolId, runningRunId: runId, lastRun: null });

    const result = await this.client.run(runId, toolId);
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        runningToolId: null,
        runningRunId: null,
        lastRun: result.value,
        activity: describeRun(result.value),
        error: null,
      });
      return;
    }

    this.patch({
      busy: null,
      runningToolId: null,
      runningRunId: null,
      ...this.failurePatch(result.failure),
    });
  }

  /** Best effort: abandons a launch attempt in progress. Never kills an already-started application. */
  async cancelRun(): Promise<void> {
    const runId = this.state.runningRunId;
    if (runId === null) return;
    await this.client.cancel(runId);
    if (this.disposed) return;
    this.patch({ activity: 'Asked the action to stop.' });
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

  private failurePatch(failure: AutomationFailure): Partial<AutomationState> {
    if (failure.kind === 'denied') {
      return { error: { message: DENIED_MESSAGE, retryable: false }, activity: null };
    }
    if (failure.kind === 'declined') {
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

  private beginOperation(operation: AutomationOperation): number {
    this.sequence += 1;
    this.patch({ busy: operation, error: null });
    return this.sequence;
  }

  private isStale(sequence: number): boolean {
    return this.disposed || sequence !== this.sequence;
  }

  private patch(changes: Partial<AutomationState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.state);
  }
}

/**
 * One plain sentence describing how a run ended.
 *
 * Built from the record's own bounded enums and counts, never from any raw
 * text, so this cannot become a way for main-process wording to reach the
 * screen indirectly.
 */
export function describeRun(run: AutomationRunResult): string {
  const attempts = run.attempts > 1 ? ` after ${String(run.attempts)} attempts` : '';
  return `${run.outcome}${attempts}.`;
}
