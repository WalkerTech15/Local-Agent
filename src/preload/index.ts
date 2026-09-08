import { contextBridge, ipcRenderer } from 'electron';

import {
  chatCancelResponseSchema,
  chatChunkEventSchema,
  chatSendResponseSchema,
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
  secretsClearResponseSchema,
  secretsStatusResponseSchema,
  secretsWriteResponseSchema,
  settingsGetResponseSchema,
  settingsUpdateResponseSchema,
  IPC_WORKSPACE_FILE_CHANNEL,
  IPC_WORKSPACE_PLAN_CHANNEL,
  IPC_WORKSPACE_SEARCH_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
  IPC_WORKSPACE_STATUS_CHANNEL,
  IPC_WORKSPACE_TREE_CHANNEL,
  workspaceFileResponseSchema,
  workspacePlanResponseSchema,
  workspaceSearchResponseSchema,
  workspaceSelectResponseSchema,
  workspaceStatusResponseSchema,
  workspaceTreeResponseSchema,
  type ChatChunkEvent,
  type ChatMessage,
  type ChatSendResponse,
  type HealthCheckResponse,
  type SecretsActionResponse,
  type SettingsActionResponse,
  type SettingsUpdateInput,
  type WorkspaceFileResponse,
  type WorkspacePlanResponse,
  type WorkspaceProjectResponse,
  type WorkspaceSearchResponse,
  type WorkspaceTreeResponse,
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
 *
 * `chat.onChunk` (Phase 2, Milestone 4) is the single exception to
 * "everything here is a request": it subscribes to one fixed, one-way event
 * channel. It is held to the same rules — a fixed channel name, no
 * `ipcRenderer`, no raw Electron event, a validated payload — and returns an
 * unsubscribe function so a listener's lifetime is the caller's to end. See
 * its own doc comment below.
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
    /**
     * Subscribes to streaming previews for in-flight `chat.send` calls
     * (Phase 2, Milestone 4), returning an unsubscribe function.
     *
     * The one place this bridge exposes a main → renderer *event* rather
     * than a request, and deliberately the narrowest possible form of one:
     *
     *  - the channel is fixed here, never a caller-supplied name, so this
     *    cannot become a generic "listen to any channel" surface any more
     *    than `send` could become a generic invoke;
     *  - `ipcRenderer` itself is never handed out, and neither is the raw
     *    Electron event — the listener receives only a validated
     *    {@link ChatChunkEvent}, never the `IpcRendererEvent` (which carries
     *    `sender` and reply handles a renderer has no business holding);
     *  - a payload that fails {@link chatChunkEventSchema} is dropped
     *    silently rather than forwarded or thrown, so a malformed or
     *    hostile event cannot reach renderer code or break its event loop;
     *  - a listener that throws is contained here, for the same reason.
     */
    onChunk: (listener: (event: ChatChunkEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const parsed = chatChunkEventSchema.safeParse(payload);
        if (!parsed.success) return;
        try {
          listener(parsed.data);
        } catch {
          // A failing preview listener must not break the IPC event loop.
        }
      };

      ipcRenderer.on(IPC_CHAT_CHUNK_CHANNEL, handler);
      return () => {
        ipcRenderer.off(IPC_CHAT_CHUNK_CHANNEL, handler);
      };
    },
  },
  /**
   * The read-only coding workspace (Phase 2, Milestone 5).
   *
   * Six functions, six fixed channels, and — the property worth checking
   * first — **no way to name a directory**. `select` takes no argument at
   * all: the main process opens a native picker and the user chooses, so
   * nothing on this bridge can point the application at a directory of the
   * caller's choosing. Every other function takes a path *relative* to
   * whatever the user already approved, which the main process validates for
   * containment before it touches the filesystem and re-validates after
   * resolving it.
   *
   * There is no `write`, no `create`, no `delete` and no `apply`. The absence
   * is the control: a renderer cannot ask for a modification because no
   * function here expresses one.
   */
  workspace: {
    status: async (): Promise<WorkspaceProjectResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_STATUS_CHANNEL);
      return workspaceStatusResponseSchema.parse(result);
    },
    select: async (): Promise<WorkspaceProjectResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_SELECT_CHANNEL);
      return workspaceSelectResponseSchema.parse(result);
    },
    tree: async (path: string): Promise<WorkspaceTreeResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_TREE_CHANNEL, { path });
      return workspaceTreeResponseSchema.parse(result);
    },
    file: async (path: string): Promise<WorkspaceFileResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_FILE_CHANNEL, { path });
      return workspaceFileResponseSchema.parse(result);
    },
    search: async (query: string, path: string): Promise<WorkspaceSearchResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_SEARCH_CHANNEL, {
        query,
        path,
      });
      return workspaceSearchResponseSchema.parse(result);
    },
    plan: async (objective: string): Promise<WorkspacePlanResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_PLAN_CHANNEL, { objective });
      return workspacePlanResponseSchema.parse(result);
    },
  },
};

contextBridge.exposeInMainWorld('localAgent', bridge);

export type LocalAgentBridge = typeof bridge;
