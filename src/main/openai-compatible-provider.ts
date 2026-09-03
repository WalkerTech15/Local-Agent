/**
 * The real OpenAI-compatible chat provider adapter (Phase 2, Milestone 3).
 *
 * The first, and so far only, `ChatProvider` implementation in this codebase
 * that makes a real network request. It lives in `src/main` deliberately —
 * `src/shared`, where every other `ChatProvider` lives, structurally cannot
 * perform network access (see `src/shared/chat/provider.ts`'s doc comment) —
 * and is never imported by `src/renderer` or `src/shared`: the renderer
 * reaches it only through the `chat:send` IPC channel (`main/ipc.ts`), which
 * resolves it through `main/chat-provider-registry.ts`.
 *
 * Security properties, all structural, not conventions:
 *
 *  - **The plaintext API key is a plain function parameter, never a module
 *    global.** It is read from the encrypted secret store immediately before
 *    this module is called (`main/chat-provider-registry.ts`) and is used
 *    only to build one `Authorization` header per request. It is never
 *    logged, never placed in a thrown error's `message`, and never appears
 *    in this module's return value.
 *  - **Nothing here logs a request or a response.** No `console.log` (or
 *    equivalent) exists anywhere in this file — not the outgoing headers,
 *    not the request body (which carries the user's conversation), not the
 *    raw response body, not a caught error's message.
 *  - **The upstream response is never trusted structurally.** Its body is
 *    read under a byte cap ({@link MAX_RESPONSE_BYTES}) before it is ever
 *    parsed as JSON, and the extracted `content` is validated by the same
 *    {@link chatProviderResultSchema} every other provider's result is
 *    validated by — bounded length, no unsafe control characters, no bidi
 *    overrides — before this function ever returns it.
 *  - **Every failure normalizes into the existing five-code vocabulary**
 *    (`src/shared/chat/provider.ts`) — never a raw `Error.message`, a URL, a
 *    header, or a status body reaches a caller of this module.
 */

import { z } from 'zod';

import {
  ChatProviderError,
  type ChatProvider,
  type ChatProviderRequest,
  type ChatProviderRequestOptions,
  type ChatProviderResult,
} from '../shared/chat/provider';
import { chatProviderResultSchema } from '../shared/schemas/chat.schema';

/** OpenAI-compatible chat completions endpoint, relative to the configured base URL. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Upper bound on the bytes read from a response body before this module
 * gives up and reports a malformed response, rather than buffering an
 * unbounded amount of memory for a hostile or misbehaving endpoint — the
 * base URL is user-supplied (including self-hosted endpoints), so it is
 * never assumed to be well-behaved. Generous for any real chat completion
 * (a very long reply is still a few hundred KB of JSON at most) and tight
 * enough to bound memory use for a pathological response.
 */
export const MAX_RESPONSE_BYTES = 1_000_000;

export interface OpenAiCompatibleProviderConfig {
  /** Already validated: absolute http/https, no embedded credentials — see `settingsSchema`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Plaintext, decrypted immediately before this is constructed. Never logged. */
  readonly apiKey: string;
}

/** Only the roles this milestone's chat can produce are forwarded to the wire format. */
const FORWARDED_ROLES = new Set(['system', 'user', 'assistant']);

const chatCompletionMessageSchema = z.object({
  content: z.string().nullable().optional(),
});
const chatCompletionChoiceSchema = z.object({
  message: chatCompletionMessageSchema,
});
/**
 * The minimal shape this adapter reads from an OpenAI-compatible response.
 * Deliberately not `strictObject`: this describes an upstream API this
 * codebase does not control, which may carry vendor-specific fields this
 * adapter has no use for and must not reject on that basis alone — only the
 * one field this function actually reads is validated.
 */
const chatCompletionResponseSchema = z.object({
  choices: z.array(chatCompletionChoiceSchema).min(1).max(32),
});

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

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
      throw new Error('response body exceeds the configured byte cap');
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
      throw new Error('response body exceeds the configured byte cap');
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

function toWireMessages(
  request: ChatProviderRequest,
): { readonly role: string; readonly content: string }[] {
  return request.messages
    .filter((message) => FORWARDED_ROLES.has(message.role))
    .map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Creates the real OpenAI-compatible adapter for one resolved configuration.
 *
 * Callers apply `withProviderTimeout` around the returned provider — this
 * function starts no timer of its own, matching every other `ChatProvider`
 * in this codebase (see `src/shared/chat/timeout.ts`).
 */
export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleProviderConfig,
): ChatProvider {
  return {
    id: 'openai-compatible',
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
        stream: false,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
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
        throw new ChatProviderError(
          'PROVIDER_REQUEST_FAILED',
          'The provider returned a malformed response.',
          { cause: error },
        );
      }

      const wireResult = chatCompletionResponseSchema.safeParse(parsedJson);
      const content = wireResult.success ? wireResult.data.choices[0]?.message.content : undefined;
      if (typeof content !== 'string') {
        throw new ChatProviderError(
          'PROVIDER_REQUEST_FAILED',
          'The provider returned a malformed response.',
        );
      }

      const result = chatProviderResultSchema.safeParse({ content });
      if (!result.success) {
        throw new ChatProviderError(
          'PROVIDER_REQUEST_FAILED',
          'The provider returned a malformed response.',
        );
      }

      return result.data;
    },
  };
}
