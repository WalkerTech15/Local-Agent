import { describe, expect, it } from 'vitest';

import {
  afterStepOutcome,
  classifyWorkflowRun,
  decideNextWorkflowStep,
  describeWorkflowTools,
  evaluateWorkflowVerification,
  isStepConditionMet,
  planWorkflowRollback,
  toRollbackOutcome,
  workflowCheckpointCount,
  workflowStartsProcess,
  workflowStepsWithinProfile,
} from '../../../src/shared/workflow/execution';
import type { AgentProfile } from '../../../src/shared/schemas/agent.schema';
import type {
  Workflow,
  WorkflowRunStep,
  WorkflowStep,
} from '../../../src/shared/schemas/workflow.schema';

const NOW = '2026-01-01T00:00:00.000Z';

function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    tool: 'workspace.inspect',
    target: '',
    query: null,
    condition: 'always',
    maxRetries: 0,
    checkpoint: false,
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'nightly.check',
    name: 'Nightly check',
    description: '',
    trigger: 'manual',
    agentProfileId: 'reviewer',
    steps: [step()],
    limits: { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
    failureBehavior: 'stop',
    rollback: 'none',
    successCriteria: { verification: [], requireAllStepsSucceed: true },
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    description: '',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect', 'workspace.search', 'workspace.plan', 'command.test'],
    approvedWorkspacePaths: ['', 'src'],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
    enabled: true,
    builtIn: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function progress(overrides: Partial<Parameters<typeof decideNextWorkflowStep>[2]> = {}) {
  return {
    stepIndex: 0,
    attempt: 0,
    completedSteps: 0,
    previousOutcome: null,
    elapsedMs: 0,
    outputBytes: 0,
    cancelled: false,
    paused: false,
    emergencyEngaged: false,
    hasProject: true,
    ...overrides,
  };
}

describe('the authority chain: workflow inside agent', () => {
  it('accepts a workflow whose steps the profile allows', () => {
    expect(workflowStepsWithinProfile(workflow(), profile())).toBeNull();
  });

  it('refuses a step naming a tool the profile does not allow', () => {
    const flow = workflow({ steps: [step({ tool: 'git.status' })] });
    expect(workflowStepsWithinProfile(flow, profile())).toBe('WORKFLOW_TOOL_NOT_ALLOWED');
  });

  it('refuses a step naming a path outside the profile scope', () => {
    const flow = workflow({ steps: [step({ target: 'vendor' })] });
    const narrow = profile({ approvedWorkspacePaths: ['src'] });
    expect(workflowStepsWithinProfile(flow, narrow)).toBe('WORKFLOW_WORKSPACE_NOT_ALLOWED');
  });

  it('refuses the same step again at execution time, not only at save time', () => {
    const flow = workflow({ steps: [step({ tool: 'git.status' })] });
    const decision = decideNextWorkflowStep(flow, profile(), progress());
    expect(decision).toEqual({ kind: 'stop', reason: 'tool-not-allowed' });
  });

  it('stops when the profile is narrowed after the workflow was written', () => {
    const flow = workflow({ steps: [step({ target: 'src' })] });
    const narrowed = profile({ approvedWorkspacePaths: [''], allowedTools: ['workspace.plan'] });
    const decision = decideNextWorkflowStep(flow, narrowed, progress());
    expect(decision).toEqual({ kind: 'stop', reason: 'tool-not-allowed' });
  });
});

describe('the check order is the security property', () => {
  it('reports the emergency stop above every other stop condition', () => {
    const decision = decideNextWorkflowStep(
      workflow({ enabled: false }),
      profile({ enabled: false }),
      progress({
        emergencyEngaged: true,
        cancelled: true,
        paused: true,
        hasProject: false,
        elapsedMs: 999_999,
        completedSteps: 99,
        outputBytes: 999_999,
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'emergency-stop' });
  });

  it('reports cancellation above a pause and above every budget', () => {
    const decision = decideNextWorkflowStep(
      workflow(),
      profile(),
      progress({ cancelled: true, paused: true, elapsedMs: 999_999 }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'cancelled' });
  });

  it('reports a pause above a missing project', () => {
    const decision = decideNextWorkflowStep(
      workflow(),
      profile(),
      progress({ paused: true, hasProject: false }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'paused' });
  });

  it('stops with no approved project', () => {
    expect(decideNextWorkflowStep(workflow(), profile(), progress({ hasProject: false }))).toEqual({
      kind: 'stop',
      reason: 'no-project',
    });
  });

  it('stops when the workflow was disabled mid-run', () => {
    expect(decideNextWorkflowStep(workflow({ enabled: false }), profile(), progress())).toEqual({
      kind: 'stop',
      reason: 'workflow-disabled',
    });
  });

  it('stops when the agent was disabled mid-run', () => {
    expect(decideNextWorkflowStep(workflow(), profile({ enabled: false }), progress())).toEqual({
      kind: 'stop',
      reason: 'agent-denied',
    });
  });

  it('enforces the time, step and output ceilings before choosing a step', () => {
    expect(decideNextWorkflowStep(workflow(), profile(), progress({ elapsedMs: 60_000 }))).toEqual({
      kind: 'stop',
      reason: 'time-limit',
    });
    expect(decideNextWorkflowStep(workflow(), profile(), progress({ completedSteps: 8 }))).toEqual({
      kind: 'stop',
      reason: 'step-limit',
    });
    expect(
      decideNextWorkflowStep(workflow(), profile(), progress({ outputBytes: 50_000 })),
    ).toEqual({ kind: 'stop', reason: 'output-limit' });
  });

  it('stops when the profile denies the tool outright', () => {
    const denying = profile({
      permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'deny' }],
    });
    expect(decideNextWorkflowStep(workflow(), denying, progress())).toEqual({
      kind: 'stop',
      reason: 'agent-denied',
    });
  });

  it('reports completion once every step has been taken', () => {
    expect(decideNextWorkflowStep(workflow(), profile(), progress({ stepIndex: 1 }))).toEqual({
      kind: 'stop',
      reason: 'completed',
    });
  });
});

describe('running a step', () => {
  it('returns the step with a one-based attempt number', () => {
    const decision = decideNextWorkflowStep(workflow(), profile(), progress());
    expect(decision.kind).toBe('run');
    if (decision.kind !== 'run') return;
    expect(decision.attempt).toBe(1);
    expect(decision.stepIndex).toBe(0);
    expect(decision.tool.actionType).toBe('workspace.read');
  });

  it('raises a checkpoint step to requiring confirmation', () => {
    const flow = workflow({ steps: [step({ checkpoint: true })] });
    const decision = decideNextWorkflowStep(flow, profile(), progress());
    expect(decision.kind === 'run' && decision.requiresConfirmation).toBe(true);
  });

  it('raises a step the profile marks confirm, even without a checkpoint', () => {
    const confirming = profile({
      permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'confirm' }],
    });
    const decision = decideNextWorkflowStep(workflow(), confirming, progress());
    expect(decision.kind === 'run' && decision.requiresConfirmation).toBe(true);
  });

  it('refuses an attempt beyond the declared retry allowance', () => {
    const decision = decideNextWorkflowStep(workflow(), profile(), progress({ attempt: 1 }));
    expect(decision).toEqual({ kind: 'stop', reason: 'retries-exhausted' });
  });
});

describe('conditions', () => {
  it('always runs an unconditional step', () => {
    expect(isStepConditionMet(step(), null)).toBe(true);
    expect(isStepConditionMet(step(), 'failure')).toBe(true);
  });

  it('runs a success-conditioned step only after a success', () => {
    const conditioned = step({ condition: 'if-previous-succeeded' });
    expect(isStepConditionMet(conditioned, 'success')).toBe(true);
    expect(isStepConditionMet(conditioned, 'failure')).toBe(false);
    expect(isStepConditionMet(conditioned, null)).toBe(false);
  });

  it('runs a failure-conditioned step after anything but a success', () => {
    const conditioned = step({ condition: 'if-previous-failed' });
    expect(isStepConditionMet(conditioned, 'failure')).toBe(true);
    expect(isStepConditionMet(conditioned, 'denied')).toBe(true);
    expect(isStepConditionMet(conditioned, 'success')).toBe(false);
  });

  it('skips rather than stops when a condition is unmet', () => {
    const flow = workflow({ steps: [step(), step({ condition: 'if-previous-failed' })] });
    const decision = decideNextWorkflowStep(
      flow,
      profile(),
      progress({ stepIndex: 1, previousOutcome: 'success' }),
    );
    expect(decision).toEqual({ kind: 'skip', stepIndex: 1 });
  });
});

describe('a refusal always stops the run', () => {
  it('stops on a denial whatever the failure behaviour says', () => {
    for (const behaviour of ['stop', 'continue'] as const) {
      const flow = workflow({ failureBehavior: behaviour });
      expect(afterStepOutcome(flow, 0, 1, 'denied'), behaviour).toEqual({
        kind: 'stop',
        reason: 'step-denied',
      });
    }
  });

  it('stops on a declined confirmation whatever the failure behaviour says', () => {
    for (const behaviour of ['stop', 'continue'] as const) {
      const flow = workflow({ failureBehavior: behaviour });
      expect(afterStepOutcome(flow, 0, 1, 'aborted'), behaviour).toEqual({
        kind: 'stop',
        reason: 'step-declined',
      });
    }
  });

  it('never retries a refusal', () => {
    const flow = workflow({ steps: [step({ maxRetries: 3 })], failureBehavior: 'continue' });
    expect(afterStepOutcome(flow, 0, 1, 'denied').kind).toBe('stop');
    expect(afterStepOutcome(flow, 0, 1, 'aborted').kind).toBe('stop');
  });
});

describe('retries are bounded', () => {
  it('advances after a success', () => {
    expect(afterStepOutcome(workflow(), 0, 1, 'success')).toEqual({
      kind: 'advance',
      settledOutcome: 'success',
    });
  });

  it('retries a failure while the allowance lasts, then settles', () => {
    const flow = workflow({ steps: [step({ maxRetries: 2 })], failureBehavior: 'continue' });
    expect(afterStepOutcome(flow, 0, 1, 'failure')).toEqual({ kind: 'retry' });
    expect(afterStepOutcome(flow, 0, 2, 'failure')).toEqual({ kind: 'retry' });
    expect(afterStepOutcome(flow, 0, 3, 'failure')).toEqual({
      kind: 'advance',
      settledOutcome: 'failure',
    });
  });

  it('stops instead of advancing when the failure behaviour says stop', () => {
    const flow = workflow({ steps: [step({ maxRetries: 1 })], failureBehavior: 'stop' });
    expect(afterStepOutcome(flow, 0, 2, 'failure')).toEqual({
      kind: 'stop',
      reason: 'step-failed',
    });
  });

  it('never retries a step that declared no retries', () => {
    expect(afterStepOutcome(workflow({ failureBehavior: 'continue' }), 0, 1, 'failure')).toEqual({
      kind: 'advance',
      settledOutcome: 'failure',
    });
  });
});

describe('verification and classification', () => {
  function runStep(overrides: Partial<WorkflowRunStep> = {}): WorkflowRunStep {
    return {
      index: 0,
      stepIndex: 0,
      attempt: 1,
      tool: 'command.test',
      actionType: 'command.run',
      outcome: 'success',
      summary: 'ran',
      durationMs: 1,
      outputBytes: 1,
      ...overrides,
    };
  }

  const verifying = workflow({
    steps: [step(), step({ tool: 'command.test' })],
    successCriteria: { verification: ['tests-pass'], requireAllStepsSucceed: false },
  });

  it('satisfies a requirement only when its own tool succeeded', () => {
    expect(evaluateWorkflowVerification(verifying, [runStep()]).passed).toBe(true);
    expect(evaluateWorkflowVerification(verifying, [runStep({ outcome: 'failure' })]).passed).toBe(
      false,
    );
    expect(evaluateWorkflowVerification(verifying, [runStep({ outcome: 'denied' })]).passed).toBe(
      false,
    );
    expect(evaluateWorkflowVerification(verifying, []).passed).toBe(false);
  });

  it('passes vacuously when nothing is required', () => {
    expect(evaluateWorkflowVerification(workflow(), []).passed).toBe(true);
  });

  it('reports a completed-but-unverified run as failed', () => {
    const verification = evaluateWorkflowVerification(verifying, []);
    expect(classifyWorkflowRun(verifying, 'completed', verification, false)).toEqual({
      status: 'failed',
      stopReason: 'criteria-not-met',
    });
  });

  it('reports a completed run with a failed step as failed when every step must succeed', () => {
    const strict = workflow({
      successCriteria: { verification: [], requireAllStepsSucceed: true },
    });
    const verification = evaluateWorkflowVerification(strict, []);
    expect(classifyWorkflowRun(strict, 'completed', verification, true)).toEqual({
      status: 'failed',
      stopReason: 'criteria-not-met',
    });
  });

  it('permits a failed step when the criteria do not require every step to succeed', () => {
    const lenient = workflow({
      successCriteria: { verification: [], requireAllStepsSucceed: false },
    });
    const verification = evaluateWorkflowVerification(lenient, []);
    expect(classifyWorkflowRun(lenient, 'completed', verification, true)).toEqual({
      status: 'completed',
      stopReason: 'completed',
    });
  });

  it('classifies every refusal as denied rather than failed', () => {
    const verification = evaluateWorkflowVerification(workflow(), []);
    for (const reason of [
      'emergency-stop',
      'workflow-disabled',
      'agent-denied',
      'tool-not-allowed',
      'workspace-not-allowed',
      'step-denied',
      'step-declined',
    ] as const) {
      expect(classifyWorkflowRun(workflow(), reason, verification, false).status, reason).toBe(
        'denied',
      );
    }
  });

  it('classifies a pause and a cancellation as stopped, not failed', () => {
    const verification = evaluateWorkflowVerification(workflow(), []);
    expect(classifyWorkflowRun(workflow(), 'paused', verification, false).status).toBe('stopped');
    expect(classifyWorkflowRun(workflow(), 'cancelled', verification, false).status).toBe(
      'stopped',
    );
  });
});

describe('rollback', () => {
  it('reports not-configured when the workflow asks for none', () => {
    expect(planWorkflowRollback('none', 'failed', ['a'])).toEqual({ kind: 'not-configured' });
  });

  it('reports not-required when the run completed', () => {
    expect(planWorkflowRollback('restore-run-changes', 'completed', ['a'])).toEqual({
      kind: 'not-required',
    });
  });

  it('reports nothing-to-roll-back when the run applied no change', () => {
    // The honest answer in this milestone: no agent tool can write a file, so
    // a workflow run never produces a change set.
    expect(planWorkflowRollback('restore-run-changes', 'failed', [])).toEqual({
      kind: 'nothing-to-roll-back',
    });
  });

  it('restores only the changes it is given, and never anything else', () => {
    const plan = planWorkflowRollback('restore-run-changes', 'failed', ['a', 'b']);
    expect(plan).toEqual({ kind: 'restore', changeIds: ['a', 'b'] });
  });

  it('records what actually happened, not what was planned', () => {
    const plan = planWorkflowRollback('restore-run-changes', 'failed', ['a']);
    expect(toRollbackOutcome('restore-run-changes', plan, 1)).toEqual({
      mode: 'restore-run-changes',
      result: 'restored',
      restored: 1,
    });
    expect(toRollbackOutcome('restore-run-changes', plan, 0)).toEqual({
      mode: 'restore-run-changes',
      result: 'nothing-to-roll-back',
      restored: 0,
    });
  });
});

describe('describing a workflow', () => {
  it('lists each named tool once, in registry order', () => {
    const flow = workflow({
      steps: [step({ tool: 'command.test' }), step(), step()],
    });
    expect(describeWorkflowTools(flow).map((tool) => tool.id)).toEqual([
      'workspace.inspect',
      'command.test',
    ]);
  });

  it('reports whether any step starts a process', () => {
    expect(workflowStartsProcess(workflow())).toBe(false);
    expect(workflowStartsProcess(workflow({ steps: [step({ tool: 'command.lint' })] }))).toBe(true);
  });

  it('counts checkpoints', () => {
    const flow = workflow({ steps: [step({ checkpoint: true }), step()] });
    expect(workflowCheckpointCount(flow)).toBe(1);
  });
});
