import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import {
  AUDIT_LOG_FILE_EXTENSION,
  AUDIT_LOG_FILE_PREFIX,
  CHAT_STREAM_MAX_DELTA_LENGTH,
} from '../../../src/shared/constants';
import {
  createChatMessage,
  createDefaultSettings,
  IPC_CHAT_CANCEL_CHANNEL,
  IPC_CHAT_CHUNK_CHANNEL,
  IPC_CHAT_SEND_CHANNEL,
  IPC_SECRETS_CLEAR_CHANNEL,
  IPC_SECRETS_STATUS_CHANNEL,
  IPC_SECRETS_WRITE_CHANNEL,
  IPC_SETTINGS_GET_CHANNEL,
  IPC_SETTINGS_UPDATE_CHANNEL,
  IPC_WORKSPACE_FILE_CHANNEL,
  IPC_WORKSPACE_PLAN_CHANNEL,
  IPC_WORKSPACE_SEARCH_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
  IPC_WORKSPACE_STATUS_CHANNEL,
  IPC_WORKSPACE_TREE_CHANNEL,
} from '../../../src/shared/schemas';
import type {
  ChatCancelResponse,
  ChatSendResponse,
  SecretsActionResponse,
  SettingsActionResponse,
  WorkspaceFileResponse,
  WorkspacePlanResponse,
  WorkspaceProjectResponse,
  WorkspaceSearchResponse,
  WorkspaceTreeResponse,
} from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

const NOW = '2026-08-07T00:00:00.000Z';
const PLAINTEXT_KEY = 'sk-super-secret-onboarding-key';
/**
 * An obviously fake value written into a project fixture's `.env`, so tests
 * can assert it never appears in a response, a search result or an audit
 * record. Never a real credential — see `AGENTS.md` section 4.
 */
const WORKSPACE_SENTINEL_SECRET = 'fake-sentinel-not-a-real-key';

/** One main → renderer event the fake `WebContents` was asked to send. */
interface SentEvent {
  readonly channel: string;
  readonly payload: unknown;
}

function createFakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** Everything pushed to the invoking renderer, in order. */
  sentEvents: SentEvent[];
  /** Simulates the window closing mid-request. */
  destroySender: () => void;
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  // Stands in for the `IpcMainInvokeEvent.sender` `WebContents` that real
  // Electron hands a handler: the only way a handler can push an event back
  // to the renderer that invoked it.
  const sentEvents: SentEvent[] = [];
  let senderDestroyed = false;
  const event = {
    sender: {
      isDestroyed: () => senderDestroyed,
      send: (channel: string, payload: unknown) => {
        sentEvents.push({ channel, payload });
      },
    },
  };

  return {
    ipcMain,
    sentEvents,
    destroySender: () => {
      senderDestroyed = true;
    },
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
        return Promise.resolve(handler(event, ...args));
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

/**
 * The default picker answer: dismissed.
 *
 * A test that wants a project must say so explicitly, so no test can approve
 * a directory by forgetting to configure one.
 */
function cancelDirectoryPicker(): Promise<string | null> {
  return Promise.resolve(null);
}

function buildRuntime(overrides: Partial<IpcHandlerRuntime> = {}): IpcHandlerRuntime {
  return {
    userDataPaths: paths,
    safeStorage: fakeSafeStorage(true),
    requestConfirmation: approve,
    selectProjectDirectory: cancelDirectoryPicker,
    nowFn: () => NOW,
    ...overrides,
  };
}

function setUp(overrides: Partial<IpcHandlerRuntime> = {}) {
  const { ipcMain, invoke } = createFakeIpcMain();
  registerIpcHandlers(ipcMain, buildRuntime(overrides));
  return invoke;
}

/** Like {@link setUp}, but also exposes what was pushed back to the renderer. */
function setUpWithEvents(overrides: Partial<IpcHandlerRuntime> = {}) {
  const fake = createFakeIpcMain();
  registerIpcHandlers(fake.ipcMain, buildRuntime(overrides));
  return fake;
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

describe('chat:send — streaming previews (chat:chunk)', () => {
  function sseResponse(...contents: string[]): Response {
    const body =
      contents
        .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        .join('') + 'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('pushes one chat:chunk event per streamed fragment, correlated by requestId', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('Hel', 'lo')));

    const { invoke, sentEvents } = setUpWithEvents();
    const requestId = randomUUID();
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId,
      messages: [userMessage('hi')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('success');
    expect(response.content).toBe('Hello');
    expect(sentEvents).toEqual([
      { channel: IPC_CHAT_CHUNK_CHANNEL, payload: { requestId, delta: 'Hel' } },
      { channel: IPC_CHAT_CHUNK_CHANNEL, payload: { requestId, delta: 'lo' } },
    ]);
  });

  it('sends no chunk event for a non-streamed response', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'whole' } }] })),
    );

    const { invoke, sentEvents } = setUpWithEvents();
    await invoke(IPC_CHAT_SEND_CHANNEL, { requestId: randomUUID(), messages: [userMessage('hi')] });

    expect(sentEvents).toEqual([]);
  });

  it('sends no chunk event when the action is denied by the emergency stop', async () => {
    await configureOpenAiCompatible();
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('never')));

    const { invoke, sentEvents } = setUpWithEvents();
    const response = (await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hi')],
    })) as ChatSendResponse;

    expect(response.outcome).toBe('denied');
    expect(sentEvents).toEqual([]);
  });

  it('splits an oversized fragment across several bounded events rather than dropping it', async () => {
    await configureOpenAiCompatible();
    const long = 'x'.repeat(CHAT_STREAM_MAX_DELTA_LENGTH + 500);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(long)));

    const { invoke, sentEvents } = setUpWithEvents();
    await invoke(IPC_CHAT_SEND_CHANNEL, { requestId: randomUUID(), messages: [userMessage('hi')] });

    expect(sentEvents.length).toBe(2);
    for (const event of sentEvents) {
      const { delta } = event.payload as { delta: string };
      expect(delta.length).toBeLessThanOrEqual(CHAT_STREAM_MAX_DELTA_LENGTH);
    }
    const rejoined = sentEvents.map((event) => (event.payload as { delta: string }).delta).join('');
    expect(rejoined).toBe(long);
  });

  it('never sends a chunk event to a destroyed renderer', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('gone')));

    const fake = setUpWithEvents();
    fake.destroySender();
    const response = (await fake.invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('hi')],
    })) as ChatSendResponse;

    // The request itself still completes; only the preview is skipped.
    expect(response.outcome).toBe('success');
    expect(fake.sentEvents).toEqual([]);
  });

  it('never includes the API key or the conversation in a chunk event', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('safe reply')));

    const { invoke, sentEvents } = setUpWithEvents();
    await invoke(IPC_CHAT_SEND_CHANNEL, {
      requestId: randomUUID(),
      messages: [userMessage('a private question nobody should echo')],
    });

    const serialized = JSON.stringify(sentEvents);
    expect(serialized).not.toContain(PLAINTEXT_KEY);
    expect(serialized).not.toContain('a private question nobody should echo');
  });

  it('records nothing about streamed content in the audit trail', async () => {
    await configureOpenAiCompatible();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('audited nowhere')));

    const { invoke } = setUpWithEvents();
    await invoke(IPC_CHAT_SEND_CHANNEL, { requestId: randomUUID(), messages: [userMessage('hi')] });

    const lines = await readAuditLines();
    const record = lines.find((line) => line.actionType === 'chat.send');
    expect(record?.parameters).toEqual({ provider: 'openai-compatible', messageCount: 1 });
    expect(JSON.stringify(lines)).not.toContain('audited nowhere');
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

// ---------------------------------------------------------------------------
// Coding workspace (Phase 2, Milestone 5)
// ---------------------------------------------------------------------------

/** A small project fixture, created outside the user-data directory. */
async function createProjectFixture(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'local-agent-project-'));
  const real = await realpath(projectRoot);
  await mkdir(join(real, 'src'), { recursive: true });
  await mkdir(join(real, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(real, 'README.md'), '# Fixture\n\nThe answer is 42.\n', 'utf8');
  await writeFile(join(real, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await writeFile(join(real, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
  await writeFile(join(real, '.env'), `API_KEY=${WORKSPACE_SENTINEL_SECRET}\n`, 'utf8');
  await writeFile(join(real, 'node_modules', 'pkg', 'index.js'), 'module.exports = 42;\n', 'utf8');
  return real;
}

/** Registers handlers whose picker returns `projectRoot` exactly once. */
function setUpWorkspace(projectRoot: string, overrides: Partial<IpcHandlerRuntime> = {}) {
  return setUp({
    selectProjectDirectory: () => Promise.resolve(projectRoot),
    ...overrides,
  });
}

describe('workspace:status', () => {
  it('reports no project before one has been approved', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_WORKSPACE_STATUS_CHANNEL)) as WorkspaceProjectResponse;
    expect(response.outcome).toBe('success');
    expect(response.project).toBeNull();
  });

  it('is routed through the permission pipeline and audited', async () => {
    const invoke = setUp();
    await invoke(IPC_WORKSPACE_STATUS_CHANNEL);

    const [record] = await readAuditLines();
    expect(record?.actionType).toBe('workspace.read');
    expect(record?.decision).toBe('allow');
    expect(record?.outcome).toBe('success');
    expect(record?.parameters).toEqual({ operation: 'status' });
  });

  it('rejects an unexpected argument before any proposal is built', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_WORKSPACE_STATUS_CHANNEL, { extra: true })).rejects.toThrow();
    await expect(readAuditLines()).rejects.toThrow();
  });
});

describe('workspace:select', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createProjectFixture();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('adopts the directory the native picker returned, with its markers', async () => {
    const invoke = setUpWorkspace(projectRoot);
    const response = (await invoke(IPC_WORKSPACE_SELECT_CHANNEL)) as WorkspaceProjectResponse;

    expect(response.outcome).toBe('success');
    expect(response.project?.path).toBe(projectRoot);
    expect(response.project?.markers).toContain('package.json');
    expect(response.project?.markers).toContain('README.md');
  });

  it('takes no argument, so the renderer cannot name a directory', async () => {
    const selectProjectDirectory = vi.fn(() => Promise.resolve(projectRoot));
    const invoke = setUp({ selectProjectDirectory });

    // A payload naming a directory is rejected outright by the request tuple.
    await expect(invoke(IPC_WORKSPACE_SELECT_CHANNEL, { path: 'C:\\Windows' })).rejects.toThrow();
    expect(selectProjectDirectory).not.toHaveBeenCalled();

    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);
    expect(selectProjectDirectory).toHaveBeenCalledWith();
  });

  it('reports a dismissed picker with its own code, not a generic failure', async () => {
    const invoke = setUp({ selectProjectDirectory: () => Promise.resolve(null) });
    const response = (await invoke(IPC_WORKSPACE_SELECT_CHANNEL)) as WorkspaceProjectResponse;
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKSPACE_SELECTION_CANCELLED');
    expect(response.project).toBeUndefined();
  });

  it("refuses the application's own user-data directory", async () => {
    const invoke = setUp({ selectProjectDirectory: () => Promise.resolve(dir) });
    const response = (await invoke(IPC_WORKSPACE_SELECT_CHANNEL)) as WorkspaceProjectResponse;
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKSPACE_INVALID_PROJECT');
  });

  it('records the selection without the path or the project name', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);

    const [record] = await readAuditLines();
    expect(record?.actionType).toBe('workspace.select');
    expect(record?.outcome).toBe('success');
    expect(record?.parameters).toEqual({ operation: 'select' });
    // A directory path can name a person, a client, or an unreleased product.
    expect(JSON.stringify(record)).not.toContain(projectRoot);
  });

  it('keeps the approved project for the rest of the session', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);

    const status = (await invoke(IPC_WORKSPACE_STATUS_CHANNEL)) as WorkspaceProjectResponse;
    expect(status.project?.path).toBe(projectRoot);
  });

  it('never leaks the project of one registration into another', async () => {
    const first = setUpWorkspace(projectRoot);
    await first(IPC_WORKSPACE_SELECT_CHANNEL);

    const second = setUp();
    const status = (await second(IPC_WORKSPACE_STATUS_CHANNEL)) as WorkspaceProjectResponse;
    expect(status.project).toBeNull();
  });
});

describe('workspace:tree, workspace:file and workspace:search', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createProjectFixture();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function withProject() {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);
    return invoke;
  }

  it('refuses every read before a project is approved', async () => {
    const invoke = setUp();
    for (const [channel, payload] of [
      [IPC_WORKSPACE_TREE_CHANNEL, { path: '' }],
      [IPC_WORKSPACE_FILE_CHANNEL, { path: 'README.md' }],
      [IPC_WORKSPACE_SEARCH_CHANNEL, { query: 'answer', path: '' }],
      [IPC_WORKSPACE_PLAN_CHANNEL, { objective: 'Add retry' }],
    ] as const) {
      const response = (await invoke(channel, payload)) as { outcome: string; errorCode?: string };
      expect(response.outcome, channel).toBe('failure');
      expect(response.errorCode, channel).toBe('WORKSPACE_NO_PROJECT');
    }
  });

  it('lists the approved project', async () => {
    const invoke = await withProject();
    const response = (await invoke(IPC_WORKSPACE_TREE_CHANNEL, {
      path: '',
    })) as WorkspaceTreeResponse;
    expect(response.outcome).toBe('success');
    expect(response.tree?.entries.map((entry) => entry.path)).toContain('README.md');
  });

  it('reads a text file from the approved project', async () => {
    const invoke = await withProject();
    const response = (await invoke(IPC_WORKSPACE_FILE_CHANNEL, {
      path: 'src/index.ts',
    })) as WorkspaceFileResponse;
    expect(response.outcome).toBe('success');
    expect(response.file?.content).toContain('answer');
  });

  it('refuses a traversal at the schema, before a proposal exists', async () => {
    const invoke = await withProject();
    await expect(
      invoke(IPC_WORKSPACE_FILE_CHANNEL, { path: '../../etc/passwd' }),
    ).rejects.toThrow();
    await expect(invoke(IPC_WORKSPACE_TREE_CHANNEL, { path: '..' })).rejects.toThrow();
  });

  it('refuses a credential file and never returns its contents', async () => {
    const invoke = await withProject();
    const response = (await invoke(IPC_WORKSPACE_FILE_CHANNEL, {
      path: '.env',
    })) as WorkspaceFileResponse;
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKSPACE_PATH_EXCLUDED');
    expect(JSON.stringify(response)).not.toContain(WORKSPACE_SENTINEL_SECRET);
  });

  it('never surfaces a credential through search either', async () => {
    const invoke = await withProject();
    const response = (await invoke(IPC_WORKSPACE_SEARCH_CHANNEL, {
      query: WORKSPACE_SENTINEL_SECRET,
      path: '',
    })) as WorkspaceSearchResponse;
    expect(response.outcome).toBe('success');
    expect(response.results?.matches).toEqual([]);
  });

  it('searches the approved project and returns bounded matches', async () => {
    const invoke = await withProject();
    const response = (await invoke(IPC_WORKSPACE_SEARCH_CHANNEL, {
      query: 'answer',
      path: '',
    })) as WorkspaceSearchResponse;
    expect(response.outcome).toBe('success');
    expect(response.results?.matches.length).toBeGreaterThan(0);
    for (const match of response.results?.matches ?? []) {
      expect(match.path.startsWith('node_modules/')).toBe(false);
    }
  });

  it('rejects a search query that is too short or carries control characters', async () => {
    const invoke = await withProject();
    await expect(invoke(IPC_WORKSPACE_SEARCH_CHANNEL, { query: 'a', path: '' })).rejects.toThrow();
    await expect(
      invoke(IPC_WORKSPACE_SEARCH_CHANNEL, {
        query: `bad${String.fromCharCode(0)}query`,
        path: '',
      }),
    ).rejects.toThrow();
  });

  it('records the operation and a length, never a path, a name or a query', async () => {
    const invoke = await withProject();
    await invoke(IPC_WORKSPACE_FILE_CHANNEL, { path: 'src/index.ts' });
    await invoke(IPC_WORKSPACE_SEARCH_CHANNEL, { query: 'answer', path: '' });

    const records = await readAuditLines();
    const fileRecord = records.find(
      (record) => (record.parameters as { operation?: string }).operation === 'file',
    );
    const searchRecord = records.find(
      (record) => (record.parameters as { operation?: string }).operation === 'search',
    );

    expect(fileRecord?.parameters).toEqual({ operation: 'file' });
    expect(searchRecord?.parameters).toEqual({ operation: 'search', queryLength: 6 });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('src/index.ts');
    expect(serialized).not.toContain('answer');
    expect(serialized).not.toContain(projectRoot);
  });
});

describe('workspace:plan', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createProjectFixture();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('produces an inert plan that always awaits approval', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);

    const response = (await invoke(IPC_WORKSPACE_PLAN_CHANNEL, {
      objective: 'Add retry around the answer constant',
    })) as WorkspacePlanResponse;

    expect(response.outcome).toBe('success');
    expect(response.plan?.approvalRequired).toBe(true);
    expect(response.plan?.status).toBe('awaiting-approval');
    expect(response.plan?.diff).toBeNull();
  });

  it('changes nothing on disk, whatever the objective asks for', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);

    const before = await readFile(join(projectRoot, 'src', 'index.ts'), 'utf8');
    await invoke(IPC_WORKSPACE_PLAN_CHANNEL, {
      objective: 'Delete src/index.ts and rewrite README.md completely',
    });
    expect(await readFile(join(projectRoot, 'src', 'index.ts'), 'utf8')).toBe(before);
  });

  it('records the objective length, never the objective itself', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);
    await invoke(IPC_WORKSPACE_PLAN_CHANNEL, { objective: 'Add retry to the answer' });

    const records = await readAuditLines();
    const planRecord = records.find((record) => record.actionType === 'workspace.plan');
    expect(planRecord?.parameters).toEqual({
      operation: 'plan',
      objectiveLength: 'Add retry to the answer'.length,
    });
    expect(JSON.stringify(records)).not.toContain('Add retry to the answer');
  });

  it('rejects an objective that is too short, too long, or unsafe', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);

    await expect(invoke(IPC_WORKSPACE_PLAN_CHANNEL, { objective: 'ab' })).rejects.toThrow();
    await expect(
      invoke(IPC_WORKSPACE_PLAN_CHANNEL, { objective: 'a'.repeat(5000) }),
    ).rejects.toThrow();
    await expect(
      invoke(IPC_WORKSPACE_PLAN_CHANNEL, { objective: `add${String.fromCharCode(0)}retry` }),
    ).rejects.toThrow();
  });
});

describe('workspace channels under the emergency stop', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createProjectFixture();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('denies every workspace action once the stop is engaged', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    for (const [channel, payload] of [
      [IPC_WORKSPACE_STATUS_CHANNEL, undefined],
      [IPC_WORKSPACE_SELECT_CHANNEL, undefined],
      [IPC_WORKSPACE_TREE_CHANNEL, { path: '' }],
      [IPC_WORKSPACE_FILE_CHANNEL, { path: 'README.md' }],
      [IPC_WORKSPACE_SEARCH_CHANNEL, { query: 'answer', path: '' }],
      [IPC_WORKSPACE_PLAN_CHANNEL, { objective: 'Add retry' }],
    ] as const) {
      const response = (await (payload === undefined
        ? invoke(channel)
        : invoke(channel, payload))) as { outcome: string };
      expect(response.outcome, channel).toBe('denied');
    }
  });

  it('never opens the picker while the stop is engaged', async () => {
    const selectProjectDirectory = vi.fn(() => Promise.resolve(projectRoot));
    const invoke = setUp({ selectProjectDirectory });
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const response = (await invoke(IPC_WORKSPACE_SELECT_CHANNEL)) as WorkspaceProjectResponse;
    expect(response.outcome).toBe('denied');
    // `execute` never reaches `perform`, so the dialog is never shown.
    expect(selectProjectDirectory).not.toHaveBeenCalled();
  });

  it('never reads a file while the stop is engaged', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await invoke(IPC_WORKSPACE_SELECT_CHANNEL);
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const response = (await invoke(IPC_WORKSPACE_FILE_CHANNEL, {
      path: 'src/index.ts',
    })) as WorkspaceFileResponse;
    expect(response.outcome).toBe('denied');
    expect(response.file).toBeUndefined();
  });

  it('records the denial with the same fidelity as a success', async () => {
    const invoke = setUpWorkspace(projectRoot);
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    await invoke(IPC_WORKSPACE_TREE_CHANNEL, { path: '' });

    const records = await readAuditLines();
    const denial = records.find((record) => record.actionType === 'workspace.read');
    expect(denial?.decision).toBe('deny');
    expect(denial?.outcome).toBe('denied');
    expect(denial?.decisionReason).toBe('emergency-stop');
  });
});

describe('workspace channels under a restrictive policy', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createProjectFixture();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('denies a workspace action a hand-edited policy omits', async () => {
    // A policy that declares only the emergency floor leaves every workspace
    // action unmatched, and unmatched actions are denied.
    await mkdir(join(paths.userDataDir, 'permissions'), { recursive: true });
    await writeFile(
      paths.permissionPolicyFile,
      JSON.stringify({
        schemaVersion: 1,
        defaultDecision: 'deny',
        rules: [
          {
            id: 'audit.read',
            actionType: 'audit.read',
            decision: 'allow',
            priority: 100,
            reason: 'x',
          },
          {
            id: 'emergency.engage',
            actionType: 'emergency.engage',
            decision: 'allow',
            priority: 100,
            reason: 'x',
          },
          {
            id: 'emergency.reset',
            actionType: 'emergency.reset',
            decision: 'confirm',
            priority: 100,
            reason: 'x',
          },
        ],
      }),
      'utf8',
    );

    const invoke = setUpWorkspace(projectRoot);
    const response = (await invoke(IPC_WORKSPACE_SELECT_CHANNEL)) as WorkspaceProjectResponse;
    expect(response.outcome).toBe('denied');
  });
});
