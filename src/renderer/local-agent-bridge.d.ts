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
  HealthCheckResponse,
  SecretsActionResponse,
  SettingsActionResponse,
  SettingsUpdateInput,
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
    };
  }
}
