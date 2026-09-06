import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SafeStorage } from 'electron';

import {
  CHAT_PROVIDER_REQUEST_TIMEOUT_MS,
  resolveMainChatProvider,
} from '../../../src/main/chat-provider-registry';
import { writeSecret } from '../../../src/main/secrets';
import {
  GLM_DEFAULT_BASE_URL,
  MODEL_PROVIDERS,
  OLLAMA_DEFAULT_BASE_URL,
  type ModelProvider,
} from '../../../src/shared/constants';
import type { ModelProviderSettings } from '../../../src/shared/schemas';

const PLAINTEXT_KEY = 'sk-test-not-a-real-key';

function fakeSafeStorage(available = true): SafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`fake-enc:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice('fake-enc:'.length),
  } as unknown as SafeStorage;
}

function settings(overrides: Partial<ModelProviderSettings> = {}): ModelProviderSettings {
  return {
    provider: 'openai-compatible',
    model: 'gpt-test',
    baseUrl: 'https://api.example.test/v1',
    hasApiKey: false,
    ...overrides,
  };
}

let dir: string;
let secretsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-chat-registry-'));
  secretsFile = join(dir, 'secrets', 'secrets.enc');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resolveMainChatProvider — identifiers without a real adapter', () => {
  it('delegates none to the shared fail-closed registry', async () => {
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings({ provider: 'none' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it.each(['anthropic', 'openai', 'claude', 'gemini', ''])(
    'fails closed for the unapproved identifier %s, never treating it as a real provider',
    async (hostile) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const chatProvider = await resolveMainChatProvider({
        // Simulates an identifier reaching this function without having
        // passed `settingsSchema` — the type system cannot express it, so
        // the runtime membership check is what has to catch it.
        modelProvider: settings({ provider: hostile as ModelProvider }),
        secretsFile,
        safeStorage: fakeSafeStorage(),
      });

      await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('never calls fetch for an unimplemented identifier', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings({ provider: 'none' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await chatProvider.send({ messages: [] }).catch(() => undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('resolveMainChatProvider — openai-compatible configuration checks', () => {
  it('fails closed with PROVIDER_INVALID_CONFIGURATION when baseUrl is empty', async () => {
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings({ baseUrl: '' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('fails closed with PROVIDER_INVALID_CONFIGURATION when model is empty', async () => {
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings({ model: '' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('fails closed with PROVIDER_INVALID_CONFIGURATION when no key is stored', async () => {
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });

  it('never calls fetch when configuration is incomplete', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings({ baseUrl: '' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await chatProvider.send({ messages: [] }).catch(() => undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('resolveMainChatProvider — openai-compatible, fully configured', () => {
  it('resolves a real provider that calls fetch and returns content once a key is stored', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hi there' } }] }), {
          status: 200,
        }),
      ),
    );

    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    const result = await chatProvider.send({ messages: [] });
    expect(result.content).toBe('hi there');
  });

  it('is wrapped in the shared timeout decorator, using CHAT_PROVIDER_REQUEST_TIMEOUT_MS', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    vi.useFakeTimers();
    // Mirrors real `fetch`'s own behaviour: a passed `signal` rejects the
    // pending request once it aborts. Without this, the mock would hang
    // forever instead of ever letting the timeout decorator's own `await`
    // settle, since the decorator only reacts to the *wrapped call*
    // rejecting — it does not race a timer against the call itself.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }),
    );

    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });

    const pending = chatProvider.send({ messages: [] });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(CHAT_PROVIDER_REQUEST_TIMEOUT_MS + 1);
    await assertion;
  });

  it('fails closed with PROVIDER_INVALID_CONFIGURATION when safeStorage cannot decrypt', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    const chatProvider = await resolveMainChatProvider({
      modelProvider: settings(),
      secretsFile,
      // A different fake store cannot decrypt what the one above encrypted.
      safeStorage: fakeSafeStorage(false),
    });
    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
  });
});

describe('resolveMainChatProvider — every approved identifier resolves to something', () => {
  it.each(MODEL_PROVIDERS)('never throws synchronously for %s', async (provider: ModelProvider) => {
    await expect(
      resolveMainChatProvider({
        modelProvider: settings({ provider }),
        secretsFile,
        safeStorage: fakeSafeStorage(),
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// glm (Phase 2, Milestone 4)
// ---------------------------------------------------------------------------

function glmSettings(overrides: Partial<ModelProviderSettings> = {}): ModelProviderSettings {
  return settings({ provider: 'glm', model: 'glm-4', baseUrl: '', ...overrides });
}

function okStream(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('resolveMainChatProvider — glm', () => {
  it('fails closed with PROVIDER_INVALID_CONFIGURATION when no key is stored', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: glmSettings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });

    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed with PROVIDER_INVALID_CONFIGURATION when no model is configured', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: glmSettings({ model: '' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });

    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the public default endpoint and a bearer key once configured', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okStream('data: {"choices":[{"delta":{"content":"ni hao"}}]}\n\ndata: [DONE]\n\n'),
      );
    vi.stubGlobal('fetch', fetchMock);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: glmSettings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    const result = await chatProvider.send({ messages: [] });

    expect(result.content).toBe('ni hao');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GLM_DEFAULT_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PLAINTEXT_KEY}`);
  });

  it('prefers a configured endpoint over the default', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    vi.stubGlobal('fetch', fetchMock);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: glmSettings({ baseUrl: 'https://glm.mirror.test/v4' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await chatProvider.send({ messages: [] });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://glm.mirror.test/v4/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// ollama (Phase 2, Milestone 4)
// ---------------------------------------------------------------------------

function ollamaSettings(overrides: Partial<ModelProviderSettings> = {}): ModelProviderSettings {
  return settings({ provider: 'ollama', model: 'llama3.1', baseUrl: '', ...overrides });
}

describe('resolveMainChatProvider — ollama', () => {
  it('uses the local default endpoint and sends no Authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okStream('data: {"choices":[{"delta":{"content":"local hi"}}]}\n\n'));
    vi.stubGlobal('fetch', fetchMock);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: ollamaSettings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    const result = await chatProvider.send({ messages: [] });

    expect(result.content).toBe('local hi');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OLLAMA_DEFAULT_BASE_URL}/chat/completions`);
    expect(init.headers as Record<string, string>).not.toHaveProperty('authorization');
  });

  it('never reads the secret store, even when a key is stored for another provider', async () => {
    await writeSecret(secretsFile, PLAINTEXT_KEY, fakeSafeStorage());
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    vi.stubGlobal('fetch', fetchMock);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: ollamaSettings(),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await chatProvider.send({ messages: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.stringify(init)).not.toContain(PLAINTEXT_KEY);
  });

  it.each([
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://[::1]:11434/v1',
    'http://192.168.1.50:11434/v1',
  ])('accepts the local endpoint %s', async (baseUrl) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    vi.stubGlobal('fetch', fetchMock);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: ollamaSettings({ baseUrl }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await chatProvider.send({ messages: [] });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/chat/completions`);
  });

  it.each([
    'https://api.openai-like.test/v1',
    'http://example.test:11434/v1',
    'https://ollama.somecloud.test',
  ])('refuses the non-local endpoint %s without any request', async (baseUrl) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: ollamaSettings({ baseUrl }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });

    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never silently falls back to the local default when a non-local endpoint is configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: ollamaSettings({ baseUrl: 'https://ollama.somecloud.test' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });
    await chatProvider.send({ messages: [] }).catch(() => undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed with PROVIDER_INVALID_CONFIGURATION when no model is configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const chatProvider = await resolveMainChatProvider({
      modelProvider: ollamaSettings({ model: '' }),
      secretsFile,
      safeStorage: fakeSafeStorage(),
    });

    await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_CONFIGURATION',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
