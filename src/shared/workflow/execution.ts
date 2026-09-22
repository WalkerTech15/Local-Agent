/**
 * Bounded workflow execution, as pure logic (Phase 2, Milestone 9).
 *
 * This module decides **what a run would do next, whether it may, and when it
 * must stop**. It performs none of it: there is no I/O here, nothing is
 * executed, and no permission is granted. `main/workflow-runner.ts` drives
 * this, and `main/ipc.ts` is still the only place an action proposal is
 * built.
 *
 * It is the direct counterpart of `shared/agent/orchestration.ts` and follows
 * its shape deliberately, because a workflow run *is* an agent run with a
 * stored step list instead of a derived one.
 *
 * ## The authority chain
 *
 *     workflow  ⊆  agent profile  ⊆  permission policy
 *
 * {@link decideNextWorkflowStep} enforces the first link and nothing more. A
 * `run` decision means "the workflow declared this step, the selected agent
 * profile permits the tool and the path, and no budget has been reached" — it
 * never means "this is authorized". `main/permissions.ts` decides that
 * afterwards, unchanged, on the step's own action type.
 *
 * The second link is enforced twice: {@link workflowStepsWithinProfile} when
 * a workflow is saved, and again here before every single step. Twice,
 * because a profile can be narrowed after a workflow was written, and the
 * workflow file is user-editable in between.
 *
 * ## The order of the checks is the security property
 *
 * {@link decideNextWorkflowStep} evaluates its stop conditions before it ever
 * returns a step, in a fixed order: **emergency stop, cancellation, pause, no
 * project, workflow disabled, agent disabled, time, steps, output**, and only
 * then the per-step allowlist checks. A state that satisfies more than one
 * stop condition reports the most authoritative one.
 *
 * ## No model proposes these steps
 *
 * The step list comes from the stored definition. Nothing here parses model
 * output, and no network call is made. If a model ever proposes a step list,
 * it arrives as the same untrusted input this one already is — which is why
 * every step is re-checked against the profile at execution time rather than
 * once when the workflow was saved.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import {
  agentProfileDecisionFor,
  isAgentToolAllowed,
  isWorkspacePathAllowed,
} from '../agent/registry';
import { AGENT_TOOLS, findAgentTool, requirementToolId } from '../agent/tools';
import type { AgentToolDefinition } from '../agent/tools';
import type { AgentProfile } from '../schemas/agent.schema';
import type {
  Workflow,
  WorkflowRollbackMode,
  WorkflowRollbackOutcome,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowStep,
  WorkflowStopReason,
  WorkflowVerificationResult,
} from '../schemas/workflow.schema';
import type { WorkflowErrorCode } from './errors';
import type { AuditOutcome } from '../types';

/**
 * Checks that every declared step is inside the selected profile's
 * allowlists, and reports the first thing that is not.
 *
 * Used when a workflow is **saved**, so that a definition which could never
 * run is refused at the point someone can still fix it, rather than
 * discovered halfway through a run. Returns `null` when the workflow fits
 * entirely within the profile.
 *
 * This is a convenience, not the control: the control is that
 * {@link decideNextWorkflowStep} performs the same two checks again before
 * every step, and would refuse even if this had somehow passed.
 */
export function workflowStepsWithinProfile(
  workflow: Workflow,
  profile: AgentProfile,
): WorkflowErrorCode | null {
  for (const step of workflow.steps) {
    if (!isAgentToolAllowed(profile, step.tool)) return 'WORKFLOW_TOOL_NOT_ALLOWED';
    if (!isWorkspacePathAllowed(profile, step.target)) return 'WORKFLOW_WORKSPACE_NOT_ALLOWED';
  }
  return null;
}

/**
 * Whether a step's condition is satisfied, given how the previous **declared
 * step** ended.
 *
 * `previous` is the settled outcome of the previous declared step — after its
 * retries, not after each attempt — or `null` before the first step has run.
 * A condition that refers to a previous step when there is none is treated as
 * unsatisfied rather than as vacuously true; the schema already refuses such
 * a definition, and this is the backstop for one that reached here anyway.
 */
export function isStepConditionMet(step: WorkflowStep, previous: AuditOutcome | null): boolean {
  if (step.condition === 'always') return true;
  if (previous === null) return false;
  if (step.condition === 'if-previous-succeeded') return previous === 'success';
  return previous !== 'success';
}

/** Everything {@link decideNextWorkflowStep} needs to know about a run. */
export interface WorkflowRunProgress {
  /** Which declared step is next. */
  readonly stepIndex: number;
  /** How many attempts have already been made on that declared step. */
  readonly attempt: number;
  /** How many executions have finished, counting every attempt. */
  readonly completedSteps: number;
  /** The settled outcome of the previous declared step, or `null`. */
  readonly previousOutcome: AuditOutcome | null;
  /** Milliseconds since the run started, supplied by the caller's clock. */
  readonly elapsedMs: number;
  readonly outputBytes: number;
  readonly cancelled: boolean;
  /** The user asked the run to stop cleanly at the next step boundary. */
  readonly paused: boolean;
  readonly emergencyEngaged: boolean;
  readonly hasProject: boolean;
}

/**
 * What the runner should do next.
 *
 * A `run` decision means only that the workflow and the profile both permit
 * this step. It is not authorization — nothing in this module can produce
 * one, which is why the type says `run` rather than `allow`.
 */
export type WorkflowStepDecision =
  | {
      readonly kind: 'run';
      readonly step: WorkflowStep;
      readonly stepIndex: number;
      /** 1 for the first try, 2 for the first retry, and so on. */
      readonly attempt: number;
      readonly tool: AgentToolDefinition;
      readonly requiresConfirmation: boolean;
    }
  | { readonly kind: 'skip'; readonly stepIndex: number }
  | { readonly kind: 'stop'; readonly reason: WorkflowStopReason };

/**
 * The next step, the decision to skip one, or the reason the run stops here.
 *
 * The check order is fixed and is the point of this function; see the note at
 * the top of the module. Every branch that cannot prove a step is within
 * bounds returns a stop, so there is no path through this function that
 * returns `run` by falling through.
 */
export function decideNextWorkflowStep(
  workflow: Workflow,
  profile: AgentProfile,
  progress: WorkflowRunProgress,
): WorkflowStepDecision {
  // Refusals first. An engaged emergency stop outranks everything, including
  // a run that still has budget left, because the whole point of the stop is
  // that it does not wait for a natural stopping point.
  if (progress.emergencyEngaged) return { kind: 'stop', reason: 'emergency-stop' };
  if (progress.cancelled) return { kind: 'stop', reason: 'cancelled' };
  if (progress.paused) return { kind: 'stop', reason: 'paused' };
  if (!progress.hasProject) return { kind: 'stop', reason: 'no-project' };

  // Both of these are re-read between steps, so disabling a workflow or its
  // agent mid-run takes effect on the next one rather than at the end.
  if (!workflow.enabled) return { kind: 'stop', reason: 'workflow-disabled' };
  if (!profile.enabled) return { kind: 'stop', reason: 'agent-denied' };

  // Budgets. Checked before the step is chosen, so exceeding one never
  // executes "just one more".
  if (progress.elapsedMs >= workflow.limits.maxDurationMs) {
    return { kind: 'stop', reason: 'time-limit' };
  }
  if (progress.completedSteps >= workflow.limits.maxSteps) {
    return { kind: 'stop', reason: 'step-limit' };
  }
  if (progress.outputBytes >= workflow.limits.maxOutputBytes) {
    return { kind: 'stop', reason: 'output-limit' };
  }

  if (workflow.steps.length === 0) return { kind: 'stop', reason: 'no-steps' };
  if (progress.stepIndex >= workflow.steps.length) return { kind: 'stop', reason: 'completed' };

  const step = workflow.steps[progress.stepIndex];
  if (step === undefined) return { kind: 'stop', reason: 'completed' };

  // A retry beyond the declared allowance is not a step this workflow
  // permits. Unreachable while `afterStepOutcome` advances correctly, and
  // checked anyway because "how many times may this repeat" is the question
  // an unbounded loop would be the wrong answer to.
  if (progress.attempt > step.maxRetries) return { kind: 'stop', reason: 'retries-exhausted' };

  if (!isStepConditionMet(step, progress.previousOutcome)) {
    return { kind: 'skip', stepIndex: progress.stepIndex };
  }

  // The second link of the authority chain, re-checked rather than trusted
  // from save time. The definition is untrusted input — it is a user-editable
  // file, and the profile it points at may have been narrowed since.
  if (!isAgentToolAllowed(profile, step.tool)) {
    return { kind: 'stop', reason: 'tool-not-allowed' };
  }
  if (!isWorkspacePathAllowed(profile, step.target)) {
    return { kind: 'stop', reason: 'workspace-not-allowed' };
  }

  const profileDecision = agentProfileDecisionFor(profile, step.tool);
  if (profileDecision === 'deny') return { kind: 'stop', reason: 'agent-denied' };

  const tool = findAgentTool(step.tool);
  if (tool === null) return { kind: 'stop', reason: 'tool-not-allowed' };

  return {
    kind: 'run',
    step,
    stepIndex: progress.stepIndex,
    attempt: progress.attempt + 1,
    tool,
    // Either the workflow's own checkpoint or the profile's `confirm` raises
    // this step to asking first. Both can only ever *add* a prompt: neither
    // vocabulary has an `allow`, so nothing here can remove a confirmation
    // the floor requires or turn a denial into a permission.
    requiresConfirmation: step.checkpoint || profileDecision === 'confirm',
  };
}

/** What to do once a step has produced an outcome. */
export type WorkflowStepFollowUp =
  | { readonly kind: 'retry' }
  | { readonly kind: 'advance'; readonly settledOutcome: AuditOutcome }
  | { readonly kind: 'stop'; readonly reason: WorkflowStopReason };

/**
 * Whether to retry the step, move to the next one, or stop the run.
 *
 * Three rules, in order:
 *
 *  - **A refusal always stops the run**, whatever `failureBehavior` says. A
 *    step denied by the permission engine, declined by the user, or blocked
 *    by the emergency stop is an answer the run has already received;
 *    continuing past it would be the run arguing with it. This is the
 *    milestone's "never continue after a failed safety check", and it is not
 *    configurable — there is no value of `failureBehavior` that reaches it.
 *  - **A failure may be retried**, up to the step's own declared allowance.
 *    Every attempt is an execution and counts against `limits.maxSteps`, so
 *    the retry budget cannot outlive the run budget.
 *  - **A failure with no retries left** ends the run or advances past it,
 *    depending on `failureBehavior`. That choice applies only here: to a step
 *    that ran and reported a failure, never to one that was refused.
 */
export function afterStepOutcome(
  workflow: Workflow,
  stepIndex: number,
  attempt: number,
  outcome: AuditOutcome,
): WorkflowStepFollowUp {
  if (outcome === 'denied') return { kind: 'stop', reason: 'step-denied' };
  if (outcome === 'aborted') return { kind: 'stop', reason: 'step-declined' };
  if (outcome === 'success') return { kind: 'advance', settledOutcome: 'success' };

  const step = workflow.steps[stepIndex];
  if (step !== undefined && attempt <= step.maxRetries) return { kind: 'retry' };

  if (workflow.failureBehavior === 'stop') return { kind: 'stop', reason: 'step-failed' };
  return { kind: 'advance', settledOutcome: 'failure' };
}

/**
 * Which success criteria the completed steps actually satisfied.
 *
 * A requirement is satisfied only by its own tool completing with
 * `outcome: 'success'`, and by nothing else — a denied step, a declined
 * confirmation, a failed command and a step that never ran are all equally
 * unsatisfying. Nothing here can be satisfied by an assertion that the work
 * was done.
 *
 * `passed` is vacuously true when a workflow requires nothing. That is
 * deliberate: "this workflow does not define verification" is a different
 * statement from "verification failed".
 */
export function evaluateWorkflowVerification(
  workflow: Workflow,
  steps: readonly WorkflowRunStep[],
): WorkflowVerificationResult {
  const succeeded = new Set<string>(
    steps.filter((step) => step.outcome === 'success').map((step) => step.tool),
  );

  const required = [...workflow.successCriteria.verification];
  const satisfied = required.filter((requirement) => succeeded.has(requirementToolId(requirement)));

  return { required, satisfied, passed: satisfied.length === required.length };
}

/**
 * The overall status implied by how a run stopped.
 *
 * Kept as one mapping rather than assembled at each call site so that a new
 * stop reason cannot quietly default to `completed` — the exhaustive record
 * below stops compiling until the new reason is classified.
 */
const STATUS_BY_STOP_REASON: Readonly<Record<WorkflowStopReason, WorkflowRunStatus>> = {
  completed: 'completed',
  'step-limit': 'stopped',
  'time-limit': 'stopped',
  'output-limit': 'stopped',
  'retries-exhausted': 'failed',
  cancelled: 'stopped',
  paused: 'stopped',
  'emergency-stop': 'denied',
  'workflow-disabled': 'denied',
  'agent-denied': 'denied',
  'tool-not-allowed': 'denied',
  'workspace-not-allowed': 'denied',
  'step-denied': 'denied',
  'step-declined': 'denied',
  'step-failed': 'failed',
  'criteria-not-met': 'failed',
  'no-project': 'failed',
  'no-steps': 'completed',
};

/**
 * Classifies a finished run.
 *
 * A run that reached the end of its steps but did not meet its stated success
 * criteria is **not** a success: it is reported as `failed` with
 * `criteria-not-met`, so "the steps ran" is never mistaken for "the work is
 * verified". `requireAllStepsSucceed` is the second half of that — a run with
 * a failed step in it does not pass merely because its verification tools
 * happened to succeed.
 */
export function classifyWorkflowRun(
  workflow: Workflow,
  stopReason: WorkflowStopReason,
  verification: WorkflowVerificationResult,
  anyStepFailed: boolean,
): { readonly status: WorkflowRunStatus; readonly stopReason: WorkflowStopReason } {
  if (stopReason === 'completed') {
    if (!verification.passed) return { status: 'failed', stopReason: 'criteria-not-met' };
    if (workflow.successCriteria.requireAllStepsSucceed && anyStepFailed) {
      return { status: 'failed', stopReason: 'criteria-not-met' };
    }
  }
  return { status: STATUS_BY_STOP_REASON[stopReason], stopReason };
}

/** What a rollback would do, decided before anything is attempted. */
export type WorkflowRollbackPlan =
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'not-required' }
  | { readonly kind: 'nothing-to-roll-back' }
  | { readonly kind: 'restore'; readonly changeIds: readonly string[] };

/**
 * Decides what a run's rollback should do.
 *
 * **It restores change sets this run applied, and nothing else.** Never a
 * change the user made by hand, never one from an earlier run — the caller
 * passes the ids the run itself collected, and this function has no way to
 * reach any other.
 *
 * In this milestone that list is always empty, because no agent tool can
 * write a file: there is no `workspace.write` tool, so a workflow run cannot
 * produce a change set. `nothing-to-roll-back` is therefore the honest answer
 * today, and it is reported rather than dressed up as a successful rollback.
 * The `restore` branch is real, reviewed and tested so that the decision is
 * already correct if a write tool is ever added; see
 * `docs/phase-2-workflows.md`.
 */
export function planWorkflowRollback(
  mode: WorkflowRollbackMode,
  status: WorkflowRunStatus,
  appliedChangeIds: readonly string[],
): WorkflowRollbackPlan {
  if (mode === 'none') return { kind: 'not-configured' };
  if (status === 'completed') return { kind: 'not-required' };
  if (appliedChangeIds.length === 0) return { kind: 'nothing-to-roll-back' };
  return { kind: 'restore', changeIds: [...appliedChangeIds] };
}

/** Turns a plan, plus what actually happened, into the recorded outcome. */
export function toRollbackOutcome(
  mode: WorkflowRollbackMode,
  plan: WorkflowRollbackPlan,
  restored: number,
): WorkflowRollbackOutcome {
  if (plan.kind === 'restore') {
    return restored > 0
      ? { mode, result: 'restored', restored }
      : { mode, result: 'nothing-to-roll-back', restored: 0 };
  }
  return { mode, result: plan.kind, restored: 0 };
}

/**
 * Every tool this workflow's steps name, as full definitions, without
 * repeats and in registry order.
 *
 * Used by the interface to show what a workflow may reach for, and by the
 * confirmation dialog to state it before a run starts. Derived from the
 * registry rather than from the definition's own strings, so what is
 * displayed is what the code will actually consult.
 */
export function describeWorkflowTools(workflow: Workflow): readonly AgentToolDefinition[] {
  const named = new Set<string>(workflow.steps.map((step) => step.tool));
  return AGENT_TOOLS.filter((tool) => named.has(tool.id));
}

/** True when any step in this workflow can start a process. */
export function workflowStartsProcess(workflow: Workflow): boolean {
  return describeWorkflowTools(workflow).some((tool) => tool.commandId !== null);
}

/** How many steps in this workflow are confirmation checkpoints. */
export function workflowCheckpointCount(workflow: Workflow): number {
  return workflow.steps.filter((step) => step.checkpoint).length;
}
