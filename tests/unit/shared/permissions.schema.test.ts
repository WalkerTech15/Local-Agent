import { describe, expect, it } from 'vitest';

import {
  ACTION_TYPES,
  CONFIRMATION_REQUIRED_ACTION_TYPES,
  EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES,
} from '../../../src/shared/constants';
import type { PermissionPolicy } from '../../../src/shared/schemas/permissions.schema';
import {
  createDefaultPermissionPolicy,
  DEFAULT_PERMISSION_POLICY,
  permissionPolicySchema,
} from '../../../src/shared/schemas/permissions.schema';

const clonePolicy = (): PermissionPolicy => createDefaultPermissionPolicy();

const patch = (overrides: Record<string, unknown>): unknown => ({
  ...clonePolicy(),
  ...overrides,
});

/**
 * The smallest rule set a valid policy may contain: one rule for each action
 * on the emergency availability floor, and nothing else.
 */
const availabilityFloorRules = (): unknown[] => [
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
    reason: 'Recovery must be deliberate.',
  },
  {
    id: 'audit.read',
    actionType: 'audit.read',
    decision: 'allow',
    priority: 100,
    reason: 'The user must be able to inspect the audit trail.',
  },
];

describe('DEFAULT_PERMISSION_POLICY', () => {
  it('is itself a valid policy', () => {
    expect(permissionPolicySchema.safeParse(DEFAULT_PERMISSION_POLICY).success).toBe(true);
  });

  it('denies by default', () => {
    expect(DEFAULT_PERMISSION_POLICY.defaultDecision).toBe('deny');
  });

  it('covers every Phase 1 action type, so no action falls through by accident', () => {
    const covered = DEFAULT_PERMISSION_POLICY.rules.map((rule) => rule.actionType).sort();
    expect(covered).toEqual([...ACTION_TYPES].sort());
  });

  it('requires confirmation for every destructive or privacy-sensitive action', () => {
    const byAction = new Map(
      DEFAULT_PERMISSION_POLICY.rules.map((rule) => [rule.actionType, rule.decision]),
    );
    expect(byAction.get('secrets.write')).toBe('confirm');
    expect(byAction.get('secrets.clear')).toBe('confirm');
    expect(byAction.get('emergency.reset')).toBe('confirm');
    expect(byAction.get('app.exit')).toBe('confirm');
  });

  it('never obstructs engaging the emergency stop', () => {
    const rule = DEFAULT_PERMISSION_POLICY.rules.find(
      (candidate) => candidate.actionType === 'emergency.engage',
    );
    expect(rule?.decision).toBe('allow');
  });

  it('gives every rule a human-readable reason for the audit trail', () => {
    for (const rule of DEFAULT_PERMISSION_POLICY.rules) {
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });
});

/** A well-formed, floor-compliant rule used as the basis for negative cases. */
const sampleRule = (): Record<string, unknown> => ({
  id: 'settings.read',
  actionType: 'settings.read',
  decision: 'allow',
  priority: 100,
  reason: 'Reading non-secret settings is read-only.',
});

/**
 * A policy that satisfies the availability floor, plus the supplied rules.
 *
 * Negative tests build on this so that a rejection is attributable to the
 * property under test rather than to an incidentally missing floor rule.
 */
const policyWith = (...extraRules: unknown[]): unknown =>
  patch({ rules: [...availabilityFloorRules(), ...extraRules] });

describe('permissionPolicySchema — rejects malformed input', () => {
  it('accepts the negative-test base, so rejections below are attributable', () => {
    expect(permissionPolicySchema.safeParse(policyWith(sampleRule())).success).toBe(true);
  });

  it('rejects an unknown decision', () => {
    expect(
      permissionPolicySchema.safeParse(policyWith({ ...sampleRule(), decision: 'maybe' })).success,
    ).toBe(false);
  });

  it('rejects an unknown action type', () => {
    expect(
      permissionPolicySchema.safeParse(policyWith({ ...sampleRule(), actionType: 'shell.execute' }))
        .success,
    ).toBe(false);
  });

  it('rejects a defaultDecision other than deny', () => {
    for (const defaultDecision of ['allow', 'confirm', 'ask', '']) {
      expect(permissionPolicySchema.safeParse(patch({ defaultDecision })).success).toBe(false);
    }
  });

  it('rejects an unexpected schemaVersion', () => {
    expect(permissionPolicySchema.safeParse(patch({ schemaVersion: 99 })).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(permissionPolicySchema.safeParse(patch({ allowAll: true })).success).toBe(false);
  });

  it('rejects unknown keys inside a rule', () => {
    expect(
      permissionPolicySchema.safeParse(policyWith({ ...sampleRule(), bypass: true })).success,
    ).toBe(false);
  });

  it('rejects duplicate rule ids', () => {
    expect(permissionPolicySchema.safeParse(policyWith(sampleRule(), sampleRule())).success).toBe(
      false,
    );
  });

  it('rejects a malformed rule id', () => {
    for (const id of ['', 'Has Spaces', 'UPPER', '-leading-dash']) {
      expect(permissionPolicySchema.safeParse(policyWith({ ...sampleRule(), id })).success).toBe(
        false,
      );
    }
  });

  it('rejects a non-integer or out-of-range priority', () => {
    for (const priority of [1.5, -1, 1001, '100']) {
      expect(
        permissionPolicySchema.safeParse(policyWith({ ...sampleRule(), priority })).success,
      ).toBe(false);
    }
  });
});

describe('permissionPolicySchema — the confirmation floor', () => {
  it('refuses to let a hand-edited policy downgrade a confirmation to allow', () => {
    for (const actionType of [
      'secrets.write',
      'secrets.clear',
      'emergency.reset',
      'app.exit',
    ] as const) {
      const result = permissionPolicySchema.safeParse(
        policyWith({
          id: 'attacker.rule',
          actionType,
          decision: 'allow',
          priority: 1000,
          reason: 'attempted downgrade',
        }),
      );
      expect(result.success, `expected allow on ${actionType} to be rejected`).toBe(false);
    }
  });

  it('still permits tightening a confirmation to a hard deny', () => {
    const result = permissionPolicySchema.safeParse(
      policyWith({
        id: 'lockdown.secrets',
        actionType: 'secrets.write',
        decision: 'deny',
        priority: 1000,
        reason: 'locked down by the user',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('still permits allow on actions that carry no confirmation floor', () => {
    expect(permissionPolicySchema.safeParse(policyWith(sampleRule())).success).toBe(true);
  });

  it('rejects an empty rule list, because it would remove the emergency controls', () => {
    // Default-deny remains the conceptual posture for any *unlisted* action,
    // but a complete policy document must still declare the availability
    // floor. An empty policy would silently make the emergency stop and the
    // audit trail unreachable.
    const rules: unknown[] = [];
    expect(permissionPolicySchema.safeParse(patch({ rules })).success).toBe(false);
  });
});

describe('permissionPolicySchema — the emergency availability floor', () => {
  it('accepts a minimum compliant policy containing only the floor', () => {
    const result = permissionPolicySchema.safeParse(patch({ rules: availabilityFloorRules() }));
    expect(result.success).toBe(true);
  });

  it('rejects an explicit deny on any floor action', () => {
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const rules = availabilityFloorRules().map((rule) => {
        const typed = rule as { actionType: string };
        return typed.actionType === actionType ? { ...typed, decision: 'deny' } : rule;
      });
      const result = permissionPolicySchema.safeParse(patch({ rules }));
      expect(result.success, `expected deny on ${actionType} to be rejected`).toBe(false);
    }
  });

  it('rejects a deny added at high priority alongside a compliant rule', () => {
    // Denial must be rejected wherever it appears, not only when it is the
    // sole rule for that action.
    const rules: unknown[] = [
      ...availabilityFloorRules(),
      {
        id: 'attacker.suppress.audit',
        actionType: 'audit.read',
        decision: 'deny',
        priority: 1000,
        reason: 'attempted suppression',
      },
    ];
    expect(permissionPolicySchema.safeParse(patch({ rules })).success).toBe(false);
  });

  it('rejects omission of any floor action', () => {
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const rules = availabilityFloorRules().filter(
        (rule) => (rule as { actionType: string }).actionType !== actionType,
      );
      const result = permissionPolicySchema.safeParse(patch({ rules }));
      expect(result.success, `expected omission of ${actionType} to be rejected`).toBe(false);
    }
  });

  it('pins emergency.reset to confirm, since it is on both floors', () => {
    // The confirmation floor forbids `allow`; the availability floor forbids
    // `deny`. Only `confirm` remains: recovery stays possible, but deliberate.
    const floors: readonly string[] = CONFIRMATION_REQUIRED_ACTION_TYPES;
    const availability: readonly string[] = EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES;
    expect(floors).toContain('emergency.reset');
    expect(availability).toContain('emergency.reset');

    for (const decision of ['allow', 'deny']) {
      const rules = availabilityFloorRules().map((rule) => {
        const typed = rule as { actionType: string };
        return typed.actionType === 'emergency.reset' ? { ...typed, decision } : rule;
      });
      const result = permissionPolicySchema.safeParse(patch({ rules }));
      expect(result.success, `expected emergency.reset=${decision} to be rejected`).toBe(false);
    }

    expect(
      permissionPolicySchema.safeParse(patch({ rules: availabilityFloorRules() })).success,
    ).toBe(true);
  });

  it('permits confirm on floor actions other than reset', () => {
    const rules = availabilityFloorRules().map((rule) => {
      const typed = rule as { actionType: string };
      return typed.actionType === 'emergency.engage' ? { ...typed, decision: 'confirm' } : rule;
    });
    expect(permissionPolicySchema.safeParse(patch({ rules })).success).toBe(true);
  });

  it('keeps the shipped default policy compliant with the floor', () => {
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const rule = DEFAULT_PERMISSION_POLICY.rules.find(
        (candidate) => candidate.actionType === actionType,
      );
      expect(rule, `default policy must declare ${actionType}`).toBeDefined();
      expect(rule?.decision).not.toBe('deny');
    }
  });
});

describe('DEFAULT_PERMISSION_POLICY — immutability', () => {
  it('is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_PERMISSION_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PERMISSION_POLICY.rules)).toBe(true);
    for (const rule of DEFAULT_PERMISSION_POLICY.rules) {
      expect(Object.isFrozen(rule)).toBe(true);
    }
  });

  it('throws when a caller tries to weaken it', () => {
    const mutable = DEFAULT_PERMISSION_POLICY as unknown as {
      defaultDecision: string;
      rules: { decision: string }[];
    };
    expect(() => {
      mutable.defaultDecision = 'allow';
    }).toThrow(TypeError);
    expect(() => {
      mutable.rules.push({ decision: 'allow' });
    }).toThrow(TypeError);
    expect(() => {
      const first = mutable.rules[0];
      if (first) first.decision = 'allow';
    }).toThrow(TypeError);
    expect(DEFAULT_PERMISSION_POLICY.defaultDecision).toBe('deny');
  });

  it('hands out a fresh mutable copy from the factory', () => {
    const first = createDefaultPermissionPolicy();
    const second = createDefaultPermissionPolicy();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(false);

    first.rules = [];
    expect(createDefaultPermissionPolicy().rules.length).toBeGreaterThan(0);
    expect(DEFAULT_PERMISSION_POLICY.rules.length).toBeGreaterThan(0);
  });
});
