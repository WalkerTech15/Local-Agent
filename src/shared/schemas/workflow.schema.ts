/**
 * Workflow definition and run schemas (Phase 2, Milestone 9).
 *
 * A workflow is **a saved recipe for running an agent profile that already
 * exists**, and this file is where that sentence is made structural rather
 * than aspirational:
 *
 *  - **A workflow cannot name a capability.** Every step's `tool` is an
 *    {@link AGENT_TOOL_IDS} member — the fixed Milestone 7 registry — and
 *    each of those maps to an action type Milestones 5 and 6 already defined.
 *    There is no field for an action type, a command string, an argument, a
 *    shell, an absolute path or a URL.
 *  - **A workflow cannot widen an agent.** It selects an agent profile by id
 *    and may only use tools and paths that profile already allows. That is
 *    checked when the workflow is saved *and* again before every step, since
 *    a profile can be narrowed after a workflow was written.
 *  - **A workflow cannot start itself.** `trigger` is an enum with one
 *    member, `manual`. A schedule, a file watch, a Git hook and an inbox are
 *    not disabled anywhere — they are not representable.
 *  - **A workflow cannot loop without bound.** Retries are capped per step,
 *    and every attempt counts against `limits.maxSteps`, so the total number
 *    of executions is bounded by a number the schema itself constrains.
 *  - **A workflow cannot carry a credential.** Every object here is a
 *    `strictObject` and no field capable of holding one is declared, so a
 *    document containing `apiKey`, `token` or `password` is rejected outright
 *    rather than stored and quietly ignored.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { z } from 'zod';

import {
  ACTION_TYPES,
  AGENT_MAX_VERIFICATION_REQUIREMENTS,
  AUDIT_OUTCOMES,
  BIDI_CONTROL_PATTERN,
  CONTROL_CHARACTER_PATTERN,
  MODEL_PROVIDERS,
  WORKFLOW_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_ID_MAX_LENGTH,
  WORKFLOW_ID_MIN_LENGTH,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_MAX_DEFINITION_STEPS,
  WORKFLOW_MAX_DURATION_MS,
  WORKFLOW_MAX_OUTPUT_BYTES,
  WORKFLOW_MAX_STEP_RETRIES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_WORKFLOWS,
  WORKFLOW_MIN_DURATION_MS,
  WORKFLOW_MIN_OUTPUT_BYTES,
  WORKFLOW_MIN_STEPS,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_NAME_MIN_LENGTH,
  WORKFLOW_ROLLBACK_MODES,
  WORKFLOW_RUN_MAX_RECORDED_STEPS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STEP_CONDITIONS,
  WORKFLOW_STEP_SUMMARY_MAX_LENGTH,
  WORKFLOW_FAILURE_BEHAVIORS,
  WORKFLOW_TRIGGERS,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MIN_LENGTH,
} from '../constants';
import { AGENT_TOOL_IDS, findAgentTool, requirementToolId } from '../agent/tools';
import { agentProfileIdSchema, agentVerificationRequirementSchema } from './agent.schema';
import { WORKSPACE_ERROR_CODES } from '../workspace/errors';
import { workspaceRelativePathSchema } from './workspace.schema';

/**
 * A trimmed, single-line, control-character-free display string.
 *
 * An independent copy of the helper `settings.schema.ts` and
 * `agent.schema.ts` each hold, for the reason `main/policy.ts` gives for
 * duplicating `containsForbiddenKey`: this module should not gain a
 * dependency on an already-reviewed schema from an earlier milestone for one
 * small, pure, self-contained check. Accented French and Vietnamese text is
 * unaffected.
 */
const displayString = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
      message: 'must not contain control characters',
    })
    .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
      message: 'must not contain bidirectional control characters',
    });

/**
 * A workflow identifier.
 *
 * The same shape as an agent profile id: lowercase, separator-limited, and
 * therefore incapable of carrying a path separator, a control character or a
 * bidirectional override into the audit trail or a file name.
 */
export const workflowIdSchema = z
  .string()
  .trim()
  .min(WORKFLOW_ID_MIN_LENGTH)
  .max(WORKFLOW_ID_MAX_LENGTH)
  .regex(WORKFLOW_ID_PATTERN, {
    message: 'workflow id must be lowercase alphanumeric with . _ - separators',
  });

export const workflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS);
export const workflowStepConditionSchema = z.enum(WORKFLOW_STEP_CONDITIONS);
export const workflowFailureBehaviorSchema = z.enum(WORKFLOW_FAILURE_BEHAVIORS);
export const workflowRollbackModeSchema = z.enum(WORKFLOW_ROLLBACK_MODES);

export type WorkflowTriggerValue = z.infer<typeof workflowTriggerSchema>;
export type WorkflowStepConditionValue = z.infer<typeof workflowStepConditionSchema>;
export type WorkflowFailureBehaviorValue = z.infer<typeof workflowFailureBehaviorSchema>;
export type WorkflowRollbackMode = z.infer<typeof workflowRollbackModeSchema>;

/**
 * One ordered step.
 *
 * `tool` is an agent tool id and nothing else; `target` is a
 * project-**relative** path validated by the same pure rule the main process
 * applies before touching the disk, so an absolute path, a `..` segment or a
 * drive letter cannot be represented here at all. The empty string means the
 * whole approved project.
 */
export const workflowStepSchema = z
  .strictObject({
    tool: z.enum(AGENT_TOOL_IDS),
    target: workspaceRelativePathSchema,
    /**
     * The search term, for the one tool that takes one. `null` for every
     * other tool — a step carrying a query it cannot use would read as doing
     * something it does not do.
     */
    query: z
      .string()
      .trim()
      .min(WORKSPACE_SEARCH_QUERY_MIN_LENGTH)
      .max(WORKSPACE_SEARCH_QUERY_MAX_LENGTH)
      .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
        message: 'must not contain control characters',
      })
      .nullable(),
    condition: workflowStepConditionSchema,
    /**
     * How many times this step may be retried after a failure.
     *
     * Bounded here, and bounded again by `limits.maxSteps`, because every
     * attempt counts as a step. There is no combination of values that
     * produces an unbounded loop.
     */
    maxRetries: z.int().min(0).max(WORKFLOW_MAX_STEP_RETRIES),
    /**
     * A confirmation checkpoint: the user is asked, natively, before this
     * step is proposed at all.
     *
     * This only ever *adds* a prompt. It cannot remove one the confirmation
     * floor requires, and it cannot turn a denial into a permission.
     */
    checkpoint: z.boolean(),
  })
  .superRefine((step, ctx) => {
    const definition = findAgentTool(step.tool);
    if (definition === null) {
      // Defence in depth against a tool id that satisfied the enum but has no
      // definition — unreachable through the type system alone, which is
      // exactly why it is checked rather than assumed.
      ctx.addIssue({ code: 'custom', path: ['tool'], message: 'unknown tool' });
      return;
    }

    const needsQuery = step.tool === 'workspace.search';
    if (needsQuery && step.query === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'a search step must carry the term to search for',
      });
    }
    if (!needsQuery && step.query !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'only a search step may carry a query',
      });
    }
  });

export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/**
 * The three ceilings a run is held to.
 *
 * Ranges rather than free integers, exactly as an agent profile's are: a
 * workflow picks a value between a floor and a cap declared in
 * `constants.ts`, so "a run is bounded" does not depend on the definition
 * being sensible. The runner enforces the chosen value as well — two layers,
 * because this file is user-editable.
 */
export const workflowLimitsSchema = z.strictObject({
  maxSteps: z.int().min(WORKFLOW_MIN_STEPS).max(WORKFLOW_MAX_STEPS),
  maxDurationMs: z.int().min(WORKFLOW_MIN_DURATION_MS).max(WORKFLOW_MAX_DURATION_MS),
  maxOutputBytes: z.int().min(WORKFLOW_MIN_OUTPUT_BYTES).max(WORKFLOW_MAX_OUTPUT_BYTES),
});

export type WorkflowLimits = z.infer<typeof workflowLimitsSchema>;

/**
 * What has to be true for a run to count as a success.
 *
 * `verification` reuses the Milestone 7 vocabulary, and therefore inherits
 * its one important property: a requirement is satisfied only by its own tool
 * completing successfully, and by nothing else — in particular, not by a
 * model asserting that it did.
 */
export const workflowSuccessCriteriaSchema = z.strictObject({
  verification: z
    .array(agentVerificationRequirementSchema)
    .max(AGENT_MAX_VERIFICATION_REQUIREMENTS),
  /** When true, any failed step makes the run a failure, verified or not. */
  requireAllStepsSucceed: z.boolean(),
});

export type WorkflowSuccessCriteria = z.infer<typeof workflowSuccessCriteriaSchema>;

/**
 * The fields a caller may submit when creating or updating a workflow.
 *
 * Deliberately narrower than {@link workflowSchema}: no `createdAt` and no
 * `updatedAt` — the main process supplies the clock, exactly as it does for
 * settings, agent profiles and memory. A request carrying either is rejected
 * outright by `strictObject`, not silently stripped.
 */
const workflowFieldsSchema = z.strictObject({
  id: workflowIdSchema,
  name: displayString(WORKFLOW_NAME_MAX_LENGTH).refine(
    (value) => value.length >= WORKFLOW_NAME_MIN_LENGTH,
    { message: 'workflow name must not be empty' },
  ),
  description: displayString(WORKFLOW_DESCRIPTION_MAX_LENGTH),
  trigger: workflowTriggerSchema,
  /** The agent profile whose allowlists are this workflow's ceiling. */
  agentProfileId: agentProfileIdSchema,
  steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_MAX_DEFINITION_STEPS),
  limits: workflowLimitsSchema,
  failureBehavior: workflowFailureBehaviorSchema,
  rollback: workflowRollbackModeSchema,
  successCriteria: workflowSuccessCriteriaSchema,
  enabled: z.boolean(),
});

type WorkflowFields = z.infer<typeof workflowFieldsSchema>;

/**
 * Cross-field rules.
 *
 * Each one closes a way for a definition to be internally incoherent in a
 * direction that would read as workable while being unrunnable, or as
 * stricter than it is.
 */
function refineWorkflowFields(workflow: WorkflowFields, ctx: z.RefinementCtx): void {
  // A ceiling below the number of declared steps means the run stops before
  // the last step every single time. That is a definition that can never do
  // what it says, and it is caught here rather than discovered at the end of
  // a run.
  if (workflow.limits.maxSteps < workflow.steps.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['limits', 'maxSteps'],
      message: 'the step ceiling must be at least the number of declared steps',
    });
  }

  // There is no previous step before the first one, so a condition about it
  // could never be evaluated honestly.
  const first = workflow.steps[0];
  if (first !== undefined && first.condition !== 'always') {
    ctx.addIssue({
      code: 'custom',
      path: ['steps', 0, 'condition'],
      message: 'the first step has no previous step, so it must run always',
    });
  }

  const seenRequirement = new Set<string>();
  const declaredTools = new Set<string>(workflow.steps.map((step) => step.tool));

  workflow.successCriteria.verification.forEach((requirement, index) => {
    if (seenRequirement.has(requirement)) {
      ctx.addIssue({
        code: 'custom',
        path: ['successCriteria', 'verification', index],
        message: 'a requirement must not be listed twice',
      });
    }
    seenRequirement.add(requirement);

    // A requirement no step can satisfy would leave every run unverified.
    // That is a configuration mistake, not a stricter posture.
    if (!declaredTools.has(requirementToolId(requirement))) {
      ctx.addIssue({
        code: 'custom',
        path: ['successCriteria', 'verification', index],
        message: 'no step in this workflow runs the tool that satisfies this requirement',
      });
    }
  });
}

export const workflowInputSchema = workflowFieldsSchema.superRefine(refineWorkflowFields);

export type WorkflowInput = z.infer<typeof workflowInputSchema>;

/** A workflow as it is stored and as it is shown. */
export const workflowSchema = workflowFieldsSchema
  .extend({
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine(refineWorkflowFields);

export type Workflow = z.infer<typeof workflowSchema>;

/**
 * `workflows/workflows.json`.
 *
 * There are no built-in workflows: every definition here was written by the
 * user, so unlike the agent profile store this file is the whole list rather
 * than the user-supplied half of one.
 */
export const workflowStoreSchema = z
  .strictObject({
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    workflows: z.array(workflowSchema).max(WORKFLOW_MAX_WORKFLOWS),
  })
  .superRefine((store, ctx) => {
    const seen = new Set<string>();
    store.workflows.forEach((workflow, index) => {
      if (seen.has(workflow.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['workflows', index, 'id'],
          message: `duplicate workflow id: ${workflow.id}`,
        });
      }
      seen.add(workflow.id);
    });
  });

export type WorkflowStore = z.infer<typeof workflowStoreSchema>;

/** An empty store. Used on first launch and on every load failure. */
export function createEmptyWorkflowStore(): WorkflowStore {
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflows: [] };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * How a run ended, as a whole.
 *
 * `denied` is kept apart from `failed` for the reason the agent run statuses
 * keep them apart: a refusal by the permission engine, by the emergency stop,
 * or by the user is not a malfunction, and reporting it as one would
 * misinform.
 */
export const WORKFLOW_RUN_STATUSES = ['completed', 'stopped', 'denied', 'failed'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/**
 * Why a run stopped when it did.
 *
 * Every terminal condition the runner can reach has a member here, so "the
 * run ended and nothing can say why" is not a representable state.
 */
export const WORKFLOW_STOP_REASONS = [
  'completed',
  'step-limit',
  'time-limit',
  'output-limit',
  'retries-exhausted',
  'cancelled',
  'paused',
  'emergency-stop',
  'workflow-disabled',
  'agent-denied',
  'tool-not-allowed',
  'workspace-not-allowed',
  'step-denied',
  'step-declined',
  'step-failed',
  'criteria-not-met',
  'no-project',
  'no-steps',
] as const;
export type WorkflowStopReason = (typeof WORKFLOW_STOP_REASONS)[number];

export const workflowRunStepSchema = z.strictObject({
  /** Position in the execution record, counting every attempt. */
  index: z.int().min(0).max(WORKFLOW_MAX_STEPS),
  /** Which declared step this was an execution of. */
  stepIndex: z.int().min(0).max(WORKFLOW_MAX_DEFINITION_STEPS),
  /** 1 for the first try, 2 for the first retry, and so on. */
  attempt: z
    .int()
    .min(1)
    .max(WORKFLOW_MAX_STEP_RETRIES + 1),
  tool: z.enum(AGENT_TOOL_IDS),
  /** The existing action type this step was decided as. Never a new one. */
  actionType: z.enum(ACTION_TYPES),
  outcome: z.enum(AUDIT_OUTCOMES),
  /**
   * A short, reviewed description of what the step did.
   *
   * Built by the main process from counts and fixed wording — never from a
   * file's contents, a command's output, or a path.
   */
  summary: displayString(WORKFLOW_STEP_SUMMARY_MAX_LENGTH),
  /** The normalized workspace code when the step failed. Never a message. */
  errorCode: z.enum(WORKSPACE_ERROR_CODES).optional(),
  durationMs: z.int().min(0),
  outputBytes: z.int().min(0),
});

export type WorkflowRunStep = z.infer<typeof workflowRunStepSchema>;

/**
 * Why a rollback did or did not happen.
 *
 * `nothing-to-roll-back` is the honest answer in this milestone and is
 * reported rather than hidden: no agent tool can write a file, so a run
 * cannot produce a change set to restore. See `docs/phase-2-workflows.md`.
 */
export const WORKFLOW_ROLLBACK_RESULTS = [
  'not-configured',
  'not-required',
  'nothing-to-roll-back',
  'restored',
] as const;
export type WorkflowRollbackResult = (typeof WORKFLOW_ROLLBACK_RESULTS)[number];

export const workflowRollbackOutcomeSchema = z.strictObject({
  mode: workflowRollbackModeSchema,
  result: z.enum(WORKFLOW_ROLLBACK_RESULTS),
  /** How many change sets were restored. Always 0 unless `result` is `restored`. */
  restored: z.int().min(0).max(WORKFLOW_MAX_STEPS),
});

export type WorkflowRollbackOutcome = z.infer<typeof workflowRollbackOutcomeSchema>;

export const workflowVerificationResultSchema = z.strictObject({
  required: z.array(agentVerificationRequirementSchema).max(AGENT_MAX_VERIFICATION_REQUIREMENTS),
  satisfied: z.array(agentVerificationRequirementSchema).max(AGENT_MAX_VERIFICATION_REQUIREMENTS),
  /** True only when every required item is satisfied; vacuously true when none are. */
  passed: z.boolean(),
});

export type WorkflowVerificationResult = z.infer<typeof workflowVerificationResultSchema>;

export const workflowRunSchema = z.strictObject({
  runId: z.uuid(),
  workflowId: workflowIdSchema,
  workflowName: displayString(WORKFLOW_NAME_MAX_LENGTH),
  agentProfileId: agentProfileIdSchema,
  /**
   * Which provider the selected agent resolved to for this run.
   *
   * Recorded for transparency about what *would* carry a model call. No model
   * is called in this milestone — see `docs/phase-2-workflows.md`.
   */
  provider: z.enum(MODEL_PROVIDERS),
  status: z.enum(WORKFLOW_RUN_STATUSES),
  stopReason: z.enum(WORKFLOW_STOP_REASONS),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  steps: z.array(workflowRunStepSchema).max(WORKFLOW_RUN_MAX_RECORDED_STEPS),
  verification: workflowVerificationResultSchema,
  rollback: workflowRollbackOutcomeSchema,
  totals: z.strictObject({
    steps: z.int().min(0).max(WORKFLOW_MAX_STEPS),
    outputBytes: z.int().min(0),
    durationMs: z.int().min(0),
  }),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * What a progress event says about a run in flight.
 *
 * Deliberately a bounded, content-free shape: counts, an index, a tool id and
 * an outcome. There is no field for a summary, a path, a command line or any
 * output, because this is an **advisory** event pushed to the renderer while
 * the authoritative record is still being built — and an advisory channel is
 * the wrong place to be the first thing that carries content.
 */
export const WORKFLOW_PROGRESS_PHASES = [
  'started',
  'step-started',
  'awaiting-confirmation',
  'step-finished',
  'finished',
] as const;
export type WorkflowProgressPhase = (typeof WORKFLOW_PROGRESS_PHASES)[number];

export const workflowProgressEventSchema = z.strictObject({
  runId: z.uuid(),
  phase: z.enum(WORKFLOW_PROGRESS_PHASES),
  /** Which declared step, or `null` for the run-level phases. */
  stepIndex: z.int().min(0).max(WORKFLOW_MAX_DEFINITION_STEPS).nullable(),
  attempt: z
    .int()
    .min(0)
    .max(WORKFLOW_MAX_STEP_RETRIES + 1),
  tool: z.enum(AGENT_TOOL_IDS).nullable(),
  /** How many declared steps this run has. */
  totalSteps: z.int().min(0).max(WORKFLOW_MAX_DEFINITION_STEPS),
  /** How many executions have finished, counting every attempt. */
  completedSteps: z.int().min(0).max(WORKFLOW_MAX_STEPS),
  outcome: z.enum(AUDIT_OUTCOMES).nullable(),
});

export type WorkflowProgressEvent = z.infer<typeof workflowProgressEventSchema>;
