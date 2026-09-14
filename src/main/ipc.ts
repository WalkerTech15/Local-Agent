/**
 * IPC handler registration for Local Agent.
 *
 * `main` is the only layer that registers `ipcMain` handlers; `preload` only
 * ever calls `ipcRenderer.invoke` against a channel named here. Every handler
 * validates its incoming arguments and its outgoing result against the
 * shared schema for that channel before either crosses the process boundary,
 * so a malformed call or a malformed result fails loudly instead of reaching
 * untrusted code.
 *
 * Milestone 2 registered exactly one channel, a liveness check with no side
 * effect. Milestone 7 adds the first privileged channels — non-secret
 * settings and the encrypted secret store — and every one of them is routed
 * through `runAction` (`main/action-runtime.ts`), which calls the unmodified
 * Milestone 5 `handleActionProposal`. No handler here calls `execute` or the
 * secret-store / settings-write functions directly; every side effect is
 * reached only through a permission decision.
 *
 * Phase 2 Milestone 3 adds `chat:send` (routed through that same pipeline)
 * and `chat:cancel` (no side effect of its own to gate). Phase 2 Milestone 4
 * adds `chat:chunk`, the only main → renderer *push* channel in this
 * codebase: one-way, correlated to a single in-flight `chat:send`, bounded
 * and validated before it is sent, and advisory — see {@link emitChatChunks}
 * and `docs/phase-2-provider-completion.md`.
 */

import { randomUUID } from 'node:crypto';

import type { IpcMain, IpcMainInvokeEvent, SafeStorage } from 'electron';

import {
  createAgentProfile,
  deleteAgentProfile,
  readAgentRegistry,
  selectAgentProfile,
  setAgentProfileEnabled,
  updateAgentProfile,
} from './agent-profiles';
import { describeAgentRun, runAgentOrchestration } from './agent-orchestrator';
import type { AgentStepOutcome, AgentStepRequest } from './agent-orchestrator';
import { runAction } from './action-runtime';
import type { ActionRuntime } from './action-runtime';
import { resolveMainChatProvider } from './chat-provider-registry';
import { loadEmergencyState } from './emergency';
import { ActionExecutionError } from './executor';
import { createGitCheckpoint, describeCheckpoint, readGitDiff, readGitStatus } from './git-runner';
import type { GitRuntime } from './git-runner';
import type { UserDataPaths } from './paths';
import { buildCommandCatalog, runCodingCommand } from './project-commands';
import { clearSecret, SecretStoreUnavailableError, writeSecret } from './secrets';
import { createChangeStore } from './workspace-changes';
import { listProjectTree, readProjectFile, searchProject } from './workspace-inspector';
import { createCodingPlan } from './workspace-planner';
import {
  adoptProjectDirectory,
  createWorkspaceSession,
  requireApprovedProject,
  toProjectSummary,
} from './workspace-session';
import {
  readReconciledSettings,
  refreshHasApiKeyAfterSecretChange,
  writeOnboardingSettings,
} from './settings-service';
import { loadSettings } from './settings';
import { AgentError, isAgentErrorCode } from '../shared/agent/errors';
import type { AgentErrorCode } from '../shared/agent/errors';
import { buildAgentPlan } from '../shared/agent/orchestration';
import { resolveActiveProfile, resolveAgentProvider } from '../shared/agent/registry';
import type { AgentRegistry } from '../shared/agent/registry';
import { findAgentTool } from '../shared/agent/tools';
import { CHAT_PROVIDER_ERROR_CODES, ChatProviderError } from '../shared/chat/provider';
import type { ChatProviderResult } from '../shared/chat/provider';
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_STEP_SUMMARY_MAX_LENGTH,
  CHAT_STREAM_MAX_DELTA_LENGTH,
  COMMAND_MAX_CONCURRENT_RUNS,
  PROVIDERS_REQUIRING_API_KEY,
} from '../shared/constants';
import type { ModelProvider } from '../shared/constants';
import { describeCommandLine, findCodingCommand } from '../shared/workspace/command-registry';
import { collapseToSingleLine } from '../shared/workspace/text-safety';
import {
  chatCancelRequestSchema,
  chatCancelResponseSchema,
  chatChunkEventSchema,
  chatSendRequestSchema,
  chatSendResponseSchema,
  healthCheckRequestSchema,
  healthCheckResponseSchema,
  IPC_CHAT_CANCEL_CHANNEL,
  IPC_CHAT_CHUNK_CHANNEL,
  IPC_CHAT_SEND_CHANNEL,
  IPC_HEALTH_CHANNEL,
  IPC_SECRETS_CLEAR_CHANNEL,
  IPC_SECRETS_STATUS_CHANNEL,
  IPC_SECRETS_WRITE_CHANNEL,
  IPC_SETTINGS_GET_CHANNEL,
  IPC_SETTINGS_UPDATE_CHANNEL,
  secretsClearRequestSchema,
  secretsClearResponseSchema,
  secretsStatusRequestSchema,
  secretsStatusResponseSchema,
  secretsWriteRequestSchema,
  secretsWriteResponseSchema,
  settingsGetRequestSchema,
  settingsGetResponseSchema,
  settingsUpdateRequestSchema,
  settingsUpdateResponseSchema,
  IPC_WORKSPACE_FILE_CHANNEL,
  IPC_WORKSPACE_PLAN_CHANNEL,
  IPC_WORKSPACE_SEARCH_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
  IPC_WORKSPACE_STATUS_CHANNEL,
  IPC_WORKSPACE_TREE_CHANNEL,
  workspaceFileRequestSchema,
  workspaceFileResponseSchema,
  workspacePlanRequestSchema,
  workspacePlanResponseSchema,
  workspaceSearchRequestSchema,
  workspaceSearchResponseSchema,
  workspaceSelectRequestSchema,
  workspaceSelectResponseSchema,
  workspaceStatusRequestSchema,
  workspaceStatusResponseSchema,
  workspaceTreeRequestSchema,
  workspaceTreeResponseSchema,
  commandCancelRequestSchema,
  commandCancelResponseSchema,
  commandListRequestSchema,
  commandListResponseSchema,
  commandRunRequestSchema,
  commandRunResponseSchema,
  gitCheckpointRequestSchema,
  gitCheckpointResponseSchema,
  gitDiffRequestSchema,
  gitDiffResponseSchema,
  gitStatusRequestSchema,
  gitStatusResponseSchema,
  IPC_COMMAND_CANCEL_CHANNEL,
  IPC_COMMAND_LIST_CHANNEL,
  IPC_COMMAND_RUN_CHANNEL,
  IPC_GIT_CHECKPOINT_CHANNEL,
  IPC_GIT_DIFF_CHANNEL,
  IPC_GIT_STATUS_CHANNEL,
  IPC_WORKSPACE_APPLY_CHANNEL,
  IPC_WORKSPACE_CHANGES_CHANNEL,
  IPC_WORKSPACE_PROPOSE_CHANNEL,
  IPC_WORKSPACE_ROLLBACK_CHANNEL,
  workspaceApplyRequestSchema,
  workspaceApplyResponseSchema,
  workspaceChangesRequestSchema,
  workspaceChangesResponseSchema,
  workspaceProposeRequestSchema,
  workspaceProposeResponseSchema,
  workspaceRollbackRequestSchema,
  workspaceRollbackResponseSchema,
  agentCancelRequestSchema,
  agentCancelResponseSchema,
  agentCreateRequestSchema,
  agentCreateResponseSchema,
  agentDeleteRequestSchema,
  agentDeleteResponseSchema,
  agentListRequestSchema,
  agentListResponseSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
  agentSelectRequestSchema,
  agentSelectResponseSchema,
  agentSetEnabledRequestSchema,
  agentSetEnabledResponseSchema,
  agentUpdateRequestSchema,
  agentUpdateResponseSchema,
  IPC_AGENT_CANCEL_CHANNEL,
  IPC_AGENT_CREATE_CHANNEL,
  IPC_AGENT_DELETE_CHANNEL,
  IPC_AGENT_LIST_CHANNEL,
  IPC_AGENT_RUN_CHANNEL,
  IPC_AGENT_SELECT_CHANNEL,
  IPC_AGENT_SET_ENABLED_CHANNEL,
  IPC_AGENT_UPDATE_CHANNEL,
} from '../shared/schemas';
import type {
  AgentProfile,
  AgentProfileInput,
  AgentRegistryResponse,
  AgentRun,
  AgentRunResponse,
  ChatSendResponse,
  CodingPlan,
  CommandIdValue,
  CommandCatalog,
  CommandListResponse,
  CommandRunResponse,
  CommandRunResult,
  GitCheckpointResponse,
  GitCheckpointValue,
  GitDiffResponse,
  GitDiffValue,
  GitStatusResponse,
  GitStatusValue,
  SecretsActionResponse,
  SecretStatusResult,
  SettingsActionResponse,
  Settings,
  WorkspaceChangeHistory,
  WorkspaceChangeResponse,
  WorkspaceChangesResponse,
  WorkspaceChangeSet,
  WorkspaceFile,
  WorkspaceFileResponse,
  WorkspacePlanResponse,
  WorkspaceProjectResponse,
  WorkspaceProjectSummary,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
  WorkspaceTree,
  WorkspaceTreeResponse,
} from '../shared/schemas';
import { isWorkspaceErrorCode, WorkspaceError } from '../shared/workspace/errors';
import type { WorkspaceErrorCode } from '../shared/workspace/errors';
import type { ActionProposal, ActionResult, ActionType, ConfirmationResult } from '../shared/types';

/** `ActionResult.errorCode` values `secrets.write`'s `perform` may throw. */
export const SECRETS_ERROR_PROVIDER_DOES_NOT_USE_API_KEY = 'PROVIDER_DOES_NOT_USE_API_KEY';
export const SECRETS_ERROR_STORE_UNAVAILABLE = 'SECRET_STORE_UNAVAILABLE';

function isKnownChatProviderErrorCode(
  code: string,
): code is (typeof CHAT_PROVIDER_ERROR_CODES)[number] {
  return (CHAT_PROVIDER_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Everything an IPC handler needs to build and run a proposal, resolved once
 * at startup in `main/index.ts` and passed in here — mirroring how every
 * loader in this codebase takes its path as a parameter rather than resolving
 * it itself, this stays independent of `app.getPath` and free of any direct
 * dependency on the live `electron` module, so a test can supply a
 * temporary-directory `UserDataPaths`, a fake `safeStorage`, and a fake
 * confirmation answer with nothing else to configure.
 *
 * `requestConfirmation` is injected rather than this module reaching for
 * `main/confirm.ts`'s real `showNativeConfirmation` itself: the real
 * implementation calls `electron`'s `dialog`, which only exists inside a
 * running Electron process, so keeping the dependency at the boundary — built
 * once in `main/index.ts`, where the real `dialog` and the real window are
 * both available — is what lets this module's own tests run under plain
 * Node, with a fake answer, and still exercise the true confirmation-gated
 * code paths for `secrets.write` and `secrets.clear`.
 */
export interface IpcHandlerRuntime {
  readonly userDataPaths: UserDataPaths;
  readonly safeStorage: SafeStorage;
  readonly requestConfirmation: (message: string) => Promise<ConfirmationResult>;
  /** UTC ISO-8601. Injected so this stays testable with a fixed clock. */
  readonly nowFn: () => string;
  /**
   * Shows the native project-directory picker and resolves to what the user
   * chose, or `null` if they dismissed it (Phase 2, Milestone 5).
   *
   * Injected for exactly the reason `requestConfirmation` is: the real
   * implementation calls `electron`'s `dialog`, which exists only inside a
   * running Electron process, so keeping the dependency at the boundary —
   * built once in `main/index.ts` — is what lets this module's own tests run
   * under plain Node while still exercising the real selection path.
   *
   * Note what this signature does *not* have: a parameter. Nothing the
   * renderer sends can influence which directory is offered or chosen.
   */
  readonly selectProjectDirectory: () => Promise<string | null>;
}

/**
 * One fixed timestamp for the whole lifetime of one IPC call, shared by the
 * permission decision, the audit record and whatever the action itself
 * persists — never re-read from the clock partway through a single request.
 */
function buildActionRuntime(runtime: IpcHandlerRuntime, now: string): ActionRuntime {
  return {
    userDataPaths: runtime.userDataPaths,
    now: () => now,
    requestConfirmation: runtime.requestConfirmation,
  };
}

function newProposal(actionType: ActionType, parameters: Record<string, unknown>): ActionProposal {
  return { actionType, parameters, correlationId: randomUUID() };
}

function toSettingsResponse(result: ActionResult<Settings>): SettingsActionResponse {
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { settings: result.value }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

function toSecretsResponse(result: ActionResult<SecretStatusResult>): SecretsActionResponse {
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { status: result.value }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

/**
 * Forwards one streamed fragment to the renderer that asked for it, as one
 * or more `chat:chunk` events (Phase 2, Milestone 4).
 *
 * Four properties, all enforced here rather than assumed of the caller:
 *
 *  - **Only the requesting window is told.** The event goes to
 *    `event.sender` — the `WebContents` that invoked this `chat:send` — not
 *    broadcast, and never to a destroyed one.
 *  - **Only bounded fragments are sent.** A delta longer than
 *    {@link CHAT_STREAM_MAX_DELTA_LENGTH} is split across several events
 *    rather than truncated or dropped, so no single IPC message is
 *    unbounded and no text is lost.
 *  - **Only content-safe fragments are sent.** Each piece is validated by
 *    {@link chatChunkEventSchema}; one that fails is skipped silently. A
 *    dropped preview fragment costs nothing, because the authoritative reply
 *    is the validated one `chat:send` resolves with — never the sum of these
 *    events.
 *  - **A failure here never fails the request.** Streaming is advisory; the
 *    provider call continues regardless.
 */
function emitChatChunks(event: IpcMainInvokeEvent, requestId: string, delta: string): void {
  const sender = event.sender;
  if (sender.isDestroyed()) return;

  for (let index = 0; index < delta.length; index += CHAT_STREAM_MAX_DELTA_LENGTH) {
    const piece = delta.slice(index, index + CHAT_STREAM_MAX_DELTA_LENGTH);
    const payload = chatChunkEventSchema.safeParse({ requestId, delta: piece });
    if (!payload.success) continue;
    sender.send(IPC_CHAT_CHUNK_CHANNEL, payload.data);
  }
}

/**
 * `result.errorCode` is normally always one of {@link CHAT_PROVIDER_ERROR_CODES}
 * — `perform` below never throws anything except a `ChatProviderError`,
 * translated to an `ActionExecutionError` carrying that same code. This
 * degrades any other value to `PROVIDER_REQUEST_FAILED` rather than letting
 * an unexpected internal error code fail `chatSendResponseSchema.parse`
 * outright — defence in depth for a path that should not be reachable, not
 * a substitute for `perform` only ever throwing a normalized error.
 */
function toChatSendResponse(result: ActionResult<ChatProviderResult>): ChatSendResponse {
  const errorCode =
    result.errorCode === undefined
      ? undefined
      : isKnownChatProviderErrorCode(result.errorCode)
        ? result.errorCode
        : 'PROVIDER_REQUEST_FAILED';
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { content: result.value.content }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/**
 * Normalizes whatever code a workspace action failed with.
 *
 * `perform` below only ever throws a `WorkspaceError`, translated to an
 * `ActionExecutionError` carrying the same code — but `execute` also has its
 * own generic `EXECUTION_FAILED` for an unexpected throw, and that is not a
 * member of the workspace vocabulary. Degrading it to `WORKSPACE_READ_FAILED`
 * keeps a response schema-valid rather than letting an internal code fail
 * validation on the way out, exactly as `toChatSendResponse` already does for
 * the provider vocabulary. Defence in depth for a path that should not be
 * reachable, not a substitute for `perform` normalizing its own failures.
 */
function toWorkspaceErrorCode(result: ActionResult): WorkspaceErrorCode | undefined {
  if (result.errorCode === undefined) return undefined;
  return isWorkspaceErrorCode(result.errorCode) ? result.errorCode : 'WORKSPACE_READ_FAILED';
}

function toWorkspaceProjectResponse(
  result: ActionResult<WorkspaceProjectSummary | null>,
): WorkspaceProjectResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { project: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toWorkspaceTreeResponse(result: ActionResult<WorkspaceTree>): WorkspaceTreeResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { tree: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toWorkspaceFileResponse(result: ActionResult<WorkspaceFile>): WorkspaceFileResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { file: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toWorkspaceSearchResponse(
  result: ActionResult<WorkspaceSearchResult>,
): WorkspaceSearchResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { results: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toWorkspacePlanResponse(result: ActionResult<CodingPlan>): WorkspacePlanResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { plan: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toWorkspaceChangeResponse(
  result: ActionResult<WorkspaceChangeSet>,
): WorkspaceChangeResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { change: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toWorkspaceChangesResponse(
  result: ActionResult<WorkspaceChangeHistory>,
): WorkspaceChangesResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { history: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toCommandListResponse(result: ActionResult<CommandCatalog>): CommandListResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { catalog: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toCommandRunResponse(result: ActionResult<CommandRunResult>): CommandRunResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { run: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toGitStatusResponse(result: ActionResult<GitStatusValue>): GitStatusResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { status: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toGitDiffResponse(result: ActionResult<GitDiffValue>): GitDiffResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { diff: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toGitCheckpointResponse(result: ActionResult<GitCheckpointValue>): GitCheckpointResponse {
  const errorCode = toWorkspaceErrorCode(result);
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { checkpoint: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/**
 * Normalizes whatever code an agent action failed with.
 *
 * The same defence in depth `toWorkspaceErrorCode` provides for the workspace
 * vocabulary: `perform` below only ever throws an `AgentError` translated to
 * an `ActionExecutionError` carrying the same code, but `execute` has its own
 * generic `EXECUTION_FAILED` for an unexpected throw, and that is not a member
 * of this vocabulary. Degrading it keeps a response schema-valid rather than
 * letting an internal code fail validation on the way out.
 *
 * The fallback differs by channel because "something went wrong" means
 * something different for a profile write than for a run.
 */
function toAgentErrorCode(
  result: ActionResult,
  fallback: AgentErrorCode,
): AgentErrorCode | undefined {
  if (result.errorCode === undefined) return undefined;
  return isAgentErrorCode(result.errorCode) ? result.errorCode : fallback;
}

function toAgentRegistryResponse(result: ActionResult<AgentRegistry>): AgentRegistryResponse {
  const errorCode = toAgentErrorCode(result, 'AGENT_PROFILE_STORE_FAILED');
  return {
    outcome: result.outcome,
    ...(result.value === undefined
      ? {}
      : {
          registry: {
            activeProfileId: result.value.activeProfileId,
            profiles: [...result.value.profiles],
          },
        }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toAgentRunResponse(result: ActionResult<AgentRun>): AgentRunResponse {
  const errorCode = toAgentErrorCode(result, 'AGENT_RUN_FAILED');
  return {
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { run: result.value }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/**
 * How much of a run's output budget one step's result consumed.
 *
 * The serialized size of the value the step produced — a listing, a search
 * result, a plan, a command's captured output. Measured rather than guessed
 * so that "output limit" means something a person can reason about, and
 * measured *here* rather than inside each tool so every tool is counted the
 * same way. A value that cannot be serialized counts as nothing rather than
 * failing the step.
 */
function measureOutputBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    // `JSON.stringify` is typed as returning `string` but really returns
    // `undefined` for a value it cannot represent, such as a function. The
    // `byteLength` call then throws and is caught here, which is why this is
    // a try/catch rather than a check the type system would call redundant.
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * `ipcMain` is passed in rather than imported here.
 *
 * Electron's ESM support for its built-in `electron` module fully resolves
 * `import ... from 'electron'` only in the process entry file; a value
 * import of it from a second statically-imported module resolves to the
 * unrelated `electron` npm package instead (its own path-to-binary helper,
 * not the runtime API) and fails at startup. `index.ts` is the only file
 * that imports the live `electron` module; everything else receives what it
 * needs as an argument. A type-only import is unaffected — it is erased
 * before anything runs — so the `electron` type imports above are safe.
 */
export function registerIpcHandlers(ipcMain: IpcMain, runtime: IpcHandlerRuntime): void {
  /**
   * One `AbortController` per in-flight `chat:send` call, keyed by the
   * caller-supplied `requestId`. `chat:cancel` looks a request up here and
   * aborts it; nothing else ever reads or holds a reference to a request
   * once it settles — the `finally` below always removes it, on success,
   * on failure, and on cancellation alike, so this map never grows with
   * completed requests and never leaks a controller across calls to
   * `registerIpcHandlers` (each call — one per test, one per app run — gets
   * its own map, never a module-level shared one).
   */
  const inFlightChatRequests = new Map<string, AbortController>();

  ipcMain.handle(IPC_HEALTH_CHANNEL, (_event, ...args: unknown[]) => {
    healthCheckRequestSchema.parse(args);
    return healthCheckResponseSchema.parse({ status: 'ok' });
  });

  ipcMain.handle(IPC_SETTINGS_GET_CHANNEL, async (_event, ...args: unknown[]) => {
    settingsGetRequestSchema.parse(args);
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    const result = await runAction(actionRuntime, newProposal('settings.read', {}), null, () =>
      readReconciledSettings(runtime.userDataPaths, now),
    );

    return settingsGetResponseSchema.parse(toSettingsResponse(result));
  });

  ipcMain.handle(IPC_SETTINGS_UPDATE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [input] = settingsUpdateRequestSchema.parse(args);
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    const proposal = newProposal('settings.write', {
      onboardingCompleted: input.onboardingCompleted,
      provider: input.modelProvider.provider,
    });

    const result = await runAction(actionRuntime, proposal, null, () =>
      writeOnboardingSettings(runtime.userDataPaths, now, input),
    );

    return settingsUpdateResponseSchema.parse(toSettingsResponse(result));
  });

  ipcMain.handle(IPC_SECRETS_STATUS_CHANNEL, async (_event, ...args: unknown[]) => {
    secretsStatusRequestSchema.parse(args);
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    const currentSettings = await loadSettings(runtime.userDataPaths.settingsFile, now);
    const proposal = newProposal('secrets.status', {
      provider: currentSettings.modelProvider.provider,
    });

    const result = await runAction(actionRuntime, proposal, null, async () => {
      const reconciled = await readReconciledSettings(runtime.userDataPaths, now);
      return { present: reconciled.modelProvider.hasApiKey };
    });

    return secretsStatusResponseSchema.parse(toSecretsResponse(result));
  });

  ipcMain.handle(IPC_SECRETS_WRITE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ apiKey }] = secretsWriteRequestSchema.parse(args);
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    const currentSettings = await loadSettings(runtime.userDataPaths.settingsFile, now);
    const provider = currentSettings.modelProvider.provider;
    const proposal = newProposal('secrets.write', { provider, keyPresent: true });
    const confirmationMessage = `Store an API key for the "${provider}" provider in the encrypted secret store?`;

    const result = await runAction(actionRuntime, proposal, confirmationMessage, async () => {
      // Re-checked against the provider on disk at the moment of execution,
      // not the value read above when the proposal was built — the two are
      // usually the same request-scoped read, but only this one gates the
      // side effect.
      const latestSettings = await loadSettings(runtime.userDataPaths.settingsFile, now);
      if (!PROVIDERS_REQUIRING_API_KEY.includes(latestSettings.modelProvider.provider)) {
        throw new ActionExecutionError(
          SECRETS_ERROR_PROVIDER_DOES_NOT_USE_API_KEY,
          'the selected provider does not use an API key',
        );
      }

      try {
        await writeSecret(runtime.userDataPaths.secretsFile, apiKey, runtime.safeStorage);
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError) {
          throw new ActionExecutionError(SECRETS_ERROR_STORE_UNAVAILABLE, error.message);
        }
        throw error;
      }

      // hasApiKey is updated only now that the store write above has
      // already succeeded.
      const refreshed = await refreshHasApiKeyAfterSecretChange(runtime.userDataPaths, now);
      return { present: refreshed.modelProvider.hasApiKey };
    });

    return secretsWriteResponseSchema.parse(toSecretsResponse(result));
  });

  ipcMain.handle(IPC_SECRETS_CLEAR_CHANNEL, async (_event, ...args: unknown[]) => {
    secretsClearRequestSchema.parse(args);
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    const currentSettings = await loadSettings(runtime.userDataPaths.settingsFile, now);
    const proposal = newProposal('secrets.clear', {
      provider: currentSettings.modelProvider.provider,
      keyPresent: false,
    });
    const confirmationMessage =
      'Remove the stored API key from the encrypted secret store? This cannot be undone.';

    const result = await runAction(actionRuntime, proposal, confirmationMessage, async () => {
      await clearSecret(runtime.userDataPaths.secretsFile);
      // hasApiKey is updated only now that the store clear above has
      // already succeeded.
      const refreshed = await refreshHasApiKeyAfterSecretChange(runtime.userDataPaths, now);
      return { present: refreshed.modelProvider.hasApiKey };
    });

    return secretsClearResponseSchema.parse(toSecretsResponse(result));
  });

  ipcMain.handle(IPC_CHAT_SEND_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const [{ requestId, messages }] = chatSendRequestSchema.parse(args);
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    const currentSettings = await loadSettings(runtime.userDataPaths.settingsFile, now);
    // Never the full conversation: only enough to describe what happened,
    // matching `secrets.write`'s own minimal `{provider, keyPresent}`
    // parameters. Message content never enters an audit record.
    const proposal = newProposal('chat.send', {
      provider: currentSettings.modelProvider.provider,
      messageCount: messages.length,
    });

    const abortController = new AbortController();
    inFlightChatRequests.set(requestId, abortController);

    try {
      const result = await runAction(actionRuntime, proposal, null, async () => {
        const provider = await resolveMainChatProvider({
          modelProvider: currentSettings.modelProvider,
          secretsFile: runtime.userDataPaths.secretsFile,
          safeStorage: runtime.safeStorage,
        });

        try {
          return await provider.send(
            { messages },
            {
              signal: abortController.signal,
              onChunk: (delta) => {
                emitChatChunks(event, requestId, delta);
              },
            },
          );
        } catch (error) {
          if (error instanceof ChatProviderError) {
            throw new ActionExecutionError(error.code, error.message);
          }
          throw error;
        }
      });

      return chatSendResponseSchema.parse(toChatSendResponse(result));
    } finally {
      inFlightChatRequests.delete(requestId);
    }
  });

  ipcMain.handle(IPC_CHAT_CANCEL_CHANNEL, (_event, ...args: unknown[]) => {
    const [{ requestId }] = chatCancelRequestSchema.parse(args);
    // Best-effort and idempotent: a request that already finished, or one
    // that never existed, is simply not in the map — there is nothing to
    // abort, and that is not an error. No permission check applies here:
    // this cannot start a new action, read a secret, or reach the network
    // itself, it can only ask an already-authorized `chat:send` call
    // already in flight to stop early.
    inFlightChatRequests.get(requestId)?.abort();
    return chatCancelResponseSchema.parse({ acknowledged: true });
  });

  // -------------------------------------------------------------------------
  // Coding workspace (Phase 2, Milestone 5)
  //
  // Six channels, all read-only, all routed through the same unmodified
  // `runAction` -> `handleActionProposal` pipeline every other action-backed
  // channel above uses. There is no seventh channel that writes.
  // -------------------------------------------------------------------------

  /**
   * The project the user approved during *this* run.
   *
   * Created per `registerIpcHandlers` call, exactly like
   * {@link inFlightChatRequests} above and for the same reason: one test's
   * approved project can never leak into another's, and one application run's
   * grant never survives into the next. Nothing persists it to disk.
   */
  const workspaceSession = createWorkspaceSession();

  /**
   * Runs one workspace operation as a permission-gated, audited action.
   *
   * The `parameters` every caller passes below are deliberately thin —
   * `operation`, and at most a *length*. No path, no project name, no query
   * text and no file content ever enters an audit record: the milestone brief
   * requires sensitive paths and contents to be kept out of logs, and this is
   * the same discipline `chat.send` already applies by recording only
   * `{provider, messageCount}` rather than the conversation.
   *
   * A thrown {@link WorkspaceError} becomes an `ActionExecutionError` carrying
   * its normalized code, which is what `execute` already extracts into
   * `ActionResult.errorCode` — the same translation `secrets.write` performs
   * for `SecretStoreUnavailableError`.
   */
  async function runWorkspaceAction<TValue>(
    actionType: ActionType,
    parameters: Record<string, unknown>,
    perform: (now: string) => TValue | Promise<TValue>,
    /**
     * Builds the sentence shown in the native confirmation dialog, if the
     * verdict turns out to require one (Phase 2, Milestone 6).
     *
     * Built here, in the main process, from state the main process already
     * holds — a change set it stored, a registry entry, a fixed command
     * vector — never from the request. The renderer therefore cannot
     * influence what the user is asked, only that they are asked.
     *
     * Omitted for the read-only actions, which matches `runAction`'s own
     * contract: no callback is supplied, so a `confirm` verdict reaching one
     * of them fails loudly rather than silently proceeding unconfirmed.
     */
    buildConfirmation?: (now: string) => string | Promise<string>,
  ): Promise<ActionResult<TValue>> {
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);
    const confirmationMessage =
      buildConfirmation === undefined ? null : await buildConfirmation(now);

    return runAction(
      actionRuntime,
      newProposal(actionType, parameters),
      confirmationMessage,
      async () => {
        try {
          return await perform(now);
        } catch (error) {
          if (error instanceof WorkspaceError) {
            throw new ActionExecutionError(error.code, error.message);
          }
          throw error;
        }
      },
    );
  }

  ipcMain.handle(IPC_WORKSPACE_STATUS_CHANNEL, async (_event, ...args: unknown[]) => {
    workspaceStatusRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceProjectSummary | null>(
      'workspace.read',
      { operation: 'status' },
      () => {
        const project = workspaceSession.get();
        return project === null ? null : toProjectSummary(project);
      },
    );

    return workspaceStatusResponseSchema.parse(toWorkspaceProjectResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_SELECT_CHANNEL, async (_event, ...args: unknown[]) => {
    workspaceSelectRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceProjectSummary | null>(
      'workspace.select',
      { operation: 'select' },
      async (now) => {
        // The renderer contributed nothing to this call. The user chooses in
        // a native dialog the main process owns; a compromised renderer can
        // ask that the question be put, and nothing more.
        const chosenPath = await runtime.selectProjectDirectory();
        if (chosenPath === null) {
          // Dismissing the picker is the user declining, so it gets its own
          // code rather than a generic failure — the interface shows no
          // error for it, and the audit trail still records honestly that
          // the action did not complete.
          throw new WorkspaceError('WORKSPACE_SELECTION_CANCELLED');
        }

        const project = await adoptProjectDirectory({
          chosenPath,
          now,
          userDataDir: runtime.userDataPaths.userDataDir,
        });
        workspaceSession.set(project);
        return toProjectSummary(project);
      },
    );

    return workspaceSelectResponseSchema.parse(toWorkspaceProjectResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_TREE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ path }] = workspaceTreeRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceTree>(
      'workspace.read',
      { operation: 'tree' },
      () => listProjectTree(requireApprovedProject(workspaceSession), path),
    );

    return workspaceTreeResponseSchema.parse(toWorkspaceTreeResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_FILE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ path }] = workspaceFileRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceFile>(
      'workspace.read',
      { operation: 'file' },
      () => readProjectFile(requireApprovedProject(workspaceSession), path),
    );

    return workspaceFileResponseSchema.parse(toWorkspaceFileResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_SEARCH_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ query, path }] = workspaceSearchRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceSearchResult>(
      'workspace.read',
      // The query's *length*, never the query itself: a search term is user
      // content, and user content does not belong in a security log.
      { operation: 'search', queryLength: query.length },
      () => searchProject(requireApprovedProject(workspaceSession), query, path),
    );

    return workspaceSearchResponseSchema.parse(toWorkspaceSearchResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_PLAN_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ objective }] = workspacePlanRequestSchema.parse(args);

    const result = await runWorkspaceAction<CodingPlan>(
      'workspace.plan',
      { operation: 'plan', objectiveLength: objective.length },
      (now) => createCodingPlan(requireApprovedProject(workspaceSession), objective, now),
    );

    return workspacePlanResponseSchema.parse(toWorkspacePlanResponse(result));
  });

  // -------------------------------------------------------------------------
  // Controlled coding actions (Phase 2, Milestone 6)
  //
  // Ten channels. Four of them can change something, and every one of those
  // four routes through the same unmodified `runAction` ->
  // `handleActionProposal` pipeline as everything above, with a confirmation
  // message this process builds from state it already holds.
  // -------------------------------------------------------------------------

  /**
   * Proposed changes, held in the main process for the lifetime of this run.
   *
   * Per `registerIpcHandlers` call, exactly like {@link workspaceSession} and
   * {@link inFlightChatRequests}: one test's proposal never reaches another's,
   * and one application run's proposals never survive into the next.
   */
  const changeStore = createChangeStore({ backupsDir: runtime.userDataPaths.backupsDir });

  const gitRuntime: GitRuntime = { hooksDir: runtime.userDataPaths.gitHooksDir };

  /**
   * The one command allowed to be running, and how to stop it.
   *
   * A map rather than a single slot so `command:cancel` can address a run by
   * id without having to guess which one is current — and its size is the
   * concurrency limit, checked inside `perform` where the check and the claim
   * happen together and cannot race.
   */
  const inFlightCommandRuns = new Map<string, AbortController>();

  /**
   * Whether the emergency stop is engaged *right now*, re-read from disk.
   *
   * Passed to a running command so an engaged stop kills it. The permission
   * engine already refuses to start an action while the stop is engaged; this
   * is the other half, without which "emergency stop" would only mean "no new
   * work".
   */
  async function isEmergencyEngaged(): Promise<boolean> {
    const state = await loadEmergencyState(
      runtime.userDataPaths.emergencyStateFile,
      runtime.nowFn(),
    );
    return state.engaged;
  }

  /** Plain, exact text for the write confirmation, built from the stored change. */
  function describeChangeSet(change: WorkspaceChangeSet | null, verb: string): string {
    if (change === null) {
      return `${verb} a proposed change? The change is no longer held by this session, so nothing would be written.`;
    }
    const paths = change.files.map((file) => `  ${file.path}`).join('\n');
    return [
      `${verb} ${String(change.files.length)} file(s) in the approved project?`,
      '',
      paths,
      '',
      `+${String(change.totalAdded)} / -${String(change.totalRemoved)} lines.`,
      'A copy of the current contents is kept so the change can be undone.',
    ].join('\n');
  }

  /**
   * The sentence shown before a registry command starts.
   *
   * Extracted so that the interface's own `command:run` and an agent run's
   * verification step ask the **same** question, in the same words, built the
   * same way — from the registry entry and the project's own `package.json`,
   * never from a request. Two copies of a security dialog are two chances for
   * them to drift.
   */
  async function describeCommandRun(commandId: CommandIdValue): Promise<string> {
    const command = findCodingCommand(commandId);
    const project = workspaceSession.get();
    const catalog =
      project === null ? null : await buildCommandCatalog(project, false).catch(() => null);
    const descriptor = catalog?.commands.find((entry) => entry.id === commandId) ?? null;

    const lines = [
      `Run a command inside the approved project?`,
      '',
      `Command:   ${command === null ? commandId : describeCommandLine(command)}`,
      `Directory: ${project === null ? '(no project approved)' : project.rootPath}`,
    ];
    if (descriptor?.scriptPreview != null) {
      lines.push('', `The project defines this script as:`, `  ${descriptor.scriptPreview}`);
    }
    if (descriptor !== null && descriptor.risks.length > 0) {
      lines.push('', `Note: this script ${descriptor.risks.join(', ')}.`);
    }
    lines.push(
      '',
      'This runs code from the project you opened. Local Agent bounds how long it may run and how much it may print, but not what it does.',
    );
    return lines.join('\n');
  }

  ipcMain.handle(IPC_WORKSPACE_PROPOSE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ edits }] = workspaceProposeRequestSchema.parse(args);

    // Producing a diff writes nothing, so it is `workspace.plan` — the same
    // action type as the inert Milestone 5 plan, for the same reason.
    const result = await runWorkspaceAction<WorkspaceChangeSet>(
      'workspace.plan',
      { operation: 'propose', fileCount: edits.length },
      (now) =>
        changeStore.propose({
          project: requireApprovedProject(workspaceSession),
          edits,
          now,
        }),
    );

    return workspaceProposeResponseSchema.parse(toWorkspaceChangeResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_APPLY_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ changeId }] = workspaceApplyRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceChangeSet>(
      'workspace.write',
      // The number of files, never their paths: a path names a person, a
      // client or an unreleased product, and this follows the same rule the
      // Milestone 5 workspace parameters already do.
      { operation: 'apply', fileCount: changeStore.describe(changeId)?.files.length ?? 0 },
      (now) =>
        changeStore.apply({
          project: requireApprovedProject(workspaceSession),
          changeId,
          now,
        }),
      () => describeChangeSet(changeStore.describe(changeId), 'Overwrite'),
    );

    return workspaceApplyResponseSchema.parse(toWorkspaceChangeResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_ROLLBACK_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ changeId }] = workspaceRollbackRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceChangeSet>(
      'workspace.rollback',
      { operation: 'rollback', fileCount: changeStore.describe(changeId)?.files.length ?? 0 },
      (now) =>
        changeStore.rollback({
          project: requireApprovedProject(workspaceSession),
          changeId,
          now,
        }),
      () => describeChangeSet(changeStore.describe(changeId), 'Restore the previous contents of'),
    );

    return workspaceRollbackResponseSchema.parse(toWorkspaceChangeResponse(result));
  });

  ipcMain.handle(IPC_WORKSPACE_CHANGES_CHANNEL, async (_event, ...args: unknown[]) => {
    workspaceChangesRequestSchema.parse(args);

    const result = await runWorkspaceAction<WorkspaceChangeHistory>(
      'workspace.read',
      { operation: 'changes' },
      () => {
        requireApprovedProject(workspaceSession);
        return changeStore.history();
      },
    );

    return workspaceChangesResponseSchema.parse(toWorkspaceChangesResponse(result));
  });

  ipcMain.handle(IPC_COMMAND_LIST_CHANNEL, async (_event, ...args: unknown[]) => {
    commandListRequestSchema.parse(args);

    const result = await runWorkspaceAction<CommandCatalog>(
      'workspace.read',
      { operation: 'commands' },
      () =>
        buildCommandCatalog(requireApprovedProject(workspaceSession), inFlightCommandRuns.size > 0),
    );

    return commandListResponseSchema.parse(toCommandListResponse(result));
  });

  ipcMain.handle(IPC_COMMAND_RUN_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ runId, commandId }] = commandRunRequestSchema.parse(args);

    const result = await runWorkspaceAction<CommandRunResult>(
      'command.run',
      // The command's own identifier is a member of a fixed enum, not user
      // content, so recording it costs nothing and makes the audit trail
      // actually answer "what did it run".
      { operation: 'run', commandId },
      async (now) => {
        const approved = requireApprovedProject(workspaceSession);

        // Checked and claimed in the same step, inside `perform`, so two
        // concurrent requests cannot both pass the check.
        if (inFlightCommandRuns.size >= COMMAND_MAX_CONCURRENT_RUNS) {
          throw new WorkspaceError('COMMAND_ALREADY_RUNNING');
        }
        const abortController = new AbortController();
        inFlightCommandRuns.set(runId, abortController);

        try {
          return await runCodingCommand({
            project: approved,
            commandId,
            runId,
            startedAt: now,
            finishedAtFn: runtime.nowFn,
            signal: abortController.signal,
            isEmergencyEngaged,
          });
        } finally {
          inFlightCommandRuns.delete(runId);
        }
      },
      () => describeCommandRun(commandId),
    );

    return commandRunResponseSchema.parse(toCommandRunResponse(result));
  });

  ipcMain.handle(IPC_COMMAND_CANCEL_CHANNEL, (_event, ...args: unknown[]) => {
    const [{ runId }] = commandCancelRequestSchema.parse(args);
    // Best-effort and idempotent, exactly like `chat:cancel`, and ungated for
    // the same reason: this cannot start an action, read anything or reach
    // anything — it can only ask an already-authorized run to stop early.
    inFlightCommandRuns.get(runId)?.abort();
    return commandCancelResponseSchema.parse({ acknowledged: true });
  });

  ipcMain.handle(IPC_GIT_STATUS_CHANNEL, async (_event, ...args: unknown[]) => {
    gitStatusRequestSchema.parse(args);

    const result = await runWorkspaceAction<GitStatusValue>(
      'git.read',
      { operation: 'status' },
      () => readGitStatus(requireApprovedProject(workspaceSession), gitRuntime),
    );

    return gitStatusResponseSchema.parse(toGitStatusResponse(result));
  });

  ipcMain.handle(IPC_GIT_DIFF_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ path }] = gitDiffRequestSchema.parse(args);

    const result = await runWorkspaceAction<GitDiffValue>(
      'git.read',
      // Whether the diff was narrowed, never to what: a path is user content.
      { operation: 'diff', scoped: path !== null },
      () => readGitDiff(requireApprovedProject(workspaceSession), gitRuntime, path),
    );

    return gitDiffResponseSchema.parse(toGitDiffResponse(result));
  });

  ipcMain.handle(IPC_GIT_CHECKPOINT_CHANNEL, async (_event, ...args: unknown[]) => {
    gitCheckpointRequestSchema.parse(args);

    const project = workspaceSession.get();

    const result = await runWorkspaceAction<GitCheckpointValue>(
      'git.checkpoint',
      { operation: 'checkpoint' },
      (now) => createGitCheckpoint(requireApprovedProject(workspaceSession), gitRuntime, now),
      (now) =>
        [
          'Create a Git checkpoint commit in the approved project?',
          '',
          `Directory: ${project === null ? '(no project approved)' : project.rootPath}`,
          '',
          'Exactly these commands will run, and nothing else:',
          describeCheckpoint(now),
          '',
          'Nothing is reset, checked out, deleted or pushed. Repository hooks are disabled for this commit.',
        ].join('\n'),
    );

    return gitCheckpointResponseSchema.parse(toGitCheckpointResponse(result));
  });

  // -------------------------------------------------------------------------
  // Agent profiles and runs (Phase 2, Milestone 7)
  //
  // Eight channels, and not one of them is a new capability. Six read or
  // change *configuration*. `agent:run` executes a bounded sequence of the
  // actions this file already offered, each one still routed through the same
  // unmodified `runAction` -> `handleActionProposal` pipeline, decided on its
  // own action type, confirmed natively where the floor requires it, and
  // written to the audit log. `main/permissions.ts`, `main/executor.ts`,
  // `main/action-pipeline.ts` and `main/audit.ts` have zero diff for the
  // sixth consecutive milestone.
  // -------------------------------------------------------------------------

  /**
   * The one run allowed to be in flight, and how to stop it.
   *
   * Per `registerIpcHandlers` call, exactly like {@link inFlightCommandRuns}:
   * one test's run never reaches another's, and one application run's
   * cancellation handle never survives into the next.
   */
  const inFlightAgentRuns = new Map<string, AbortController>();

  /**
   * Runs one agent operation as a permission-gated, audited action.
   *
   * The same shape as {@link runWorkspaceAction}, differing only in which
   * normalized error vocabulary it translates. A `WorkspaceError` is
   * translated too, because a run's steps reach workspace code and a failure
   * there must not escape as a raw error.
   */
  async function runAgentAction<TValue>(
    actionType: ActionType,
    parameters: Record<string, unknown>,
    perform: (now: string) => TValue | Promise<TValue>,
    buildConfirmation?: (now: string) => string | Promise<string>,
  ): Promise<ActionResult<TValue>> {
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);
    const confirmationMessage =
      buildConfirmation === undefined ? null : await buildConfirmation(now);

    return runAction(
      actionRuntime,
      newProposal(actionType, parameters),
      confirmationMessage,
      async () => {
        try {
          return await perform(now);
        } catch (error) {
          if (error instanceof AgentError) {
            throw new ActionExecutionError(error.code, error.message);
          }
          if (error instanceof WorkspaceError) {
            throw new ActionExecutionError(error.code, error.message);
          }
          throw error;
        }
      },
    );
  }

  /**
   * The sentence shown before a profile is created, changed or removed.
   *
   * States what the profile would be allowed to reach for, in the same terms
   * the run dialog uses, because "what does this profile permit" is the only
   * question that matters when approving a profile edit. The name is
   * sanitized before it is interpolated: it is user-typed text about to be
   * shown inside a security prompt, which is the worst place for something
   * that can move the cursor or reorder itself.
   */
  function describeProfileWrite(
    verb: string,
    profileId: string,
    input: AgentProfileInput | null,
  ): string {
    const lines = [`${verb} the agent profile "${profileId}"?`];

    if (input !== null) {
      const tools =
        input.allowedTools.length === 0
          ? ['  (no tools — this profile would be able to do nothing)']
          : input.allowedTools.map((toolId) => {
              const tool = findAgentTool(toolId);
              return `  ${tool === null ? toolId : `${tool.label} (${tool.actionType})`}`;
            });
      const scope =
        input.approvedWorkspacePaths.length === 0
          ? ['  (nothing)']
          : input.approvedWorkspacePaths.map((path) =>
              path === '' ? '  the whole approved project' : `  ${path}`,
            );

      lines.push(
        '',
        `Name: ${collapseToSingleLine(input.name, AGENT_NAME_MAX_LENGTH)}`,
        '',
        'It would be allowed to use:',
        ...tools,
        '',
        'Limited to these parts of the approved project:',
        ...scope,
        '',
        `Per run: at most ${String(input.limits.maxSteps)} steps, ${String(Math.round(input.limits.maxDurationMs / 1000))}s, and ${String(input.limits.maxOutputBytes)} bytes of output.`,
      );
    }

    lines.push(
      '',
      'A profile can only narrow what the permission policy already allows. It cannot grant a permission, and there is no tool it can name that writes a file, undoes a write, or creates a commit.',
    );

    return lines.join('\n');
  }

  /** The sentence shown when a profile itself asks for a step to be confirmed. */
  function describeProfileGatedStep(request: AgentStepRequest): string {
    return [
      'The active agent profile requires confirmation before this step.',
      '',
      `Step:   ${request.tool.label}`,
      `Action: ${request.tool.actionType}`,
      '',
      'Approving this skips nothing else: the permission policy still decides the action afterwards, and a confirmation the policy itself requires is still asked separately.',
    ].join('\n');
  }

  /** Bounded, single-line, control-character-free wording for a step record. */
  function stepSummary(text: string): string {
    return collapseToSingleLine(text, AGENT_STEP_SUMMARY_MAX_LENGTH);
  }

  /**
   * Which provider this profile resolves to, given what is actually
   * configured right now.
   *
   * A provider is usable only when it is the one selected in settings *and*,
   * if it authenticates with a key, a key is actually present — read from the
   * reconciled settings, so a stale `hasApiKey` cannot make an unusable
   * provider look available. Nothing is called: this only records what would
   * carry a model request once one exists.
   */
  async function resolveRunProvider(profile: AgentProfile, now: string): Promise<ModelProvider> {
    const reconciled = await readReconciledSettings(runtime.userDataPaths, now);
    return resolveAgentProvider(profile, (candidate) => {
      if (candidate !== reconciled.modelProvider.provider) return false;
      if (!PROVIDERS_REQUIRING_API_KEY.includes(candidate)) return true;
      return reconciled.modelProvider.hasApiKey;
    });
  }

  /**
   * Builds the step executor for one run.
   *
   * A closure over the run's `AbortSignal` so that cancelling the run also
   * kills a child process the run started — without it, `agent:cancel` would
   * mean "take no further steps" while `npm test` kept running.
   *
   * Every branch below dispatches through {@link runWorkspaceAction}, the
   * same function the interface's own channels use. There is no path here
   * that reaches a workspace, command or Git operation without a permission
   * decision and an audit record.
   */
  function createAgentStepRunner(
    signal: AbortSignal,
  ): (request: AgentStepRequest) => Promise<AgentStepOutcome> {
    function settle<TValue>(
      result: ActionResult<TValue>,
      describe: (value: TValue) => string,
    ): AgentStepOutcome {
      if (result.outcome === 'success' && result.value !== undefined) {
        return {
          outcome: 'success',
          summary: stepSummary(describe(result.value)),
          outputBytes: measureOutputBytes(result.value),
        };
      }

      const errorCode = toWorkspaceErrorCode(result);
      const summary =
        result.outcome === 'denied'
          ? 'Refused before it ran, by the permission policy or the emergency stop.'
          : result.outcome === 'aborted'
            ? 'The confirmation was declined, so nothing ran.'
            : 'The step did not complete.';

      return {
        outcome: result.outcome,
        summary: stepSummary(summary),
        ...(errorCode === undefined ? {} : { errorCode }),
        outputBytes: 0,
      };
    }

    async function runCommandStep(commandId: CommandIdValue): Promise<AgentStepOutcome> {
      const stepRunId = randomUUID();

      const result = await runWorkspaceAction<CommandRunResult>(
        'command.run',
        { operation: 'agent-command', commandId },
        async (now) => {
          const approved = requireApprovedProject(workspaceSession);

          if (inFlightCommandRuns.size >= COMMAND_MAX_CONCURRENT_RUNS) {
            throw new WorkspaceError('COMMAND_ALREADY_RUNNING');
          }

          const controller = new AbortController();
          const forward = (): void => {
            controller.abort();
          };
          if (signal.aborted) controller.abort();
          else signal.addEventListener('abort', forward, { once: true });
          inFlightCommandRuns.set(stepRunId, controller);

          try {
            return await runCodingCommand({
              project: approved,
              commandId,
              runId: stepRunId,
              startedAt: now,
              finishedAtFn: runtime.nowFn,
              signal: controller.signal,
              isEmergencyEngaged,
            });
          } finally {
            signal.removeEventListener('abort', forward);
            inFlightCommandRuns.delete(stepRunId);
          }
        },
        // The same dialog, in the same words, the interface's own
        // `command:run` shows. A verification step inside an agent run does
        // not get a quieter path to starting a process than a person does.
        () => describeCommandRun(commandId),
      );

      if (result.outcome === 'success' && result.value !== undefined) {
        const run = result.value;
        // A command that ran and exited non-zero is a failure *of the thing
        // being checked*, and the step records it as `failure` so it cannot
        // satisfy a verification requirement. The action itself succeeded,
        // which is why `result.outcome` is not what is reported here.
        return {
          outcome: run.outcome === 'succeeded' ? 'success' : 'failure',
          summary: stepSummary(
            `${run.commandLine}: ${run.outcome} (exit ${run.exitCode === null ? 'none' : String(run.exitCode)}).`,
          ),
          outputBytes: measureOutputBytes(run.output),
        };
      }

      return settle(result, () => 'The command ran.');
    }

    return async (request: AgentStepRequest): Promise<AgentStepOutcome> => {
      // The profile's own extra gate, in front of the pipeline rather than
      // instead of it. A profile can only ever *add* this prompt: its
      // decision vocabulary has no `allow`, so nothing here can remove a
      // confirmation the floor requires or turn a denial into a permission.
      if (request.requiresConfirmation) {
        const answer = await runtime.requestConfirmation(describeProfileGatedStep(request));
        if (answer !== 'approved') {
          return {
            outcome: 'aborted',
            summary: stepSummary(`Declined: ${request.tool.label}.`),
            outputBytes: 0,
          };
        }
      }

      switch (request.step.tool) {
        case 'workspace.inspect': {
          const result = await runWorkspaceAction<WorkspaceTree>(
            'workspace.read',
            { operation: 'agent-tree' },
            () => listProjectTree(requireApprovedProject(workspaceSession), request.step.target),
          );
          return settle(
            result,
            (tree) =>
              `Listed ${String(tree.entries.length)} entries${tree.truncated ? ' (truncated)' : ''}.`,
          );
        }

        case 'workspace.search': {
          const query = request.step.query ?? '';
          const result = await runWorkspaceAction<WorkspaceSearchResult>(
            'workspace.read',
            // The query's length, never the query: the same rule the
            // interface's own search channel already follows.
            { operation: 'agent-search', queryLength: query.length },
            () =>
              searchProject(requireApprovedProject(workspaceSession), query, request.step.target),
          );
          return settle(
            result,
            (search) =>
              `Found ${String(search.matches.length)} matches across ${String(search.filesScanned)} files.`,
          );
        }

        case 'workspace.plan': {
          const result = await runWorkspaceAction<CodingPlan>(
            'workspace.plan',
            { operation: 'agent-plan', objectiveLength: request.objective.length },
            (now) =>
              createCodingPlan(requireApprovedProject(workspaceSession), request.objective, now),
          );
          return settle(
            result,
            (plan) =>
              `Produced a plan with ${String(plan.steps.length)} steps and ${String(plan.relevantFiles.length)} relevant files.`,
          );
        }

        case 'git.status': {
          const result = await runWorkspaceAction<GitStatusValue>(
            'git.read',
            { operation: 'agent-git-status' },
            () => readGitStatus(requireApprovedProject(workspaceSession), gitRuntime),
          );
          return settle(result, (status) =>
            status.clean
              ? 'The working tree is clean.'
              : `${String(status.entries.length)} changed paths in the working tree.`,
          );
        }

        case 'command.test':
        case 'command.lint':
        case 'command.typecheck': {
          const commandId = request.tool.commandId;
          if (commandId === null) {
            return {
              outcome: 'failure',
              summary: stepSummary('That tool names no command to run.'),
              outputBytes: 0,
            };
          }
          return runCommandStep(commandId);
        }
      }
    };
  }

  ipcMain.handle(IPC_AGENT_LIST_CHANNEL, async (_event, ...args: unknown[]) => {
    agentListRequestSchema.parse(args);

    const result = await runAgentAction<AgentRegistry>('agent.read', { operation: 'list' }, () =>
      readAgentRegistry(runtime.userDataPaths.agentProfilesFile),
    );

    return agentListResponseSchema.parse(toAgentRegistryResponse(result));
  });

  ipcMain.handle(IPC_AGENT_SELECT_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ profileId }] = agentSelectRequestSchema.parse(args);

    const result = await runAgentAction<AgentRegistry>(
      // Selecting cannot widen anything: every action a run later takes is
      // still decided by the permission engine against the same policy. That
      // is why this is its own action type rather than `agent.write`, and why
      // it is not on the confirmation floor — a native dialog for every
      // selection would train people to click through dialogs, which is its
      // own security problem.
      'agent.select',
      { operation: 'select', profileId },
      () => selectAgentProfile(runtime.userDataPaths.agentProfilesFile, profileId),
    );

    return agentSelectResponseSchema.parse(toAgentRegistryResponse(result));
  });

  ipcMain.handle(IPC_AGENT_CREATE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ profile }] = agentCreateRequestSchema.parse(args);

    const result = await runAgentAction<AgentRegistry>(
      'agent.write',
      { operation: 'create', profileId: profile.id, toolCount: profile.allowedTools.length },
      (now) => createAgentProfile(runtime.userDataPaths.agentProfilesFile, profile, now),
      () => describeProfileWrite('Create', profile.id, profile),
    );

    return agentCreateResponseSchema.parse(toAgentRegistryResponse(result));
  });

  ipcMain.handle(IPC_AGENT_UPDATE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ profileId, profile }] = agentUpdateRequestSchema.parse(args);

    const result = await runAgentAction<AgentRegistry>(
      'agent.write',
      { operation: 'update', profileId, toolCount: profile.allowedTools.length },
      (now) => updateAgentProfile(runtime.userDataPaths.agentProfilesFile, profileId, profile, now),
      () => describeProfileWrite('Replace', profileId, profile),
    );

    return agentUpdateResponseSchema.parse(toAgentRegistryResponse(result));
  });

  ipcMain.handle(IPC_AGENT_DELETE_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ profileId }] = agentDeleteRequestSchema.parse(args);

    const result = await runAgentAction<AgentRegistry>(
      'agent.write',
      { operation: 'delete', profileId },
      () => deleteAgentProfile(runtime.userDataPaths.agentProfilesFile, profileId),
      () => describeProfileWrite('Delete', profileId, null),
    );

    return agentDeleteResponseSchema.parse(toAgentRegistryResponse(result));
  });

  ipcMain.handle(IPC_AGENT_SET_ENABLED_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ profileId, enabled }] = agentSetEnabledRequestSchema.parse(args);

    const result = await runAgentAction<AgentRegistry>(
      'agent.write',
      { operation: 'set-enabled', profileId, enabled },
      (now) =>
        setAgentProfileEnabled(runtime.userDataPaths.agentProfilesFile, profileId, enabled, now),
      () => describeProfileWrite(enabled ? 'Enable' : 'Disable', profileId, null),
    );

    return agentSetEnabledResponseSchema.parse(toAgentRegistryResponse(result));
  });

  ipcMain.handle(IPC_AGENT_RUN_CHANNEL, async (_event, ...args: unknown[]) => {
    const [{ runId, objective }] = agentRunRequestSchema.parse(args);

    // Read once, up front, so the dialog the user reads and the run that
    // follows describe the same profile — and read from the *store*, never
    // from the request, so a compromised renderer cannot widen a run by
    // describing it differently.
    const registry = await readAgentRegistry(runtime.userDataPaths.agentProfilesFile);
    const profile = resolveActiveProfile(registry);
    const plan = buildAgentPlan(profile, objective);
    const provider = await resolveRunProvider(profile, runtime.nowFn());

    const result = await runAgentAction<AgentRun>(
      'agent.run',
      {
        operation: 'run',
        // The profile id, never the objective. An id is a bounded, lowercase
        // slug the schema constrains to `[a-z0-9._-]`, and recording it is
        // what lets the audit trail answer "which profile authorized this" —
        // the same reasoning that puts `commandId` in a command record. The
        // objective is user content, so only its length is recorded.
        profileId: profile.id,
        plannedSteps: plan.steps.length,
        objectiveLength: objective.length,
      },
      async (now) => {
        if (inFlightAgentRuns.size > 0) throw new AgentError('AGENT_RUN_ALREADY_RUNNING');
        if (!profile.enabled) throw new AgentError('AGENT_PROFILE_DISABLED');

        const controller = new AbortController();
        inFlightAgentRuns.set(runId, controller);

        try {
          return await runAgentOrchestration({
            runId,
            profile,
            objective,
            provider,
            startedAt: now,
            nowFn: runtime.nowFn,
            monotonicMs: () => Date.now(),
            signal: controller.signal,
            isEmergencyEngaged,
            hasProject: () => workspaceSession.get() !== null,
            runStep: createAgentStepRunner(controller.signal),
          });
        } finally {
          inFlightAgentRuns.delete(runId);
        }
      },
      () => describeAgentRun(profile, plan.steps.length),
    );

    return agentRunResponseSchema.parse(toAgentRunResponse(result));
  });

  ipcMain.handle(IPC_AGENT_CANCEL_CHANNEL, (_event, ...args: unknown[]) => {
    const [{ runId }] = agentCancelRequestSchema.parse(args);
    // Best-effort and idempotent, exactly like `chat:cancel` and
    // `command:cancel`, and ungated for the same reason: it cannot start an
    // action, read anything or reach anything — only ask an
    // already-authorized run to stop early. Aborting the run's signal also
    // kills a child process the run had started.
    inFlightAgentRuns.get(runId)?.abort();
    return agentCancelResponseSchema.parse({ acknowledged: true });
  });
}
