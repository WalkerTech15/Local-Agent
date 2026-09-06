/**
 * The `glm` provider adapter (Phase 2, Milestone 4).
 *
 * GLM's public API speaks the OpenAI chat-completions wire format —
 * `POST <base>/chat/completions`, a bearer key, the same request and
 * response shapes, the same server-sent-events streaming — so this module is
 * a configuration of `./chat-completions-transport.ts` and nothing more.
 * Every security property of the exchange (no logging, bounded reads,
 * validated output, normalized errors, the key never leaving the
 * `Authorization` header) is that module's, audited once for all three real
 * providers, rather than re-implemented and re-reviewed here.
 *
 * Two things are specific to GLM, and both are here rather than buried in
 * the transport:
 *
 *  - **A default endpoint.** Unlike `openai-compatible`, whose whole point
 *    is a user-supplied endpoint, GLM has a known public one
 *    ({@link GLM_DEFAULT_BASE_URL}). A configured `baseUrl` still wins, so a
 *    regional mirror or a corporate proxy stays reachable — the default is a
 *    fallback, never an override.
 *  - **A key is mandatory.** GLM is in `PROVIDERS_REQUIRING_API_KEY`;
 *    `main/chat-provider-registry.ts` refuses to construct this adapter
 *    without one, so the key reaching this module is always a real, stored,
 *    decrypted value rather than an empty string standing in for one.
 */

import {
  createChatCompletionsProvider,
  type ChatCompletionsConfig,
} from './chat-completions-transport';
import type { ChatProvider } from '../shared/chat/provider';
import { GLM_DEFAULT_BASE_URL } from '../shared/constants';

export interface GlmProviderConfig {
  /**
   * The user's configured endpoint, or an empty string to use
   * {@link GLM_DEFAULT_BASE_URL}. When non-empty it has already been
   * validated as an absolute, credential-free http/https URL by
   * `settingsSchema`.
   */
  readonly baseUrl: string;
  readonly model: string;
  /** Plaintext, decrypted immediately before this is constructed. Never logged. */
  readonly apiKey: string;
}

/** The endpoint a given configuration resolves to. Exported for tests and diagnostics. */
export function resolveGlmBaseUrl(configuredBaseUrl: string): string {
  const trimmed = configuredBaseUrl.trim();
  return trimmed === '' ? GLM_DEFAULT_BASE_URL : trimmed;
}

/**
 * Creates the `glm` adapter for one resolved configuration.
 *
 * Callers apply `withProviderTimeout` around the returned provider — this
 * function starts no timer of its own.
 */
export function createGlmProvider(config: GlmProviderConfig): ChatProvider {
  const transportConfig: ChatCompletionsConfig = {
    providerId: 'glm',
    baseUrl: resolveGlmBaseUrl(config.baseUrl),
    model: config.model,
    apiKey: config.apiKey,
  };
  return createChatCompletionsProvider(transportConfig);
}
