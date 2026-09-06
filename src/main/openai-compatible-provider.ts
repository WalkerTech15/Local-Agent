/**
 * The `openai-compatible` provider adapter (Phase 2, Milestone 3; factored
 * onto the shared transport in Milestone 4).
 *
 * The generic case: an endpoint the user supplies in full, authenticated
 * with a bearer key from the encrypted secret store. Everything about the
 * exchange itself — request building, bounded reading, streaming, response
 * validation, error normalization, the guarantee that nothing here logs —
 * lives in `./chat-completions-transport.ts`, which this module configures
 * and nothing more. See that module's doc comment for the security
 * properties that hold for every provider built on it.
 *
 * Milestone 3's behaviour is preserved exactly, including for an endpoint
 * that ignores `stream`: the transport handles a plain JSON completion and a
 * server-sent-events stream alike.
 */

import {
  createChatCompletionsProvider,
  MAX_RESPONSE_BYTES,
  type ChatCompletionsConfig,
} from './chat-completions-transport';
import type { ChatProvider } from '../shared/chat/provider';

export { MAX_RESPONSE_BYTES };

export interface OpenAiCompatibleProviderConfig {
  /** Already validated: absolute http/https, no embedded credentials — see `settingsSchema`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Plaintext, decrypted immediately before this is constructed. Never logged. */
  readonly apiKey: string;
}

/**
 * Creates the `openai-compatible` adapter for one resolved configuration.
 *
 * Callers apply `withProviderTimeout` around the returned provider — this
 * function starts no timer of its own.
 */
export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleProviderConfig,
): ChatProvider {
  const transportConfig: ChatCompletionsConfig = {
    providerId: 'openai-compatible',
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
  };
  return createChatCompletionsProvider(transportConfig);
}
