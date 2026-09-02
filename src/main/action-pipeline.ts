/**
 * The canonical request path, assembled.
 *
 * `docs/architecture.md` describes the path every privileged action must
 * follow: `ipc → permissions → [confirm] → executor → audit`. This module is
 * that path as one callable function, `handleActionProposal`. It exists so
 * that no future IPC handler can wire the pieces together *itself* and risk
 * getting the order wrong, skipping the audit call, or calling a side effect
 * before a decision — there is exactly one supported way to go from a
 * validated `ActionProposal` to an `ActionResult`, and this is it. Milestone
 * 5 registers no new IPC channel of its own — nothing yet has a real,
 * safe side effect to offer one — but this is the function such a channel
 * must call once one does.
 *
 * Order, matching `main/permissions.ts`'s own ordering exactly:
 *
 *  1. `decidePermission` — pure, synchronous, no I/O.
 *  2. If the verdict requires confirmation, `requestConfirmation` is called
 *     to obtain the user's answer. It is **never** called for any other
 *     decision — asking for confirmation on an already-denied or
 *     already-allowed action would be meaningless and would let something
 *     other than the verdict decide whether a prompt appears.
 *  3. `execute` — the only function that may run `perform`, and only when
 *     `verdict` and (if applicable) the confirmation answer authorize it.
 *  4. Exactly one audit record is appended for the whole call — a denial, a
 *     rejected confirmation, a success and a failure are all recorded
 *     through the same call to `appendAuditRecord`, which redacts and
 *     validates it before anything reaches disk. If that write itself
 *     throws, this function lets the error propagate rather than silently
 *     returning a result that was never actually recorded — there is no
 *     compensating rollback for the underlying action, but there is nothing
 *     to roll back yet either, since Phase 1 performs no real side effect.
 */

import { randomUUID } from 'node:crypto';

import { appendAuditRecord } from './audit';
import { ExecutorInvariantError, execute } from './executor';
import { decidePermission } from './permissions';
import { AUDIT_SCHEMA_VERSION } from '../shared/constants';
import type { EmergencyState, PermissionPolicy } from '../shared/schemas';
import type { ActionProposal, ActionResult, AuditActor, ConfirmationResult } from '../shared/types';

export interface HandleActionProposalOptions<TValue> {
  readonly proposal: ActionProposal;
  readonly policy: PermissionPolicy | null;
  readonly emergencyState: EmergencyState;
  /** Who originated the proposal, recorded on the audit record. */
  readonly actor: AuditActor;
  /** Directory passed straight through to `appendAuditRecord`. */
  readonly auditLogDir: string;
  /** UTC ISO-8601, supplied by the caller so this stays testable and deterministic. */
  readonly now: string;
  /**
   * Called if, and only if, the verdict requires confirmation. Absent this,
   * a `confirm` verdict causes {@link ExecutorInvariantError} rather than
   * silently treating the action as approved or denied.
   */
  readonly requestConfirmation?: () => ConfirmationResult | Promise<ConfirmationResult>;
  /** The actual side effect. Reaches `execute`, and only runs if authorized. */
  readonly perform: () => TValue | Promise<TValue>;
}

export async function handleActionProposal<TValue>(
  options: HandleActionProposalOptions<TValue>,
): Promise<ActionResult<TValue>> {
  const {
    proposal,
    policy,
    emergencyState,
    actor,
    auditLogDir,
    now,
    requestConfirmation,
    perform,
  } = options;

  const verdict = decidePermission({ proposal, policy, emergencyState });

  let confirmationResult: ConfirmationResult | undefined;
  if (verdict.decision === 'confirm') {
    if (!requestConfirmation) {
      throw new ExecutorInvariantError(
        'a confirm decision requires a requestConfirmation callback',
      );
    }
    confirmationResult = await requestConfirmation();
  }

  const startedAt = Date.now();
  const result = await execute({
    proposal,
    verdict,
    perform,
    ...(confirmationResult === undefined ? {} : { confirmationResult }),
  });
  const durationMs = Math.max(0, Date.now() - startedAt);

  await appendAuditRecord(auditLogDir, {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId: randomUUID(),
    correlationId: proposal.correlationId,
    timestamp: now,
    actor,
    actionType: proposal.actionType,
    parameters: proposal.parameters,
    decision: verdict.decision,
    decisionReason: verdict.reason,
    confirmationResult: result.confirmationResult,
    outcome: result.outcome,
    errorCode: result.errorCode,
    durationMs,
  });

  return result;
}
