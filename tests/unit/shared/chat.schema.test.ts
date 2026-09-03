import { describe, expect, it } from 'vitest';

import { CHAT_MESSAGE_CONTENT_MAX_LENGTH, CHAT_MESSAGE_ROLES } from '../../../src/shared/constants';
import { chatMessageSchema, createChatMessage } from '../../../src/shared/schemas/chat.schema';

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const VALID_CREATED_AT = '2026-01-01T00:00:00.000Z';

function validMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALID_ID,
    role: 'user',
    content: 'Hello there',
    createdAt: VALID_CREATED_AT,
    ...overrides,
  };
}

describe('chatMessageSchema', () => {
  it('accepts a well-formed message', () => {
    const result = chatMessageSchema.safeParse(validMessage());
    expect(result.success).toBe(true);
  });

  it.each(CHAT_MESSAGE_ROLES)('accepts every declared role: %s', (role) => {
    const result = chatMessageSchema.safeParse(validMessage({ role }));
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognised role', () => {
    const result = chatMessageSchema.safeParse(validMessage({ role: 'admin' }));
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    const result = chatMessageSchema.safeParse(validMessage({ apiKey: 'sk-not-real-test-only' }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID id', () => {
    const result = chatMessageSchema.safeParse(validMessage({ id: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('rejects a createdAt with a UTC offset instead of Z', () => {
    const result = chatMessageSchema.safeParse(
      validMessage({ createdAt: '2026-01-01T00:00:00.000+02:00' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an empty content string', () => {
    const result = chatMessageSchema.safeParse(validMessage({ content: '' }));
    expect(result.success).toBe(false);
  });

  it('accepts content at exactly the maximum length', () => {
    const content = 'a'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH);
    const result = chatMessageSchema.safeParse(validMessage({ content }));
    expect(result.success).toBe(true);
  });

  it('rejects content one character past the maximum length', () => {
    const content = 'a'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH + 1);
    const result = chatMessageSchema.safeParse(validMessage({ content }));
    expect(result.success).toBe(false);
  });

  it('allows tab, newline and carriage return inside content', () => {
    const result = chatMessageSchema.safeParse(
      validMessage({ content: 'line one\nline two\tindented\r\nline three' }),
    );
    expect(result.success).toBe(true);
  });

  it.each([
    ['NUL', '\x00'],
    ['BEL', '\x07'],
    ['ESC', '\x1B'],
    ['DEL', '\x7F'],
  ])('rejects content containing a %s control character', (_label, char) => {
    const result = chatMessageSchema.safeParse(validMessage({ content: `hello${char}world` }));
    expect(result.success).toBe(false);
  });

  it('rejects content containing a bidirectional override character', () => {
    const result = chatMessageSchema.safeParse(validMessage({ content: 'safe looking ‮text' }));
    expect(result.success).toBe(false);
  });

  it('accepts an optional status of "complete" or "error"', () => {
    expect(chatMessageSchema.safeParse(validMessage({ status: 'complete' })).success).toBe(true);
    expect(chatMessageSchema.safeParse(validMessage({ status: 'error' })).success).toBe(true);
  });

  it('rejects an unrecognised status', () => {
    const result = chatMessageSchema.safeParse(validMessage({ status: 'streaming' }));
    expect(result.success).toBe(false);
  });

  it('accepts a message with no status and no metadata at all', () => {
    const result = chatMessageSchema.safeParse(validMessage());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
      expect(result.data.metadata).toBeUndefined();
    }
  });

  it('accepts safe, bounded metadata', () => {
    const result = chatMessageSchema.safeParse(
      validMessage({ metadata: { source: 'mock', turn: 1 } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects metadata carrying a secret-looking field with a real-looking value', () => {
    const result = chatMessageSchema.safeParse(
      validMessage({ metadata: { apiKey: 'sk-not-real-test-only' } }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts metadata carrying a secret-looking field only when already redacted', () => {
    const result = chatMessageSchema.safeParse(
      validMessage({ metadata: { apiKey: '[REDACTED]' } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects metadata containing a function or other non-JSON value', () => {
    const result = chatMessageSchema.safeParse(
      validMessage({ metadata: { handler: () => 'not json safe' } }),
    );
    expect(result.success).toBe(false);
  });
});

describe('createChatMessage', () => {
  it('returns a validated message for valid input', () => {
    const message = createChatMessage({
      id: VALID_ID,
      role: 'assistant',
      content: 'a validated reply',
      createdAt: VALID_CREATED_AT,
    });
    expect(message).toEqual({
      id: VALID_ID,
      role: 'assistant',
      content: 'a validated reply',
      createdAt: VALID_CREATED_AT,
    });
  });

  it('throws for content that fails validation, rather than returning a partial message', () => {
    expect(() =>
      createChatMessage({
        id: VALID_ID,
        role: 'user',
        content: '',
        createdAt: VALID_CREATED_AT,
      }),
    ).toThrow();
  });

  it('throws for an oversized message', () => {
    expect(() =>
      createChatMessage({
        id: VALID_ID,
        role: 'user',
        content: 'a'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH + 1),
        createdAt: VALID_CREATED_AT,
      }),
    ).toThrow();
  });
});
