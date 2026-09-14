/**
 * IPC channel contracts for Local Agent.
 *
 * Every channel the preload bridge is allowed to call is named here as an
 * explicit constant — never a string literal duplicated in `main` and
 * `preload` — and paired with a schema for its request and its response.
 * `main/ipc` validates both directions before a handler runs and before a
 * result crosses back into the renderer, so a malformed call or a
 * malformed result fails loudly instead of reaching untrusted code.
 *
 * Milestone 2 established exactly one channel: a liveness check with no
 * useful payload, to prove the request path end to end — preload → main →
 * validated response → renderer — before any privileged channel existed.
 * Milestone 7 adds the first privileged channels: non-secret settings
 * (read/update) and the encrypted secret store (status/write/clear). Every
 * one of them is routed through `main/action-pipeline.ts`'s
 * `handleActionProposal` — the same permission engine, confirmation floor,
 * emergency-stop gate and audit log every other action type uses — so none of
 * these schemas grant authority on their own; they only describe shape.
 *
 * Two properties hold for every channel below, by construction:
 *
 *  - **No plaintext secret ever appears in a request or response schema.**
 *    `secretsWriteRequestSchema` accepts a plaintext `apiKey` — the one
 *    necessary exception, since the renderer is the only place a user can
 *    type one — and every other schema here, including every response,
 *    carries only non-secret settings fields or the boolean-shaped
 *    {@link secretStatusResultSchema}. There is no schema anywhere in this
 *    file for reading a key back out.
 *  - **Every response carries `outcome`.** A privileged action can be denied
 *    by policy, blocked by the emergency stop, aborted by a rejected
 *    confirmation, or fail outright — the renderer must be able to tell those
 *    apart from a success rather than receiving a value only on the happy
 *    path and nothing otherwise.
 */

import { z } from 'zod';

import { CHAT_PROVIDER_ERROR_CODES } from '../chat/provider';
import {
  AGENT_MAX_PROFILES,
  API_KEY_MAX_LENGTH,
  API_KEY_MIN_LENGTH,
  AUDIT_OUTCOMES,
  CHAT_CONVERSATION_MAX_MESSAGES,
  CONTROL_CHARACTER_PATTERN,
  WORKSPACE_MAX_CHANGE_FILES,
} from '../constants';
import { AGENT_ERROR_CODES } from '../agent/errors';
import {
  agentProfileIdSchema,
  agentProfileInputSchema,
  agentProfileSchema,
  agentRunSchema,
} from './agent.schema';
import {
  commandCatalogSchema,
  commandIdSchema,
  commandRunResultSchema,
  gitCheckpointSchema,
  gitDiffSchema,
  gitStatusSchema,
  workspaceChangeHistorySchema,
  workspaceChangeIdSchema,
  workspaceChangeSetSchema,
  workspaceEditSchema,
} from './coding.schema';
import { chatContentSchema, chatMessageSchema, chatStreamDeltaSchema } from './chat.schema';
import { MEMORY_ERROR_CODES } from '../memory/errors';
import {
  memoryMutationSummarySchema,
  memoryQueryResultSchema,
  memoryRecordInputSchema,
  memoryRecordSchema,
  memoryRetrievalResultSchema,
  memoryScopeSchema,
  memorySearchQuerySchema,
} from './memory.schema';
import {
  codingPlanSchema,
  workspaceEntryPathSchema,
  workspaceFileSchema,
  workspaceObjectiveSchema,
  workspaceProjectSummarySchema,
  workspaceRelativePathSchema,
  workspaceSearchQuerySchema,
  workspaceSearchResultSchema,
  workspaceTreeSchema,
} from './workspace.schema';
import { WORKSPACE_ERROR_CODES } from '../workspace/errors';
import {
  assistantSettingsSchema,
  languageSettingsSchema,
  modelProviderInputSchema,
  settingsSchema,
  userSettingsSchema,
} from './settings.schema';

/** The only IPC channel Milestone 2 registers. */
export const IPC_HEALTH_CHANNEL = 'app:health';

/**
 * The health check takes no arguments. Validating this explicitly, rather
 * than assuming an empty call, means an unexpected extra argument — from a
 * future bug or a tampered call — is rejected instead of silently ignored.
 */
export const healthCheckRequestSchema = z.tuple([]);

export const healthCheckResponseSchema = z.strictObject({
  status: z.literal('ok'),
});

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;

// ---------------------------------------------------------------------------
// Settings: settings.read / settings.write
// ---------------------------------------------------------------------------

export const IPC_SETTINGS_GET_CHANNEL = 'settings:get';
export const IPC_SETTINGS_UPDATE_CHANNEL = 'settings:update';

export const settingsGetRequestSchema = z.tuple([]);

/**
 * What a caller may set through `settings:update`. Deliberately narrower than
 * {@link settingsSchema}: no `schemaVersion` (fixed), no `updatedAt` (the main
 * process supplies the clock), no `telemetry` (hard-pinned in Phase 1), and no
 * `hasApiKey` (server-computed — see {@link modelProviderInputSchema}). A
 * request carrying any of those extra fields is rejected outright by
 * `strictObject`, not silently stripped.
 */
export const settingsUpdateRequestSchema = z.tuple([
  z.strictObject({
    onboardingCompleted: z.boolean(),
    assistant: assistantSettingsSchema,
    user: userSettingsSchema,
    language: languageSettingsSchema,
    modelProvider: modelProviderInputSchema,
  }),
]);

export type SettingsUpdateInput = z.infer<typeof settingsUpdateRequestSchema>[0];

/**
 * Shared response shape for both settings channels: the outcome of the
 * underlying `settings.read` / `settings.write` action, the resulting
 * (already `hasApiKey`-reconciled) settings on success, and a stable error
 * code — never a raw error message — on failure. `settings` and `errorCode`
 * are mutually exclusive in practice but both declared optional rather than
 * a discriminated union, matching `ActionResult`'s own shape.
 */
export const settingsActionResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  settings: settingsSchema.optional(),
  errorCode: z.string().max(64).optional(),
});

export const settingsGetResponseSchema = settingsActionResponseSchema;
export const settingsUpdateResponseSchema = settingsActionResponseSchema;

export type SettingsActionResponse = z.infer<typeof settingsActionResponseSchema>;

// ---------------------------------------------------------------------------
// Secrets: secrets.status / secrets.write / secrets.clear
//
// No channel here can return a plaintext key. `secretStatusResultSchema` is
// the only secret-adjacent value ever sent to the renderer: whether a key is
// present, never what it is. There is deliberately no "get key" channel.
// ---------------------------------------------------------------------------

export const IPC_SECRETS_STATUS_CHANNEL = 'secrets:status';
export const IPC_SECRETS_WRITE_CHANNEL = 'secrets:write';
export const IPC_SECRETS_CLEAR_CHANNEL = 'secrets:clear';

export const secretsStatusRequestSchema = z.tuple([]);
export const secretsClearRequestSchema = z.tuple([]);

/**
 * The plaintext key never leaves this one request schema. Bounded, and never
 * trimmed — see {@link API_KEY_MAX_LENGTH}'s doc comment for why mutating a
 * credential the user typed would be unsafe. Control characters are rejected:
 * a real bearer token or API key is never legitimately multi-line.
 */
export const secretsWriteRequestSchema = z.tuple([
  z.strictObject({
    apiKey: z
      .string()
      .min(API_KEY_MIN_LENGTH)
      .max(API_KEY_MAX_LENGTH)
      .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
        message: 'must not contain control characters',
      }),
  }),
]);

export const secretStatusResultSchema = z.strictObject({
  present: z.boolean(),
});

export type SecretStatusResult = z.infer<typeof secretStatusResultSchema>;

/** Shared response shape for all three secret channels. */
export const secretsActionResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  status: secretStatusResultSchema.optional(),
  errorCode: z.string().max(64).optional(),
});

export const secretsStatusResponseSchema = secretsActionResponseSchema;
export const secretsWriteResponseSchema = secretsActionResponseSchema;
export const secretsClearResponseSchema = secretsActionResponseSchema;

export type SecretsActionResponse = z.infer<typeof secretsActionResponseSchema>;

// ---------------------------------------------------------------------------
// Chat: chat.send (Phase 2, Milestone 3)
//
// The one network-capable action in this codebase. `chat:send` routes
// through the same `handleActionProposal` pipeline as every channel above —
// see `main/ipc.ts` — so a real provider call is permission-gated,
// emergency-stop-gated and audited exactly like `secrets.write` is, never
// reached directly from this IPC handler. `chat:cancel` has no side effect
// of its own: it only asks the main process to abort a `chat:send` call
// already in flight and already authorized, so it is not routed through the
// permission engine — see `main/ipc.ts`'s handler for the reasoning.
//
// Neither request schema below accepts an API key, a header, or a provider
// URL: the request carries only the conversation itself. `main/ipc.ts`
// resolves which provider to call, and with which stored credential, from
// settings and the encrypted secret store — never from renderer input.
// ---------------------------------------------------------------------------

export const IPC_CHAT_SEND_CHANNEL = 'chat:send';
export const IPC_CHAT_CANCEL_CHANNEL = 'chat:cancel';

export const chatSendRequestSchema = z.tuple([
  z.strictObject({
    /** Correlates a later `chat:cancel` call to this specific in-flight request. */
    requestId: z.uuid(),
    messages: z.array(chatMessageSchema).max(CHAT_CONVERSATION_MAX_MESSAGES),
  }),
]);

export type ChatSendRequestInput = z.infer<typeof chatSendRequestSchema>[0];

/**
 * `content` is present only on `outcome: 'success'`; `errorCode` is present
 * only otherwise, and is always one of {@link CHAT_PROVIDER_ERROR_CODES} —
 * the same normalized vocabulary `ChatProvider` implementations already
 * throw, reused rather than re-invented at this boundary. Never a raw
 * provider error message, a URL, a header, or a credential.
 */
export const chatSendResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  content: chatContentSchema.optional(),
  errorCode: z.enum(CHAT_PROVIDER_ERROR_CODES).optional(),
});

export type ChatSendResponse = z.infer<typeof chatSendResponseSchema>;

export const chatCancelRequestSchema = z.tuple([
  z.strictObject({
    requestId: z.uuid(),
  }),
]);

/**
 * Always `{ acknowledged: true }`. Cancellation is best-effort and
 * idempotent — asking to cancel a request that already finished, or one that
 * never existed, is not an error; there is simply nothing left to abort.
 */
export const chatCancelResponseSchema = z.strictObject({
  acknowledged: z.literal(true),
});

export type ChatCancelResponse = z.infer<typeof chatCancelResponseSchema>;

/**
 * The one main → renderer push channel in this codebase (Phase 2, Milestone
 * 4), carrying streaming previews for an in-flight `chat:send`.
 *
 * Deliberately narrow, in every dimension:
 *
 *  - **One direction, one purpose.** The renderer can only listen; there is
 *    no request it can make on this channel and no reply it can send back.
 *  - **Correlated.** `requestId` matches the `chat:send` call this delta
 *    belongs to, so a listener discards anything that is not its own
 *    request rather than trusting whatever arrives.
 *  - **Bounded and content-safe.** `delta` is {@link chatStreamDeltaSchema}:
 *    short, control-character-free, bidi-free. A larger fragment is split by
 *    the sender into several events rather than sent whole.
 *  - **Advisory.** A delta is a preview to render, never a message to
 *    commit. The authoritative reply is still the one `chat:send` resolves
 *    with, validated as a whole. Dropping every event on this channel would
 *    cost the live preview and change nothing about the final conversation.
 *
 * Validated by `main/ipc.ts` before it is sent and again by
 * `src/preload/index.ts` before any renderer listener sees it.
 */
export const IPC_CHAT_CHUNK_CHANNEL = 'chat:chunk';

export const chatChunkEventSchema = z.strictObject({
  requestId: z.uuid(),
  delta: chatStreamDeltaSchema,
});

export type ChatChunkEvent = z.infer<typeof chatChunkEventSchema>;

// ---------------------------------------------------------------------------
// Coding workspace: workspace.select / workspace.read / workspace.plan
// (Phase 2, Milestone 5)
//
// The first channels in this codebase that read the user's own filesystem.
// Three properties are worth stating before the shapes, because they are what
// keep "read-only workspace" a structural claim rather than a promise:
//
//  - **No request carries a project path.** `workspace:select` takes no
//    arguments at all: the main process opens a native directory picker and
//    the *user* chooses. A renderer — or anything that has compromised one —
//    therefore cannot name a directory to open, only ask that the user be
//    asked. Every other request carries a path *relative* to whatever the
//    user already approved, validated by `workspaceRelativePathSchema` before
//    it reaches the filesystem and re-checked for containment after
//    resolution.
//  - **No request can modify anything.** There is no content field, no
//    destination, no patch and no write channel. The absence is the control.
//  - **Every response is bounded.** Trees, matches, file text and generated
//    plans are all capped by `workspace.schema.ts`, so a project with a
//    million files produces a truncated response or an error, never an
//    unbounded one.
//
// All six channels are routed through `main/action-runtime.ts`'s `runAction`
// and the unmodified `handleActionProposal`, so each is permission-gated,
// blocked by an engaged emergency stop, and audited — see `main/ipc.ts`.
// ---------------------------------------------------------------------------

export const IPC_WORKSPACE_STATUS_CHANNEL = 'workspace:status';
export const IPC_WORKSPACE_SELECT_CHANNEL = 'workspace:select';
export const IPC_WORKSPACE_TREE_CHANNEL = 'workspace:tree';
export const IPC_WORKSPACE_FILE_CHANNEL = 'workspace:file';
export const IPC_WORKSPACE_SEARCH_CHANNEL = 'workspace:search';
export const IPC_WORKSPACE_PLAN_CHANNEL = 'workspace:plan';

export const workspaceStatusRequestSchema = z.tuple([]);

/**
 * Takes no arguments on purpose. The directory is chosen by the user in a
 * native dialog the main process owns and the renderer cannot see, forge or
 * dismiss — the same reasoning that makes `main/confirm.ts`'s confirmation
 * dialog native rather than HTML.
 */
export const workspaceSelectRequestSchema = z.tuple([]);

export const workspaceTreeRequestSchema = z.tuple([
  z.strictObject({
    /** `''` lists the project root. */
    path: workspaceRelativePathSchema,
  }),
]);

export const workspaceFileRequestSchema = z.tuple([
  z.strictObject({
    path: workspaceEntryPathSchema,
  }),
]);

export const workspaceSearchRequestSchema = z.tuple([
  z.strictObject({
    query: workspaceSearchQuerySchema,
    /** The subtree to search; `''` searches the whole approved project. */
    path: workspaceRelativePathSchema,
  }),
]);

export const workspacePlanRequestSchema = z.tuple([
  z.strictObject({
    objective: workspaceObjectiveSchema,
  }),
]);

export type WorkspaceTreeRequestInput = z.infer<typeof workspaceTreeRequestSchema>[0];
export type WorkspaceFileRequestInput = z.infer<typeof workspaceFileRequestSchema>[0];
export type WorkspaceSearchRequestInput = z.infer<typeof workspaceSearchRequestSchema>[0];
export type WorkspacePlanRequestInput = z.infer<typeof workspacePlanRequestSchema>[0];

/**
 * `errorCode` is always one of {@link WORKSPACE_ERROR_CODES} — the same
 * normalized vocabulary the workspace layer already throws, reused rather
 * than re-invented at this boundary, exactly as `chatSendResponseSchema`
 * reuses the provider vocabulary. Never a raw error, an `errno`, or a
 * filesystem path.
 */
const workspaceErrorCodeSchema = z.enum(WORKSPACE_ERROR_CODES);

/** Response for the two channels that answer with the approved project. */
export const workspaceProjectResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  /** `null` means "no project approved", which is a success, not a failure. */
  project: workspaceProjectSummarySchema.nullable().optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export const workspaceStatusResponseSchema = workspaceProjectResponseSchema;
export const workspaceSelectResponseSchema = workspaceProjectResponseSchema;

export type WorkspaceProjectResponse = z.infer<typeof workspaceProjectResponseSchema>;

export const workspaceTreeResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  tree: workspaceTreeSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type WorkspaceTreeResponse = z.infer<typeof workspaceTreeResponseSchema>;

export const workspaceFileResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  file: workspaceFileSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type WorkspaceFileResponse = z.infer<typeof workspaceFileResponseSchema>;

export const workspaceSearchResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  results: workspaceSearchResultSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type WorkspaceSearchResponse = z.infer<typeof workspaceSearchResponseSchema>;

export const workspacePlanResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  plan: codingPlanSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type WorkspacePlanResponse = z.infer<typeof workspacePlanResponseSchema>;

// ---------------------------------------------------------------------------
// Controlled coding actions (Phase 2, Milestone 6)
//
// The first channels in this codebase that can change something outside
// `%APPDATA%\Local-Agent`. Four properties hold across all of them, and each
// is a shape rather than a check:
//
//  - **A change is applied by reference.** `workspace:propose` is the only
//    channel that carries file content, and it writes nothing.
//    `workspace:apply` carries a change *id* and nothing else — no path, no
//    content, no destination — so the bytes written are necessarily the bytes
//    that were diffed and shown. A renderer compromised between the two calls
//    can re-request an already-reviewed change; it cannot substitute one.
//  - **A command is named, never spelled.** `commandRunRequestSchema` carries
//    an identifier from a five-value enum. There is no field here for a
//    command string, an argument, a shell, a working directory, or an
//    environment variable, so "no arbitrary command strings" is a property of
//    the type rather than a filter applied to one.
//  - **Git is not addressable.** No schema here carries a git subcommand,
//    a ref, a branch name, a remote or a commit message. `git:checkpoint`
//    takes no arguments at all.
//  - **Every one of them except the read-only pair is on the confirmation
//    floor**, which no policy edit can downgrade, so the operation is stated
//    in a native dialog the main process owns before anything happens.
//
// `command:cancel` is the one channel with no permission gate, for exactly
// the reason `chat:cancel` has none: it cannot start anything, reach anything
// or read anything — it can only ask an already-authorized run to stop early.
// ---------------------------------------------------------------------------

export const IPC_WORKSPACE_PROPOSE_CHANNEL = 'workspace:propose';
export const IPC_WORKSPACE_APPLY_CHANNEL = 'workspace:apply';
export const IPC_WORKSPACE_ROLLBACK_CHANNEL = 'workspace:rollback';
export const IPC_WORKSPACE_CHANGES_CHANNEL = 'workspace:changes';
export const IPC_COMMAND_LIST_CHANNEL = 'command:list';
export const IPC_COMMAND_RUN_CHANNEL = 'command:run';
export const IPC_COMMAND_CANCEL_CHANNEL = 'command:cancel';
export const IPC_GIT_STATUS_CHANNEL = 'git:status';
export const IPC_GIT_DIFF_CHANNEL = 'git:diff';
export const IPC_GIT_CHECKPOINT_CHANNEL = 'git:checkpoint';

/**
 * The one request that carries file content, and it produces a diff rather
 * than a write.
 *
 * Duplicate paths are refused outright: two edits naming the same file would
 * make "what will this change set do to that file" ambiguous, and an
 * ambiguous change is not one a person can meaningfully approve.
 */
export const workspaceProposeRequestSchema = z.tuple([
  z.strictObject({
    edits: z
      .array(workspaceEditSchema)
      .min(1)
      .max(WORKSPACE_MAX_CHANGE_FILES)
      .superRefine((edits, ctx) => {
        const seen = new Set<string>();
        edits.forEach((edit, index) => {
          if (seen.has(edit.path)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'path'],
              message: 'a change set must not name the same file twice',
            });
          }
          seen.add(edit.path);
        });
      }),
  }),
]);

export type WorkspaceProposeRequestInput = z.infer<typeof workspaceProposeRequestSchema>[0];

/** Applying and rolling back both carry an identifier and nothing else. */
const changeReferenceRequestSchema = z.tuple([
  z.strictObject({ changeId: workspaceChangeIdSchema }),
]);

export const workspaceApplyRequestSchema = changeReferenceRequestSchema;
export const workspaceRollbackRequestSchema = changeReferenceRequestSchema;
export const workspaceChangesRequestSchema = z.tuple([]);

export const workspaceChangeResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  change: workspaceChangeSetSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export const workspaceProposeResponseSchema = workspaceChangeResponseSchema;
export const workspaceApplyResponseSchema = workspaceChangeResponseSchema;
export const workspaceRollbackResponseSchema = workspaceChangeResponseSchema;

export type WorkspaceChangeResponse = z.infer<typeof workspaceChangeResponseSchema>;

export const workspaceChangesResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  history: workspaceChangeHistorySchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type WorkspaceChangesResponse = z.infer<typeof workspaceChangesResponseSchema>;

export const commandListRequestSchema = z.tuple([]);

/**
 * `runId` correlates a later `command:cancel` to this specific run, exactly
 * as `chat:send`'s `requestId` does. `commandId` is an enum member; there is
 * no other field, and in particular no argument vector.
 */
export const commandRunRequestSchema = z.tuple([
  z.strictObject({
    runId: z.uuid(),
    commandId: commandIdSchema,
  }),
]);

export type CommandRunRequestInput = z.infer<typeof commandRunRequestSchema>[0];

export const commandCancelRequestSchema = z.tuple([z.strictObject({ runId: z.uuid() })]);

export const commandListResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  catalog: commandCatalogSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type CommandListResponse = z.infer<typeof commandListResponseSchema>;

export const commandRunResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  run: commandRunResultSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type CommandRunResponse = z.infer<typeof commandRunResponseSchema>;

/** Best-effort and idempotent, exactly like {@link chatCancelResponseSchema}. */
export const commandCancelResponseSchema = z.strictObject({
  acknowledged: z.literal(true),
});

export type CommandCancelResponse = z.infer<typeof commandCancelResponseSchema>;

export const gitStatusRequestSchema = z.tuple([]);

/** `null` diffs the whole working tree; a path narrows it to one file. */
export const gitDiffRequestSchema = z.tuple([
  z.strictObject({ path: workspaceEntryPathSchema.nullable() }),
]);

export type GitDiffRequestInput = z.infer<typeof gitDiffRequestSchema>[0];

/** Takes no arguments: the message, the branch and the commands are all fixed. */
export const gitCheckpointRequestSchema = z.tuple([]);

export const gitStatusResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  status: gitStatusSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type GitStatusResponse = z.infer<typeof gitStatusResponseSchema>;

export const gitDiffResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  diff: gitDiffSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type GitDiffResponse = z.infer<typeof gitDiffResponseSchema>;

export const gitCheckpointResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  checkpoint: gitCheckpointSchema.optional(),
  errorCode: workspaceErrorCodeSchema.optional(),
});

export type GitCheckpointResponse = z.infer<typeof gitCheckpointResponseSchema>;

// ---------------------------------------------------------------------------
// Agent profiles and runs (Phase 2, Milestone 7)
//
// Eight channels. None of them introduces a capability: the four write
// channels change *configuration*, and `agent:run` executes a bounded
// sequence of actions that the interface could already have taken one at a
// time, each still decided by the permission engine on its own action type.
//
// Four properties hold across all of them, and each is a shape rather than a
// check:
//
//  - **A request cannot grant a permission.** `agentProfileInputSchema`'s
//    `permissionPolicy` entries are `confirm` or `deny`; `allow` is not a
//    member of the enum, so "permit this" is not expressible in a payload.
//  - **A request cannot name a capability.** `allowedTools` is an enum of
//    seven tool ids, each bound in reviewed source to an action type that
//    already existed. There is no field for an action type, a command string,
//    an argument, a shell, an absolute path or a URL.
//  - **A request cannot carry a credential.** Every object is a
//    `strictObject` with no field capable of holding one, so a payload with
//    an `apiKey` is rejected rather than stored and ignored.
//  - **A run is named, never described.** `agent:run` carries a run id and an
//    objective string. It cannot carry a step list, a tool, a path or a
//    command — the steps are derived in the main process from the *stored*
//    profile, so a compromised renderer cannot substitute a plan.
//
// `agent:cancel` is the one channel with no permission gate, for exactly the
// reason `chat:cancel` and `command:cancel` have none: it cannot start
// anything, read anything or reach anything — it can only ask an
// already-authorized run to stop early.
// ---------------------------------------------------------------------------

export const IPC_AGENT_LIST_CHANNEL = 'agent:list';
export const IPC_AGENT_SELECT_CHANNEL = 'agent:select';
export const IPC_AGENT_CREATE_CHANNEL = 'agent:create';
export const IPC_AGENT_UPDATE_CHANNEL = 'agent:update';
export const IPC_AGENT_DELETE_CHANNEL = 'agent:delete';
export const IPC_AGENT_SET_ENABLED_CHANNEL = 'agent:setEnabled';
export const IPC_AGENT_RUN_CHANNEL = 'agent:run';
export const IPC_AGENT_CANCEL_CHANNEL = 'agent:cancel';

/**
 * `errorCode` is always one of {@link AGENT_ERROR_CODES} — the same
 * normalized vocabulary the agent layer throws, reused rather than restated.
 * Never a raw error, a profile name, or a filesystem path.
 */
const agentErrorCodeSchema = z.enum(AGENT_ERROR_CODES);

export const agentListRequestSchema = z.tuple([]);

/** Selecting, deleting and enabling all address a profile by id and nothing else. */
const agentProfileReferenceRequestSchema = z.tuple([
  z.strictObject({ profileId: agentProfileIdSchema }),
]);

export const agentSelectRequestSchema = agentProfileReferenceRequestSchema;
export const agentDeleteRequestSchema = agentProfileReferenceRequestSchema;

export const agentSetEnabledRequestSchema = z.tuple([
  z.strictObject({ profileId: agentProfileIdSchema, enabled: z.boolean() }),
]);

export const agentCreateRequestSchema = z.tuple([
  z.strictObject({ profile: agentProfileInputSchema }),
]);

/**
 * Updating carries the target id *and* the submitted profile.
 *
 * The two must agree — the main process refuses a mismatch rather than
 * picking one — so a payload cannot rename a profile by addressing one id and
 * submitting another, which would otherwise be a way to overwrite a
 * profile the caller did not name.
 */
export const agentUpdateRequestSchema = z.tuple([
  z.strictObject({
    profileId: agentProfileIdSchema,
    profile: agentProfileInputSchema,
  }),
]);

export type AgentProfileReferenceInput = z.infer<typeof agentSelectRequestSchema>[0];
export type AgentSetEnabledInput = z.infer<typeof agentSetEnabledRequestSchema>[0];
export type AgentCreateInput = z.infer<typeof agentCreateRequestSchema>[0];
export type AgentUpdateInput = z.infer<typeof agentUpdateRequestSchema>[0];

/**
 * The registry as the renderer sees it: every profile, and which is active.
 *
 * Safe to send in full — a profile carries no credential, by construction.
 * The interface needs the whole document to show a profile's tools, its
 * workspace scope and its limits, which is the milestone's own requirement
 * that active permissions and limits be clearly visible.
 */
export const agentRegistryResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  registry: z
    .strictObject({
      activeProfileId: agentProfileIdSchema,
      profiles: z.array(agentProfileSchema).max(AGENT_MAX_PROFILES),
    })
    .optional(),
  errorCode: agentErrorCodeSchema.optional(),
});

export const agentListResponseSchema = agentRegistryResponseSchema;
export const agentSelectResponseSchema = agentRegistryResponseSchema;
export const agentCreateResponseSchema = agentRegistryResponseSchema;
export const agentUpdateResponseSchema = agentRegistryResponseSchema;
export const agentDeleteResponseSchema = agentRegistryResponseSchema;
export const agentSetEnabledResponseSchema = agentRegistryResponseSchema;

export type AgentRegistryResponse = z.infer<typeof agentRegistryResponseSchema>;

/**
 * Starting a run.
 *
 * `runId` correlates a later `agent:cancel` to this run, exactly as
 * `chat:send`'s `requestId` and `command:run`'s `runId` do. `objective` is
 * the request in the user's own words, bounded by the same schema
 * `workspace:plan` already uses. There is deliberately no `steps`, no
 * `tools`, no `profile` and no `limits` field: everything a run is permitted
 * to do comes from the *stored* profile, read in the main process, so a
 * renderer cannot widen a run by describing it differently.
 */
export const agentRunRequestSchema = z.tuple([
  z.strictObject({
    runId: z.uuid(),
    objective: workspaceObjectiveSchema,
  }),
]);

export type AgentRunRequestInput = z.infer<typeof agentRunRequestSchema>[0];

export const agentCancelRequestSchema = z.tuple([z.strictObject({ runId: z.uuid() })]);

export const agentRunResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  run: agentRunSchema.optional(),
  errorCode: agentErrorCodeSchema.optional(),
});

export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;

/** Best-effort and idempotent, exactly like {@link commandCancelResponseSchema}. */
export const agentCancelResponseSchema = z.strictObject({
  acknowledged: z.literal(true),
});

export type AgentCancelResponse = z.infer<typeof agentCancelResponseSchema>;

// ---------------------------------------------------------------------------
// Local memory (Phase 2, Milestone 8)
//
// Ten channels. None of them introduces a capability: they read and write
// short, user-authored notes inside this application's own data directory,
// and a note grants nothing — nothing in this codebase reads a permission, a
// tool, a path or a provider out of one.
//
// Five properties hold across all of them, and each is a shape rather than a
// check:
//
//  - **A request cannot label its own provenance.** `memoryRecordInputSchema`
//    has no `source` field. `user` is stamped by the add handler and `import`
//    by the import handler, and those are the only two writers of either
//    value, so a renderer cannot pass off imported content as something the
//    user typed — or the reverse.
//  - **A request cannot name a file.** `memory:export` and `memory:import`
//    carry a scope and nothing else; the file is chosen by the user in a
//    native dialog the main process owns, exactly as `workspace:select`
//    already works. There is no path parameter anywhere in this section.
//  - **A request cannot move a record between scopes.** An update addresses a
//    record by id *within* the scope its own submitted record names, and a
//    stored record found in a different scope is refused rather than
//    relocated. A project note therefore cannot become a personal one by
//    editing it, which is what keeps project isolation from depending on the
//    renderer behaving.
//  - **A retrieval cannot ask for everything.** `memoryRetrievalResultSchema`
//    is capped at `MEMORY_MAX_RETRIEVED`, so the type itself cannot express
//    "the whole store" — the milestone's rule about what a model may be
//    handed, made structural.
//  - **A failure carries a code and nothing else.** Never a record, never a
//    fragment of one, never the path of a file that could not be read.
// ---------------------------------------------------------------------------

export const IPC_MEMORY_LIST_CHANNEL = 'memory:list';
export const IPC_MEMORY_SEARCH_CHANNEL = 'memory:search';
export const IPC_MEMORY_RETRIEVE_CHANNEL = 'memory:retrieve';
export const IPC_MEMORY_ADD_CHANNEL = 'memory:add';
export const IPC_MEMORY_UPDATE_CHANNEL = 'memory:update';
export const IPC_MEMORY_SET_PINNED_CHANNEL = 'memory:setPinned';
export const IPC_MEMORY_DELETE_CHANNEL = 'memory:delete';
export const IPC_MEMORY_CLEAR_CHANNEL = 'memory:clear';
export const IPC_MEMORY_EXPORT_CHANNEL = 'memory:export';
export const IPC_MEMORY_IMPORT_CHANNEL = 'memory:import';

/**
 * `errorCode` is always one of {@link MEMORY_ERROR_CODES} — the same
 * normalized vocabulary the memory layer throws, reused rather than restated.
 * Never a raw error, a record's content, or a filesystem path.
 */
const memoryErrorCodeSchema = z.enum(MEMORY_ERROR_CODES);

/** Every scoped operation addresses exactly one scope, and says which. */
const memoryScopeRequestSchema = z.tuple([z.strictObject({ scope: memoryScopeSchema })]);

export const memoryListRequestSchema = memoryScopeRequestSchema;
export const memoryClearRequestSchema = memoryScopeRequestSchema;
export const memoryExportRequestSchema = memoryScopeRequestSchema;
export const memoryImportRequestSchema = memoryScopeRequestSchema;

export const memorySearchRequestSchema = z.tuple([
  z.strictObject({ scope: memoryScopeSchema, query: memorySearchQuerySchema }),
]);

/**
 * Retrieval takes an objective and nothing else.
 *
 * No scope: a retrieval spans every scope the session can currently read,
 * which is personal and session always, and project only while one is
 * approved. Bounded by the same objective schema `workspace:plan` already
 * uses, so this milestone adds no new free-text surface.
 */
export const memoryRetrieveRequestSchema = z.tuple([
  z.strictObject({ objective: workspaceObjectiveSchema }),
]);

export const memoryAddRequestSchema = z.tuple([
  z.strictObject({ record: memoryRecordInputSchema }),
]);

/**
 * Updating carries the target id *and* the submitted record.
 *
 * The record's own `scope` is what addresses the store, and the stored record
 * must already live there — a mismatch is a refusal, never a move. Editing a
 * project note into a personal one is therefore not expressible.
 */
export const memoryUpdateRequestSchema = z.tuple([
  z.strictObject({ id: z.uuid(), record: memoryRecordInputSchema }),
]);

export const memorySetPinnedRequestSchema = z.tuple([
  z.strictObject({ id: z.uuid(), scope: memoryScopeSchema, pinned: z.boolean() }),
]);

export const memoryDeleteRequestSchema = z.tuple([
  z.strictObject({ id: z.uuid(), scope: memoryScopeSchema }),
]);

export type MemoryScopeRequestInput = z.infer<typeof memoryListRequestSchema>[0];
export type MemorySearchRequestInput = z.infer<typeof memorySearchRequestSchema>[0];
export type MemoryRetrieveRequestInput = z.infer<typeof memoryRetrieveRequestSchema>[0];
export type MemoryAddRequestInput = z.infer<typeof memoryAddRequestSchema>[0];
export type MemoryUpdateRequestInput = z.infer<typeof memoryUpdateRequestSchema>[0];
export type MemorySetPinnedRequestInput = z.infer<typeof memorySetPinnedRequestSchema>[0];
export type MemoryDeleteRequestInput = z.infer<typeof memoryDeleteRequestSchema>[0];

export const memoryQueryResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  result: memoryQueryResultSchema.optional(),
  errorCode: memoryErrorCodeSchema.optional(),
});

export const memoryListResponseSchema = memoryQueryResponseSchema;
export const memorySearchResponseSchema = memoryQueryResponseSchema;

export type MemoryQueryResponse = z.infer<typeof memoryQueryResponseSchema>;

export const memoryRetrieveResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  result: memoryRetrievalResultSchema.optional(),
  errorCode: memoryErrorCodeSchema.optional(),
});

export type MemoryRetrieveResponse = z.infer<typeof memoryRetrieveResponseSchema>;

/** What a single-record write answers with: the record as it was stored. */
export const memoryRecordResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  record: memoryRecordSchema.optional(),
  errorCode: memoryErrorCodeSchema.optional(),
});

export const memoryAddResponseSchema = memoryRecordResponseSchema;
export const memoryUpdateResponseSchema = memoryRecordResponseSchema;
export const memorySetPinnedResponseSchema = memoryRecordResponseSchema;

export type MemoryRecordResponse = z.infer<typeof memoryRecordResponseSchema>;

/**
 * What a delete, a clear, an export or an import answers with: counts, and
 * never the records themselves. An export in particular reports how many
 * records were written and nothing about what they said.
 */
export const memoryMutationResponseSchema = z.strictObject({
  outcome: z.enum(AUDIT_OUTCOMES),
  summary: memoryMutationSummarySchema.optional(),
  errorCode: memoryErrorCodeSchema.optional(),
});

export const memoryDeleteResponseSchema = memoryMutationResponseSchema;
export const memoryClearResponseSchema = memoryMutationResponseSchema;
export const memoryExportResponseSchema = memoryMutationResponseSchema;
export const memoryImportResponseSchema = memoryMutationResponseSchema;

export type MemoryMutationResponse = z.infer<typeof memoryMutationResponseSchema>;
