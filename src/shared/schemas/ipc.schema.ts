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
  API_KEY_MAX_LENGTH,
  API_KEY_MIN_LENGTH,
  AUDIT_OUTCOMES,
  CHAT_CONVERSATION_MAX_MESSAGES,
  CONTROL_CHARACTER_PATTERN,
  WORKSPACE_MAX_CHANGE_FILES,
} from '../constants';
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
