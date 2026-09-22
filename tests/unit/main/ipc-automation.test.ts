import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcMain, SafeStorage } from 'electron';

import { engageEmergencyStop } from '../../../src/main/emergency';
import { registerIpcHandlers } from '../../../src/main/ipc';
import type { IpcHandlerRuntime } from '../../../src/main/ipc';
import type { UserDataPaths } from '../../../src/main/paths';
import { AUDIT_LOG_FILE_EXTENSION, AUDIT_LOG_FILE_PREFIX } from '../../../src/shared/constants';
import {
  IPC_AUTOMATION_CANCEL_CHANNEL,
  IPC_AUTOMATION_LIST_CHANNEL,
  IPC_AUTOMATION_RUN_CHANNEL,
} from '../../../src/shared/schemas';
import type { AutomationListResponse, AutomationRunResponse } from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

/**
 * The Windows automation channels, end to end through the real pipeline
 * (Phase 2, Milestone 10).
 *
 * `automationLaunchProcess` is always overridden with a fake here: the real
 * one starts a real, visible process (Notepad, Task Manager, …), and a test
 * suite must never do that. `automationOpenPath`, `automationOpenExternal`
 * and `focusMainWindow` are already fakes by default, from `buildRuntime`.
 */

const NOW = '2026-09-16T00:00:00.000Z';

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

  const event = { sender: { isDestroyed: () => false, send: () => undefined } };

  return {
    ipcMain,
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(new Error(`no handler registered for channel: ${channel}`));
      }
      try {
        return Promise.resolve(handler(event, ...args));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

function fakeSafeStorage(): SafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
  } as unknown as SafeStorage;
}

let dir: string;
let paths: UserDataPaths;

function approve(): Promise<ConfirmationResult> {
  return Promise.resolve('approved');
}

function reject(): Promise<ConfirmationResult> {
  return Promise.resolve('rejected');
}

function spyConfirmation(answer: ConfirmationResult) {
  return vi.fn<(message: string) => Promise<ConfirmationResult>>(() => Promise.resolve(answer));
}

function buildRuntime(overrides: Partial<IpcHandlerRuntime> = {}): IpcHandlerRuntime {
  return {
    userDataPaths: paths,
    safeStorage: fakeSafeStorage(),
    requestConfirmation: approve,
    selectProjectDirectory: () => Promise.resolve(null),
    selectMemoryExportFile: () => Promise.resolve(null),
    selectMemoryImportFile: () => Promise.resolve(null),
    automationOpenPath: () => Promise.resolve(''),
    automationOpenExternal: () => Promise.resolve(),
    automationSpecialFolder: () => 'C:\\fake\\Desktop',
    focusMainWindow: () => true,
    // Never the real process launcher in a test.
    automationLaunchProcess: () => Promise.resolve({ started: true }),
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

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-ipc10-')));
  paths = {
    userDataDir: dir,
    settingsFile: join(dir, 'settings.json'),
    permissionPolicyFile: join(dir, 'permissions', 'policy.json'),
    secretsFile: join(dir, 'secrets', 'secrets.enc'),
    auditLogDir: join(dir, 'logs', 'audit'),
    emergencyStateFile: join(dir, 'state', 'emergency.json'),
    memoryDir: join(dir, 'memory'),
    backupsDir: join(dir, 'backups'),
    gitHooksDir: join(dir, 'state', 'git-hooks-disabled'),
    agentProfilesFile: join(dir, 'agents', 'profiles.json'),
    memoryPersonalFile: join(dir, 'memory', 'personal.json'),
    memoryProjectsDir: join(dir, 'memory', 'projects'),
    workflowsFile: join(dir, 'workflows', 'workflows.json'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('automation:list', () => {
  it('lists every registered tool with no confirmation needed', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    const response = (await invoke(IPC_AUTOMATION_LIST_CHANNEL)) as AutomationListResponse;

    expect(response.outcome).toBe('success');
    expect(response.catalog?.tools.length).toBeGreaterThan(0);
    expect(response.catalog?.busy).toBe(false);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('never exposes an executable, an argument or a URL for any tool', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_AUTOMATION_LIST_CHANNEL)) as AutomationListResponse;
    for (const tool of response.catalog?.tools ?? []) {
      expect(tool).not.toHaveProperty('executable');
      expect(tool).not.toHaveProperty('args');
      expect(tool).not.toHaveProperty('url');
      expect(tool).not.toHaveProperty('folder');
    }
  });

  it('records only the read operation', async () => {
    const invoke = setUp();
    await invoke(IPC_AUTOMATION_LIST_CHANNEL);
    const record = (await readAuditLines()).at(-1);
    expect(record?.actionType).toBe('automation.read');
    expect(record?.parameters).toEqual({});
  });
});

describe('automation:run', () => {
  it('rejects a tool id outside the fixed registry before anything is decided', async () => {
    const invoke = setUp();
    for (const toolId of [
      'app.cmd',
      'app.powershell',
      'shell.execute',
      '',
      'app.notepad; whoami',
    ]) {
      await expect(
        invoke(IPC_AUTOMATION_RUN_CHANNEL, { runId: randomUUID(), toolId }),
      ).rejects.toThrow();
    }
  });

  it('has no field for a path, a URL, an argument or a command', async () => {
    const invoke = setUp();
    for (const extra of [
      { path: 'C:\\Windows\\System32' },
      { url: 'https://evil.example' },
      { args: ['--help'] },
      { command: 'notepad.exe' },
    ]) {
      await expect(
        invoke(IPC_AUTOMATION_RUN_CHANNEL, {
          runId: randomUUID(),
          toolId: 'app.notepad',
          ...extra,
        }),
      ).rejects.toThrow();
    }
  });

  it('asks for confirmation before running, naming the tool', async () => {
    const requestConfirmation = spyConfirmation('rejected');
    const invoke = setUp({ requestConfirmation });

    const response = (await invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'app.notepad',
    })) as AutomationRunResponse;

    expect(response.outcome).toBe('aborted');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0]?.[0] ?? '').toContain('Notepad');
  });

  it('cancels a pending confirmation so approving it later cannot start the action', async () => {
    const captured: {
      answerConfirmation: ((answer: ConfirmationResult) => void) | null;
      confirmationRequested: (() => void) | null;
    } = { answerConfirmation: null, confirmationRequested: null };
    const requested = new Promise<void>((resolvePromise) => {
      captured.confirmationRequested = resolvePromise;
    });
    const requestConfirmation = vi.fn(
      () =>
        new Promise<ConfirmationResult>((resolvePromise) => {
          captured.answerConfirmation = resolvePromise;
          captured.confirmationRequested?.();
        }),
    );
    const automationLaunchProcess = vi.fn(() => Promise.resolve({ started: true }));
    const invoke = setUp({ requestConfirmation, automationLaunchProcess });
    const runId = randomUUID();

    const run = invoke(IPC_AUTOMATION_RUN_CHANNEL, { runId, toolId: 'app.notepad' });
    await requested;
    await invoke(IPC_AUTOMATION_CANCEL_CHANNEL, { runId });
    captured.answerConfirmation?.('approved');

    const response = (await run) as AutomationRunResponse;
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('AUTOMATION_CANCELLED');
    expect(automationLaunchProcess).not.toHaveBeenCalled();
  });

  it('never starts the process when the confirmation is declined', async () => {
    const automationLaunchProcess = vi.fn(() => Promise.resolve({ started: true }));
    const invoke = setUp({ requestConfirmation: reject, automationLaunchProcess });
    await invoke(IPC_AUTOMATION_RUN_CHANNEL, { runId: randomUUID(), toolId: 'app.notepad' });
    expect(automationLaunchProcess).not.toHaveBeenCalled();
  });

  it('succeeds once approved, and reports a verified outcome', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'app.notepad',
    })) as AutomationRunResponse;

    expect(response.outcome).toBe('success');
    expect(response.run?.outcome).toBe('succeeded');
    expect(response.run?.verified).toBe(true);
  });

  it('records the tool id and its kind, and nothing else identifying', async () => {
    const invoke = setUp({ requestConfirmation: reject });
    await invoke(IPC_AUTOMATION_RUN_CHANNEL, { runId: randomUUID(), toolId: 'app.notepad' });

    const record = (await readAuditLines()).find((entry) => entry.actionType === 'automation.run');
    expect(record?.decision).toBe('confirm');
    expect(record?.outcome).toBe('aborted');
    expect(record?.parameters).toEqual({ toolId: 'app.notepad', kind: 'launch-app' });
  });

  it('refuses a second action while one is already running', async () => {
    const captured: { release: (() => void) | null; launchStarted: (() => void) | null } = {
      release: null,
      launchStarted: null,
    };
    const stall = new Promise<{ started: boolean }>((resolvePromise) => {
      captured.release = () => {
        resolvePromise({ started: true });
      };
    });
    const launchStarted = new Promise<void>((resolvePromise) => {
      captured.launchStarted = resolvePromise;
    });
    const invoke = setUp({
      automationLaunchProcess: () => {
        captured.launchStarted?.();
        return stall;
      },
    });

    const first = invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'app.notepad',
    });
    // Wait until the first request has actually claimed the in-flight slot,
    // rather than guessing how many ticks the real emergency-state read
    // needs before the second request is sent.
    await launchStarted;

    const second = (await invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'app.calculator',
    })) as AutomationRunResponse;
    expect(second.outcome).toBe('failure');
    expect(second.errorCode).toBe('AUTOMATION_ALREADY_RUNNING');

    captured.release?.();
    await first;
  });

  it('is refused outright while the emergency stop is engaged, without confirming', async () => {
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });

    const response = (await invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'app.notepad',
    })) as AutomationRunResponse;

    expect(response.outcome).toBe('denied');
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses the project folder tool when no project is approved', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'folder.project',
    })) as AutomationRunResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('AUTOMATION_NO_PROJECT');
  });

  it('reports a verification failure when the shell refuses to open a folder', async () => {
    const invoke = setUp({ automationOpenPath: () => Promise.resolve('no such folder') });
    const response = (await invoke(IPC_AUTOMATION_RUN_CHANNEL, {
      runId: randomUUID(),
      toolId: 'folder.desktop',
    })) as AutomationRunResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('AUTOMATION_VERIFICATION_FAILED');
  });
});

describe('automation:cancel', () => {
  it('acknowledges an unknown run without an error and without an audit record', async () => {
    const invoke = setUp();
    const response = await invoke(IPC_AUTOMATION_CANCEL_CHANNEL, { runId: randomUUID() });
    expect(response).toEqual({ acknowledged: true });
    await expect(readAuditLines()).rejects.toThrow();
  });

  it('rejects a run id that is not a uuid', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_AUTOMATION_CANCEL_CHANNEL, { runId: 'whatever' })).rejects.toThrow();
  });

  it('abandons a launch attempt in progress', async () => {
    const abortedFlag = { value: false };
    const captured: { launchStarted: (() => void) | null } = { launchStarted: null };
    const launchStarted = new Promise<void>((resolvePromise) => {
      captured.launchStarted = resolvePromise;
    });
    const invoke = setUp({
      automationLaunchProcess: (_program, _args, options) => {
        captured.launchStarted?.();
        return new Promise((resolvePromise) => {
          options.signal.addEventListener('abort', () => {
            abortedFlag.value = true;
            resolvePromise({ started: false });
          });
        });
      },
    });

    const runId = randomUUID();
    const run = invoke(IPC_AUTOMATION_RUN_CHANNEL, { runId, toolId: 'app.notepad' });
    // Wait until the fake launcher has actually been reached, rather than
    // guessing how many microtask or I/O ticks the emergency-state read
    // (`isEmergencyEngaged`) needs — that read is real filesystem I/O, not
    // just a microtask.
    await launchStarted;
    await invoke(IPC_AUTOMATION_CANCEL_CHANNEL, { runId });

    const response = (await run) as AutomationRunResponse;
    expect(abortedFlag.value).toBe(true);
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('AUTOMATION_CANCELLED');
  });
});
