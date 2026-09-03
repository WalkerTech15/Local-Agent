import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatProviderError } from '../../../src/shared/chat/provider';
import { createMockChatProvider } from '../../../src/shared/chat/mock-provider';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';
import {
  MOCK_CHAT_PROVIDER_FAILURE_TRIGGER,
  MOCK_CHAT_PROVIDER_ID,
} from '../../../src/shared/constants';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function userMessage(content: string, id = '11111111-1111-4111-8111-111111111111') {
  return createChatMessage({ id, role: 'user', content, createdAt: CREATED_AT });
}

describe('createMockChatProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has the documented provider id', () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    expect(provider.id).toBe(MOCK_CHAT_PROVIDER_ID);
  });

  it('is deterministic: the same conversation produces the same reply', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    const request = { messages: [userMessage('hello there')] };

    const first = await provider.send(request);
    const second = await provider.send(request);

    expect(first).toEqual(second);
  });

  it('marks the response clearly as a mock reply', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    const result = await provider.send({ messages: [userMessage('hello')] });
    expect(result.content).toContain('[Mock provider]');
  });

  it('echoes the latest user message content into the reply', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    const result = await provider.send({ messages: [userMessage('a very specific phrase')] });
    expect(result.content).toContain('a very specific phrase');
  });

  it('truncates a very long echoed message rather than reproducing it in full', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    const longContent = 'x'.repeat(500);
    const result = await provider.send({ messages: [userMessage(longContent)] });
    expect(result.content.length).toBeLessThan(longContent.length);
  });

  it('handles a conversation with no user message yet without throwing', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    const result = await provider.send({ messages: [] });
    expect(result.content).toContain('[Mock provider]');
  });

  it('never returns oversized content', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    const result = await provider.send({ messages: [userMessage('x'.repeat(7999))] });
    expect(result.content.length).toBeLessThanOrEqual(8000);
  });

  it('resolves only after the configured delay', async () => {
    vi.useFakeTimers();
    try {
      const provider = createMockChatProvider({ delayMs: 1000 });
      let resolved = false;
      const promise = provider.send({ messages: [userMessage('hi')] }).then((result) => {
        resolved = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(600);
      expect(resolved).toBe(true);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects deterministically when the message content is the documented failure trigger', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    await expect(
      provider.send({ messages: [userMessage(MOCK_CHAT_PROVIDER_FAILURE_TRIGGER)] }),
    ).rejects.toBeInstanceOf(ChatProviderError);
  });

  it('reports PROVIDER_REQUEST_FAILED for the deliberate failure trigger', async () => {
    const provider = createMockChatProvider({ delayMs: 0 });
    await expect(
      provider.send({ messages: [userMessage(MOCK_CHAT_PROVIDER_FAILURE_TRIGGER)] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
  });

  it('rejects immediately with PROVIDER_ABORTED when the signal is already aborted', async () => {
    const provider = createMockChatProvider({ delayMs: 1000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.send({ messages: [userMessage('hi')] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
  });

  it('rejects with PROVIDER_ABORTED when the signal fires mid-delay', async () => {
    vi.useFakeTimers();
    try {
      const provider = createMockChatProvider({ delayMs: 1000 });
      const controller = new AbortController();

      const promise = provider.send(
        { messages: [userMessage('hi')] },
        { signal: controller.signal },
      );
      const assertion = expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });

      await vi.advanceTimersByTimeAsync(200);
      controller.abort();

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls the global fetch function', async () => {
    if (typeof globalThis.fetch !== 'function') {
      // Nothing to spy on in this runtime; the eslint boundary on
      // src/shared already forbids referencing `fetch` at all, which is the
      // stronger, always-on guarantee. See eslint.config.js.
      return;
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = createMockChatProvider({ delayMs: 0 });

    await provider.send({ messages: [userMessage('hello')] });
    await provider
      .send({ messages: [userMessage(MOCK_CHAT_PROVIDER_FAILURE_TRIGGER)] })
      .catch(() => undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
