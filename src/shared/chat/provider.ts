/**
 * Chat provider abstraction (Phase 2, Milestones 1–2).
 *
 * A `ChatProvider` turns a validated conversation into assistant reply text.
 * This module defines the shape only. The one working implementation in this
 * codebase is still the deterministic mock (`./mock-provider.ts`) — Milestone
 * 2 adds the registry (`./registry.ts`), request/response schemas
 * (`../schemas/chat.schema.ts`) and a timeout decorator (`./timeout.ts`)
 * around this same interface, but implements no real provider. A future
 * phase adding one (GLM, an OpenAI-compatible endpoint, Ollama) implements
 * this same interface; nothing that consumes a `ChatProvider` needs to
 * change when that happens.
 *
 * Deliberately provider-independent and inert:
 *
 *  - No Electron import, no Node built-in, no filesystem or shell access —
 *    enforced the same way the rest of `src/shared` is, by
 *    `eslint.config.js`'s purity boundary.
 *  - No network access — the same boundary blocks `fetch`, `XMLHttpRequest`,
 *    `WebSocket` and `EventSource` as globals, so a provider implementation
 *    placed under `src/shared` cannot make a network request even if a
 *    future edit tried to add one here by mistake.
 *  - No secret access — a `ChatProvider` receives only conversation messages,
 *    never settings, never the secret store. A real provider's API key, when
 *    one exists, stays inside the main process exactly as it does for
 *    `secrets.write` today; how a future real provider would reach it without
 *    handing a plaintext key to this layer is an open design question for the
 *    milestone that adds one, not answered here.
 *  - Cancellation is an `AbortSignal`, the standard inert, dependency-free
 *    mechanism — nothing here starts a timer or a network request that would
 *    need a bespoke cancellation channel.
 *  - Timeout is deliberately **not** a field on {@link ChatProviderRequestOptions}.
 *    Every provider already accepts a `signal`, so a caller wanting a timeout
 *    budget composes `withProviderTimeout(provider, timeoutMs)`
 *    (`./timeout.ts`) once, rather than every adapter re-implementing its own
 *    timer and every call site remembering to pass one.
 */

import type { ChatMessage } from '../schemas/chat.schema';

export interface ChatProviderRequest {
  /** The conversation so far, oldest first, already schema-validated. */
  readonly messages: readonly ChatMessage[];
}

export interface ChatProviderResult {
  /**
   * Assistant reply text. Untrusted output: a caller must render this as
   * text only, never as HTML, and must never treat it as authorization for
   * any action — see `docs/phase-2-chat-architecture.md`.
   */
  readonly content: string;
}

/**
 * The normalized failure vocabulary every `ChatProvider` reports through,
 * covering the five categories a caller must be able to distinguish:
 *
 *  - `PROVIDER_UNAVAILABLE` — the provider cannot be used at all right now:
 *    nothing is configured (`none`), or the configured provider has no real
 *    implementation yet (`glm`, `openai-compatible`, `ollama` in Phase 2), or
 *    an unrecognised identifier reached the registry. See
 *    `src/shared/chat/registry.ts`.
 *  - `PROVIDER_INVALID_CONFIGURATION` — the provider is implemented but its
 *    configuration is unusable (for example, a real HTTP adapter with no
 *    base URL). Declared now for a future real adapter to report against;
 *    nothing in this milestone constructs this code, since no adapter here
 *    has configuration to validate beyond what `settingsSchema` already
 *    enforces.
 *  - `PROVIDER_TIMEOUT` — the request did not complete within a caller's
 *    configured budget. See `src/shared/chat/timeout.ts`'s
 *    `withProviderTimeout`, the one thing in this codebase that produces it.
 *  - `PROVIDER_ABORTED` — cancelled via `AbortSignal`, whether by the caller
 *    directly or as a side effect of `withProviderTimeout`'s own internal
 *    cancellation forwarding.
 *  - `PROVIDER_REQUEST_FAILED` — a generic failure that fits none of the
 *    above. The mock provider's deliberate failure trigger uses this.
 */
export const CHAT_PROVIDER_ERROR_CODES = [
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_INVALID_CONFIGURATION',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ABORTED',
  'PROVIDER_REQUEST_FAILED',
] as const;
export type ChatProviderErrorCode = (typeof CHAT_PROVIDER_ERROR_CODES)[number];

/**
 * A structured provider failure.
 *
 * Mirrors `main/executor.ts`'s `ActionExecutionError` pattern: a stable code
 * a caller can branch on, with `cause` reserved for local debugging only
 * (never rendered, never sent anywhere) rather than surfacing a raw
 * provider-internal message to the conversation UI.
 */
export class ChatProviderError extends Error {
  readonly code: ChatProviderErrorCode;

  constructor(code: ChatProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatProviderError';
    this.code = code;
  }
}

export interface ChatProviderRequestOptions {
  /** Abort an in-flight request. See the module doc comment. */
  readonly signal?: AbortSignal;
}

/**
 * No real provider is implemented in this milestone. Every `ChatProvider` in
 * this codebase today is the mock in `./mock-provider.ts`.
 */
export interface ChatProvider {
  /** A short, stable identifier — `'mock'` for the only provider that exists yet. */
  readonly id: string;
  send(
    request: ChatProviderRequest,
    options?: ChatProviderRequestOptions,
  ): Promise<ChatProviderResult>;
}
