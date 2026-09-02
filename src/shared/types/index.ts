/**
 * Shared type definitions for Local Agent.
 *
 * These types describe the contract between the privileged main process and
 * the sandboxed renderer. No implementation lives here; the modules that
 * satisfy these contracts arrive in later milestones.
 */

import type {
  ActionType,
  AuditOutcome,
  ConfirmationResult,
  PermissionDecision,
} from '../constants';

export type {
  ActionType,
  AuditActor,
  AuditOutcome,
  ConfirmationResult,
  ModelProvider,
  PermissionDecision,
  UiLanguage,
} from '../constants';

export type {
  AssistantSettings,
  AuditRecord,
  EmergencyState,
  EmergencyStateResolution,
  EmergencyStateSource,
  LanguageSettings,
  ModelProviderSettings,
  PermissionPolicy,
  PermissionRule,
  Settings,
  UserSettings,
} from '../schemas';

/**
 * A request to perform a privileged operation.
 *
 * A proposal is inert. It carries no authority of its own: whatever produced
 * it, whether the interface or a model in a later phase, it must still pass
 * through the permission engine before the executor will act on it.
 */
export interface ActionProposal {
  readonly actionType: ActionType;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Correlates every audit record produced while handling this proposal. */
  readonly correlationId: string;
}

/**
 * The permission engine's verdict on a proposal.
 *
 * The executor requires one of these as an argument. It has no code path that
 * performs an action without a decision, which is what keeps "models propose,
 * only the executor performs" an architectural property rather than a
 * convention.
 */
export interface PermissionVerdict {
  readonly decision: PermissionDecision;
  /** A policy rule id, or one of the documented reason constants. */
  readonly reason: string;
  /** Set when the emergency stop, rather than a policy rule, was decisive. */
  readonly emergencyStopEngaged: boolean;
}

/** The outcome of handling a proposal, returned to the caller. */
export interface ActionResult<TValue = unknown> {
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly value?: TValue;
  readonly errorCode?: string;
  readonly confirmationResult?: ConfirmationResult;
}
