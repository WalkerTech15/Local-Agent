/**
 * Wires one action proposal to the Milestone 5 pipeline for Local Agent's IPC
 * handlers.
 *
 * `main/action-pipeline.ts`'s `handleActionProposal` — unchanged since
 * Milestone 5 — needs the *current* policy and the *current* emergency state
 * as explicit arguments; it performs no I/O of its own. Milestone 6's loaders
 * fail safe on their own (a missing policy file becomes the default policy, a
 * missing emergency-state file becomes disengaged, a corrupt one of either
 * becomes safe/engaged respectively), so re-reading both from disk on every
 * single action — rather than trusting an in-memory copy cached at startup —
 * is what makes a hand-edited policy file or a just-engaged emergency stop
 * take effect on the very next action, without requiring a restart.
 *
 * This module adds no new authorization logic: it is glue, not a sixth step
 * in the decision engine. `main/permissions.ts`, `main/action-pipeline.ts`
 * and `main/executor.ts` are untouched by Milestone 7.
 */

import { handleActionProposal } from './action-pipeline';
import { loadEmergencyState } from './emergency';
import type { UserDataPaths } from './paths';
import { loadPermissionPolicy } from './policy';
import type { ActionProposal, ActionResult, ConfirmationResult } from '../shared/types';

export interface ActionRuntime {
  readonly userDataPaths: UserDataPaths;
  /**
   * Shows a native confirmation dialog and resolves to the user's answer.
   * Bound to a specific, already-built message per call site — see
   * `main/confirm.ts`.
   */
  readonly requestConfirmation: (message: string) => Promise<ConfirmationResult>;
  /** UTC ISO-8601. Injected so this stays testable with a fixed clock. */
  readonly now: () => string;
}

/**
 * Decides and, if authorized, executes one proposal, exactly as
 * `handleActionProposal` does — this only assembles its arguments.
 *
 * @param confirmationMessage The message to show if, and only if, the
 *   verdict turns out to require confirmation. `null` for an action that
 *   never requires one (`settings.read`, `settings.write`, `secrets.status`
 *   in Phase 1's default policy) — passing `null` means no
 *   `requestConfirmation` callback is supplied at all, matching
 *   `handleActionProposal`'s own contract: a `confirm` verdict reaching it
 *   with no callback throws `ExecutorInvariantError` rather than silently
 *   treating the action as approved, so an action wrongly assumed to never
 *   need confirmation fails loudly instead of skipping the prompt.
 */
export async function runAction<TValue>(
  runtime: ActionRuntime,
  proposal: ActionProposal,
  confirmationMessage: string | null,
  perform: () => TValue | Promise<TValue>,
): Promise<ActionResult<TValue>> {
  const now = runtime.now();
  const [policy, emergencyState] = await Promise.all([
    loadPermissionPolicy(runtime.userDataPaths.permissionPolicyFile),
    loadEmergencyState(runtime.userDataPaths.emergencyStateFile, now),
  ]);

  return handleActionProposal<TValue>({
    proposal,
    policy,
    emergencyState,
    actor: 'user',
    auditLogDir: runtime.userDataPaths.auditLogDir,
    now,
    ...(confirmationMessage === null
      ? {}
      : { requestConfirmation: () => runtime.requestConfirmation(confirmationMessage) }),
    perform,
  });
}
