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

import { runAction } from './action-runtime';
import type { ActionRuntime } from './action-runtime';
import { resolveMainChatProvider } from './chat-provider-registry';
import { ActionExecutionError } from './executor';
import type { UserDataPaths } from './paths';
import { clearSecret, SecretStoreUnavailableError, writeSecret } from './secrets';
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
import { CHAT_PROVIDER_ERROR_CODES, ChatProviderError } from '../shared/chat/provider';
import type { ChatProviderResult } from '../shared/chat/provider';
import { CHAT_STREAM_MAX_DELTA_LENGTH, PROVIDERS_REQUIRING_API_KEY } from '../shared/constants';
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
} from '../shared/schemas';
import type {
  ChatSendResponse,
  CodingPlan,
  SecretsActionResponse,
  SecretStatusResult,
  SettingsActionResponse,
  Settings,
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
  ): Promise<ActionResult<TValue>> {
    const now = runtime.nowFn();
    const actionRuntime = buildActionRuntime(runtime, now);

    return runAction(actionRuntime, newProposal(actionType, parameters), null, async () => {
      try {
        return await perform(now);
      } catch (error) {
        if (error instanceof WorkspaceError) {
          throw new ActionExecutionError(error.code, error.message);
        }
        throw error;
      }
    });
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
}
