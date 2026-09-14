/**
 * Bounded agent orchestration, as pure logic (Phase 2, Milestone 7).
 *
 * This module decides **what a run would do next and when it must stop**. It
 * performs none of it: there is no I/O here, nothing is executed, and no
 * permission is granted. `main/agent-orchestrator.ts` drives this, and
 * `main/ipc.ts` is still the only place an action proposal is built.
 *
 * The reason the decision logic lives here rather than inside the runner is
 * the reason `src/shared/workspace/plan.ts` and `diff.ts` do: every limit
 * that matters — the step ceiling, the clock, the output budget, the tool
 * allowlist, the workspace scope, the emergency stop, cancellation — is then
 * testable with plain Vitest against a table of states, rather than only
 * observable by starting real processes and waiting.
 *
 * ## The order of the checks is the security property
 *
 * {@link decideNextStep} evaluates its stop conditions before it ever returns
 * a step to run, and in a fixed order: **emergency stop, cancellation, time,
 * steps, output, profile allowlist, workspace scope, profile decision.** The
 * first three are refusals the user or the system made, so they outrank the
 * budget checks; the allowlist checks come last only because they are
 * per-step. Nothing below can reorder them, and a state that satisfies more
 * than one stop condition reports the most authoritative one.
 *
 * ## What this module deliberately does not decide
 *
 * It does not decide whether an action is *permitted*. That is
 * `main/permissions.ts`'s job, unchanged, and it runs on every step after
 * this module has said the step is within the profile's own bounds. A `run`
 * decision here means "the profile does not forbid this", never "this is
 * authorized" — see {@link AgentStepDecision}.
 *
 * ## No model proposes these steps
 *
 * {@link buildAgentPlan} derives the sequence deterministically from the
 * profile and the objective. Nothing here parses model output, and no network
 * call is made. {@link AgentPlan} is the seam through which a model-proposed
 * plan would arrive in a later milestone, and it would pass through exactly
 * the same gates below — the plan is untrusted input either way, which is why
 * every step is re-checked against the profile at execution time rather than
 * once at planning time.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { agentProfileDecisionFor, isAgentToolAllowed, isWorkspacePathAllowed } from './registry';
import { AGENT_TOOLS, findAgentTool, requirementToolId } from './tools';
import type { AgentToolId, AgentVerificationRequirement } from './tools';
import { WORKSPACE_SEARCH_QUERY_MAX_LENGTH } from '../constants';
import type {
  AgentProfile,
  AgentRunStatus,
  AgentRunStep,
  AgentStopReason,
  AgentVerificationResult,
} from '../schemas/agent.schema';
import { extractObjectiveKeywords } from '../workspace/plan';

/**
 * One step a run intends to take.
 *
 * `target` is always a project-relative path, so a step cannot name a
 * location outside the approved project — the type has no shape for one.
 * `query` is present only for the search tool.
 */
export interface AgentPlanStep {
  readonly tool: AgentToolId;
  readonly target: string;
  readonly query: string | null;
}

export interface AgentPlan {
  readonly steps: readonly AgentPlanStep[];
}

/**
 * The order tools are attempted in.
 *
 * Inspect before search before plan before read-only Git before anything that
 * starts a process: the cheapest and least consequential first, so a run that
 * stops early stops having done the least.
 */
const TOOL_ORDER: readonly AgentToolId[] = [
  'workspace.inspect',
  'workspace.search',
  'workspace.plan',
  'git.status',
  'command.test',
  'command.lint',
  'command.typecheck',
];

/**
 * Derives the step sequence for one run.
 *
 * Deterministic: the same profile and the same objective always produce the
 * same steps. Bounded twice over — by the profile's own `maxSteps`, and by
 * the fact that the sequence is drawn from a fixed list of tools rather than
 * generated.
 *
 * A verification command is included **only when the profile requires it**.
 * A profile that requires nothing therefore starts no process at all, which
 * is the right default: an agent run should not run someone's test suite
 * because it could, only because the profile says a verified result depends
 * on it.
 */
export function buildAgentPlan(profile: AgentProfile, objective: string): AgentPlan {
  const steps: AgentPlanStep[] = [];
  const requiredTools = new Set<AgentToolId>(profile.verification.map(requirementToolId));
  const keyword = extractObjectiveKeywords(objective)[0] ?? null;

  for (const tool of TOOL_ORDER) {
    if (steps.length >= profile.limits.maxSteps) break;
    if (!isAgentToolAllowed(profile, tool)) continue;

    const definition = findAgentTool(tool);
    if (definition === null) continue;

    // A verification tool runs only to satisfy a stated requirement.
    if (definition.kind === 'verify' && !requiredTools.has(tool)) continue;

    if (tool === 'workspace.inspect') {
      // One inspection per approved scope, so a profile scoped to two
      // directories looks at both rather than only the first.
      for (const scope of profile.approvedWorkspacePaths) {
        if (steps.length >= profile.limits.maxSteps) break;
        steps.push({ tool, target: scope, query: null });
      }
      continue;
    }

    if (tool === 'workspace.search') {
      // Nothing searchable was extracted from the objective, so the step is
      // omitted rather than issued with an empty or invented query.
      if (keyword === null) continue;
      steps.push({
        tool,
        target: profile.approvedWorkspacePaths[0] ?? '',
        query: keyword.slice(0, WORKSPACE_SEARCH_QUERY_MAX_LENGTH),
      });
      continue;
    }

    steps.push({ tool, target: profile.approvedWorkspacePaths[0] ?? '', query: null });
  }

  return { steps };
}

/** Everything {@link decideNextStep} needs to know about a run in progress. */
export interface AgentRunProgress {
  /** How many steps have already been taken. */
  readonly completedSteps: number;
  /** Milliseconds since the run started, supplied by the caller's clock. */
  readonly elapsedMs: number;
  /** How much of the output budget has been consumed. */
  readonly outputBytes: number;
  readonly cancelled: boolean;
  readonly emergencyEngaged: boolean;
  /** True once an approved project exists. A run cannot proceed without one. */
  readonly hasProject: boolean;
}

/**
 * What the orchestrator should do next.
 *
 * A `run` decision means only that the *profile* does not forbid this step.
 * It is not authorization: `main/permissions.ts` decides that afterwards, and
 * may still deny or require a confirmation. Nothing in this module can
 * produce an authorization, which is why the type says `run` rather than
 * `allow`.
 */
export type AgentStepDecision =
  | { readonly kind: 'run'; readonly step: AgentPlanStep; readonly requiresConfirmation: boolean }
  | { readonly kind: 'stop'; readonly reason: AgentStopReason };

/**
 * The next step, or the reason the run stops here.
 *
 * The check order is fixed and is the point of this function; see the note at
 * the top of the module. Every branch that cannot prove a step is within
 * bounds returns a stop, so there is no path through this function that
 * returns `run` by falling through.
 */
export function decideNextStep(
  profile: AgentProfile,
  plan: AgentPlan,
  progress: AgentRunProgress,
): AgentStepDecision {
  // Refusals first. An engaged emergency stop outranks everything, including
  // a run that still has budget left, because the whole point of the stop is
  // that it does not wait for a natural stopping point.
  if (progress.emergencyEngaged) return { kind: 'stop', reason: 'emergency-stop' };
  if (progress.cancelled) return { kind: 'stop', reason: 'cancelled' };
  if (!progress.hasProject) return { kind: 'stop', reason: 'no-project' };

  // A disabled profile cannot run at all, even if it was enabled when the run
  // started — the store is re-read between steps, so disabling a profile
  // mid-run takes effect on the next one.
  if (!profile.enabled) return { kind: 'stop', reason: 'profile-denied' };

  // Budgets. Checked before the step is chosen, so exceeding one never
  // executes "just one more".
  if (progress.elapsedMs >= profile.limits.maxDurationMs) {
    return { kind: 'stop', reason: 'time-limit' };
  }
  if (progress.completedSteps >= profile.limits.maxSteps) {
    return { kind: 'stop', reason: 'step-limit' };
  }
  if (progress.outputBytes >= profile.limits.maxOutputBytes) {
    return { kind: 'stop', reason: 'output-limit' };
  }

  if (plan.steps.length === 0) return { kind: 'stop', reason: 'no-steps' };
  if (progress.completedSteps >= plan.steps.length) return { kind: 'stop', reason: 'completed' };

  const step = plan.steps[progress.completedSteps];
  if (step === undefined) return { kind: 'stop', reason: 'completed' };

  // Re-checked here rather than trusted from planning time. The plan is
  // untrusted input — today because a user-editable profile shaped it, and in
  // a later milestone because a model proposed it.
  if (!isAgentToolAllowed(profile, step.tool)) {
    return { kind: 'stop', reason: 'tool-not-allowed' };
  }
  if (!isWorkspacePathAllowed(profile, step.target)) {
    return { kind: 'stop', reason: 'workspace-not-allowed' };
  }

  const profileDecision = agentProfileDecisionFor(profile, step.tool);
  if (profileDecision === 'deny') return { kind: 'stop', reason: 'profile-denied' };

  const definition = findAgentTool(step.tool);
  if (definition === null) return { kind: 'stop', reason: 'tool-not-allowed' };

  return {
    kind: 'run',
    step,
    // The profile may *raise* a step to requiring confirmation. It can never
    // lower one: an action already on the confirmation floor stays there
    // whatever the profile says, because this flag is only ever an input to
    // the pipeline, never a way around it.
    requiresConfirmation: profileDecision === 'confirm',
  };
}

/**
 * Which verification requirements the completed steps actually satisfied.
 *
 * A requirement is satisfied only by its own tool completing with
 * `outcome: 'success'`. A denied step, a declined confirmation, a failed
 * command and a step that never ran are all equally unsatisfying — this
 * function has no notion of "close enough", and nothing here can be satisfied
 * by an assertion that the work was done.
 *
 * `passed` is vacuously true when a profile requires nothing. That is
 * deliberate: "this profile does not define verification" is a different
 * statement from "verification failed", and conflating them would report
 * every read-only run as a failure.
 */
export function evaluateAgentVerification(
  profile: AgentProfile,
  steps: readonly AgentRunStep[],
): AgentVerificationResult {
  const succeeded = new Set<string>(
    steps.filter((step) => step.outcome === 'success').map((step) => step.tool),
  );

  const required = [...profile.verification];
  const satisfied = required.filter((requirement) => succeeded.has(requirementToolId(requirement)));

  return {
    required,
    satisfied,
    passed: satisfied.length === required.length,
  };
}

/**
 * The overall status implied by how a run stopped.
 *
 * Kept as one mapping rather than assembled at each call site so that a new
 * stop reason cannot quietly default to `completed` — the exhaustive record
 * below stops compiling until the new reason is classified.
 */
const STATUS_BY_STOP_REASON: Readonly<Record<AgentStopReason, AgentRunStatus>> = {
  completed: 'completed',
  'step-limit': 'stopped',
  'time-limit': 'stopped',
  'output-limit': 'stopped',
  cancelled: 'stopped',
  'emergency-stop': 'denied',
  'tool-not-allowed': 'denied',
  'workspace-not-allowed': 'denied',
  'profile-denied': 'denied',
  'step-denied': 'denied',
  'step-declined': 'denied',
  'step-failed': 'failed',
  'verification-failed': 'failed',
  'no-project': 'failed',
  'no-steps': 'completed',
};

/**
 * Classifies a finished run.
 *
 * A run that reached the end of its plan but did not satisfy its stated
 * verification is **not** a success: it is reported as `failed` with
 * `verification-failed`, so "the steps ran" is never mistaken for "the work
 * is verified".
 */
export function classifyAgentRun(
  stopReason: AgentStopReason,
  verification: AgentVerificationResult,
): { readonly status: AgentRunStatus; readonly stopReason: AgentStopReason } {
  if (stopReason === 'completed' && !verification.passed) {
    return { status: 'failed', stopReason: 'verification-failed' };
  }
  return { status: STATUS_BY_STOP_REASON[stopReason], stopReason };
}

/**
 * Every tool this profile permits, as full definitions.
 *
 * Used by the interface to show what an agent may reach for, and by the
 * confirmation dialog to state it before a run starts. Derived from the
 * registry rather than from the profile's own strings, so what is displayed
 * is what the code will actually consult.
 */
export function describeProfileTools(profile: AgentProfile) {
  return AGENT_TOOLS.filter((tool) => isAgentToolAllowed(profile, tool.id));
}

/** True when any tool this profile permits can start a process. */
export function profileCanRunCommands(profile: AgentProfile): boolean {
  return describeProfileTools(profile).some((tool) => tool.commandId !== null);
}

/** The verification requirements this profile states, in registry order. */
export function profileVerificationRequirements(
  profile: AgentProfile,
): readonly AgentVerificationRequirement[] {
  return profile.verification;
}
