/**
 * Timeout decorator for any `ChatProvider` (Phase 2, Milestone 2).
 *
 * `withProviderTimeout(provider, timeoutMs)` wraps a provider so a request
 * that does not settle within `timeoutMs` is aborted and rejected with
 * `ChatProviderError('PROVIDER_TIMEOUT', …)`, instead of hanging
 * indefinitely. Composable and provider-neutral: it wraps `mock-provider.ts`
 * today and will wrap a real adapter identically once one exists, without
 * either implementation needing its own timer.
 *
 * No network access, no Electron, no Node built-in — the same `src/shared`
 * purity boundary as every other file in this directory.
 */

import {
  ChatProviderError,
  type ChatProvider,
  type ChatProviderRequest,
  type ChatProviderRequestOptions,
  type ChatProviderResult,
} from './provider';

/**
 * A module-local sentinel, never exported: identifies an abort this
 * decorator caused itself (the timer firing), distinct from one it merely
 * forwarded from an external signal. A fresh `Symbol` rather than a string
 * so nothing outside this file could construct an equal value by accident.
 */
const TIMEOUT_REASON = Symbol('withProviderTimeout:timeout');

/**
 * Wraps `provider` so every `send()` call is bounded by `timeoutMs`.
 *
 * A single fresh `AbortController` is created per call and passed to the
 * wrapped provider as its `signal` — never the caller's own signal directly
 * — so this decorator can tell, when the wrapped provider's promise rejects,
 * whether the cause was its own timer firing (report `PROVIDER_TIMEOUT`) or
 * something else (forward the original error unchanged, including a genuine
 * caller-initiated `PROVIDER_ABORTED`). It tells the two apart via
 * `AbortSignal.abort(reason)`'s `reason` — a fixed local sentinel for the
 * timer, the external signal's own `reason` when forwarding an outside
 * cancellation — rather than a separate mutable flag: a `let` reassigned
 * only inside the `setTimeout` callback below would need an explicit type
 * annotation to stop TypeScript narrowing it to `false` for the rest of this
 * function body (control-flow analysis does not follow the reassignment
 * through that closure), and an explicit annotation on an otherwise-inferred
 * boolean is exactly what `@typescript-eslint/no-inferrable-types` forbids.
 * Reading `combined.signal.reason` sidesteps the conflict entirely. The
 * caller's signal, if supplied, is forwarded into the same combined
 * controller, so an external cancellation still cancels the wrapped
 * provider's work exactly as it would without this decorator.
 *
 * An externally already-aborted signal is rejected immediately, before the
 * wrapped provider's `send()` is ever called. This does not rely on the
 * wrapped provider itself correctly noticing a pre-aborted signal — the
 * interface documents that a provider *may* check `signal.aborted` up front
 * the way the mock provider does, but nothing requires every future
 * implementation to, and this decorator's own cancellation guarantee should
 * not depend on that.
 */
export function withProviderTimeout(provider: ChatProvider, timeoutMs: number): ChatProvider {
  return {
    id: provider.id,
    async send(
      request: ChatProviderRequest,
      options?: ChatProviderRequestOptions,
    ): Promise<ChatProviderResult> {
      const externalSignal = options?.signal;
      if (externalSignal?.aborted) {
        throw new ChatProviderError('PROVIDER_ABORTED', 'The request was already aborted.');
      }

      const combined = new AbortController();

      const forwardAbort = (): void => {
        combined.abort(externalSignal?.reason);
      };
      externalSignal?.addEventListener('abort', forwardAbort, { once: true });

      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        combined.abort(TIMEOUT_REASON);
      }, timeoutMs);

      try {
        return await provider.send(request, { signal: combined.signal });
      } catch (error) {
        if (combined.signal.reason === TIMEOUT_REASON) {
          throw new ChatProviderError(
            'PROVIDER_TIMEOUT',
            `The provider did not respond within ${String(timeoutMs)}ms.`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}
