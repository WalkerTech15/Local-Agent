/**
 * Resolves the real, main-process `ChatProvider` for the currently selected
 * provider (Phase 2, Milestones 3-4).
 *
 * This is the counterpart to `src/shared/chat/registry.ts`'s
 * `createChatProviderForSelection`, and deliberately a separate module in a
 * separate process: this one is the only place in the codebase that reads a
 * decrypted API key and hands it to a network-capable adapter, so it must
 * live where secrets already live — `src/main` — never in `src/shared`.
 *
 * It is also the one place that decides, per provider, what a *usable*
 * configuration is:
 *
 * | Identifier          | Endpoint                        | Credential            |
 * | ------------------- | ------------------------------- | --------------------- |
 * | `none`              | —                               | —                     |
 * | `openai-compatible` | required, user-supplied         | required              |
 * | `glm`               | optional, public default        | required              |
 * | `ollama`            | optional, local default, **must be local** | never read |
 *
 * A model identifier is required for all three real providers.
 *
 * Every failure to reach a usable configuration produces a fail-closed
 * `ChatProvider` rather than an exception or a substitution: `none` (and
 * anything outside {@link MODEL_PROVIDERS}) delegates straight back to the
 * shared, always-fail-closed registry; a missing key, a missing model or a
 * non-local Ollama endpoint each yield a provider whose `send()` rejects
 * with `PROVIDER_INVALID_CONFIGURATION`. **Nothing here ever silently
 * substitutes one provider for another** — the user's selection is either
 * honoured or refused, never quietly redirected.
 */

import type { SafeStorage } from 'electron';

import { createGlmProvider } from './glm-provider';
import { createOllamaProvider } from './ollama-provider';
import { createOpenAiCompatibleProvider } from './openai-compatible-provider';
import { readSecret } from './secrets';
import { ChatProviderError, type ChatProvider } from '../shared/chat/provider';
import { createChatProviderForSelection } from '../shared/chat/registry';
import { withProviderTimeout } from '../shared/chat/timeout';
import {
  MODEL_PROVIDERS,
  PROVIDERS_REQUIRING_API_KEY,
  type ModelProvider,
} from '../shared/constants';
import type { ModelProviderSettings } from '../shared/schemas';

/**
 * Bounds how long a real provider call may run before it is aborted and
 * reported as `PROVIDER_TIMEOUT`.
 *
 * One budget covers the whole call, streamed or not: for a streamed reply
 * that means the complete exchange, not the gap between two deltas. The
 * accumulated reply is itself bounded to `CHAT_MESSAGE_CONTENT_MAX_LENGTH`
 * characters, so "the whole call" cannot be arbitrarily long by design;
 * a provider that streams unusually slowly is the case this budget will cut
 * short, and it does so safely — the request is aborted, nothing partial is
 * committed to the conversation, and the user can retry.
 */
export const CHAT_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

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

const NO_MODEL_MESSAGE = 'No model is configured. Add one in provider settings.';
const NO_KEY_MESSAGE = 'No API key is stored yet. Add one in provider settings.';

/**
 * Reads the stored key for a provider that requires one.
 *
 * Returns `null` when no key is stored, when `safeStorage` cannot decrypt,
 * or — defensively — when the provider is not one that takes a key at all,
 * so no caller can reach the secret store on behalf of a provider that has
 * no business authenticating.
 */
async function readKeyFor(
  provider: ModelProvider,
  secretsFile: string,
  safeStorage: SafeStorage,
): Promise<string | null> {
  if (!PROVIDERS_REQUIRING_API_KEY.includes(provider)) return null;
  return readSecret(secretsFile, safeStorage);
}

/**
 * Resolves the `ChatProvider` a real `chat:send` call should use.
 *
 * Never throws: every failure to resolve a working adapter (no key stored,
 * `safeStorage` unavailable, an empty model, a non-local Ollama endpoint, an
 * unimplemented identifier) is represented as a `ChatProvider` whose
 * `send()` rejects with a normalized code, exactly like the shared
 * registry's fail-closed placeholders — so a caller (`main/ipc.ts`) always
 * has one `ChatProvider` to call, uniformly, regardless of why it might
 * fail.
 */
export async function resolveMainChatProvider(
  options: ResolveChatProviderOptions,
): Promise<ChatProvider> {
  const { modelProvider, secretsFile, safeStorage } = options;
  const { provider, baseUrl, model } = modelProvider;

  // Checked first, and by membership rather than by exhausting the union
  // below: `ModelProvider` is a closed type, but this function is reached
  // from an IPC boundary, so an identifier that never passed `settingsSchema`
  // must fail closed here instead of falling through to whichever branch
  // happens to be last. Written as a runtime membership test on purpose —
  // an equality chain the type system can prove exhaustive is exactly what
  // an automated lint fix will delete as "unnecessary", taking the
  // fail-closed guarantee with it.
  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    return createChatProviderForSelection(provider);
  }

  if (provider === 'none') {
    return createChatProviderForSelection(provider);
  }

  if (provider === 'openai-compatible') {
    if (baseUrl.trim() === '') {
      return unavailable(provider, 'No endpoint is configured. Add one in provider settings.');
    }
    if (model.trim() === '') return unavailable(provider, NO_MODEL_MESSAGE);

    const apiKey = await readKeyFor(provider, secretsFile, safeStorage);
    if (apiKey === null) return unavailable(provider, NO_KEY_MESSAGE);

    return withProviderTimeout(
      createOpenAiCompatibleProvider({ baseUrl, model, apiKey }),
      CHAT_PROVIDER_REQUEST_TIMEOUT_MS,
    );
  }

  if (provider === 'glm') {
    if (model.trim() === '') return unavailable(provider, NO_MODEL_MESSAGE);

    const apiKey = await readKeyFor(provider, secretsFile, safeStorage);
    if (apiKey === null) return unavailable(provider, NO_KEY_MESSAGE);

    return withProviderTimeout(
      createGlmProvider({ baseUrl, model, apiKey }),
      CHAT_PROVIDER_REQUEST_TIMEOUT_MS,
    );
  }

  // `ollama` is what remains: the membership check above already rejected
  // anything outside `MODEL_PROVIDERS`, and the three branches above consumed
  // every other approved identifier.
  if (model.trim() === '') return unavailable(provider, NO_MODEL_MESSAGE);

  // No secret is read here at all: Ollama authenticates with nothing, and
  // `createOllamaProvider` has no parameter that could carry a key even if
  // one were read by mistake. A non-local endpoint is refused inside that
  // factory, which returns its own fail-closed provider.
  return withProviderTimeout(
    createOllamaProvider({ baseUrl, model }),
    CHAT_PROVIDER_REQUEST_TIMEOUT_MS,
  );
}
