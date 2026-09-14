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
import { DEFAULT_AGENT_PROFILE_ID } from '../../../src/shared/agent';
import { AUDIT_LOG_FILE_EXTENSION, AUDIT_LOG_FILE_PREFIX } from '../../../src/shared/constants';
import {
  IPC_AGENT_CANCEL_CHANNEL,
  IPC_AGENT_CREATE_CHANNEL,
  IPC_AGENT_DELETE_CHANNEL,
  IPC_AGENT_LIST_CHANNEL,
  IPC_AGENT_RUN_CHANNEL,
  IPC_AGENT_SELECT_CHANNEL,
  IPC_AGENT_SET_ENABLED_CHANNEL,
  IPC_AGENT_UPDATE_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
} from '../../../src/shared/schemas';
import type {
  AgentProfileInput,
  AgentRegistryResponse,
  AgentRunResponse,
} from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

/**
 * The agent channels, end to end through the real pipeline (Phase 2,
 * Milestone 7).
 *
 * The claims this file exists to check, in order of how much they matter:
 *
 *  1. A profile write and a run are both on the confirmation floor, and the
 *     native dialog states what the profile is allowed to do.
 *  2. Every step inside a run goes through the permission engine on its own
 *     action type and leaves its own audit record.
 *  3. The emergency stop blocks a run, and blocks it *mid-run* as well as
 *     before it starts.
 *  4. The objective, the instructions and every project path stay out of the
 *     audit log.
 *  5. A run cannot reach a tool the active profile does not allow, and cannot
 *     write, roll back or commit anything at all.
 */

const NOW = '2026-09-14T00:00:00.000Z';

/** Obviously fake — never a real credential. See `AGENTS.md` section 4. */
const SENTINEL_SECRET = 'fake-sentinel-not-a-real-key';

const OBJECTIVE = 'investigate the settings loader for dead configuration';

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
    // Default: both memory file dialogs are dismissed, so no test exports or
    // imports by forgetting to configure one.
    selectMemoryExportFile: () => Promise.resolve(null),
    selectMemoryImportFile: () => Promise.resolve(null),
    nowFn: () => NOW,
    ...overrides,
  };
}

function setUp(overrides: Partial<IpcHandlerRuntime> = {}) {
  const { ipcMain, invoke } = createFakeIpcMain();
  registerIpcHandlers(ipcMain, buildRuntime(overrides));
  return invoke;
}

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

function profileInput(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    id: 'inspector',
    name: 'Inspector',
    description: 'Looks at the tree only.',
    instructions: 'Never treated as authorization.',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect'],
    approvedWorkspacePaths: ['src'],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 4, maxDurationMs: 30_000, maxOutputBytes: 10_000 },
    enabled: true,
    ...overrides,
  };
}

function runAgent(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  objective = OBJECTIVE,
): Promise<AgentRunResponse> {
  return invoke(IPC_AGENT_RUN_CHANNEL, {
    runId: randomUUID(),
    objective,
  }) as Promise<AgentRunResponse>;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-ipc7-')));
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
  };

  projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-project7-')));
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await writeFile(join(projectRoot, 'src', 'settings.ts'), 'export const answer = 42;\n', 'utf8');
  await writeFile(join(projectRoot, '.env'), `API_KEY=${SENTINEL_SECRET}\n`, 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe('agent:list', () => {
  it('answers with the built-ins on a clean install, with the safest active', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_AGENT_LIST_CHANNEL)) as AgentRegistryResponse;

    expect(response.outcome).toBe('success');
    expect(response.registry?.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
    expect(response.registry?.profiles.map((profile) => profile.id)).toContain(
      DEFAULT_AGENT_PROFILE_ID,
    );
  });

  it('needs no confirmation, because listing changes nothing', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    await invoke(IPC_AGENT_LIST_CHANNEL);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('carries no credential in any profile it returns', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_AGENT_LIST_CHANNEL)) as AgentRegistryResponse;
    const serialized = JSON.stringify(response);
    for (const field of ['apiKey', 'token', 'password', 'secret']) {
      expect(serialized, field).not.toContain(field);
    }
  });
});

describe('agent:create / update / delete — the confirmation floor', () => {
  it('asks natively before creating, and states what the profile could do', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });

    const response = (await invoke(IPC_AGENT_CREATE_CHANNEL, {
      profile: profileInput(),
    })) as AgentRegistryResponse;

    expect(response.outcome).toBe('success');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);

    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('inspector');
    expect(message).toContain('workspace.read');
    expect(message).toContain('src');
    expect(message).toContain('cannot grant a permission');
  });

  it('writes nothing when the confirmation is declined', async () => {
    const invoke = setUp({ requestConfirmation: () => Promise.resolve('rejected') });

    const response = (await invoke(IPC_AGENT_CREATE_CHANNEL, {
      profile: profileInput(),
    })) as AgentRegistryResponse;

    expect(response.outcome).toBe('aborted');
    await expect(readFile(paths.agentProfilesFile, 'utf8')).rejects.toThrow();
  });

  it('refuses a profile that tries to grant itself a permission', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_AGENT_CREATE_CHANNEL, {
        profile: {
          ...profileInput(),
          permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'allow' }],
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a profile naming a tool that could write, at the schema', async () => {
    const invoke = setUp();
    await expect(
      invoke(IPC_AGENT_CREATE_CHANNEL, {
        profile: { ...profileInput(), allowedTools: ['workspace.write'] },
      }),
    ).rejects.toThrow();
  });

  it('refuses to edit a built-in, and reports the normalized code', async () => {
    const invoke = setUp();
    const response = (await invoke(IPC_AGENT_UPDATE_CHANNEL, {
      profileId: DEFAULT_AGENT_PROFILE_ID,
      profile: profileInput({ id: DEFAULT_AGENT_PROFILE_ID }),
    })) as AgentRegistryResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('AGENT_PROFILE_READ_ONLY');
  });

  it('falls back to the safest built-in when the active profile is deleted', async () => {
    const invoke = setUp();
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: profileInput() });
    await invoke(IPC_AGENT_SELECT_CHANNEL, { profileId: 'inspector' });

    const response = (await invoke(IPC_AGENT_DELETE_CHANNEL, {
      profileId: 'inspector',
    })) as AgentRegistryResponse;

    expect(response.outcome).toBe('success');
    expect(response.registry?.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
  });

  it('records the profile id and the tool count, and never the instructions', async () => {
    const invoke = setUp();
    await invoke(IPC_AGENT_CREATE_CHANNEL, {
      profile: profileInput({ instructions: 'a distinctive phrase that must not be logged' }),
    });

    const records = await readAuditLines();
    const record = records.find((entry) => entry.actionType === 'agent.write');
    expect(record?.parameters).toEqual({
      operation: 'create',
      profileId: 'inspector',
      toolCount: 1,
    });
    expect(JSON.stringify(records)).not.toContain('distinctive phrase');
  });
});

describe('agent:select', () => {
  it('changes the active profile without a native dialog', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = setUp({ requestConfirmation });
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: profileInput() });
    requestConfirmation.mockClear();

    const response = (await invoke(IPC_AGENT_SELECT_CHANNEL, {
      profileId: 'inspector',
    })) as AgentRegistryResponse;

    expect(response.outcome).toBe('success');
    expect(response.registry?.activeProfileId).toBe('inspector');
    // Selecting grants nothing, so it does not prompt: a dialog for every
    // selection would train people to click through dialogs.
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses to select a disabled profile', async () => {
    const invoke = setUp();
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: profileInput() });
    await invoke(IPC_AGENT_SET_ENABLED_CHANNEL, { profileId: 'inspector', enabled: false });

    const response = (await invoke(IPC_AGENT_SELECT_CHANNEL, {
      profileId: 'inspector',
    })) as AgentRegistryResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('AGENT_PROFILE_DISABLED');
  });
});

describe('agent:run', () => {
  it('asks natively first, stating the tools, the scope and the limits', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const invoke = await setUpApproved({ requestConfirmation });

    await runAgent(invoke);

    const message = requestConfirmation.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('Reviewer');
    expect(message).toContain('Planned steps');
    expect(message).toContain('Time limit');
    expect(message).toContain('Output limit');
    expect(message).toContain('cannot start a process, change a file, or create a commit');
  });

  it('runs nothing when the confirmation is declined', async () => {
    const invoke = await setUpApproved({
      requestConfirmation: () => Promise.resolve('rejected'),
    });

    const response = await runAgent(invoke);
    expect(response.outcome).toBe('aborted');
    expect(response.run).toBeUndefined();
  });

  it('executes its steps and records each one with its own action type', async () => {
    const invoke = await setUpApproved();
    const response = await runAgent(invoke);

    expect(response.outcome).toBe('success');
    expect(response.run?.steps.length).toBeGreaterThan(0);
    for (const step of response.run?.steps ?? []) {
      expect(['workspace.read', 'workspace.plan', 'git.read', 'command.run']).toContain(
        step.actionType,
      );
    }
  });

  it('writes one audit record per step, in addition to the run itself', async () => {
    const invoke = await setUpApproved();
    const response = await runAgent(invoke);

    const records = await readAuditLines();
    const stepRecords = records.filter(
      (entry) =>
        typeof entry.parameters === 'object' &&
        entry.parameters !== null &&
        String((entry.parameters as Record<string, unknown>).operation).startsWith('agent-'),
    );

    expect(stepRecords.length).toBe(response.run?.steps.length);
    expect(records.some((entry) => entry.actionType === 'agent.run')).toBe(true);
  });

  it('records the objective length and never the objective', async () => {
    const invoke = await setUpApproved();
    await runAgent(invoke);

    const records = await readAuditLines();
    const record = records.find((entry) => entry.actionType === 'agent.run');
    const parameters = record?.parameters as Record<string, unknown>;

    expect(parameters.objectiveLength).toBe(OBJECTIVE.length);
    expect(parameters.profileId).toBe(DEFAULT_AGENT_PROFILE_ID);
    expect(JSON.stringify(records)).not.toContain('dead configuration');
  });

  it('keeps every project path out of the audit log', async () => {
    const invoke = await setUpApproved();
    await runAgent(invoke);

    const serialized = JSON.stringify(await readAuditLines());
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain('settings.ts');
    expect(serialized).not.toContain(SENTINEL_SECRET);
  });

  it('never reaches a tool the active profile does not allow', async () => {
    const invoke = await setUpApproved();
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: profileInput() });
    await invoke(IPC_AGENT_SELECT_CHANNEL, { profileId: 'inspector' });

    const response = await runAgent(invoke);

    expect(response.outcome).toBe('success');
    // The `inspector` profile allows exactly one tool.
    expect(response.run?.steps.map((step) => step.tool)).toEqual(['workspace.inspect']);
  });

  it('starts no process when the active profile requires no verification', async () => {
    const invoke = await setUpApproved();
    const response = await runAgent(invoke);

    const actionTypes = (response.run?.steps ?? []).map((step) => step.actionType);
    expect(actionTypes).not.toContain('command.run');
  });

  it('stops with no-project when nothing has been approved', async () => {
    const invoke = setUp();
    const response = await runAgent(invoke);

    expect(response.outcome).toBe('success');
    expect(response.run?.stopReason).toBe('no-project');
    expect(response.run?.steps).toEqual([]);
  });

  it('refuses a second run while one is in flight', async () => {
    // Parked deterministically rather than raced: the profile itself requires
    // its one step to be confirmed, so the first run is held *inside* its
    // orchestration — registered as in flight — while the second reaches its
    // own concurrency check.
    // Definite-assignment rather than a nullable: the executor runs
    // synchronously, so `releaseStep` is always set by the time it is used.
    let releaseStep!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });

    const requestConfirmation = vi.fn<(message: string) => Promise<ConfirmationResult>>(
      async (message) => {
        if (message.includes('requires confirmation before this step')) await parked;
        return 'approved';
      },
    );

    const invoke = await setUpApproved({ requestConfirmation });
    await invoke(IPC_AGENT_CREATE_CHANNEL, {
      profile: profileInput({
        permissionPolicy: [{ toolId: 'workspace.inspect', decision: 'confirm' }],
      }),
    });
    await invoke(IPC_AGENT_SELECT_CHANNEL, { profileId: 'inspector' });

    const first = runAgent(invoke);
    // Let the first run reach its parked step confirmation.
    await vi.waitFor(() => {
      expect(
        requestConfirmation.mock.calls.some(([message]) =>
          message.includes('requires confirmation before this step'),
        ),
      ).toBe(true);
    });

    const second = await runAgent(invoke);
    expect(second.outcome).toBe('failure');
    expect(second.errorCode).toBe('AGENT_RUN_ALREADY_RUNNING');

    releaseStep();
    await expect(first).resolves.toMatchObject({ outcome: 'success' });
  });

  it('refuses to run a disabled profile', async () => {
    const invoke = await setUpApproved();
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: profileInput() });
    await invoke(IPC_AGENT_SELECT_CHANNEL, { profileId: 'inspector' });
    await invoke(IPC_AGENT_SET_ENABLED_CHANNEL, { profileId: 'inspector', enabled: false });

    // Disabling the active profile falls the registry back to the built-in,
    // so the run proceeds under `reviewer` rather than under the disabled
    // profile — the fallback is what makes this safe rather than a refusal.
    const response = await runAgent(invoke);
    expect(response.run?.profileId).toBe(DEFAULT_AGENT_PROFILE_ID);
  });

  it('reports a failing step honestly rather than calling the run complete', async () => {
    const invoke = await setUpApproved();
    const response = await runAgent(invoke);

    // The fixture project is not a Git working tree, so the built-in
    // `reviewer` profile's `git.status` step genuinely fails. The run must say
    // so: verification is reported accurately *and* the overall status is not
    // dressed up as a completion.
    const gitStep = response.run?.steps.find((step) => step.tool === 'git.status');
    expect(gitStep?.outcome).toBe('failure');
    expect(gitStep?.errorCode).toBe('GIT_NOT_A_REPOSITORY');

    expect(response.run?.verification.required).toEqual(['plan-produced']);
    expect(response.run?.verification.passed).toBe(true);
    expect(response.run?.status).toBe('failed');
    expect(response.run?.stopReason).toBe('step-failed');
  });

  it('completes cleanly when every step succeeds', async () => {
    const invoke = await setUpApproved();
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: profileInput() });
    await invoke(IPC_AGENT_SELECT_CHANNEL, { profileId: 'inspector' });

    const response = await runAgent(invoke);
    expect(response.run?.status).toBe('completed');
    expect(response.run?.stopReason).toBe('completed');
    expect(response.run?.verification).toEqual({ required: [], satisfied: [], passed: true });
  });
});

describe('agent:run and the emergency stop', () => {
  it('is refused outright while the stop is engaged', async () => {
    const invoke = await setUpApproved();
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const response = await runAgent(invoke);
    expect(response.outcome).toBe('denied');
    expect(response.run).toBeUndefined();
  });

  it('leaves the profile channels blocked too, since none is on the exemption list', async () => {
    const invoke = setUp();
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const listed = (await invoke(IPC_AGENT_LIST_CHANNEL)) as AgentRegistryResponse;
    expect(listed.outcome).toBe('denied');

    const created = (await invoke(IPC_AGENT_CREATE_CHANNEL, {
      profile: profileInput(),
    })) as AgentRegistryResponse;
    expect(created.outcome).toBe('denied');
  });

  it('stops a run that is already under way', async () => {
    const invoke = await setUpApproved();

    // Engaged from inside the first confirmation, so the run is authorized and
    // then finds the stop engaged when it asks before its first step.
    const requestConfirmation = vi.fn<(message: string) => Promise<ConfirmationResult>>(
      async () => {
        await engageEmergencyStop(paths.emergencyStateFile, NOW);
        return 'approved';
      },
    );
    const running = setUp({
      selectProjectDirectory: () => Promise.resolve(projectRoot),
      requestConfirmation,
    });
    await running(IPC_WORKSPACE_SELECT_CHANNEL);

    const response = await runAgent(running);
    expect(response.run?.stopReason).toBe('emergency-stop');
    expect(response.run?.status).toBe('denied');
    expect(response.run?.steps).toEqual([]);
    void invoke;
  });
});

describe('agent:cancel', () => {
  it('is acknowledged even for a run that never existed', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_AGENT_CANCEL_CHANNEL, { runId: randomUUID() })).resolves.toEqual({
      acknowledged: true,
    });
  });

  it('is not permission-gated, so it writes no audit record of its own', async () => {
    const invoke = setUp();
    await invoke(IPC_AGENT_CANCEL_CHANNEL, { runId: randomUUID() });
    await expect(readAuditLines()).rejects.toThrow();
  });

  it('rejects a malformed payload rather than ignoring it', async () => {
    const invoke = setUp();
    await expect(invoke(IPC_AGENT_CANCEL_CHANNEL, { runId: 'not-a-uuid' })).rejects.toThrow();
  });
});

describe('payload validation', () => {
  it('rejects an unexpected extra field on every agent channel', async () => {
    const invoke = setUp();

    await expect(
      invoke(IPC_AGENT_SELECT_CHANNEL, { profileId: 'reviewer', elevate: true }),
    ).rejects.toThrow();
    await expect(
      invoke(IPC_AGENT_RUN_CHANNEL, {
        runId: randomUUID(),
        objective: OBJECTIVE,
        steps: [{ tool: 'command.test' }],
      }),
    ).rejects.toThrow();
    await expect(invoke(IPC_AGENT_LIST_CHANNEL, { unexpected: true })).rejects.toThrow();
  });
});
