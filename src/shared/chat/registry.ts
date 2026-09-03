/**
 * Approved-provider registry (Phase 2, Milestone 2).
 *
 * Maps the four settings-level provider identifiers (`none`, `glm`,
 * `openai-compatible`, `ollama` — {@link MODEL_PROVIDERS}) to safe capability
 * metadata and to a `ChatProvider` adapter. No real network adapter exists
 * for any of them yet, so {@link createChatProviderForSelection} returns a
 * fail-closed placeholder for all four: asking any of them to `send()`
 * always rejects with a normalized `PROVIDER_UNAVAILABLE` error, never a
 * silent success and never a real request. This is deliberate, not a gap —
 * see `docs/phase-2-provider-architecture.md` for why `none` and the three
 * unimplemented real identifiers are treated identically at the `send()`
 * boundary and are distinguished only by status text, never by one of them
 * quietly working.
 *
 * The deterministic mock (`./mock-provider.ts`) is a separate, always-
 * available adapter — for tests, and as the one thing that actually answers
 * a chat message in this phase. `src/renderer/chat/useActiveChatProvider.ts`
 * is the single, explicit place that decides to use it; nothing here wires
 * it in automatically for any approved identifier, so the fail-closed
 * guarantee below is real and independently testable.
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
  /** Whether a real, network-capable adapter exists for this identifier yet. Always `false` in Phase 2. */
  readonly implemented: boolean;
}

const LABEL_BY_PROVIDER: Readonly<Record<ModelProvider, string>> = {
  none: 'No provider configured',
  glm: 'GLM',
  'openai-compatible': 'OpenAI-compatible endpoint',
  ollama: 'Ollama (local)',
};

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
    implemented: false,
  };
}

/** What the interface should tell the user about the currently selected provider. */
export type ChatProviderAvailability = 'not-configured' | 'not-implemented';

export interface ChatProviderStatus {
  readonly selected: ModelProvider;
  readonly availability: ChatProviderAvailability;
  /**
   * Safe, user-facing summary text. Never contains a key, a header, a URL,
   * or any value from the encrypted secret store — it is built entirely from
   * the fixed labels above and a fixed template, never from settings input.
   */
  readonly summary: string;
}

/**
 * Describes the currently selected provider for display, without implying a
 * real connection exists — none does yet.
 */
export function describeChatProviderStatus(selected: ModelProvider): ChatProviderStatus {
  const capabilities = getChatProviderCapabilities(selected);
  if (selected === 'none') {
    return {
      selected,
      availability: 'not-configured',
      summary: 'No provider configured. Chat is running on the local mock provider.',
    };
  }
  return {
    selected,
    availability: 'not-implemented',
    summary: `${capabilities.label} is selected but not connected yet. Chat is running on the local mock provider.`,
  };
}

const UNAVAILABLE_MESSAGE_BY_PROVIDER: Readonly<Record<ModelProvider, string>> = {
  none: 'No provider is configured. Choose one in provider settings.',
  glm: 'GLM is configured but not yet connected in this version.',
  'openai-compatible':
    'This OpenAI-compatible endpoint is configured but not yet connected in this version.',
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
 * Resolves the `ChatProvider` for an approved settings-level identifier.
 *
 * Every one of the four approved identifiers — including `none` — maps to a
 * fail-closed adapter in this milestone: none of them makes a network
 * request, and none of them silently succeeds. An identifier outside
 * {@link MODEL_PROVIDERS} (which should not happen, since `ModelProvider` is
 * a closed type validated by `settingsSchema`, but may reach here through an
 * untrusted boundary that bypassed that validation) fails closed the same
 * way rather than throwing.
 */
export function createChatProviderForSelection(id: ModelProvider): ChatProvider {
  if (!MODEL_PROVIDERS.includes(id)) {
    return createUnavailableChatProvider('unknown', 'This provider is not recognised.');
  }
  return createUnavailableChatProvider(id, UNAVAILABLE_MESSAGE_BY_PROVIDER[id]);
}
