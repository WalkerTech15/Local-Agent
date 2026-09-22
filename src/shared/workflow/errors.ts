/**
 * The workflow layer's normalized failure vocabulary (Phase 2, Milestone 9).
 *
 * The same shape as `shared/workspace/errors.ts`, `shared/agent/errors.ts`
 * and `shared/memory/errors.ts`, and for the same reason: a failure that
 * crosses the IPC boundary carries a **code from this closed list and nothing
 * else** — never a message, never a path, never a workflow's own text.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const WORKFLOW_ERROR_CODES = [
  /** No workflow with that id exists. */
  'WORKFLOW_NOT_FOUND',
  /** That identifier is already taken. */
  'WORKFLOW_EXISTS',
  /** The submitted definition failed validation, so nothing was written. */
  'WORKFLOW_INVALID',
  /** The store already holds `WORKFLOW_MAX_WORKFLOWS` definitions. */
  'WORKFLOW_LIMIT_REACHED',
  /** The store could not be written. The file on disk is unchanged. */
  'WORKFLOW_STORE_FAILED',
  /** The workflow is disabled, so it cannot be run. */
  'WORKFLOW_DISABLED',
  /**
   * A run of this workflow is in flight, so it may not be edited or deleted.
   *
   * The milestone's "do not delete the active workflow during execution"
   * rule. Enforced against the in-flight run map in the main process, which
   * is the only thing that knows what is actually executing.
   */
  'WORKFLOW_RUNNING',
  /** Another run is already in progress; runs are one at a time. */
  'WORKFLOW_RUN_ALREADY_RUNNING',
  /** The agent profile this workflow selects no longer exists. */
  'WORKFLOW_AGENT_NOT_FOUND',
  /** The selected agent profile exists but is disabled. */
  'WORKFLOW_AGENT_DISABLED',
  /**
   * A step names a tool the selected agent profile does not allow.
   *
   * The chain `workflow ⊆ agent profile ⊆ permission policy` failing at its
   * first link — normally caught when the workflow is saved, and re-checked
   * at execution time because a profile can be narrowed afterwards.
   */
  'WORKFLOW_TOOL_NOT_ALLOWED',
  /** A step names a part of the project the selected profile does not cover. */
  'WORKFLOW_WORKSPACE_NOT_ALLOWED',
  /** No project is approved in this session. */
  'WORKFLOW_NO_PROJECT',
  /** The run reached one of its own ceilings and stopped. */
  'WORKFLOW_LIMIT_EXCEEDED',
  /** The run was cancelled, or paused at a step boundary. */
  'WORKFLOW_RUN_CANCELLED',
  /** The emergency stop was engaged, so the run stopped. */
  'WORKFLOW_EMERGENCY_STOPPED',
  /** The run finished, but its success criteria were not met. */
  'WORKFLOW_VERIFICATION_FAILED',
  /** The run did not complete, for a reason with no more specific code. */
  'WORKFLOW_RUN_FAILED',
] as const;

export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

/**
 * One reviewed sentence per code, for use inside the main process only.
 *
 * None of these strings crosses the IPC boundary. `main/ipc.ts` sends the
 * code; the renderer's own `workflow-controller.ts` holds the sentence a
 * person actually reads. Two independent sets of words, so main-process
 * phrasing can never reach the screen by accident.
 */
export const WORKFLOW_ERROR_MESSAGES: Readonly<Record<WorkflowErrorCode, string>> = {
  WORKFLOW_NOT_FOUND: 'no such workflow',
  WORKFLOW_EXISTS: 'a workflow already has that identifier',
  WORKFLOW_INVALID: 'the workflow definition failed validation',
  WORKFLOW_LIMIT_REACHED: 'the store already holds the maximum number of workflows',
  WORKFLOW_STORE_FAILED: 'the workflow store could not be written',
  WORKFLOW_DISABLED: 'the workflow is disabled',
  WORKFLOW_RUNNING: 'a run of this workflow is in progress',
  WORKFLOW_RUN_ALREADY_RUNNING: 'a workflow run is already in progress',
  WORKFLOW_AGENT_NOT_FOUND: 'the selected agent profile no longer exists',
  WORKFLOW_AGENT_DISABLED: 'the selected agent profile is disabled',
  WORKFLOW_TOOL_NOT_ALLOWED: 'the selected agent profile does not allow that tool',
  WORKFLOW_WORKSPACE_NOT_ALLOWED: 'the selected agent profile does not cover that path',
  WORKFLOW_NO_PROJECT: 'no project is approved in this session',
  WORKFLOW_LIMIT_EXCEEDED: 'the run reached one of its own limits',
  WORKFLOW_RUN_CANCELLED: 'the run was stopped',
  WORKFLOW_EMERGENCY_STOPPED: 'the emergency stop was engaged',
  WORKFLOW_VERIFICATION_FAILED: 'the success criteria were not met',
  WORKFLOW_RUN_FAILED: 'the run did not complete',
};

/**
 * A failure inside the workflow layer.
 *
 * Carries a code and the reviewed sentence for it — never a cause, and never
 * an interpolated value. Attaching the original error would be how a
 * filesystem path or a fragment of a project's own output escapes into a
 * place this module promises it cannot reach.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode) {
    super(WORKFLOW_ERROR_MESSAGES[code]);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export function isWorkflowErrorCode(value: string): value is WorkflowErrorCode {
  return (WORKFLOW_ERROR_CODES as readonly string[]).includes(value);
}
