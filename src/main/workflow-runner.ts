/**
 * The bounded workflow runner (Phase 2, Milestone 9).
 *
 * This is the loop that turns one stored definition into a sequence of
 * already-existing actions, and it is deliberately small. Every decision it
 * makes — what to do next, whether a limit has been reached, whether the
 * selected agent permits the step, whether a failure should be retried,
 * whether the result counts as verified — is made by the pure functions in
 * `src/shared/workflow/execution.ts`, which are testable without a
 * filesystem. What lives here is only the part that cannot be pure: reading
 * the clock, re-reading state between steps, and calling the injected step
 * executor.
 *
 * ## What this module is not
 *
 * It is **not** a second permission engine. It never decides that something
 * is allowed. `runStep` is supplied by `main/ipc.ts` and is the *same
 * executor an agent run uses* — the identical `AgentStepRequest` shape
 * dispatched through the identical `runWorkspaceAction` — so each step is
 * decided by `main/permissions.ts` on its own action type, confirmed natively
 * where the floor requires it, and written to the audit log. There is no
 * execution path in this milestone that an agent run did not already have.
 *
 * It is **not** a model client. No provider is called and no network request
 * is made; the step sequence comes from the stored definition.
 * `resolvedProvider` is recorded for transparency about what *would* carry a
 * model call once one exists.
 *
 * ## What it re-reads between steps
 *
 * The emergency stop, the workflow definition and the agent profile, every
 * single iteration. Engaging the stop, disabling the workflow or disabling
 * its agent therefore takes effect on the next step rather than at the end of
 * the run — "stop" has to mean "stop what is happening", not only "start
 * nothing new".
 */

import {
  afterStepOutcome,
  classifyWorkflowRun,
  decideNextWorkflowStep,
  evaluateWorkflowVerification,
  planWorkflowRollback,
  toRollbackOutcome,
} from '../shared/workflow/execution';
import type { AgentStepOutcome } from './agent-orchestrator';
import type { AgentToolDefinition } from '../shared/agent/tools';
import type { AgentProfile } from '../shared/schemas/agent.schema';
import type { ModelProvider } from '../shared/constants';
import { workflowRunSchema } from '../shared/schemas/workflow.schema';
import type {
  Workflow,
  WorkflowProgressEvent,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowStep,
  WorkflowStopReason,
} from '../shared/schemas/workflow.schema';
import type { AuditOutcome } from '../shared/types';

/** One step, as handed to the executor. */
export interface WorkflowStepRequest {
  readonly step: WorkflowStep;
  readonly tool: AgentToolDefinition;
  /** A checkpoint, or the profile's own `confirm`, asked before the pipeline. */
  readonly requiresConfirmation: boolean;
  readonly stepIndex: number;
  readonly attempt: number;
}

export interface WorkflowRunnerOptions {
  readonly runId: string;
  /** The definition as it was when the run was approved. */
  readonly workflow: Workflow;
  readonly profile: AgentProfile;
  /** Which provider the selected agent resolved to. Recorded, not called. */
  readonly provider: ModelProvider;
  /** The request in the user's own words, for the one tool that needs it. */
  readonly objective: string;
  /** UTC ISO-8601 for the start of the run. */
  readonly startedAt: string;
  /** UTC ISO-8601, read again when the run ends. */
  readonly nowFn: () => string;
  /** Elapsed-time source, injected so a test can drive the clock. */
  readonly monotonicMs: () => number;
  /** Cancellation, from the `workflow:cancel` channel. */
  readonly signal: AbortSignal;
  /**
   * Whether the user has asked the run to stop cleanly.
   *
   * Distinct from cancellation: a pause stops the run at the **next step
   * boundary**, keeping everything already done, while a cancel aborts
   * immediately and kills a child process the run had started.
   */
  readonly isPaused: () => boolean;
  /** Re-read from disk between steps, never cached for the run. */
  readonly isEmergencyEngaged: () => Promise<boolean>;
  /** Whether a project is approved *right now*. */
  readonly hasProject: () => boolean;
  /** The definition as it is *now*, or `null` if it has been deleted. */
  readonly refreshWorkflow: () => Promise<Workflow | null>;
  /** The selected profile as it is *now*, or `null` if it is gone. */
  readonly refreshProfile: () => Promise<AgentProfile | null>;
  readonly runStep: (request: WorkflowStepRequest) => Promise<AgentStepOutcome>;
  /** Advisory progress, pushed to the renderer. Never carries content. */
  readonly onProgress: (event: WorkflowProgressEvent) => void;
}

/**
 * Runs one bounded workflow and returns its record.
 *
 * Never throws for an ordinary refusal: a denial, a decline, a limit, a pause
 * and a cancellation are all outcomes recorded on the returned
 * {@link WorkflowRun}, because a run that was stopped on purpose is not an
 * error. The result is validated against `workflowRunSchema` before it is
 * returned, so a malformed record fails here rather than at the IPC boundary.
 */
export async function runWorkflow(options: WorkflowRunnerOptions): Promise<WorkflowRun> {
  const { signal } = options;

  const steps: WorkflowRunStep[] = [];
  const startMs = options.monotonicMs();

  let workflow = options.workflow;
  let profile = options.profile;
  let stepIndex = 0;
  let attempt = 0;
  let previousOutcome: AuditOutcome | null = null;
  let outputBytes = 0;
  let anyStepFailed = false;
  // Definite assignment: every path out of the loop below sets this before it
  // breaks, and there is no other exit — so an initial value here would be
  // dead, and a *wrong* dead default is exactly how a stopped run comes to be
  // reported as a completed one.
  let stopReason!: WorkflowStopReason;

  const emit = (
    phase: WorkflowProgressEvent['phase'],
    detail: Partial<WorkflowProgressEvent> = {},
  ): void => {
    options.onProgress({
      runId: options.runId,
      phase,
      stepIndex: null,
      attempt: 0,
      tool: null,
      totalSteps: workflow.steps.length,
      completedSteps: steps.length,
      outcome: null,
      ...detail,
    });
  };

  emit('started');

  for (;;) {
    // Re-read every iteration rather than once. Engaging the emergency stop,
    // disabling the workflow, disabling its agent or closing the project all
    // take effect on the next step.
    const emergencyEngaged = await options.isEmergencyEngaged();

    const currentWorkflow = await options.refreshWorkflow();
    if (currentWorkflow === null) {
      // Deleting a running workflow is refused by the store, so this is the
      // backstop for a file edited by hand mid-run. Treated as "disabled"
      // because the effect is the same: there is no definition to continue.
      stopReason = 'workflow-disabled';
      break;
    }
    workflow = currentWorkflow;

    const currentProfile = await options.refreshProfile();
    if (currentProfile === null) {
      stopReason = 'agent-denied';
      break;
    }
    profile = currentProfile;

    const decision = decideNextWorkflowStep(workflow, profile, {
      stepIndex,
      attempt,
      completedSteps: steps.length,
      previousOutcome,
      elapsedMs: Math.max(0, options.monotonicMs() - startMs),
      outputBytes,
      cancelled: signal.aborted,
      paused: options.isPaused(),
      emergencyEngaged,
      hasProject: options.hasProject(),
    });

    if (decision.kind === 'stop') {
      stopReason = decision.reason;
      break;
    }

    if (decision.kind === 'skip') {
      // A skipped step did not run, so it does not become the "previous
      // outcome" for the next condition: that always refers to the last step
      // that actually executed.
      stepIndex += 1;
      attempt = 0;
      continue;
    }

    emit(decision.requiresConfirmation ? 'awaiting-confirmation' : 'step-started', {
      stepIndex: decision.stepIndex,
      attempt: decision.attempt,
      tool: decision.step.tool,
    });

    const stepStartedMs = options.monotonicMs();
    const result = await options.runStep({
      step: decision.step,
      tool: decision.tool,
      requiresConfirmation: decision.requiresConfirmation,
      stepIndex: decision.stepIndex,
      attempt: decision.attempt,
    });
    const durationMs = Math.max(0, options.monotonicMs() - stepStartedMs);

    steps.push({
      index: steps.length,
      stepIndex: decision.stepIndex,
      attempt: decision.attempt,
      tool: decision.step.tool,
      actionType: decision.tool.actionType,
      outcome: result.outcome,
      summary: result.summary,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      durationMs,
      outputBytes: result.outputBytes,
    });
    outputBytes += result.outputBytes;
    if (result.outcome === 'failure') anyStepFailed = true;

    emit('step-finished', {
      stepIndex: decision.stepIndex,
      attempt: decision.attempt,
      tool: decision.step.tool,
      outcome: result.outcome,
    });

    const follow = afterStepOutcome(workflow, decision.stepIndex, decision.attempt, result.outcome);
    if (follow.kind === 'stop') {
      stopReason = follow.reason;
      break;
    }
    if (follow.kind === 'retry') {
      attempt = decision.attempt;
      continue;
    }

    stepIndex = decision.stepIndex + 1;
    attempt = 0;
    previousOutcome = follow.settledOutcome;
  }

  const verification = evaluateWorkflowVerification(workflow, steps);
  const classified = classifyWorkflowRun(workflow, stopReason, verification, anyStepFailed);

  /**
   * Change sets this run applied, in the order it applied them.
   *
   * **Always empty in this milestone**, and not because collecting them was
   * forgotten: no agent tool can write a file — there is no `workspace.write`
   * tool for a workflow step to name — so no step can produce a change set.
   * The list exists because the rollback decision is about what *this run*
   * did, and never about a change the user made by hand or one from an
   * earlier run; a decision function given no such input would be deciding
   * about something else. See `docs/phase-2-workflows.md`.
   */
  const appliedChangeIds: readonly string[] = [];
  const rollbackPlan = planWorkflowRollback(workflow.rollback, classified.status, appliedChangeIds);
  const rollback = toRollbackOutcome(workflow.rollback, rollbackPlan, 0);

  emit('finished');

  return workflowRunSchema.parse({
    runId: options.runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    agentProfileId: profile.id,
    provider: options.provider,
    status: classified.status,
    stopReason: classified.stopReason,
    startedAt: options.startedAt,
    finishedAt: options.nowFn(),
    steps,
    verification,
    rollback,
    totals: {
      steps: steps.length,
      outputBytes,
      durationMs: Math.max(0, options.monotonicMs() - startMs),
    },
  } satisfies WorkflowRun);
}

/**
 * The sentence shown in the native dialog before a workflow run starts.
 *
 * Built here, in the main process, from the *stored* definition and the
 * *stored* profile — never from the request — so a compromised renderer can
 * cause the question to be asked but cannot change what it says. It states
 * every one of the milestone's "show limits and permissions" items in plain
 * text: which agent, which ordered steps, which part of the project, the
 * three ceilings, where it will stop to ask again, and what happens if
 * something fails.
 */
export function describeWorkflowRun(
  workflow: Workflow,
  profile: AgentProfile,
  tools: readonly AgentToolDefinition[],
): string {
  const startsProcess = tools.some((tool) => tool.commandId !== null);
  const checkpoints = workflow.steps.filter((step) => step.checkpoint).length;

  const lines = [
    `Run the workflow "${workflow.name}"?`,
    '',
    `Agent:         ${profile.name}`,
    `Steps:         ${String(workflow.steps.length)} (ceiling ${String(workflow.limits.maxSteps)} including retries)`,
    `Time limit:    ${String(Math.round(workflow.limits.maxDurationMs / 1000))}s`,
    `Output limit:  ${String(workflow.limits.maxOutputBytes)} bytes`,
    `On failure:    ${workflow.failureBehavior === 'stop' ? 'stop the run' : 'continue to the next step'}`,
    `Rollback:      ${workflow.rollback === 'none' ? 'none' : 'restore changes this run applied'}`,
    '',
    'Ordered steps:',
    ...workflow.steps.map((step, index) => {
      const scope = step.target === '' ? 'the whole approved project' : step.target;
      const retries =
        step.maxRetries > 0
          ? `, up to ${String(step.maxRetries)} retr${step.maxRetries === 1 ? 'y' : 'ies'}`
          : '';
      const checkpoint = step.checkpoint ? ' [asks first]' : '';
      return `  ${String(index + 1)}. ${step.tool} on ${scope}${retries}${checkpoint}`;
    }),
    '',
    'It may use only these tools:',
    ...tools.map((tool) => `  ${tool.label} (${tool.actionType})`),
    '',
    'Limited to the parts of the project the agent covers:',
    ...profile.approvedWorkspacePaths.map((path) =>
      path === '' ? '  the whole approved project' : `  ${path}`,
    ),
  ];

  if (workflow.successCriteria.verification.length > 0) {
    lines.push('', `Success requires: ${workflow.successCriteria.verification.join(', ')}`);
  }

  lines.push(
    '',
    checkpoints > 0
      ? `${String(checkpoints)} step(s) will stop and ask again before running.`
      : 'No step is marked as a checkpoint.',
    startsProcess
      ? 'This workflow can run the project’s own scripts. Each one is confirmed separately before it starts.'
      : 'This workflow cannot start a process, change a file, or create a commit.',
  );

  return lines.join('\n');
}

/** The sentence shown when a workflow step is a confirmation checkpoint. */
export function describeWorkflowCheckpoint(
  workflow: Workflow,
  request: WorkflowStepRequest,
): string {
  return [
    `Checkpoint in the workflow "${workflow.name}".`,
    '',
    `Step:    ${String(request.stepIndex + 1)} of ${String(workflow.steps.length)} (attempt ${String(request.attempt)})`,
    `Tool:    ${request.tool.label}`,
    `Action:  ${request.tool.actionType}`,
    `Scope:   ${request.step.target === '' ? 'the whole approved project' : request.step.target}`,
    '',
    'Approving this skips nothing else: the permission policy still decides the action afterwards, and a confirmation the policy itself requires is still asked separately.',
  ].join('\n');
}
