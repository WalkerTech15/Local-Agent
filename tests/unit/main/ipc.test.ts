import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcMain, SafeStorage } from 'electron';

import { engageEmergencyStop } from '../../../src/main/emergency';
import {
  registerIpcHandlers,
  SECRETS_ERROR_PROVIDER_DOES_NOT_USE_API_KEY,
  SECRETS_ERROR_STORE_UNAVAILABLE,
} from '../../../src/main/ipc';
import type { IpcHandlerRuntime } from '../../../src/main/ipc';
import type { UserDataPaths } from '../../../src/main/paths';
import { hasStoredSecret, writeSecret } from '../../../src/main/secrets';
import { loadSettings, writeSettings } from '../../../src/main/settings';
import { AUDIT_LOG_FILE_EXTENSION, AUDIT_LOG_FILE_PREFIX } from '../../../src/shared/constants';
import {
  createChatMessage,
  createDefaultSettings,
  IPC_CHAT_CANCEL_CHANNEL,
  IPC_CHAT_SEND_CHANNEL,
  IPC_SECRETS_CLEAR_CHANNEL,
  IPC_SECRETS_STATUS_CHANNEL,
  IPC_SECRETS_WRITE_CHANNEL,
  IPC_SETTINGS_GET_CHANNEL,
  IPC_SETTINGS_UPDATE_CHANNEL,
} from '../../../src/shared/schemas';
import type {
  ChatCancelResponse,
  ChatSendResponse,
  SecretsActionResponse,
  SettingsActionResponse,
} from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

const NOW = '2026-08-07T00:00:00.000Z';
const PLAINTEXT_KEY = 'sk-super-secret-onboarding-key';

function createFakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  return {
    ipcMain,
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(new Error(`no handler registered for channel: ${channel}`));
      }
      // Mirrors real Electron: a handler that throws synchronously (never
      // awaiting anything, so validation failure is not itself wrapped in a
      // promise) still rejects `ipcRenderer.invoke`'s promise, exactly as one
      // that returns a rejected promise does.
      try {
        return Promise.resolve(handler({}, ...args));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

function fakeSafeStorage(available = true): SafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`fake-enc:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice('fake-enc:'.length),
  } as unknown as SafeStorage;
}

let dir: string;
let paths: UserDataPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-ipc-'));
  paths = {
    userDataDir: dir,
    settingsFile: join(dir, 'settings.json'),
    permissionPolicyFile: join(dir, 'permissions', 'policy.json'),
    secretsFile: join(dir, 'secrets', 'secrets.enc'),
    auditLogDir: join(dir, 'logs', 'audit'),
    emergencyStateFile: join(dir, 'state', 'emergency.json'),
    memoryDir: join(dir, 'memory'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function approve(): Promise<ConfirmationResult> {
  return Promise.resolve('approved');
}

function reject(): Promise<ConfirmationResult> {
  return Promise.resolve('rejected');
}

function buildRuntime(overrides: Partial<IpcHandlerRuntime> = {}): IpcHandlerRuntime {
  return {
    userDataPaths: paths,
    safeStorage: fakeSafeStorage(true),
    requestConfirmation: approve,
    nowFn: () => NOW,
    ...overrides,
  };
}

function setUp(overrides: Partial<IpcHandlerRuntime> = {}) {
  const { ipcMain, invoke } = createFakeIpcMain();
  registerIpcHandlers(ipcMain, buildRuntime(overrides));
  return invoke;
}

async function readAuditLines(): Promise<Record<string, unknown>[]> {
  const filePath = join(
    paths.auditLogDir,
    `${AUDIT_LOG_FILE_PREFIX}${NOW.slice(0, 10)}${AUDIT_LOG_FILE_EXTENSION}`,
  );
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('settings:get', () => {
  it('returns safe defaults, onboardingCompleted false, on a first launch', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_SETTINGS_GET_CHANNEL)) as SettingsActionResponse;

    expect(response.outcome).toBe('success');
    expect(response.settings?.onboardingCompleted).toBe(false);
    expect(response.settings?.modelProvider.hasApiKey).toBe(false);
  });

  it('never creates settings.json merely by reading', async () => {
    const invoke = setUp();
    await invoke(IPC_SETTINGS_GET_CHANNEL);
    await expect(readFile(paths.settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unexpected argument', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_SETTINGS_GET_CHANNEL, 'unexpected')).rejects.toThrow();
  });

  it('remains available while the emergency stop is engaged (settings.read is exempt)', async () => {
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    const invoke = setUp();
    const response = (await invoke(IPC_SETTINGS_GET_CHANNEL)) as SettingsActionResponse;
    expect(response.outcome).toBe('success');
  });
});

describe('settings:update — onboarding', () => {
  it('persists a valid onboarding payload and returns it reconciled', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_SETTINGS_UPDATE_CHANNEL, {
      onboardingCompleted: true,
      assistant: { name: 'JARVIS' },
      user: { displayName: 'Alex Martin' },
      language: { ui: 'fr' },
      modelProvider: { provider: 'none', model: '', baseUrl: '' },
    })) as SettingsActionResponse;

    expect(response.outcome).toBe('success');
    expect(response.settings?.onboardingCompleted).toBe(true);
    expect(response.settings?.language.ui).toBe('fr');

    const persisted = await loadSettings(paths.settingsFile, NOW);
    expect(persisted.user.displayName).toBe('Alex Martin');
  });

  it('rejects a payload carrying hasApiKey before anything is written', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_SETTINGS_UPDATE_CHANNEL, {
        onboardingCompleted: true,
        assistant: { name: 'JARVIS' },
        user: { displayName: 'Alex' },
        language: { ui: 'en' },
        modelProvider: { provider: 'none', model: '', baseUrl: '', hasApiKey: true },
      }),
    ).rejects.toThrow();
    await expect(readFile(paths.settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unapproved provider identifier before anything is written', async () => {
    const invoke = setUp();
    for (const hostile of ['anthropic', 'openai', 'claude', 'gemini']) {
      await expect(
        invoke(IPC_SETTINGS_UPDATE_CHANNEL, {
          onboardingCompleted: false,
          assistant: { name: 'JARVIS' },
          user: { displayName: '' },
          language: { ui: 'en' },
          modelProvider: { provider: hostile, model: '', baseUrl: '' },
        }),
      ).rejects.toThrow();
    }
    await expect(readFile(paths.settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not require confirmation (settings.write is allow by default policy)', async () => {
    const requestConfirmation = vi.fn<() => Promise<ConfirmationResult>>();
    const invoke = setUp({ requestConfirmation });
    await invoke(IPC_SETTINGS_UPDATE_CHANNEL, {
      onboardingCompleted: false,
      assistant: { name: 'JARVIS' },
      user: { displayName: '' },
      language: { ui: 'en' },
      modelProvider: { provider: 'none', model: '', baseUrl: '' },
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('is denied while the emergency stop is engaged, and writes nothing', async () => {
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    const invoke = setUp();
    const response = (await invoke(IPC_SETTINGS_UPDATE_CHANNEL, {
      onboardingCompleted: true,
      assistant: { name: 'JARVIS' },
      user: { displayName: 'Alex' },
      language: { ui: 'en' },
      modelProvider: { provider: 'none', model: '', baseUrl: '' },
    })) as SettingsActionResponse;

    expect(response.outcome).toBe('denied');
    await expect(readFile(paths.settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('secrets:status', () => {
  it('reports present: false when nothing is stored', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_SECRETS_STATUS_CHANNEL)) as SecretsActionResponse;
    expect(response.outcome).toBe('success');
    expect(response.status).toEqual({ present: false });
  });

  it('does not require confirmation', async () => {
    const requestConfirmation = vi.fn<() => Promise<ConfirmationResult>>();
    const invoke = setUp({ requestConfirmation });
    await invoke(IPC_SECRETS_STATUS_CHANNEL);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});

describe('secrets:write — approved', () => {
  it('stores the key, reports present: true, and updates settings.json hasApiKey', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });

    const invoke = setUp({ requestConfirmation: approve });
    const response = (await invoke(IPC_SECRETS_WRITE_CHANNEL, {
      apiKey: PLAINTEXT_KEY,
    })) as SecretsActionResponse;

    expect(response.outcome).toBe('success');
    expect(response.status).toEqual({ present: true });
    expect(await hasStoredSecret(paths.secretsFile)).toBe(true);

    const persisted = await loadSettings(paths.settingsFile, NOW);
    expect(persisted.modelProvider.hasApiKey).toBe(true);
  });

  it('asks for confirmation exactly once, with a message that never contains the key', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });

    const requestConfirmation = vi.fn((_message: string) => approve());
    const invoke = setUp({ requestConfirmation });
    await invoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: PLAINTEXT_KEY });

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const call = requestConfirmation.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).not.toContain(PLAINTEXT_KEY);
  });
});

describe('secrets:write — rejected confirmation', () => {
  it('never stores the key and leaves hasApiKey false', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });

    const invoke = setUp({ requestConfirmation: reject });
    const response = (await invoke(IPC_SECRETS_WRITE_CHANNEL, {
      apiKey: PLAINTEXT_KEY,
    })) as SecretsActionResponse;

    expect(response.outcome).toBe('aborted');
    await expect(readFile(paths.secretsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const persisted = await loadSettings(paths.settingsFile, NOW);
    expect(persisted.modelProvider.hasApiKey).toBe(false);
  });
});

describe('secrets:write — provider does not use an API key', () => {
  it('fails with a specific error code and stores nothing when the provider is none', async () => {
    // Default settings: provider 'none'.
    const invoke = setUp();
    const response = (await invoke(IPC_SECRETS_WRITE_CHANNEL, {
      apiKey: PLAINTEXT_KEY,
    })) as SecretsActionResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe(SECRETS_ERROR_PROVIDER_DOES_NOT_USE_API_KEY);
    await expect(readFile(paths.secretsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails the same way for ollama, which does not use an API key either', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'ollama', model: 'llama3.1', baseUrl: '', hasApiKey: false },
    });
    const invoke = setUp();
    const response = (await invoke(IPC_SECRETS_WRITE_CHANNEL, {
      apiKey: PLAINTEXT_KEY,
    })) as SecretsActionResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe(SECRETS_ERROR_PROVIDER_DOES_NOT_USE_API_KEY);
  });
});

describe('secrets:write — safeStorage unavailable', () => {
  it('fails with a specific error code and never falls back to plaintext', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });

    const invoke = setUp({ safeStorage: fakeSafeStorage(false) });
    const response = (await invoke(IPC_SECRETS_WRITE_CHANNEL, {
      apiKey: PLAINTEXT_KEY,
    })) as SecretsActionResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe(SECRETS_ERROR_STORE_UNAVAILABLE);
    await expect(readFile(paths.secretsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('secrets:write — request validation', () => {
  it('rejects an empty key before any permission decision is made (no audit record)', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: '' })).rejects.toThrow();
    await expect(readdir(paths.auditLogDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('secrets:write — denied while the emergency stop is engaged', () => {
  it('never asks for confirmation and never touches the secret store', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const requestConfirmation = vi.fn<() => Promise<ConfirmationResult>>();
    const invoke = setUp({ requestConfirmation });
    const response = (await invoke(IPC_SECRETS_WRITE_CHANNEL, {
      apiKey: PLAINTEXT_KEY,
    })) as SecretsActionResponse;

    expect(response.outcome).toBe('denied');
    expect(requestConfirmation).not.toHaveBeenCalled();
    await expect(readFile(paths.secretsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('secrets:clear — approved', () => {
  it('clears a stored key and updates settings.json hasApiKey to false', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });
    const writeInvoke = setUp({ requestConfirmation: approve });
    await writeInvoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: PLAINTEXT_KEY });
    expect(await hasStoredSecret(paths.secretsFile)).toBe(true);

    const clearInvoke = setUp({ requestConfirmation: approve });
    const response = (await clearInvoke(IPC_SECRETS_CLEAR_CHANNEL)) as SecretsActionResponse;

    expect(response.outcome).toBe('success');
    expect(response.status).toEqual({ present: false });
    expect(await hasStoredSecret(paths.secretsFile)).toBe(false);

    const persisted = await loadSettings(paths.settingsFile, NOW);
    expect(persisted.modelProvider.hasApiKey).toBe(false);
  });
});

describe('secrets:clear — rejected confirmation', () => {
  it('leaves the stored key completely unchanged, byte for byte', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });
    const writeInvoke = setUp({ requestConfirmation: approve });
    await writeInvoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: PLAINTEXT_KEY });
    const before = await readFile(paths.secretsFile, 'utf8');

    const clearInvoke = setUp({ requestConfirmation: reject });
    const response = (await clearInvoke(IPC_SECRETS_CLEAR_CHANNEL)) as SecretsActionResponse;

    expect(response.outcome).toBe('aborted');
    const after = await readFile(paths.secretsFile, 'utf8');
    expect(after).toBe(before);
    expect(await hasStoredSecret(paths.secretsFile)).toBe(true);
  });
});

describe('audit — no plaintext secret ever appears in an audit record', () => {
  it('across write (approved), write (rejected) and clear (approved)', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });

    const approveInvoke = setUp({ requestConfirmation: approve });
    await approveInvoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: PLAINTEXT_KEY });

    const rejectInvoke = setUp({ requestConfirmation: reject });
    await rejectInvoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: `${PLAINTEXT_KEY}-second` });

    const clearInvoke = setUp({ requestConfirmation: approve });
    await clearInvoke(IPC_SECRETS_CLEAR_CHANNEL);

    const lines = await readAuditLines();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(PLAINTEXT_KEY);
    expect(serialized).not.toContain(`${PLAINTEXT_KEY}-second`);

    // Safe metadata is present instead.
    const writeRecord = lines.find(
      (line) => line.actionType === 'secrets.write' && line.outcome === 'success',
    );
    expect(writeRecord?.parameters).toMatchObject({ provider: 'glm', keyPresent: true });
  });

  it('records provider metadata under a name that is not a secret-looking field', async () => {
    const invoke = setUp();
    await invoke(IPC_SECRETS_STATUS_CHANNEL);
    const lines = await readAuditLines();
    expect(lines[0]?.parameters).toMatchObject({ provider: 'none' });
  });
});

describe('the encrypted store file never contains the plaintext key', () => {
  it('after an approved write', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });
    const invoke = setUp({ requestConfirmation: approve });
    await invoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: PLAINTEXT_KEY });

    const raw = await readFile(paths.secretsFile, 'utf8');
    expect(raw).not.toContain(PLAINTEXT_KEY);
  });
});

describe('settings.json never contains a plaintext key field', () => {
  it('after onboarding and after a secret write', async () => {
    const invoke = setUp({ requestConfirmation: approve });
    await invoke(IPC_SETTINGS_UPDATE_CHANNEL, {
      onboardingCompleted: true,
      assistant: { name: 'JARVIS' },
      user: { displayName: 'Alex' },
      language: { ui: 'en' },
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '' },
    });
    await invoke(IPC_SECRETS_WRITE_CHANNEL, { apiKey: PLAINTEXT_KEY });

    const raw = await readFile(paths.settingsFile, 'utf8');
    expect(raw).not.toContain(PLAINTEXT_KEY);
    expect(raw).not.toContain('apiKey');
  });
});

describe('health channel still works unmodified', () => {
  it('responds ok', async () => {
    const invoke = setUp();
    expect(await invoke('app:health')).toEqual({ status: 'ok' });
  });
});

describe('a corrupt settings.json falls back safely rather than trusting partial data', () => {
  it('settings:get returns safe defaults, still reporting onboarding as incomplete', async () => {
    await writeFile(paths.settingsFile, 'not valid json at all', 'utf8');

    const invoke = setUp();
    const response = (await invoke(IPC_SETTINGS_GET_CHANNEL)) as SettingsActionResponse;

    expect(response.outcome).toBe('success');
    expect(response.settings?.onboardingCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chat:send / chat:cancel (Phase 2, Milestone 3)
// ---------------------------------------------------------------------------

function userMessage(content: string) {
  return createChatMessage({ id: randomUUID(), role: 'user', content, createdAt: NOW });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function configureOpenAiCompatible(): Promise<void> {
  await writeSettings(paths.settingsFile, {
    ...createDefaultSettings(NOW),
    modelProvider: {
      provider: 'openai-compatible',
      model: 'gpt-test',
      baseUrl: 'https://api.example.test/v1',
      hasApiKey: false,
    },
  });
  await writeSecret(paths.secretsFile, PLAINTEXT_KEY, fakeSafeStorage(true));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat:send — provider none (default settings)', () => {
  it('fails closed with PROVIDER_UNAVAILABLE and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const invoke = setUp();
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hello')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(response.content).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not require confirmation (chat.send is allow by default policy)', async () => {
    const requestConfirmation = vi.fn<() => Promise<ConfirmationResult>>();
    const invoke = setUp({ requestConfirmation });
    await invoke(IPC_CHAT_SEND_CHANNEL, { requestId: randomUUID(), messages: [userMessage('hi')] });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('is denied while the emergency stop is engaged, and never resolves a provider', async () => {
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const requestConfirmation = vi.fn<() => Promise<ConfirmationResult>>();

    const invoke = setUp({ requestConfirmation });
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hi')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('denied');
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed request before any proposal is built (no audit record)', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_CHAT_SEND_CHANNEL, { requestId: 'not-a-uuid', messages: [] }),
    ).rejects.toThrow();
    await expect(readdir(paths.auditLogDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a request carrying an unexpected field', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_CHAT_SEND_CHANNEL, {
        requestId: randomUUID(),
        messages: [userMessage('hi')],
        apiKey: 'sk-not-real',
      }),
    ).rejects.toThrow();
  });
});

describe('chat:send — audit trail', () => {
  it('records provider and messageCount only, never message content', async () => {
    const invoke = setUp();
    await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('a secret-shaped message nobody should log')],
    });

    const lines = await readAuditLines();
    const record = lines.find((line) => line.actionType === 'chat.send');
    expect(record?.parameters).toEqual({ provider: 'none', messageCount: 1 });
    expect(JSON.stringify(lines)).not.toContain('a secret-shaped message nobody should log');
  });
});

describe('chat:send — openai-compatible, fully configured', () => {
  it('returns the assistant content on a successful call', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi there' } }] })),
    );

    const invoke = setUp();
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hello')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('success');
    expect(response.content).toBe('hi there');
  });

  it('never includes the API key anywhere in the response', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi there' } }] })),
    );

    const invoke = setUp();
    const response = await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hello')],
    });
    expect(JSON.stringify(response)).not.toContain(PLAINTEXT_KEY);
  });

  it('never includes the API key anywhere in the audit trail', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi there' } }] })),
    );

    const invoke = setUp();
    await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hello')],
    });
    const lines = await readAuditLines();
    expect(JSON.stringify(lines)).not.toContain(PLAINTEXT_KEY);
  });

  it('reports PROVIDER_INVALID_CONFIGURATION when the endpoint rejects the credentials', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );

    const invoke = setUp();
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hello')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('PROVIDER_INVALID_CONFIGURATION');
  });

  it('reports PROVIDER_INVALID_CONFIGURATION when no key is stored yet', async () => {
    await writeSettings(paths.settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: {
        provider: 'openai-compatible',
        model: 'gpt-test',
        baseUrl: 'https://api.example.test/v1',
        hasApiKey: false,
      },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const invoke = setUp();
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hello')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('PROVIDER_INVALID_CONFIGURATION');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('chat:cancel', () => {
  it('aborts a matching in-flight chat:send call', async () => {
    await configureOpenAiCompatible();

    // Resolves once `fetch` is actually reached, which can only happen after
    // the handler has already registered the in-flight `AbortController` —
    // deterministic synchronization instead of a fixed delay.
    let notifyFetchCalled: () => void = () => undefined;
    const fetchCalled = new Promise<void>((resolve) => {
      notifyFetchCalled = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
        notifyFetchCalled();
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }),
    );

    const invoke = setUp();
    const requestId = randomUUID();
    const pending = invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId,
      messages: [userMessage('hello')],
    }) as Promise<ChatSendResponse>;

    await fetchCalled;
    const cancelResponse = (await invoke(IPC_CHAT_CANCEL_CHANNEL, {
      requestId,
    })) as ChatCancelResponse;
    expect(cancelResponse).toEqual({ acknowledged: true });

    const response = await pending;
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('PROVIDER_ABORTED');
  });

  it('is a harmless no-op for an unknown or already-completed requestId', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_CHAT_CANCEL_CHANNEL, {
      requestId: randomUUID(),
    })) as ChatCancelResponse;
    expect(response).toEqual({ acknowledged: true });
  });

  it('rejects a malformed request', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_CHAT_CANCEL_CHANNEL, { requestId: 'not-a-uuid' })).rejects.toThrow();
  });
});
