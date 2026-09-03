/**
 * Renderer-side `ChatProvider` backed by the real, network-capable adapter
 * that lives in the main process (Phase 2, Milestone 3).
 *
 * This is the one file under `src/renderer/chat` permitted to reference
 * `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does. Every other chat file
 * stays exactly as renderer-local as it was in Milestones 1-2: no IPC, no
 * network, no secret.
 *
 * No network call, no secret, and no privileged API is reachable from this
 * file directly — it only ever calls the two narrow, typed,
 * schema-validated functions the preload bridge exposes (`chat.send`,
 * `chat.cancel`). The actual HTTP request, the API key, and the provider
 * selection all live in the main process; see
 * `src/main/chat-provider-registry.ts` and
 * `src/main/openai-compatible-provider.ts`.
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

/** The identifier for this adapter, distinct from `MOCK_CHAT_PROVIDER_ID`. */
export const IPC_CHAT_PROVIDER_ID = 'openai-compatible';

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
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
