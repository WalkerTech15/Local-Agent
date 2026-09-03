import { contextBridge, ipcRenderer } from 'electron';

import {
  chatCancelResponseSchema,
  chatSendResponseSchema,
  healthCheckResponseSchema,
  IPC_CHAT_CANCEL_CHANNEL,
  IPC_CHAT_SEND_CHANNEL,
  IPC_HEALTH_CHANNEL,
  IPC_SECRETS_CLEAR_CHANNEL,
  IPC_SECRETS_STATUS_CHANNEL,
  IPC_SECRETS_WRITE_CHANNEL,
  IPC_SETTINGS_GET_CHANNEL,
  IPC_SETTINGS_UPDATE_CHANNEL,
  secretsClearResponseSchema,
  secretsStatusResponseSchema,
  secretsWriteResponseSchema,
  settingsGetResponseSchema,
  settingsUpdateResponseSchema,
  type ChatMessage,
  type ChatSendResponse,
  type HealthCheckResponse,
  type SecretsActionResponse,
  type SettingsActionResponse,
  type SettingsUpdateInput,
} from '../shared/schemas';

/**
 * The narrow, explicitly enumerated API exposed to the renderer.
 *
 * Nothing here forwards `ipcRenderer` itself and nothing here accepts a
 * caller-supplied channel name: each function calls exactly one fixed
 * channel, so the renderer can request only what is listed below, never an
 * arbitrary IPC channel. Every result is re-validated against the shared
 * response schema before it leaves this module, so a malformed reply from a
 * compromised or buggy main process cannot reach the renderer looking valid.
 *
 * There is deliberately no function here that can return a plaintext API
 * key — `secrets.write` takes one as input and returns only
 * {@link SecretsActionResponse}'s boolean-shaped `status`, never the key
 * back. Requests still cross to the main process even when they carry
 * user-typed input (`settings.update`, `secrets.write`): validation of that
 * input is `main/ipc.ts`'s job, the actual trust boundary, not this bridge's
 * — this module's own responsibility is only the channel allowlist and the
 * response shape.
 */
const bridge = {
  health: async (): Promise<HealthCheckResponse> => {
    const result: unknown = await ipcRenderer.invoke(IPC_HEALTH_CHANNEL);
    return healthCheckResponseSchema.parse(result);
  },
  settings: {
    get: async (): Promise<SettingsActionResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_SETTINGS_GET_CHANNEL);
      return settingsGetResponseSchema.parse(result);
    },
    update: async (input: SettingsUpdateInput): Promise<SettingsActionResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_SETTINGS_UPDATE_CHANNEL, input);
      return settingsUpdateResponseSchema.parse(result);
    },
  },
  secrets: {
    status: async (): Promise<SecretsActionResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_SECRETS_STATUS_CHANNEL);
      return secretsStatusResponseSchema.parse(result);
    },
    write: async (apiKey: string): Promise<SecretsActionResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey });
      return secretsWriteResponseSchema.parse(result);
    },
    clear: async (): Promise<SecretsActionResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_SECRETS_CLEAR_CHANNEL);
      return secretsClearResponseSchema.parse(result);
    },
  },
  /**
   * The one network-capable pair of channels (Phase 2, Milestone 3). Neither
   * accepts or returns an API key, a header, or a provider URL — `send`
   * takes only the conversation itself; the main process resolves which
   * provider and which stored credential to use from settings and the
   * encrypted secret store, never from a renderer-supplied value. `cancel`
   * is fire-and-forget best effort: it asks the main process to abort a
   * `send` already in flight, identified by the same `requestId`.
   */
  chat: {
    send: async (
      requestId: string,
      messages: readonly ChatMessage[],
    ): Promise<ChatSendResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_CHAT_SEND_CHANNEL, {
        requestId,
        messages,
      });
      return chatSendResponseSchema.parse(result);
    },
    cancel: async (requestId: string): Promise<void> => {
      const result: unknown = await ipcRenderer.invoke(IPC_CHAT_CANCEL_CHANNEL, { requestId });
      chatCancelResponseSchema.parse(result);
    },
  },
};

contextBridge.exposeInMainWorld('localAgent', bridge);

export type LocalAgentBridge = typeof bridge;
