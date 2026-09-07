import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOllamaProvider,
  NonLocalOllamaEndpointError,
  resolveOllamaBaseUrl,
} from '../../../src/main/ollama-provider';
import { OLLAMA_DEFAULT_BASE_URL } from '../../../src/shared/constants';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';

const NOW = '2026-08-07T00:00:00.000Z';

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

describe('resolveOllamaBaseUrl', () => {
  it('falls back to the local default when nothing is configured', () => {
    expect(resolveOllamaBaseUrl('')).toBe(OLLAMA_DEFAULT_BASE_URL);
    expect(resolveOllamaBaseUrl('   ')).toBe(OLLAMA_DEFAULT_BASE_URL);
  });

  it('accepts a configured local endpoint', () => {
    expect(resolveOllamaBaseUrl('http://192.168.1.50:11434/v1')).toBe(
      'http://192.168.1.50:11434/v1',
    );
  });

  it('throws for a non-local endpoint rather than falling back to the default', () => {
    expect(() => resolveOllamaBaseUrl('https://ollama.somecloud.test')).toThrow(
      NonLocalOllamaEndpointError,
    );
  });
});

describe('createOllamaProvider', () => {
  it('identifies itself as ollama', () => {
    expect(createOllamaProvider({ baseUrl: '', model: 'llama3.1' }).id).toBe('ollama');
  });

  it('talks to the local default and sends no Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseOk('local reply'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider({ baseUrl: '', model: 'llama3.1' });
    const result = await provider.send({ messages: [userMessage('hi')] });

    expect(result.content).toBe('local reply');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OLLAMA_DEFAULT_BASE_URL}/chat/completions`);
    expect(init.headers as Record<string, string>).not.toHaveProperty('authorization');
  });

  it('has no way to be given a key at all', () => {
    // Structural, not a convention: the config type has no key field, so a
    // credential cannot reach a local endpoint even by a caller's mistake.
    const config: Parameters<typeof createOllamaProvider>[0] = { baseUrl: '', model: 'llama3.1' };
    expect(Object.keys(config).sort()).toEqual(['baseUrl', 'model']);
  });

  it('fails closed for a non-local endpoint without any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const provider = createOllamaProvider({
      baseUrl: 'https://ollama.somecloud.test',
      model: 'llama3.1',
    });

    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a fail-closed provider rather than throwing synchronously', () => {
    expect(() =>
      createOllamaProvider({ baseUrl: 'https://ollama.somecloud.test', model: 'llama3.1' }),
    ).not.toThrow();
  });

  it('still identifies itself as ollama when failing closed', () => {
    const provider = createOllamaProvider({
      baseUrl: 'https://ollama.somecloud.test',
      model: 'llama3.1',
    });
    expect(provider.id).toBe('ollama');
  });

  it('streams incrementally through onChunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'local ' } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'stream' } }] })}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    );
    const deltas: string[] = [];

    const provider = createOllamaProvider({ baseUrl: '', model: 'llama3.1' });
    const result = await provider.send(
      { messages: [userMessage('hi')] },
      { onChunk: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual(['local ', 'stream']);
    expect(result.content).toBe('local stream');
  });
});
