import { describe, expect, it } from 'vitest';

import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MAX_DURATION_MS,
  AGENT_MAX_OUTPUT_BYTES,
  AGENT_MAX_STEPS,
  AGENT_MIN_STEPS,
  AGENT_PROFILE_SCHEMA_VERSION,
} from '../../../src/shared/constants';
import {
  AGENT_PROFILE_DECISIONS,
  agentProfileInputSchema,
  agentProfileSchema,
  agentProfileStoreSchema,
  agentRunSchema,
} from '../../../src/shared/schemas';
import type { AgentProfileInput } from '../../../src/shared/schemas';
import { createBuiltInAgentProfiles } from '../../../src/shared/agent';

/**
 * The agent profile boundary (Phase 2, Milestone 7).
 *
 * Almost everything here is about what a profile **cannot express**. The
 * milestone's central claim is that a profile narrows and never grants, and
 * that claim is only worth anything if the shape itself refuses the
 * alternatives — so these cases are mostly rejections, deliberately.
 */

function validInput(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    id: 'my-agent',
    name: 'My agent',
    description: 'Looks at things.',
    instructions: 'Look at things and report back.',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect', 'workspace.plan'],
    approvedWorkspacePaths: ['src'],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 4, maxDurationMs: 30_000, maxOutputBytes: 10_000 },
    enabled: true,
    ...overrides,
  };
}

describe('agent profile — what it cannot express', () => {
  it('has no decision that grants: the enum is confirm/deny, with no allow', () => {
    expect([...AGENT_PROFILE_DECISIONS]).toEqual(['confirm', 'deny']);
    expect(AGENT_PROFILE_DECISIONS as readonly string[]).not.toContain('allow');
  });

  it('rejects a permission rule that tries to allow', () => {
    const result = agentProfileInputSchema.safeParse(
      validInput({
        permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'allow' } as never],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a tool id that is not in the registry', () => {
    for (const forbidden of [
      'workspace.write',
      'workspace.apply',
      'workspace.rollback',
      'git.checkpoint',
      'shell.execute',
      'fs.write',
    ]) {
      const result = agentProfileInputSchema.safeParse(
        validInput({ allowedTools: [forbidden as never] }),
      );
      expect(result.success, forbidden).toBe(false);
    }
  });

  it('rejects a profile carrying anything that could be a credential', () => {
    for (const field of ['apiKey', 'token', 'password', 'secret', 'authorization']) {
      const result = agentProfileInputSchema.safeParse({
        ...validInput(),
        [field]: 'fake-sentinel-not-a-real-key',
      });
      expect(result.success, field).toBe(false);
    }
  });

  it('rejects builtIn, createdAt and updatedAt on a submitted profile', () => {
    for (const field of [
      { builtIn: true },
      { createdAt: '2026-09-14T00:00:00.000Z' },
      { updatedAt: '2026-09-14T00:00:00.000Z' },
    ]) {
      const result = agentProfileInputSchema.safeParse({ ...validInput(), ...field });
      expect(result.success, JSON.stringify(field)).toBe(false);
    }
  });

  it('rejects a workspace path that leaves the project', () => {
    for (const path of ['..', '../secrets', '/etc/passwd', 'C:\\Windows', 'src/../..']) {
      const result = agentProfileInputSchema.safeParse(
        validInput({ approvedWorkspacePaths: [path] }),
      );
      expect(result.success, path).toBe(false);
    }
  });

  it('rejects an identifier that could carry a path separator or a control character', () => {
    for (const id of ['../escape', 'a/b', 'UPPER', 'has space', 'x', 'aa\u0000bb']) {
      const result = agentProfileInputSchema.safeParse(validInput({ id }));
      expect(result.success, JSON.stringify(id)).toBe(false);
    }
  });

  it('rejects a name carrying a bidirectional override', () => {
    const result = agentProfileInputSchema.safeParse(validInput({ name: 'safe\u202Ereversed' }));
    expect(result.success).toBe(false);
  });
});

describe('agent profile — bounds', () => {
  it('refuses a step, duration or output ceiling outside the declared range', () => {
    const overLimit: Partial<AgentProfileInput>[] = [
      { limits: { maxSteps: AGENT_MAX_STEPS + 1, maxDurationMs: 30_000, maxOutputBytes: 10_000 } },
      { limits: { maxSteps: AGENT_MIN_STEPS - 1, maxDurationMs: 30_000, maxOutputBytes: 10_000 } },
      {
        limits: {
          maxSteps: 4,
          maxDurationMs: AGENT_MAX_DURATION_MS + 1,
          maxOutputBytes: 10_000,
        },
      },
      {
        limits: {
          maxSteps: 4,
          maxDurationMs: 30_000,
          maxOutputBytes: AGENT_MAX_OUTPUT_BYTES + 1,
        },
      },
    ];
    for (const override of overLimit) {
      expect(agentProfileInputSchema.safeParse(validInput(override)).success).toBe(false);
    }
  });

  it('refuses instructions longer than the cap', () => {
    const result = agentProfileInputSchema.safeParse(
      validInput({ instructions: 'a'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH + 1) }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts multi-line instructions but refuses other control characters', () => {
    expect(
      agentProfileInputSchema.safeParse(validInput({ instructions: 'line one\nline two\ttabbed' }))
        .success,
    ).toBe(true);
    expect(
      agentProfileInputSchema.safeParse(validInput({ instructions: 'bell\u0007here' })).success,
    ).toBe(false);
  });
});

describe('agent profile — internal coherence', () => {
  it('refuses a duplicate tool, path, requirement or fallback', () => {
    expect(
      agentProfileInputSchema.safeParse(
        validInput({ allowedTools: ['workspace.inspect', 'workspace.inspect'] }),
      ).success,
    ).toBe(false);
    expect(
      agentProfileInputSchema.safeParse(validInput({ approvedWorkspacePaths: ['src', 'src'] }))
        .success,
    ).toBe(false);
    expect(
      agentProfileInputSchema.safeParse(
        validInput({
          provider: 'glm',
          fallbackProviders: ['ollama', 'ollama'],
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses a fallback that is the primary, or that is "none"', () => {
    expect(
      agentProfileInputSchema.safeParse(validInput({ provider: 'glm', fallbackProviders: ['glm'] }))
        .success,
    ).toBe(false);
    expect(
      agentProfileInputSchema.safeParse(
        validInput({ provider: 'glm', fallbackProviders: ['none'] }),
      ).success,
    ).toBe(false);
  });

  it('refuses a permission rule for a tool the profile does not allow', () => {
    const result = agentProfileInputSchema.safeParse(
      validInput({
        allowedTools: ['workspace.inspect'],
        permissionPolicy: [{ toolId: 'command.test', decision: 'confirm' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a verification requirement whose tool is not allowed', () => {
    const result = agentProfileInputSchema.safeParse(
      validInput({ allowedTools: ['workspace.inspect'], verification: ['tests-pass'] }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a profile that allows a tool but names no workspace scope', () => {
    const result = agentProfileInputSchema.safeParse(
      validInput({ allowedTools: ['workspace.inspect'], approvedWorkspacePaths: [] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts the empty path, which means the whole approved project', () => {
    expect(
      agentProfileInputSchema.safeParse(validInput({ approvedWorkspacePaths: [''] })).success,
    ).toBe(true);
  });
});

describe('agent profile store', () => {
  function storeWith(profiles: unknown[]): unknown {
    return {
      schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
      activeProfileId: 'reviewer',
      profiles,
    };
  }

  function storedProfile(overrides: Record<string, unknown> = {}): unknown {
    return {
      ...validInput(),
      builtIn: false,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      ...overrides,
    };
  }

  it('accepts a well-formed store', () => {
    expect(agentProfileStoreSchema.safeParse(storeWith([storedProfile()])).success).toBe(true);
  });

  it('refuses a stored profile that claims to be built in', () => {
    const result = agentProfileStoreSchema.safeParse(storeWith([storedProfile({ builtIn: true })]));
    expect(result.success).toBe(false);
  });

  it('refuses two profiles sharing an identifier', () => {
    const result = agentProfileStoreSchema.safeParse(
      storeWith([storedProfile(), storedProfile({ name: 'Another' })]),
    );
    expect(result.success).toBe(false);
  });

  it('refuses an unknown top-level field', () => {
    const result = agentProfileStoreSchema.safeParse({
      ...(storeWith([]) as Record<string, unknown>),
      apiKey: 'fake-sentinel-not-a-real-key',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null timestamps only on a profile, which is how a built-in is expressed', () => {
    expect(
      agentProfileSchema.safeParse(storedProfile({ createdAt: null, updatedAt: null })).success,
    ).toBe(true);
  });
});

describe('built-in profiles', () => {
  it('every built-in validates against the profile schema it will be merged into', () => {
    for (const profile of createBuiltInAgentProfiles()) {
      const result = agentProfileSchema.safeParse(profile);
      expect(result.success, `${profile.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('no built-in grants itself anything: every permission policy is empty', () => {
    for (const profile of createBuiltInAgentProfiles()) {
      expect(profile.permissionPolicy, profile.id).toEqual([]);
    }
  });
});

describe('agent run record', () => {
  const baseRun = {
    runId: '0f3f2f6e-6bd3-4f37-9a3a-7f0f2e6ac111',
    profileId: 'reviewer',
    profileName: 'Reviewer',
    provider: 'none',
    status: 'completed',
    stopReason: 'completed',
    startedAt: '2026-09-14T00:00:00.000Z',
    finishedAt: '2026-09-14T00:00:01.000Z',
    steps: [],
    verification: { required: [], satisfied: [], passed: true },
    totals: { steps: 0, outputBytes: 0, durationMs: 1000 },
  };

  it('accepts a well-formed record', () => {
    expect(agentRunSchema.safeParse(baseRun).success).toBe(true);
  });

  it('refuses a step whose action type is not a real action type', () => {
    const result = agentRunSchema.safeParse({
      ...baseRun,
      steps: [
        {
          index: 0,
          tool: 'workspace.inspect',
          actionType: 'agent.execute',
          outcome: 'success',
          summary: 'Listed 3 entries.',
          durationMs: 5,
          outputBytes: 12,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('refuses more recorded steps than the step ceiling allows', () => {
    const step = {
      index: 0,
      tool: 'workspace.inspect',
      actionType: 'workspace.read',
      outcome: 'success',
      summary: 'Listed 3 entries.',
      durationMs: 5,
      outputBytes: 12,
    };
    const result = agentRunSchema.safeParse({
      ...baseRun,
      steps: Array.from({ length: AGENT_MAX_STEPS + 1 }, () => step),
    });
    expect(result.success).toBe(false);
  });
});
