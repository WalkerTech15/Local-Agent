import { afterEach, describe, expect, it, vi } from 'vitest';

import { withProviderTimeout } from '../../../src/shared/chat/timeout';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import type {
  ChatProvider,
  ChatProviderRequest,
  ChatProviderRequestOptions,
  ChatProviderResult,
} from '../../../src/shared/chat/provider';

const EMPTY_REQUEST: ChatProviderRequest = { messages: [] };

/** A provider whose resolution/rejection is controlled by the test, and that observes its signal. */
function controllableProvider(): {
  provider: ChatProvider;
  resolve: (result: ChatProviderResult) => void;
  reject: (error: unknown) => void;
  receivedSignals: (AbortSignal | undefined)[];
} {
  const receivedSignals: (AbortSignal | undefined)[] = [];
  let resolveFn: (result: ChatProviderResult) => void = () => undefined;
  let rejectFn: (error: unknown) => void = () => undefined;

  const provider: ChatProvider = {
    id: 'controllable-test-provider',
    send: (_request: ChatProviderRequest, options?: ChatProviderRequestOptions) => {
      receivedSignals.push(options?.signal);
      return new Promise<ChatProviderResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
        options?.signal?.addEventListener('abort', () => {
          reject(new ChatProviderError('PROVIDER_ABORTED', 'aborted by wrapped provider'));
        });
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
    receivedSignals,
  };
}

describe('withProviderTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves the wrapped provider id', () => {
    const { provider } = controllableProvider();
    const wrapped = withProviderTimeout(provider, 1000);
    expect(wrapped.id).toBe(provider.id);
  });

  it('resolves normally when the provider answers within the budget', async () => {
    const { provider, resolve } = controllableProvider();
    const wrapped = withProviderTimeout(provider, 1000);

    const promise = wrapped.send(EMPTY_REQUEST);
    resolve({ content: 'on time' });

    await expect(promise).resolves.toEqual({ content: 'on time' });
  });

  it('rejects with PROVIDER_TIMEOUT when the provider does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const { provider } = controllableProvider(); // never resolved
      const wrapped = withProviderTimeout(provider, 1000);

      const promise = wrapped.send(EMPTY_REQUEST);
      const assertion = expect(promise).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });

      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the provider error unchanged when it fails before the timeout', async () => {
    const { provider, reject } = controllableProvider();
    const wrapped = withProviderTimeout(provider, 1000);

    const promise = wrapped.send(EMPTY_REQUEST);
    reject(new ChatProviderError('PROVIDER_REQUEST_FAILED', 'genuine failure'));

    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
  });

  it('forwards an external abort signal into the wrapped provider, reported as aborted, not timeout', async () => {
    const { provider } = controllableProvider(); // wrapped provider rejects with PROVIDER_ABORTED on its own signal
    const wrapped = withProviderTimeout(provider, 5000);
    const external = new AbortController();

    const promise = wrapped.send(EMPTY_REQUEST, { signal: external.signal });
    external.abort();

    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
  });

  it('does not wait out the timeout when the external signal is already aborted', async () => {
    const { provider } = controllableProvider();
    const wrapped = withProviderTimeout(provider, 5000);
    const external = new AbortController();
    external.abort();

    await expect(wrapped.send(EMPTY_REQUEST, { signal: external.signal })).rejects.toMatchObject({
      code: 'PROVIDER_ABORTED',
    });
  });

  it('passes a combined signal to the wrapped provider, never the external signal directly', () => {
    const { provider, receivedSignals } = controllableProvider();
    const wrapped = withProviderTimeout(provider, 1000);
    const external = new AbortController();

    void wrapped.send(EMPTY_REQUEST, { signal: external.signal });

    expect(receivedSignals[0]).not.toBe(external.signal);
  });

  it('never calls the global fetch function', async () => {
    if (typeof globalThis.fetch !== 'function') return;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { provider, resolve } = controllableProvider();
    const wrapped = withProviderTimeout(provider, 1000);

    const promise = wrapped.send(EMPTY_REQUEST);
    resolve({ content: 'ok' });
    await promise;

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
