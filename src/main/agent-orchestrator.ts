/**
 * The bounded agent orchestrator (Phase 2, Milestone 7).
 *
 * This is the loop that turns one request into a sequence of already-existing
 * actions, and it is deliberately small. Every decision it makes — what to do
 * next, whether a limit has been reached, whether the profile permits a step,
 * whether the result counts as verified — is made by the pure functions in
 * `src/shared/agent/orchestration.ts`, which are testable without a
 * filesystem. What lives here is only the part that cannot be pure: reading
 * the clock, asking whether the emergency stop is engaged, and calling the
 * injected step executor.
 *
 * ## What this module is not
 *
 * It is **not** a second permission engine. It never decides that something
 * is allowed. `runStep` is supplied by `main/ipc.ts` and routes every step
 * through the unmodified `handleActionProposal`, so each step is decided by
 * `main/permissions.ts` on its own action type, confirmed natively where the
 * floor requires it, and written to the audit log — exactly as the same
 * operation would be if a person had clicked it. This module can only ever
 * stop a run *earlier* than the permission engine would have.
 *
 * It is **not** a model client. No provider is called and no network request
 * is made; the step sequence is derived deterministically from the profile
 * and the objective. `resolvedProvider` is recorded for transparency about
 * what *would* carry a model call once one exists.
 *
 * ## The one thing a profile may add
 *
 * A profile whose `permissionPolicy` says `confirm` for a tool causes
 * {@link AgentStepRequest.requiresConfirmation} to be set, and the step
 * executor asks the user before proposing the action at all. That is an
 * **additional** gate in front of the pipeline, never a substitute for one: a
 * profile cannot say `allow`, so nothing here can remove a confirmation the
 * floor requires or turn a denial into a permission.
 */

import {
  buildAgentPlan,
  classifyAgentRun,
  decideNextStep,
  describeProfileTools,
  evaluateAgentVerification,
} from '../shared/agent/orchestration';
import type { AgentPlanStep } from '../shared/agent/orchestration';
import { findAgentTool } from '../shared/agent/tools';
import type { AgentToolDefinition } from '../shared/agent/tools';
import type { ModelProvider } from '../shared/constants';
import { agentRunSchema } from '../shared/schemas/agent.schema';
import type {
  AgentProfile,
  AgentRun,
  AgentRunStep,
  AgentStopReason,
} from '../shared/schemas/agent.schema';
import type { AuditOutcome } from '../shared/types';
import type { WorkspaceErrorCode } from '../shared/workspace/errors';

/** One step, as handed to the executor. */
export interface AgentStepRequest {
  readonly step: AgentPlanStep;
  readonly tool: AgentToolDefinition;
  /** The profile asked for this step to be confirmed, on top of any floor. */
  readonly requiresConfirmation: boolean;
  /** The run's objective, for the one tool that needs it. */
  readonly objective: string;
}

/** What the executor reports back. Never a message, never a path. */
export interface AgentStepOutcome {
  readonly outcome: AuditOutcome;
  /** Reviewed, bounded wording built from counts — never from file contents. */
  readonly summary: string;
  readonly errorCode?: WorkspaceErrorCode;
  /** How much of the run's output budget this step consumed. */
  readonly outputBytes: number;
}

export interface AgentOrchestrationOptions {
  readonly runId: string;
  readonly profile: AgentProfile;
  readonly objective: string;
  /** Which provider the profile resolved to. Recorded, not called. */
  readonly provider: ModelProvider;
  /** UTC ISO-8601 for the start of the run. */
  readonly startedAt: string;
  /** UTC ISO-8601, read again when the run ends. */
  readonly nowFn: () => string;
  /** Elapsed-time source, injected so a test can drive the clock. */
  readonly monotonicMs: () => number;
  /** Cancellation, from the `agent:cancel` channel. */
  readonly signal: AbortSignal;
  /** Re-read from disk between steps, never cached for the run. */
  readonly isEmergencyEngaged: () => Promise<boolean>;
  /** Whether a project is approved *right now*. */
  readonly hasProject: () => boolean;
  readonly runStep: (request: AgentStepRequest) => Promise<AgentStepOutcome>;
}

/**
 * Runs one bounded orchestration and returns its record.
 *
 * Never throws for an ordinary refusal: a denial, a decline, a limit and a
 * cancellation are all outcomes recorded on the returned {@link AgentRun},
 * because a run that was stopped on purpose is not an error. The result is
 * validated against `agentRunSchema` before it is returned, so a malformed
 * record fails here rather than at the IPC boundary.
 */
export async function runAgentOrchestration(options: AgentOrchestrationOptions): Promise<AgentRun> {
  const { profile, objective, signal } = options;

  const plan = buildAgentPlan(profile, objective);
  const steps: AgentRunStep[] = [];
  const startMs = options.monotonicMs();

  let outputBytes = 0;
  let anyStepFailed = false;
  // Definite assignment: every path out of the loop below sets this before it
  // breaks, and there is no other exit — so an initial value here would be
  // dead, and a *wrong* dead default is exactly how a stopped run comes to be
  // reported as a completed one.
  let stopReason!: AgentStopReason;

  for (;;) {
    // Re-read every iteration rather than once: "emergency stop" has to mean
    // "stop what is happening", not only "start nothing new", and the same
    // applies to the project being closed mid-run.
    const emergencyEngaged = await options.isEmergencyEngaged();

    const decision = decideNextStep(profile, plan, {
      completedSteps: steps.length,
      elapsedMs: Math.max(0, options.monotonicMs() - startMs),
      outputBytes,
      cancelled: signal.aborted,
      emergencyEngaged,
      hasProject: options.hasProject(),
    });

    if (decision.kind === 'stop') {
      stopReason = decision.reason;
      break;
    }

    const tool = findAgentTool(decision.step.tool);
    if (tool === null) {
      // Unreachable while `decideNextStep` has already resolved the tool;
      // treated as a refusal rather than an exception so a run can never
      // proceed on a step nothing could describe.
      stopReason = 'tool-not-allowed';
      break;
    }

    const stepStartedMs = options.monotonicMs();
    const result = await options.runStep({
      step: decision.step,
      tool,
      requiresConfirmation: decision.requiresConfirmation,
      objective,
    });
    const durationMs = Math.max(0, options.monotonicMs() - stepStartedMs);

    steps.push({
      index: steps.length,
      tool: decision.step.tool,
      actionType: tool.actionType,
      outcome: result.outcome,
      summary: result.summary,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      durationMs,
      outputBytes: result.outputBytes,
    });
    outputBytes += result.outputBytes;

    // A refusal ends the run. Continuing after the permission engine said no,
    // or after the user answered no, would be the run arguing with an answer
    // it already received.
    if (result.outcome === 'denied') {
      stopReason = 'step-denied';
      break;
    }
    if (result.outcome === 'aborted') {
      stopReason = 'step-declined';
      break;
    }
    // A *failure* is information, not a refusal: a lint script exiting
    // non-zero is exactly what the run was asked to find out. The remaining
    // steps are each separately gated anyway, and the step ceiling still
    // bounds how many of them there can be.
    if (result.outcome === 'failure') anyStepFailed = true;
  }

  if (stopReason === 'completed' && anyStepFailed) stopReason = 'step-failed';

  const verification = evaluateAgentVerification(profile, steps);
  const classified = classifyAgentRun(stopReason, verification);

  return agentRunSchema.parse({
    runId: options.runId,
    profileId: profile.id,
    profileName: profile.name,
    provider: options.provider,
    status: classified.status,
    stopReason: classified.stopReason,
    startedAt: options.startedAt,
    finishedAt: options.nowFn(),
    steps,
    verification,
    totals: {
      steps: steps.length,
      outputBytes,
      durationMs: Math.max(0, options.monotonicMs() - startMs),
    },
  } satisfies AgentRun);
}

/**
 * The sentence shown in the native dialog before a run starts.
 *
 * Built here, in the main process, from the *stored* profile — never from the
 * request — so a compromised renderer can cause the question to be asked but
 * cannot change what it says. It states every one of the milestone's
 * "clearly show active permissions and limits" items in plain text: which
 * tools, which part of the project, and the three ceilings.
 */
export function describeAgentRun(profile: AgentProfile, plannedSteps: number): string {
  const tools = describeProfileTools(profile);
  const startsProcess = tools.some((tool) => tool.commandId !== null);
  const scope = profile.approvedWorkspacePaths
    .map((path) => (path === '' ? '  the whole approved project' : `  ${path}`))
    .join('\n');

  const lines = [
    `Run the "${profile.name}" agent against the approved project?`,
    '',
    `Planned steps: ${String(plannedSteps)} (ceiling ${String(profile.limits.maxSteps)})`,
    `Time limit:    ${String(Math.round(profile.limits.maxDurationMs / 1000))}s`,
    `Output limit:  ${String(profile.limits.maxOutputBytes)} bytes`,
    '',
    'This agent may use only these tools:',
    ...tools.map((tool) => `  ${tool.label} (${tool.actionType})`),
    '',
    'Limited to these parts of the project:',
    scope,
  ];

  if (profile.verification.length > 0) {
    lines.push('', `Verification required: ${profile.verification.join(', ')}`);
  }

  lines.push(
    '',
    startsProcess
      ? 'This agent can run the project’s own scripts. Each one is confirmed separately before it starts.'
      : 'This agent cannot start a process, change a file, or create a commit.',
  );

  return lines.join('\n');
}
