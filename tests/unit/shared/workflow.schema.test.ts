import { describe, expect, it } from 'vitest';

import { AGENT_TOOL_IDS } from '../../../src/shared/agent/tools';
import {
  WORKFLOW_MAX_DEFINITION_STEPS,
  WORKFLOW_MAX_STEP_RETRIES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_WORKFLOWS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_TRIGGERS,
} from '../../../src/shared/constants';
import {
  createEmptyWorkflowStore,
  workflowInputSchema,
  workflowProgressEventSchema,
  workflowRunSchema,
  workflowSchema,
  workflowStepSchema,
  workflowStoreSchema,
} from '../../../src/shared/schemas/workflow.schema';

const NOW = '2026-01-01T00:00:00.000Z';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function step(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'workspace.inspect' as const,
    target: '',
    query: null,
    condition: 'always' as const,
    maxRetries: 0,
    checkpoint: false,
    ...overrides,
  };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'nightly.check',
    name: 'Nightly check',
    description: 'Looks at the tree and runs the tests.',
    trigger: 'manual' as const,
    agentProfileId: 'reviewer',
    steps: [step()],
    limits: { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
    failureBehavior: 'stop' as const,
    rollback: 'none' as const,
    successCriteria: { verification: [], requireAllStepsSucceed: true },
    enabled: true,
    ...overrides,
  };
}

describe('the trigger cannot express background autonomy', () => {
  it('declares exactly one trigger', () => {
    expect(WORKFLOW_TRIGGERS).toEqual(['manual']);
  });

  it('accepts a manual trigger and refuses every other kind', () => {
    expect(workflowInputSchema.safeParse(validInput()).success).toBe(true);
    for (const trigger of ['schedule', 'cron', 'file-change', 'git', 'email', 'startup']) {
      expect(workflowInputSchema.safeParse(validInput({ trigger })).success, trigger).toBe(false);
    }
  });

  it('declares no field that could carry a schedule', () => {
    for (const field of ['cron', 'schedule', 'interval', 'watchPaths', 'onCommit']) {
      expect(workflowInputSchema.safeParse(validInput({ [field]: 'x' })).success, field).toBe(
        false,
      );
    }
  });
});

describe('a workflow cannot name a capability or a credential', () => {
  it('accepts only agent tool ids as a step tool', () => {
    for (const tool of AGENT_TOOL_IDS) {
      const query = tool === 'workspace.search' ? 'todo' : null;
      expect(workflowStepSchema.safeParse(step({ tool, query })).success, tool).toBe(true);
    }
    for (const tool of ['workspace.write', 'git.checkpoint', 'shell.execute', 'fs.read']) {
      expect(workflowStepSchema.safeParse(step({ tool })).success, tool).toBe(false);
    }
  });

  it('declares no field for a command, an argument or a shell', () => {
    for (const field of ['command', 'args', 'shell', 'cwd', 'env', 'url', 'actionType']) {
      expect(workflowStepSchema.safeParse(step({ [field]: 'x' })).success, field).toBe(false);
    }
  });

  it('rejects any field capable of carrying a credential', () => {
    for (const field of ['apiKey', 'token', 'password', 'secret', 'authorization']) {
      expect(workflowInputSchema.safeParse(validInput({ [field]: 'x' })).success, field).toBe(
        false,
      );
    }
  });

  it('refuses an absolute path or a traversal as a step target', () => {
    for (const target of ['C:\\Windows', '/etc/passwd', '../outside', 'a/../../b']) {
      expect(workflowStepSchema.safeParse(step({ target })).success, target).toBe(false);
    }
  });

  it('has no id or timestamp field on the submitted form', () => {
    expect(workflowInputSchema.safeParse(validInput({ createdAt: NOW })).success).toBe(false);
    expect(workflowInputSchema.safeParse(validInput({ updatedAt: NOW })).success).toBe(false);
  });
});

describe('steps are coherent', () => {
  it('requires a search step to carry a query, and refuses one elsewhere', () => {
    expect(
      workflowStepSchema.safeParse(step({ tool: 'workspace.search', query: null })).success,
    ).toBe(false);
    expect(
      workflowStepSchema.safeParse(step({ tool: 'workspace.search', query: 'todo' })).success,
    ).toBe(true);
    expect(
      workflowStepSchema.safeParse(step({ tool: 'workspace.inspect', query: 'todo' })).success,
    ).toBe(false);
  });

  it('bounds retries', () => {
    expect(workflowStepSchema.safeParse(step({ maxRetries: -1 })).success).toBe(false);
    expect(
      workflowStepSchema.safeParse(step({ maxRetries: WORKFLOW_MAX_STEP_RETRIES + 1 })).success,
    ).toBe(false);
    expect(
      workflowStepSchema.safeParse(step({ maxRetries: WORKFLOW_MAX_STEP_RETRIES })).success,
    ).toBe(true);
  });

  it('requires at least one step and bounds how many', () => {
    expect(workflowInputSchema.safeParse(validInput({ steps: [] })).success).toBe(false);
    const tooMany = Array.from({ length: WORKFLOW_MAX_DEFINITION_STEPS + 1 }, () => step());
    expect(
      workflowInputSchema.safeParse(
        validInput({
          steps: tooMany,
          limits: { maxSteps: WORKFLOW_MAX_STEPS, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses a first step whose condition refers to a previous one', () => {
    expect(
      workflowInputSchema.safeParse(
        validInput({ steps: [step({ condition: 'if-previous-succeeded' })] }),
      ).success,
    ).toBe(false);
  });

  it('permits a conditional step after the first', () => {
    expect(
      workflowInputSchema.safeParse(
        validInput({ steps: [step(), step({ condition: 'if-previous-failed' })] }),
      ).success,
    ).toBe(true);
  });
});

describe('a workflow cannot be unbounded', () => {
  it('refuses a step ceiling below the number of declared steps', () => {
    const input = validInput({
      steps: [step(), step(), step()],
      limits: { maxSteps: 2, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
    });
    expect(workflowInputSchema.safeParse(input).success).toBe(false);
  });

  it('bounds every ceiling to its declared range', () => {
    const outOfRange = [
      { maxSteps: 0, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
      { maxSteps: WORKFLOW_MAX_STEPS + 1, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
      { maxSteps: 8, maxDurationMs: 1, maxOutputBytes: 50_000 },
      { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 1 },
    ];
    for (const limits of outOfRange) {
      expect(workflowInputSchema.safeParse(validInput({ limits })).success).toBe(false);
    }
  });
});

describe('success criteria must be satisfiable', () => {
  it('refuses a requirement no step can satisfy', () => {
    const input = validInput({
      successCriteria: { verification: ['tests-pass'], requireAllStepsSucceed: true },
    });
    expect(workflowInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts one the steps do run', () => {
    const input = validInput({
      steps: [step(), step({ tool: 'command.test' })],
      successCriteria: { verification: ['tests-pass'], requireAllStepsSucceed: true },
    });
    expect(workflowInputSchema.safeParse(input).success).toBe(true);
  });

  it('refuses a requirement listed twice', () => {
    const input = validInput({
      steps: [step(), step({ tool: 'command.test' })],
      successCriteria: {
        verification: ['tests-pass', 'tests-pass'],
        requireAllStepsSucceed: true,
      },
    });
    expect(workflowInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('the store', () => {
  function stored(overrides: Record<string, unknown> = {}) {
    return { ...validInput(overrides), createdAt: NOW, updatedAt: NOW };
  }

  it('accepts an empty store', () => {
    expect(workflowStoreSchema.safeParse(createEmptyWorkflowStore()).success).toBe(true);
  });

  it('pins the schema version', () => {
    const store = { ...createEmptyWorkflowStore(), schemaVersion: WORKFLOW_SCHEMA_VERSION + 1 };
    expect(workflowStoreSchema.safeParse(store).success).toBe(false);
  });

  it('refuses two workflows under one id', () => {
    const store = { ...createEmptyWorkflowStore(), workflows: [stored(), stored()] };
    expect(workflowStoreSchema.safeParse(store).success).toBe(false);
  });

  it('bounds how many workflows it may hold', () => {
    const workflows = Array.from({ length: WORKFLOW_MAX_WORKFLOWS + 1 }, (_value, index) =>
      stored({ id: `flow.${String(index)}` }),
    );
    expect(
      workflowStoreSchema.safeParse({ ...createEmptyWorkflowStore(), workflows }).success,
    ).toBe(false);
  });

  it('refuses an unknown top-level field', () => {
    const store = { ...createEmptyWorkflowStore(), activeRunId: RUN_ID };
    expect(workflowStoreSchema.safeParse(store).success).toBe(false);
  });

  it('accepts a stored workflow with both timestamps', () => {
    expect(workflowSchema.safeParse(stored()).success).toBe(true);
    const { createdAt: _createdAt, ...withoutCreated } = stored();
    expect(workflowSchema.safeParse(withoutCreated).success).toBe(false);
  });
});

describe('run and progress records', () => {
  function validRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: RUN_ID,
      workflowId: 'nightly.check',
      workflowName: 'Nightly check',
      agentProfileId: 'reviewer',
      provider: 'none' as const,
      status: 'completed' as const,
      stopReason: 'completed' as const,
      startedAt: NOW,
      finishedAt: NOW,
      steps: [],
      verification: { required: [], satisfied: [], passed: true },
      rollback: { mode: 'none' as const, result: 'not-configured' as const, restored: 0 },
      totals: { steps: 0, outputBytes: 0, durationMs: 0 },
      ...overrides,
    };
  }

  it('accepts a well-formed run', () => {
    expect(workflowRunSchema.safeParse(validRun()).success).toBe(true);
  });

  it('refuses a stop reason outside the closed list', () => {
    expect(workflowRunSchema.safeParse(validRun({ stopReason: 'whatever' })).success).toBe(false);
  });

  it('bounds how many step records one run may carry', () => {
    const steps = Array.from({ length: WORKFLOW_MAX_STEPS + 1 }, (_value, index) => ({
      index,
      stepIndex: 0,
      attempt: 1,
      tool: 'workspace.inspect' as const,
      actionType: 'workspace.read' as const,
      outcome: 'success' as const,
      summary: 'Listed entries.',
      durationMs: 1,
      outputBytes: 1,
    }));
    expect(workflowRunSchema.safeParse(validRun({ steps })).success).toBe(false);
  });

  it('keeps a progress event content-free', () => {
    const event = {
      runId: RUN_ID,
      phase: 'step-started' as const,
      stepIndex: 0,
      attempt: 1,
      tool: 'workspace.inspect' as const,
      totalSteps: 2,
      completedSteps: 0,
      outcome: null,
    };
    expect(workflowProgressEventSchema.safeParse(event).success).toBe(true);
    for (const field of ['summary', 'output', 'path', 'commandLine', 'content']) {
      expect(workflowProgressEventSchema.safeParse({ ...event, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });
});
