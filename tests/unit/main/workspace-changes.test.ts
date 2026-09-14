import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChangeStore, type ChangeStore } from '../../../src/main/workspace-changes';
import { adoptProjectDirectory, type ApprovedProject } from '../../../src/main/workspace-session';
import { workspaceChangeSetSchema } from '../../../src/shared/schemas/coding.schema';
import {
  WORKSPACE_MAX_CHANGE_FILES,
  WORKSPACE_MAX_PENDING_CHANGES,
  WORKSPACE_MAX_WRITE_BYTES,
} from '../../../src/shared/constants';
import { WorkspaceError } from '../../../src/shared/workspace/errors';

/**
 * Proposing, applying and undoing file changes, against a real temporary
 * directory (Phase 2, Milestone 6).
 *
 * Nothing here mocks `fs`. The behaviours under test are behaviours against a
 * real filesystem — what a write lands on, what a symbolic link resolves to,
 * what a backup contains — and a mock would only assert that the mock behaves
 * as the test expects.
 *
 * Three concerns run throughout, in decreasing order of how much they matter:
 *
 *  1. **Nothing is written until `apply`.** Proposing produces a diff and
 *     touches nothing.
 *  2. **A write can only land inside the approved project**, and only on the
 *     file whose current contents were diffed.
 *  3. **Nothing is ever deleted**, and a failed change leaves the project as
 *     it was.
 */

const NOW = '2026-09-08T00:00:00.000Z';
const LATER = '2026-09-08T00:05:00.000Z';

let dir: string;
let root: string;
let backupsDir: string;
let project: ApprovedProject;
let store: ChangeStore;

async function write(relativePath: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, ...relativePath.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, ...relativePath.split('/')), 'utf8');
}

/** Every path in the project, with its bytes, for before/after comparison. */
async function snapshot(directory = root, prefix = ''): Promise<Map<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const out = new Map<string, string>();
  for (const entry of entries) {
    const full = join(directory, entry.name);
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await snapshot(full, relative)) out.set(key, value);
      continue;
    }
    out.set(relative, (await readFile(full)).toString('base64'));
  }
  return out;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-changes-')));
  root = join(dir, 'demo');
  backupsDir = join(dir, 'Local-Agent', 'backups');
  await mkdir(root, { recursive: true });

  await write('package.json', '{"name":"demo","scripts":{"test":"vitest run"}}\n');
  await write('src/index.ts', 'export const answer = 42;\n');
  await write('src/other.ts', 'export const other = 1;\n');
  await write('README.md', '# Demo\n');
  await write('.env', 'API_KEY=fake-sentinel-value\n');
  await write('node_modules/pkg/index.js', 'module.exports = 42;\n');
  await write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  project = await adoptProjectDirectory({
    chosenPath: root,
    now: NOW,
    userDataDir: join(dir, 'Local-Agent'),
  });
  store = createChangeStore({ backupsDir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('propose — producing a diff without writing', () => {
  it('returns a change set awaiting approval, with a diff', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'export const answer = 43;\n' }],
      now: NOW,
    });

    expect(change.status).toBe('awaiting-approval');
    expect(change.approvalRequired).toBe(true);
    expect(change.files).toHaveLength(1);
    expect(change.totalAdded).toBe(1);
    expect(change.totalRemoved).toBe(1);
    expect(workspaceChangeSetSchema.safeParse(change).success).toBe(true);
  });

  it('writes absolutely nothing to the project', async () => {
    const before = await snapshot();
    await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'export const answer = 43;\n' }],
      now: NOW,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('takes no backup before anything has been applied', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    expect(change.backupAvailable).toBe(false);
    await expect(stat(backupsDir)).rejects.toThrow();
  });

  it('refuses a change that would leave every file exactly as it is', async () => {
    await expect(
      store.propose({
        project,
        edits: [{ path: 'src/index.ts', content: await read('src/index.ts') }],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_EMPTY' });
  });

  it('accepts a change set touching several files at once', async () => {
    const change = await store.propose({
      project,
      edits: [
        { path: 'src/index.ts', content: 'export const answer = 43;\n' },
        { path: 'src/other.ts', content: 'export const other = 2;\n' },
      ],
      now: NOW,
    });
    expect(change.files.map((file) => file.path)).toEqual(['src/index.ts', 'src/other.ts']);
  });
});

describe('propose — containment and exclusion', () => {
  it('refuses a traversal path', async () => {
    for (const path of ['../outside.ts', 'src/../../outside.ts', '..']) {
      await expect(
        store.propose({ project, edits: [{ path, content: 'x' }], now: NOW }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID_PATH' });
    }
  });

  it('refuses an absolute path', async () => {
    for (const path of ['/etc/passwd', 'C:/Windows/System32/config/SAM']) {
      await expect(
        store.propose({ project, edits: [{ path, content: 'x' }], now: NOW }),
      ).rejects.toBeInstanceOf(WorkspaceError);
    }
  });

  it('refuses a credential file, so a write can never target one', async () => {
    await expect(
      store.propose({ project, edits: [{ path: '.env', content: 'API_KEY=other\n' }], now: NOW }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_EXCLUDED' });
  });

  it('refuses a path under an excluded directory', async () => {
    await expect(
      store.propose({
        project,
        edits: [{ path: 'node_modules/pkg/index.js', content: 'x\n' }],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_EXCLUDED' });
  });

  it('refuses a binary file, because a file it will not show is one it will not write', async () => {
    await expect(
      store.propose({ project, edits: [{ path: 'assets/logo.png', content: 'x' }], now: NOW }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_BINARY_FILE' });
  });

  it('refuses a file that does not exist — a change modifies, never creates', async () => {
    await expect(
      store.propose({ project, edits: [{ path: 'src/new-file.ts', content: 'x\n' }], now: NOW }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });

  it('refuses a symbolic link that leaves the project', async () => {
    const outside = join(dir, 'outside.txt');
    await writeFile(outside, 'secret\n');

    let linked = false;
    try {
      await symlink(outside, join(root, 'src', 'link.ts'), 'file');
      linked = true;
    } catch {
      // Windows needs Developer Mode or elevation to create a link.
      console.warn('skipped: this platform refused to create a symbolic link');
    }
    if (!linked) return;

    await expect(
      store.propose({ project, edits: [{ path: 'src/link.ts', content: 'x\n' }], now: NOW }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_OUTSIDE_PROJECT' });

    // And the file it pointed at is untouched.
    expect(await readFile(outside, 'utf8')).toBe('secret\n');
  });
});

describe('propose — bounds', () => {
  it('refuses more files than the change-set limit', async () => {
    const edits = Array.from({ length: WORKSPACE_MAX_CHANGE_FILES + 1 }, (_, index) => ({
      path: 'src/index.ts',
      content: `export const answer = ${String(index)};\n`,
    }));
    await expect(store.propose({ project, edits, now: NOW })).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGE_TOO_LARGE',
    });
  });

  it('refuses an empty change set', async () => {
    await expect(store.propose({ project, edits: [], now: NOW })).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGE_TOO_LARGE',
    });
  });

  it('refuses content larger than the write limit', async () => {
    await expect(
      store.propose({
        project,
        edits: [{ path: 'src/index.ts', content: 'x'.repeat(WORKSPACE_MAX_WRITE_BYTES + 1) }],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_TOO_LARGE' });
  });

  it('measures the write limit in bytes, not in characters', async () => {
    // A multi-byte character encodes to more bytes than it occupies as a
    // UTF-16 code unit, so a string that looks short enough can still be over.
    const content = '\u00e9'.repeat(WORKSPACE_MAX_WRITE_BYTES - 10);
    expect(content.length).toBeLessThan(WORKSPACE_MAX_WRITE_BYTES);
    await expect(
      store.propose({ project, edits: [{ path: 'src/index.ts', content }], now: NOW }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_TOO_LARGE' });
  });

  it('discards the oldest still-pending proposal rather than growing without limit', async () => {
    const ids: string[] = [];
    for (let index = 0; index < WORKSPACE_MAX_PENDING_CHANGES + 2; index += 1) {
      const change = await store.propose({
        project,
        edits: [{ path: 'src/index.ts', content: `export const answer = ${String(index)};\n` }],
        now: NOW,
      });
      ids.push(change.id);
    }

    expect(store.history().changes.length).toBe(WORKSPACE_MAX_PENDING_CHANGES);
    expect(store.describe(ids[0] ?? '')).toBeNull();
    expect(store.describe(ids[ids.length - 1] ?? '')).not.toBeNull();
  });
});

describe('apply — writing only what was approved', () => {
  it('writes the proposed content and reports the change as applied', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'export const answer = 43;\n' }],
      now: NOW,
    });

    const applied = await store.apply({ project, changeId: change.id, now: LATER });
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBe(LATER);
    expect(applied.backupAvailable).toBe(true);
    expect(await read('src/index.ts')).toBe('export const answer = 43;\n');
  });

  it('changes nothing else in the project', async () => {
    const before = await snapshot();
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'export const answer = 43;\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });

    const after = await snapshot();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      if (path === 'src/index.ts') continue;
      expect(after.get(path), path).toBe(bytes);
    }
  });

  it('applies every file of a multi-file change set', async () => {
    const change = await store.propose({
      project,
      edits: [
        { path: 'src/index.ts', content: 'a\n' },
        { path: 'src/other.ts', content: 'b\n' },
      ],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });
    expect(await read('src/index.ts')).toBe('a\n');
    expect(await read('src/other.ts')).toBe('b\n');
  });

  it('refuses an unknown change id', async () => {
    await expect(
      store.apply({ project, changeId: '11111111-1111-4111-8111-111111111111', now: LATER }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_NOT_FOUND' });
  });

  it('refuses to apply the same change twice', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'once\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });
    await expect(store.apply({ project, changeId: change.id, now: LATER })).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGE_SETTLED',
    });
  });

  it('refuses when the file changed after the diff was produced', async () => {
    // The content half of time-of-check/time-of-use, and unlike the path half
    // it can be closed completely: someone else's edit is never discarded.
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'from the agent\n' }],
      now: NOW,
    });
    await write('src/index.ts', 'edited by the user in another editor\n');

    await expect(store.apply({ project, changeId: change.id, now: LATER })).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGE_STALE',
    });
    expect(await read('src/index.ts')).toBe('edited by the user in another editor\n');
  });

  it('refuses to apply a change proposed against a different project', async () => {
    const otherRoot = join(dir, 'other');
    await mkdir(join(otherRoot, 'src'), { recursive: true });
    await writeFile(join(otherRoot, 'src', 'index.ts'), 'export const answer = 42;\n');
    const otherProject = await adoptProjectDirectory({
      chosenPath: otherRoot,
      now: NOW,
      userDataDir: join(dir, 'Local-Agent'),
    });

    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });

    await expect(
      store.apply({ project: otherProject, changeId: change.id, now: LATER }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_NOT_FOUND' });
    expect(await readFile(join(otherRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export const answer = 42;\n',
    );
  });

  it('re-checks containment at write time, not only at proposal time', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });

    // Replace the target with a link out of the project after the diff was
    // produced but before it is applied.
    const outside = join(dir, 'outside.txt');
    await writeFile(outside, 'secret\n');
    await rm(join(root, 'src', 'index.ts'));

    let linked = false;
    try {
      await symlink(outside, join(root, 'src', 'index.ts'), 'file');
      linked = true;
    } catch {
      console.warn('skipped: this platform refused to create a symbolic link');
    }
    if (!linked) return;

    await expect(store.apply({ project, changeId: change.id, now: LATER })).rejects.toThrow(
      WorkspaceError,
    );
    expect(await readFile(outside, 'utf8')).toBe('secret\n');
  });
});

describe('backup and rollback', () => {
  it('keeps the pre-change bytes outside the project', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });

    // The backup exists, and it is not inside the user's project — a backup
    // written there would appear in their tree and eventually in a commit.
    const backup = join(backupsDir, change.id, 'src', 'index.ts');
    expect(await readFile(backup, 'utf8')).toBe('export const answer = 42;\n');
    expect((await snapshot()).has('.local-agent-backup')).toBe(false);
  });

  it('restores the previous contents exactly', async () => {
    const original = await read('src/index.ts');
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });
    expect(await read('src/index.ts')).toBe('changed\n');

    const rolled = await store.rollback({ project, changeId: change.id, now: LATER });
    expect(rolled.status).toBe('rolled-back');
    expect(await read('src/index.ts')).toBe(original);
  });

  it('restores every file of a multi-file change set', async () => {
    const before = await snapshot();
    const change = await store.propose({
      project,
      edits: [
        { path: 'src/index.ts', content: 'a\n' },
        { path: 'src/other.ts', content: 'b\n' },
      ],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });
    await store.rollback({ project, changeId: change.id, now: LATER });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to roll back the same change twice', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });
    await store.rollback({ project, changeId: change.id, now: LATER });
    await expect(
      store.rollback({ project, changeId: change.id, now: LATER }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_SETTLED' });
  });

  it('refuses to roll back a change that was never applied', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    await expect(
      store.rollback({ project, changeId: change.id, now: LATER }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGE_SETTLED' });
  });

  it('rolls back only the most recent applied change', async () => {
    // Restoring an older backup would silently undo everything applied after
    // it, which is not what "undo the change I just made" means to anyone.
    const first = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'first\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: first.id, now: LATER });

    const second = await store.propose({
      project,
      edits: [{ path: 'src/other.ts', content: 'second\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: second.id, now: LATER });

    expect(store.rollbackTarget()).toBe(second.id);
    await expect(store.rollback({ project, changeId: first.id, now: LATER })).rejects.toMatchObject(
      { code: 'WORKSPACE_ROLLBACK_UNAVAILABLE' },
    );
    expect(await read('src/index.ts')).toBe('first\n');
  });

  it('reports the rollback target and the history newest first', async () => {
    const first = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'first\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: first.id, now: LATER });

    const history = store.history();
    expect(history.rollbackTarget).toBe(first.id);
    expect(history.changes[0]?.id).toBe(first.id);
  });

  it('reports no rollback target when nothing has been applied', () => {
    expect(store.rollbackTarget()).toBeNull();
    expect(store.history().rollbackTarget).toBeNull();
  });
});

describe('what this module never does', () => {
  it('never deletes a file from the project', async () => {
    const before = await snapshot();
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });
    await store.rollback({ project, changeId: change.id, now: LATER });

    // Same set of paths throughout, and identical bytes after the undo.
    expect(await snapshot()).toEqual(before);
  });

  it('leaves no temporary file behind after an apply', async () => {
    const change = await store.propose({
      project,
      edits: [{ path: 'src/index.ts', content: 'changed\n' }],
      now: NOW,
    });
    await store.apply({ project, changeId: change.id, now: LATER });

    for (const path of (await snapshot()).keys()) {
      expect(path, path).not.toContain('local-agent-');
      expect(path, path).not.toMatch(/\.tmp$/);
    }
  });

  it('never logs, so no path or file content reaches a log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const change = await store.propose({
        project,
        edits: [{ path: 'src/index.ts', content: 'changed\n' }],
        now: NOW,
      });
      await store.apply({ project, changeId: change.id, now: LATER });
      await store.rollback({ project, changeId: change.id, now: LATER });
      await store
        .propose({ project, edits: [{ path: '../escape', content: 'x' }], now: NOW })
        .catch(() => undefined);

      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('never puts a path or file content into a thrown error message', async () => {
    try {
      await store.propose({
        project,
        edits: [{ path: 'node_modules/pkg/index.js', content: 'x' }],
        now: NOW,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      const message = (error as WorkspaceError).message;
      expect(message).not.toContain(root);
      expect(message).not.toContain('node_modules');
    }
  });
});
