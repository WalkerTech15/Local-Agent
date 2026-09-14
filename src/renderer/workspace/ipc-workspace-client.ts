/**
 * The renderer's one seam to the read-only coding workspace (Phase 2,
 * Milestone 5).
 *
 * This is the only file under `src/renderer/workspace` permitted to reference
 * `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does, exactly as it already
 * does for `ipc-chat-provider.ts` under `src/renderer/chat`. Every other
 * workspace file in the renderer talks to this module, never to the bridge.
 *
 * It performs no filesystem access, and structurally cannot: it calls only
 * the six narrow, typed, schema-validated functions the preload bridge
 * exposes. The actual `readdir`/`readFile`, the path containment checks and
 * the exclusion rules all live in the main process.
 *
 * **Nothing that crossed the boundary is trusted as text.** A failure yields
 * only the bounded `WorkspaceErrorCode` enum; the sentence a user reads is
 * always one of `workspace-controller.ts`'s own reviewed strings, never
 * anything reconstructed from a main-process message — the same rule
 * `ConversationController` already follows for provider failures.
 */

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
import { isWorkspaceErrorCode } from '../../shared/workspace';
import type { WorkspaceErrorCode } from '../../shared/workspace';

/**
 * Why a request did not produce a value.
 *
 * `'denied'` is kept distinct from every error code because it is not a
 * failure of the operation at all: the permission engine or the emergency
 * stop refused it, and that deserves its own message rather than being folded
 * into "could not read".
 *
 * `'declined'` is the Milestone 6 addition, and it matters more than it
 * looks: it is the user answering "no" to the native confirmation that guards
 * every write, every command and every checkpoint. Reporting that as an error
 * would tell someone their own deliberate refusal had failed.
 */
export type WorkspaceFailure =
  | { readonly kind: 'denied' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly code: WorkspaceErrorCode };

export type WorkspaceResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: WorkspaceFailure };

/** The shape every workspace IPC response shares. */
interface OutcomeCarrier {
  readonly outcome: string;
  readonly errorCode?: string | undefined;
}

function failureFrom(response: OutcomeCarrier): WorkspaceFailure {
  if (response.outcome === 'denied') return { kind: 'denied' };
  // `aborted` is what `execute` returns for a rejected confirmation.
  if (response.outcome === 'aborted') return { kind: 'declined' };
  const code = response.errorCode;
  return {
    kind: 'error',
    // An unrecognised code degrades to the generic read failure rather than
    // being shown, so a value that somehow bypassed the response schema still
    // cannot reach the interface as text.
    code: code !== undefined && isWorkspaceErrorCode(code) ? code : 'WORKSPACE_READ_FAILED',
  };
}

function unwrap<TValue>(
  response: OutcomeCarrier,
  value: TValue | undefined,
): WorkspaceResult<TValue> {
  if (response.outcome === 'success' && value !== undefined) return { ok: true, value };
  return { ok: false, failure: failureFrom(response) };
}

/**
 * The typed operations `WorkspaceController` depends on.
 *
 * An interface rather than a direct import so the controller can be tested
 * against a fake with no `window` at all — the same injection
 * `ConversationController` uses for its `ChatProvider`.
 */
export interface WorkspaceClient {
  status(): Promise<WorkspaceResult<WorkspaceProjectSummary | null>>;
  /** Opens the native picker. Takes no path: the user chooses, not the caller. */
  select(): Promise<WorkspaceResult<WorkspaceProjectSummary | null>>;
  tree(path: string): Promise<WorkspaceResult<WorkspaceTree>>;
  file(path: string): Promise<WorkspaceResult<WorkspaceFile>>;
  search(query: string, path: string): Promise<WorkspaceResult<WorkspaceSearchResult>>;
  plan(objective: string): Promise<WorkspaceResult<CodingPlan>>;

  // Controlled coding actions (Phase 2, Milestone 6).

  /** Produces a diff. Writes nothing. */
  propose(edits: readonly WorkspaceEdit[]): Promise<WorkspaceResult<WorkspaceChangeSet>>;
  /** Applies a change the main process holds, by id — never by content. */
  apply(changeId: string): Promise<WorkspaceResult<WorkspaceChangeSet>>;
  rollback(changeId: string): Promise<WorkspaceResult<WorkspaceChangeSet>>;
  changes(): Promise<WorkspaceResult<WorkspaceChangeHistory>>;
  commands(): Promise<WorkspaceResult<CommandCatalog>>;
  runCommand(runId: string, commandId: CommandIdValue): Promise<WorkspaceResult<CommandRunResult>>;
  cancelCommand(runId: string): Promise<void>;
  gitStatus(): Promise<WorkspaceResult<GitStatusValue>>;
  gitDiff(path: string | null): Promise<WorkspaceResult<GitDiffValue>>;
  gitCheckpoint(): Promise<WorkspaceResult<GitCheckpointValue>>;
}

export function createIpcWorkspaceClient(): WorkspaceClient {
  return {
    async status() {
      const response = await window.localAgent.workspace.status();
      return unwrap(response, response.project);
    },
    async select() {
      const response = await window.localAgent.workspace.select();
      return unwrap(response, response.project);
    },
    async tree(path: string) {
      const response = await window.localAgent.workspace.tree(path);
      return unwrap(response, response.tree);
    },
    async file(path: string) {
      const response = await window.localAgent.workspace.file(path);
      return unwrap(response, response.file);
    },
    async search(query: string, path: string) {
      const response = await window.localAgent.workspace.search(query, path);
      return unwrap(response, response.results);
    },
    async plan(objective: string) {
      const response = await window.localAgent.workspace.plan(objective);
      return unwrap(response, response.plan);
    },
    async propose(edits: readonly WorkspaceEdit[]) {
      const response = await window.localAgent.workspace.propose(edits);
      return unwrap(response, response.change);
    },
    async apply(changeId: string) {
      const response = await window.localAgent.workspace.apply(changeId);
      return unwrap(response, response.change);
    },
    async rollback(changeId: string) {
      const response = await window.localAgent.workspace.rollback(changeId);
      return unwrap(response, response.change);
    },
    async changes() {
      const response = await window.localAgent.workspace.changes();
      return unwrap(response, response.history);
    },
    async commands() {
      const response = await window.localAgent.command.list();
      return unwrap(response, response.catalog);
    },
    async runCommand(runId: string, commandId: CommandIdValue) {
      const response = await window.localAgent.command.run(runId, commandId);
      return unwrap(response, response.run);
    },
    async cancelCommand(runId: string) {
      await window.localAgent.command.cancel(runId);
    },
    async gitStatus() {
      const response = await window.localAgent.git.status();
      return unwrap(response, response.status);
    },
    async gitDiff(path: string | null) {
      const response = await window.localAgent.git.diff(path);
      return unwrap(response, response.diff);
    },
    async gitCheckpoint() {
      const response = await window.localAgent.git.checkpoint();
      return unwrap(response, response.checkpoint);
    },
  };
}
