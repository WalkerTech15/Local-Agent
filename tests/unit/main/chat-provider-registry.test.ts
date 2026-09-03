import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SafeStorage } from 'electron';

import {
  OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS,
  resolveMainChatProvider,
} from '../../../src/main/chat-provider-registry';
import { writeSecret } from '../../../src/main/secrets';
import { MODEL_PROVIDERS, type ModelProvider } from '../../../src/shared/constants';
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
  it.each(['none', 'glm', 'ollama'] as const)(
    'delegates %s to the shared fail-closed registry',
    async (provider) => {
      const chatProvider = await resolveMainChatProvider({
        modelProvider: settings({ provider }),
        secretsFile,
        safeStorage: fakeSafeStorage(),
      });
      await expect(chatProvider.send({ messages: [] })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
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

  it('is wrapped in the shared timeout decorator, using OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS', async () => {
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
    await vi.advanceTimersByTimeAsync(OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS + 1);
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
