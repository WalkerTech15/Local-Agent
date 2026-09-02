/**
 * The executor boundary for Local Agent.
 *
 * `execute` is the **only** function in this codebase permitted to run the
 * side effect behind a privileged action, and it can only do so given a
 * {@link PermissionVerdict} as an explicit argument. There is no code path
 * here that runs `perform` without one:
 *
 *  - `verdict.decision === 'deny'` returns a `denied` result. `perform` is
 *    never called.
 *  - `verdict.decision === 'confirm'` requires `confirmationResult` to
 *    already be resolved — this function does not show a dialog or wait for
 *    one; whatever obtained the user's answer (a future native,
 *    main-process-owned prompt) must do so *before* calling this function.
 *    A `'rejected'` result returns `aborted`. `perform` is never called.
 *    Only `'approved'` allows `perform` to run.
 *  - `verdict.decision === 'allow'` calls `perform` directly.
 *
 * `perform` is supplied by the caller — this module knows nothing about what
 * any particular action actually does, which is what keeps it reusable for
 * every action type without needing to make its own policy judgements. In
 * Milestone 5, no real privileged action exists yet (filesystem tools, shell
 * execution, secret storage and provider calls all arrive later), so every
 * caller in this milestone's tests supplies an inert `perform` — a test
 * double, never a real side effect.
 *
 * A model's rationale, confidence or any other proposal content plays no
 * part here: `execute` never reads `proposal.parameters`, only
 * `proposal.correlationId`, to shape the result it returns. Authorization
 * came entirely from `verdict`, decided before this function was ever
 * called.
 */

import type {
  ActionProposal,
  ActionResult,
  ConfirmationResult,
  PermissionVerdict,
} from '../shared/types';

/**
 * Thrown when a caller violates this module's own contract — not a
 * permission decision, a programming error in the code that sequenced the
 * confirmation step. A `confirm` verdict reaching `execute` without an
 * already-resolved `confirmationResult` means something upstream skipped the
 * controlled confirmation path.
 */
export class ExecutorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorInvariantError';
  }
}

/**
 * Thrown by a real executor's `perform` callback to report a specific,
 * stable failure code. `execute` never inspects `Error.message` for this —
 * only `code` — so a caller that throws an ordinary `Error` instead still
 * fails safely, just with the generic `EXECUTION_FAILED` code rather than a
 * specific one.
 */
export class ActionExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ActionExecutionError';
    this.code = code;
  }
}

const GENERIC_EXECUTION_FAILURE_CODE = 'EXECUTION_FAILED';

export interface ExecuteOptions<TValue> {
  readonly proposal: ActionProposal;
  readonly verdict: PermissionVerdict;
  /** Required, and must already be resolved, when `verdict.decision === 'confirm'`. */
  readonly confirmationResult?: ConfirmationResult;
  /** The actual side effect. Never called unless `verdict` authorizes it. */
  readonly perform: () => TValue | Promise<TValue>;
}

export async function execute<TValue>(
  options: ExecuteOptions<TValue>,
): Promise<ActionResult<TValue>> {
  const { proposal, verdict, confirmationResult, perform } = options;

  if (verdict.decision === 'deny') {
    return { outcome: 'denied', correlationId: proposal.correlationId };
  }

  let resolvedConfirmationResult: ConfirmationResult | undefined;

  if (verdict.decision === 'confirm') {
    if (confirmationResult === undefined) {
      throw new ExecutorInvariantError(
        'a confirm decision requires an already-resolved confirmationResult before execute can run',
      );
    }
    if (confirmationResult === 'rejected') {
      return {
        outcome: 'aborted',
        correlationId: proposal.correlationId,
        confirmationResult: 'rejected',
      };
    }
    resolvedConfirmationResult = 'approved';
  }

  // `exactOptionalPropertyTypes` treats an explicit `confirmationResult:
  // undefined` as a type error on `ActionResult` (which is correct — the
  // schema this eventually feeds distinguishes "field absent" from "field
  // present with an invalid value"), so the key is only ever included when
  // there is a real value for it.
  const confirmationFields =
    resolvedConfirmationResult === undefined
      ? {}
      : { confirmationResult: resolvedConfirmationResult };

  try {
    const value = await perform();
    return {
      outcome: 'success',
      correlationId: proposal.correlationId,
      value,
      ...confirmationFields,
    };
  } catch (error) {
    const errorCode =
      error instanceof ActionExecutionError ? error.code : GENERIC_EXECUTION_FAILURE_CODE;
    return {
      outcome: 'failure',
      correlationId: proposal.correlationId,
      errorCode,
      ...confirmationFields,
    };
  }
}
