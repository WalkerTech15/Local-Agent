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
 * Longest fragment the mock emits through `onChunk`. Small enough that a
 * normal reply arrives as several deltas, so the streaming path is genuinely
 * exercised rather than delivered in one piece.
 */
const MOCK_STREAM_CHUNK_LENGTH = 24;

function splitIntoChunks(content: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += size) {
    chunks.push(content.slice(index, index + size));
  }
  return chunks;
}

/**
 * Creates the deterministic mock provider.
 *
 * `id` is {@link MOCK_CHAT_PROVIDER_ID}. Streaming (Phase 2, Milestone 4) is
 * offered only when the caller passes `onChunk`: the reply is then delivered
 * as several fragments spread across the *same* simulated delay — not an
 * additional one — so total timing, and the final content, are byte-for-byte
 * what they were without streaming. A caller that passes no `onChunk`
 * observes exactly the Milestone 1 behaviour.
 */
export function createMockChatProvider(options: CreateMockChatProviderOptions = {}): ChatProvider {
  const delayMs = options.delayMs ?? MOCK_CHAT_PROVIDER_DEFAULT_DELAY_MS;

  return {
    id: MOCK_CHAT_PROVIDER_ID,
    async send(
      request: ChatProviderRequest,
      requestOptions?: ChatProviderRequestOptions,
    ): Promise<ChatProviderResult> {
      const signal = requestOptions?.signal;
      const onChunk = requestOptions?.onChunk;
      const latest = lastUserContent(request);
      const shouldFail = latest !== null && latest.trim() === MOCK_CHAT_PROVIDER_FAILURE_TRIGGER;

      if (onChunk === undefined || shouldFail) {
        // The failure trigger deliberately streams nothing: a request that
        // fails must not leave a partial preview behind, exactly as a real
        // adapter's failure does not.
        await delay(delayMs, signal);
        if (shouldFail) {
          throw new ChatProviderError(
            'PROVIDER_REQUEST_FAILED',
            'The mock provider was asked to simulate a failure.',
          );
        }
        return { content: buildReplyContent(request) };
      }

      const content = buildReplyContent(request);
      const chunks = splitIntoChunks(content, MOCK_STREAM_CHUNK_LENGTH);
      const perChunkDelayMs = chunks.length === 0 ? delayMs : delayMs / chunks.length;

      for (const chunk of chunks) {
        // Sequential by nature: a stream is ordered, and each fragment waits
        // its share of the same total delay.
        await delay(perChunkDelayMs, signal);
        onChunk(chunk);
      }

      return { content };
    },
  };
}
