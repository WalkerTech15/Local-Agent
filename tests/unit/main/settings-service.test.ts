import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SafeStorage } from 'electron';

import type { UserDataPaths } from '../../../src/main/paths';
import { writeSecret } from '../../../src/main/secrets';
import { loadSettings, writeSettings } from '../../../src/main/settings';
import {
  readReconciledSettings,
  refreshHasApiKeyAfterSecretChange,
  writeOnboardingSettings,
} from '../../../src/main/settings-service';
import { createDefaultSettings } from '../../../src/shared/schemas';

const NOW = '2026-08-07T00:00:00.000Z';

function fakeSafeStorage(): SafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`fake-enc:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice('fake-enc:'.length),
  } as unknown as SafeStorage;
}

let dir: string;
let settingsFile: string;
let secretsFile: string;
let paths: UserDataPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-settings-service-'));
  settingsFile = join(dir, 'settings.json');
  secretsFile = join(dir, 'secrets.enc');
  paths = {
    userDataDir: dir,
    settingsFile,
    permissionPolicyFile: join(dir, 'policy.json'),
    secretsFile,
    auditLogDir: join(dir, 'logs', 'audit'),
    emergencyStateFile: join(dir, 'emergency.json'),
    memoryDir: join(dir, 'memory'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readReconciledSettings — reconciliation', () => {
  it('leaves hasApiKey false when no key is stored and none was recorded', async () => {
    const settings = await readReconciledSettings(paths, NOW);
    expect(settings.modelProvider.hasApiKey).toBe(false);
  });

  it('corrects a stale hasApiKey: true to false when the secret store has no key', async () => {
    await writeSettings(settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: true },
    });

    const settings = await readReconciledSettings(paths, NOW);
    expect(settings.modelProvider.hasApiKey).toBe(false);

    const persisted = await loadSettings(settingsFile, NOW);
    expect(persisted.modelProvider.hasApiKey).toBe(false);
  });

  it('corrects a stale hasApiKey: false to true when the secret store actually has a key', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', fakeSafeStorage());
    await writeSettings(settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });

    const settings = await readReconciledSettings(paths, NOW);
    expect(settings.modelProvider.hasApiKey).toBe(true);
  });

  it('forces hasApiKey false for the none provider even if a key happens to be stored', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', fakeSafeStorage());
    await writeSettings(settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'none', model: '', baseUrl: '', hasApiKey: false },
    });

    const settings = await readReconciledSettings(paths, NOW);
    expect(settings.modelProvider.hasApiKey).toBe(false);
  });

  it('forces hasApiKey false for ollama even if a key happens to be stored', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', fakeSafeStorage());
    await writeSettings(settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'ollama', model: 'llama3.1', baseUrl: '', hasApiKey: false },
    });

    const settings = await readReconciledSettings(paths, NOW);
    expect(settings.modelProvider.hasApiKey).toBe(false);
  });

  it('does not rewrite settings.json when hasApiKey already matches the store', async () => {
    await writeSettings(settingsFile, createDefaultSettings(NOW));
    const before = await readFile(settingsFile, 'utf8');

    await readReconciledSettings(paths, NOW);

    const after = await readFile(settingsFile, 'utf8');
    expect(after).toBe(before);
  });
});

describe('writeOnboardingSettings', () => {
  it('persists a full settings document and never accepts hasApiKey as input', async () => {
    const result = await writeOnboardingSettings(paths, NOW, {
      onboardingCompleted: true,
      assistant: { name: 'JARVIS' },
      user: { displayName: 'Alex Martin' },
      language: { ui: 'fr' },
      modelProvider: { provider: 'none', model: '', baseUrl: '' },
    });

    expect(result.onboardingCompleted).toBe(true);
    expect(result.language.ui).toBe('fr');
    expect(result.modelProvider.hasApiKey).toBe(false);

    const persisted = await loadSettings(settingsFile, NOW);
    expect(persisted).toEqual(result);
  });

  it('computes hasApiKey from the secret store for the selected provider, not from input', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', fakeSafeStorage());

    const result = await writeOnboardingSettings(paths, NOW, {
      onboardingCompleted: true,
      assistant: { name: 'JARVIS' },
      user: { displayName: 'Alex Martin' },
      language: { ui: 'en' },
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '' },
    });

    expect(result.modelProvider.hasApiKey).toBe(true);
  });

  it('rejects completing onboarding with an empty display name, and writes nothing', async () => {
    await expect(
      writeOnboardingSettings(paths, NOW, {
        onboardingCompleted: true,
        assistant: { name: 'JARVIS' },
        user: { displayName: '' },
        language: { ui: 'en' },
        modelProvider: { provider: 'none', model: '', baseUrl: '' },
      }),
    ).rejects.toThrow();

    await expect(readFile(settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects openai-compatible with an empty baseUrl, and writes nothing', async () => {
    await expect(
      writeOnboardingSettings(paths, NOW, {
        onboardingCompleted: true,
        assistant: { name: 'JARVIS' },
        user: { displayName: 'Alex' },
        language: { ui: 'en' },
        modelProvider: { provider: 'openai-compatible', model: 'gpt', baseUrl: '' },
      }),
    ).rejects.toThrow();

    await expect(readFile(settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows skipping provider setup with the safe none state and an empty display name pending', async () => {
    const result = await writeOnboardingSettings(paths, NOW, {
      onboardingCompleted: false,
      assistant: { name: 'JARVIS' },
      user: { displayName: '' },
      language: { ui: 'en' },
      modelProvider: { provider: 'none', model: '', baseUrl: '' },
    });
    expect(result.onboardingCompleted).toBe(false);
    expect(result.modelProvider.provider).toBe('none');
    expect(result.modelProvider.hasApiKey).toBe(false);
  });

  it('carries schemaVersion and telemetry forward rather than accepting them as input', async () => {
    const result = await writeOnboardingSettings(paths, NOW, {
      onboardingCompleted: true,
      assistant: { name: 'JARVIS' },
      user: { displayName: 'Alex' },
      language: { ui: 'en' },
      modelProvider: { provider: 'none', model: '', baseUrl: '' },
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.telemetry).toEqual({ enabled: false });
  });
});

describe('refreshHasApiKeyAfterSecretChange', () => {
  it('reflects a key that was just written', async () => {
    await writeSettings(settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: false },
    });
    await writeSecret(secretsFile, 'sk-real-secret-value', fakeSafeStorage());

    const refreshed = await refreshHasApiKeyAfterSecretChange(paths, NOW);
    expect(refreshed.modelProvider.hasApiKey).toBe(true);

    const persisted = await loadSettings(settingsFile, NOW);
    expect(persisted.modelProvider.hasApiKey).toBe(true);
  });

  it('reflects a key that was just cleared', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', fakeSafeStorage());
    await writeSettings(settingsFile, {
      ...createDefaultSettings(NOW),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: true },
    });

    // Simulate the store having just been cleared by main/secrets.ts.
    const { clearSecret } = await import('../../../src/main/secrets');
    await clearSecret(secretsFile);

    const refreshed = await refreshHasApiKeyAfterSecretChange(paths, NOW);
    expect(refreshed.modelProvider.hasApiKey).toBe(false);
  });
});
