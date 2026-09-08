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
