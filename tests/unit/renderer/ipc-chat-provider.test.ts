import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIpcChatProvider,
  IPC_CHAT_PROVIDER_ID,
} from '../../../src/renderer/chat/ipc-chat-provider';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import { createChatMessage } from '../../../src/shared/schemas/chat.schema';
import type { ChatSendResponse } from '../../../src/shared/schemas';

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
}

function installFakeBridge(): FakeBridge {
  const send = vi.fn<(requestId: string, messages: unknown[]) => Promise<ChatSendResponse>>();
  const cancel = vi.fn<(requestId: string) => Promise<void>>();
  vi.stubGlobal('window', { localAgent: { chat: { send, cancel } } });
  return { send, cancel };
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
  it('has the openai-compatible id', () => {
    const { send } = installFakeBridge();
    send.mockResolvedValue({ outcome: 'success', content: 'ok' });
    const provider = createIpcChatProvider();
    expect(provider.id).toBe(IPC_CHAT_PROVIDER_ID);
    expect(provider.id).toBe('openai-compatible');
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
