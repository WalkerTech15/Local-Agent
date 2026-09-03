import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenAiCompatibleProvider,
  MAX_RESPONSE_BYTES,
} from '../../../src/main/openai-compatible-provider';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';

const NOW = '2026-08-07T00:00:00.000Z';
const PLAINTEXT_KEY = 'sk-test-not-a-real-key';

function userMessage(content: string, id = '11111111-1111-4111-8111-111111111111') {
  return createChatMessage({ id, role: 'user', content, createdAt: NOW });
}

function baseConfig(overrides: Partial<{ baseUrl: string; model: string; apiKey: string }> = {}) {
  return {
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-test',
    apiKey: PLAINTEXT_KEY,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createOpenAiCompatibleProvider — success', () => {
  it('returns the assistant content from a well-formed completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hello there' } }] })),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());

    const result = await provider.send({ messages: [userMessage('hi')] });
    expect(result).toEqual({ content: 'hello there' });
  });

  it('posts to <baseUrl>/chat/completions, handling a trailing slash on baseUrl', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    await createOpenAiCompatibleProvider(
      baseConfig({ baseUrl: 'https://api.example.test/v1/' }),
    ).send({ messages: [userMessage('hi')] });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
  });

  it('sends the API key as a bearer token, and the request body never contains it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    await createOpenAiCompatibleProvider(baseConfig()).send({ messages: [userMessage('hi')] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${PLAINTEXT_KEY}`);
    // The key belongs in the Authorization header alone.
    const bodyText = init.body as string;
    expect(bodyText).not.toContain(PLAINTEXT_KEY);
  });

  it('forwards only system/user/assistant messages, dropping tool messages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const toolMessage = createChatMessage({
      id: '22222222-2222-4222-8222-222222222222',
      role: 'tool',
      content: 'tool output',
      createdAt: NOW,
    });

    await createOpenAiCompatibleProvider(baseConfig()).send({
      messages: [userMessage('hi'), toolMessage],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: { role: string }[] };
    expect(body.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('never logs anything, including on a successful call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await createOpenAiCompatibleProvider(baseConfig()).send({ messages: [userMessage('hi')] });

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('createOpenAiCompatibleProvider — authentication and rate limiting', () => {
  it('reports PROVIDER_INVALID_CONFIGURATION for a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('reports PROVIDER_INVALID_CONFIGURATION for a 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED for a 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('too many requests', { status: 429 })),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED for a generic 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('never includes a response body or status text in the thrown error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('leaky-diagnostic-detail', { status: 500 })),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ChatProviderError);
        expect((error as ChatProviderError).message).not.toContain('leaky-diagnostic-detail');
        return true;
      },
    );
  });
});

describe('createOpenAiCompatibleProvider — network failure and cancellation', () => {
  it('reports PROVIDER_REQUEST_FAILED when fetch rejects for a reason other than abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('never forwards a raw network error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:9999')));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as ChatProviderError).message).not.toContain('ECONNREFUSED');
        return true;
      },
    );
  });

  it('rejects immediately with PROVIDER_ABORTED when the signal is already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(
      provider.send({ messages: [userMessage('hi')] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports PROVIDER_ABORTED when fetch rejects because the signal fired mid-flight', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }),
    );

    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(
      provider.send({ messages: [userMessage('hi')] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
  });
});

describe('createOpenAiCompatibleProvider — malformed and oversized responses', () => {
  it('reports PROVIDER_REQUEST_FAILED for a response that is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json at all', { status: 200 })),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED when choices is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED when choices is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [] })));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED when message.content is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] })));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED when content fails the shared content-safety schema (control character)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: 'bad' + String.fromCharCode(0) + 'char' } }],
        }),
      ),
    );
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('reports PROVIDER_REQUEST_FAILED for a response body larger than the byte cap, without buffering it all', async () => {
    const oversized = 'a'.repeat(MAX_RESPONSE_BYTES + 1024);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(oversized, { status: 200 })));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('accepts a response body at exactly the byte cap', async () => {
    const atCap = JSON.stringify({
      choices: [{ message: { content: 'x'.repeat(100) } }],
      padding: 'p'.repeat(MAX_RESPONSE_BYTES - 200),
    });
    expect(Buffer.byteLength(atCap, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(atCap, { status: 200 })));
    const provider = createOpenAiCompatibleProvider(baseConfig());
    const result = await provider.send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('x'.repeat(100));
  });
});
