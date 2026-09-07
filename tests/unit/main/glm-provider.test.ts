import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlmProvider, resolveGlmBaseUrl } from '../../../src/main/glm-provider';
import { GLM_DEFAULT_BASE_URL } from '../../../src/shared/constants';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';

const NOW = '2026-08-07T00:00:00.000Z';
const PLAINTEXT_KEY = 'sk-glm-test-not-a-real-key';

function userMessage(content: string) {
  return createChatMessage({
    id: '11111111-1111-4111-8111-111111111111',
    role: 'user',
    content,
    createdAt: NOW,
  });
}

function sseOk(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveGlmBaseUrl', () => {
  it('falls back to the public default when nothing is configured', () => {
    expect(resolveGlmBaseUrl('')).toBe(GLM_DEFAULT_BASE_URL);
    expect(resolveGlmBaseUrl('   ')).toBe(GLM_DEFAULT_BASE_URL);
  });

  it('prefers a configured endpoint', () => {
    expect(resolveGlmBaseUrl('https://glm.mirror.test/v4')).toBe('https://glm.mirror.test/v4');
  });

  it('trims surrounding whitespace rather than building a broken URL', () => {
    expect(resolveGlmBaseUrl('  https://glm.mirror.test/v4  ')).toBe('https://glm.mirror.test/v4');
  });
});

describe('createGlmProvider', () => {
  it('identifies itself as glm', () => {
    expect(createGlmProvider({ baseUrl: '', model: 'glm-4', apiKey: PLAINTEXT_KEY }).id).toBe(
      'glm',
    );
  });

  it('sends the stored key as a bearer token and never in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseOk('hello'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createGlmProvider({ baseUrl: '', model: 'glm-4', apiKey: PLAINTEXT_KEY });
    const result = await provider.send({ messages: [userMessage('hi')] });

    expect(result.content).toBe('hello');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GLM_DEFAULT_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PLAINTEXT_KEY}`);
    expect(init.body as string).not.toContain(PLAINTEXT_KEY);
  });

  it('never places the key in a thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    const provider = createGlmProvider({ baseUrl: '', model: 'glm-4', apiKey: PLAINTEXT_KEY });
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as Error).message).not.toContain(PLAINTEXT_KEY);
        return true;
      },
    );
  });

  it('normalizes a rejected credential to PROVIDER_INVALID_CONFIGURATION', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    const provider = createGlmProvider({ baseUrl: '', model: 'glm-4', apiKey: PLAINTEXT_KEY });
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('streams incrementally through onChunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'ni ' } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'hao' } }] })}\n\n` +
              'data: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    );
    const deltas: string[] = [];

    const provider = createGlmProvider({ baseUrl: '', model: 'glm-4', apiKey: PLAINTEXT_KEY });
    const result = await provider.send(
      { messages: [userMessage('hi')] },
      { onChunk: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual(['ni ', 'hao']);
    expect(result.content).toBe('ni hao');
  });
});
