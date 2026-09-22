/**
 * The automation layer's normalized failure vocabulary (Phase 2, Milestone 10).
 *
 * The same shape as `shared/workflow/errors.ts`, `shared/agent/errors.ts` and
 * `shared/workspace/errors.ts`: a failure that crosses the IPC boundary
 * carries a **code from this closed list and nothing else** — never a
 * message, never a path, never a program's own output.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const AUTOMATION_ERROR_CODES = [
  /** The requested tool id is not in the fixed registry. */
  'AUTOMATION_TOOL_NOT_FOUND',
  /** The tool requires an approved project, and none is open this session. */
  'AUTOMATION_NO_PROJECT',
  /** Another automation action is already running; runs are one at a time. */
  'AUTOMATION_ALREADY_RUNNING',
  /** The action could not be started or did not reach a verifiable state. */
  'AUTOMATION_LAUNCH_FAILED',
  /** The action ran, but Local Agent could not confirm it succeeded. */
  'AUTOMATION_VERIFICATION_FAILED',
  /** The action did not finish within its bounded time. */
  'AUTOMATION_TIMEOUT',
  /** The action was cancelled before it completed. */
  'AUTOMATION_CANCELLED',
  /** The emergency stop was engaged, so the action stopped or never started. */
  'AUTOMATION_EMERGENCY_STOPPED',
  /** The action did not complete, for a reason with no more specific code. */
  'AUTOMATION_RUN_FAILED',
] as const;

export type AutomationErrorCode = (typeof AUTOMATION_ERROR_CODES)[number];

/**
 * One reviewed sentence per code, for use inside the main process only.
 *
 * None of these strings crosses the IPC boundary. `main/ipc.ts` sends the
 * code; the renderer's own automation controller holds the sentence a person
 * actually reads.
 */
export const AUTOMATION_ERROR_MESSAGES: Readonly<Record<AutomationErrorCode, string>> = {
  AUTOMATION_TOOL_NOT_FOUND: 'no such automation tool',
  AUTOMATION_NO_PROJECT: 'no project is approved in this session',
  AUTOMATION_ALREADY_RUNNING: 'an automation action is already running',
  AUTOMATION_LAUNCH_FAILED: 'the action could not be started',
  AUTOMATION_VERIFICATION_FAILED: 'the action could not be confirmed to have succeeded',
  AUTOMATION_TIMEOUT: 'the action did not finish in time',
  AUTOMATION_CANCELLED: 'the action was cancelled',
  AUTOMATION_EMERGENCY_STOPPED: 'the emergency stop was engaged',
  AUTOMATION_RUN_FAILED: 'the action did not complete',
};

/**
 * A failure inside the automation layer.
 *
 * Carries a code and the reviewed sentence for it — never a cause, and never
 * an interpolated value. Attaching the original error would be how a
 * filesystem path or a fragment of a process's own output escapes into a
 * place this module promises it cannot reach.
 */
export class AutomationError extends Error {
  readonly code: AutomationErrorCode;

  constructor(code: AutomationErrorCode) {
    super(AUTOMATION_ERROR_MESSAGES[code]);
    this.name = 'AutomationError';
    this.code = code;
  }
}

export function isAutomationErrorCode(value: string): value is AutomationErrorCode {
  return (AUTOMATION_ERROR_CODES as readonly string[]).includes(value);
}
