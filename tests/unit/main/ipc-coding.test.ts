import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcMain, SafeStorage } from 'electron';

import { engageEmergencyStop } from '../../../src/main/emergency';
import { registerIpcHandlers } from '../../../src/main/ipc';
import type { IpcHandlerRuntime } from '../../../src/main/ipc';
import type { UserDataPaths } from '../../../src/main/paths';
import { AUDIT_LOG_FILE_EXTENSION, AUDIT_LOG_FILE_PREFIX } from '../../../src/shared/constants';
import {
  IPC_COMMAND_CANCEL_CHANNEL,
  IPC_COMMAND_LIST_CHANNEL,
  IPC_COMMAND_RUN_CHANNEL,
  IPC_GIT_CHECKPOINT_CHANNEL,
  IPC_GIT_DIFF_CHANNEL,
  IPC_GIT_STATUS_CHANNEL,
  IPC_WORKSPACE_APPLY_CHANNEL,
  IPC_WORKSPACE_CHANGES_CHANNEL,
  IPC_WORKSPACE_PROPOSE_CHANNEL,
  IPC_WORKSPACE_ROLLBACK_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
} from '../../../src/shared/schemas';
import type {
  CommandCancelResponse,
  CommandListResponse,
  CommandRunResponse,
  GitCheckpointResponse,
  GitStatusResponse,
  WorkspaceChangeResponse,
  WorkspaceChangesResponse,
} from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

/**
 * The controlled coding channels, end to end through the real pipeline
 * (Phase 2, Milestone 6).
 *
 * The four channels that can change something outside the application's own
 * data directory are the reason this milestone exists, so almost everything
 * here is about the gates in front of them: the permission engine, the native
 * confirmation, the emergency stop, and what does — and does not — reach the
 * audit log.
 *
 * A separate file from `ipc.test.ts` rather than an addition to it: the
 * Milestone 5 suite is already long, and these cases share a different
 * fixture (an approved project with a proposed change) that would otherwise
 * have to be built in every test. The small harness below is deliberately
 * duplicated rather than exported, matching how this codebase already treats
 * small self-contained helpers.
 */

const NOW = '2026-09-08T00:00:00.000Z';
const ORIGINAL_INDEX = 'export const answer = 42;\n';
const CHANGED_INDEX = 'export const answer = 43;\n';

/** Obviously fake — never a real credential. See `AGENTS.md` section 4. */
const SENTINEL_SECRET = 'fake-sentinel-not-a-real-key';

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

  const event = {
    sender: { isDestroyed: () => false, send: () => undefined },
  };

  return {
    ipcMain,
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(new Error(`no handler registered for channel: ${channel}`));
      }
      // Mirrors real Electron: a handler that throws synchronously still
      // rejects `ipcRenderer.invoke`'s promise.
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
let projectRoot: string;

function approve(): Promise<ConfirmationResult> {
  return Promise.resolve('approved');
}

function reject(): Promise<ConfirmationResult> {
  return Promise.resolve('rejected');
}

/**
 * A confirmation spy that keeps the message parameter in its type.
 *
 * `vi.fn(approve)` would infer the zero-argument signature of `approve` and
 * lose the message, which is the one thing several of these tests need to
 * inspect: the sentence the user is actually shown.
 */
function spyConfirmation(answer: ConfirmationResult) {
  return vi.fn<(message: string) => Promise<ConfirmationResult>>(() => Promise.resolve(answer));
}

function buildRuntime(overrides: Partial<IpcHandlerRuntime> = {}): IpcHandlerRuntime {
  return {
    userDataPaths: paths,
    safeStorage: fakeSafeStorage(),
    requestConfirmation: approve,
    // Default: the picker is dismissed, so no test approves a directory by
    // forgetting to configure one.
    selectProjectDirectory: () => Promise.resolve(null),
    nowFn: () => NOW,
    ...overrides,
  };
}

function setUp(overrides: Partial<IpcHandlerRuntime> = {}) {
  const { ipcMain, invoke } = createFakeIpcMain();
  registerIpcHandlers(ipcMain, buildRuntime(overrides));
  return invoke;
}

/** Registers handlers with the picker already answering with the fixture. */
async function setUpApproved(overrides: Partial<IpcHandlerRuntime> = {}) {
  const invoke = setUp({
    selectProjectDirectory: () => Promise.resolve(projectRoot),
    ...overrides,
  });
  await invoke(IPC_WORKSPACE_SELECT_CHANNEL);
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

function indexPath(): string {
  return join(projectRoot, 'src', 'index.ts');
}

/** Proposes a one-file change and returns its id. */
async function proposeIndexChange(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): Promise<string> {
  const response = (await invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, {
    edits: [{ path: 'src/index.ts', content: CHANGED_INDEX }],
  })) as WorkspaceChangeResponse;
  expect(response.outcome).toBe('success');
  return response.change?.id ?? '';
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-ipc6-')));
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
  };

  projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-project6-')));
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await writeFile(join(projectRoot, 'README.md'), '# Fixture\n', 'utf8');
  await writeFile(indexPath(), ORIGINAL_INDEX, 'utf8');
  await writeFile(join(projectRoot, '.env'), `API_KEY=${SENTINEL_SECRET}\n`, 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe('workspace:propose', () => {
  it('returns a diff and writes nothing', async () => {
    const invoke = await setUpApproved();
    const response = (await invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, {
      edits: [{ path: 'src/index.ts', content: CHANGED_INDEX }],
    })) as WorkspaceChangeResponse;

    expect(response.outcome).toBe('success');
    expect(response.change?.status).toBe('awaiting-approval');
    expect(response.change?.approvalRequired).toBe(true);
    expect(await readFile(indexPath(), 'utf8')).toBe(ORIGINAL_INDEX);
  });

  it('needs no confirmation, because it changes nothing', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = await setUpApproved({ requestConfirmation });
    await proposeIndexChange(invoke);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('records the file count and no path at all', async () => {
    const invoke = await setUpApproved();
    await proposeIndexChange(invoke);

    const records = await readAuditLines();
    const record = records[records.length - 1];
    expect(record?.actionType).toBe('workspace.plan');
    expect(record?.parameters).toEqual({ operation: 'propose', fileCount: 1 });
  });

  it('rejects a traversal path before any proposal is built', async () => {
    const invoke = await setUpApproved();
    await expect(
      invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, { edits: [{ path: '../escape.ts', content: 'x' }] }),
    ).rejects.toThrow();
  });

  it('rejects a change set naming the same file twice', async () => {
    const invoke = await setUpApproved();
    await expect(
      invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, {
        edits: [
          { path: 'src/index.ts', content: 'a\n' },
          { path: 'src/index.ts', content: 'b\n' },
        ],
      }),
    ).rejects.toThrow();
  });

  it('rejects a request carrying an unexpected field', async () => {
    const invoke = await setUpApproved();
    await expect(
      invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, {
        edits: [{ path: 'src/index.ts', content: 'x\n' }],
        force: true,
      }),
    ).rejects.toThrow();
  });

  it('refuses before a project is approved', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_WORKSPACE_PROPOSE_CHANNEL, {
      edits: [{ path: 'src/index.ts', content: 'x\n' }],
    })) as WorkspaceChangeResponse;
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKSPACE_NO_PROJECT');
  });
});

describe('workspace:apply', () => {
  it('writes the proposed content once the confirmation is approved', async () => {
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);

    const response = (await invoke(IPC_WORKSPACE_APPLY_CHANNEL, {
      changeId,
    })) as WorkspaceChangeResponse;

    expect(response.outcome).toBe('success');
    expect(response.change?.status).toBe('applied');
    expect(await readFile(indexPath(), 'utf8')).toBe(CHANGED_INDEX);
  });

  it('writes nothing when the confirmation is rejected', async () => {
    const invoke = await setUpApproved({ requestConfirmation: reject });
    const changeId = await proposeIndexChange(invoke);

    const response = (await invoke(IPC_WORKSPACE_APPLY_CHANNEL, {
      changeId,
    })) as WorkspaceChangeResponse;

    expect(response.outcome).toBe('aborted');
    expect(await readFile(indexPath(), 'utf8')).toBe(ORIGINAL_INDEX);
  });

  it('asks for confirmation, and the message states the exact files', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = await setUpApproved({ requestConfirmation });
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('src/index.ts');
    expect(message).toContain('Overwrite');
  });

  it('is recorded as workspace.write, confirmed, with a file count and no path', async () => {
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });

    const record = (await readAuditLines()).find((entry) => entry.actionType === 'workspace.write');
    expect(record?.decision).toBe('confirm');
    expect(record?.confirmationResult).toBe('approved');
    expect(record?.outcome).toBe('success');
    expect(record?.parameters).toEqual({ operation: 'apply', fileCount: 1 });
  });

  it('records a rejected confirmation as aborted', async () => {
    const invoke = await setUpApproved({ requestConfirmation: reject });
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });

    const record = (await readAuditLines()).find((entry) => entry.actionType === 'workspace.write');
    expect(record?.outcome).toBe('aborted');
    expect(record?.confirmationResult).toBe('rejected');
  });

  it('rejects a change id that is not a uuid', async () => {
    const invoke = await setUpApproved();
    await expect(
      invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId: 'src/index.ts' }),
    ).rejects.toThrow();
  });

  it('has no field through which content or a path could be substituted', async () => {
    // The property that makes approval mean something: applying names a
    // change, never a destination or a payload. A renderer compromised
    // between the diff and the approval can re-request what was reviewed; it
    // cannot substitute something else.
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);
    await expect(
      invoke(IPC_WORKSPACE_APPLY_CHANNEL, {
        changeId,
        path: 'src/index.ts',
        content: 'something else entirely\n',
      }),
    ).rejects.toThrow();
    expect(await readFile(indexPath(), 'utf8')).toBe(ORIGINAL_INDEX);
  });
});

describe('workspace:rollback', () => {
  it('restores the previous contents after a confirmation', async () => {
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });
    expect(await readFile(indexPath(), 'utf8')).toBe(CHANGED_INDEX);

    const response = (await invoke(IPC_WORKSPACE_ROLLBACK_CHANNEL, {
      changeId,
    })) as WorkspaceChangeResponse;

    expect(response.outcome).toBe('success');
    expect(await readFile(indexPath(), 'utf8')).toBe(ORIGINAL_INDEX);
  });

  it('restores nothing when the confirmation is rejected', async () => {
    const requestConfirmation = vi
      .fn<(message: string) => Promise<ConfirmationResult>>()
      .mockResolvedValueOnce('approved')
      .mockResolvedValue('rejected');
    const invoke = await setUpApproved({ requestConfirmation });

    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });
    const response = (await invoke(IPC_WORKSPACE_ROLLBACK_CHANNEL, {
      changeId,
    })) as WorkspaceChangeResponse;

    expect(response.outcome).toBe('aborted');
    expect(await readFile(indexPath(), 'utf8')).toBe(CHANGED_INDEX);
  });

  it('is recorded as workspace.rollback with no path', async () => {
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });
    await invoke(IPC_WORKSPACE_ROLLBACK_CHANNEL, { changeId });

    const record = (await readAuditLines()).find(
      (entry) => entry.actionType === 'workspace.rollback',
    );
    expect(record?.decision).toBe('confirm');
    expect(record?.parameters).toEqual({ operation: 'rollback', fileCount: 1 });
  });
});

describe('workspace:changes', () => {
  it('reports the history and what a rollback would target', async () => {
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });

    const response = (await invoke(IPC_WORKSPACE_CHANGES_CHANNEL)) as WorkspaceChangesResponse;
    expect(response.outcome).toBe('success');
    expect(response.history?.rollbackTarget).toBe(changeId);
  });

  it('is a read, and records only the operation', async () => {
    const invoke = await setUpApproved();
    await invoke(IPC_WORKSPACE_CHANGES_CHANNEL);

    const record = (await readAuditLines()).at(-1);
    expect(record?.actionType).toBe('workspace.read');
    expect(record?.parameters).toEqual({ operation: 'changes' });
  });
});

describe('command:list and command:run', () => {
  it('lists every registry command and records only the operation', async () => {
    const invoke = await setUpApproved();
    const response = (await invoke(IPC_COMMAND_LIST_CHANNEL)) as CommandListResponse;

    expect(response.outcome).toBe('success');
    expect(response.catalog?.commands.length).toBe(5);
    // The fixture package.json declares no scripts, so nothing is runnable.
    expect(response.catalog?.commands.every((command) => !command.available)).toBe(true);
    expect((await readAuditLines()).at(-1)?.parameters).toEqual({ operation: 'commands' });
  });

  it('rejects any command identifier outside the registry', async () => {
    const invoke = await setUpApproved();
    for (const commandId of ['install', 'whoami', 'test && whoami', '', 'TEST']) {
      await expect(
        invoke(IPC_COMMAND_RUN_CHANNEL, { runId: randomUUID(), commandId }),
      ).rejects.toThrow();
    }
  });

  it('has no field for a command string, an argument or a directory', async () => {
    const invoke = await setUpApproved();
    for (const extra of [
      { command: 'npm run whatever' },
      { args: ['--help'] },
      { cwd: 'C:\\' },
      { env: { PATH: 'x' } },
      { shell: true },
    ]) {
      await expect(
        invoke(IPC_COMMAND_RUN_CHANNEL, { runId: randomUUID(), commandId: 'test', ...extra }),
      ).rejects.toThrow();
    }
  });

  it('asks for confirmation before running, stating the command and the directory', async () => {
    const requestConfirmation = spyConfirmation('rejected');
    const invoke = await setUpApproved({ requestConfirmation });

    const response = (await invoke(IPC_COMMAND_RUN_CHANNEL, {
      runId: randomUUID(),
      commandId: 'test',
    })) as CommandRunResponse;

    expect(response.outcome).toBe('aborted');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('npm run test');
    expect(message).toContain(projectRoot);
  });

  it('records the command identifier, which is an enum member and not user text', async () => {
    const invoke = await setUpApproved({ requestConfirmation: reject });
    await invoke(IPC_COMMAND_RUN_CHANNEL, { runId: randomUUID(), commandId: 'lint' });

    const record = (await readAuditLines()).find((entry) => entry.actionType === 'command.run');
    expect(record?.decision).toBe('confirm');
    expect(record?.outcome).toBe('aborted');
    expect(record?.parameters).toEqual({ operation: 'run', commandId: 'lint' });
  });

  it('refuses a command the project does not declare, after the confirmation', async () => {
    const invoke = await setUpApproved();
    const response = (await invoke(IPC_COMMAND_RUN_CHANNEL, {
      runId: randomUUID(),
      commandId: 'test',
    })) as CommandRunResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('COMMAND_NOT_AVAILABLE');
  });
});

describe('command:cancel', () => {
  it('acknowledges an unknown run without an error and without an audit record', async () => {
    // Best-effort and idempotent, ungated for the same reason `chat:cancel`
    // is: it cannot start, read or reach anything.
    const invoke = setUp();
    const response = (await invoke(IPC_COMMAND_CANCEL_CHANNEL, {
      runId: randomUUID(),
    })) as CommandCancelResponse;

    expect(response.acknowledged).toBe(true);
    await expect(readAuditLines()).rejects.toThrow();
  });

  it('rejects a run id that is not a uuid', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_COMMAND_CANCEL_CHANNEL, { runId: 'whatever' })).rejects.toThrow();
  });
});

describe('git channels', () => {
  it('refuses git operations on a project with no repository, without confirming', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = await setUpApproved({ requestConfirmation });

    const status = (await invoke(IPC_GIT_STATUS_CHANNEL)) as GitStatusResponse;
    expect(status.outcome).toBe('failure');
    expect(status.errorCode).toBe('GIT_NOT_A_REPOSITORY');
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('records git.read for status, with only the operation', async () => {
    const invoke = await setUpApproved();
    await invoke(IPC_GIT_STATUS_CHANNEL);

    const record = (await readAuditLines()).at(-1);
    expect(record?.actionType).toBe('git.read');
    expect(record?.decision).toBe('allow');
    expect(record?.parameters).toEqual({ operation: 'status' });
  });

  it('records whether a diff was narrowed, never to what', async () => {
    const invoke = await setUpApproved();
    await invoke(IPC_GIT_DIFF_CHANNEL, { path: 'src/index.ts' });

    const record = (await readAuditLines()).at(-1);
    expect(record?.parameters).toEqual({ operation: 'diff', scoped: true });
    expect(JSON.stringify(record)).not.toContain('src/index.ts');
  });

  it('rejects a diff path that escapes the project', async () => {
    const invoke = await setUpApproved();
    await expect(invoke(IPC_GIT_DIFF_CHANNEL, { path: '../escape' })).rejects.toThrow();
  });

  it('asks for confirmation before a checkpoint, stating the exact commands', async () => {
    const requestConfirmation = spyConfirmation('rejected');
    const invoke = await setUpApproved({ requestConfirmation });

    const response = (await invoke(IPC_GIT_CHECKPOINT_CHANNEL)) as GitCheckpointResponse;
    expect(response.outcome).toBe('aborted');

    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('git add --all');
    expect(message).toContain('git commit');
    expect(message).toContain('Nothing is reset, checked out, deleted or pushed');
  });

  it('takes no arguments, so nothing can name a ref, a branch or a message', async () => {
    const invoke = await setUpApproved();
    await expect(invoke(IPC_GIT_CHECKPOINT_CHANNEL, { branch: 'main' })).rejects.toThrow();
    await expect(invoke(IPC_GIT_CHECKPOINT_CHANNEL, { message: 'anything' })).rejects.toThrow();
  });
});

describe('the emergency stop blocks every Milestone 6 channel', () => {
  it('denies every one of them, and asks for no confirmation', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = await setUpApproved({ requestConfirmation });
    const changeId = await proposeIndexChange(invoke);

    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const attempts: [string, unknown][] = [
      [IPC_WORKSPACE_PROPOSE_CHANNEL, { edits: [{ path: 'src/index.ts', content: 'x\n' }] }],
      [IPC_WORKSPACE_APPLY_CHANNEL, { changeId }],
      [IPC_WORKSPACE_ROLLBACK_CHANNEL, { changeId }],
      [IPC_WORKSPACE_CHANGES_CHANNEL, undefined],
      [IPC_COMMAND_LIST_CHANNEL, undefined],
      [IPC_COMMAND_RUN_CHANNEL, { runId: randomUUID(), commandId: 'test' }],
      [IPC_GIT_STATUS_CHANNEL, undefined],
      [IPC_GIT_DIFF_CHANNEL, { path: null }],
      [IPC_GIT_CHECKPOINT_CHANNEL, undefined],
    ];

    for (const [channel, payload] of attempts) {
      const response = (await (payload === undefined
        ? invoke(channel)
        : invoke(channel, payload))) as { outcome: string };
      expect(response.outcome, channel).toBe('denied');
    }

    // A denied action never reaches the confirmation step...
    expect(requestConfirmation).not.toHaveBeenCalled();
    // ...and nothing was written.
    expect(await readFile(indexPath(), 'utf8')).toBe(ORIGINAL_INDEX);
  });
});

describe('no Milestone 6 audit record carries a path, a name or file content', () => {
  it('keeps the project path, the file paths and the proposed content out of the log', async () => {
    const invoke = await setUpApproved();
    const changeId = await proposeIndexChange(invoke);
    await invoke(IPC_WORKSPACE_APPLY_CHANNEL, { changeId });
    await invoke(IPC_WORKSPACE_ROLLBACK_CHANNEL, { changeId });
    await invoke(IPC_COMMAND_LIST_CHANNEL);
    await invoke(IPC_GIT_STATUS_CHANNEL);
    await invoke(IPC_GIT_DIFF_CHANNEL, { path: 'src/index.ts' });

    const serialized = JSON.stringify(await readAuditLines());
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain('src/index.ts');
    expect(serialized).not.toContain('answer = 43');
    expect(serialized).not.toContain(SENTINEL_SECRET);
  });
});
