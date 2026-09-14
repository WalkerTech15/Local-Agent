/**
 * Agent profile and run state management (Phase 2, Milestone 7).
 *
 * Framework-independent, exactly like `chat/conversation-controller.ts` and
 * `workspace/workspace-controller.ts`, and for the same reason: React Testing
 * Library and jsdom are not part of this project's toolchain
 * (`docs/security-model.md`, known limitation 18), so every behaviour worth
 * testing — loading, empty, error, retry, staleness, cancellation — lives
 * here, where plain Vitest can drive it.
 *
 * Three properties this module is responsible for:
 *
 *  - **One operation at a time, and the last one wins.** Every request takes a
 *    sequence number; a response whose number is no longer current is
 *    discarded rather than applied over newer state.
 *  - **No message from the main process is ever displayed.** Failures arrive
 *    as a bounded `AgentErrorCode`, and the sentence the user reads comes from
 *    {@link FAILURE_MESSAGES} below — this file's own reviewed strings.
 *  - **Declining is not failing.** Answering "no" to a native confirmation
 *    comes back as `outcome: 'aborted'`, reported as an ordinary activity note
 *    rather than an error banner.
 *
 * It holds **no authority of its own.** Nothing here decides what an agent may
 * do: the profile on disk does, the permission engine decides every action,
 * and the native dialogs the main process owns are what a person actually
 * approves. A compromised renderer can misdescribe a profile on screen; it
 * cannot change what the profile permits, because it never sends one that was
 * not validated in the main process first.
 *
 * Never imports Electron, never touches `window.localAgent` (that is
 * `ipc-agent-client.ts`'s single job), and never reaches the filesystem or the
 * network.
 */

import type { AgentClient, AgentFailure, AgentRegistryView } from './ipc-agent-client';
import type { AgentErrorCode } from '../../shared/agent';
import type { AgentProfile, AgentProfileInput, AgentRun } from '../../shared/schemas';

/** Which request is in flight, for the interface's own status line. */
export type AgentOperation =
  'list' | 'select' | 'create' | 'update' | 'delete' | 'set-enabled' | 'run';

export interface AgentUiError {
  readonly message: string;
  /** True when re-running the same request could plausibly succeed. */
  readonly retryable: boolean;
}

export interface AgentState {
  readonly profiles: readonly AgentProfile[];
  /** `null` until the first `list` answers. */
  readonly activeProfileId: string | null;
  /** True once the first `list` call has answered, whatever it said. */
  readonly initialized: boolean;
  readonly busy: AgentOperation | null;
  /** The most recent run's record, or `null`. */
  readonly run: AgentRun | null;
  /** The id of the run currently in flight, so cancelling has an address. */
  readonly runningRunId: string | null;
  readonly activity: string | null;
  readonly error: AgentUiError | null;
}

export type AgentListener = (state: AgentState) => void;

/**
 * One user-facing sentence per normalized failure code.
 *
 * Written here, in the renderer, deliberately: the main process's own messages
 * never cross the IPC boundary, so these are the only agent error strings a
 * person ever sees, and they are reviewable in one place.
 */
const FAILURE_MESSAGES: Readonly<Record<AgentErrorCode, string>> = {
  AGENT_PROFILE_NOT_FOUND: 'That agent profile no longer exists.',
  AGENT_PROFILE_EXISTS: 'That identifier is already taken. Choose another.',
  AGENT_PROFILE_READ_ONLY:
    'Built-in profiles ship with the application and cannot be edited, disabled or deleted. Create your own to change what an agent may do.',
  AGENT_PROFILE_DISABLED: 'That profile is disabled. Enable it before selecting or running it.',
  AGENT_PROFILE_LIMIT_REACHED: 'There is no room for another profile. Delete one first.',
  AGENT_PROFILE_INVALID: 'That profile is not valid, so nothing was saved.',
  AGENT_PROFILE_STORE_FAILED: 'The profile could not be saved. Nothing was changed.',
  AGENT_TOOL_NOT_ALLOWED: 'The run asked for a tool this profile does not allow, so it stopped.',
  AGENT_WORKSPACE_NOT_ALLOWED:
    'The run asked for a part of the project this profile does not cover, so it stopped.',
  AGENT_PROVIDER_UNAVAILABLE: 'No configured provider is usable for this profile.',
  AGENT_RUN_ALREADY_RUNNING: 'A run is already in progress. Wait for it, or cancel it first.',
  AGENT_NO_PROJECT: 'No project is open. Select one in the Workspace before running an agent.',
  AGENT_LIMIT_REACHED: 'The run reached one of its own limits and stopped.',
  AGENT_RUN_CANCELLED: 'The run was cancelled.',
  AGENT_EMERGENCY_STOPPED: 'The emergency stop was engaged, so the run stopped.',
  AGENT_VERIFICATION_FAILED: 'The run finished, but its verification requirements were not met.',
  AGENT_RUN_FAILED: 'The run did not complete.',
};

const DENIED_MESSAGE =
  'This action was refused. The emergency stop may be engaged, or the permission policy does not allow it.';

const DECLINED_MESSAGE = 'You declined the confirmation, so nothing was changed.';

/**
 * Codes that mean "trying again might help" rather than "the answer will be
 * the same next time".
 *
 * A read-only built-in, a taken identifier and an invalid profile will not
 * become different on a second attempt, so offering Retry for those would be
 * misleading.
 */
const RETRYABLE_CODES: readonly AgentErrorCode[] = [
  'AGENT_PROFILE_STORE_FAILED',
  'AGENT_RUN_FAILED',
  'AGENT_RUN_ALREADY_RUNNING',
];

const INITIAL_STATE: AgentState = {
  profiles: [],
  activeProfileId: null,
  initialized: false,
  busy: null,
  run: null,
  runningRunId: null,
  activity: null,
  error: null,
};

export interface AgentControllerDeps {
  readonly client: AgentClient;
  /** Injectable for deterministic tests. Defaults to `crypto.randomUUID()`. */
  readonly newRunId?: () => string;
}

export class AgentController {
  private readonly client: AgentClient;
  private readonly newRunId: () => string;
  private readonly listeners = new Set<AgentListener>();

  private state: AgentState = INITIAL_STATE;

  /**
   * Incremented for every request. A response carrying a stale sequence is
   * discarded rather than applied over newer state — the same staleness guard
   * `WorkspaceController` uses.
   */
  private sequence = 0;
  private disposed = false;

  /** The last operation, so Retry has something to repeat. */
  private lastAttempt: (() => Promise<void>) | null = null;

  constructor(deps: AgentControllerDeps) {
    this.client = deps.client;
    this.newRunId = deps.newRunId ?? (() => crypto.randomUUID());
  }

  getState(): AgentState {
    return this.state;
  }

  subscribe(listener: AgentListener): () => void {
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

  refresh(): Promise<void> {
    return this.runRegistryOperation('list', () => this.client.list(), null);
  }

  selectProfile(profileId: string): Promise<void> {
    return this.runRegistryOperation(
      'select',
      () => this.client.select(profileId),
      'Active profile changed.',
    );
  }

  createProfile(profile: AgentProfileInput): Promise<void> {
    return this.runRegistryOperation(
      'create',
      () => this.client.create(profile),
      'Profile created.',
    );
  }

  updateProfile(profileId: string, profile: AgentProfileInput): Promise<void> {
    return this.runRegistryOperation(
      'update',
      () => this.client.update(profileId, profile),
      'Profile saved.',
    );
  }

  deleteProfile(profileId: string): Promise<void> {
    return this.runRegistryOperation(
      'delete',
      () => this.client.remove(profileId),
      'Profile deleted.',
    );
  }

  setProfileEnabled(profileId: string, enabled: boolean): Promise<void> {
    return this.runRegistryOperation(
      'set-enabled',
      () => this.client.setEnabled(profileId, enabled),
      enabled ? 'Profile enabled.' : 'Profile disabled.',
    );
  }

  /**
   * Starts one bounded run.
   *
   * The objective is the only thing sent. What the run may do comes from the
   * stored profile, read in the main process — this controller cannot widen a
   * run, and deliberately has no field through which it could try.
   */
  async startRun(objective: string): Promise<void> {
    if (this.state.busy !== null) return;

    const runId = this.newRunId();
    const attempt = async (): Promise<void> => {
      await this.startRun(objective);
    };
    this.lastAttempt = attempt;

    const sequence = this.beginOperation('run');
    this.patch({ runningRunId: runId, run: null });

    const result = await this.client.run(runId, objective);
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        runningRunId: null,
        run: result.value,
        activity: describeRun(result.value),
        error: null,
      });
      return;
    }

    this.patch({ busy: null, runningRunId: null, ...this.failurePatch(result.failure) });
  }

  /**
   * Asks the main process to stop the run in flight.
   *
   * Best effort and idempotent: the `agent:run` call already in flight is what
   * ultimately answers, with a record whose `stopReason` says it was
   * cancelled. Nothing is patched here beyond noting that the request was
   * sent, so the interface never claims a run stopped before it actually did.
   */
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

  private async runRegistryOperation(
    operation: AgentOperation,
    request: () => Promise<
      { ok: true; value: AgentRegistryView } | { ok: false; failure: AgentFailure }
    >,
    successActivity: string | null,
  ): Promise<void> {
    if (this.state.busy !== null) return;

    this.lastAttempt = async (): Promise<void> => {
      await this.runRegistryOperation(operation, request, successActivity);
    };

    const sequence = this.beginOperation(operation);
    const result = await request();
    if (this.isStale(sequence)) return;

    if (result.ok) {
      this.patch({
        busy: null,
        initialized: true,
        profiles: result.value.profiles,
        activeProfileId: result.value.activeProfileId,
        ...(successActivity === null ? {} : { activity: successActivity }),
        error: null,
      });
      return;
    }

    this.patch({ busy: null, initialized: true, ...this.failurePatch(result.failure) });
  }

  private failurePatch(failure: AgentFailure): Partial<AgentState> {
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

  private beginOperation(operation: AgentOperation): number {
    this.sequence += 1;
    this.patch({ busy: operation, error: null });
    return this.sequence;
  }

  private isStale(sequence: number): boolean {
    return this.disposed || sequence !== this.sequence;
  }

  private patch(changes: Partial<AgentState>): void {
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
export function describeRun(run: AgentRun): string {
  const verified =
    run.verification.required.length === 0
      ? 'no verification required'
      : run.verification.passed
        ? 'verification passed'
        : `verification failed (${String(run.verification.satisfied.length)}/${String(run.verification.required.length)})`;
  return `${run.status} after ${String(run.totals.steps)} step(s) — ${run.stopReason}, ${verified}.`;
}
