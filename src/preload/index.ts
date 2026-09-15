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
  commandCancelResponseSchema,
  commandListResponseSchema,
  commandRunResponseSchema,
  gitCheckpointResponseSchema,
  gitDiffResponseSchema,
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
  workspaceApplyResponseSchema,
  workspaceChangesResponseSchema,
  workspaceProposeResponseSchema,
  workspaceRollbackResponseSchema,
  agentCancelResponseSchema,
  agentCreateResponseSchema,
  agentDeleteResponseSchema,
  agentListResponseSchema,
  agentRunResponseSchema,
  agentSelectResponseSchema,
  agentSetEnabledResponseSchema,
  agentUpdateResponseSchema,
  IPC_AGENT_CANCEL_CHANNEL,
  IPC_AGENT_CREATE_CHANNEL,
  IPC_AGENT_DELETE_CHANNEL,
  IPC_AGENT_LIST_CHANNEL,
  IPC_AGENT_RUN_CHANNEL,
  IPC_AGENT_SELECT_CHANNEL,
  IPC_AGENT_SET_ENABLED_CHANNEL,
  IPC_AGENT_UPDATE_CHANNEL,
  IPC_MEMORY_ADD_CHANNEL,
  IPC_MEMORY_CLEAR_CHANNEL,
  IPC_MEMORY_DELETE_CHANNEL,
  IPC_MEMORY_EXPORT_CHANNEL,
  IPC_MEMORY_IMPORT_CHANNEL,
  IPC_MEMORY_LIST_CHANNEL,
  IPC_MEMORY_RETRIEVE_CHANNEL,
  IPC_MEMORY_SEARCH_CHANNEL,
  IPC_MEMORY_SET_PINNED_CHANNEL,
  IPC_MEMORY_UPDATE_CHANNEL,
  memoryAddResponseSchema,
  memoryClearResponseSchema,
  memoryDeleteResponseSchema,
  memoryExportResponseSchema,
  memoryImportResponseSchema,
  memoryListResponseSchema,
  memoryRetrieveResponseSchema,
  memorySearchResponseSchema,
  memorySetPinnedResponseSchema,
  memoryUpdateResponseSchema,
  type MemoryMutationResponse,
  type MemoryQueryResponse,
  type MemoryRecordInput,
  type MemoryRecordResponse,
  type MemoryRetrieveResponse,
  type MemoryScopeValue,
  IPC_WORKFLOW_CANCEL_CHANNEL,
  IPC_WORKFLOW_CREATE_CHANNEL,
  IPC_WORKFLOW_DELETE_CHANNEL,
  IPC_WORKFLOW_DUPLICATE_CHANNEL,
  IPC_WORKFLOW_LIST_CHANNEL,
  IPC_WORKFLOW_PAUSE_CHANNEL,
  IPC_WORKFLOW_PROGRESS_CHANNEL,
  IPC_WORKFLOW_RUN_CHANNEL,
  IPC_WORKFLOW_SET_ENABLED_CHANNEL,
  IPC_WORKFLOW_UPDATE_CHANNEL,
  workflowControlResponseSchema,
  workflowCreateResponseSchema,
  workflowDeleteResponseSchema,
  workflowDuplicateResponseSchema,
  workflowListResponseSchema,
  workflowProgressIpcEventSchema,
  workflowRunResponseSchema,
  workflowSetEnabledResponseSchema,
  workflowUpdateResponseSchema,
  type WorkflowInput,
  type WorkflowListResponse,
  type WorkflowProgressEvent,
  type WorkflowRunResponse,
  type AgentProfileInput,
  type AgentRegistryResponse,
  type AgentRunResponse,
  type CommandIdValue,
  type CommandListResponse,
  type CommandRunResponse,
  type GitCheckpointResponse,
  type GitDiffResponse,
  type GitStatusResponse,
  type WorkspaceChangeResponse,
  type WorkspaceChangesResponse,
  type WorkspaceEdit,
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
    /**
     * Proposes a change and gets back a diff (Phase 2, Milestone 6).
     *
     * The only function on this bridge that carries file content, and it
     * writes nothing: the main process keeps the proposal and answers with a
     * diff to show. Applying it is {@link LocalAgentBridge.coding}'s `apply`,
     * which takes an id.
     */
    propose: async (edits: readonly WorkspaceEdit[]): Promise<WorkspaceChangeResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, { edits });
      return workspaceProposeResponseSchema.parse(result);
    },
    /**
     * Applies a change the main process already holds, already diffed and
     * already shown.
     *
     * Takes a change id and nothing else — no path, no content, no
     * destination — so the bytes written are necessarily the bytes that were
     * diffed. There is no function here that writes content directly, and
     * none that creates or deletes a file.
     */
    apply: async (changeId: string): Promise<WorkspaceChangeResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });
      return workspaceApplyResponseSchema.parse(result);
    },
    /** Restores the backup taken before the most recent applied change. */
    rollback: async (changeId: string): Promise<WorkspaceChangeResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_ROLLBACK_CHANNEL, {
        changeId,
      });
      return workspaceRollbackResponseSchema.parse(result);
    },
    changes: async (): Promise<WorkspaceChangesResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKSPACE_CHANGES_CHANNEL);
      return workspaceChangesResponseSchema.parse(result);
    },
  },
  /**
   * The command registry (Phase 2, Milestone 6).
   *
   * `run` takes an identifier from a five-value enum. There is no parameter
   * here for a command string, an argument, a shell, a working directory or
   * an environment variable — so this bridge cannot express an arbitrary
   * command, in the same way `workspace.select` cannot express a directory.
   * `cancel` is fire-and-forget best effort, exactly like `chat.cancel`.
   */
  command: {
    list: async (): Promise<CommandListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_COMMAND_LIST_CHANNEL);
      return commandListResponseSchema.parse(result);
    },
    run: async (runId: string, commandId: CommandIdValue): Promise<CommandRunResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_COMMAND_RUN_CHANNEL, {
        runId,
        commandId,
      });
      return commandRunResponseSchema.parse(result);
    },
    cancel: async (runId: string): Promise<void> => {
      const result: unknown = await ipcRenderer.invoke(IPC_COMMAND_CANCEL_CHANNEL, { runId });
      commandCancelResponseSchema.parse(result);
    },
  },
  /**
   * Git (Phase 2, Milestone 6).
   *
   * `status` and `diff` read. `checkpoint` takes no argument at all: the
   * branch is whatever is already checked out, the message is generated by
   * the main process, and the command vector is fixed — so nothing here can
   * name a ref, a remote, a branch or a commit message, and there is no
   * function for a reset, a checkout, a push or a delete.
   */
  /**
   * Agent profiles and runs (Phase 2, Milestone 7).
   *
   * Eight functions, eight fixed channels, and — the property worth checking
   * first — **none of them can grant a permission**. `create` and `update`
   * carry a profile whose own permission entries are `confirm` or `deny`;
   * `allow` is not a member of that enum, so "permit this" is not
   * expressible through this bridge at all.
   *
   * `run` takes a run id and an objective. It cannot carry a step list, a
   * tool, a path, a command or a limit: what a run may do comes from the
   * profile the main process reads from disk, so a compromised renderer can
   * ask for a run and cannot widen one. `cancel` is fire-and-forget best
   * effort, exactly like `chat.cancel` and `command.cancel`.
   */
  agent: {
    list: async (): Promise<AgentRegistryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_LIST_CHANNEL);
      return agentListResponseSchema.parse(result);
    },
    select: async (profileId: string): Promise<AgentRegistryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_SELECT_CHANNEL, { profileId });
      return agentSelectResponseSchema.parse(result);
    },
    create: async (profile: AgentProfileInput): Promise<AgentRegistryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_CREATE_CHANNEL, { profile });
      return agentCreateResponseSchema.parse(result);
    },
    update: async (
      profileId: string,
      profile: AgentProfileInput,
    ): Promise<AgentRegistryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_UPDATE_CHANNEL, {
        profileId,
        profile,
      });
      return agentUpdateResponseSchema.parse(result);
    },
    remove: async (profileId: string): Promise<AgentRegistryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_DELETE_CHANNEL, { profileId });
      return agentDeleteResponseSchema.parse(result);
    },
    setEnabled: async (profileId: string, enabled: boolean): Promise<AgentRegistryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_SET_ENABLED_CHANNEL, {
        profileId,
        enabled,
      });
      return agentSetEnabledResponseSchema.parse(result);
    },
    run: async (runId: string, objective: string): Promise<AgentRunResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_RUN_CHANNEL, {
        runId,
        objective,
      });
      return agentRunResponseSchema.parse(result);
    },
    cancel: async (runId: string): Promise<void> => {
      const result: unknown = await ipcRenderer.invoke(IPC_AGENT_CANCEL_CHANNEL, { runId });
      agentCancelResponseSchema.parse(result);
    },
  },
  /**
   * Local memory (Phase 2, Milestone 8).
   *
   * Ten functions, ten fixed channels, and three properties worth checking
   * first:
   *
   *  - **Nothing here can name a file.** `exportScope` and `importScope` take
   *    a scope and nothing else; the file is chosen by the user in a native
   *    dialog the main process owns. There is no path parameter anywhere in
   *    this object.
   *  - **Nothing here can label a record's provenance.** The add and update
   *    payloads have no `source` field — the main process stamps `user` or
   *    `import`, so a compromised renderer cannot pass imported content off
   *    as something the person typed.
   *  - **Nothing here can move a record between scopes.** An update addresses
   *    a record inside the scope its own record names, and a stored record
   *    found elsewhere is refused rather than relocated.
   */
  memory: {
    list: async (scope: MemoryScopeValue): Promise<MemoryQueryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_LIST_CHANNEL, { scope });
      return memoryListResponseSchema.parse(result);
    },
    search: async (scope: MemoryScopeValue, query: string): Promise<MemoryQueryResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_SEARCH_CHANNEL, {
        scope,
        query,
      });
      return memorySearchResponseSchema.parse(result);
    },
    retrieve: async (objective: string): Promise<MemoryRetrieveResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_RETRIEVE_CHANNEL, { objective });
      return memoryRetrieveResponseSchema.parse(result);
    },
    add: async (record: MemoryRecordInput): Promise<MemoryRecordResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_ADD_CHANNEL, { record });
      return memoryAddResponseSchema.parse(result);
    },
    update: async (id: string, record: MemoryRecordInput): Promise<MemoryRecordResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_UPDATE_CHANNEL, { id, record });
      return memoryUpdateResponseSchema.parse(result);
    },
    setPinned: async (
      id: string,
      scope: MemoryScopeValue,
      pinned: boolean,
    ): Promise<MemoryRecordResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_SET_PINNED_CHANNEL, {
        id,
        scope,
        pinned,
      });
      return memorySetPinnedResponseSchema.parse(result);
    },
    remove: async (id: string, scope: MemoryScopeValue): Promise<MemoryMutationResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_DELETE_CHANNEL, { id, scope });
      return memoryDeleteResponseSchema.parse(result);
    },
    clear: async (scope: MemoryScopeValue): Promise<MemoryMutationResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_CLEAR_CHANNEL, { scope });
      return memoryClearResponseSchema.parse(result);
    },
    exportScope: async (scope: MemoryScopeValue): Promise<MemoryMutationResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_EXPORT_CHANNEL, { scope });
      return memoryExportResponseSchema.parse(result);
    },
    importScope: async (scope: MemoryScopeValue): Promise<MemoryMutationResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_MEMORY_IMPORT_CHANNEL, { scope });
      return memoryImportResponseSchema.parse(result);
    },
  },
  /**
   * Workflows (Phase 2, Milestone 9).
   *
   * Nine functions, nine fixed channels, one subscription, and three
   * properties worth checking first:
   *
   *  - **Nothing here can schedule anything.** A workflow's `trigger` is an
   *    enum with one member, `manual`, so a payload cannot express a
   *    schedule, a file watch, a Git hook or an inbox. There is no `schedule`
   *    function and no `watch` function.
   *  - **Nothing here can widen an agent.** A workflow selects a profile by
   *    id and may only use tools and paths that profile already allows,
   *    checked in the main process when it is saved and again before every
   *    step.
   *  - **`run` takes a workflow id and an objective.** It cannot carry a step
   *    list, a tool, a path, a command or a limit: what a run may do comes
   *    from the stored definition the main process reads.
   *
   * `pause` stops a run at the next step boundary; `cancel` aborts it and
   * kills a child process it had started. Both are fire-and-forget, exactly
   * like `agent.cancel`.
   */
  workflow: {
    list: async (): Promise<WorkflowListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_LIST_CHANNEL);
      return workflowListResponseSchema.parse(result);
    },
    create: async (workflow: WorkflowInput): Promise<WorkflowListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_CREATE_CHANNEL, { workflow });
      return workflowCreateResponseSchema.parse(result);
    },
    update: async (workflowId: string, workflow: WorkflowInput): Promise<WorkflowListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_UPDATE_CHANNEL, {
        workflowId,
        workflow,
      });
      return workflowUpdateResponseSchema.parse(result);
    },
    duplicate: async (workflowId: string, newId: string): Promise<WorkflowListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_DUPLICATE_CHANNEL, {
        workflowId,
        newId,
      });
      return workflowDuplicateResponseSchema.parse(result);
    },
    remove: async (workflowId: string): Promise<WorkflowListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_DELETE_CHANNEL, { workflowId });
      return workflowDeleteResponseSchema.parse(result);
    },
    setEnabled: async (workflowId: string, enabled: boolean): Promise<WorkflowListResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_SET_ENABLED_CHANNEL, {
        workflowId,
        enabled,
      });
      return workflowSetEnabledResponseSchema.parse(result);
    },
    run: async (
      runId: string,
      workflowId: string,
      objective: string,
    ): Promise<WorkflowRunResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_RUN_CHANNEL, {
        runId,
        workflowId,
        objective,
      });
      return workflowRunResponseSchema.parse(result);
    },
    pause: async (runId: string): Promise<void> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_PAUSE_CHANNEL, { runId });
      workflowControlResponseSchema.parse(result);
    },
    cancel: async (runId: string): Promise<void> => {
      const result: unknown = await ipcRenderer.invoke(IPC_WORKFLOW_CANCEL_CHANNEL, { runId });
      workflowControlResponseSchema.parse(result);
    },
    /**
     * Subscribes to advisory progress for a run in flight.
     *
     * Modelled exactly on `chat.onChunk`: the listener never receives the raw
     * Electron event, every payload is re-validated here before it reaches
     * the renderer, and an invalid one is dropped rather than forwarded.
     */
    onProgress: (listener: (event: WorkflowProgressEvent) => void): (() => void) => {
      const subscription = (_event: unknown, payload: unknown): void => {
        const parsed = workflowProgressIpcEventSchema.safeParse(payload);
        if (!parsed.success) return;
        listener(parsed.data);
      };
      ipcRenderer.on(IPC_WORKFLOW_PROGRESS_CHANNEL, subscription);
      return () => {
        ipcRenderer.removeListener(IPC_WORKFLOW_PROGRESS_CHANNEL, subscription);
      };
    },
  },
  git: {
    status: async (): Promise<GitStatusResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_GIT_STATUS_CHANNEL);
      return gitStatusResponseSchema.parse(result);
    },
    diff: async (path: string | null): Promise<GitDiffResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_GIT_DIFF_CHANNEL, { path });
      return gitDiffResponseSchema.parse(result);
    },
    checkpoint: async (): Promise<GitCheckpointResponse> => {
      const result: unknown = await ipcRenderer.invoke(IPC_GIT_CHECKPOINT_CHANNEL);
      return gitCheckpointResponseSchema.parse(result);
    },
  },
};

contextBridge.exposeInMainWorld('localAgent', bridge);

export type LocalAgentBridge = typeof bridge;
