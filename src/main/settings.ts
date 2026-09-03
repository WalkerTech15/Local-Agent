/**
 * Non-secret settings storage for Local Agent.
 *
 * Reads and writes `settings.json`. Nothing here ever handles a credential:
 * the schema this module validates against declares no field capable of
 * holding one, and the only secret-adjacent value is the boolean
 * `hasApiKey` — metadata, never a key. See `docs/security-model.md`.
 *
 * Both functions take a plain settings-file path rather than an
 * `UserDataPaths` object, so a test can point at a file inside a temporary
 * directory with nothing else to configure and never touch the real
 * `%APPDATA%`.
 *
 * Pure I/O boundary: no permission decisions, no audit writes, no secret
 * store. Those are separate modules in later milestones.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { FORBIDDEN_OBJECT_KEYS } from '../shared/constants';
import { createDefaultSettings, settingsSchema } from '../shared/schemas';
import type { Settings } from '../shared/schemas';

/**
 * A JSON document is never trusted merely for having parsed. `JSON.parse`
 * itself does not fall for `__proto__` — engines create it as an ordinary
 * own property, not a prototype write — but nothing downstream is allowed
 * to assume that. This walk is the explicit, auditable backstop: it rejects
 * a document outright if `__proto__`, `constructor` or `prototype` appears
 * as an own key anywhere in it, before the document reaches anything that
 * might one day merge or assign through it.
 *
 * A depth cap turns a pathological, deeply nested payload into a rejection
 * instead of a stack overflow. Sixty-four is far beyond any shape
 * `settingsSchema` describes.
 */
const MAX_SETTINGS_JSON_DEPTH = 64;

/**
 * A destination-file rename can transiently fail on Windows — `EPERM`,
 * `EBUSY` or `EACCES` — when something else briefly holds the destination
 * path open, which a concurrent writer racing to replace the same file is
 * exactly one real example of. This is a sharing violation, not a sign the
 * operation is unsafe to retry: each attempt is still one whole-file
 * rename, so retrying never risks a partial write, only a delayed one.
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
      if (attempt === RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

export function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_SETTINGS_JSON_DEPTH) return true;
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
 * Loads `settingsFile`, failing safe on every problem.
 *
 * Never throws. A missing file, an unreadable one, malformed JSON, a
 * `__proto__`/`constructor`/`prototype` key anywhere in it, or a document
 * that fails `settingsSchema` all resolve the same way: fresh defaults from
 * {@link createDefaultSettings}. This function performs no merge of the
 * loaded document into the defaults — a document either validates in full,
 * as itself, or it is discarded in full. There is no partial-trust path.
 *
 * Never creates a file. A first launch is indistinguishable, by design, from
 * an unreadable or invalid one: both return the same fresh defaults.
 *
 * @param now UTC ISO-8601, supplied by the caller so this stays testable
 *   with a fixed clock — see {@link createDefaultSettings}.
 */
export async function loadSettings(settingsFile: string, now: string): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(settingsFile, 'utf8');
  } catch {
    // Missing file (first launch) and any other read failure (permissions,
    // a directory where the file should be, an I/O error) fail the same
    // way: safe defaults. Neither the error nor the path is surfaced.
    return createDefaultSettings(now);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createDefaultSettings(now);
  }

  if (containsForbiddenKey(parsed)) {
    return createDefaultSettings(now);
  }

  const result = settingsSchema.safeParse(parsed);
  if (!result.success) {
    return createDefaultSettings(now);
  }

  return result.data;
}

/**
 * Writes `settings` to `settingsFile` atomically.
 *
 * The document is re-validated against `settingsSchema` immediately before
 * serialising, so a caller cannot persist a value that only *claims* the
 * `Settings` type at compile time. The directory is created if missing. The
 * document is written to a uniquely named temporary file in the same
 * directory — required for the final rename to be atomic on the same
 * volume — flushed to disk, then moved into place with a single `rename`,
 * retried on a transient sharing violation (see {@link renameWithRetry}).
 * Any process observing `settingsFile` therefore only ever sees the
 * previous complete document or the new complete one, never a partial
 * write, regardless of when a crash or a concurrent write happens. On any
 * failure after the temporary file is created, it is removed before the
 * error propagates.
 */
export async function writeSettings(settingsFile: string, settings: Settings): Promise<void> {
  const validated = settingsSchema.parse(settings);
  const payload = JSON.stringify(validated, null, 2);

  const dir = dirname(settingsFile);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `${basename(settingsFile)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameWithRetry(tempFile, settingsFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
