import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcMain, SafeStorage } from 'electron';

import { engageEmergencyStop } from '../../../src/main/emergency';
import { registerIpcHandlers } from '../../../src/main/ipc';
import type { IpcHandlerRuntime } from '../../../src/main/ipc';
import { memoryProjectKey } from '../../../src/main/memory-store';
import type { UserDataPaths } from '../../../src/main/paths';
import {
  AUDIT_LOG_FILE_EXTENSION,
  AUDIT_LOG_FILE_PREFIX,
  MEMORY_SCHEMA_VERSION,
} from '../../../src/shared/constants';
import {
  IPC_MEMORY_ADD_CHANNEL,
  IPC_MEMORY_CLEAR_CHANNEL,
  IPC_MEMORY_DELETE_CHANNEL,
  IPC_MEMORY_EXPORT_CHANNEL,
  IPC_MEMORY_IMPORT_CHANNEL,
  IPC_MEMORY_LIST_CHANNEL,
  IPC_MEMORY_RETRIEVE_CHANNEL,
  IPC_MEMORY_SEARCH_CHANNEL,
  IPC_MEMORY_SET_PINNED_CHANNEL,
  IPC_MEMORY_UPDATE_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
  MEMORY_EXPORT_KIND,
} from '../../../src/shared/schemas';
import type {
  MemoryMutationResponse,
  MemoryQueryResponse,
  MemoryRecordInput,
  MemoryRecordResponse,
  MemoryRetrieveResponse,
} from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

/**
 * The memory channels, end to end through the real pipeline (Phase 2,
 * Milestone 8).
 *
 * The claims this file exists to check, in order of how much they matter:
 *
 *  1. Clearing, exporting and importing are on the confirmation floor, and
 *     the native dialog states the scope and what is about to happen.
 *  2. A record's content, a search query and a file path never reach the
 *     audit log.
 *  3. Project memory is isolated by project and refused with no project.
 *  4. Session memory is never written to disk.
 *  5. Neither the renderer nor an import file can name a file, claim a
 *     record's provenance, or store a credential.
 *  6. The emergency stop blocks memory writes.
 */

const NOW = '2026-09-14T00:00:00.000Z';

/** Obviously fake — never a real credential. See `AGENTS.md` section 4. */
const SENTINEL_KEY = 'sk-fakefakefakefakefakefake';

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
let projectRoot: string;
let otherProjectRoot: string;
let transferDir: string;

function approve(): Promise<ConfirmationResult> {
  return Promise.resolve('approved');
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
    automationSpecialFolder: () => 'C:\\fake\\folder',
    focusMainWindow: () => true,
    nowFn: () => NOW,
    ...overrides,
  };
}

function setUp(overrides: Partial<IpcHandlerRuntime> = {}) {
  const { ipcMain, invoke } = createFakeIpcMain();
  registerIpcHandlers(ipcMain, buildRuntime(overrides));
  return invoke;
}

async function setUpWithProject(
  root: string,
  overrides: Partial<IpcHandlerRuntime> = {},
): Promise<(channel: string, ...args: unknown[]) => Promise<unknown>> {
  const invoke = setUp({ selectProjectDirectory: () => Promise.resolve(root), ...overrides });
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

function memoryInput(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    scope: 'personal',
    category: 'user-preference',
    content: 'Prefers concise answers in French.',
    importance: 3,
    confidence: 90,
    expiresAt: null,
    pinned: false,
    ...overrides,
  };
}

function addMemory(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  overrides: Partial<MemoryRecordInput> = {},
): Promise<MemoryRecordResponse> {
  return invoke(IPC_MEMORY_ADD_CHANNEL, {
    record: memoryInput(overrides),
  }) as Promise<MemoryRecordResponse>;
}

function listMemory(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  scope: 'session' | 'project' | 'personal' = 'personal',
): Promise<MemoryQueryResponse> {
  return invoke(IPC_MEMORY_LIST_CHANNEL, { scope }) as Promise<MemoryQueryResponse>;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-ipc8-')));
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

  projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-project8a-')));
  otherProjectRoot = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-project8b-')));
  transferDir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-transfer8-')));

  for (const root of [projectRoot, otherProjectRoot]) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  }
});

afterEach(async () => {
  for (const path of [dir, projectRoot, otherProjectRoot, transferDir]) {
    await rm(path, { recursive: true, force: true });
  }
});

describe('memory:add / list', () => {
  it('stores a record and reads it back', async () => {
    const invoke = setUp();
    const added = await addMemory(invoke);

    expect(added.outcome).toBe('success');
    expect(added.record?.content).toBe('Prefers concise answers in French.');

    const listed = await listMemory(invoke);
    expect(listed.result?.records).toHaveLength(1);
    expect(listed.result?.total).toBe(1);
  });

  it('stamps the source as "user", whatever the renderer sends', async () => {
    const invoke = setUp();
    const added = await addMemory(invoke);
    expect(added.record?.source).toBe('user');
  });

  it('refuses a payload that tries to declare its own source or id', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_MEMORY_ADD_CHANNEL, {
        record: { ...memoryInput(), source: 'import' },
      }),
    ).rejects.toThrow();
    await expect(
      invoke(IPC_MEMORY_ADD_CHANNEL, {
        record: { ...memoryInput(), id: '11111111-1111-4111-8111-111111111111' },
      }),
    ).rejects.toThrow();
  });

  it('needs no confirmation to save or to read a note', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    await addMemory(invoke);
    await listMemory(invoke);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses content that looks like a credential, and stores nothing', async () => {
    const invoke = setUp();
    const response = await addMemory(invoke, { content: `my key is ${SENTINEL_KEY}` });

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('MEMORY_SECRET_REJECTED');
    await expect(readFile(paths.memoryPersonalFile, 'utf8')).rejects.toThrow();
  });
});

describe('the audit trail carries no private content', () => {
  it('records the operation, the scope and a length — never the note', async () => {
    const invoke = setUp();
    await addMemory(invoke, { content: 'Never mention the Aurora acquisition.' });

    const lines = await readAuditLines();
    const serialized = JSON.stringify(lines);
    expect(serialized).toContain('memory.write');
    expect(serialized).not.toContain('Aurora');
    expect(serialized).toContain('contentLength');
  });

  it('records a search without recording what was searched for', async () => {
    const invoke = setUp();
    await addMemory(invoke);
    await invoke(IPC_MEMORY_SEARCH_CHANNEL, { scope: 'personal', query: 'aurora' });

    const serialized = JSON.stringify(await readAuditLines());
    expect(serialized).toContain('memory.read');
    expect(serialized).not.toContain('aurora');
    expect(serialized).toContain('queryLength');
  });

  it('records an export without recording the file it was written to', async () => {
    const target = join(transferDir, 'export.json');
    const invoke = setUp({ selectMemoryExportFile: () => Promise.resolve(target) });
    await addMemory(invoke);
    await invoke(IPC_MEMORY_EXPORT_CHANNEL, { scope: 'personal' });

    const serialized = JSON.stringify(await readAuditLines());
    expect(serialized).toContain('memory.export');
    expect(serialized).not.toContain('export.json');
    expect(serialized).not.toContain(transferDir.replace(/\\/g, '\\\\'));
  });
});

describe('memory:search and memory:retrieve', () => {
  it('searches only within the addressed scope', async () => {
    const invoke = setUp();
    await addMemory(invoke, { content: 'personal note about the parser' });
    await addMemory(invoke, { scope: 'session', content: 'session note about the parser' });

    const personal = (await invoke(IPC_MEMORY_SEARCH_CHANNEL, {
      scope: 'personal',
      query: 'parser',
    })) as MemoryQueryResponse;
    expect(personal.result?.records).toHaveLength(1);
    expect(personal.result?.records[0]?.scope).toBe('personal');
  });

  it('retrieves a small relevant set across readable scopes', async () => {
    const invoke = setUp();
    await addMemory(invoke, { content: 'the parser is hand written' });
    await addMemory(invoke, { scope: 'session', content: 'parser tests live in tests/' });
    await addMemory(invoke, { content: 'prefers dark chocolate' });

    const response = (await invoke(IPC_MEMORY_RETRIEVE_CHANNEL, {
      objective: 'improve the parser implementation',
    })) as MemoryRetrieveResponse;

    expect(response.outcome).toBe('success');
    expect(response.result?.records).toHaveLength(2);
    const contents = response.result?.records.map((entry) => entry.content) ?? [];
    expect(contents.join(' ')).not.toContain('chocolate');
  });

  it('retrieves without a project approved, skipping the project scope', async () => {
    const invoke = setUp();
    await addMemory(invoke, { content: 'the parser is hand written' });

    const response = (await invoke(IPC_MEMORY_RETRIEVE_CHANNEL, {
      objective: 'improve the parser implementation',
    })) as MemoryRetrieveResponse;

    expect(response.outcome).toBe('success');
    expect(response.result?.records).toHaveLength(1);
  });
});

describe('session memory is never written to disk', () => {
  it('keeps a session note out of every file under the data directory', async () => {
    const invoke = setUp();
    await addMemory(invoke, { scope: 'session', content: 'ephemeral note about Aurora' });

    const listed = await listMemory(invoke, 'session');
    expect(listed.result?.records).toHaveLength(1);

    // Nothing under `memory/` exists at all: the session store has no file.
    await expect(readFile(paths.memoryPersonalFile, 'utf8')).rejects.toThrow();
    const auditText = JSON.stringify(await readAuditLines());
    expect(auditText).not.toContain('Aurora');
  });

  it('starts empty for each registration, so one run never sees another’s', async () => {
    const first = setUp();
    await addMemory(first, { scope: 'session', content: 'from the first run' });
    expect((await listMemory(first, 'session')).result?.records).toHaveLength(1);

    const second = setUp();
    expect((await listMemory(second, 'session')).result?.records).toHaveLength(0);
  });
});

describe('project memory is isolated per project', () => {
  it('refuses a project operation when no project is approved', async () => {
    const invoke = setUp();
    const response = await addMemory(invoke, { scope: 'project', content: 'decision: use zod' });

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('MEMORY_NO_PROJECT');
  });

  it('writes into a file named from a hash of the approved project root', async () => {
    const invoke = await setUpWithProject(projectRoot);
    await addMemory(invoke, { scope: 'project', content: 'decision: use zod everywhere' });

    const expected = join(paths.memoryProjectsDir, `${memoryProjectKey(projectRoot)}.json`);
    const raw = await readFile(expected, 'utf8');
    expect(raw).toContain('use zod everywhere');
    // The project's own path is not in the file name or the document.
    expect(expected).not.toContain('local-agent-project8a');
    expect(raw).not.toContain(projectRoot.replace(/\\/g, '\\\\'));
  });

  it('never shows one project’s notes to another', async () => {
    const first = await setUpWithProject(projectRoot);
    await addMemory(first, { scope: 'project', content: 'note belonging to project A' });

    const second = await setUpWithProject(otherProjectRoot);
    const listed = await listMemory(second, 'project');

    expect(listed.result?.records).toHaveLength(0);
  });

  it('shows the same project’s notes again in a later session', async () => {
    const first = await setUpWithProject(projectRoot);
    await addMemory(first, { scope: 'project', content: 'note belonging to project A' });

    const second = await setUpWithProject(projectRoot);
    const listed = await listMemory(second, 'project');

    expect(listed.result?.records).toHaveLength(1);
    expect(listed.result?.records[0]?.content).toBe('note belonging to project A');
  });
});

describe('memory:update / setPinned / delete', () => {
  it('updates in place, keeping createdAt and source', async () => {
    const invoke = setUp();
    const added = await addMemory(invoke);
    const id = added.record?.id ?? '';

    const updated = (await invoke(IPC_MEMORY_UPDATE_CHANNEL, {
      id,
      record: memoryInput({ content: 'Prefers English after all.' }),
    })) as MemoryRecordResponse;

    expect(updated.outcome).toBe('success');
    expect(updated.record?.content).toBe('Prefers English after all.');
    expect(updated.record?.createdAt).toBe(added.record?.createdAt);
    expect(updated.record?.source).toBe('user');
  });

  it('cannot move a record to another scope by editing it', async () => {
    const invoke = setUp();
    const added = await addMemory(invoke);
    const id = added.record?.id ?? '';

    const moved = (await invoke(IPC_MEMORY_UPDATE_CHANNEL, {
      id,
      record: memoryInput({ scope: 'session' }),
    })) as MemoryRecordResponse;

    expect(moved.outcome).toBe('failure');
    expect(moved.errorCode).toBe('MEMORY_NOT_FOUND');
    expect((await listMemory(invoke, 'personal')).result?.records).toHaveLength(1);
    expect((await listMemory(invoke, 'session')).result?.records).toHaveLength(0);
  });

  it('pins and unpins without a confirmation dialog', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    const added = await addMemory(invoke);

    const pinned = (await invoke(IPC_MEMORY_SET_PINNED_CHANNEL, {
      id: added.record?.id,
      scope: 'personal',
      pinned: true,
    })) as MemoryRecordResponse;

    expect(pinned.record?.pinned).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('deletes one record without a confirmation dialog', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    const added = await addMemory(invoke);

    const deleted = (await invoke(IPC_MEMORY_DELETE_CHANNEL, {
      id: added.record?.id,
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(deleted.summary?.affected).toBe(1);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect((await listMemory(invoke)).result?.records).toHaveLength(0);
  });
});

describe('memory:clear — the confirmation floor', () => {
  it('asks natively, naming the scope and the count', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    await addMemory(invoke);

    const response = (await invoke(IPC_MEMORY_CLEAR_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('success');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('1 record');
    expect(message).toContain('personal memory');
    expect(message).toContain('cannot be undone');
  });

  it('clears nothing when the confirmation is declined', async () => {
    const invoke = setUp({ requestConfirmation: () => Promise.resolve('rejected') });
    await addMemory(invoke);

    const response = (await invoke(IPC_MEMORY_CLEAR_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('aborted');
    expect((await listMemory(invoke)).result?.records).toHaveLength(1);
  });
});

describe('memory:export — the confirmation floor and the native dialog', () => {
  it('asks natively before anything is written', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const target = join(transferDir, 'export.json');
    const invoke = setUp({
      requestConfirmation,
      selectMemoryExportFile: () => Promise.resolve(target),
    });
    await addMemory(invoke);

    const response = (await invoke(IPC_MEMORY_EXPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('success');
    expect(response.summary?.affected).toBe(1);
    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('outside Local Agent');
  });

  it('writes a document carrying no path, project name or machine name', async () => {
    const target = join(transferDir, 'export.json');
    const invoke = await setUpWithProject(projectRoot, {
      selectMemoryExportFile: () => Promise.resolve(target),
    });
    await addMemory(invoke, { scope: 'project', content: 'decision: use zod' });
    await invoke(IPC_MEMORY_EXPORT_CHANNEL, { scope: 'project' });

    const document = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(document.kind).toBe(MEMORY_EXPORT_KIND);
    expect(Object.keys(document).sort()).toEqual([
      'exportedAt',
      'kind',
      'records',
      'schemaVersion',
      'scope',
    ]);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('local-agent-project8a');
    expect(serialized).not.toContain(memoryProjectKey(projectRoot));
  });

  it('writes nothing when the file dialog is dismissed', async () => {
    const invoke = setUp({ selectMemoryExportFile: () => Promise.resolve(null) });
    await addMemory(invoke);

    const response = (await invoke(IPC_MEMORY_EXPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('MEMORY_FILE_SELECTION_CANCELLED');
  });

  it('does not open the file dialog when the confirmation is declined', async () => {
    const selectMemoryExportFile = vi.fn(() => Promise.resolve(join(transferDir, 'export.json')));
    const invoke = setUp({
      requestConfirmation: () => Promise.resolve('rejected'),
      selectMemoryExportFile,
    });
    await addMemory(invoke);

    const response = (await invoke(IPC_MEMORY_EXPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('aborted');
    expect(selectMemoryExportFile).not.toHaveBeenCalled();
  });

  it('takes no path from the renderer', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_MEMORY_EXPORT_CHANNEL, { scope: 'personal', path: join(transferDir, 'x.json') }),
    ).rejects.toThrow();
  });
});

describe('memory:import — untrusted content', () => {
  async function writeImportFile(document: unknown): Promise<string> {
    const source = join(transferDir, 'import.json');
    await writeFile(source, JSON.stringify(document), 'utf8');
    return source;
  }

  function exportDocument(records: readonly unknown[], scope = 'personal') {
    return {
      kind: MEMORY_EXPORT_KIND,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      exportedAt: NOW,
      scope,
      records,
    };
  }

  function importableRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'personal',
      category: 'user-preference',
      content: 'an imported preference',
      source: 'user',
      importance: 3,
      confidence: 80,
      expiresAt: null,
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('asks natively, then imports and relabels the records', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const source = await writeImportFile(exportDocument([importableRecord()]));
    const invoke = setUp({
      requestConfirmation,
      selectMemoryImportFile: () => Promise.resolve(source),
    });

    const response = (await invoke(IPC_MEMORY_IMPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('success');
    expect(response.summary?.affected).toBe(1);
    expect(requestConfirmation.mock.calls[0]?.[0] ?? '').toContain('untrusted');

    const listed = await listMemory(invoke);
    expect(listed.result?.records[0]?.source).toBe('import');
    expect(listed.result?.records[0]?.id).not.toBe('22222222-2222-4222-8222-222222222222');
  });

  it('refuses a file that is merely valid JSON', async () => {
    const source = await writeImportFile({ name: 'package', version: '1.0.0' });
    const invoke = setUp({ selectMemoryImportFile: () => Promise.resolve(source) });

    const response = (await invoke(IPC_MEMORY_IMPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('MEMORY_IMPORT_INVALID');
  });

  it('refuses a file carrying a prototype-polluting key', async () => {
    const source = join(transferDir, 'import.json');
    await writeFile(
      source,
      '{"kind":"local-agent-memory-export","schemaVersion":1,"exportedAt":"2026-09-14T00:00:00.000Z","scope":"personal","records":[],"__proto__":{"polluted":true}}',
      'utf8',
    );
    const invoke = setUp({ selectMemoryImportFile: () => Promise.resolve(source) });

    const response = (await invoke(IPC_MEMORY_IMPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('MEMORY_IMPORT_INVALID');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses individual imported records that look like credentials', async () => {
    const source = await writeImportFile(
      exportDocument([
        importableRecord({ content: 'a fine preference' }),
        importableRecord({
          id: '33333333-3333-4333-8333-333333333333',
          content: `token ${SENTINEL_KEY}`,
        }),
      ]),
    );
    const invoke = setUp({ selectMemoryImportFile: () => Promise.resolve(source) });

    const response = (await invoke(IPC_MEMORY_IMPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.summary).toEqual({ scope: 'personal', affected: 1, rejected: 1 });
    const raw = await readFile(paths.memoryPersonalFile, 'utf8');
    expect(raw).not.toContain(SENTINEL_KEY);
  });

  it('refuses a record claiming a source no writer can produce', async () => {
    const source = await writeImportFile(exportDocument([importableRecord({ source: 'model' })]));
    const invoke = setUp({ selectMemoryImportFile: () => Promise.resolve(source) });

    const response = (await invoke(IPC_MEMORY_IMPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.errorCode).toBe('MEMORY_IMPORT_INVALID');
  });

  it('does not open the file dialog when the confirmation is declined', async () => {
    const selectMemoryImportFile = vi.fn(() => Promise.resolve(null));
    const invoke = setUp({
      requestConfirmation: () => Promise.resolve('rejected'),
      selectMemoryImportFile,
    });

    const response = (await invoke(IPC_MEMORY_IMPORT_CHANNEL, {
      scope: 'personal',
    })) as MemoryMutationResponse;

    expect(response.outcome).toBe('aborted');
    expect(selectMemoryImportFile).not.toHaveBeenCalled();
  });
});

describe('the emergency stop', () => {
  it('blocks a memory write while engaged', async () => {
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    const invoke = setUp();

    const response = await addMemory(invoke);
    expect(response.outcome).toBe('denied');
  });

  it('blocks a clear, an export and an import while engaged', async () => {
    await engageEmergencyStop(paths.emergencyStateFile, NOW);
    const invoke = setUp();

    for (const channel of [
      IPC_MEMORY_CLEAR_CHANNEL,
      IPC_MEMORY_EXPORT_CHANNEL,
      IPC_MEMORY_IMPORT_CHANNEL,
    ]) {
      const response = (await invoke(channel, { scope: 'personal' })) as MemoryMutationResponse;
      expect(response.outcome, channel).toBe('denied');
    }
  });
});

describe('request validation', () => {
  it('refuses an unknown scope', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_MEMORY_LIST_CHANNEL, { scope: 'global' })).rejects.toThrow();
  });

  it('refuses an unknown field on any memory request', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_MEMORY_LIST_CHANNEL, { scope: 'personal', includeExpired: true }),
    ).rejects.toThrow();
  });

  it('refuses a record carrying a credential-named field', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_MEMORY_ADD_CHANNEL, { record: { ...memoryInput(), apiKey: SENTINEL_KEY } }),
    ).rejects.toThrow();
  });
});
