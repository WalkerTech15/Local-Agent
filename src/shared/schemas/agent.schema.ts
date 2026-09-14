/**
 * Agent profile and run schemas (Phase 2, Milestone 7).
 *
 * An agent profile is **configuration that can only narrow**. This file is
 * where that sentence is made structural rather than aspirational:
 *
 *  - **A profile cannot name a capability.** `allowedTools` is an array of
 *    {@link AGENT_TOOL_IDS} members, and every one of those maps to an action
 *    type that already existed. There is no field for an action type, a
 *    command string, a path outside the project, a URL or a shell.
 *  - **A profile cannot grant.** {@link agentPermissionRuleSchema}'s
 *    `decision` is `'confirm' | 'deny'` — `'allow'` is *not a member of the
 *    enum*, so a hand-edited profile file cannot express "permit this", only
 *    "ask first" or "refuse". The global permission policy remains the only
 *    thing that can say `allow`, and the orchestrator takes the stricter of
 *    the two.
 *  - **A profile cannot carry a credential.** Every object here is a
 *    `strictObject` and no field capable of holding one is declared, so a
 *    profile document containing `apiKey`, `token` or `password` is rejected
 *    outright rather than stored and quietly ignored.
 *  - **A profile cannot be unbounded.** Instruction length, tool count,
 *    workspace count, step count, duration and output size are each capped by
 *    a named constant, and the step/duration/output ceilings are ranges, so a
 *    profile chooses a value *inside* the bound rather than supplying one.
 *  - **A stored profile cannot impersonate a built-in.** The store holds user
 *    profiles only; built-ins come from reviewed source on every load. A file
 *    claiming a built-in id, or claiming `builtIn: true`, fails validation in
 *    full — which is what stops someone from editing the shipped read-only
 *    profile into a permissive one by hand.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { z } from 'zod';

import {
  ACTION_TYPES,
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_ID_MAX_LENGTH,
  AGENT_ID_MIN_LENGTH,
  AGENT_ID_PATTERN,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MAX_ALLOWED_TOOLS,
  AGENT_MAX_DURATION_MS,
  AGENT_MAX_FALLBACK_PROVIDERS,
  AGENT_MAX_OUTPUT_BYTES,
  AGENT_MAX_PROFILES,
  AGENT_MAX_STEPS,
  AGENT_MAX_VERIFICATION_REQUIREMENTS,
  AGENT_MAX_WORKSPACE_PATHS,
  AGENT_MIN_DURATION_MS,
  AGENT_MIN_OUTPUT_BYTES,
  AGENT_MIN_STEPS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_MIN_LENGTH,
  AGENT_PROFILE_SCHEMA_VERSION,
  AGENT_RUN_MAX_RECORDED_STEPS,
  AGENT_STEP_SUMMARY_MAX_LENGTH,
  AUDIT_OUTCOMES,
  BIDI_CONTROL_PATTERN,
  CHAT_CONTROL_CHARACTER_PATTERN,
  CONTROL_CHARACTER_PATTERN,
  MODEL_PROVIDERS,
} from '../constants';
import {
  AGENT_TOOL_IDS,
  AGENT_VERIFICATION_REQUIREMENTS,
  findAgentTool,
  requirementToolId,
} from '../agent/tools';
import { WORKSPACE_ERROR_CODES } from '../workspace/errors';
import { workspaceRelativePathSchema } from './workspace.schema';

/**
 * A trimmed, single-line, control-character-free display string.
 *
 * A second, independent copy of `settings.schema.ts`'s own helper rather than
 * a shared import, for the reason `main/policy.ts` gives for duplicating
 * `containsForbiddenKey`: this module should not gain a dependency on an
 * already-reviewed schema from an earlier milestone for one small, pure,
 * self-contained check. Accented French and Vietnamese text is unaffected.
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
 * A profile identifier.
 *
 * The same shape as a permission rule id: lowercase, separator-limited, and
 * therefore incapable of carrying a path separator, a control character or a
 * bidirectional override into the audit trail or a file name.
 */
export const agentProfileIdSchema = z
  .string()
  .trim()
  .min(AGENT_ID_MIN_LENGTH)
  .max(AGENT_ID_MAX_LENGTH)
  .regex(AGENT_ID_PATTERN, {
    message: 'profile id must be lowercase alphanumeric with . _ - separators',
  });

export const agentToolIdSchema = z.enum(AGENT_TOOL_IDS);
export const agentVerificationRequirementSchema = z.enum(AGENT_VERIFICATION_REQUIREMENTS);

/**
 * What a profile may say about one of its own tools.
 *
 * Note what this enum does **not** contain. `allow` is absent, so the type
 * cannot express a grant at all — a profile can require a confirmation that
 * the global policy would not have required, or refuse a tool the global
 * policy would have permitted, and nothing else. This is the schema-level
 * half of "a profile can never grant itself a permission"; the orchestrator
 * enforces the same rule again at decision time, because a profile file is
 * user-editable and may reach the engine by some path that skipped this.
 */
export const AGENT_PROFILE_DECISIONS = ['confirm', 'deny'] as const;
export type AgentProfileDecision = (typeof AGENT_PROFILE_DECISIONS)[number];

export const agentPermissionRuleSchema = z.strictObject({
  toolId: agentToolIdSchema,
  decision: z.enum(AGENT_PROFILE_DECISIONS),
});

export type AgentPermissionRule = z.infer<typeof agentPermissionRuleSchema>;

/**
 * The three ceilings a run is held to.
 *
 * Ranges rather than free integers: a profile picks a value between a floor
 * and a cap declared in `constants.ts`, so "a run is bounded" does not depend
 * on the profile being sensible. The orchestrator checks the chosen value as
 * well — two layers, because this file is user-editable.
 */
export const agentLimitsSchema = z.strictObject({
  maxSteps: z.int().min(AGENT_MIN_STEPS).max(AGENT_MAX_STEPS),
  maxDurationMs: z.int().min(AGENT_MIN_DURATION_MS).max(AGENT_MAX_DURATION_MS),
  maxOutputBytes: z.int().min(AGENT_MIN_OUTPUT_BYTES).max(AGENT_MAX_OUTPUT_BYTES),
});

export type AgentLimits = z.infer<typeof agentLimitsSchema>;

/**
 * The fields a caller may submit when creating or updating a profile.
 *
 * Deliberately narrower than {@link agentProfileSchema}: no `builtIn` (a
 * caller may not declare itself shipped), and no `createdAt` / `updatedAt`
 * (the main process supplies the clock, exactly as it does for settings). A
 * request carrying any of those is rejected outright by `strictObject`, not
 * silently stripped.
 */
const agentProfileFieldsSchema = z.strictObject({
  id: agentProfileIdSchema,
  name: displayString(AGENT_NAME_MAX_LENGTH).refine(
    (value) => value.length >= AGENT_NAME_MIN_LENGTH,
    { message: 'profile name must not be empty' },
  ),
  description: displayString(AGENT_DESCRIPTION_MAX_LENGTH),
  /**
   * Standing instructions for the agent.
   *
   * Multi-line, so newlines and tabs are permitted where a display string
   * would reject them — {@link CHAT_CONTROL_CHARACTER_PATTERN} is the same
   * relaxation `chat.schema.ts` already applies to message content — but
   * every other control character and every bidirectional override is still
   * refused, because this text is shown to a person deciding whether to trust
   * the profile.
   *
   * **This field is never authorization.** Nothing reads a permission, a tool
   * or a path out of it; `allowedTools` and `approvedWorkspacePaths` are the
   * only things consulted, and neither is derived from this string. See
   * `docs/phase-2-agent-profiles.md`.
   */
  instructions: z
    .string()
    .max(AGENT_INSTRUCTIONS_MAX_LENGTH)
    .refine((value) => !CHAT_CONTROL_CHARACTER_PATTERN.test(value), {
      message: 'must not contain control characters other than tab and newline',
    })
    .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
      message: 'must not contain bidirectional control characters',
    }),
  /** The provider this profile prefers. An enum member, never a URL or a key. */
  provider: z.enum(MODEL_PROVIDERS),
  fallbackProviders: z.array(z.enum(MODEL_PROVIDERS)).max(AGENT_MAX_FALLBACK_PROVIDERS),
  allowedTools: z.array(agentToolIdSchema).max(AGENT_MAX_ALLOWED_TOOLS),
  /**
   * Which parts of the approved project this profile may look at.
   *
   * Project-**relative** paths, validated by the same pure rule the main
   * process applies before touching the disk, so an absolute path, a `..`
   * segment or a drive letter cannot be represented here at all. The empty
   * string means the whole approved project.
   *
   * This narrows; it never widens. The approved project itself is still
   * chosen by the user in a native picker, and `main/workspace-paths.ts`'s
   * canonical containment check still runs on every path regardless of what
   * this list says.
   */
  approvedWorkspacePaths: z.array(workspaceRelativePathSchema).max(AGENT_MAX_WORKSPACE_PATHS),
  permissionPolicy: z.array(agentPermissionRuleSchema).max(AGENT_MAX_ALLOWED_TOOLS),
  verification: z
    .array(agentVerificationRequirementSchema)
    .max(AGENT_MAX_VERIFICATION_REQUIREMENTS),
  limits: agentLimitsSchema,
  enabled: z.boolean(),
});

type AgentProfileFields = z.infer<typeof agentProfileFieldsSchema>;

/** The first value that appears twice, or `null`. */
function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/**
 * Cross-field rules shared by the submitted form and the stored form.
 *
 * Every one of these closes a way for a profile to be internally incoherent
 * in a direction that would read as permissive, as unbounded, or as stricter
 * than it actually is.
 */
function refineProfileFields(profile: AgentProfileFields, ctx: z.RefinementCtx): void {
  if (firstDuplicate(profile.allowedTools) !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['allowedTools'],
      message: 'a tool must not be listed twice',
    });
  }

  if (firstDuplicate(profile.approvedWorkspacePaths) !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['approvedWorkspacePaths'],
      message: 'a workspace path must not be listed twice',
    });
  }

  if (firstDuplicate(profile.verification) !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['verification'],
      message: 'a verification requirement must not be listed twice',
    });
  }

  if (firstDuplicate(profile.fallbackProviders) !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['fallbackProviders'],
      message: 'a fallback provider must not be listed twice',
    });
  }

  // A fallback that is the primary is not a fallback. `none` is refused
  // explicitly: it is the *absence* of a provider, so listing it as somewhere
  // to fall back to would read as a configured option while meaning
  // "give up".
  profile.fallbackProviders.forEach((provider, index) => {
    if (provider === profile.provider) {
      ctx.addIssue({
        code: 'custom',
        path: ['fallbackProviders', index],
        message: 'a fallback provider must differ from the primary provider',
      });
    }
    if (provider === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['fallbackProviders', index],
        message: 'the absence of a provider cannot be a fallback',
      });
    }
  });

  // A rule about a tool the profile does not allow is misleading: it looks
  // like a restriction while restricting nothing, and reading the profile
  // would give a false impression of how narrow it is.
  const allowed = new Set<string>(profile.allowedTools);
  const seenRule = new Set<string>();
  profile.permissionPolicy.forEach((rule, index) => {
    if (seenRule.has(rule.toolId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissionPolicy', index, 'toolId'],
        message: 'a tool must not carry two rules',
      });
    }
    seenRule.add(rule.toolId);
    if (!allowed.has(rule.toolId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissionPolicy', index, 'toolId'],
        message: 'a permission rule may only name a tool the profile allows',
      });
    }
  });

  // A requirement the profile cannot perform could never be satisfied, so
  // every run under it would end unverified. That is a configuration mistake,
  // not a stricter posture, and it is caught here rather than discovered at
  // the end of a run.
  profile.verification.forEach((requirement, index) => {
    if (!allowed.has(requirementToolId(requirement))) {
      ctx.addIssue({
        code: 'custom',
        path: ['verification', index],
        message: 'a verification requirement needs the tool that satisfies it to be allowed',
      });
    }
  });

  // Every tool requires an approved project and operates on a path inside it,
  // so a profile that allows a tool but names no scope can do nothing. Fail
  // closed is the right behaviour at run time; refusing the profile up front
  // is what stops that from looking like a bug later.
  if (profile.allowedTools.length > 0 && profile.approvedWorkspacePaths.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['approvedWorkspacePaths'],
      message: 'a profile that allows a tool must name at least one workspace path',
    });
  }

  // Defence in depth against a tool id that satisfied the enum but has no
  // definition — unreachable through the type system alone, which is exactly
  // why it is checked rather than assumed.
  profile.allowedTools.forEach((toolId, index) => {
    if (findAgentTool(toolId) === null) {
      ctx.addIssue({ code: 'custom', path: ['allowedTools', index], message: 'unknown tool' });
    }
  });
}

export const agentProfileInputSchema = agentProfileFieldsSchema.superRefine(refineProfileFields);

export type AgentProfileInput = z.infer<typeof agentProfileInputSchema>;

/**
 * A profile as it is stored and as it is shown.
 *
 * `builtIn` is derived, not declared by a caller: {@link agentProfileInputSchema}
 * has no such field, and {@link agentProfileStoreSchema} refuses a stored
 * profile that claims it.
 */
export const agentProfileSchema = agentProfileFieldsSchema
  .extend({
    builtIn: z.boolean(),
    /** `null` for a built-in, which was never created by anyone. */
    createdAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .superRefine(refineProfileFields);

export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * `agents/profiles.json`.
 *
 * Holds **user profiles only**. Built-in profiles are read from reviewed
 * source on every load and are never persisted here, so editing this file
 * cannot turn a shipped read-only profile into a permissive one — the worst a
 * hand edit can do is add a user profile, and a user profile is subject to
 * every rule above.
 */
export const agentProfileStoreSchema = z
  .strictObject({
    schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
    /** Which profile is active. Resolved against the merged registry on load. */
    activeProfileId: agentProfileIdSchema,
    profiles: z.array(agentProfileSchema).max(AGENT_MAX_PROFILES),
  })
  .superRefine((store, ctx) => {
    const seen = new Set<string>();
    store.profiles.forEach((profile, index) => {
      if (seen.has(profile.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'id'],
          message: `duplicate profile id: ${profile.id}`,
        });
      }
      seen.add(profile.id);

      if (profile.builtIn) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'builtIn'],
          message: 'a stored profile may not claim to be built in',
        });
      }
    });
  });

export type AgentProfileStore = z.infer<typeof agentProfileStoreSchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * How a run ended, as a whole.
 *
 * `denied` is kept apart from `failed` for the reason
 * `ipc-workspace-client.ts` keeps them apart: a refusal by the permission
 * engine, by the emergency stop, or by the user is not a malfunction, and
 * reporting it as one would misinform.
 */
export const AGENT_RUN_STATUSES = ['completed', 'stopped', 'denied', 'failed'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * Why a run stopped when it did.
 *
 * Every terminal condition the orchestrator can reach has a member here, so
 * "the run ended and nothing can say why" is not a representable state.
 */
export const AGENT_STOP_REASONS = [
  'completed',
  'step-limit',
  'time-limit',
  'output-limit',
  'cancelled',
  'emergency-stop',
  'tool-not-allowed',
  'workspace-not-allowed',
  'profile-denied',
  'step-denied',
  'step-declined',
  'step-failed',
  'verification-failed',
  'no-project',
  'no-steps',
] as const;
export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

export const agentRunStepSchema = z.strictObject({
  index: z.int().min(0).max(AGENT_MAX_STEPS),
  tool: agentToolIdSchema,
  /** The existing action type this step was decided as. Never a new one. */
  actionType: z.enum(ACTION_TYPES),
  outcome: z.enum(AUDIT_OUTCOMES),
  /**
   * A short, reviewed description of what the step did.
   *
   * Built by the main process from counts and fixed wording — never from a
   * file's contents, a command's output, or a path.
   */
  summary: displayString(AGENT_STEP_SUMMARY_MAX_LENGTH),
  /** The normalized workspace code when the step failed. Never a message. */
  errorCode: z.enum(WORKSPACE_ERROR_CODES).optional(),
  durationMs: z.int().min(0),
  /** How much of the run's output budget this step consumed. */
  outputBytes: z.int().min(0),
});

export type AgentRunStep = z.infer<typeof agentRunStepSchema>;

export const agentVerificationResultSchema = z.strictObject({
  required: z.array(agentVerificationRequirementSchema).max(AGENT_MAX_VERIFICATION_REQUIREMENTS),
  satisfied: z.array(agentVerificationRequirementSchema).max(AGENT_MAX_VERIFICATION_REQUIREMENTS),
  /** True only when every required item is satisfied; vacuously true when none are. */
  passed: z.boolean(),
});

export type AgentVerificationResult = z.infer<typeof agentVerificationResultSchema>;

export const agentRunSchema = z.strictObject({
  runId: z.uuid(),
  profileId: agentProfileIdSchema,
  profileName: displayString(AGENT_NAME_MAX_LENGTH),
  /**
   * Which provider the profile resolved to for this run.
   *
   * Recorded for transparency about what *would* carry a model call. No model
   * is called in this milestone — see `docs/phase-2-agent-profiles.md`.
   */
  provider: z.enum(MODEL_PROVIDERS),
  status: z.enum(AGENT_RUN_STATUSES),
  stopReason: z.enum(AGENT_STOP_REASONS),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  steps: z.array(agentRunStepSchema).max(AGENT_RUN_MAX_RECORDED_STEPS),
  verification: agentVerificationResultSchema,
  totals: z.strictObject({
    steps: z.int().min(0).max(AGENT_MAX_STEPS),
    outputBytes: z.int().min(0),
    durationMs: z.int().min(0),
  }),
});

export type AgentRun = z.infer<typeof agentRunSchema>;
