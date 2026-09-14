import { describe, expect, it } from 'vitest';

import {
  buildAgentPlan,
  classifyAgentRun,
  decideNextStep,
  describeProfileTools,
  evaluateAgentVerification,
  profileCanRunCommands,
} from '../../../src/shared/agent';
import type { AgentPlan, AgentRunProgress } from '../../../src/shared/agent';
import { WORKSPACE_SEARCH_QUERY_MAX_LENGTH } from '../../../src/shared/constants';
import type { AgentProfile, AgentRunStep } from '../../../src/shared/schemas';

/**
 * Bounded orchestration, as pure logic (Phase 2, Milestone 7).
 *
 * Every limit that matters is exercised here against a table of states rather
 * than by starting real processes: the step ceiling, the clock, the output
 * budget, the tool allowlist, the workspace scope, the emergency stop and
 * cancellation. The ordering cases matter as much as the individual ones — a
 * refusal must outrank a budget, or an engaged emergency stop would be
 * reported as "ran out of steps".
 */

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'custom',
    name: 'Custom',
    description: '',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect', 'workspace.plan'],
    approvedWorkspacePaths: [''],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 10_000 },
    enabled: true,
    builtIn: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function progress(overrides: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    completedSteps: 0,
    elapsedMs: 0,
    outputBytes: 0,
    cancelled: false,
    emergencyEngaged: false,
    hasProject: true,
    ...overrides,
  };
}

function step(overrides: Partial<AgentRunStep> = {}): AgentRunStep {
  return {
    index: 0,
    tool: 'workspace.plan',
    actionType: 'workspace.plan',
    outcome: 'success',
    summary: 'Produced a plan.',
    durationMs: 1,
    outputBytes: 1,
    ...overrides,
  };
}

describe('plan construction', () => {
  it('is deterministic for the same profile and objective', () => {
    const a = buildAgentPlan(profile(), 'refactor the settings loader');
    const b = buildAgentPlan(profile(), 'refactor the settings loader');
    expect(a).toEqual(b);
  });

  it('only ever names tools the profile allows', () => {
    const allowed = profile({ allowedTools: ['workspace.inspect'], approvedWorkspacePaths: [''] });
    const plan = buildAgentPlan(allowed, 'look at the settings loader');
    expect(plan.steps.every((entry) => entry.tool === 'workspace.inspect')).toBe(true);
  });

  it('never exceeds the profile step ceiling', () => {
    const narrow = profile({
      allowedTools: ['workspace.inspect'],
      approvedWorkspacePaths: ['src', 'tests', 'docs'],
      limits: { maxSteps: 2, maxDurationMs: 60_000, maxOutputBytes: 10_000 },
    });
    const plan = buildAgentPlan(narrow, 'look at everything');
    expect(plan.steps).toHaveLength(2);
  });

  it('inspects each approved scope rather than only the first', () => {
    const scoped = profile({
      allowedTools: ['workspace.inspect'],
      approvedWorkspacePaths: ['src', 'tests'],
    });
    const plan = buildAgentPlan(scoped, 'look at the loader');
    expect(plan.steps.map((entry) => entry.target)).toEqual(['src', 'tests']);
  });

  it('starts no process unless the profile requires a verification', () => {
    const capable = profile({
      allowedTools: ['workspace.inspect', 'workspace.plan', 'command.test', 'command.lint'],
      verification: [],
    });
    const plan = buildAgentPlan(capable, 'check the loader');
    expect(plan.steps.some((entry) => entry.tool.startsWith('command.'))).toBe(false);
  });

  it('runs exactly the verification commands the profile requires', () => {
    const verifying = profile({
      allowedTools: ['workspace.inspect', 'command.test', 'command.lint', 'command.typecheck'],
      verification: ['tests-pass', 'typecheck-clean'],
    });
    const plan = buildAgentPlan(verifying, 'check the loader');
    const commands = plan.steps
      .map((entry) => entry.tool)
      .filter((tool) => tool.startsWith('command.'));
    expect(commands).toEqual(['command.test', 'command.typecheck']);
  });

  it('omits the search step rather than inventing a query', () => {
    const searcher = profile({
      allowedTools: ['workspace.search'],
      approvedWorkspacePaths: [''],
    });
    // No token survives keyword extraction, so there is nothing to search for.
    const plan = buildAgentPlan(searcher, 'a of to');
    expect(plan.steps).toHaveLength(0);
  });

  it('derives the search query from the objective, by the shared keyword rule', () => {
    const searcher = profile({ allowedTools: ['workspace.search'], approvedWorkspacePaths: [''] });
    const plan = buildAgentPlan(searcher, 'investigate the permissions engine');
    // `extractObjectiveKeywords` ranks by length and breaks ties
    // alphabetically, so this is the shared rule's answer, not a second one.
    expect(plan.steps[0]?.query).toBe('investigate');
    expect(plan.steps[0]?.query?.length).toBeLessThanOrEqual(WORKSPACE_SEARCH_QUERY_MAX_LENGTH);
  });
});

describe('stop conditions and their order', () => {
  const plan: AgentPlan = { steps: [{ tool: 'workspace.inspect', target: '', query: null }] };
  const allowing = profile({ allowedTools: ['workspace.inspect'], approvedWorkspacePaths: [''] });

  it('runs a step when everything is within bounds', () => {
    const decision = decideNextStep(allowing, plan, progress());
    expect(decision.kind).toBe('run');
  });

  it('stops on an engaged emergency stop, ahead of every other condition', () => {
    const decision = decideNextStep(
      allowing,
      plan,
      // Every other stop condition is also true here; the emergency stop is
      // the one that must be reported.
      progress({
        emergencyEngaged: true,
        cancelled: true,
        completedSteps: 99,
        elapsedMs: 10_000_000,
        outputBytes: 10_000_000,
        hasProject: false,
      }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'emergency-stop' });
  });

  it('stops on cancellation ahead of any budget', () => {
    const decision = decideNextStep(
      allowing,
      plan,
      progress({ cancelled: true, completedSteps: 99, elapsedMs: 10_000_000 }),
    );
    expect(decision).toEqual({ kind: 'stop', reason: 'cancelled' });
  });

  it('stops when no project is approved', () => {
    const decision = decideNextStep(allowing, plan, progress({ hasProject: false }));
    expect(decision).toEqual({ kind: 'stop', reason: 'no-project' });
  });

  it('stops when the profile has been disabled mid-run', () => {
    const decision = decideNextStep({ ...allowing, enabled: false }, plan, progress());
    expect(decision).toEqual({ kind: 'stop', reason: 'profile-denied' });
  });

  it('stops on the time limit before choosing a step', () => {
    const decision = decideNextStep(allowing, plan, progress({ elapsedMs: 60_000 }));
    expect(decision).toEqual({ kind: 'stop', reason: 'time-limit' });
  });

  it('stops on the step limit', () => {
    const bounded = profile({
      allowedTools: ['workspace.inspect'],
      approvedWorkspacePaths: [''],
      limits: { maxSteps: 1, maxDurationMs: 60_000, maxOutputBytes: 10_000 },
    });
    const decision = decideNextStep(bounded, plan, progress({ completedSteps: 1 }));
    expect(decision).toEqual({ kind: 'stop', reason: 'step-limit' });
  });

  it('stops on the output limit', () => {
    const decision = decideNextStep(allowing, plan, progress({ outputBytes: 10_000 }));
    expect(decision).toEqual({ kind: 'stop', reason: 'output-limit' });
  });

  it('re-checks the tool allowlist at execution time, not only at planning time', () => {
    // A plan that names a tool the profile does not allow — which is what a
    // model-proposed plan could look like in a later milestone.
    const hostilePlan: AgentPlan = {
      steps: [{ tool: 'command.test', target: '', query: null }],
    };
    const decision = decideNextStep(allowing, hostilePlan, progress());
    expect(decision).toEqual({ kind: 'stop', reason: 'tool-not-allowed' });
  });

  it('re-checks the workspace scope at execution time', () => {
    const scoped = profile({
      allowedTools: ['workspace.inspect'],
      approvedWorkspacePaths: ['src'],
    });
    const hostilePlan: AgentPlan = {
      steps: [{ tool: 'workspace.inspect', target: 'secrets', query: null }],
    };
    const decision = decideNextStep(scoped, hostilePlan, progress());
    expect(decision).toEqual({ kind: 'stop', reason: 'workspace-not-allowed' });
  });

  it('stops when the profile itself denies the tool', () => {
    const denying = profile({
      allowedTools: ['workspace.inspect'],
      approvedWorkspacePaths: [''],
      permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'deny' }],
    });
    expect(decideNextStep(denying, plan, progress())).toEqual({
      kind: 'stop',
      reason: 'profile-denied',
    });
  });

  it('raises a step to requiring confirmation when the profile says so', () => {
    const confirming = profile({
      allowedTools: ['workspace.inspect'],
      approvedWorkspacePaths: [''],
      permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'confirm' }],
    });
    const decision = decideNextStep(confirming, plan, progress());
    expect(decision).toEqual({
      kind: 'run',
      step: plan.steps[0],
      requiresConfirmation: true,
    });
  });

  it('reports completion once the plan is exhausted', () => {
    expect(decideNextStep(allowing, plan, progress({ completedSteps: 1 }))).toEqual({
      kind: 'stop',
      reason: 'completed',
    });
  });

  it('reports an empty plan distinctly from a completed one', () => {
    expect(decideNextStep(allowing, { steps: [] }, progress())).toEqual({
      kind: 'stop',
      reason: 'no-steps',
    });
  });
});

describe('verification', () => {
  it('is satisfied only by the requirement’s own tool succeeding', () => {
    const verifying = profile({
      allowedTools: ['workspace.plan', 'command.test'],
      verification: ['plan-produced', 'tests-pass'],
    });
    const result = evaluateAgentVerification(verifying, [
      step({ tool: 'workspace.plan', outcome: 'success' }),
      step({ index: 1, tool: 'command.test', actionType: 'command.run', outcome: 'failure' }),
    ]);
    expect(result.satisfied).toEqual(['plan-produced']);
    expect(result.passed).toBe(false);
  });

  it('is not satisfied by a denied or declined step', () => {
    const verifying = profile({
      allowedTools: ['workspace.plan', 'command.test'],
      verification: ['tests-pass'],
    });
    for (const outcome of ['denied', 'aborted', 'failure'] as const) {
      const result = evaluateAgentVerification(verifying, [
        step({ tool: 'command.test', actionType: 'command.run', outcome }),
      ]);
      expect(result.passed, outcome).toBe(false);
    }
  });

  it('passes vacuously when a profile requires nothing', () => {
    const result = evaluateAgentVerification(profile({ verification: [] }), []);
    expect(result).toEqual({ required: [], satisfied: [], passed: true });
  });
});

describe('run classification', () => {
  it('reports an unverified completion as a failure, not a success', () => {
    const classified = classifyAgentRun('completed', {
      required: ['tests-pass'],
      satisfied: [],
      passed: false,
    });
    expect(classified).toEqual({ status: 'failed', stopReason: 'verification-failed' });
  });

  it('reports a verified completion as completed', () => {
    const classified = classifyAgentRun('completed', {
      required: ['tests-pass'],
      satisfied: ['tests-pass'],
      passed: true,
    });
    expect(classified).toEqual({ status: 'completed', stopReason: 'completed' });
  });

  it('reports every refusal as denied rather than failed', () => {
    const passing = { required: [], satisfied: [], passed: true };
    for (const reason of [
      'emergency-stop',
      'tool-not-allowed',
      'workspace-not-allowed',
      'profile-denied',
      'step-denied',
      'step-declined',
    ] as const) {
      expect(classifyAgentRun(reason, passing).status, reason).toBe('denied');
    }
  });

  it('reports a limit or a cancellation as stopped, not failed', () => {
    const passing = { required: [], satisfied: [], passed: true };
    for (const reason of ['step-limit', 'time-limit', 'output-limit', 'cancelled'] as const) {
      expect(classifyAgentRun(reason, passing).status, reason).toBe('stopped');
    }
  });
});

describe('profile description helpers', () => {
  it('describes only the tools the profile actually permits', () => {
    const described = describeProfileTools(
      profile({ allowedTools: ['workspace.inspect'], approvedWorkspacePaths: [''] }),
    );
    expect(described.map((tool) => tool.id)).toEqual(['workspace.inspect']);
  });

  it('describes nothing for a disabled profile', () => {
    expect(describeProfileTools(profile({ enabled: false }))).toEqual([]);
  });

  it('reports whether any permitted tool can start a process', () => {
    expect(profileCanRunCommands(profile({ allowedTools: ['workspace.inspect'] }))).toBe(false);
    expect(
      profileCanRunCommands(
        profile({ allowedTools: ['command.test'], verification: ['tests-pass'] }),
      ),
    ).toBe(true);
  });
});
