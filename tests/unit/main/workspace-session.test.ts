import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adoptProjectDirectory,
  createWorkspaceSession,
  requireApprovedProject,
  toProjectSummary,
} from '../../../src/main/workspace-session';
import { workspaceProjectSummarySchema } from '../../../src/shared/schemas/workspace.schema';
import { WorkspaceError } from '../../../src/shared/workspace/errors';

const NOW = '2026-09-07T00:00:00.000Z';

let dir: string;
let userDataDir: string;
let project: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-wssession-')));
  userDataDir = join(dir, 'Local-Agent');
  project = join(dir, 'demo-project');
  await mkdir(userDataDir, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function adopt(chosenPath: string) {
  return adoptProjectDirectory({ chosenPath, now: NOW, userDataDir });
}

async function expectInvalidProject(chosenPath: string): Promise<void> {
  await expect(adopt(chosenPath)).rejects.toBeInstanceOf(WorkspaceError);
  await adopt(chosenPath).then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => {
      expect((error as WorkspaceError).code).toBe('WORKSPACE_INVALID_PROJECT');
    },
  );
}

describe('createWorkspaceSession', () => {
  it('starts with no approved project', () => {
    expect(createWorkspaceSession().get()).toBeNull();
  });

  it('holds one project and can forget it', async () => {
    const session = createWorkspaceSession();
    const approved = await adopt(project);
    session.set(approved);
    expect(session.get()).toBe(approved);
    session.clear();
    expect(session.get()).toBeNull();
  });

  it('gives each session its own state, so one never leaks into another', async () => {
    const first = createWorkspaceSession();
    const second = createWorkspaceSession();
    first.set(await adopt(project));
    expect(second.get()).toBeNull();
  });

  it('requireApprovedProject throws the normalized code when nothing is approved', () => {
    const session = createWorkspaceSession();
    expect(() => requireApprovedProject(session)).toThrow(WorkspaceError);
    try {
      requireApprovedProject(session);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('WORKSPACE_NO_PROJECT');
    }
  });
});

describe('adoptProjectDirectory — acceptance', () => {
  it('canonicalises the path and takes the directory name', async () => {
    const approved = await adopt(project);
    expect(approved.rootPath).toBe(project);
    expect(approved.name).toBe('demo-project');
    expect(approved.selectedAt).toBe(NOW);
  });

  it('detects project markers by presence, without reading them', async () => {
    await writeFile(join(project, 'package.json'), '{"name":"demo"}', 'utf8');
    await writeFile(join(project, 'README.md'), '# demo', 'utf8');
    await writeFile(join(project, 'tsconfig.json'), '{}', 'utf8');

    const approved = await adopt(project);
    expect(approved.markers).toContain('package.json');
    expect(approved.markers).toContain('README.md');
    expect(approved.markers).toContain('tsconfig.json');
    expect(approved.markers).not.toContain('Cargo.toml');
  });

  it('detects Git metadata from the entry alone, never by reading inside it', async () => {
    await mkdir(join(project, '.git', 'objects'), { recursive: true });
    await writeFile(join(project, '.git', 'config'), '[core]\n', 'utf8');

    const approved = await adopt(project);
    expect(approved.hasGitMetadata).toBe(true);
    expect(approved.markers).toContain('.git');
  });

  it('reports no Git metadata when there is none', async () => {
    expect((await adopt(project)).hasGitMetadata).toBe(false);
  });

  it('detects test tooling from a marker that implies it', async () => {
    await writeFile(join(project, 'package.json'), '{"name":"demo"}', 'utf8');
    expect((await adopt(project)).hasTestTooling).toBe(true);

    await rm(join(project, 'package.json'));
    expect((await adopt(project)).hasTestTooling).toBe(false);
  });

  it('produces a summary its own schema accepts', async () => {
    const summary = toProjectSummary(await adopt(project));
    expect(workspaceProjectSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.path).toBe(project);
    expect(summary.name).toBe('demo-project');
  });
});

describe('adoptProjectDirectory — refusals', () => {
  it('refuses a path that does not exist', async () => {
    await expectInvalidProject(join(dir, 'no-such-directory'));
  });

  it('refuses a file rather than a directory', async () => {
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'hello', 'utf8');
    await expectInvalidProject(file);
  });

  it("refuses the application's own user-data directory", async () => {
    // Opening `%APPDATA%\Local-Agent` as a project would point the inspector
    // at the settings file, the permission policy and the audit log.
    await expectInvalidProject(userDataDir);
  });

  it("refuses a directory inside the application's user-data directory", async () => {
    const inside = join(userDataDir, 'logs');
    await mkdir(inside, { recursive: true });
    await expectInvalidProject(inside);
  });

  it("refuses a directory that would contain the application's user-data directory", async () => {
    // Selecting the parent would pull the app's own state in as a subtree.
    await expectInvalidProject(dir);
  });

  it('refuses a directory whose name cannot be described safely', async () => {
    const odd = join(dir, 'proj‮cte');
    await mkdir(odd, { recursive: true });
    // A bidirectional override in the name would render as something other
    // than what is stored, so the project is refused rather than displayed.
    await expectInvalidProject(odd);
  });

  it('accepts a project directory with an accented name', async () => {
    const accented = join(dir, 'projet-général');
    await mkdir(accented, { recursive: true });
    const approved = await adopt(accented);
    expect(approved.name).toBe('projet-général');
  });

  it('never puts the rejected path into the thrown error', async () => {
    try {
      await adopt(join(dir, 'no-such-directory'));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).message).not.toContain(dir);
      expect((error as WorkspaceError).message).not.toContain('no-such-directory');
    }
  });
});
