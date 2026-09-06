/**
 * The `ollama` provider adapter (Phase 2, Milestone 4).
 *
 * Ollama is a **local** model runtime. It serves an OpenAI-compatible API
 * under `/v1`, which is what this adapter talks to, so the exchange is the
 * same `./chat-completions-transport.ts` every other real provider uses —
 * one wire protocol, one parser, one set of bounds, audited once. Ollama's
 * own native `/api/chat` protocol is deliberately not implemented: a second
 * streaming format would be a second thing to get right for no capability
 * this milestone needs.
 *
 * Three things are specific to Ollama, and all three are enforced here
 * rather than assumed:
 *
 *  - **No credential is sent.** Ollama is unauthenticated and is not in
 *    `PROVIDERS_REQUIRING_API_KEY`; this adapter passes `apiKey: null`, so
 *    the transport sends no `Authorization` header at all. A key stored for
 *    some other provider is never read for, or forwarded to, Ollama — a
 *    property {@link createOllamaProvider}'s signature makes structural,
 *    since it has no way to accept one.
 *  - **The endpoint must be local.** {@link isLocalHttpEndpoint} decides,
 *    statically and without DNS, whether a configured `baseUrl` is a
 *    loopback, private or link-local address (or `localhost`). Anything else
 *    is refused before a request is built. Without this, a mistyped or
 *    hostile endpoint would ship the user's entire conversation to a cloud
 *    service while the interface still called the provider "local".
 *  - **A default endpoint.** {@link OLLAMA_DEFAULT_BASE_URL} —
 *    `http://127.0.0.1:11434/v1`, Ollama's own default port — is used when
 *    nothing is configured, so the common case needs no setup at all. A
 *    configured endpoint still wins, provided it is local.
 */

import {
  createChatCompletionsProvider,
  type ChatCompletionsConfig,
} from './chat-completions-transport';
import { isLocalHttpEndpoint } from '../shared/chat/local-endpoint';
import { ChatProviderError, type ChatProvider } from '../shared/chat/provider';
import { OLLAMA_DEFAULT_BASE_URL } from '../shared/constants';

export interface OllamaProviderConfig {
  /**
   * The user's configured endpoint, or an empty string to use
   * {@link OLLAMA_DEFAULT_BASE_URL}. Must resolve to a local address either
   * way — see {@link resolveOllamaBaseUrl}.
   */
  readonly baseUrl: string;
  readonly model: string;
}

/** Thrown by {@link resolveOllamaBaseUrl} for an endpoint that is not local. */
export class NonLocalOllamaEndpointError extends Error {
  constructor() {
    super('the configured Ollama endpoint is not a local address');
    this.name = 'NonLocalOllamaEndpointError';
  }
}

/**
 * The endpoint a given configuration resolves to.
 *
 * Throws {@link NonLocalOllamaEndpointError} for a configured endpoint that
 * is not local. The caller (`main/chat-provider-registry.ts`) turns that
 * into a fail-closed `PROVIDER_INVALID_CONFIGURATION` provider, so the
 * refusal reaches the user as an ordinary configuration error rather than an
 * exception — but the refusal itself happens here, before any URL is built.
 */
export function resolveOllamaBaseUrl(configuredBaseUrl: string): string {
  const trimmed = configuredBaseUrl.trim();
  if (trimmed === '') return OLLAMA_DEFAULT_BASE_URL;
  if (!isLocalHttpEndpoint(trimmed)) throw new NonLocalOllamaEndpointError();
  return trimmed;
}

/**
 * Creates the `ollama` adapter for one resolved configuration.
 *
 * Rejects a non-local endpoint by returning a provider whose `send()` always
 * fails closed with `PROVIDER_INVALID_CONFIGURATION` — never by throwing
 * synchronously, matching how every other resolution failure in this
 * codebase is represented, and never by quietly falling back to the default
 * local endpoint, which would send the request somewhere the user did not
 * configure.
 *
 * Callers apply `withProviderTimeout` around the returned provider — this
 * function starts no timer of its own.
 */
export function createOllamaProvider(config: OllamaProviderConfig): ChatProvider {
  let baseUrl: string;
  try {
    baseUrl = resolveOllamaBaseUrl(config.baseUrl);
  } catch {
    return {
      id: 'ollama',
      send() {
        return Promise.reject(
          new ChatProviderError(
            'PROVIDER_INVALID_CONFIGURATION',
            'The configured Ollama endpoint is not a local address. Ollama runs locally; point it at a loopback or private address.',
          ),
        );
      },
    };
  }

  const transportConfig: ChatCompletionsConfig = {
    providerId: 'ollama',
    baseUrl,
    model: config.model,
    // Never a key: Ollama is unauthenticated, and a key stored for another
    // provider must not leak to a local endpoint.
    apiKey: null,
  };
  return createChatCompletionsProvider(transportConfig);
}
