/**
 * Pure permission decision engine for Local Agent.
 *
 * `decidePermission` is the only export. It performs no I/O, shows no
 * dialog, writes no log, makes no network call, imports nothing from
 * `electron`, and reads no clock — every one of those is a security
 * requirement, not a style preference: a decision function that could touch
 * any of them could be made to decide differently depending on something
 * other than its inputs, which would make "models propose, only the
 * executor performs, after a decision" unauditable and untestable as a pure
 * function of (proposal, policy, emergency state).
 *
 * The canonical request path (`docs/architecture.md`) puts the emergency
 * stop before policy rules, and this function's internal ordering matches
 * that exactly:
 *
 *  1. Reject a proposal whose `actionType` is not a real, known action —
 *     never trust the type system alone for a value that may have crossed
 *     an untrusted boundary before reaching here.
 *  2. Match the policy's rules for that action type — highest `priority`
 *     wins; a tie keeps the first matching rule in file order, exactly as
 *     `permissionPolicySchema` documents. No matching rule, or no policy at
 *     all, is `deny`.
 *  3. Apply the **confirmation floor**: an effective `allow` for a
 *     {@link CONFIRMATION_REQUIRED_ACTION_TYPES} action is downgraded to
 *     `confirm`. `deny` is left alone — the floor only forbids `allow`.
 *  4. Apply the **emergency availability floor**: an effective `deny` for an
 *     {@link EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES} action is replaced
 *     with the same safe value {@link createDefaultPermissionPolicy} already
 *     assigns it (`confirm` for `emergency.reset`, `allow` for the other
 *     two) — never left at `deny`, regardless of whether that `deny` came
 *     from an explicit rule, default-deny, or the policy being unavailable
 *     altogether. Both floors are enforced here, independently of whether
 *     `policy` ever passed `permissionPolicySchema` — a policy object that
 *     reached this function having bypassed validation some other way still
 *     cannot suppress these actions or grant a forbidden `allow`.
 *  5. Apply the **emergency stop gate** last, so it can override everything
 *     above it, including a floor-forced `allow`: while
 *     `emergencyState.engaged` is true, any action *not* in
 *     {@link EMERGENCY_STOP_EXEMPT_ACTION_TYPES} is denied outright. Note
 *     `emergency.engage` is an availability-floor action but is
 *     deliberately *not* stop-exempt: engaging an already-engaged stop has
 *     nothing left to do, and the floor's real guarantee — inspect via
 *     `audit.read`, recover via `emergency.reset` — is unaffected, since
 *     both of those *are* exempt.
 */

import {
  ACTION_TYPES,
  CONFIRMATION_REQUIRED_ACTION_TYPES,
  DEFAULT_PERMISSION_DECISION,
  EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES,
  EMERGENCY_STOP_EXEMPT_ACTION_TYPES,
  REASON_CONFIRMATION_FLOOR,
  REASON_DEFAULT_DENY,
  REASON_EMERGENCY_AVAILABILITY_FLOOR,
  REASON_EMERGENCY_STOP,
  REASON_POLICY_UNAVAILABLE,
  REASON_UNKNOWN_ACTION_TYPE,
} from '../shared/constants';
import type { EmergencyState, PermissionPolicy, PermissionRule } from '../shared/schemas';
import type { ActionProposal, PermissionDecision, PermissionVerdict } from '../shared/types';

/**
 * Everything the engine needs to decide one proposal.
 *
 * `policy` is nullable so a caller whose policy failed to load can still
 * call this function and receive a safe, fully-reasoned verdict rather than
 * having to special-case "no policy" itself. In production,
 * `main/policy.ts`'s `loadPermissionPolicy` never actually returns `null` —
 * it already falls back to {@link createDefaultPermissionPolicy} on any
 * failure, exactly as `main/settings.ts` does for settings — so this is a
 * second, independent layer of the same fail-safe guarantee, not the only
 * one.
 */
export interface DecidePermissionInput {
  readonly proposal: ActionProposal;
  readonly policy: PermissionPolicy | null;
  readonly emergencyState: EmergencyState;
}

function isKnownActionType(actionType: string): actionType is ActionProposal['actionType'] {
  return (ACTION_TYPES as readonly string[]).includes(actionType);
}

/**
 * The single matching rule for `actionType`, or `null` if none matches.
 *
 * Highest `priority` wins; among equal priorities the first rule in
 * `policy.rules` order wins, because `best` is only replaced on a strictly
 * greater priority — matching `permissionRuleSchema`'s documented tie-break.
 */
function matchRule(policy: PermissionPolicy, actionType: string): PermissionRule | null {
  let best: PermissionRule | null = null;
  for (const rule of policy.rules) {
    if (rule.actionType !== actionType) continue;
    if (best === null || rule.priority > best.priority) {
      best = rule;
    }
  }
  return best;
}

function verdict(
  decision: PermissionDecision,
  reason: string,
  emergencyStopEngaged: boolean,
): PermissionVerdict {
  return { decision, reason, emergencyStopEngaged, confirmationRequired: decision === 'confirm' };
}

/**
 * Decides one action proposal. Pure: same inputs, same output, every time.
 */
export function decidePermission(input: DecidePermissionInput): PermissionVerdict {
  const { proposal, policy, emergencyState } = input;

  if (!isKnownActionType(proposal.actionType)) {
    return verdict('deny', REASON_UNKNOWN_ACTION_TYPE, false);
  }
  const actionType = proposal.actionType;

  // Step 2: policy matching (or its absence).
  let decision: PermissionDecision;
  let reason: string;
  if (policy === null) {
    decision = DEFAULT_PERMISSION_DECISION;
    reason = REASON_POLICY_UNAVAILABLE;
  } else {
    const rule = matchRule(policy, actionType);
    if (rule === null) {
      decision = DEFAULT_PERMISSION_DECISION;
      reason = REASON_DEFAULT_DENY;
    } else {
      decision = rule.decision;
      reason = rule.id;
    }
  }

  // Step 3: confirmation floor. Only `allow` is forbidden; `deny` is left as
  // the policy (or its absence) decided.
  if (decision === 'allow' && CONFIRMATION_REQUIRED_ACTION_TYPES.includes(actionType)) {
    decision = 'confirm';
    reason = REASON_CONFIRMATION_FLOOR;
  }

  // Step 4: emergency availability floor. Only `deny` is forbidden for these
  // three actions, regardless of why it was `deny`.
  if (decision === 'deny' && EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES.includes(actionType)) {
    decision = CONFIRMATION_REQUIRED_ACTION_TYPES.includes(actionType) ? 'confirm' : 'allow';
    reason = REASON_EMERGENCY_AVAILABILITY_FLOOR;
  }

  // Step 5: the emergency stop gate, evaluated last so it can override even
  // a floor-forced allow for a non-exempt action (`emergency.engage`).
  if (emergencyState.engaged && !EMERGENCY_STOP_EXEMPT_ACTION_TYPES.includes(actionType)) {
    return verdict('deny', REASON_EMERGENCY_STOP, true);
  }

  return verdict(decision, reason, false);
}
