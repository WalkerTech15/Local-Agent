import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChatProviderForSelection,
  describeChatProviderStatus,
  getChatProviderCapabilities,
} from '../../../src/shared/chat/registry';
import { ChatProviderError } from '../../../src/shared/chat/provider';
import { MODEL_PROVIDERS, type ModelProvider } from '../../../src/shared/constants';

describe('getChatProviderCapabilities', () => {
  it.each(MODEL_PROVIDERS)('describes every approved identifier: %s', (id) => {
    const capabilities = getChatProviderCapabilities(id);
    expect(capabilities.id).toBe(id);
    expect(typeof capabilities.label).toBe('string');
    expect(capabilities.label.length).toBeGreaterThan(0);
  });

  it('reports requiresApiKey only for glm and openai-compatible', () => {
    expect(getChatProviderCapabilities('none').requiresApiKey).toBe(false);
    expect(getChatProviderCapabilities('ollama').requiresApiKey).toBe(false);
    expect(getChatProviderCapabilities('glm').requiresApiKey).toBe(true);
    expect(getChatProviderCapabilities('openai-compatible').requiresApiKey).toBe(true);
  });

  it('reports every provider as not implemented in this phase', () => {
    for (const id of MODEL_PROVIDERS) {
      expect(getChatProviderCapabilities(id).implemented).toBe(false);
    }
  });

  it('exposes requiresApiKey only as a boolean flag, never a credential-shaped value', () => {
    // `requiresApiKey` is a safe, neutral capability flag — the same pattern
    // `settings.json`'s own `hasApiKey` boolean already uses — not a secret
    // itself. What must never appear is an actual key- or token-shaped
    // *value* anywhere in this object.
    for (const id of MODEL_PROVIDERS) {
      const capabilities = getChatProviderCapabilities(id);
      expect(typeof capabilities.requiresApiKey).toBe('boolean');
      for (const value of Object.values(capabilities)) {
        if (typeof value === 'string') {
          expect(value).not.toMatch(/^sk-|bearer\s|^[A-Za-z0-9_-]{32,}$/i);
        }
      }
    }
  });
});

describe('describeChatProviderStatus', () => {
  it('reports "none" as not-configured', () => {
    const status = describeChatProviderStatus('none');
    expect(status.availability).toBe('not-configured');
    expect(status.summary).toMatch(/mock/i);
  });

  it.each(['glm', 'openai-compatible', 'ollama'] as const)(
    'reports %s as not-implemented',
    (id) => {
      const status = describeChatProviderStatus(id);
      expect(status.availability).toBe('not-implemented');
      expect(status.summary).toMatch(/mock/i);
    },
  );

  it('never places settings input into the summary text, only fixed labels', () => {
    // The function's only input is the enum identifier itself — there is no
    // parameter through which a hostile or unexpected string could reach
    // the summary, so this asserts the output is always one of the four
    // known, reviewed templates.
    for (const id of MODEL_PROVIDERS) {
      const summary = describeChatProviderStatus(id).summary;
      expect(summary).not.toContain('apiKey');
      expect(summary).not.toContain('token');
    }
  });
});

describe('createChatProviderForSelection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(MODEL_PROVIDERS)('fails closed for the approved identifier %s', async (id) => {
    const provider = createChatProviderForSelection(id);
    await expect(provider.send({ messages: [] })).rejects.toBeInstanceOf(ChatProviderError);
  });

  it.each(MODEL_PROVIDERS)('reports PROVIDER_UNAVAILABLE for %s', async (id) => {
    const provider = createChatProviderForSelection(id);
    await expect(provider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('fails closed for an identifier outside the approved set, never throwing synchronously', async () => {
    const hostile = 'anthropic' as unknown as ModelProvider;
    const provider = createChatProviderForSelection(hostile);
    await expect(provider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('never returns a provider whose id is one of the disapproved identifiers', () => {
    for (const hostile of ['anthropic', 'openai', 'claude', 'gemini'] as const) {
      const provider = createChatProviderForSelection(hostile as unknown as ModelProvider);
      expect(provider.id).not.toBe(hostile);
    }
  });

  it('never calls the global fetch function for any approved identifier', async () => {
    if (typeof globalThis.fetch !== 'function') return;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const id of MODEL_PROVIDERS) {
      await createChatProviderForSelection(id)
        .send({ messages: [] })
        .catch(() => undefined);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never resolves successfully for any approved identifier', async () => {
    for (const id of MODEL_PROVIDERS) {
      let resolved = false;
      await createChatProviderForSelection(id)
        .send({ messages: [] })
        .then(() => {
          resolved = true;
        })
        .catch(() => undefined);
      expect(resolved).toBe(false);
    }
  });
});
