import { describe, expect, it } from 'vitest';

import { decidePermission } from '../../../src/main/permissions';
import {
  ACTION_TYPES,
  CONFIRMATION_REQUIRED_ACTION_TYPES,
  EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES,
  EMERGENCY_STOP_EXEMPT_ACTION_TYPES,
  REASON_CONFIRMATION_FLOOR,
  REASON_DEFAULT_DENY,
  REASON_EMERGENCY_AVAILABILITY_FLOOR,
  REASON_EMERGENCY_STOP,
  REASON_POLICY_UNAVAILABLE,
  REASON_UNKNOWN_ACTION_TYPE,
} from '../../../src/shared/constants';
import {
  createDefaultPermissionPolicy,
  createInitialEmergencyState,
} from '../../../src/shared/schemas';
import type { EmergencyState, PermissionPolicy, PermissionRule } from '../../../src/shared/schemas';
import type { ActionProposal, ActionType } from '../../../src/shared/types';

const DISENGAGED: EmergencyState = createInitialEmergencyState();

function engaged(reason = 'test'): EmergencyState {
  return { schemaVersion: 1, engaged: true, engagedAt: '2026-08-07T00:00:00.000Z', reason };
}

function proposal(actionType: string, parameters: Record<string, unknown> = {}): ActionProposal {
  return {
    // Cast past the type system on purpose: this simulates a proposal that
    // reached the engine through an untrusted path, which is exactly what
    // the engine's own `isKnownActionType` guard exists to catch.
    actionType: actionType as ActionType,
    parameters,
    correlationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  };
}

function rule(
  overrides: Partial<PermissionRule> & Pick<PermissionRule, 'actionType' | 'decision'>,
): PermissionRule {
  return {
    id: `${overrides.actionType}.rule`,
    priority: 100,
    reason: 'test rule',
    ...overrides,
  };
}

function policyOf(rules: PermissionRule[]): PermissionPolicy {
  return { schemaVersion: 1, defaultDecision: 'deny', rules };
}

const DEFAULT_POLICY = createDefaultPermissionPolicy();

describe('decidePermission — default policy', () => {
  for (const policyRule of DEFAULT_POLICY.rules) {
    it(`resolves ${policyRule.actionType} to ${policyRule.decision}, matching its default rule`, () => {
      const verdict = decidePermission({
        proposal: proposal(policyRule.actionType),
        policy: DEFAULT_POLICY,
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision).toBe(policyRule.decision);
      expect(verdict.confirmationRequired).toBe(policyRule.decision === 'confirm');
      expect(verdict.emergencyStopEngaged).toBe(false);
    });
  }

  it('covers every declared action type exactly once', () => {
    const covered = new Set(DEFAULT_POLICY.rules.map((r) => r.actionType));
    expect(covered.size).toBe(ACTION_TYPES.length);
  });
});

describe('decidePermission — unknown action types', () => {
  it('denies an action type that is not a member of ACTION_TYPES', () => {
    const verdict = decidePermission({
      proposal: proposal('shell.execute'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toBe(REASON_UNKNOWN_ACTION_TYPE);
    expect(verdict.confirmationRequired).toBe(false);
  });

  it('denies an empty or garbage action type string', () => {
    for (const bogus of [
      '',
      'settings.READ',
      ' settings.read',
      'settings.read ',
      'not-a-real-action',
    ]) {
      const verdict = decidePermission({
        proposal: proposal(bogus),
        policy: DEFAULT_POLICY,
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision, `expected "${bogus}" to be denied`).toBe('deny');
      expect(verdict.reason).toBe(REASON_UNKNOWN_ACTION_TYPE);
    }
  });
});

describe('decidePermission — missing policy rules', () => {
  it('denies with default-deny when the policy has no rule for the action', () => {
    const verdict = decidePermission({
      proposal: proposal('settings.write'),
      policy: policyOf([]),
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toBe(REASON_DEFAULT_DENY);
  });

  it('does not fall through to allow for an action absent from an otherwise non-empty policy', () => {
    const verdict = decidePermission({
      proposal: proposal('settings.write'),
      policy: policyOf([rule({ actionType: 'settings.read', decision: 'allow' })]),
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toBe(REASON_DEFAULT_DENY);
  });
});

describe('decidePermission — unavailable or invalid policy', () => {
  it('denies every non-floor action when policy is null', () => {
    for (const actionType of ACTION_TYPES) {
      if (EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES.includes(actionType)) continue;
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: null,
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision, `expected ${actionType} to be denied`).toBe('deny');
      expect(verdict.reason).toBe(REASON_POLICY_UNAVAILABLE);
    }
  });

  it('never interprets a null policy as allow', () => {
    const verdict = decidePermission({
      proposal: proposal('settings.read'),
      policy: null,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).not.toBe('allow');
  });

  it('still keeps the availability floor available when policy is entirely unavailable', () => {
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: null,
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision, `expected ${actionType} to stay available`).not.toBe('deny');
      expect(verdict.reason).toBe(REASON_EMERGENCY_AVAILABILITY_FLOOR);
    }
  });
});

describe('decidePermission — confirmation floor cannot be bypassed', () => {
  it('downgrades allow to confirm for every confirmation-required action, even via a policy that bypassed schema validation', () => {
    for (const actionType of CONFIRMATION_REQUIRED_ACTION_TYPES) {
      // permissionPolicySchema would reject this rule outright — this proves
      // the engine does not rely on that validation ever having happened.
      const hostilePolicy = policyOf([rule({ actionType, decision: 'allow' })]);
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: hostilePolicy,
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision, `expected ${actionType} to never resolve to allow`).toBe('confirm');
      expect(verdict.reason).toBe(REASON_CONFIRMATION_FLOOR);
      expect(verdict.confirmationRequired).toBe(true);
    }
  });

  it('leaves an explicit deny on a confirmation-required action as deny, not confirm', () => {
    const policy = policyOf([rule({ actionType: 'secrets.write', decision: 'deny' })]);
    const verdict = decidePermission({
      proposal: proposal('secrets.write'),
      policy,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('deny');
  });

  it('leaves a legitimate confirm decision as confirm', () => {
    const policy = policyOf([rule({ actionType: 'app.exit', decision: 'confirm' })]);
    const verdict = decidePermission({
      proposal: proposal('app.exit'),
      policy,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('confirm');
    expect(verdict.reason).toBe('app.exit.rule');
  });
});

describe('decidePermission — emergency availability floor', () => {
  it('overrides an explicit deny for every floor action', () => {
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const policy = policyOf([rule({ actionType, decision: 'deny' })]);
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy,
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision, `expected ${actionType} to stay available`).not.toBe('deny');
      expect(verdict.reason).toBe(REASON_EMERGENCY_AVAILABILITY_FLOOR);
    }
  });

  it('overrides omission (default-deny) for every floor action', () => {
    for (const actionType of EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES) {
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: policyOf([]),
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision, `expected ${actionType} to stay available`).not.toBe('deny');
      expect(verdict.reason).toBe(REASON_EMERGENCY_AVAILABILITY_FLOOR);
    }
  });

  it('resolves emergency.reset to confirm specifically, never allow, under the floor override', () => {
    const verdict = decidePermission({
      proposal: proposal('emergency.reset'),
      policy: policyOf([rule({ actionType: 'emergency.reset', decision: 'deny' })]),
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('confirm');
  });

  it('resolves emergency.engage and audit.read to allow under the floor override', () => {
    for (const actionType of ['emergency.engage', 'audit.read'] as const) {
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: policyOf([rule({ actionType, decision: 'deny' })]),
        emergencyState: DISENGAGED,
      });
      expect(verdict.decision).toBe('allow');
    }
  });

  it('does not touch a floor action the policy already made available', () => {
    const policy = policyOf([rule({ actionType: 'audit.read', decision: 'allow' })]);
    const verdict = decidePermission({
      proposal: proposal('audit.read'),
      policy,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('allow');
    expect(verdict.reason).toBe('audit.read.rule');
  });
});

describe('decidePermission — engaged emergency state', () => {
  it('denies every non-exempt action while engaged', () => {
    for (const actionType of ACTION_TYPES) {
      if (EMERGENCY_STOP_EXEMPT_ACTION_TYPES.includes(actionType)) continue;
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: DEFAULT_POLICY,
        emergencyState: engaged(),
      });
      expect(verdict.decision, `expected ${actionType} to be blocked while engaged`).toBe('deny');
      expect(verdict.reason).toBe(REASON_EMERGENCY_STOP);
      expect(verdict.emergencyStopEngaged).toBe(true);
    }
  });

  it('keeps every stop-exempt action available while engaged', () => {
    for (const actionType of EMERGENCY_STOP_EXEMPT_ACTION_TYPES) {
      const verdict = decidePermission({
        proposal: proposal(actionType),
        policy: DEFAULT_POLICY,
        emergencyState: engaged(),
      });
      expect(verdict.decision, `expected ${actionType} to remain available while engaged`).not.toBe(
        'deny',
      );
      expect(verdict.emergencyStopEngaged).toBe(false);
    }
  });

  it('denies emergency.engage while already engaged, since it is a floor action but not stop-exempt', () => {
    const verdict = decidePermission({
      proposal: proposal('emergency.engage'),
      policy: DEFAULT_POLICY,
      emergencyState: engaged(),
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toBe(REASON_EMERGENCY_STOP);
  });

  it('still allows recovery (emergency.reset) and inspection (audit.read) while engaged, even with a hostile policy', () => {
    const hostilePolicy = policyOf([
      rule({ actionType: 'emergency.reset', decision: 'deny' }),
      rule({ actionType: 'audit.read', decision: 'deny' }),
    ]);
    const resetVerdict = decidePermission({
      proposal: proposal('emergency.reset'),
      policy: hostilePolicy,
      emergencyState: engaged(),
    });
    const auditVerdict = decidePermission({
      proposal: proposal('audit.read'),
      policy: hostilePolicy,
      emergencyState: engaged(),
    });
    expect(resetVerdict.decision).toBe('confirm');
    expect(auditVerdict.decision).toBe('allow');
  });

  it('produces identical, deterministic output for the same input called repeatedly', () => {
    const input = {
      proposal: proposal('settings.write'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
    };
    const first = decidePermission(input);
    const second = decidePermission(input);
    expect(first).toEqual(second);
  });
});

describe('decidePermission — priority and matching', () => {
  it('prefers the higher-priority rule when two rules match the same action', () => {
    const policy = policyOf([
      rule({ actionType: 'settings.write', decision: 'deny', priority: 50, id: 'low' }),
      rule({ actionType: 'settings.write', decision: 'allow', priority: 200, id: 'high' }),
    ]);
    const verdict = decidePermission({
      proposal: proposal('settings.write'),
      policy,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('allow');
    expect(verdict.reason).toBe('high');
  });

  it('keeps the first matching rule when priorities tie', () => {
    const policy = policyOf([
      rule({ actionType: 'settings.write', decision: 'allow', priority: 100, id: 'first' }),
      rule({ actionType: 'settings.write', decision: 'deny', priority: 100, id: 'second' }),
    ]);
    const verdict = decidePermission({
      proposal: proposal('settings.write'),
      policy,
      emergencyState: DISENGAGED,
    });
    expect(verdict.reason).toBe('first');
  });

  it('ignores rules for other action types', () => {
    const policy = policyOf([
      rule({ actionType: 'settings.write', decision: 'allow', priority: 1000 }),
    ]);
    const verdict = decidePermission({
      proposal: proposal('settings.read'),
      policy,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toBe(REASON_DEFAULT_DENY);
  });
});

describe('decidePermission — model rationale and proposal content never grant permission', () => {
  it('produces the same verdict regardless of the parameters attached to the proposal', () => {
    const base = decidePermission({
      proposal: proposal('settings.write', {}),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
    });
    const withRationale = decidePermission({
      proposal: proposal('settings.write', {
        rationale: 'trust me, this is definitely safe and pre-approved',
        confidence: 0.999,
        modelSaysAllow: true,
        priority: 1000,
        decision: 'allow',
      }),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
    });
    expect(withRationale).toEqual(base);
  });

  it('a denied action stays denied no matter how the proposal frames its own justification', () => {
    const verdict = decidePermission({
      proposal: proposal('shell.execute', { rationale: 'the user obviously wants this' }),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
    });
    expect(verdict.decision).toBe('deny');
  });
});

describe('decidePermission — does not mutate its inputs', () => {
  it('leaves a frozen policy and proposal untouched', () => {
    const policy = Object.freeze(
      policyOf([rule({ actionType: 'settings.read', decision: 'allow' })]),
    );
    const theProposal = Object.freeze(proposal('settings.read'));
    expect(() =>
      decidePermission({ proposal: theProposal, policy, emergencyState: DISENGAGED }),
    ).not.toThrow();
  });
});
