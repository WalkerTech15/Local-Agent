import { describe, expect, it, vi } from 'vitest';

import { ConversationController } from '../../../src/renderer/chat/conversation-controller';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import type {
  ChatProvider,
  ChatProviderRequest,
  ChatProviderResult,
} from '../../../src/shared/chat/provider';
import {
  CHAT_CONVERSATION_MAX_MESSAGES,
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
} from '../../../src/shared/constants';

/** A test clock and id source that never repeats and never depends on the wall clock. */
function makeDeps() {
  const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
  let tick = 0;
  let idCounter = 0;
  return {
    // Adds whole seconds via real Date arithmetic rather than formatting the
    // tick directly into the seconds field, so this stays a valid ISO-8601
    // timestamp no matter how many messages a test creates (a naive
    // `:${tick}` field overflows past 59 seconds and starts producing
    // strings `z.iso.datetime()` correctly rejects).
    now: () => {
      tick += 1;
      return new Date(baseMs + tick * 1000).toISOString();
    },
    generateId: () => {
      idCounter += 1;
      return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
    },
  };
}

/** A provider whose resolution is controlled by the test, to inspect intermediate state. */
function deferredProvider(): {
  provider: ChatProvider;
  resolve: (result: ChatProviderResult) => void;
  reject: (error: unknown) => void;
  calls: ChatProviderRequest[];
} {
  const calls: ChatProviderRequest[] = [];
  let resolveFn: (result: ChatProviderResult) => void = () => undefined;
  let rejectFn: (error: unknown) => void = () => undefined;

  const provider: ChatProvider = {
    id: 'deferred-test-provider',
    send: (request) => {
      calls.push(request);
      return new Promise<ChatProviderResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
  };

  return {
    provider,
    resolve: (result) => {
      resolveFn(result);
    },
    reject: (error) => {
      rejectFn(error);
    },
    calls,
  };
}

/** A provider that resolves or rejects on the next microtask, for straight-line async tests. */
function instantProvider(
  handler: (request: ChatProviderRequest) => ChatProviderResult,
): ChatProvider {
  return {
    id: 'instant-test-provider',
    send: (request) => Promise.resolve(handler(request)),
  };
}

describe('ConversationController', () => {
  it('starts empty, idle, with no error', () => {
    const controller = new ConversationController({
      provider: instantProvider(() => ({ content: 'unused' })),
      ...makeDeps(),
    });
    expect(controller.getState()).toEqual({ messages: [], status: 'idle', error: null });
    expect(controller.canSubmit).toBe(true);
  });

  it('adds the user message immediately and enters awaiting-response before the provider resolves', async () => {
    const { provider, resolve, calls } = deferredProvider();
    const controller = new ConversationController({ provider, ...makeDeps() });

    const submitPromise = controller.submit('hello there');

    // Synchronous portion of submit() has already run by the time this line
    // executes, since nothing before the provider call awaits anything.
    expect(controller.getState().status).toBe('awaiting-response');
    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().messages[0]).toMatchObject({
      role: 'user',
      content: 'hello there',
    });
    expect(calls).toHaveLength(1);

    resolve({ content: 'a reply' });
    await submitPromise;

    expect(controller.getState().status).toBe('idle');
    expect(controller.getState().messages).toHaveLength(2);
    expect(controller.getState().messages[1]).toMatchObject({
      role: 'assistant',
      content: 'a reply',
    });
  });

  it('trims whitespace before storing the user message', async () => {
    const controller = new ConversationController({
      provider: instantProvider(() => ({ content: 'ok' })),
      ...makeDeps(),
    });
    await controller.submit('   hello with padding   ');
    expect(controller.getState().messages[0]?.content).toBe('hello with padding');
  });

  it('is a no-op for a whitespace-only message', async () => {
    const controller = new ConversationController({
      provider: instantProvider(() => ({ content: 'ok' })),
      ...makeDeps(),
    });
    await controller.submit('    ');
    expect(controller.getState()).toEqual({ messages: [], status: 'idle', error: null });
  });

  it('prevents a second submission while a response is pending', async () => {
    const { provider, resolve, calls } = deferredProvider();
    const controller = new ConversationController({ provider, ...makeDeps() });

    const first = controller.submit('first message');
    await controller.submit('second message'); // should be a no-op: status is not idle

    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().messages[0]?.content).toBe('first message');
    expect(calls).toHaveLength(1);

    resolve({ content: 'reply' });
    await first;
  });

  it('renders assistant output only as message content, never interpreted as markup or code', async () => {
    const hostile = '<img src=x onerror=alert(1)>${process.exit(1)}';
    const controller = new ConversationController({
      provider: instantProvider(() => ({ content: hostile })),
      ...makeDeps(),
    });
    await controller.submit('trigger');
    expect(controller.getState().messages[1]?.content).toBe(hostile);
    // The controller stores it as an inert string field; src/renderer/chat/Chat.tsx
    // is responsible for rendering it as JSX text (verified by inspection: no
    // dangerouslySetInnerHTML anywhere in that file) rather than markup.
  });

  it('keeps prior conversation intact after a provider failure', async () => {
    const controller = new ConversationController({
      provider: instantProvider(() => {
        throw new ChatProviderError('PROVIDER_REQUEST_FAILED', 'simulated failure');
      }),
      ...makeDeps(),
    });

    await controller.submit('will fail');

    const state = controller.getState();
    expect(state.status).toBe('idle');
    expect(state.error).not.toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: 'user', content: 'will fail' });
  });

  it('never leaks a raw provider error message into conversation state', async () => {
    const controller = new ConversationController({
      provider: instantProvider(() => {
        throw new Error('internal secret detail: connection string leaked here');
      }),
      ...makeDeps(),
    });

    await controller.submit('trigger');

    expect(controller.getState().error?.message).not.toContain('connection string');
  });

  it('retries using the existing user message without adding a duplicate', async () => {
    let attempt = 0;
    const controller = new ConversationController({
      provider: {
        id: 'flaky',
        send: (request) => {
          attempt += 1;
          if (attempt === 1) {
            return Promise.reject(
              new ChatProviderError('PROVIDER_REQUEST_FAILED', 'first attempt fails'),
            );
          }
          return Promise.resolve({
            content: `ok on attempt ${String(attempt)}, saw ${String(request.messages.length)} messages`,
          });
        },
      },
      ...makeDeps(),
    });

    await controller.submit('please retry me');
    expect(controller.getState().error).not.toBeNull();
    expect(controller.getState().messages).toHaveLength(1);

    await controller.retry();

    const state = controller.getState();
    expect(state.error).toBeNull();
    expect(state.status).toBe('idle');
    // Exactly one user message and one assistant message — retry did not
    // insert a second copy of the user's message.
    expect(state.messages).toHaveLength(2);
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(state.messages[1]?.content).toContain('ok on attempt 2');
  });

  it('retry is a no-op when there is no standing error', async () => {
    const send = vi.fn(() => Promise.resolve({ content: 'ok' }));
    const controller = new ConversationController({
      provider: { id: 'counting', send },
      ...makeDeps(),
    });

    await controller.submit('hello');
    expect(send).toHaveBeenCalledTimes(1);

    await controller.retry(); // no error present — must not call the provider again
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retry is a no-op while a response is already pending', async () => {
    const { provider, resolve, calls } = deferredProvider();
    const controller = new ConversationController({ provider, ...makeDeps() });

    const submitPromise = controller.submit('hello');
    await controller.retry(); // status is awaiting-response, not idle

    expect(calls).toHaveLength(1);
    resolve({ content: 'ok' });
    await submitPromise;
  });

  it('rejects an oversized message without changing prior state or contacting the provider', async () => {
    const send = vi.fn(() => Promise.resolve({ content: 'unused' }));
    const controller = new ConversationController({
      provider: { id: 'counting', send },
      ...makeDeps(),
    });

    await controller.submit('a'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH + 1));

    expect(send).not.toHaveBeenCalled();
    const state = controller.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.status).toBe('idle');
    expect(state.error).not.toBeNull();
  });

  it('refuses to submit once the conversation reaches its maximum length', async () => {
    const send = vi.fn(() => Promise.resolve({ content: 'ok' }));
    const controller = new ConversationController({
      provider: { id: 'counting', send },
      ...makeDeps(),
    });

    const rounds = CHAT_CONVERSATION_MAX_MESSAGES / 2;
    for (let i = 0; i < rounds; i += 1) {
      await controller.submit(`message ${String(i)}`);
    }

    expect(controller.getState().messages).toHaveLength(CHAT_CONVERSATION_MAX_MESSAGES);
    expect(send).toHaveBeenCalledTimes(rounds);

    await controller.submit('one too many');

    expect(controller.getState().messages).toHaveLength(CHAT_CONVERSATION_MAX_MESSAGES);
    expect(controller.getState().error?.message).toMatch(/maximum length/i);
    // The bound is enforced before the provider is ever contacted again.
    expect(send).toHaveBeenCalledTimes(rounds);
  }, 20_000);

  it('stops delivering state updates to subscribers after dispose', async () => {
    const { provider, resolve } = deferredProvider();
    const controller = new ConversationController({ provider, ...makeDeps() });
    const listener = vi.fn();
    controller.subscribe(listener);

    const submitPromise = controller.submit('hello');
    listener.mockClear();

    controller.dispose();
    resolve({ content: 'too late' });
    await submitPromise.catch(() => undefined);

    expect(listener).not.toHaveBeenCalled();
  });
});
