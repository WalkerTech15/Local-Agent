/**
 * Permission policy schema for Local Agent.
 *
 * This describes `%APPDATA%\Local-Agent\permissions/policy.json`.
 *
 * The policy is data, not code. It is human-readable and human-editable, and
 * it cannot widen the permission model beyond the limits enforced here:
 *
 *  - the default decision is `deny` and is not configurable;
 *  - an action with no matching rule is denied;
 *  - destructive, privacy-sensitive and security-sensitive actions cannot be
 *    downgraded to `allow` by editing the file.
 *
 * Models propose actions. Only the permission-controlled executor performs
 * them, and only after this policy has been consulted.
 */

import { z } from 'zod';

import {
  ACTION_TYPES,
  CONFIRMATION_REQUIRED_ACTION_TYPES,
  EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES,
  PERMISSION_DECISIONS,
  PERMISSION_POLICY_SCHEMA_VERSION,
} from '../constants';
import type { DeepReadonly } from '../freeze';
import { deepFreeze } from '../freeze';

export const permissionRuleSchema = z.strictObject({
  /** Stable identifier, recorded in the audit trail as the decision reason. */
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, {
      message: 'rule id must be lowercase alphanumeric with . _ - separators',
    }),
  actionType: z.enum(ACTION_TYPES),
  decision: z.enum(PERMISSION_DECISIONS),
  /** Higher priority wins. Ties are resolved by the first matching rule. */
  priority: z.int().min(0).max(1000),
  reason: z.string().trim().min(1).max(200),
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const permissionPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(PERMISSION_POLICY_SCHEMA_VERSION),
    /**
     * Not configurable. Declared explicitly so that the file states the
     * posture it is operating under, and so that a file attempting to set
     * anything else is rejected rather than silently corrected.
     */
    defaultDecision: z.literal('deny'),
    rules: z.array(permissionRuleSchema).max(200),
  })
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: `duplicate rule id: ${rule.id}`,
        });
      }
      seen.add(rule.id);

      // The confirmation floor. Enforced in the schema so that a hand-edited
      // policy file cannot quietly remove a confirmation prompt.
      if (
        rule.decision === 'allow' &&
        CONFIRMATION_REQUIRED_ACTION_TYPES.includes(rule.actionType)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'decision'],
          message: `${rule.actionType} always requires confirmation and cannot be set to allow`,
        });
      }

      // The availability floor, denial half. The user's own emergency
      // controls cannot be turned off by the policy that governs them.
      if (
        rule.decision === 'deny' &&
        EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES.includes(rule.actionType)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'decision'],
          message: `${rule.actionType} must remain available to the user and cannot be set to deny`,
        });
      }
    });

    // The availability floor, omission half.
    //
    // Denying these actions and simply leaving them out have exactly the same
    // effect, because an unmatched action falls through to default-deny. A
    // floor that only checked for explicit denials would be trivially evaded
    // by deleting a rule, so a valid policy must positively declare one.
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const covered = policy.rules.some((rule) => rule.actionType === actionType);
      if (!covered) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules'],
          message: `policy must declare a rule for ${actionType}; omitting it would let default-deny remove the user's emergency controls`,
        });
      }
    }
  });

export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;

/**
 * Builds the policy written on first launch.
 *
 * Every Phase 1 action type appears exactly once. Because unmatched actions
 * are denied, adding a new action type without adding a rule here fails
 * closed rather than open.
 *
 * A factory rather than a shared object: the caller that writes the policy
 * file owns its result and may adjust it freely without that edit becoming
 * visible to every other caller. Use {@link DEFAULT_PERMISSION_POLICY} when a
 * read-only reference is all that is needed.
 */
export function createDefaultPermissionPolicy(): PermissionPolicy {
  return {
    schemaVersion: PERMISSION_POLICY_SCHEMA_VERSION,
    defaultDecision: 'deny',
    rules: [
      {
        id: 'settings.read',
        actionType: 'settings.read',
        decision: 'allow',
        priority: 100,
        reason: 'Reading non-secret settings is read-only and not sensitive.',
      },
      {
        id: 'settings.write',
        actionType: 'settings.write',
        decision: 'allow',
        priority: 100,
        reason: 'Settings changes are user-initiated from the interface and are audited.',
      },
      {
        id: 'secrets.status',
        actionType: 'secrets.status',
        decision: 'allow',
        priority: 100,
        reason: 'Returns only whether a key exists, never a key value.',
      },
      {
        id: 'secrets.write',
        actionType: 'secrets.write',
        decision: 'confirm',
        priority: 100,
        reason: 'Storing a credential is privacy-sensitive and requires explicit consent.',
      },
      {
        id: 'secrets.clear',
        actionType: 'secrets.clear',
        decision: 'confirm',
        priority: 100,
        reason: 'Deleting a stored credential is destructive and irreversible.',
      },
      {
        id: 'audit.read',
        actionType: 'audit.read',
        decision: 'allow',
        priority: 100,
        reason: 'The user must always be able to inspect the audit trail.',
      },
      {
        id: 'emergency.engage',
        actionType: 'emergency.engage',
        decision: 'allow',
        priority: 100,
        reason: 'Stopping the assistant must never be obstructed.',
      },
      {
        id: 'emergency.reset',
        actionType: 'emergency.reset',
        decision: 'confirm',
        priority: 100,
        reason: 'Releasing the emergency stop re-enables activity and must be deliberate.',
      },
      {
        id: 'app.exit',
        actionType: 'app.exit',
        decision: 'confirm',
        priority: 100,
        reason: 'Exiting is user-visible and interruptive.',
      },
      {
        id: 'chat.send',
        actionType: 'chat.send',
        decision: 'allow',
        priority: 100,
        reason:
          'Sending a chat message is a direct, per-message user action, not a background or model-initiated one; the send itself is the consent.',
      },
    ],
  };
}

/**
 * The default policy as a deeply frozen, read-only reference.
 *
 * A security default that callers can mutate is a shared mutable security
 * control: one caller editing it silently changes what every later caller
 * sees. Attempting to mutate this throws, because every module here is an ES
 * module and therefore strict mode.
 *
 * Call {@link createDefaultPermissionPolicy} when a mutable copy is needed.
 */
export const DEFAULT_PERMISSION_POLICY: DeepReadonly<PermissionPolicy> = deepFreeze(
  createDefaultPermissionPolicy(),
);
