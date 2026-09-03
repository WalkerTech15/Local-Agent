/**
 * Approved-provider registry (Phase 2, Milestones 2-3).
 *
 * Maps the four settings-level provider identifiers (`none`, `glm`,
 * `openai-compatible`, `ollama` — {@link MODEL_PROVIDERS}) to safe capability
 * metadata and to a `ChatProvider` adapter.
 *
 * **{@link createChatProviderForSelection} in this file always fails
 * closed, for all four identifiers, including `openai-compatible` — this
 * has not changed since Milestone 2 and never will while this function
 * lives under `src/shared`.** `src/shared` cannot perform network access —
 * `eslint.config.js`'s purity boundary blocks `fetch` and every other
 * network-capable global here, structurally, not by convention — so a
 * "registry" living in this directory can never itself place a real call.
 * Milestone 3's real, network-capable `openai-compatible` adapter lives in
 * `src/main/openai-compatible-provider.ts` and is resolved by
 * `src/main/chat-provider-registry.ts`'s `resolveMainChatProvider`, reached
 * from the renderer only through the `chat:send` IPC channel
 * (`main/ipc.ts`) — never through this function. This module's
 * {@link ChatProviderCapabilities.implemented} flag reflects that a real
 * adapter exists *somewhere* in the codebase for `openai-compatible` now;
 * `createChatProviderForSelection` reflects what *this* file can do, which
 * is, and stays, nothing. See `docs/phase-2-provider-architecture.md` and
 * `docs/phase-2-real-provider-architecture.md`.
 *
 * The deterministic mock (`./mock-provider.ts`) is a separate, always-
 * available adapter — for tests, and as what answers a chat message for
 * every identifier `implemented` is still `false` for.
 * `src/renderer/chat/useActiveChatProvider.ts` is the single, explicit place
 * that decides between the mock and the real IPC-backed adapter, based on
 * {@link ChatProviderCapabilities.implemented}.
 *
 * No I/O, no Electron, no network — the same `src/shared` purity boundary as
 * every file in this directory.
 */

import { MODEL_PROVIDERS, PROVIDERS_REQUIRING_API_KEY, type ModelProvider } from '../constants';
import { ChatProviderError, type ChatProvider, type ChatProviderResult } from './provider';

/** Safe, non-secret metadata describing one approved provider identifier. */
export interface ChatProviderCapabilities {
  readonly id: ModelProvider;
  /** Human-readable label, safe to show in the UI. */
  readonly label: string;
  /** Whether this provider authenticates with a key from the encrypted secret store. */
  readonly requiresApiKey: boolean;
  /**
   * Whether a real, network-capable adapter exists for this identifier
   * *anywhere in the codebase* — never inside `src/shared`, always in
   * `src/main`, reached only through IPC. `true` for `openai-compatible`
   * since Milestone 3; `false` for `none`, `glm` and `ollama`, still.
   */
  readonly implemented: boolean;
}

const LABEL_BY_PROVIDER: Readonly<Record<ModelProvider, string>> = {
  none: 'No provider configured',
  glm: 'GLM',
  'openai-compatible': 'OpenAI-compatible endpoint',
  ollama: 'Ollama (local)',
};

/**
 * Identifiers with a real, network-capable adapter somewhere in the
 * codebase (always `src/main`, never here). The single place this milestone
 * flips an identifier from mock-only to real — see
 * `src/renderer/chat/useActiveChatProvider.ts`, the one thing that reads
 * this through {@link getChatProviderCapabilities}.
 */
const IMPLEMENTED_PROVIDERS: ReadonlySet<ModelProvider> = new Set(['openai-compatible']);

/**
 * Safe capability metadata for an approved provider identifier.
 *
 * `requiresApiKey` is derived from {@link PROVIDERS_REQUIRING_API_KEY} —
 * the same constant `main/settings-service.ts`'s `hasApiKey` reconciliation
 * and `main/ipc.ts`'s `secrets.write` eligibility check already use — rather
 * than a second, hand-duplicated table that could silently drift from it.
 */
export function getChatProviderCapabilities(id: ModelProvider): ChatProviderCapabilities {
  return {
    id,
    label: LABEL_BY_PROVIDER[id],
    requiresApiKey: PROVIDERS_REQUIRING_API_KEY.includes(id),
    implemented: IMPLEMENTED_PROVIDERS.has(id),
  };
}

/**
 * What the interface should tell the user about the currently selected
 * provider:
 *
 *  - `not-configured` — `none` is selected. Chat runs on the mock.
 *  - `not-implemented` — a real identifier with no adapter yet (`glm`,
 *    `ollama`) is selected. Chat runs on the mock.
 *  - `missing-api-key` — an implemented, key-requiring provider is selected,
 *    but no key is stored. Chat uses the real adapter regardless; a missing
 *    key surfaces as an ordinary `PROVIDER_INVALID_CONFIGURATION` failure
 *    through the existing error/retry UI the first time a message is sent,
 *    rather than this status function guessing at what a real send would do.
 *  - `ready` — an implemented provider is selected and, if it requires one,
 *    a key is stored. Chat uses the real adapter.
 */
export type ChatProviderAvailability =
  'not-configured' | 'not-implemented' | 'missing-api-key' | 'ready';

export interface ChatProviderStatus {
  readonly selected: ModelProvider;
  readonly availability: ChatProviderAvailability;
  /**
   * Safe, user-facing summary text. Never contains a key, a header, a URL,
   * or any value from the encrypted secret store beyond the boolean
   * `hasApiKey` this function's input already carries — built entirely from
   * fixed labels and fixed templates, never from settings input rendered
   * verbatim.
   */
  readonly summary: string;
}

/** The fields {@link describeChatProviderStatus} actually reads. */
export interface ChatProviderStatusInput {
  readonly provider: ModelProvider;
  readonly hasApiKey: boolean;
}

/**
 * Describes the currently selected provider for display.
 *
 * Does not itself attempt a connection or a decrypt — `hasApiKey` is the
 * same already-reconciled boolean `settings:get` returns, not something
 * this function checks freshly. For `ready`, "ready" means "chat will use
 * the real adapter for this identifier," not "this endpoint and key are
 * known-good" — that can only be discovered by actually sending a message,
 * exactly as for any other network call.
 */
export function describeChatProviderStatus(input: ChatProviderStatusInput): ChatProviderStatus {
  const { provider: selected, hasApiKey } = input;
  const capabilities = getChatProviderCapabilities(selected);

  if (selected === 'none') {
    return {
      selected,
      availability: 'not-configured',
      summary: 'No provider configured. Chat is running on the local mock provider.',
    };
  }

  if (!capabilities.implemented) {
    return {
      selected,
      availability: 'not-implemented',
      summary: `${capabilities.label} is selected but not connected yet. Chat is running on the local mock provider.`,
    };
  }

  if (capabilities.requiresApiKey && !hasApiKey) {
    return {
      selected,
      availability: 'missing-api-key',
      summary: `${capabilities.label} is selected, but no API key is stored yet. Add one in provider settings.`,
    };
  }

  return {
    selected,
    availability: 'ready',
    summary: `Using ${capabilities.label}.`,
  };
}

const UNAVAILABLE_MESSAGE_BY_PROVIDER: Readonly<Record<ModelProvider, string>> = {
  none: 'No provider is configured. Choose one in provider settings.',
  glm: 'GLM is configured but not yet connected in this version.',
  'openai-compatible':
    'This function never reaches the network; use chat:send for the real OpenAI-compatible adapter.',
  ollama: 'Ollama is configured but not yet connected in this version.',
};

/**
 * A `ChatProvider` whose `send()` always rejects with `PROVIDER_UNAVAILABLE`
 * and the given safe message — never a network request, never a partial
 * result. Used for every approved identifier in {@link createChatProviderForSelection}
 * and for any identifier the registry does not recognise.
 */
function createUnavailableChatProvider(id: string, message: string): ChatProvider {
  return {
    id,
    send(): Promise<ChatProviderResult> {
      return Promise.reject(new ChatProviderError('PROVIDER_UNAVAILABLE', message));
    },
  };
}

/**
 * Resolves the `ChatProvider` for an approved settings-level identifier —
 * **from inside `src/shared` only**, which is why this always fails closed,
 * for all four identifiers, `openai-compatible` included, regardless of
 * {@link ChatProviderCapabilities.implemented}. No branch of this specific
 * function can ever place a network request or read a credential, because
 * this file cannot: see this module's own doc comment. The real
 * `openai-compatible` adapter is `src/main/openai-compatible-provider.ts`,
 * resolved by `src/main/chat-provider-registry.ts`, reached only through the
 * `chat:send` IPC channel — a different registry, in a different process,
 * for a reason this one cannot satisfy by construction.
 *
 * An identifier outside {@link MODEL_PROVIDERS} (which should not happen,
 * since `ModelProvider` is a closed type validated by `settingsSchema`, but
 * may reach here through an untrusted boundary that bypassed that
 * validation) fails closed the same way rather than throwing.
 */
export function createChatProviderForSelection(id: ModelProvider): ChatProvider {
  if (!MODEL_PROVIDERS.includes(id)) {
    return createUnavailableChatProvider('unknown', 'This provider is not recognised.');
  }
  return createUnavailableChatProvider(id, UNAVAILABLE_MESSAGE_BY_PROVIDER[id]);
}
