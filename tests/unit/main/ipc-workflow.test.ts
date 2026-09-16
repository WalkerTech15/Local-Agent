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
  IPC_AGENT_CREATE_CHANNEL,
  IPC_AGENT_SET_ENABLED_CHANNEL,
  IPC_WORKFLOW_CANCEL_CHANNEL,
  IPC_WORKFLOW_CREATE_CHANNEL,
  IPC_WORKFLOW_DELETE_CHANNEL,
  IPC_WORKFLOW_DUPLICATE_CHANNEL,
  IPC_WORKFLOW_LIST_CHANNEL,
  IPC_WORKFLOW_PAUSE_CHANNEL,
  IPC_WORKFLOW_RUN_CHANNEL,
  IPC_WORKFLOW_SET_ENABLED_CHANNEL,
  IPC_WORKFLOW_UPDATE_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
} from '../../../src/shared/schemas';
import type {
  AgentProfileInput,
  WorkflowInput,
  WorkflowListResponse,
  WorkflowRunResponse,
} from '../../../src/shared/schemas';
import type { ConfirmationResult } from '../../../src/shared/types';

/**
 * The workflow channels, end to end through the real pipeline (Phase 2,
 * Milestone 9).
 *
 * The claims this file exists to check, in order of how much they matter:
 *
 *  1. A workflow write and a run are both on the confirmation floor, and the
 *     native dialog states the agent, the steps, the scope and the limits.
 *  2. A workflow can never widen its agent: a step outside the selected
 *     profile's allowlists is refused when saved, and again before it runs.
 *  3. Every step inside a run goes through the permission engine on its own
 *     action type and leaves its own audit record.
 *  4. The emergency stop blocks a run, and blocks it mid-run.
 *  5. A checkpoint step asks natively before it is proposed at all, and
 *     declining one stops the run.
 *  6. The objective and every project path stay out of the audit log.
 *  7. A running workflow cannot be edited or deleted.
 */

const NOW = '2026-09-14T00:00:00.000Z';
const OBJECTIVE = 'review the settings loader for dead configuration';

function createFakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  sent: { channel: string; payload: unknown }[];
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  const event = {
    sender: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  };

  return {
    ipcMain,
    sent,
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
  const { ipcMain, invoke, sent } = createFakeIpcMain();
  registerIpcHandlers(ipcMain, buildRuntime(overrides));
  return { invoke, sent };
}

async function setUpApproved(overrides: Partial<IpcHandlerRuntime> = {}) {
  const harness = setUp({
    selectProjectDirectory: () => Promise.resolve(projectRoot),
    ...overrides,
  });
  await harness.invoke(IPC_WORKSPACE_SELECT_CHANNEL);
  return harness;
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

/** An agent profile that permits the read-only tools these tests use. */
function agentInput(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    id: 'inspector',
    name: 'Inspector',
    description: 'Reads the tree.',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect', 'workspace.plan'],
    approvedWorkspacePaths: [''],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 8, maxDurationMs: 30_000, maxOutputBytes: 20_000 },
    enabled: true,
    ...overrides,
  };
}

function workflowInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    id: 'nightly.check',
    name: 'Nightly check',
    description: 'Looks at the tree.',
    trigger: 'manual',
    agentProfileId: 'inspector',
    steps: [
      {
        tool: 'workspace.inspect',
        target: '',
        query: null,
        condition: 'always',
        maxRetries: 0,
        checkpoint: false,
      },
    ],
    limits: { maxSteps: 8, maxDurationMs: 30_000, maxOutputBytes: 20_000 },
    failureBehavior: 'stop',
    rollback: 'none',
    successCriteria: { verification: [], requireAllStepsSucceed: true },
    enabled: true,
    ...overrides,
  };
}

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

async function seed(
  invoke: Invoke,
  workflow: Partial<WorkflowInput> = {},
  agent: Partial<AgentProfileInput> = {},
): Promise<void> {
  await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: agentInput(agent) });
  await invoke(IPC_WORKFLOW_CREATE_CHANNEL, { workflow: workflowInput(workflow) });
}

function runWorkflow(invoke: Invoke, workflowId = 'nightly.check'): Promise<WorkflowRunResponse> {
  return invoke(IPC_WORKFLOW_RUN_CHANNEL, {
    runId: randomUUID(),
    workflowId,
    objective: OBJECTIVE,
  }) as Promise<WorkflowRunResponse>;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-ipc9-')));
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

  projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-project9-')));
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await writeFile(join(projectRoot, 'src', 'settings.ts'), 'export const answer = 42;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe('workflow:list', () => {
  it('answers with an empty list on a clean install', async () => {
    const { invoke } = setUp();
    const response = (await invoke(IPC_WORKFLOW_LIST_CHANNEL)) as WorkflowListResponse;
    expect(response.outcome).toBe('success');
    expect(response.workflows).toEqual([]);
  });

  it('needs no confirmation, because listing changes nothing', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const { invoke } = setUp({ requestConfirmation });
    await invoke(IPC_WORKFLOW_LIST_CHANNEL);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('carries no credential in any definition it returns', async () => {
    const { invoke } = setUp();
    await seed(invoke);
    const response = (await invoke(IPC_WORKFLOW_LIST_CHANNEL)) as WorkflowListResponse;
    const serialized = JSON.stringify(response);
    for (const field of ['apiKey', 'token', 'password', 'secret']) {
      expect(serialized, field).not.toContain(field);
    }
  });
});

describe('workflow:create / update / delete — the confirmation floor', () => {
  it('asks natively before creating, stating the agent, the steps and the limits', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const { invoke } = setUp({ requestConfirmation });
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: agentInput() });

    const response = (await invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
      workflow: workflowInput(),
    })) as WorkflowListResponse;

    expect(response.outcome).toBe('success');
    const message = requestConfirmation.mock.calls.at(-1)?.[0] ?? '';
    expect(message).toContain('nightly.check');
    expect(message).toContain('inspector');
    expect(message).toContain('workspace.inspect');
    expect(message).toContain('cannot grant a permission');
  });

  it('writes nothing when the confirmation is declined', async () => {
    const { invoke } = setUp({ requestConfirmation: () => Promise.resolve('rejected') });

    const response = (await invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
      workflow: workflowInput(),
    })) as WorkflowListResponse;

    expect(response.outcome).toBe('aborted');
    await expect(readFile(paths.workflowsFile, 'utf8')).rejects.toThrow();
  });

  it('refuses a definition that names a non-manual trigger', async () => {
    const { invoke } = setUp();
    await expect(
      invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
        workflow: { ...workflowInput(), trigger: 'schedule' },
      }),
    ).rejects.toThrow();
  });

  it('duplicates under a new id, disabled, and says so in the dialog', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const { invoke } = setUp({ requestConfirmation });
    await seed(invoke);

    const response = (await invoke(IPC_WORKFLOW_DUPLICATE_CHANNEL, {
      workflowId: 'nightly.check',
      newId: 'nightly.copy',
    })) as WorkflowListResponse;

    expect(response.outcome).toBe('success');
    const copy = response.workflows?.find((entry) => entry.id === 'nightly.copy');
    expect(copy?.enabled).toBe(false);
    expect(requestConfirmation.mock.calls.at(-1)?.[0] ?? '').toContain('created disabled');
  });

  it('enables and disables through the same gated channel', async () => {
    const { invoke } = setUp();
    await seed(invoke);

    const response = (await invoke(IPC_WORKFLOW_SET_ENABLED_CHANNEL, {
      workflowId: 'nightly.check',
      enabled: false,
    })) as WorkflowListResponse;

    expect(response.workflows?.[0]?.enabled).toBe(false);
  });

  it('deletes a workflow that is not running', async () => {
    const { invoke } = setUp();
    await seed(invoke);

    const response = (await invoke(IPC_WORKFLOW_DELETE_CHANNEL, {
      workflowId: 'nightly.check',
    })) as WorkflowListResponse;

    expect(response.workflows).toEqual([]);
  });
});

describe('a workflow can never widen its agent', () => {
  it('refuses a step naming a tool the selected agent does not allow', async () => {
    const { invoke } = setUp();
    await invoke(IPC_AGENT_CREATE_CHANNEL, { profile: agentInput() });

    const response = (await invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
      workflow: workflowInput({
        steps: [
          {
            tool: 'git.status',
            target: '',
            query: null,
            condition: 'always',
            maxRetries: 0,
            checkpoint: false,
          },
        ],
      }),
    })) as WorkflowListResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKFLOW_TOOL_NOT_ALLOWED');
  });

  it('refuses a step naming a path outside the agent scope', async () => {
    const { invoke } = setUp();
    await invoke(IPC_AGENT_CREATE_CHANNEL, {
      profile: agentInput({ approvedWorkspacePaths: ['src'] }),
    });

    const response = (await invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
      workflow: workflowInput({
        steps: [
          {
            tool: 'workspace.inspect',
            target: 'vendor',
            query: null,
            condition: 'always',
            maxRetries: 0,
            checkpoint: false,
          },
        ],
      }),
    })) as WorkflowListResponse;

    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKFLOW_WORKSPACE_NOT_ALLOWED');
  });

  it('refuses a workflow whose agent does not exist', async () => {
    const { invoke } = setUp();
    const response = (await invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
      workflow: workflowInput({ agentProfileId: 'nobody' }),
    })) as WorkflowListResponse;

    expect(response.errorCode).toBe('WORKFLOW_AGENT_NOT_FOUND');
  });

  it('stops a run whose agent was disabled after the workflow was saved', async () => {
    const { invoke } = await setUpApproved();
    await seed(invoke);
    await invoke(IPC_AGENT_SET_ENABLED_CHANNEL, { profileId: 'inspector', enabled: false });

    const response = await runWorkflow(invoke);
    expect(response.outcome).toBe('failure');
    expect(response.errorCode).toBe('WORKFLOW_AGENT_DISABLED');
  });
});

describe('workflow:run', () => {
  it('asks natively before the first step, stating everything the run may do', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const { invoke } = await setUpApproved({ requestConfirmation });
    await seed(invoke);

    const response = await runWorkflow(invoke);
    expect(response.outcome).toBe('success');

    const message = requestConfirmation.mock.calls.at(-1)?.[0] ?? '';
    expect(message).toContain('Nightly check');
    expect(message).toContain('Inspector');
    expect(message).toContain('Ordered steps');
    expect(message).toContain('Time limit');
    expect(message).toContain('cannot start a process, change a file, or create a commit');
  });

  it('runs nothing when the confirmation is declined', async () => {
    const { invoke } = await setUpApproved({
      requestConfirmation: (message: string) =>
        Promise.resolve(message.startsWith('Run the workflow') ? 'rejected' : 'approved'),
    });
    await seed(invoke);

    const response = await runWorkflow(invoke);
    expect(response.outcome).toBe('aborted');
  });

  it('completes a read-only run and records each step', async () => {
    const { invoke } = await setUpApproved();
    await seed(invoke);

    const response = await runWorkflow(invoke);
    expect(response.outcome).toBe('success');
    expect(response.run?.status).toBe('completed');
    expect(response.run?.steps).toHaveLength(1);
    expect(response.run?.steps[0]?.actionType).toBe('workspace.read');
    expect(response.run?.rollback.result).toBe('not-configured');
  });

  it('refuses to run a disabled workflow', async () => {
    const { invoke } = await setUpApproved();
    await seed(invoke, { enabled: false });

    const response = await runWorkflow(invoke);
    expect(response.errorCode).toBe('WORKFLOW_DISABLED');
  });

  it('refuses to run with no approved project', async () => {
    const { invoke } = setUp();
    await seed(invoke);

    const response = await runWorkflow(invoke);
    expect(response.run?.stopReason).toBe('no-project');
    expect(response.run?.status).toBe('failed');
  });

  it('pushes bounded progress events that carry no content', async () => {
    const { invoke, sent } = await setUpApproved();
    await seed(invoke);
    await runWorkflow(invoke);

    const progress = sent.filter((entry) => entry.channel === 'workflow:progress');
    expect(progress.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(progress);
    expect(serialized).not.toContain('settings.ts');
    expect(serialized).not.toContain(OBJECTIVE);
    for (const field of ['summary', 'output', 'path']) {
      expect(serialized, field).not.toContain(`"${field}"`);
    }
  });
});

describe('confirmation checkpoints', () => {
  it('asks again before a checkpoint step, naming the workflow and the step', async () => {
    const requestConfirmation = spyConfirmation('approved');
    const { invoke } = await setUpApproved({ requestConfirmation });
    await seed(invoke, {
      steps: [
        {
          tool: 'workspace.inspect',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: true,
        },
      ],
    });

    await runWorkflow(invoke);

    const messages = requestConfirmation.mock.calls.map((call) => call[0]);
    const checkpoint = messages.find((message) => message.startsWith('Checkpoint in the workflow'));
    expect(checkpoint).toBeDefined();
    expect(checkpoint).toContain('Nightly check');
    expect(checkpoint).toContain('Step:');
    expect(checkpoint).toContain('skips nothing else');
  });

  it('stops the run when a checkpoint is declined', async () => {
    const { invoke } = await setUpApproved({
      requestConfirmation: (message: string) =>
        Promise.resolve(message.startsWith('Checkpoint in the workflow') ? 'rejected' : 'approved'),
    });
    await seed(invoke, {
      steps: [
        {
          tool: 'workspace.inspect',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: true,
        },
        {
          tool: 'workspace.plan',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: false,
        },
      ],
    });

    const response = await runWorkflow(invoke);
    expect(response.run?.stopReason).toBe('step-declined');
    expect(response.run?.status).toBe('denied');
    // The second step never ran: a declined checkpoint ends the run.
    expect(response.run?.steps).toHaveLength(1);
  });
});

describe('the audit trail', () => {
  it('records each step on its own action type, and the run on workflow.run', async () => {
    const { invoke } = await setUpApproved();
    await seed(invoke);
    await runWorkflow(invoke);

    const actionTypes = (await readAuditLines()).map((line) => line.actionType);
    expect(actionTypes).toContain('workflow.run');
    expect(actionTypes).toContain('workspace.read');
  });

  it('records ids and counts, never the objective or a project path', async () => {
    const { invoke } = await setUpApproved();
    await seed(invoke);
    await runWorkflow(invoke);

    const serialized = JSON.stringify(await readAuditLines());
    expect(serialized).toContain('nightly.check');
    expect(serialized).toContain('objectiveLength');
    expect(serialized).not.toContain(OBJECTIVE);
    expect(serialized).not.toContain('settings.ts');
    expect(serialized).not.toContain(projectRoot.replace(/\\/g, '\\\\'));
  });
});

describe('the emergency stop', () => {
  it('blocks a run before it starts', async () => {
    const { invoke } = await setUpApproved();
    await seed(invoke);
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const response = await runWorkflow(invoke);
    expect(response.outcome).toBe('denied');
  });

  it('blocks a workflow write while engaged', async () => {
    const { invoke } = setUp();
    await engageEmergencyStop(paths.emergencyStateFile, NOW);

    const response = (await invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
      workflow: workflowInput(),
    })) as WorkflowListResponse;
    expect(response.outcome).toBe('denied');
  });

  it('stops a run mid-flight, through the permission engine, when the stop is engaged', async () => {
    // Engaging the stop while a step's checkpoint is being answered. The
    // engine refuses that very step — a stronger guarantee than the runner's
    // own between-steps re-read, which is the backstop and is covered
    // directly in `tests/unit/shared/workflow-execution.test.ts`.
    const { invoke } = await setUpApproved({
      requestConfirmation: async (message: string) => {
        if (message.startsWith('Checkpoint in the workflow')) {
          await engageEmergencyStop(paths.emergencyStateFile, NOW);
        }
        return 'approved';
      },
    });
    await seed(invoke, {
      steps: [
        {
          tool: 'workspace.inspect',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: true,
        },
        {
          tool: 'workspace.plan',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: false,
        },
      ],
    });

    const response = await runWorkflow(invoke);
    expect(response.run?.status).toBe('denied');
    expect(response.run?.stopReason).toBe('step-denied');
    expect(response.run?.steps[0]?.outcome).toBe('denied');
    // The second step never ran.
    expect(response.run?.steps).toHaveLength(1);
  });
});

describe('a running workflow is protected', () => {
  it('refuses to edit or delete a workflow while a run of it is in flight', async () => {
    const captured: { edit?: WorkflowListResponse; remove?: WorkflowListResponse } = {};

    const harness = await setUpApproved({
      // The run parks here, inside the checkpoint, while the edit and the
      // delete are attempted.
      requestConfirmation: async (message: string) => {
        if (message.startsWith('Checkpoint in the workflow')) {
          captured.edit = (await harness.invoke(IPC_WORKFLOW_UPDATE_CHANNEL, {
            workflowId: 'nightly.check',
            workflow: workflowInput({ description: 'changed mid-run' }),
          })) as WorkflowListResponse;
          captured.remove = (await harness.invoke(IPC_WORKFLOW_DELETE_CHANNEL, {
            workflowId: 'nightly.check',
          })) as WorkflowListResponse;
        }
        return 'approved';
      },
    });

    await seed(harness.invoke, {
      steps: [
        {
          tool: 'workspace.inspect',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: true,
        },
      ],
    });

    await runWorkflow(harness.invoke);

    expect(captured.edit).toBeDefined();
    expect(captured.edit?.errorCode).toBe('WORKFLOW_RUNNING');
    expect(captured.remove?.errorCode).toBe('WORKFLOW_RUNNING');
  });

  it('refuses a second run while one is in flight', async () => {
    const captured: { second?: WorkflowRunResponse } = {};

    const harness = await setUpApproved({
      requestConfirmation: async (message: string) => {
        if (message.startsWith('Checkpoint in the workflow') && captured.second === undefined) {
          captured.second = await runWorkflow(harness.invoke);
        }
        return 'approved';
      },
    });

    await seed(harness.invoke, {
      steps: [
        {
          tool: 'workspace.inspect',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: true,
        },
      ],
    });

    await runWorkflow(harness.invoke);
    expect(captured.second?.errorCode).toBe('WORKFLOW_RUN_ALREADY_RUNNING');
  });
});

describe('pause and cancel', () => {
  it('acknowledges a pause for an unknown run without failing', async () => {
    const { invoke } = setUp();
    await expect(invoke(IPC_WORKFLOW_PAUSE_CHANNEL, { runId: randomUUID() })).resolves.toEqual({
      acknowledged: true,
    });
  });

  it('acknowledges a cancel for an unknown run without failing', async () => {
    const { invoke } = setUp();
    await expect(invoke(IPC_WORKFLOW_CANCEL_CHANNEL, { runId: randomUUID() })).resolves.toEqual({
      acknowledged: true,
    });
  });

  it('stops the run at the next step boundary when paused', async () => {
    const runId = randomUUID();
    const harness = await setUpApproved({
      requestConfirmation: async (message: string) => {
        if (message.startsWith('Checkpoint in the workflow')) {
          await harness.invoke(IPC_WORKFLOW_PAUSE_CHANNEL, { runId });
        }
        return 'approved';
      },
    });

    await seed(harness.invoke, {
      steps: [
        {
          tool: 'workspace.inspect',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: true,
        },
        {
          tool: 'workspace.plan',
          target: '',
          query: null,
          condition: 'always',
          maxRetries: 0,
          checkpoint: false,
        },
      ],
    });

    const response = (await harness.invoke(IPC_WORKFLOW_RUN_CHANNEL, {
      runId,
      workflowId: 'nightly.check',
      objective: OBJECTIVE,
    })) as WorkflowRunResponse;

    expect(response.run?.stopReason).toBe('paused');
    expect(response.run?.status).toBe('stopped');
    // The step that was already under way still completed and was recorded.
    expect(response.run?.steps).toHaveLength(1);
  });
});

describe('request validation', () => {
  it('refuses an unknown field on a run request', async () => {
    const { invoke } = setUp();
    await expect(
      invoke(IPC_WORKFLOW_RUN_CHANNEL, {
        runId: randomUUID(),
        workflowId: 'nightly.check',
        objective: OBJECTIVE,
        steps: [],
      }),
    ).rejects.toThrow();
  });

  it('refuses a run request that tries to carry its own limits', async () => {
    const { invoke } = setUp();
    await expect(
      invoke(IPC_WORKFLOW_RUN_CHANNEL, {
        runId: randomUUID(),
        workflowId: 'nightly.check',
        objective: OBJECTIVE,
        limits: { maxSteps: 999 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a definition carrying a credential-named field', async () => {
    const { invoke } = setUp();
    await expect(
      invoke(IPC_WORKFLOW_CREATE_CHANNEL, {
        workflow: { ...workflowInput(), apiKey: 'fake-sentinel-not-a-real-key' },
      }),
    ).rejects.toThrow();
  });
});
