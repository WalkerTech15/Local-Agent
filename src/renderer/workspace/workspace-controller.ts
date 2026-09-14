/**
 * Coding-workspace state management (Phase 2, Milestones 5-6).
 *
 * Framework-independent, exactly like `chat/conversation-controller.ts` and
 * for the same reason: React Testing Library and jsdom are not part of this
 * project's toolchain (`docs/security-model.md`, known limitation 18), so
 * every behaviour worth testing — loading, empty, error, retry, staleness,
 * the approval gates — lives here, where plain Vitest can drive it, rather
 * than inside a component nothing can render.
 *
 * Four properties this module is responsible for:
 *
 *  - **One operation at a time, and the last one wins.** Every request takes
 *    a sequence number; a response whose number is no longer current is
 *    discarded rather than applied over newer state. This is the same
 *    staleness guard `ConversationController` implements with its
 *    `AbortController` identity check.
 *  - **No message from the main process is ever displayed.** Failures arrive
 *    as a bounded `WorkspaceErrorCode`, and the sentence the user reads comes
 *    from {@link FAILURE_MESSAGES} below — this file's own reviewed strings.
 *  - **Approval is recorded here and enforced there.** `approveChange` is the
 *    interface's own gate: a change cannot be sent for application until the
 *    user has looked at its diff and approved it. That gate is *not* the
 *    security control — the native confirmation the main process owns is, and
 *    it runs whatever this controller believes. A compromised renderer can
 *    skip this flag; it cannot skip that dialog.
 *  - **Declining is not failing.** Answering "no" to a native confirmation
 *    comes back as `outcome: 'aborted'`, which this controller reports as an
 *    ordinary activity note rather than an error banner. Telling someone
 *    their own refusal had gone wrong would be its own misinformation.
 *
 * Never imports Electron, never touches `window.localAgent` (that is
 * `ipc-workspace-client.ts`'s single job), and never reaches the filesystem
 * or the network.
 */

import type { WorkspaceClient, WorkspaceFailure } from './ipc-workspace-client';
import type {
  CodingPlan,
  CommandCatalog,
  CommandIdValue,
  CommandRunResult,
  GitCheckpointValue,
  GitDiffValue,
  GitStatusValue,
  WorkspaceChangeHistory,
  WorkspaceChangeSet,
  WorkspaceEdit,
  WorkspaceFile,
  WorkspaceProjectSummary,
  WorkspaceSearchResult,
  WorkspaceTree,
} from '../../shared/schemas';
import type { WorkspaceErrorCode } from '../../shared/workspace';

/** Which request is in flight, for the interface's own status line. */
export type WorkspaceOperation =
  | 'status'
  | 'select'
  | 'tree'
  | 'file'
  | 'search'
  | 'plan'
  | 'propose'
  | 'apply'
  | 'rollback'
  | 'changes'
  | 'commands'
  | 'run'
  | 'git-status'
  | 'git-diff'
  | 'checkpoint';

export interface WorkspaceUiError {
  readonly message: string;
  /** True when re-running the same request could plausibly succeed. */
  readonly retryable: boolean;
}

/** Which command is running, so cancellation has something to address. */
export interface RunningCommand {
  readonly runId: string;
  readonly commandId: CommandIdValue;
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
   * inherited by a plan the user has not seen.
   */
  readonly planApproved: boolean;

  // Controlled coding actions (Phase 2, Milestone 6).

  /** The change set currently under review, or the last one settled. */
  readonly change: WorkspaceChangeSet | null;
  /**
   * Whether the user has approved the change on screen.
   *
   * Reset for every newly proposed change set, so approval is never inherited
   * by a diff the user has not seen. `applyChange` refuses without it.
   */
  readonly changeApproved: boolean;
  readonly history: WorkspaceChangeHistory | null;
  readonly commands: CommandCatalog | null;
  readonly commandRun: CommandRunResult | null;
  readonly runningCommand: RunningCommand | null;
  readonly gitStatus: GitStatusValue | null;
  readonly gitDiff: GitDiffValue | null;
  readonly checkpoint: GitCheckpointValue | null;

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

  WORKSPACE_CHANGE_NOT_FOUND:
    'That proposed change is no longer available. Prepare it again to review a fresh diff.',
  WORKSPACE_CHANGE_STALE:
    'The file changed after this diff was produced, so nothing was written. Prepare the change again against the current contents.',
  WORKSPACE_CHANGE_SETTLED: 'That change has already been applied or undone.',
  WORKSPACE_CHANGE_EMPTY: 'That change would leave every file exactly as it is.',
  WORKSPACE_CHANGE_TOO_LARGE: 'That change is larger than this workspace will apply in one step.',
  WORKSPACE_WRITE_FAILED:
    'The change could not be written. Every file it had already changed was restored.',
  WORKSPACE_ROLLBACK_UNAVAILABLE: 'There is no applied change left to undo.',
  WORKSPACE_BACKUP_FAILED: 'The backup could not be taken, so nothing was written.',

  COMMAND_NOT_AVAILABLE: 'This project does not define that command.',
  COMMAND_ALREADY_RUNNING: 'A command is already running. Wait for it, or cancel it first.',
  COMMAND_TIMED_OUT: 'The command ran past its time limit and was stopped.',
  COMMAND_CANCELLED: 'The command was cancelled.',
  COMMAND_STOPPED_BY_EMERGENCY:
    'The emergency stop was engaged, so the running command was stopped.',
  COMMAND_LAUNCH_FAILED: 'The command could not be started. Check that npm is installed.',

  GIT_UNAVAILABLE: 'Git is not available on this machine.',
  GIT_NOT_A_REPOSITORY:
    'This project is not the root of a Git working tree, so Git operations are not offered.',
  GIT_DETACHED_HEAD: 'No branch is checked out, so a checkpoint commit was not created.',
  GIT_NOTHING_TO_COMMIT: 'There is nothing uncommitted, so there is nothing to check point.',
  GIT_COMMAND_FAILED: 'Git reported a failure. Nothing was changed.',
};

const DENIED_MESSAGE =
  'This action was refused. The emergency stop may be engaged, or the permission policy does not allow it.';

const DECLINED_MESSAGE = 'You declined the confirmation, so nothing was changed.';

/**
 * Codes that mean "the request failed and trying again might help" as opposed
 * to "the answer will be the same next time".
 *
 * An excluded path, an oversized file, a stale diff or an already-settled
 * change will not become different on a second attempt, so offering Retry for
 * those would be misleading.
 */
const RETRYABLE_CODES: readonly WorkspaceErrorCode[] = [
  'WORKSPACE_ACCESS_DENIED',
  'WORKSPACE_READ_FAILED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_WRITE_FAILED',
  'WORKSPACE_BACKUP_FAILED',
  'COMMAND_LAUNCH_FAILED',
  'COMMAND_ALREADY_RUNNING',
  'GIT_COMMAND_FAILED',
];

function describeFailure(failure: WorkspaceFailure): WorkspaceUiError {
  if (failure.kind === 'denied') return { message: DENIED_MESSAGE, retryable: true };
  if (failure.kind === 'declined') return { message: DECLINED_MESSAGE, retryable: true };
  return {
    message: FAILURE_MESSAGES[failure.code],
    retryable: RETRYABLE_CODES.includes(failure.code),
  };
}

/** One clause describing how a run ended, for the activity line. */
function describeRunOutcome(run: CommandRunResult): string {
  if (run.stoppedByEmergency) return 'was stopped by the emergency stop.';
  if (run.timedOut) return 'ran past its time limit and was stopped.';
  if (run.cancelled) return 'was cancelled.';
  if (run.outcome === 'succeeded') return 'succeeded.';
  return `failed with exit code ${run.exitCode === null ? 'unknown' : String(run.exitCode)}.`;
}

/** What `retry()` would re-run. */
type Attempt =
  | { readonly operation: 'status' }
  | { readonly operation: 'select' }
  | { readonly operation: 'tree'; readonly path: string }
  | { readonly operation: 'file'; readonly path: string }
  | { readonly operation: 'search'; readonly query: string; readonly path: string }
  | { readonly operation: 'plan'; readonly objective: string }
  | { readonly operation: 'propose'; readonly edits: readonly WorkspaceEdit[] }
  | { readonly operation: 'apply' }
  | { readonly operation: 'rollback' }
  | { readonly operation: 'changes' }
  | { readonly operation: 'commands' }
  | { readonly operation: 'run'; readonly commandId: CommandIdValue }
  | { readonly operation: 'git-status' }
  | { readonly operation: 'git-diff'; readonly path: string | null }
  | { readonly operation: 'checkpoint' };

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
    change: null,
    changeApproved: false,
    history: null,
    commands: null,
    commandRun: null,
    runningCommand: null,
    gitStatus: null,
    gitDiff: null,
    checkpoint: null,
    activity: null,
    error: null,
  };
}

export interface WorkspaceControllerDeps {
  readonly client: WorkspaceClient;
  /**
   * Produces the identifier a later cancellation refers to.
   *
   * Injected so a test can drive cancellation deterministically rather than
   * having to observe an identifier the controller generated privately.
   */
  readonly newRunId?: () => string;
}

export class WorkspaceController {
  private readonly client: WorkspaceClient;
  private readonly newRunId: () => string;
  private readonly listeners = new Set<WorkspaceListener>();
  private state: WorkspaceState = initialState();
  private sequence = 0;
  private lastAttempt: Attempt | null = null;
  private disposed = false;

  constructor(deps: WorkspaceControllerDeps) {
    this.client = deps.client;
    this.newRunId = deps.newRunId ?? (() => crypto.randomUUID());
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
    // Answering "no" to a native confirmation is the same kind of thing: a
    // decision, not a failure. It is reported, never shown as an error.
    if (failure.kind === 'declined') {
      this.setState({
        ...this.state,
        busy: null,
        runningCommand: null,
        activity: 'Confirmation declined. Nothing was changed.',
      });
      return;
    }
    this.setState({
      ...this.state,
      busy: null,
      runningCommand: null,
      error: describeFailure(failure),
    });
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

    // A new project invalidates everything that described the previous one —
    // including any proposed change, which belonged to the old project and
    // must never be applicable to the new one.
    this.setState({
      ...this.state,
      busy: null,
      project: result.value,
      tree: null,
      openFile: null,
      search: null,
      plan: null,
      planApproved: false,
      change: null,
      changeApproved: false,
      history: null,
      commands: null,
      commandRun: null,
      gitStatus: null,
      gitDiff: null,
      checkpoint: null,
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
   * A plan still describes rather than does: nothing acts on one, and
   * approving it authorizes nothing. Preparing a change is a separate,
   * explicit step, with its own diff and its own approval.
   */
  approvePlan(): void {
    if (this.state.plan === null) return;
    if (this.state.planApproved) return;
    this.setState({
      ...this.state,
      planApproved: true,
      activity: 'Plan approved. Preparing a change is still a separate, explicit step.',
    });
  }

  // -------------------------------------------------------------------------
  // Change sets (Phase 2, Milestone 6)
  // -------------------------------------------------------------------------

  /**
   * Sends proposed file contents and gets back a diff. Writes nothing.
   *
   * Approval is reset here, unconditionally, so a change the user approved a
   * moment ago can never carry its approval over to a different diff.
   */
  async proposeChange(edits: readonly WorkspaceEdit[]): Promise<void> {
    if (edits.length === 0) return;

    const sequence = this.begin('propose', { operation: 'propose', edits });
    const result = await this.client.propose(edits);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.setState({ ...this.state, change: null, changeApproved: false });
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      change: result.value,
      changeApproved: false,
      activity: `Prepared a change to ${String(result.value.files.length)} file(s): +${String(result.value.totalAdded)} / -${String(result.value.totalRemoved)}. Nothing has been written.`,
    });
  }

  /**
   * Records that the user has read the diff and approves it.
   *
   * The interface's gate, not the security control — `applyChange` refuses
   * without it, but the native confirmation the main process owns is what
   * actually authorizes the write, and it runs whatever this flag says.
   */
  approveChange(): void {
    if (this.state.change === null) return;
    if (this.state.change.status !== 'awaiting-approval') return;
    if (this.state.changeApproved) return;
    this.setState({
      ...this.state,
      changeApproved: true,
      activity: 'Change approved here. Applying it still requires the system confirmation.',
    });
  }

  /**
   * Applies the approved change set.
   *
   * Sends the change *id* and nothing else: the content that gets written is
   * the content the main process already holds and already diffed, so what
   * was reviewed is necessarily what is applied.
   */
  async applyChange(): Promise<void> {
    const change = this.state.change;
    if (change === null) return;
    if (change.status !== 'awaiting-approval') return;
    if (!this.state.changeApproved) return;

    const sequence = this.begin('apply', { operation: 'apply' });
    const result = await this.client.apply(change.id);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      change: result.value,
      changeApproved: false,
      // Whatever the viewer was showing is now out of date with the disk.
      openFile: null,
      activity: `Applied a change to ${String(result.value.files.length)} file(s). A backup was kept, so it can be undone.`,
    });
    await this.refreshChanges();
  }

  /** Restores the backup taken before the most recent applied change. */
  async rollbackLatest(): Promise<void> {
    const target = this.state.history?.rollbackTarget ?? null;
    if (target === null) return;

    const sequence = this.begin('rollback', { operation: 'rollback' });
    const result = await this.client.rollback(target);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      change: result.value,
      changeApproved: false,
      openFile: null,
      activity: `Undid a change to ${String(result.value.files.length)} file(s).`,
    });
    await this.refreshChanges();
  }

  /** Reads this session's change history and what a rollback would target. */
  async refreshChanges(): Promise<void> {
    const sequence = this.begin('changes', { operation: 'changes' });
    const result = await this.client.changes();
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({ ...this.state, busy: null, history: result.value });
  }

  // -------------------------------------------------------------------------
  // Commands (Phase 2, Milestone 6)
  // -------------------------------------------------------------------------

  /** Reads which registry commands this project actually declares. */
  async refreshCommands(): Promise<void> {
    const sequence = this.begin('commands', { operation: 'commands' });
    const result = await this.client.commands();
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({ ...this.state, busy: null, commands: result.value });
  }

  /**
   * Runs one registry command.
   *
   * Sends an identifier from the enum, never a command line. The run id is
   * generated here so `cancelCommand` has something to address while the
   * request is still in flight.
   */
  async runCommand(commandId: CommandIdValue): Promise<void> {
    const runId = this.newRunId();
    const sequence = this.begin('run', { operation: 'run', commandId });
    this.setState({ ...this.state, runningCommand: { runId, commandId } });

    const result = await this.client.runCommand(runId, commandId);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    const run = result.value;
    this.setState({
      ...this.state,
      busy: null,
      runningCommand: null,
      commandRun: run,
      activity: `${run.commandLine} ${describeRunOutcome(run)}`,
    });
  }

  /**
   * Asks the main process to stop the running command.
   *
   * Deliberately does not go through {@link begin}: cancellation has to work
   * *while* a command is in flight, which is exactly when the controller is
   * busy. Best-effort and idempotent, like `chat:cancel`.
   */
  async cancelCommand(): Promise<void> {
    const running = this.state.runningCommand;
    if (running === null) return;
    await this.client.cancelCommand(running.runId);
    this.setState({ ...this.state, activity: 'Asked the running command to stop.' });
  }

  // -------------------------------------------------------------------------
  // Git (Phase 2, Milestone 6)
  // -------------------------------------------------------------------------

  async refreshGitStatus(): Promise<void> {
    const sequence = this.begin('git-status', { operation: 'git-status' });
    const result = await this.client.gitStatus();
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      gitStatus: result.value,
      activity: result.value.clean
        ? 'Working tree is clean.'
        : `${String(result.value.entries.length)} changed path(s) in Git.`,
    });
  }

  async refreshGitDiff(path: string | null = null): Promise<void> {
    const sequence = this.begin('git-diff', { operation: 'git-diff', path });
    const result = await this.client.gitDiff(path);
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      gitDiff: result.value,
      activity: result.value.empty ? 'Git reports no differences.' : 'Read the working-tree diff.',
    });
  }

  /** Creates one checkpoint commit, after the native confirmation. */
  async createCheckpoint(): Promise<void> {
    const sequence = this.begin('checkpoint', { operation: 'checkpoint' });
    const result = await this.client.gitCheckpoint();
    if (!this.isCurrent(sequence)) return;

    if (!result.ok) {
      this.fail(sequence, result.failure);
      return;
    }

    this.setState({
      ...this.state,
      busy: null,
      checkpoint: result.value,
      activity: `Checkpoint ${result.value.commit} created on ${result.value.branch} (${String(result.value.filesChanged)} path(s)).`,
    });
    await this.refreshGitStatus();
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
   *
   * Note what retrying an `apply` does: it re-runs `applyChange`, which still
   * requires the approval flag *and* still passes through the native
   * confirmation. Retry is not a way around either gate.
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
      case 'propose':
        await this.proposeChange(attempt.edits);
        return;
      case 'apply':
        await this.applyChange();
        return;
      case 'rollback':
        await this.rollbackLatest();
        return;
      case 'changes':
        await this.refreshChanges();
        return;
      case 'commands':
        await this.refreshCommands();
        return;
      case 'run':
        await this.runCommand(attempt.commandId);
        return;
      case 'git-status':
        await this.refreshGitStatus();
        return;
      case 'git-diff':
        await this.refreshGitDiff(attempt.path);
        return;
      case 'checkpoint':
        await this.createCheckpoint();
        return;
    }
  }

  /**
   * Stops delivering state updates.
   *
   * Called from `useWorkspace.ts`'s unmount cleanup. A running command is
   * asked to stop, because unlike every read operation it holds a real
   * process; everything else is simply discarded on arrival, which is what
   * {@link isCurrent} already guarantees for a superseded request.
   */
  dispose(): void {
    const running = this.state.runningCommand;
    if (running !== null) void this.client.cancelCommand(running.runId).catch(() => undefined);
    this.disposed = true;
  }
}
