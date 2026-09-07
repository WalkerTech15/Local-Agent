import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIpcChatProvider,
  IPC_CHAT_PROVIDER_ID,
} from '../../../src/renderer/chat/ipc-chat-provider';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import { MODEL_PROVIDERS } from '../../../src/shared/constants';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';
import type { ChatChunkEvent, ChatSendResponse } from '../../../src/shared/schemas';

const NOW = '2026-08-07T00:00:00.000Z';

function userMessage(content: string) {
  return createChatMessage({
    id: '11111111-1111-4111-8111-111111111111',
    role: 'user',
    content,
    createdAt: NOW,
  });
}

interface FakeBridge {
  readonly send: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly onChunk: ReturnType<typeof vi.fn>;
  /** Delivers one event to every currently-subscribed listener. */
  readonly emit: (event: ChatChunkEvent) => void;
  /** How many listeners are currently subscribed — a leak check. */
  readonly listenerCount: () => number;
}

function installFakeBridge(): FakeBridge {
  const send = vi.fn<(requestId: string, messages: unknown[]) => Promise<ChatSendResponse>>();
  const cancel = vi.fn<(requestId: string) => Promise<void>>();
  const listeners = new Set<(event: ChatChunkEvent) => void>();

  const onChunk = vi.fn((listener: (event: ChatChunkEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });

  vi.stubGlobal('window', { localAgent: { chat: { send, cancel, onChunk } } });

  return {
    send,
    cancel,
    onChunk,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createIpcChatProvider', () => {
  it('reports a transport id, not the name of any one provider', () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'success', content: 'ok' });
    const provider = createIpcChatProvider();
    expect(provider.id).toBe(IPC_CHAT_PROVIDER_ID);
    expect(provider.id).toBe('ipc');
    // Which real provider answers is a main-process decision the renderer is
    // never told, so this id must not name one.
    expect(MODEL_PROVIDERS).not.toContain(provider.id);
  });

  it('calls window.localAgent.chat.send with a fresh requestId and the request messages', async () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'success', content: 'hello' });
    const provider = createIpcChatProvider();

    const result = await provider.send({ messages: [userMessage('hi')] });

    expect(result).toEqual({ content: 'hello' });
    expect(send).toHaveBeenCalledTimes(1);
    const [requestId, messages] = send.mock.calls[0] as [string, unknown[]];
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    expect(messages).toEqual([userMessage('hi')]);
  });

  it('throws a ChatProviderError with the response errorCode on failure', async () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'failure', errorCode: 'PROVIDER_INVALID_CONFIGURATION' });
    const provider = createIpcChatProvider();

    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('falls back to PROVIDER_REQUEST_FAILED for an unrecognised or missing errorCode', async () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'denied' });
    const provider = createIpcChatProvider();

    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
    });
  });

  it('never returns undefined content, even if outcome is success with content missing', async () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'success' });
    const provider = createIpcChatProvider();

    await expect(provider.send({ messages: [userMessage('hi')] })).rejects.toBeInstanceOf(
      ChatProviderError,
    );
  });

  it('rejects immediately with PROVIDER_ABORTED and never calls send when the signal is already aborted', async () => {
    const { send } = installFakeBridge();
    const controller = new AbortController();
    controller.abort();
    const provider = createIpcChatProvider();

    await expect(
      provider.send({ messages: [userMessage('hi')] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('calls chat.cancel with the same requestId and rejects with PROVIDER_ABORTED when aborted mid-flight', async () => {
    const { send, cancel } = installFakeBridge();
    const { promise, resolve } = deferred<ChatSendResponse>();
    send.mockReturnValue(promise);
    cancel.mockResolvedValue(undefined);

    const controller = new AbortController();
    const provider = createIpcChatProvider();

    const pending = provider.send({ messages: [userMessage('hi')] }, { signal: controller.signal });
    controller.abort();

    const sentRequestId = (send.mock.calls[0] as [string, unknown[]])[0];
    expect(cancel).toHaveBeenCalledWith(sentRequestId);

    // Even a late, otherwise-successful response must not overwrite the abort.
    resolve({ outcome: 'success', content: 'too late' });
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
  });

  it('never leaves an abort listener attached after the call settles', async () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'success', content: 'ok' });
    const provider = createIpcChatProvider();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await provider.send({ messages: [userMessage('hi')] }, { signal: controller.signal });

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('createIpcChatProvider — streaming previews', () => {
  it('forwards deltas for its own requestId, in order', async () => {
    const bridge = installFakeBridge();
    const { promise, resolve } = deferred<ChatSendResponse>();
    bridge.send.mockReturnValue(promise);
    const deltas: string[] = [];

    const provider = createIpcChatProvider();
    const pending = provider.send(
      { messages: [userMessage('hi')] },
      { onChunk: (delta) => deltas.push(delta) },
    );

    const requestId = (bridge.send.mock.calls[0] as [string, unknown[]])[0];
    bridge.emit({ requestId, delta: 'Hel' });
    bridge.emit({ requestId, delta: 'lo' });

    resolve({ outcome: 'success', content: 'Hello' });
    await pending;

    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('discards deltas belonging to a different request', async () => {
    const bridge = installFakeBridge();
    const { promise, resolve } = deferred<ChatSendResponse>();
    bridge.send.mockReturnValue(promise);
    const deltas: string[] = [];

    const provider = createIpcChatProvider();
    const pending = provider.send(
      { messages: [userMessage('hi')] },
      { onChunk: (delta) => deltas.push(delta) },
    );

    bridge.emit({ requestId: '99999999-9999-4999-8999-999999999999', delta: 'not mine' });

    resolve({ outcome: 'success', content: 'mine' });
    await pending;

    expect(deltas).toEqual([]);
  });

  it('stops forwarding deltas once the caller aborts', async () => {
    const bridge = installFakeBridge();
    const { promise, resolve } = deferred<ChatSendResponse>();
    bridge.send.mockReturnValue(promise);
    bridge.cancel.mockResolvedValue(undefined);
    const deltas: string[] = [];

    const controller = new AbortController();
    const provider = createIpcChatProvider();
    const pending = provider.send(
      { messages: [userMessage('hi')] },
      { signal: controller.signal, onChunk: (delta) => deltas.push(delta) },
    );

    const requestId = (bridge.send.mock.calls[0] as [string, unknown[]])[0];
    bridge.emit({ requestId, delta: 'before' });
    controller.abort();
    bridge.emit({ requestId, delta: 'after' });

    resolve({ outcome: 'success', content: 'too late' });
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });

    expect(deltas).toEqual(['before']);
  });

  it('unsubscribes when the call settles, leaving no listener behind', async () => {
    const bridge = installFakeBridge();
    bridge.send.mockResolvedValue({ outcome: 'success', content: 'ok' });

    const provider = createIpcChatProvider();
    await provider.send({ messages: [userMessage('hi')] }, { onChunk: () => undefined });

    expect(bridge.listenerCount()).toBe(0);
  });

  it('unsubscribes even when the call fails', async () => {
    const bridge = installFakeBridge();
    bridge.send.mockResolvedValue({ outcome: 'failure', errorCode: 'PROVIDER_REQUEST_FAILED' });

    const provider = createIpcChatProvider();
    await provider
      .send({ messages: [userMessage('hi')] }, { onChunk: () => undefined })
      .catch(() => undefined);

    expect(bridge.listenerCount()).toBe(0);
  });

  it('does not subscribe at all when the caller wants no previews', async () => {
    const bridge = installFakeBridge();
    bridge.send.mockResolvedValue({ outcome: 'success', content: 'ok' });

    const provider = createIpcChatProvider();
    await provider.send({ messages: [userMessage('hi')] });

    expect(bridge.onChunk).not.toHaveBeenCalled();
  });

  it('returns the authoritative response content, not the accumulated deltas', async () => {
    const bridge = installFakeBridge();
    const { promise, resolve } = deferred<ChatSendResponse>();
    bridge.send.mockReturnValue(promise);

    const provider = createIpcChatProvider();
    const pending = provider.send({ messages: [userMessage('hi')] }, { onChunk: () => undefined });

    const requestId = (bridge.send.mock.calls[0] as [string, unknown[]])[0];
    bridge.emit({ requestId, delta: 'streamed preview text' });

    resolve({ outcome: 'success', content: 'authoritative reply' });
    await expect(pending).resolves.toEqual({ content: 'authoritative reply' });
  });
});
