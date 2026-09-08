import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodingPlan, gatherPlanObservations } from '../../../src/main/workspace-planner';
import { adoptProjectDirectory, type ApprovedProject } from '../../../src/main/workspace-session';
import { codingPlanSchema } from '../../../src/shared/schemas/workspace.schema';
import { WORKSPACE_PLAN_MAX_FILES } from '../../../src/shared/constants';

/**
 * The planning layer against a real project (Phase 2, Milestone 5).
 *
 * The plan's *content* is exercised purely in
 * `tests/unit/shared/workspace-plan.test.ts`; what matters here is that the
 * observations it rests on are measured from a real directory, that the
 * inspection stays inside it, and — the milestone's central claim — that
 * producing a plan changes nothing on disk.
 */

const NOW = '2026-09-07T00:00:00.000Z';

let dir: string;
let root: string;
let project: ApprovedProject;

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = join(root, ...relativePath.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-wsplan-')));
  root = join(dir, 'demo');
  await mkdir(root, { recursive: true });

  await write('package.json', '{"name":"demo"}\n');
  await write('README.md', '# Demo\n');
  await write('src/retry.ts', 'export function retry() {\n  return true;\n}\n');
  await write('src/chat/send.ts', 'export function send() {\n  // retry here\n}\n');
  await write('src/unrelated.ts', 'export const colour = "blue";\n');
  await write('node_modules/pkg/retry.js', 'module.exports = "retry";\n');
  await write('.env', 'API_KEY=fake-sentinel\n');

  project = await adoptProjectDirectory({
    chosenPath: root,
    now: NOW,
    userDataDir: join(dir, 'Local-Agent'),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gatherPlanObservations', () => {
  it('identifies files that mention the objective, ranked by how many terms matched', async () => {
    const observations = await gatherPlanObservations(project, 'Add retry to the chat send path');
    const paths = observations.files.map((file) => file.path);
    expect(paths).toContain('src/retry.ts');
    expect(paths).toContain('src/chat/send.ts');
    expect(observations.filesInspected).toBeGreaterThan(0);
  });

  it('identifies a file from its path even when its contents do not mention the term', async () => {
    await write('src/onboarding/Form.tsx', 'export const Form = () => null;\n');
    const observations = await gatherPlanObservations(project, 'Improve the onboarding form');
    expect(observations.files.map((file) => file.path)).toContain('src/onboarding/Form.tsx');
  });

  it('never identifies a file in an excluded directory or a credential file', async () => {
    const observations = await gatherPlanObservations(project, 'Add retry everywhere');
    for (const file of observations.files) {
      expect(file.path.startsWith('node_modules/')).toBe(false);
      expect(file.path).not.toBe('.env');
    }
  });

  it('reports the project context it measured', async () => {
    const observations = await gatherPlanObservations(project, 'Add retry');
    expect(observations.projectName).toBe('demo');
    expect(observations.markers).toContain('package.json');
    expect(observations.hasTestTooling).toBe(true);
    expect(observations.hasGitMetadata).toBe(false);
  });

  it('identifies nothing when the objective has no distinctive terms', async () => {
    const observations = await gatherPlanObservations(project, 'do it for me');
    expect(observations.files).toEqual([]);
    expect(observations.filesInspected).toBe(0);
  });

  it('never lists more files than the plan can hold', async () => {
    for (let index = 0; index < WORKSPACE_PLAN_MAX_FILES + 15; index += 1) {
      await write(`src/generated/retry${String(index)}.ts`, 'export const retry = 1;\n');
    }
    const observations = await gatherPlanObservations(project, 'retry');
    expect(observations.files.length).toBeLessThanOrEqual(WORKSPACE_PLAN_MAX_FILES);
  });
});

describe('createCodingPlan', () => {
  it('produces a schema-valid plan grounded in the real project', async () => {
    const plan = await createCodingPlan(project, 'Add retry to the chat send path', NOW);
    expect(codingPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.context.projectName).toBe('demo');
    expect(plan.generatedAt).toBe(NOW);
    expect(plan.relevantFiles.map((file) => file.path)).toContain('src/retry.ts');
  });

  it('always awaits approval and never carries a diff, whatever it found', async () => {
    for (const objective of ['Add retry to chat send', 'do it for me', 'refactor everything']) {
      const plan = await createCodingPlan(project, objective, NOW);
      expect(plan.approvalRequired).toBe(true);
      expect(plan.status).toBe('awaiting-approval');
      expect(plan.diff).toBeNull();
      for (const change of plan.expectedChanges) {
        expect(change.changeType).toBe('review');
      }
    }
  });

  it('is deterministic for the same project and objective', async () => {
    const first = await createCodingPlan(project, 'Add retry to chat send', NOW);
    const second = await createCodingPlan(project, 'Add retry to chat send', NOW);
    expect(first).toEqual(second);
  });

  it('changes nothing on disk', async () => {
    const before = await readFile(join(root, 'src', 'retry.ts'), 'utf8');
    const envBefore = await readFile(join(root, '.env'), 'utf8');

    await createCodingPlan(project, 'Rewrite retry.ts entirely and delete the env file', NOW);

    expect(await readFile(join(root, 'src', 'retry.ts'), 'utf8')).toBe(before);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(envBefore);
  });

  it('never echoes the contents of a credential file into the plan', async () => {
    const plan = await createCodingPlan(project, 'Read the API key from the env file', NOW);
    expect(JSON.stringify(plan)).not.toContain('fake-sentinel');
  });

  it('carries no absolute path, only project-relative ones', async () => {
    const plan = await createCodingPlan(project, 'Add retry to chat send', NOW);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(dir);
  });
});
