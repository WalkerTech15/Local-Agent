/**
 * Memory storage (Phase 2, Milestone 8).
 *
 * Reads and writes `memory/personal.json` and `memory/projects/<key>.json`,
 * and holds the session scope in memory. It mirrors `main/settings.ts`,
 * `main/policy.ts` and `main/agent-profiles.ts` deliberately and in detail,
 * because a memory file is the same *kind* of thing those are: a
 * user-editable document this application must be able to read without
 * trusting it.
 *
 * The properties carried over from those modules:
 *
 *  - **Loading never throws and never merges.** A missing file, an unreadable
 *    one, an oversized one, malformed JSON, a `__proto__` key anywhere in it,
 *    a document the schema rejects, or a document declaring a scope other
 *    than the one that was asked for, all resolve the same way: an empty
 *    store for that scope. A document either validates in full, as itself, or
 *    it is discarded in full. There is no partial-trust path.
 *  - **Writing is atomic and re-validated.** The document is checked against
 *    the schema immediately before serialising, written to a uniquely named
 *    temporary file in the same directory, flushed, and moved into place with
 *    a single rename — so a crash or a concurrent write leaves either the
 *    previous complete document or the new one, never a partial write.
 *
 * And three of its own, all of which exist because this file holds the user's
 * private notes rather than their configuration:
 *
 *  - **The session scope is never written anywhere.** It lives in a closure
 *    created per `registerIpcHandlers` call, exactly like the approved-project
 *    session, and closing the application ends it. There is no file to find
 *    afterwards and no "session" branch in any function that touches disk.
 *  - **A project's notes are addressed by a hash of its canonical root path,
 *    never by the path itself.** A path carries a user name, often a client
 *    or employer name, and sometimes the existence of a project that is
 *    itself confidential. A directory listing of `%APPDATA%` should not
 *    disclose any of that, so the file name is a truncated SHA-256 digest.
 *  - **Loading one project's store cannot reach another's.** The file name is
 *    derived, never supplied: no caller passes a path, a key or a project
 *    name into this module, so there is no parameter through which one
 *    project's session could name another project's file.
 *
 * Every function takes a plain file path rather than a `UserDataPaths`, for
 * the reason `loadSettings` does: a test points at a temporary directory and
 * configures nothing else.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  FORBIDDEN_OBJECT_KEYS,
  MEMORY_PROJECT_KEY_LENGTH,
  MEMORY_STORE_MAX_BYTES,
} from '../shared/constants';
import type { MemoryScope } from '../shared/constants';
import { createEmptyMemoryStore, memoryStoreSchema } from '../shared/schemas/memory.schema';
import type { MemoryStore } from '../shared/schemas/memory.schema';

/**
 * Mirrors `main/policy.ts`'s and `main/agent-profiles.ts`'s own copies
 * exactly, including the reasoning: `JSON.parse` does not fall for a literal
 * `__proto__` key, but nothing downstream of this loader is allowed to assume
 * that. A fourth independent copy rather than a shared import, so this module
 * gains no runtime dependency on an already-reviewed module from an earlier
 * milestone for one small, self-contained, pure check.
 */
const MAX_MEMORY_JSON_DEPTH = 64;

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_MEMORY_JSON_DEPTH) return true;
  if (value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) {
    return value.some((element) => containsForbiddenKey(element, depth + 1));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_OBJECT_KEYS.includes(key)) return true;
    if (containsForbiddenKey(record[key], depth + 1)) return true;
  }
  return false;
}

/**
 * A destination-file rename can transiently fail on Windows when something
 * else briefly holds the destination open. The same sharing-violation retry
 * `main/settings.ts` performs, and for the same reason: each attempt is one
 * whole-file rename, so retrying risks a delayed write, never a partial one.
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
 * The file-name key for one approved project.
 *
 * A truncated SHA-256 of the project's **canonical** root path. Canonical
 * matters: two spellings of the same directory — a short (8.3) ancestor, a
 * different case, a trailing separator — must resolve to the same notes, and
 * the caller is responsible for passing the path `adoptProjectDirectory`
 * already canonicalised. The path itself is never stored, never logged and
 * never part of a record.
 *
 * Lowercased before hashing because Windows paths are case-insensitive: the
 * same project opened as `C:\Work\App` and `C:\work\app` is the same project,
 * and two stores for it would silently split someone's notes in half.
 */
export function memoryProjectKey(canonicalRootPath: string): string {
  return createHash('sha256')
    .update(canonicalRootPath.toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, MEMORY_PROJECT_KEY_LENGTH);
}

/** Where one project's notes live. Derived, never supplied by a caller. */
export function resolveProjectMemoryFile(
  memoryProjectsDir: string,
  canonicalRootPath: string,
): string {
  return join(memoryProjectsDir, `${memoryProjectKey(canonicalRootPath)}.json`);
}

/**
 * Loads `storeFile`, failing safe on every problem.
 *
 * Never throws, and never creates a file. A first launch is indistinguishable,
 * by design, from a corrupted one: both return an empty store, which loses
 * nothing that was readable and is the only answer that cannot be wrong in
 * the permissive direction.
 *
 * The size check happens before the read, not after: a file that grew without
 * bound should not be pulled into memory to discover that it is too large.
 *
 * `expectedScope` is checked against the document's own declared scope, so a
 * project file that claims to hold personal records — or a personal file
 * moved into the projects directory — is refused rather than being silently
 * re-labelled as whatever the caller asked for.
 */
export async function loadMemoryStore(
  storeFile: string,
  expectedScope: MemoryScope,
): Promise<MemoryStore> {
  try {
    const stats = await stat(storeFile);
    if (stats.size > MEMORY_STORE_MAX_BYTES) return createEmptyMemoryStore(expectedScope);
  } catch {
    // Missing file (first launch) and any other stat failure fail the same
    // way as an unreadable one. Neither the error nor the path is surfaced.
    return createEmptyMemoryStore(expectedScope);
  }

  let raw: string;
  try {
    raw = await readFile(storeFile, 'utf8');
  } catch {
    return createEmptyMemoryStore(expectedScope);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createEmptyMemoryStore(expectedScope);
  }

  if (containsForbiddenKey(parsed)) return createEmptyMemoryStore(expectedScope);

  const result = memoryStoreSchema.safeParse(parsed);
  if (!result.success) return createEmptyMemoryStore(expectedScope);
  if (result.data.scope !== expectedScope) return createEmptyMemoryStore(expectedScope);

  return result.data;
}

/**
 * Writes `store` to `storeFile` atomically.
 *
 * Re-validated against the schema immediately before serialising, so a caller
 * cannot persist a document that only *claims* the type at compile time —
 * which includes the cross-record rule that every record belongs to the
 * store's own scope, the one rule that keeps a project's notes from ending up
 * in another scope's file.
 */
export async function writeMemoryStore(storeFile: string, store: MemoryStore): Promise<void> {
  const validated = memoryStoreSchema.parse(store);
  const payload = JSON.stringify(validated, null, 2);

  const dir = dirname(storeFile);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `${basename(storeFile)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameWithRetry(tempFile, storeFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The session scope: one store, in memory, for the lifetime of one run.
 *
 * One per `registerIpcHandlers` call — never a module-level singleton, so one
 * test's session memory can never leak into another's, exactly as
 * `createWorkspaceSession` is built.
 */
export interface SessionMemoryStore {
  read(): MemoryStore;
  write(store: MemoryStore): void;
}

export function createSessionMemoryStore(): SessionMemoryStore {
  let store: MemoryStore = createEmptyMemoryStore('session');
  return {
    read: () => store,
    write: (next) => {
      // Validated on the way in for the same reason the file writer validates
      // on the way out: nothing persisted or served should rest on a caller's
      // compile-time claim about its type.
      store = memoryStoreSchema.parse(next);
    },
  };
}
