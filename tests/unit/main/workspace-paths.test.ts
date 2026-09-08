import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  isContainedPath,
  resolveProjectPath,
  toWorkspaceError,
} from '../../../src/main/workspace-paths';
import { WorkspaceError } from '../../../src/shared/workspace/errors';

/**
 * The filesystem half of path containment (Phase 2, Milestone 5).
 *
 * Runs against a real temporary directory rather than a mocked `fs`, because
 * the property under test — that a symbolic link cannot lead outside the
 * approved project — is a property of the filesystem, not of a mock.
 *
 * Symlink creation needs Developer Mode or elevation on Windows. The symlink
 * cases detect that and skip rather than fail, and say so, so a run on a
 * machine without the privilege reports "not exercised" instead of a false
 * pass. The escape they cover is *also* covered lexically, without any
 * symlink, by `tests/unit/shared/workspace-path-safety.test.ts`.
 */

let dir: string;
let project: string;
let outside: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-wspaths-')));
  project = join(dir, 'project');
  outside = join(dir, 'outside');
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(project, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'do not read me\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Creates a symlink, or returns false when the platform refuses. */
async function trySymlink(target: string, path: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(WorkspaceError);
  await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => {
      expect((error as WorkspaceError).code).toBe(code);
    },
  );
}

describe('isContainedPath', () => {
  it('treats the root itself as contained', () => {
    expect(isContainedPath(project, project)).toBe(true);
  });

  it('accepts a descendant', () => {
    expect(isContainedPath(project, join(project, 'src', 'index.ts'))).toBe(true);
  });

  it('rejects a sibling and a parent', () => {
    expect(isContainedPath(project, outside)).toBe(false);
    expect(isContainedPath(project, dir)).toBe(false);
  });

  it('rejects a sibling whose name merely starts with the root name', () => {
    // The classic string-prefix bug: `.../project-backup` is not inside
    // `.../project`, and a `startsWith` check would say it is.
    expect(isContainedPath(project, `${project}-backup`)).toBe(false);
    expect(isContainedPath(project, `${project}-backup${sep}notes.txt`)).toBe(false);
  });

  it('does not mistake a directory named with leading dots for an escape', () => {
    expect(isContainedPath(project, join(project, '..config'))).toBe(true);
  });
});

describe('resolveProjectPath — acceptance', () => {
  it('resolves the project root for the empty path', async () => {
    const resolved = await resolveProjectPath(project, '');
    expect(resolved.absolutePath).toBe(project);
    expect(resolved.relativePath).toBe('');
    expect(resolved.segments).toEqual([]);
  });

  it('resolves a nested file and reports its canonical relative path', async () => {
    const resolved = await resolveProjectPath(project, 'src/index.ts');
    expect(resolved.absolutePath).toBe(join(project, 'src', 'index.ts'));
    expect(resolved.relativePath).toBe('src/index.ts');
    expect(resolved.segments).toEqual(['src', 'index.ts']);
  });
});

describe('resolveProjectPath — refusals', () => {
  it('refuses a traversal before touching the filesystem', async () => {
    await expectCode(
      resolveProjectPath(project, '../outside/secret.txt'),
      'WORKSPACE_INVALID_PATH',
    );
    await expectCode(resolveProjectPath(project, 'src/../../outside'), 'WORKSPACE_INVALID_PATH');
  });

  it('refuses an absolute path', async () => {
    await expectCode(
      resolveProjectPath(project, join(outside, 'secret.txt').replace(/\\/g, '/')),
      'WORKSPACE_INVALID_PATH',
    );
    await expectCode(resolveProjectPath(project, '/etc/passwd'), 'WORKSPACE_INVALID_PATH');
  });

  it('refuses an excluded directory anywhere in the path', async () => {
    await mkdir(join(project, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(project, 'node_modules', 'pkg', 'index.js'), 'x\n', 'utf8');
    await expectCode(
      resolveProjectPath(project, 'node_modules/pkg/index.js'),
      'WORKSPACE_PATH_EXCLUDED',
    );
    await expectCode(resolveProjectPath(project, 'node_modules'), 'WORKSPACE_PATH_EXCLUDED');
  });

  it('refuses a credential file even when it exists and is readable', async () => {
    await writeFile(join(project, '.env'), 'API_KEY=fake-sentinel\n', 'utf8');
    await expectCode(resolveProjectPath(project, '.env'), 'WORKSPACE_PATH_EXCLUDED');
  });

  it('reports a missing entry as not found', async () => {
    await expectCode(resolveProjectPath(project, 'src/absent.ts'), 'WORKSPACE_NOT_FOUND');
  });

  it('refuses a non-string path', async () => {
    await expectCode(resolveProjectPath(project, undefined), 'WORKSPACE_INVALID_PATH');
    await expectCode(resolveProjectPath(project, 42), 'WORKSPACE_INVALID_PATH');
  });
});

describe('resolveProjectPath — symbolic links', () => {
  it('refuses a link that leads outside the project', async () => {
    const created = await trySymlink(
      join(outside, 'secret.txt'),
      join(project, 'escape.txt'),
      'file',
    );
    if (!created) {
      console.warn('skipped: this platform refused to create a symbolic link');
      return;
    }
    // Lexically this is a perfectly ordinary path inside the project; only
    // the post-`realpath` containment check can catch it.
    await expectCode(resolveProjectPath(project, 'escape.txt'), 'WORKSPACE_PATH_OUTSIDE_PROJECT');
  });

  it('refuses a linked directory that leads outside the project', async () => {
    const created = await trySymlink(outside, join(project, 'linked'), 'dir');
    if (!created) {
      console.warn('skipped: this platform refused to create a symbolic link');
      return;
    }
    await expectCode(resolveProjectPath(project, 'linked'), 'WORKSPACE_PATH_OUTSIDE_PROJECT');
    await expectCode(
      resolveProjectPath(project, 'linked/secret.txt'),
      'WORKSPACE_PATH_OUTSIDE_PROJECT',
    );
  });

  it('allows a link that stays inside the project', async () => {
    const created = await trySymlink(
      join(project, 'src', 'index.ts'),
      join(project, 'alias.ts'),
      'file',
    );
    if (!created) {
      console.warn('skipped: this platform refused to create a symbolic link');
      return;
    }
    const resolved = await resolveProjectPath(project, 'alias.ts');
    // The canonical path is the link's target, which is still inside.
    expect(resolved.absolutePath).toBe(join(project, 'src', 'index.ts'));
  });
});

describe('toWorkspaceError', () => {
  it('maps filesystem error codes to the normalized vocabulary', () => {
    expect(toWorkspaceError({ code: 'ENOENT' }).code).toBe('WORKSPACE_NOT_FOUND');
    expect(toWorkspaceError({ code: 'ENOTDIR' }).code).toBe('WORKSPACE_NOT_FOUND');
    expect(toWorkspaceError({ code: 'EACCES' }).code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(toWorkspaceError({ code: 'EPERM' }).code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(toWorkspaceError({ code: 'ELOOP' }).code).toBe('WORKSPACE_UNSUPPORTED_ENTRY');
  });

  it('degrades anything unrecognised to the generic read failure', () => {
    expect(toWorkspaceError({ code: 'EWHATEVER' }).code).toBe('WORKSPACE_READ_FAILED');
    expect(toWorkspaceError(new Error('boom')).code).toBe('WORKSPACE_READ_FAILED');
    expect(toWorkspaceError(null).code).toBe('WORKSPACE_READ_FAILED');
    expect(toWorkspaceError('a string').code).toBe('WORKSPACE_READ_FAILED');
  });

  it('passes an existing WorkspaceError through unchanged', () => {
    const original = new WorkspaceError('WORKSPACE_BINARY_FILE');
    expect(toWorkspaceError(original)).toBe(original);
  });

  it('never carries a path or an underlying message into the result', () => {
    const leaky = Object.assign(new Error(`ENOENT: no such file, open '${join(outside, 'x')}'`), {
      code: 'ENOENT',
    });
    const mapped = toWorkspaceError(leaky);
    expect(mapped.message).not.toContain(outside);
    expect(mapped.message).not.toContain('ENOENT');
    expect(mapped.cause).toBeUndefined();
  });
});
