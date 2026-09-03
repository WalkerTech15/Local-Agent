/**
 * Conversation state management (Phase 2, Milestone 1).
 *
 * Framework-independent on purpose: `ConversationController` holds no
 * reference to React and imports nothing from `src/renderer` other than the
 * shared chat schema and provider types. This is the same split the main
 * process already uses elsewhere in this codebase — a pure core
 * (`decidePermission`, `main/settings-service.ts`) behind a thin adapter that
 * does the I/O or, here, the UI binding (`useConversation.ts`) — and it means
 * every conversation behaviour below (submit, retry, loading, failure,
 * duplicate-submission prevention) is unit-testable with plain Vitest, no
 * React Testing Library or DOM required.
 *
 * The message list is append-only. Once a message is added, it is never
 * mutated or removed — including on failure or retry, so prior conversation
 * is never lost. Loading and error state live outside the message array
 * entirely; see `CHAT_MESSAGE_STATUSES`'s doc comment in `src/shared/constants.ts`
 * for why a failed attempt does not become an `'error'`-status message.
 *
 * This module never imports Electron, never touches `window.localAgent`,
 * and never reaches the filesystem, the network, or any privileged API.
 * Nothing a `ChatProvider` returns is ever treated as authorization for an
 * action — there is no action to authorize here at all.
 */

import {
  chatProviderRequestSchema,
  chatProviderResultSchema,
  createChatMessage,
  type ChatMessage,
} from '../../shared/schemas';
import { CHAT_CONVERSATION_MAX_MESSAGES } from '../../shared/constants';
import type { ChatProvider } from '../../shared/chat';

export type ConversationStatus = 'idle' | 'awaiting-response';

export interface ConversationError {
  readonly message: string;
}

export interface ConversationState {
  readonly messages: readonly ChatMessage[];
  readonly status: ConversationStatus;
  readonly error: ConversationError | null;
}

export type ConversationListener = (state: ConversationState) => void;

export interface ConversationControllerDeps {
  readonly provider: ChatProvider;
  /** Injectable for deterministic tests. Defaults to the real clock. */
  readonly now?: () => string;
  /** Injectable for deterministic tests. Defaults to `crypto.randomUUID()`. */
  readonly generateId?: () => string;
}

function initialState(): ConversationState {
  return { messages: [], status: 'idle', error: null };
}

const GENERIC_SEND_ERROR =
  'Your message could not be sent. It may be too long or contain characters that are not allowed.';
const GENERIC_PROVIDER_ERROR =
  'The assistant could not respond. Your message was not lost — you can try again.';
const CONVERSATION_FULL_ERROR =
  'This conversation has reached its maximum length. Start a new conversation to continue.';

/**
 * Turns a thrown provider or validation error into conversation-facing text.
 *
 * Deliberately never forwards a raw `Error.message`: an assistant reply is
 * untrusted output, and so, symmetrically, is whatever a provider
 * implementation throws — a raw message could describe an internal detail
 * (a URL, a stack fragment) that has no reason to reach the interface. Every
 * failure gets the same generic, safe message today; this function is the
 * one place a later milestone would add provider-specific wording (a
 * distinct message for a timeout versus a rejected key, say) without
 * touching the state machine around it. The aborted case
 * (`ChatProviderError` with code `'PROVIDER_ABORTED'`) never actually reaches
 * here — `requestAssistantReply` returns before calling this function
 * whenever its own `AbortSignal` fired — so there is nothing to special-case
 * yet.
 */
function describeProviderFailure(_error: unknown): string {
  return GENERIC_PROVIDER_ERROR;
}

/**
 * Orchestrates one conversation against one `ChatProvider`.
 *
 * Not a React hook — see `useConversation.ts` for the thin binding that
 * exposes this to a component via `useState`/`useEffect`.
 */
export class ConversationController {
  private provider: ChatProvider;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly listeners = new Set<ConversationListener>();
  private state: ConversationState = initialState();
  private activeAbortController: AbortController | null = null;
  private disposed = false;

  constructor(deps: ConversationControllerDeps) {
    this.provider = deps.provider;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
  }

  getState(): ConversationState {
    return this.state;
  }

  /** True while idle and able to accept a new submission or a retry. */
  get canSubmit(): boolean {
    return this.state.status === 'idle';
  }

  /**
   * Switches which `ChatProvider` this conversation talks to, without
   * losing any prior message. A no-op when `provider` is the same reference
   * already in use.
   *
   * Any request already in flight against the previous provider is aborted
   * first — its `AbortSignal` fires, so `requestAssistantReply`'s own
   * `if (controller.signal.aborted) return;` guard discards whatever it was
   * waiting for, and that stale response can never be appended to the
   * conversation the new provider is now serving. `status` returns to
   * `'idle'` so the composer is usable again immediately, rather than left
   * showing "awaiting response" for a request that will never resolve into
   * this conversation.
   */
  setProvider(provider: ChatProvider): void {
    if (provider === this.provider) return;
    this.provider = provider;
    this.activeAbortController?.abort();
    if (this.state.status === 'awaiting-response') {
      this.setState({ ...this.state, status: 'idle' });
    }
  }

  subscribe(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: ConversationState): void {
    this.state = next;
    if (this.disposed) return;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /**
   * Adds the user's message and requests a reply.
   *
   * A no-op while a response is already pending — the duplicate-submission
   * guard — and a no-op for a blank (whitespace-only) message. Content is
   * trimmed before it becomes part of the conversation, matching the
   * onboarding form's existing convention for user-typed fields.
   */
  async submit(rawContent: string): Promise<void> {
    if (!this.canSubmit) return;

    const trimmed = rawContent.trim();
    if (trimmed.length === 0) return;

    if (this.state.messages.length >= CHAT_CONVERSATION_MAX_MESSAGES) {
      this.setState({ ...this.state, error: { message: CONVERSATION_FULL_ERROR } });
      return;
    }

    let userMessage: ChatMessage;
    try {
      userMessage = createChatMessage({
        id: this.generateId(),
        role: 'user',
        content: trimmed,
        createdAt: this.now(),
      });
    } catch {
      this.setState({ ...this.state, error: { message: GENERIC_SEND_ERROR } });
      return;
    }

    const nextMessages = [...this.state.messages, userMessage];
    this.setState({ messages: nextMessages, status: 'awaiting-response', error: null });
    await this.requestAssistantReply(nextMessages);
  }

  /**
   * Re-requests a reply for the current conversation after a failure.
   *
   * Adds no new user message — the one already in the transcript is reused
   * exactly as submitted. A no-op unless idle with a standing error, so
   * retry cannot fire concurrently with a submission or with itself.
   */
  async retry(): Promise<void> {
    if (!this.canSubmit) return;
    if (this.state.error === null) return;
    if (this.state.messages.length === 0) return;

    const messages = this.state.messages;
    this.setState({ messages, status: 'awaiting-response', error: null });
    await this.requestAssistantReply(messages);
  }

  private async requestAssistantReply(messages: readonly ChatMessage[]): Promise<void> {
    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      // Defence in depth: `messages` is already every element individually
      // validated by `createChatMessage`, and `submit()`'s own runtime check
      // already keeps the array at or under `CHAT_CONVERSATION_MAX_MESSAGES`
      // before this is ever reached — but this is the schema-level backstop
      // for that same bound at the exact boundary a request crosses into a
      // provider, so a future bug in either caller does not silently send an
      // unbounded request. Never expected to reject in normal operation.
      const request = chatProviderRequestSchema.parse({ messages });
      const rawResult = await this.provider.send(request, { signal: controller.signal });
      if (controller.signal.aborted) return;

      // The provider's raw result is untrusted the moment it returns —
      // whether that is the deterministic mock today or a real adapter in a
      // later phase — so it is validated here, before any of it is trusted
      // enough to become part of the conversation.
      const result = chatProviderResultSchema.parse(rawResult);

      const assistantMessage = createChatMessage({
        id: this.generateId(),
        role: 'assistant',
        content: result.content,
        createdAt: this.now(),
      });
      this.setState({ messages: [...messages, assistantMessage], status: 'idle', error: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.setState({
        messages,
        status: 'idle',
        error: { message: describeProviderFailure(error) },
      });
    }
  }

  /**
   * Aborts any in-flight request and stops delivering further state updates.
   *
   * Called from `useConversation.ts`'s unmount cleanup, mirroring the
   * `cancelled` flag `App.tsx` already uses around its own async effects —
   * here backed by a real `AbortSignal` passed to the provider, rather than
   * only a local flag, since {@link ChatProvider.send} accepts one.
   */
  dispose(): void {
    this.disposed = true;
    this.activeAbortController?.abort();
  }
}
