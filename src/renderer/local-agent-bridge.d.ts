/**
 * Ambient type for `window.localAgent`.
 *
 * Mirrors `src/preload/index.ts`'s bridge shape independently rather than
 * importing it: the renderer and the preload script are separate build
 * targets (`vite.config.ts` and `vite.preload.config.ts`), and this keeps the
 * renderer's type graph from depending on preload's module, exactly as the
 * original Milestone 2 declaration depended only on `../shared/schemas`.
 */

import type {
  AgentProfileInput,
  AgentRegistryResponse,
  AgentRunResponse,
  AutomationListResponse,
  AutomationRunResponse,
  ChatChunkEvent,
  ChatMessage,
  ChatSendResponse,
  CommandIdValue,
  CommandListResponse,
  CommandRunResponse,
  GitCheckpointResponse,
  GitDiffResponse,
  GitStatusResponse,
  HealthCheckResponse,
  MemoryMutationResponse,
  MemoryQueryResponse,
  MemoryRecordInput,
  MemoryRecordResponse,
  MemoryRetrieveResponse,
  MemoryScopeValue,
  SecretsActionResponse,
  SettingsActionResponse,
  SettingsUpdateInput,
  WorkspaceChangeResponse,
  WorkspaceChangesResponse,
  WorkspaceEdit,
  WorkspaceFileResponse,
  WorkspacePlanResponse,
  WorkspaceProjectResponse,
  WorkflowInput,
  WorkflowListResponse,
  WorkflowProgressEvent,
  WorkflowRunResponse,
  WorkspaceSearchResponse,
  WorkspaceTreeResponse,
} from '../shared/schemas';

export {};

declare global {
  interface Window {
    readonly localAgent: {
      readonly health: () => Promise<HealthCheckResponse>;
      readonly settings: {
        readonly get: () => Promise<SettingsActionResponse>;
        readonly update: (input: SettingsUpdateInput) => Promise<SettingsActionResponse>;
      };
      readonly secrets: {
        readonly status: () => Promise<SecretsActionResponse>;
        readonly write: (apiKey: string) => Promise<SecretsActionResponse>;
        readonly clear: () => Promise<SecretsActionResponse>;
      };
      readonly chat: {
        readonly send: (
          requestId: string,
          messages: readonly ChatMessage[],
        ) => Promise<ChatSendResponse>;
        readonly cancel: (requestId: string) => Promise<void>;
        /** Subscribe to streaming previews; returns an unsubscribe function. */
        readonly onChunk: (listener: (event: ChatChunkEvent) => void) => () => void;
      };
      /**
       * The read-only coding workspace (Phase 2, Milestone 5). Note that
       * `select` takes no argument: the directory is chosen by the user in a
       * native picker the main process owns, never named by the renderer.
       */
      readonly workspace: {
        readonly status: () => Promise<WorkspaceProjectResponse>;
        readonly select: () => Promise<WorkspaceProjectResponse>;
        readonly tree: (path: string) => Promise<WorkspaceTreeResponse>;
        readonly file: (path: string) => Promise<WorkspaceFileResponse>;
        readonly search: (query: string, path: string) => Promise<WorkspaceSearchResponse>;
        readonly plan: (objective: string) => Promise<WorkspacePlanResponse>;
        /** Produces a diff. Writes nothing — see `apply` (Milestone 6). */
        readonly propose: (edits: readonly WorkspaceEdit[]) => Promise<WorkspaceChangeResponse>;
        /** Takes a change id only, so what was shown is what is written. */
        readonly apply: (changeId: string) => Promise<WorkspaceChangeResponse>;
        readonly rollback: (changeId: string) => Promise<WorkspaceChangeResponse>;
        readonly changes: () => Promise<WorkspaceChangesResponse>;
      };
      /**
       * The command registry (Phase 2, Milestone 6). Note that `run` takes an
       * identifier from an enum: there is no parameter for a command string,
       * an argument, a shell or a working directory.
       */
      readonly command: {
        readonly list: () => Promise<CommandListResponse>;
        readonly run: (runId: string, commandId: CommandIdValue) => Promise<CommandRunResponse>;
        readonly cancel: (runId: string) => Promise<void>;
      };
      /**
       * Agent profiles and runs (Phase 2, Milestone 7). Note that `run` takes
       * an objective and nothing else: there is no parameter for a step, a
       * tool, a path, a command or a limit, because what a run may do comes
       * from the stored profile the main process reads, never from here.
       */
      readonly agent: {
        readonly list: () => Promise<AgentRegistryResponse>;
        readonly select: (profileId: string) => Promise<AgentRegistryResponse>;
        readonly create: (profile: AgentProfileInput) => Promise<AgentRegistryResponse>;
        readonly update: (
          profileId: string,
          profile: AgentProfileInput,
        ) => Promise<AgentRegistryResponse>;
        readonly remove: (profileId: string) => Promise<AgentRegistryResponse>;
        readonly setEnabled: (
          profileId: string,
          enabled: boolean,
        ) => Promise<AgentRegistryResponse>;
        readonly run: (runId: string, objective: string) => Promise<AgentRunResponse>;
        readonly cancel: (runId: string) => Promise<void>;
      };
      /**
       * Local memory (Phase 2, Milestone 8). Note that `exportScope` and
       * `importScope` take a scope and nothing else: the file is chosen by
       * the user in a native dialog the main process owns, so there is no
       * path parameter here to name a file to read or to overwrite. Note also
       * that no write carries a `source`: whether a record was typed or
       * imported is stamped in the main process, never claimed from here.
       */
      readonly memory: {
        readonly list: (scope: MemoryScopeValue) => Promise<MemoryQueryResponse>;
        readonly search: (scope: MemoryScopeValue, query: string) => Promise<MemoryQueryResponse>;
        /** The small relevant set — never the whole store. */
        readonly retrieve: (objective: string) => Promise<MemoryRetrieveResponse>;
        readonly add: (record: MemoryRecordInput) => Promise<MemoryRecordResponse>;
        readonly update: (id: string, record: MemoryRecordInput) => Promise<MemoryRecordResponse>;
        readonly setPinned: (
          id: string,
          scope: MemoryScopeValue,
          pinned: boolean,
        ) => Promise<MemoryRecordResponse>;
        readonly remove: (id: string, scope: MemoryScopeValue) => Promise<MemoryMutationResponse>;
        readonly clear: (scope: MemoryScopeValue) => Promise<MemoryMutationResponse>;
        readonly exportScope: (scope: MemoryScopeValue) => Promise<MemoryMutationResponse>;
        readonly importScope: (scope: MemoryScopeValue) => Promise<MemoryMutationResponse>;
      };
      /**
       * Workflows (Phase 2, Milestone 9). Note that there is no `schedule`
       * and no `watch`: a workflow's trigger is an enum with one member,
       * `manual`, so nothing here can arrange for one to start by itself.
       * Note also that `run` takes a workflow id and an objective — there is
       * no parameter for a step, a tool, a path, a command or a limit,
       * because what a run may do comes from the stored definition the main
       * process reads.
       */
      readonly workflow: {
        readonly list: () => Promise<WorkflowListResponse>;
        readonly create: (workflow: WorkflowInput) => Promise<WorkflowListResponse>;
        readonly update: (
          workflowId: string,
          workflow: WorkflowInput,
        ) => Promise<WorkflowListResponse>;
        readonly duplicate: (workflowId: string, newId: string) => Promise<WorkflowListResponse>;
        readonly remove: (workflowId: string) => Promise<WorkflowListResponse>;
        readonly setEnabled: (
          workflowId: string,
          enabled: boolean,
        ) => Promise<WorkflowListResponse>;
        readonly run: (
          runId: string,
          workflowId: string,
          objective: string,
        ) => Promise<WorkflowRunResponse>;
        /** Stops the run at the next step boundary, keeping what it has done. */
        readonly pause: (runId: string) => Promise<void>;
        /** Aborts the run now, killing a child process it had started. */
        readonly cancel: (runId: string) => Promise<void>;
        /** Subscribe to advisory progress; returns an unsubscribe function. */
        readonly onProgress: (listener: (event: WorkflowProgressEvent) => void) => () => void;
      };
      /**
       * Windows automation (Phase 2, Milestone 10). `run` takes a tool id
       * from the fixed registry and nothing else — no path, no URL, no
       * argument, no window handle, no command.
       */
      readonly automation: {
        readonly list: () => Promise<AutomationListResponse>;
        readonly run: (runId: string, toolId: string) => Promise<AutomationRunResponse>;
        /** Best-effort: abandons a launch attempt in progress. */
        readonly cancel: (runId: string) => Promise<void>;
      };
      /**
       * Git (Phase 2, Milestone 6). `checkpoint` takes no argument: nothing
       * here can name a ref, a branch, a remote or a commit message, and
       * there is no reset, checkout, push or delete.
       */
      readonly git: {
        readonly status: () => Promise<GitStatusResponse>;
        readonly diff: (path: string | null) => Promise<GitDiffResponse>;
        readonly checkpoint: () => Promise<GitCheckpointResponse>;
      };
    };
  }
}
