import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatCompletionsProvider } from '../../../src/main/chat-completions-transport';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import {
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  CHAT_STREAM_MAX_LINE_LENGTH,
} from '../../../src/shared/constants';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';

const NOW = '2026-08-07T00:00:00.000Z';
const PLAINTEXT_KEY = 'sk-test-not-a-real-key';

function userMessage(content: string) {
  return createChatMessage({
    id: '11111111-1111-4111-8111-111111111111',
    role: 'user',
    content,
    createdAt: NOW,
  });
}

function provider(overrides: Partial<Parameters<typeof createChatCompletionsProvider>[0]> = {}) {
  return createChatCompletionsProvider({
    providerId: 'test-provider',
    baseUrl: 'https://api.example.test/v1',
    model: 'test-model',
    apiKey: PLAINTEXT_KEY,
    ...overrides,
  });
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** A `fetch` double that streams `chunks` one read at a time, honouring abort. */
function streamingFetch(chunks: string[], options: { readonly neverEnd?: boolean } = {}) {
  return vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init.signal?.aborted) {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index] ?? ''));
          index += 1;
          return;
        }
        if (options.neverEnd === true) return;
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createChatCompletionsProvider — request shape', () => {
  it('requests streaming and posts to <baseUrl>/chat/completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frame('hi')));
    vi.stubGlobal('fetch', fetchMock);

    await provider().send({ messages: [userMessage('hello')] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    const body = JSON.parse(init.body as string) as { stream: boolean; model: string };
    expect(body.stream).toBe(true);
    expect(body.model).toBe('test-model');
  });

  it('sends no Authorization header when configured with a null key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frame('hi')));
    vi.stubGlobal('fetch', fetchMock);

    await provider({ apiKey: null }).send({ messages: [userMessage('hello')] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('authorization');
    expect(JSON.stringify(init)).not.toContain(PLAINTEXT_KEY);
  });

  it('reports the configured provider id', () => {
    expect(provider({ providerId: 'glm' }).id).toBe('glm');
  });
});

describe('createChatCompletionsProvider — streaming', () => {
  it('accumulates multiple chunks into one reply', async () => {
    vi.stubGlobal('fetch', streamingFetch([frame('Hello'), frame(', '), frame('world')]));

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('Hello, world');
  });

  it('forwards each fragment to onChunk in order', async () => {
    vi.stubGlobal('fetch', streamingFetch([frame('a'), frame('b'), frame('c')]));
    const deltas: string[] = [];

    const result = await provider().send(
      { messages: [userMessage('hi')] },
      { onChunk: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual(['a', 'b', 'c']);
    expect(result.content).toBe('abc');
  });

  it('handles a frame split across two socket reads', async () => {
    const whole = frame('split across reads');
    const half = Math.floor(whole.length / 2);
    vi.stubGlobal('fetch', streamingFetch([whole.slice(0, half), whole.slice(half)]));

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('split across reads');
  });

  it('stops at the [DONE] sentinel and ignores anything after it', async () => {
    vi.stubGlobal(
      'fetch',
      streamingFetch([frame('kept'), 'data: [DONE]\n\n', frame('ignored after done')]),
    );

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('kept');
  });

  it('ignores comments, blank lines and non-data fields', async () => {
    vi.stubGlobal(
      'fetch',
      streamingFetch([': keep-alive\n', '\n', 'event: message\n', frame('only this')]),
    );

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('only this');
  });

  it('skips a malformed data frame and keeps the rest of the stream', async () => {
    vi.stubGlobal(
      'fetch',
      streamingFetch([frame('good '), 'data: {not json at all\n\n', frame('parts')]),
    );

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('good parts');
  });

  it('skips a well-formed frame that carries no content', async () => {
    vi.stubGlobal(
      'fetch',
      streamingFetch([
        'data: {"choices":[{"delta":{}}]}\n\n',
        'data: {"choices":[]}\n\n',
        frame('text'),
      ]),
    );

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('text');
  });

  it('accepts a final frame with no trailing newline', async () => {
    vi.stubGlobal(
      'fetch',
      streamingFetch(['data: {"choices":[{"delta":{"content":"no trailing newline"}}]}']),
    );

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('no trailing newline');
  });

  it('fails when a stream produces no content at all', async () => {
    vi.stubGlobal('fetch', streamingFetch([': keep-alive\n', 'data: [DONE]\n\n']));

    await expect(provider().send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('accepts a stream that ends without [DONE] but carried content', async () => {
    vi.stubGlobal('fetch', streamingFetch([frame('truncated but present')]));

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('truncated but present');
  });
});

describe('createChatCompletionsProvider — streaming bounds', () => {
  it('rejects once accumulated content passes the maximum message length', async () => {
    const oversized = 'a'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH + 100);
    vi.stubGlobal('fetch', streamingFetch([frame(oversized)]));

    await expect(provider().send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('rejects a stream whose accumulated deltas exceed the cap across many frames', async () => {
    const piece = 'b'.repeat(1000);
    const frames = Array.from({ length: 12 }, () => frame(piece));
    vi.stubGlobal('fetch', streamingFetch(frames));

    await expect(provider().send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('rejects a single line that never terminates, without buffering it forever', async () => {
    const endless = 'data: {"choices":[{"delta":{"content":"' + 'c'.repeat(20_000);
    vi.stubGlobal('fetch', streamingFetch([endless, endless, endless, endless, endless]));

    await expect(provider().send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('does not reject a long line that stays under the line cap', async () => {
    const content = 'd'.repeat(CHAT_MESSAGE_CONTENT_MAX_LENGTH - 1);
    expect(frame(content).length).toBeLessThan(CHAT_STREAM_MAX_LINE_LENGTH);
    vi.stubGlobal('fetch', streamingFetch([frame(content)]));

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe(content);
  });

  it('never forwards a delta after the accumulated cap is reached', async () => {
    const piece = 'e'.repeat(1000);
    const frames = Array.from({ length: 12 }, () => frame(piece));
    vi.stubGlobal('fetch', streamingFetch(frames));
    const deltas: string[] = [];

    await provider()
      .send({ messages: [userMessage('hi')] }, { onChunk: (delta) => deltas.push(delta) })
      .catch(() => undefined);

    const forwarded = deltas.join('').length;
    expect(forwarded).toBeLessThanOrEqual(CHAT_MESSAGE_CONTENT_MAX_LENGTH);
  });
});

describe('createChatCompletionsProvider — streaming failures', () => {
  it('reports PROVIDER_ABORTED when the signal fires mid-stream', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', streamingFetch([frame('partial')], { neverEnd: true }));

    const pending = provider().send(
      { messages: [userMessage('hi')] },
      {
        signal: controller.signal,
        onChunk: () => {
          controller.abort();
        },
      },
    );

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
  });

  it('stops forwarding deltas once the signal has fired', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', streamingFetch([frame('one'), frame('two'), frame('three')]));
    const deltas: string[] = [];

    await provider()
      .send(
        { messages: [userMessage('hi')] },
        {
          signal: controller.signal,
          onChunk: (delta) => {
            deltas.push(delta);
            controller.abort();
          },
        },
      )
      .catch(() => undefined);

    expect(deltas).toEqual(['one']);
  });

  it('reports PROVIDER_REQUEST_FAILED when the connection drops mid-stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame('partial')));
            controller.error(new Error('socket hang up'));
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }),
    );

    await expect(provider().send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('never leaks a raw stream error message into the thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('ECONNRESET at 10.1.2.3:443 leaky-detail'));
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }),
    );

    await expect(provider().send({ messages: [userMessage('hi')] })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(ChatProviderError);
        expect((error as ChatProviderError).message).not.toContain('leaky-detail');
        expect((error as ChatProviderError).message).not.toContain('10.1.2.3');
        return true;
      },
    );
  });

  it('a throwing onChunk callback never fails the request', async () => {
    vi.stubGlobal('fetch', streamingFetch([frame('resilient')]));

    const result = await provider().send(
      { messages: [userMessage('hi')] },
      {
        onChunk: () => {
          throw new Error('renderer preview blew up');
        },
      },
    );

    expect(result.content).toBe('resilient');
  });

  it('never logs during a streamed exchange', async () => {
    vi.stubGlobal('fetch', streamingFetch([frame('quiet')]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await provider().send({ messages: [userMessage('hi')] });

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('createChatCompletionsProvider — non-streamed responses still work', () => {
  it('parses a plain JSON completion from an endpoint that ignored stream:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'whole reply' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await provider().send({ messages: [userMessage('hi')] });
    expect(result.content).toBe('whole reply');
  });

  it('calls onChunk not at all for a non-streamed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'whole reply' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const onChunk = vi.fn();

    await provider().send({ messages: [userMessage('hi')] }, { onChunk });
    expect(onChunk).not.toHaveBeenCalled();
  });
});
