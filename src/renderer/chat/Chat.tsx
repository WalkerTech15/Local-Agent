import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { useActiveChatProvider } from './useActiveChatProvider';
import { useConversation } from './useConversation';
import type { ChatMessage, ModelProviderSettings } from '../../shared/schemas';

interface ChatProps {
  readonly assistantName: string;
  readonly modelProvider: ModelProviderSettings;
}

const ROLE_LABELS: Record<ChatMessage['role'], string> = {
  system: 'System',
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
};

/**
 * One message bubble.
 *
 * `message.content` is rendered as plain JSX text — React escapes every
 * string child by default, so this can never inject HTML or execute a
 * script, no matter what a provider (mock today, real in a later phase)
 * returns. `dangerouslySetInnerHTML` and Markdown-to-HTML rendering are
 * deliberately absent from this milestone; see
 * `docs/phase-2-chat-architecture.md`. `white-space: pre-wrap` (in
 * `styles.css`) preserves line breaks without needing to turn `\n` into
 * markup.
 */
function MessageBubble({ message }: { readonly message: ChatMessage }) {
  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <span className="chat-message__role">{ROLE_LABELS[message.role]}</span>
      <p className="chat-message__content">{message.content}</p>
    </div>
  );
}

/**
 * Chat surface for Phase 2, Milestones 1–2.
 *
 * Resolves its provider through `useActiveChatProvider` — never imports the
 * mock directly — entirely inside the renderer: no IPC channel, no call to
 * `window.localAgent`, so nothing typed here can reach a privileged API, a
 * file, the network, or an action the permission engine would need to see.
 * Assistant text is untrusted output: displayed, never executed, never
 * treated as authorization for anything.
 */
export function Chat({ assistantName, modelProvider }: ChatProps) {
  const { provider, status } = useActiveChatProvider(modelProvider);
  const { state, canSubmit, submit, retry } = useConversation(provider);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit || draft.trim().length === 0) return;
    const content = draft;
    setDraft('');
    await submit(content);
    inputRef.current?.focus();
  }

  /**
   * Enter sends; Shift+Enter inserts a newline, since chat content is
   * multi-line-capable. Delegates to the real form submit rather than
   * calling `handleSubmit` with a hand-built event, so the browser's native
   * `HTMLFormElement.requestSubmit()` path — including any future native
   * form validation — runs exactly as it would for a mouse click.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="chat" aria-label={`Chat with ${assistantName}`}>
      {/*
        Safe provider status only: a fixed label plus a fixed template
        string built from it (see `describeChatProviderStatus`) — never a
        key, a header, a URL, or `hasApiKey`. `Chat.tsx` never even receives
        a value that could contain one.
      */}
      <p className="chat__provider-status">{status.summary}</p>
      <div className="chat__transcript" role="log" aria-live="polite" aria-label="Conversation">
        {state.messages.length === 0 ? (
          <p className="chat__empty">No messages yet. Say hello to {assistantName}.</p>
        ) : (
          state.messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
        {state.status === 'awaiting-response' && (
          <p className="chat__loading" aria-live="polite">
            {assistantName} is thinking…
          </p>
        )}
      </div>

      {state.error && (
        <div className="chat__error" role="alert">
          <p>{state.error.message}</p>
          <button type="button" onClick={() => void retry()} disabled={!canSubmit}>
            Retry
          </button>
        </div>
      )}

      <form className="chat__composer" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="chat-composer-input" className="chat__composer-label">
          Message
        </label>
        <textarea
          id="chat-composer-input"
          ref={inputRef}
          value={draft}
          maxLength={8000}
          rows={2}
          placeholder={`Message ${assistantName}… (Enter to send, Shift+Enter for a new line)`}
          disabled={!canSubmit}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" disabled={!canSubmit || draft.trim().length === 0}>
          {canSubmit ? 'Send' : 'Sending…'}
        </button>
      </form>
    </section>
  );
}
