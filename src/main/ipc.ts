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
 */

import { randomUUID } from 'node:crypto';

import type { IpcMain, SafeStorage } from 'electron';

import { runAction } from './action-runtime';
import type { ActionRuntime } from './action-runtime';
import { resolveMainChatProvider } from './chat-provider-registry';
import { ActionExecutionError } from './executor';
import type { UserDataPaths } from './paths';
import { clearSecret, SecretStoreUnavailableError, writeSecret } from './secrets';
import {
  readReconciledSettings,
  refreshHasApiKeyAfterSecretChange,
  writeOnboardingSettings,
} from './settings-service';
import { loadSettings } from './settings';
import { CHAT_PROVIDER_ERROR_CODES, ChatProviderError } from '../shared/chat/provider';
import type { ChatProviderResult } from '../shared/chat/provider';
import { PROVIDERS_REQUIRING_API_KEY } from '../shared/constants';
import {
  chatCancelRequestSchema,
  chatCancelResponseSchema,
  chatSendRequestSchema,
  chatSendResponseSchema,
  healthCheckRequestSchema,
  healthCheckResponseSchema,
  IPC_CHAT_CANCEL_CHANNEL,
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
} from '../shared/schemas';
import type {
  ChatSendResponse,
  SecretsActionResponse,
  SecretStatusResult,
  SettingsActionResponse,
  Settings,
} from '../shared/schemas';
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

  ipcMain.handle(IPC_CHAT_SEND_CHANNEL, async (_event, ...args: unknown[]) => {
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
          return await provider.send({ messages }, { signal: abortController.signal });
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
}
