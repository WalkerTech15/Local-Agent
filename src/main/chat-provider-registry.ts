/**
 * Resolves the real, main-process `ChatProvider` for the currently selected
 * provider (Phase 2, Milestone 3).
 *
 * This is the counterpart to `src/shared/chat/registry.ts`'s
 * `createChatProviderForSelection`, and deliberately a separate module in a
 * separate process: this one is the only place in the codebase that reads a
 * decrypted API key and hands it to a network-capable adapter, so it must
 * live where secrets already live — `src/main` — never in `src/shared`.
 *
 * For every identifier without a real adapter (`none`, `glm`, `ollama`, and
 * anything outside {@link MODEL_PROVIDERS}), this delegates straight back to
 * the shared, always-fail-closed registry rather than re-implementing the
 * same "unavailable" behaviour a second time. Only `openai-compatible` takes
 * a different path here: configuration is checked (base URL, model, a
 * stored key), and if all three are present, the real adapter
 * (`./openai-compatible-provider.ts`) is constructed and wrapped in
 * `withProviderTimeout` — composed here, not inside the adapter itself,
 * exactly as `docs/phase-2-provider-architecture.md` describes for any
 * future real adapter.
 */

import type { SafeStorage } from 'electron';

import { createOpenAiCompatibleProvider } from './openai-compatible-provider';
import { readSecret } from './secrets';
import { ChatProviderError, type ChatProvider } from '../shared/chat/provider';
import { createChatProviderForSelection } from '../shared/chat/registry';
import { withProviderTimeout } from '../shared/chat/timeout';
import { PROVIDERS_REQUIRING_API_KEY } from '../shared/constants';
import type { ModelProviderSettings } from '../shared/schemas';

/**
 * Bounds how long a real provider call may run before it is aborted and
 * reported as `PROVIDER_TIMEOUT`. A chat completion is a synchronous
 * request/response exchange in this milestone (no streaming), so a single,
 * generous fixed budget is enough — there is no per-call configuration for
 * it yet, matching the rest of Phase 2's provider settings.
 */
export const OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS = 30_000;

export interface ResolveChatProviderOptions {
  readonly modelProvider: ModelProviderSettings;
  readonly secretsFile: string;
  readonly safeStorage: SafeStorage;
}

function unavailable(id: string, message: string): ChatProvider {
  return {
    id,
    send() {
      return Promise.reject(new ChatProviderError('PROVIDER_INVALID_CONFIGURATION', message));
    },
  };
}

/**
 * Resolves the `ChatProvider` a real `chat:send` call should use.
 *
 * Never throws: every failure to resolve a working adapter (no key stored,
 * `safeStorage` unavailable, an empty model, an unimplemented identifier) is
 * represented as a `ChatProvider` whose `send()` rejects with a normalized
 * code, exactly like the shared registry's fail-closed placeholders — so a
 * caller (`main/ipc.ts`) always has one `ChatProvider` to call, uniformly,
 * regardless of why it might fail.
 */
export async function resolveMainChatProvider(
  options: ResolveChatProviderOptions,
): Promise<ChatProvider> {
  const { modelProvider, secretsFile, safeStorage } = options;

  if (modelProvider.provider !== 'openai-compatible') {
    return createChatProviderForSelection(modelProvider.provider);
  }

  if (modelProvider.baseUrl.trim() === '') {
    return unavailable(
      'openai-compatible',
      'No endpoint is configured. Add one in provider settings.',
    );
  }

  if (modelProvider.model.trim() === '') {
    return unavailable(
      'openai-compatible',
      'No model is configured. Add one in provider settings.',
    );
  }

  if (!PROVIDERS_REQUIRING_API_KEY.includes('openai-compatible')) {
    // Unreachable given today's constant, kept so a future change to that
    // list cannot silently skip the key check below without this failing
    // loudly in review instead.
    return unavailable('openai-compatible', 'This provider is not correctly configured.');
  }

  const apiKey = await readSecret(secretsFile, safeStorage);
  if (apiKey === null) {
    return unavailable(
      'openai-compatible',
      'No API key is stored yet. Add one in provider settings.',
    );
  }

  const provider = createOpenAiCompatibleProvider({
    baseUrl: modelProvider.baseUrl,
    model: modelProvider.model,
    apiKey,
  });

  return withProviderTimeout(provider, OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS);
}
