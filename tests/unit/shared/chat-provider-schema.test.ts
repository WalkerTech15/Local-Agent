import { describe, expect, it } from 'vitest';

import {
  chatProviderRequestSchema,
  chatProviderResultSchema,
  createChatMessage,
} from '../../../src/shared/schemas/chat.schema';
import {
  CHAT_CONVERSATION_MAX_MESSAGES,
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
} from '../../../src/shared/constants';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function userMessage(content: string, id = '11111111-1111-4111-8111-111111111111') {
  return createChatMessage({ id, role: 'user', content, createdAt: CREATED_AT });
}

describe('chatProviderRequestSchema', () => {
  it('accepts a request with a normal-sized conversation', () => {
    const result = chatProviderRequestSchema.safeParse({ messages: [userMessage('hello')] });
    expect(result.success).toBe(true);
  });

  it('accepts an empty conversation (first request has no history)', () => {
    const result = chatProviderRequestSchema.safeParse({ messages: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a conversation at exactly the maximum length', () => {
    const messages = Array.from({ length: CHAT_CONVERSATION_MAX_MESSAGES }, (_, index) =>
      userMessage(
        `message ${String(index)}`,
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    );
    const result = chatProviderRequestSchema.safeParse({ messages });
    expect(result.success).toBe(true);
  });

  it('rejects a conversation one message past the maximum length', () => {
    const messages = Array.from({ length: CHAT_CONVERSATION_MAX_MESSAGES + 1 }, (_, index) =>
      userMessage(
        `message ${String(index)}`,
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    );
    const result = chatProviderRequestSchema.safeParse({ messages });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    const result = chatProviderRequestSchema.safeParse({
      messages: [userMessage('hello')],
      apiKey: 'sk-not-real-test-only',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed message inside the conversation', () => {
    const result = chatProviderRequestSchema.safeParse({
      messages: [{ id: 'not-a-uuid', role: 'user', content: 'hi', createdAt: CREATED_AT }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a message carrying an unredacted secret-looking metadata field', () => {
    const message = {
      id: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      content: 'hello',
      createdAt: CREATED_AT,
      metadata: { apiKey: 'sk-not-real-test-only' },
    };
    const result = chatProviderRequestSchema.safeParse({ messages: [message] });
    expect(result.success).toBe(false);
  });
});

describe('chatProviderResultSchema', () => {
  it('accepts a well-formed result', () => {
    const result = chatProviderResultSchema.safeParse({ content: 'a reply' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty content string', () => {
    const result = chatProviderResultSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string content', () => {
    const result = chatProviderResultSchema.safeParse({ content: 12345 });
    expect(result.success).toBe(false);
  });

  it('rejects content past the maximum length', () => {
    const result = chatProviderResultSchema.safeParse({
      content: 'a'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects content containing an unsafe control character', () => {
    const result = chatProviderResultSchema.safeParse({ content: 'hello\x00world' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field, so a provider cannot smuggle extra data past this boundary', () => {
    const result = chatProviderResultSchema.safeParse({
      content: 'a reply',
      confidence: 0.9,
      rawUpstreamError: { status: 500 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing content field', () => {
    const result = chatProviderResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
