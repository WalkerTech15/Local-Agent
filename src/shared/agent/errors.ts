/**
 * The normalized error vocabulary for agent profiles and runs (Phase 2,
 * Milestone 7).
 *
 * Modelled on `src/shared/workspace/errors.ts` and held to the same rule:
 * **a message never crosses a boundary.** {@link AgentError}'s `message`
 * exists for main-process debugging only, is built from the fixed strings
 * below, and never interpolates a profile id, a path, a name, or an
 * underlying error. The renderer maps the *code* to its own reviewed wording.
 *
 * Each code matches the audit log's `errorCode` pattern
 * (`^[A-Z][A-Z0-9_]{2,63}$`) so it can be recorded unchanged.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const AGENT_ERROR_CODES = [
  /** No profile with that id exists in the store. */
  'AGENT_PROFILE_NOT_FOUND',
  /** A profile with that id already exists, built-in ids included. */
  'AGENT_PROFILE_EXISTS',
  /** Built-in profiles live in reviewed source and cannot be edited or deleted. */
  'AGENT_PROFILE_READ_ONLY',
  /** The profile exists but is disabled, so it cannot be selected or run. */
  'AGENT_PROFILE_DISABLED',
  /** The store already holds the maximum number of profiles. */
  'AGENT_PROFILE_LIMIT_REACHED',
  /** The submitted profile failed validation. No partial-trust path exists. */
  'AGENT_PROFILE_INVALID',
  /** The profile store could not be written. Nothing was changed. */
  'AGENT_PROFILE_STORE_FAILED',
  /** A run asked for a tool the selected profile does not allow. */
  'AGENT_TOOL_NOT_ALLOWED',
  /** A run asked for a path outside the profile's approved workspace scope. */
  'AGENT_WORKSPACE_NOT_ALLOWED',
  /** Neither the primary provider nor any fallback is usable right now. */
  'AGENT_PROVIDER_UNAVAILABLE',
  /** A run is already in flight; only one runs at a time. */
  'AGENT_RUN_ALREADY_RUNNING',
  /** No project has been approved, so no tool can operate. */
  'AGENT_NO_PROJECT',
  /** The run stopped because it reached its own step, time or output ceiling. */
  'AGENT_LIMIT_REACHED',
  /** The user cancelled the run. */
  'AGENT_RUN_CANCELLED',
  /** The emergency stop was engaged while the run was in progress. */
  'AGENT_EMERGENCY_STOPPED',
  /** The run finished, but its verification requirements were not satisfied. */
  'AGENT_VERIFICATION_FAILED',
  /** Any other run failure, already stripped of its underlying detail. */
  'AGENT_RUN_FAILED',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/**
 * Fixed, reviewed messages — one per code.
 *
 * Kept as data rather than built at each throw site so that "no message ever
 * names a profile, a path or a provider" is verifiable by reading one object,
 * and by a test that asserts it.
 */
export const AGENT_ERROR_MESSAGES: Readonly<Record<AgentErrorCode, string>> = {
  AGENT_PROFILE_NOT_FOUND: 'no agent profile with that identifier exists',
  AGENT_PROFILE_EXISTS: 'an agent profile with that identifier already exists',
  AGENT_PROFILE_READ_ONLY: 'built-in agent profiles cannot be edited or deleted',
  AGENT_PROFILE_DISABLED: 'that agent profile is disabled',
  AGENT_PROFILE_LIMIT_REACHED: 'the agent profile store is full',
  AGENT_PROFILE_INVALID: 'the submitted agent profile is not valid',
  AGENT_PROFILE_STORE_FAILED: 'the agent profile store could not be written',
  AGENT_TOOL_NOT_ALLOWED: 'the selected profile does not allow that tool',
  AGENT_WORKSPACE_NOT_ALLOWED: 'the selected profile does not allow that part of the project',
  AGENT_PROVIDER_UNAVAILABLE: 'no configured provider is usable for that profile',
  AGENT_RUN_ALREADY_RUNNING: 'an agent run is already in progress',
  AGENT_NO_PROJECT: 'no project has been approved for this session',
  AGENT_LIMIT_REACHED: 'the run reached one of its own limits and stopped',
  AGENT_RUN_CANCELLED: 'the run was cancelled',
  AGENT_EMERGENCY_STOPPED: 'the emergency stop was engaged while the run was in progress',
  AGENT_VERIFICATION_FAILED: 'the run did not satisfy its verification requirements',
  AGENT_RUN_FAILED: 'the run failed',
};

/**
 * The one error type the agent layer throws.
 *
 * Mirrors {@link WorkspaceError} exactly, including carrying no `cause`:
 * attaching the underlying error would put an `errno`, a path or a command
 * line onto an object that later code might stringify.
 */
export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode) {
    super(AGENT_ERROR_MESSAGES[code]);
    this.name = 'AgentError';
    this.code = code;
  }
}

/** True for a value that is one of {@link AGENT_ERROR_CODES}. */
export function isAgentErrorCode(value: string): value is AgentErrorCode {
  return (AGENT_ERROR_CODES as readonly string[]).includes(value);
}
