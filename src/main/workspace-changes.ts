/**
 * Proposed, approved and reversible file changes (Phase 2, Milestone 6).
 *
 * This is the only module in this codebase that writes a file the user chose.
 * `node:fs/promises` is imported here for exactly `mkdir`, `open`, `readFile`,
 * `rename`, `rm` and `stat`, and that import list is the whole of its
 * filesystem capability — there is no `unlink` of a project file, no `rmdir`,
 * no `copyFile`, no `chmod`, and nothing that could create or delete an entry
 * inside the approved project. A change *modifies files that already exist*,
 * and that is the only thing it can do.
 *
 * ## The shape that makes approval mean something
 *
 * A change is proposed once and applied by reference:
 *
 *  1. {@link proposeChangeSet} takes the proposed content, reads what is
 *     currently on disk, records a hash of it, builds the diff, and keeps the
 *     whole thing **in the main process**, keyed by a main-generated id.
 *  2. {@link applyChangeSet} takes that id — and nothing else. No path, no
 *     content, no destination.
 *
 * So the bytes written are necessarily the bytes that were diffed and shown to
 * the user. A renderer that has been compromised between the two calls can ask
 * for an already-reviewed change to be applied; it cannot substitute a
 * different one, because there is no parameter through which to do so. That is
 * the difference between an approval that means something and an approval that
 * is merely a step someone took earlier.
 *
 * ## What protects the file that is already there
 *
 *  - **Containment is re-checked at write time.** Every path is resolved again
 *    through `resolveProjectPath` — lexical rules, exclusion rules, join,
 *    `realpath`, and the containment check *after* canonicalisation, which is
 *    the one that catches a symbolic link. A link planted between the proposal
 *    and the approval is refused, not followed.
 *  - **Content is re-checked at write time.** The file's hash must still match
 *    what it was when the diff was produced. If someone — the user in another
 *    editor, another process, or a build — changed the file in between, the
 *    write is refused as `WORKSPACE_CHANGE_STALE` rather than silently
 *    discarding their work. This is the content half of the
 *    time-of-check/time-of-use problem, and unlike the path half it can be
 *    closed completely.
 *  - **A backup is taken before anything is written**, outside the project, in
 *    this application's own data directory — so a backup never appears in the
 *    project tree, never gets committed, and never becomes something the user
 *    has to clean up before their next commit.
 *  - **A change set is all-or-nothing.** If the third of five writes fails,
 *    the two that succeeded are restored from the backup before the failure is
 *    reported. A half-applied change is the one outcome a user could not
 *    reason about.
 *  - **Nothing is ever deleted automatically.** Evicting an old change set
 *    from memory leaves its backup on disk. The user's own files are never
 *    removed by this module under any circumstances.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { readProjectFile } from './workspace-inspector';
import { joinAbsolute, resolveProjectPath, toWorkspaceError } from './workspace-paths';
import type { ApprovedProject } from './workspace-session';
import {
  WORKSPACE_DIFF_MAX_LINES,
  WORKSPACE_MAX_APPLIED_CHANGES,
  WORKSPACE_MAX_CHANGE_FILES,
  WORKSPACE_MAX_PENDING_CHANGES,
  WORKSPACE_MAX_WRITE_BYTES,
} from '../shared/constants';
import type {
  WorkspaceChangeHistory,
  WorkspaceChangeSet,
  WorkspaceEdit,
} from '../shared/schemas/coding.schema';
import type { FileDiff } from '../shared/workspace/diff';
import { buildFileDiff, isUnchanged } from '../shared/workspace/diff';
import { WorkspaceError } from '../shared/workspace/errors';

/** One file inside a change set, as the main process holds it. */
interface PreparedEdit {
  readonly relativePath: string;
  readonly name: string;
  /** SHA-256 of the file's bytes at the moment the diff was produced. */
  readonly baseHash: string;
  readonly diff: FileDiff;
  /**
   * The proposed replacement. Cleared once the change is applied — by then
   * the file on disk *is* this content, and holding a second copy of every
   * applied change would grow without bound.
   */
  afterContent: string | null;
}

interface ChangeRecord {
  readonly id: string;
  readonly createdAt: string;
  status: WorkspaceChangeSet['status'];
  readonly edits: PreparedEdit[];
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly truncated: boolean;
  /** Where the pre-change bytes live, once a write has actually happened. */
  backupDir: string | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  /** The project this was proposed against; a change never crosses projects. */
  readonly projectRoot: string;
}

export interface ChangeStore {
  propose(options: ProposeChangeOptions): Promise<WorkspaceChangeSet>;
  apply(options: SettleChangeOptions): Promise<WorkspaceChangeSet>;
  rollback(options: SettleChangeOptions): Promise<WorkspaceChangeSet>;
  history(): WorkspaceChangeHistory;
  /** The change set a rollback would restore, for building a confirmation. */
  describe(changeId: string): WorkspaceChangeSet | null;
  /** The id rollback would target, or `null`. */
  rollbackTarget(): string | null;
}

/**
 * Same atomic-write mechanics as `main/emergency.ts` and `main/settings.ts`,
 * duplicated rather than imported for the reason those two already duplicate
 * it between themselves: a small, pure, self-contained helper is clearer
 * repeated than turned into a shared dependency between modules that have no
 * other relationship. The retry exists because a rename over an existing
 * destination transiently fails on Windows when something else briefly holds
 * it open — an editor with the file open is the common case here, and this
 * module writes files the user is very likely to have open.
 */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 20;

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt === RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) throw error;
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

/**
 * Replaces a file's contents atomically.
 *
 * The temporary file is created in the *same directory* as the destination,
 * which is what makes the final rename atomic — a rename across volumes is a
 * copy and a delete, and a reader can see the gap between them. Its name is
 * generated here, so it is never influenced by anything a caller supplied.
 * On any failure the temporary file is removed and the original is untouched.
 */
async function writeFileAtomically(absolutePath: string, content: string): Promise<void> {
  const directory = dirname(absolutePath);
  const tempFile = join(directory, `.${basename(absolutePath)}.local-agent-${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempFile, absolutePath);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toChangeSet(record: ChangeRecord): WorkspaceChangeSet {
  return {
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    files: record.edits.map((edit) => ({
      path: edit.relativePath,
      name: edit.name,
      hunks: edit.diff.hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] })),
      added: edit.diff.added,
      removed: edit.diff.removed,
      coarse: edit.diff.coarse,
      truncated: edit.diff.truncated,
      warnings: [...edit.diff.warnings],
    })),
    totalAdded: record.totalAdded,
    totalRemoved: record.totalRemoved,
    truncated: record.truncated,
    approvalRequired: true,
    backupAvailable: record.backupDir !== null,
    appliedAt: record.appliedAt,
    rolledBackAt: record.rolledBackAt,
  };
}

export interface ProposeChangeOptions {
  readonly project: ApprovedProject;
  readonly edits: readonly WorkspaceEdit[];
  /** UTC ISO-8601, supplied by the caller. This module reads no clock. */
  readonly now: string;
}

export interface SettleChangeOptions {
  readonly project: ApprovedProject;
  readonly changeId: string;
  readonly now: string;
}

export interface CreateChangeStoreOptions {
  /**
   * Where pre-change backups are written — a directory under
   * `%APPDATA%\Local-Agent`, never inside the user's project.
   */
  readonly backupsDir: string;
}

export function createChangeStore(options: CreateChangeStoreOptions): ChangeStore {
  const { backupsDir } = options;
  /** Newest last, so eviction and "most recent" are both cheap and obvious. */
  const records: ChangeRecord[] = [];

  function find(changeId: string): ChangeRecord {
    const record = records.find((candidate) => candidate.id === changeId);
    if (record === undefined) throw new WorkspaceError('WORKSPACE_CHANGE_NOT_FOUND');
    return record;
  }

  function latestApplied(): ChangeRecord | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record?.status === 'applied') return record;
    }
    return null;
  }

  /**
   * Keeps the store bounded without ever discarding something a rollback
   * might need.
   *
   * A still-pending proposal is only a description, so the oldest is dropped
   * once too many accumulate. An applied one is dropped only when the applied
   * history is itself over its bound, and dropping it never touches the backup
   * on disk — this module deletes nothing.
   */
  function evict(): void {
    let pending = records.filter((record) => record.status === 'awaiting-approval').length;
    while (pending > WORKSPACE_MAX_PENDING_CHANGES) {
      const index = records.findIndex((record) => record.status === 'awaiting-approval');
      if (index === -1) break;
      records.splice(index, 1);
      pending -= 1;
    }

    let settled = records.filter((record) => record.status !== 'awaiting-approval').length;
    while (settled > WORKSPACE_MAX_APPLIED_CHANGES) {
      const index = records.findIndex((record) => record.status !== 'awaiting-approval');
      if (index === -1) break;
      records.splice(index, 1);
      settled -= 1;
    }
  }

  async function propose(proposeOptions: ProposeChangeOptions): Promise<WorkspaceChangeSet> {
    const { project, edits, now } = proposeOptions;

    if (edits.length === 0 || edits.length > WORKSPACE_MAX_CHANGE_FILES) {
      throw new WorkspaceError('WORKSPACE_CHANGE_TOO_LARGE');
    }

    const prepared: PreparedEdit[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    let budget = WORKSPACE_DIFF_MAX_LINES;
    let truncated = false;
    let anyChange = false;

    for (const edit of edits) {
      if (Buffer.byteLength(edit.content, 'utf8') > WORKSPACE_MAX_WRITE_BYTES) {
        throw new WorkspaceError('WORKSPACE_CHANGE_TOO_LARGE');
      }

      // Reuses the read path in full — so a credential file, an excluded
      // directory, a binary file, an oversized file and a path that escapes
      // the project are all refused here by exactly the rules that already
      // refuse them for reading. A file this application will not show is a
      // file it will not write either.
      const current = await readProjectFile(project, edit.path);
      const target = await resolveProjectPath(project.rootPath, edit.path);

      const diff = buildFileDiff({
        before: current.content,
        after: edit.content,
        maxLines: budget,
      });
      budget = Math.max(0, budget - diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0));
      if (diff.truncated) truncated = true;
      if (!isUnchanged(current.content, edit.content)) anyChange = true;

      totalAdded += diff.added;
      totalRemoved += diff.removed;

      prepared.push({
        relativePath: target.relativePath,
        name: current.metadata.name,
        baseHash: hashContent(current.content),
        diff,
        afterContent: edit.content,
      });
    }

    // A proposal that changes nothing is refused rather than recorded: it
    // would otherwise be approvable, and approving a write that writes the
    // same bytes back teaches a user that approving is inconsequential.
    if (!anyChange) throw new WorkspaceError('WORKSPACE_CHANGE_EMPTY');

    const record: ChangeRecord = {
      id: randomUUID(),
      createdAt: now,
      status: 'awaiting-approval',
      edits: prepared,
      totalAdded,
      totalRemoved,
      truncated,
      backupDir: null,
      appliedAt: null,
      rolledBackAt: null,
      projectRoot: project.rootPath,
    };
    records.push(record);
    evict();

    return toChangeSet(record);
  }

  /** Copies the current bytes of every target out of the project first. */
  async function backup(
    record: ChangeRecord,
    targets: readonly { readonly relativePath: string; readonly content: string }[],
  ): Promise<string> {
    const directory = join(backupsDir, record.id);
    try {
      for (const target of targets) {
        const destination = joinAbsolute(directory, target.relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFileAtomically(destination, target.content);
      }
    } catch {
      throw new WorkspaceError('WORKSPACE_BACKUP_FAILED');
    }
    return directory;
  }

  async function apply(settleOptions: SettleChangeOptions): Promise<WorkspaceChangeSet> {
    const { project, changeId, now } = settleOptions;
    const record = find(changeId);

    if (record.projectRoot !== project.rootPath) {
      // A change proposed against one project can never be applied to
      // another, even if the same relative paths exist in both.
      throw new WorkspaceError('WORKSPACE_CHANGE_NOT_FOUND');
    }
    if (record.status !== 'awaiting-approval') {
      throw new WorkspaceError('WORKSPACE_CHANGE_SETTLED');
    }

    // Re-resolve and re-read every target *now*. Containment, exclusion and
    // the symbolic-link check all run again against the current filesystem,
    // and the content hash must still match what was diffed.
    const targets: {
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly content: string;
      readonly next: string;
    }[] = [];

    for (const edit of record.edits) {
      const next = edit.afterContent;
      if (next === null) throw new WorkspaceError('WORKSPACE_CHANGE_SETTLED');

      const target = await resolveProjectPath(project.rootPath, edit.relativePath);
      let stats;
      try {
        stats = await stat(target.absolutePath);
      } catch (error) {
        throw toWorkspaceError(error);
      }
      if (!stats.isFile()) throw new WorkspaceError('WORKSPACE_UNSUPPORTED_ENTRY');

      const current = await readProjectFile(project, edit.relativePath);
      if (hashContent(current.content) !== edit.baseHash) {
        throw new WorkspaceError('WORKSPACE_CHANGE_STALE');
      }

      targets.push({
        relativePath: edit.relativePath,
        absolutePath: target.absolutePath,
        content: current.content,
        next,
      });
    }

    const backupDir = await backup(record, targets);
    record.backupDir = backupDir;

    const written: typeof targets = [];
    try {
      for (const target of targets) {
        await writeFileAtomically(target.absolutePath, target.next);
        written.push(target);
      }
    } catch {
      // All-or-nothing: restore whatever was already written before reporting
      // the failure, so the project is never left half-changed.
      for (const target of written) {
        await writeFileAtomically(target.absolutePath, target.content).catch(() => undefined);
      }
      record.status = 'failed';
      throw new WorkspaceError('WORKSPACE_WRITE_FAILED');
    }

    record.status = 'applied';
    record.appliedAt = now;
    for (const edit of record.edits) edit.afterContent = null;
    evict();

    return toChangeSet(record);
  }

  async function rollback(settleOptions: SettleChangeOptions): Promise<WorkspaceChangeSet> {
    const { project, changeId, now } = settleOptions;
    const record = find(changeId);

    if (record.projectRoot !== project.rootPath) {
      throw new WorkspaceError('WORKSPACE_CHANGE_NOT_FOUND');
    }
    if (record.status !== 'applied') throw new WorkspaceError('WORKSPACE_CHANGE_SETTLED');

    // Only the most recent applied change can be rolled back. Restoring an
    // older one would silently undo everything applied after it, which is not
    // what "undo the change I just made" means to anyone.
    // `?.` covers both "nothing is applied" and "the applied one is not this".
    const target = latestApplied();
    if (target?.id !== record.id) {
      throw new WorkspaceError('WORKSPACE_ROLLBACK_UNAVAILABLE');
    }

    const backupDir = record.backupDir;
    if (backupDir === null) throw new WorkspaceError('WORKSPACE_ROLLBACK_UNAVAILABLE');

    const restores: { readonly absolutePath: string; readonly content: string }[] = [];
    for (const edit of record.edits) {
      const resolved = await resolveProjectPath(project.rootPath, edit.relativePath);
      let content: string;
      try {
        content = await readFile(joinAbsolute(backupDir, edit.relativePath), 'utf8');
      } catch {
        throw new WorkspaceError('WORKSPACE_ROLLBACK_UNAVAILABLE');
      }
      restores.push({ absolutePath: resolved.absolutePath, content });
    }

    for (const restore of restores) {
      try {
        await writeFileAtomically(restore.absolutePath, restore.content);
      } catch {
        throw new WorkspaceError('WORKSPACE_WRITE_FAILED');
      }
    }

    record.status = 'rolled-back';
    record.rolledBackAt = now;
    return toChangeSet(record);
  }

  return {
    propose,
    apply,
    rollback,
    history: () => ({
      // Newest first, which is the order the interface reads them in.
      changes: [...records].reverse().map(toChangeSet),
      rollbackTarget: latestApplied()?.id ?? null,
    }),
    describe: (changeId) => {
      const record = records.find((candidate) => candidate.id === changeId);
      return record === undefined ? null : toChangeSet(record);
    },
    rollbackTarget: () => latestApplied()?.id ?? null,
  };
}
