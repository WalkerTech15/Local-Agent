/**
 * Reading and writing memory files outside the application (P2, M8).
 *
 * The only module in this milestone that touches a path the application does
 * not own. Both directions are deliberately narrow:
 *
 *  - **Neither function chooses a path.** The path always comes from a native
 *    dialog the main process owns (`main/memory-picker.ts`), so the renderer
 *    cannot name a file to read or a file to overwrite. A dialog result is
 *    still *input*, but it is input the user clicked on, which is the same
 *    consent model `workspace:select` already uses.
 *  - **An import is untrusted content.** It is size-checked before it is
 *    read, parsed as JSON with no reviver, screened for a prototype-polluting
 *    key, and returned as `unknown` — this module never claims it is a memory
 *    document. `main/memory-service.ts` decides that, against the schema.
 *  - **An export is written atomically.** A half-written export is worse than
 *    a failed one: someone who believes their notes are backed up will delete
 *    the originals. Temporary file, flush, single rename.
 *  - **No error escapes.** Every failure becomes a `MemoryError` carrying a
 *    code from the closed vocabulary. A filesystem error message would name
 *    the path, and a path is user data.
 */

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { FORBIDDEN_OBJECT_KEYS, MEMORY_IMPORT_MAX_BYTES } from '../shared/constants';
import { MemoryError } from '../shared/memory/errors';
import type { MemoryExport } from '../shared/schemas/memory.schema';

const MAX_IMPORT_JSON_DEPTH = 64;

/** The same guard `main/memory-store.ts` applies, on a far less trusted file. */
function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_IMPORT_JSON_DEPTH) return true;
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
 * Reads and parses the file the user chose, without interpreting it.
 *
 * The size check happens before the read, exactly as it does for this
 * application's own stores: a file that is too large should not be pulled
 * into the privileged process's memory in order to discover that.
 */
export async function readMemoryImportFile(sourcePath: string): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(sourcePath)).size;
  } catch {
    throw new MemoryError('MEMORY_IMPORT_INVALID');
  }
  if (size > MEMORY_IMPORT_MAX_BYTES) throw new MemoryError('MEMORY_IMPORT_TOO_LARGE');

  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch {
    throw new MemoryError('MEMORY_IMPORT_INVALID');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryError('MEMORY_IMPORT_INVALID');
  }

  if (containsForbiddenKey(parsed)) throw new MemoryError('MEMORY_IMPORT_INVALID');
  return parsed;
}

/**
 * Writes an export document to the file the user chose.
 *
 * The temporary file is created beside the destination so the rename stays on
 * one volume — a cross-volume rename is a copy, which would defeat the point.
 * It is removed on every failure path, so a failed export leaves nothing
 * behind in someone's Documents folder.
 */
export async function writeMemoryExportFile(
  targetPath: string,
  document: MemoryExport,
): Promise<void> {
  const payload = JSON.stringify(document, null, 2);
  const tempFile = join(dirname(targetPath), `${basename(targetPath)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempFile, targetPath);
  } catch {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw new MemoryError('MEMORY_EXPORT_FAILED');
  }
}
