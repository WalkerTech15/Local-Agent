/**
 * The normalized error vocabulary for the coding workspace (Phase 2,
 * Milestone 5).
 *
 * Modelled directly on `src/shared/chat/provider.ts`'s five-code provider
 * vocabulary and for the same reason: a caller — including the renderer,
 * across an IPC boundary — must be able to tell *what kind* of thing went
 * wrong without ever receiving a raw error, a filesystem path, or an
 * `errno`. Every failure inside the workspace layer normalizes to exactly
 * one of the codes below before it crosses anything.
 *
 * Each code is a stable symbolic identifier matching the audit log's own
 * `errorCode` pattern (`^[A-Z][A-Z0-9_]{2,63}$`), so it can be recorded
 * unchanged when a workspace action fails.
 *
 * **A message never crosses a boundary.** {@link WorkspaceError}'s `message`
 * exists for main-process debugging only; it is built from the fixed strings
 * below and never interpolates a path, a name, or an underlying error. The
 * renderer maps the *code* to its own reviewed wording — see
 * `src/renderer/workspace/workspace-controller.ts` — exactly as
 * `ConversationController` already does for provider failures.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const WORKSPACE_ERROR_CODES = [
  /** No project has been approved in this session yet. */
  'WORKSPACE_NO_PROJECT',
  /** The user dismissed the native directory picker. Not a failure. */
  'WORKSPACE_SELECTION_CANCELLED',
  /** The chosen location is not a directory this workspace can adopt. */
  'WORKSPACE_INVALID_PROJECT',
  /** The requested path is not a syntactically safe relative path. */
  'WORKSPACE_INVALID_PATH',
  /** The requested path resolves outside the approved project root. */
  'WORKSPACE_PATH_OUTSIDE_PROJECT',
  /** The path names an excluded directory or a credential-bearing file. */
  'WORKSPACE_PATH_EXCLUDED',
  /** Nothing exists at that path. */
  'WORKSPACE_NOT_FOUND',
  /** The operating system refused access. */
  'WORKSPACE_ACCESS_DENIED',
  /** The entry is neither a regular file nor a directory, or is the wrong one. */
  'WORKSPACE_UNSUPPORTED_ENTRY',
  /** The file is larger than the viewer's hard limit. */
  'WORKSPACE_FILE_TOO_LARGE',
  /** The file is not text and will not be decoded as text. */
  'WORKSPACE_BINARY_FILE',
  /** Any other read failure, already stripped of its underlying detail. */
  'WORKSPACE_READ_FAILED',

  // -------------------------------------------------------------------------
  // Change sets (Phase 2, Milestone 6)
  // -------------------------------------------------------------------------

  /** No change set with that identifier is held by this session. */
  'WORKSPACE_CHANGE_NOT_FOUND',
  /** A file changed on disk between the diff being shown and the write. */
  'WORKSPACE_CHANGE_STALE',
  /** The change set has already been applied, or already rolled back. */
  'WORKSPACE_CHANGE_SETTLED',
  /** The proposed content is byte-identical to what is already there. */
  'WORKSPACE_CHANGE_EMPTY',
  /** The proposal exceeds a file-count or byte bound. */
  'WORKSPACE_CHANGE_TOO_LARGE',
  /** The write itself failed. Any file already written was restored. */
  'WORKSPACE_WRITE_FAILED',
  /** There is no applied change set left to roll back. */
  'WORKSPACE_ROLLBACK_UNAVAILABLE',
  /** The pre-change backup could not be taken, so the write did not start. */
  'WORKSPACE_BACKUP_FAILED',

  // -------------------------------------------------------------------------
  // Registry commands (Phase 2, Milestone 6)
  // -------------------------------------------------------------------------

  /** The project does not declare the script this registry command runs. */
  'COMMAND_NOT_AVAILABLE',
  /** A command is already running; only one runs at a time. */
  'COMMAND_ALREADY_RUNNING',
  /** The command exceeded its time limit and was killed. */
  'COMMAND_TIMED_OUT',
  /** The user cancelled the command. */
  'COMMAND_CANCELLED',
  /** The emergency stop was engaged while the command was running. */
  'COMMAND_STOPPED_BY_EMERGENCY',
  /** The process could not be started at all — usually a missing tool. */
  'COMMAND_LAUNCH_FAILED',

  // -------------------------------------------------------------------------
  // Git (Phase 2, Milestone 6)
  // -------------------------------------------------------------------------

  /** No usable `git` executable, or it could not be started. */
  'GIT_UNAVAILABLE',
  /** The approved project is not a Git working tree. */
  'GIT_NOT_A_REPOSITORY',
  /** HEAD is detached, so a checkpoint commit would be easy to lose. */
  'GIT_DETACHED_HEAD',
  /** There is nothing uncommitted, so a checkpoint would be empty. */
  'GIT_NOTHING_TO_COMMIT',
  /** Git ran and failed. Its own message never crosses a boundary. */
  'GIT_COMMAND_FAILED',
] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

/**
 * Fixed, reviewed messages — one per code.
 *
 * Kept as data rather than built at each throw site so that "no message ever
 * contains a path" is verifiable by reading one object, and by a test that
 * asserts every message is present and free of a path separator.
 */
export const WORKSPACE_ERROR_MESSAGES: Readonly<Record<WorkspaceErrorCode, string>> = {
  WORKSPACE_NO_PROJECT: 'no project has been approved for this session',
  WORKSPACE_SELECTION_CANCELLED: 'the project selection was cancelled',
  WORKSPACE_INVALID_PROJECT: 'the selected location is not a usable project directory',
  WORKSPACE_INVALID_PATH: 'the requested path is not a valid path inside the project',
  WORKSPACE_PATH_OUTSIDE_PROJECT: 'the requested path resolves outside the approved project',
  WORKSPACE_PATH_EXCLUDED: 'the requested path is excluded from inspection',
  WORKSPACE_NOT_FOUND: 'no entry exists at the requested path',
  WORKSPACE_ACCESS_DENIED: 'the operating system refused access to the requested path',
  WORKSPACE_UNSUPPORTED_ENTRY: 'the requested path is not a readable file or directory',
  WORKSPACE_FILE_TOO_LARGE: 'the file is larger than the read-only viewer will open',
  WORKSPACE_BINARY_FILE: 'the file is not text and will not be shown as text',
  WORKSPACE_READ_FAILED: 'the requested path could not be read',

  WORKSPACE_CHANGE_NOT_FOUND: 'no such change set is held by this session',
  WORKSPACE_CHANGE_STALE: 'the file changed after the diff was produced',
  WORKSPACE_CHANGE_SETTLED: 'that change set has already been applied or rolled back',
  WORKSPACE_CHANGE_EMPTY: 'the proposed content is identical to what is already there',
  WORKSPACE_CHANGE_TOO_LARGE: 'the proposed change exceeds the size limits',
  WORKSPACE_WRITE_FAILED: 'the change could not be written and was rolled back',
  WORKSPACE_ROLLBACK_UNAVAILABLE: 'there is no applied change left to roll back',
  WORKSPACE_BACKUP_FAILED: 'the backup could not be taken, so nothing was written',

  COMMAND_NOT_AVAILABLE: 'the project does not declare that command',
  COMMAND_ALREADY_RUNNING: 'a command is already running',
  COMMAND_TIMED_OUT: 'the command exceeded its time limit and was stopped',
  COMMAND_CANCELLED: 'the command was cancelled',
  COMMAND_STOPPED_BY_EMERGENCY: 'the emergency stop was engaged while the command was running',
  COMMAND_LAUNCH_FAILED: 'the command could not be started',

  GIT_UNAVAILABLE: 'git is not available',
  GIT_NOT_A_REPOSITORY: 'the approved project is not a git working tree',
  GIT_DETACHED_HEAD: 'the repository has no branch checked out',
  GIT_NOTHING_TO_COMMIT: 'there is nothing uncommitted to check point',
  GIT_COMMAND_FAILED: 'the git command failed',
};

/**
 * The one error type the workspace layer throws.
 *
 * `code` is what callers branch on and what an audit record stores;
 * `message` never leaves the main process. Mirrors `ChatProviderError`
 * exactly, including carrying no `cause` — attaching the underlying error
 * would put an `errno`, a path and sometimes a full command line onto an
 * object that later code might stringify.
 */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode) {
    super(WORKSPACE_ERROR_MESSAGES[code]);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/** True for a value that is one of {@link WORKSPACE_ERROR_CODES}. */
export function isWorkspaceErrorCode(value: string): value is WorkspaceErrorCode {
  return (WORKSPACE_ERROR_CODES as readonly string[]).includes(value);
}
