/**
 * Deterministic mock chat provider (Phase 2, Milestone 1).
 *
 * The only `ChatProvider` implementation in this codebase. It makes no
 * network request — this file cannot: `fetch`, `XMLHttpRequest`, `WebSocket`
 * and `EventSource` are blocked as globals throughout `src/shared` by
 * `eslint.config.js`, the same boundary that keeps this layer free of
 * Electron and Node built-ins. It reads no setting and no secret; its only
 * input is the conversation it is handed.
 *
 * Every response is templated from the request alone, so the same
 * conversation always produces the same reply — no randomness, no wall-clock
 * dependency in the reply text itself (the artificial delay is timing, not
 * content, and is fully controllable by a caller for tests).
 */

import {
  ChatProviderError,
  type ChatProvider,
  type ChatProviderRequest,
  type ChatProviderRequestOptions,
  type ChatProviderResult,
} from './provider';
import { MOCK_CHAT_PROVIDER_FAILURE_TRIGGER, MOCK_CHAT_PROVIDER_ID } from '../constants';

/** Default simulated latency, long enough that a UI's loading state is actually visible. */
export const MOCK_CHAT_PROVIDER_DEFAULT_DELAY_MS = 400;

/** Longest prefix of the triggering user message ever echoed back into a mock reply. */
const ECHO_MAX_LENGTH = 200;

export interface CreateMockChatProviderOptions {
  /**
   * Simulated latency in milliseconds before the reply resolves. Defaults to
   * {@link MOCK_CHAT_PROVIDER_DEFAULT_DELAY_MS}. Tests pass `0` for an
   * instant, still-deterministic response.
   */
  readonly delayMs?: number;
}

function lastUserContent(request: ChatProviderRequest): string | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === 'user') return message.content;
  }
  return null;
}

function buildReplyContent(request: ChatProviderRequest): string {
  const latest = lastUserContent(request);
  if (latest === null) {
    return (
      '[Mock provider] No real model is connected in this milestone. ' +
      'This is a deterministic placeholder response — no network request was made.'
    );
  }

  const truncated =
    latest.length > ECHO_MAX_LENGTH ? `${latest.slice(0, ECHO_MAX_LENGTH)}…` : latest;

  return (
    `[Mock provider] I received your message: "${truncated}". ` +
    'No real model is connected in this milestone — this is a deterministic ' +
    'placeholder response and no network request was made.'
  );
}

/**
 * Waits `delayMs`, or rejects early with `PROVIDER_ABORTED` if `signal` fires
 * first. `delayMs <= 0` resolves on the next microtask without starting a
 * timer, so tests need no fake-timer setup to get an instant, deterministic
 * result.
 */
async function delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw new ChatProviderError(
      'PROVIDER_ABORTED',
      'The request was aborted before the mock provider responded.',
    );
  }
  if (delayMs <= 0) {
    await Promise.resolve();
    if (signal?.aborted) {
      throw new ChatProviderError(
        'PROVIDER_ABORTED',
        'The request was aborted before the mock provider responded.',
      );
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timer);
      reject(
        new ChatProviderError(
          'PROVIDER_ABORTED',
          'The request was aborted before the mock provider responded.',
        ),
      );
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Creates the deterministic mock provider.
 *
 * `id` is {@link MOCK_CHAT_PROVIDER_ID} — the only provider identifier in
 * use anywhere in this codebase today.
 */
export function createMockChatProvider(options: CreateMockChatProviderOptions = {}): ChatProvider {
  const delayMs = options.delayMs ?? MOCK_CHAT_PROVIDER_DEFAULT_DELAY_MS;

  return {
    id: MOCK_CHAT_PROVIDER_ID,
    async send(
      request: ChatProviderRequest,
      requestOptions?: ChatProviderRequestOptions,
    ): Promise<ChatProviderResult> {
      await delay(delayMs, requestOptions?.signal);

      const latest = lastUserContent(request);
      if (latest !== null && latest.trim() === MOCK_CHAT_PROVIDER_FAILURE_TRIGGER) {
        throw new ChatProviderError(
          'PROVIDER_REQUEST_FAILED',
          'The mock provider was asked to simulate a failure.',
        );
      }

      return { content: buildReplyContent(request) };
    },
  };
}
