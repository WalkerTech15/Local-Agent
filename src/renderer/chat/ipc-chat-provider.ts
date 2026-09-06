/**
 * Renderer-side `ChatProvider` backed by whichever real, network-capable
 * adapter the main process resolves (Phase 2, Milestones 3-4).
 *
 * This is the one file under `src/renderer/chat` permitted to reference
 * `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does. Every other chat file
 * stays exactly as renderer-local as it was in Milestones 1-2: no IPC, no
 * network, no secret.
 *
 * No network call, no secret, and no privileged API is reachable from this
 * file directly — it only ever calls the three narrow, typed,
 * schema-validated functions the preload bridge exposes (`chat.send`,
 * `chat.cancel`, `chat.onChunk`). The actual HTTP request, the API key, and
 * the provider selection all live in the main process; see
 * `src/main/chat-provider-registry.ts` and the adapters it resolves.
 *
 * Streamed deltas are **previews, never results**: they are forwarded to
 * `options.onChunk` for the caller to display, while the value this function
 * resolves with — the only thing that becomes a conversation message — is
 * still the whole, separately validated reply from `chat.send`.
 *
 * Never trusts text that crossed the IPC boundary: on failure, only the
 * bounded `errorCode` enum from `chatSendResponseSchema` is read. The
 * message shown to the user is always one of this codebase's own fixed,
 * reviewed strings (`ConversationController`'s `describeProviderFailure`),
 * never anything reconstructed from main-process input.
 */

import {
  CHAT_PROVIDER_ERROR_CODES,
  ChatProviderError,
  type ChatProvider,
  type ChatProviderErrorCode,
  type ChatProviderRequest,
  type ChatProviderRequestOptions,
  type ChatProviderResult,
} from '../../shared/chat';

/**
 * The identifier for this adapter, distinct from `MOCK_CHAT_PROVIDER_ID`.
 *
 * Deliberately not the name of any one provider: since Milestone 4 this
 * single adapter fronts whichever real provider the main process resolves
 * (`openai-compatible`, `glm` or `ollama`), and the renderer is never told
 * which — it does not need to know, and not knowing is what keeps provider
 * selection a main-process decision.
 */
export const IPC_CHAT_PROVIDER_ID = 'ipc';

const GENERIC_IPC_FAILURE_MESSAGE = 'The provider request did not succeed.';

function isKnownErrorCode(code: string | undefined): code is ChatProviderErrorCode {
  return code !== undefined && (CHAT_PROVIDER_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Creates the `ChatProvider` that reaches the real adapter through
 * `chat:send`/`chat:cancel`. Cancellation is cooperative: aborting the
 * caller's `AbortSignal` asks the main process (best effort) to abort the
 * matching in-flight request, and always rejects locally with
 * `PROVIDER_ABORTED` regardless of whether that message is acknowledged in
 * time — the caller's own signal, not the round trip, is authoritative for
 * whether this call is considered cancelled.
 */
export function createIpcChatProvider(): ChatProvider {
  return {
    id: IPC_CHAT_PROVIDER_ID,
    async send(
      request: ChatProviderRequest,
      options?: ChatProviderRequestOptions,
    ): Promise<ChatProviderResult> {
      const signal = options?.signal;
      if (signal?.aborted) {
        throw new ChatProviderError('PROVIDER_ABORTED', GENERIC_IPC_FAILURE_MESSAGE);
      }

      const requestId = crypto.randomUUID();
      const onAbort = (): void => {
        void window.localAgent.chat.cancel(requestId);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // Streaming previews (Phase 2, Milestone 4). Subscribed *before* the
      // request is sent, so no early delta can arrive unobserved, and
      // unsubscribed in the `finally` below, so one subscription never
      // outlives the one call it belongs to. Deltas for another request, or
      // any delta after this call was cancelled, are discarded here rather
      // than trusted — the correlating `requestId` is checked on arrival.
      const unsubscribe =
        options?.onChunk === undefined
          ? null
          : window.localAgent.chat.onChunk((chunkEvent) => {
              if (chunkEvent.requestId !== requestId) return;
              if (signal?.aborted) return;
              options.onChunk?.(chunkEvent.delta);
            });

      try {
        const response = await window.localAgent.chat.send(requestId, [...request.messages]);

        if (signal?.aborted) {
          throw new ChatProviderError('PROVIDER_ABORTED', GENERIC_IPC_FAILURE_MESSAGE);
        }

        if (response.outcome === 'success' && response.content !== undefined) {
          return { content: response.content };
        }

        const code = isKnownErrorCode(response.errorCode)
          ? response.errorCode
          : 'PROVIDER_REQUEST_FAILED';
        throw new ChatProviderError(code, GENERIC_IPC_FAILURE_MESSAGE);
      } finally {
        unsubscribe?.();
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
