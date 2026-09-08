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
  ChatChunkEvent,
  ChatMessage,
  ChatSendResponse,
  HealthCheckResponse,
  SecretsActionResponse,
  SettingsActionResponse,
  SettingsUpdateInput,
  WorkspaceFileResponse,
  WorkspacePlanResponse,
  WorkspaceProjectResponse,
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
      };
    };
  }
}
