import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKFLOW_MAX_WORKFLOWS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STORE_MAX_BYTES,
} from '../../../src/shared/constants';
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  findWorkflow,
  loadWorkflowStore,
  readWorkflows,
  requireWorkflow,
  setWorkflowEnabled,
  updateWorkflow,
  writeWorkflowStore,
} from '../../../src/main/workflow-store';
import { createEmptyWorkflowStore } from '../../../src/shared/schemas/workflow.schema';
import type { WorkflowInput } from '../../../src/shared/schemas/workflow.schema';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-02-01T00:00:00.000Z';

let dir: string;
let storeFile: string;

const nothingRunning = () => false;
const everythingRunning = () => true;

function input(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    id: 'nightly.check',
    name: 'Nightly check',
    description: 'Looks at the tree.',
    trigger: 'manual',
    agentProfileId: 'reviewer',
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
    limits: { maxSteps: 8, maxDurationMs: 60_000, maxOutputBytes: 50_000 },
    failureBehavior: 'stop',
    rollback: 'none',
    successCriteria: { verification: [], requireAllStepsSucceed: true },
    enabled: true,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-workflow-'));
  storeFile = join(dir, 'workflows', 'workflows.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loading fails safe', () => {
  it('returns an empty store when the file does not exist, and creates nothing', async () => {
    expect(await loadWorkflowStore(storeFile)).toEqual(createEmptyWorkflowStore());
    await expect(readdir(join(dir, 'workflows'))).rejects.toThrow();
  });

  it('returns an empty store for malformed JSON', async () => {
    await mkdir(join(dir, 'workflows'), { recursive: true });
    await writeFile(storeFile, '{ not json', 'utf8');
    expect(await loadWorkflowStore(storeFile)).toEqual(createEmptyWorkflowStore());
  });

  it('returns an empty store rather than merging a partly-valid document', async () => {
    await mkdir(join(dir, 'workflows'), { recursive: true });
    const document = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflows: [{ ...input(), createdAt: NOW, updatedAt: NOW }, { id: 'broken' }],
    };
    await writeFile(storeFile, JSON.stringify(document), 'utf8');
    expect((await loadWorkflowStore(storeFile)).workflows).toHaveLength(0);
  });

  it('refuses a document carrying a prototype-polluting key', async () => {
    await mkdir(join(dir, 'workflows'), { recursive: true });
    await writeFile(
      storeFile,
      '{"schemaVersion":1,"workflows":[],"__proto__":{"polluted":true}}',
      'utf8',
    );
    expect(await loadWorkflowStore(storeFile)).toEqual(createEmptyWorkflowStore());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a file larger than the cap', async () => {
    await mkdir(join(dir, 'workflows'), { recursive: true });
    await writeFile(
      storeFile,
      JSON.stringify({ pad: 'x'.repeat(WORKFLOW_STORE_MAX_BYTES + 10) }),
      'utf8',
    );
    expect(await loadWorkflowStore(storeFile)).toEqual(createEmptyWorkflowStore());
  });

  it('refuses a hand-edited definition that names a non-manual trigger', async () => {
    await mkdir(join(dir, 'workflows'), { recursive: true });
    const document = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflows: [{ ...input(), trigger: 'schedule', createdAt: NOW, updatedAt: NOW }],
    };
    await writeFile(storeFile, JSON.stringify(document), 'utf8');
    expect((await loadWorkflowStore(storeFile)).workflows).toHaveLength(0);
  });

  it('reads back a document it wrote', async () => {
    await createWorkflow(storeFile, input(), NOW);
    const workflows = await readWorkflows(storeFile);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe('Nightly check');
  });
});

describe('writing is atomic and validated', () => {
  it('refuses to persist a document the schema rejects', async () => {
    const invalid = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflows: [{ ...input(), trigger: 'cron', createdAt: NOW, updatedAt: NOW }],
    };
    await expect(writeWorkflowStore(storeFile, invalid as never)).rejects.toThrow();
  });

  it('leaves no temporary file behind on success', async () => {
    await createWorkflow(storeFile, input(), NOW);
    const entries = await readdir(join(dir, 'workflows'));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces the previous document rather than appending to it', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await updateWorkflow(
      storeFile,
      'nightly.check',
      input({ name: 'Renamed' }),
      LATER,
      nothingRunning,
    );
    const raw = await readFile(storeFile, 'utf8');
    expect(raw).toContain('Renamed');
    expect(raw).not.toContain('Nightly check');
  });
});

describe('create', () => {
  it('stamps both timestamps', async () => {
    const workflows = await createWorkflow(storeFile, input(), NOW);
    expect(workflows[0]?.createdAt).toBe(NOW);
    expect(workflows[0]?.updatedAt).toBe(NOW);
  });

  it('refuses a duplicate identifier', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await expect(createWorkflow(storeFile, input(), NOW)).rejects.toMatchObject({
      code: 'WORKFLOW_EXISTS',
    });
  });

  it('refuses once the store is full', async () => {
    for (let index = 0; index < WORKFLOW_MAX_WORKFLOWS; index += 1) {
      await createWorkflow(storeFile, input({ id: `flow.${String(index)}` }), NOW);
    }
    await expect(createWorkflow(storeFile, input({ id: 'one.more' }), NOW)).rejects.toMatchObject({
      code: 'WORKFLOW_LIMIT_REACHED',
    });
  });
});

describe('update', () => {
  it('carries createdAt over and moves updatedAt on', async () => {
    await createWorkflow(storeFile, input(), NOW);
    const workflows = await updateWorkflow(
      storeFile,
      'nightly.check',
      input({ description: 'changed' }),
      LATER,
      nothingRunning,
    );
    expect(workflows[0]?.createdAt).toBe(NOW);
    expect(workflows[0]?.updatedAt).toBe(LATER);
    expect(workflows[0]?.description).toBe('changed');
  });

  it('refuses an id mismatch rather than renaming', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await expect(
      updateWorkflow(
        storeFile,
        'nightly.check',
        input({ id: 'other.flow' }),
        LATER,
        nothingRunning,
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVALID' });
  });

  it('refuses an unknown workflow', async () => {
    await expect(
      updateWorkflow(
        storeFile,
        'missing.flow',
        input({ id: 'missing.flow' }),
        LATER,
        nothingRunning,
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
  });

  it('refuses to edit a workflow that is running', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await expect(
      updateWorkflow(storeFile, 'nightly.check', input(), LATER, everythingRunning),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNING' });
  });
});

describe('duplicate', () => {
  it('copies under a new id and disables the copy', async () => {
    await createWorkflow(storeFile, input({ enabled: true }), NOW);
    const workflows = await duplicateWorkflow(storeFile, 'nightly.check', 'nightly.copy', LATER);

    const copy = findWorkflow(workflows, 'nightly.copy');
    expect(copy?.enabled).toBe(false);
    expect(copy?.steps).toEqual(findWorkflow(workflows, 'nightly.check')?.steps);
    expect(copy?.createdAt).toBe(LATER);
  });

  it('refuses a taken identifier', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await expect(
      duplicateWorkflow(storeFile, 'nightly.check', 'nightly.check', LATER),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EXISTS' });
  });
});

describe('delete', () => {
  it('removes one workflow and leaves the rest', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await createWorkflow(storeFile, input({ id: 'other.flow' }), NOW);

    const workflows = await deleteWorkflow(storeFile, 'nightly.check', nothingRunning);
    expect(workflows.map((entry) => entry.id)).toEqual(['other.flow']);
  });

  it('refuses to delete a workflow that is running', async () => {
    await createWorkflow(storeFile, input(), NOW);
    await expect(
      deleteWorkflow(storeFile, 'nightly.check', everythingRunning),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNING' });
    expect(await readWorkflows(storeFile)).toHaveLength(1);
  });

  it('refuses an unknown workflow', async () => {
    await expect(deleteWorkflow(storeFile, 'missing.flow', nothingRunning)).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    });
  });
});

describe('enable and disable', () => {
  it('flips the flag and moves updatedAt on', async () => {
    await createWorkflow(storeFile, input({ enabled: true }), NOW);
    const workflows = await setWorkflowEnabled(storeFile, 'nightly.check', false, LATER);
    expect(workflows[0]?.enabled).toBe(false);
    expect(workflows[0]?.updatedAt).toBe(LATER);
  });

  it('is permitted while a run is in flight, so a run can be stopped without cancelling', async () => {
    await createWorkflow(storeFile, input(), NOW);
    const workflows = await setWorkflowEnabled(storeFile, 'nightly.check', false, LATER);
    expect(workflows[0]?.enabled).toBe(false);
  });
});

describe('reading one workflow', () => {
  it('throws the normalized refusal for an unknown id', async () => {
    await expect(requireWorkflow(storeFile, 'missing.flow')).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    });
  });

  it('answers with the stored definition', async () => {
    await createWorkflow(storeFile, input(), NOW);
    expect((await requireWorkflow(storeFile, 'nightly.check')).id).toBe('nightly.check');
  });
});
