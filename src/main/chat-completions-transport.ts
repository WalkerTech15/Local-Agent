/**
 * The one HTTP transport behind every real chat provider (Phase 2,
 * Milestone 4).
 *
 * Milestone 3 implemented the OpenAI-compatible chat-completions exchange
 * inside `openai-compatible-provider.ts`. Milestone 4 adds two more
 * providers — GLM and Ollama — that speak the *same* wire protocol (GLM's
 * public API is OpenAI-compatible; Ollama serves an OpenAI-compatible API
 * under `/v1`), so the exchange itself was factored out here rather than
 * copied three times. Each provider module is now a thin, separately
 * reviewable declaration of its endpoint, its authentication policy and its
 * identity; this module is the single place where a request is actually
 * built, sent, bounded, parsed and normalized.
 *
 * One transport also means one place to audit for the properties that
 * matter, all of which hold for every provider that uses it:
 *
 *  - **The plaintext API key is a plain function parameter, never a module
 *    global.** It is read from the encrypted secret store immediately before
 *    a provider is constructed (`main/chat-provider-registry.ts`) and is used
 *    only to build one `Authorization` header per request. It is never
 *    logged, never placed in a thrown error's `message`, and never appears
 *    in a return value. A provider configured with `apiKey: null` (Ollama)
 *    sends no `Authorization` header at all.
 *  - **Nothing here logs anything.** No `console` call exists in this file —
 *    not the outgoing headers, not the request body (which carries the
 *    user's conversation), not the raw response body, not a caught error.
 *  - **Nothing accumulates without a bound.** The bytes read from the
 *    socket, the length of a single unterminated protocol line, the total
 *    assistant text accumulated from a stream, and the size of one delta
 *    handed to a caller are each capped separately — see
 *    `src/shared/constants.ts`'s streaming-bounds section.
 *  - **The response is never trusted structurally.** Whatever comes back is
 *    parsed defensively and the final text is validated by the same
 *    {@link chatProviderResultSchema} every other provider's result passes
 *    through, before it is returned to anything.
 *  - **Every failure normalizes into the existing five-code vocabulary**
 *    (`src/shared/chat/provider.ts`) — never a raw `Error.message`, a URL, a
 *    header, or a response body reaches a caller.
 */

import { z } from 'zod';

import {
  ChatProviderError,
  type ChatProvider,
  type ChatProviderRequest,
  type ChatProviderRequestOptions,
  type ChatProviderResult,
} from '../shared/chat/provider';
import {
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  CHAT_STREAM_MAX_LINE_LENGTH,
  CHAT_STREAM_MAX_RESPONSE_BYTES,
} from '../shared/constants';
import { chatProviderResultSchema } from '../shared/schemas/chat.schema';

/** OpenAI-compatible chat completions endpoint, relative to the configured base URL. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Upper bound on the bytes read from a **non-streamed** response body,
 * before this module gives up and reports a malformed response rather than
 * buffering an unbounded amount of memory for a hostile or misbehaving
 * endpoint — the base URL is user-supplied (including self-hosted
 * endpoints), so it is never assumed to be well-behaved. Generous for any
 * real chat completion (a very long reply is still a few hundred KB of JSON)
 * and tight enough to bound memory use for a pathological response. The
 * streamed path has its own, larger byte cap — see
 * {@link CHAT_STREAM_MAX_RESPONSE_BYTES} for why the two differ.
 */
export const MAX_RESPONSE_BYTES = 1_000_000;

export interface ChatCompletionsConfig {
  /** The `ChatProvider.id` the constructed provider reports. */
  readonly providerId: string;
  /** Already validated: absolute http/https, no embedded credentials — see `settingsSchema`. */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * Plaintext, decrypted immediately before this is constructed, or `null`
   * for a provider that authenticates with no key at all (Ollama). Never
   * logged, never returned, never placed in an error.
   */
  readonly apiKey: string | null;
}

/** Only the roles this phase's chat can produce are forwarded to the wire format. */
const FORWARDED_ROLES = new Set(['system', 'user', 'assistant']);

const chatCompletionMessageSchema = z.object({
  content: z.string().nullable().optional(),
});

/**
 * The minimal shape this transport reads from a non-streamed response.
 * Deliberately not `strictObject`: this describes an upstream API this
 * codebase does not control, which may carry vendor-specific fields this
 * transport has no use for and must not reject on that basis alone — only
 * the one field actually read is validated.
 */
const chatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: chatCompletionMessageSchema,
      }),
    )
    .min(1)
    .max(32),
});

/** The minimal shape read from one streamed frame. Same reasoning as above. */
const chatCompletionChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .max(32)
    .optional(),
});

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function toWireMessages(
  request: ChatProviderRequest,
): { readonly role: string; readonly content: string }[] {
  return request.messages
    .filter((message) => FORWARDED_ROLES.has(message.role))
    .map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Thrown internally when a bound is exceeded or a body cannot be read.
 * Never escapes this module: every caller converts it into a
 * `ChatProviderError` with a fixed, safe message first.
 */
class BoundedReadError extends Error {}

/**
 * Reads `response`'s body as text, rejecting once more than `maxBytes` have
 * been received rather than buffering an unbounded amount. Falls back to
 * `response.text()` only when no streaming reader is available (a test
 * double, say) — still applying the same cap to what comes back.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new BoundedReadError('response body exceeds the configured byte cap');
    }
    return text;
  }

  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  for (;;) {
    // Sequential by nature: each chunk must be measured before the next is requested.
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BoundedReadError('response body exceeds the configured byte cap');
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

/**
 * The text carried by one server-sent-events `data:` line, or `null` when
 * the line carries none.
 *
 * A `null` result is deliberately **not** an error. Real streams legitimately
 * contain blank separator lines, `:` keep-alive comments, and `event:`/`id:`
 * fields this transport has no use for; a `data:` line whose JSON does not
 * parse, or which carries no text, is treated the same way — skipped, never
 * fatal. A stream that produces no text at all is caught afterwards, once,
 * by the empty-result check, rather than by guessing which individual frame
 * was the problem.
 */
function readSseDataLine(line: string): { readonly delta: string | null; readonly done: boolean } {
  if (!line.startsWith('data:')) return { delta: null, done: false };

  const payload = line.slice('data:'.length).trim();
  if (payload === '') return { delta: null, done: false };
  if (payload === '[DONE]') return { delta: null, done: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { delta: null, done: false };
  }

  const frame = chatCompletionChunkSchema.safeParse(parsed);
  if (!frame.success) return { delta: null, done: false };

  const choice = frame.data.choices?.[0];
  const content = choice?.delta?.content;
  const finished = typeof choice?.finish_reason === 'string';

  return {
    delta: typeof content === 'string' && content.length > 0 ? content : null,
    done: finished,
  };
}

interface StreamAccumulationOptions {
  readonly signal: AbortSignal | undefined;
  readonly onChunk: ((delta: string) => void) | undefined;
}

/**
 * Consumes a `text/event-stream` body, forwarding each fragment to
 * `onChunk` and accumulating the whole reply.
 *
 * Three independent bounds apply, and exceeding any of them ends the read
 * rather than growing a buffer: total bytes from the socket, the length of a
 * single line that never terminates, and the accumulated assistant text.
 *
 * A caller's `onChunk` is invoked inside a `try`/`catch` that discards
 * whatever it throws: a live preview failing in the renderer must never turn
 * a working provider response into a failed one.
 */
async function readStreamedCompletion(
  response: Response,
  options: StreamAccumulationOptions,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new BoundedReadError('a streamed response carried no readable body');
  }

  const decoder = new TextDecoder();
  let received = 0;
  let buffer = '';
  let accumulated = '';

  const emit = (delta: string): void => {
    if (options.signal?.aborted) return;
    if (options.onChunk === undefined) return;
    try {
      options.onChunk(delta);
    } catch {
      // Advisory only — see this function's doc comment.
    }
  };

  /**
   * Consumes one protocol line and **returns** whether the stream declared
   * itself finished, rather than setting a flag in the enclosing scope.
   *
   * That is deliberate and not a style preference: a `let` assigned only
   * inside a closure is narrowed by TypeScript to its initial literal type
   * for the rest of the function, which makes a later `if (finished)` read
   * as statically always-false — the same control-flow quirk
   * `src/shared/chat/timeout.ts` documents for its own timeout flag, and one
   * an automated lint fix will happily "simplify" by deleting the check
   * altogether, silently changing behaviour. Returning the value keeps the
   * decision in ordinary, analysable control flow.
   */
  const consumeLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const { delta, done } = readSseDataLine(line);
    if (delta !== null) {
      accumulated += delta;
      if (accumulated.length > CHAT_MESSAGE_CONTENT_MAX_LENGTH) {
        throw new BoundedReadError('streamed content exceeds the maximum message length');
      }
      emit(delta);
    }
    return done;
  };

  let streamFinished = false;

  try {
    while (!streamFinished) {
      // Sequential by nature: each chunk must be measured and parsed before
      // the next is requested, so nothing is read past a breached bound.
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > CHAT_STREAM_MAX_RESPONSE_BYTES) {
        throw new BoundedReadError('streamed response exceeds the configured byte cap');
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1 && !streamFinished) {
        streamFinished = consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }

      if (buffer.length > CHAT_STREAM_MAX_LINE_LENGTH) {
        throw new BoundedReadError('a streamed line exceeded the maximum line length');
      }
    }

    // A final line with no trailing newline is still a line — unless the
    // stream already said it was done, in which case whatever trails the
    // terminator is not part of the reply.
    if (!streamFinished) {
      buffer += decoder.decode();
      if (buffer.length > 0) consumeLine(buffer);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return accumulated;
}

function malformedResponse(cause?: unknown): ChatProviderError {
  return new ChatProviderError(
    'PROVIDER_REQUEST_FAILED',
    'The provider returned a malformed response.',
    cause === undefined ? undefined : { cause },
  );
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.toLowerCase().includes('text/event-stream');
}

/**
 * Creates a `ChatProvider` for one resolved OpenAI-compatible configuration.
 *
 * Streaming is always *requested* (`stream: true`) and both reply shapes are
 * handled: a `text/event-stream` body is consumed incrementally, and any
 * other body is read as a single bounded JSON document, exactly as
 * Milestone 3 did. An endpoint that ignores `stream` therefore keeps
 * working unchanged, and no setting has to be added to describe which
 * behaviour a given endpoint has.
 *
 * Callers apply `withProviderTimeout` around the returned provider — this
 * function starts no timer of its own, matching every other `ChatProvider`
 * in this codebase (see `src/shared/chat/timeout.ts`).
 */
export function createChatCompletionsProvider(config: ChatCompletionsConfig): ChatProvider {
  return {
    id: config.providerId,
    async send(
      request: ChatProviderRequest,
      options?: ChatProviderRequestOptions,
    ): Promise<ChatProviderResult> {
      const signal = options?.signal;
      if (signal?.aborted) {
        throw new ChatProviderError('PROVIDER_ABORTED', 'The request was already aborted.');
      }

      const url = joinUrl(config.baseUrl, CHAT_COMPLETIONS_PATH);
      const body = JSON.stringify({
        model: config.model,
        messages: toWireMessages(request),
        stream: true,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            ...(config.apiKey === null ? {} : { authorization: `Bearer ${config.apiKey}` }),
          },
          body,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new ChatProviderError('PROVIDER_ABORTED', 'The request was aborted.', {
            cause: error,
          });
        }
        throw new ChatProviderError(
          'PROVIDER_REQUEST_FAILED',
          'The network request to the provider failed.',
          { cause: error },
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new ChatProviderError(
            'PROVIDER_INVALID_CONFIGURATION',
            'The provider rejected the configured credentials.',
          );
        }
        if (response.status === 429) {
          throw new ChatProviderError(
            'PROVIDER_REQUEST_FAILED',
            'The provider is rate-limiting requests. Try again shortly.',
          );
        }
        throw new ChatProviderError(
          'PROVIDER_REQUEST_FAILED',
          'The provider returned an error response.',
        );
      }

      const content = isEventStream(response)
        ? await readStreamed(response, signal, options?.onChunk)
        : await readWhole(response);

      const result = chatProviderResultSchema.safeParse({ content });
      if (!result.success) {
        throw malformedResponse();
      }
      return result.data;
    },
  };
}

/** The streamed branch, with every failure already normalized. */
async function readStreamed(
  response: Response,
  signal: AbortSignal | undefined,
  onChunk: ((delta: string) => void) | undefined,
): Promise<string> {
  try {
    return await readStreamedCompletion(response, { signal, onChunk });
  } catch (error) {
    if (signal?.aborted) {
      throw new ChatProviderError('PROVIDER_ABORTED', 'The request was aborted.', { cause: error });
    }
    if (error instanceof BoundedReadError) {
      throw new ChatProviderError(
        'PROVIDER_REQUEST_FAILED',
        'The provider response was too large or could not be read.',
        { cause: error },
      );
    }
    // A mid-stream socket failure: the connection dropped, not a bound.
    throw new ChatProviderError(
      'PROVIDER_REQUEST_FAILED',
      'The connection to the provider was lost before the reply completed.',
      { cause: error },
    );
  }
}

/** The non-streamed branch, byte-for-byte the Milestone 3 behaviour. */
async function readWhole(response: Response): Promise<string> {
  let rawText: string;
  try {
    rawText = await readBoundedText(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    throw new ChatProviderError(
      'PROVIDER_REQUEST_FAILED',
      'The provider response was too large or could not be read.',
      { cause: error },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    throw malformedResponse(error);
  }

  const wireResult = chatCompletionResponseSchema.safeParse(parsedJson);
  const content = wireResult.success ? wireResult.data.choices[0]?.message.content : undefined;
  if (typeof content !== 'string') {
    throw malformedResponse();
  }
  return content;
}
