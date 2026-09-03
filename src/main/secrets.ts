/**
 * Encrypted secret storage for Local Agent.
 *
 * Reads and writes `secrets/secrets.enc`. Backed by Electron's `safeStorage`
 * — Windows DPAPI on this platform — which this module calls exactly as the
 * installed `electron@44.1.1` typings describe it, not as older documentation
 * or memory might suggest:
 *
 *  - `safeStorage.isEncryptionAvailable()` is **synchronous** and returns
 *    `boolean`.
 *  - `safeStorage.encryptString(plainText)` is **synchronous**, returns a
 *    `Buffer`, and throws if encryption fails.
 *  - `safeStorage.decryptString(encrypted)` is **synchronous**, returns a
 *    `string`, and throws if decryption fails.
 *
 * (Electron also exposes `encryptStringAsync` / `decryptStringAsync` /
 * `isAsyncEncryptionAvailable`, a separate, newer async encryptor. This
 * module deliberately uses the synchronous API throughout — DPAPI on Windows
 * needs no asynchronous initialisation, and mixing both encryptors in one
 * store would mean a value encrypted by one might not be decryptable by
 * whichever the module happens to call next.)
 *
 * Never stores plaintext as a fallback: if `isEncryptionAvailable()` is
 * `false`, {@link writeSecret} throws {@link SecretStoreUnavailableError}
 * rather than writing anything. `safeStorage` is passed in by the caller,
 * exactly as `main/settings.ts` takes a plain file path rather than resolving
 * `app.getPath` itself — this module never imports the live `electron` module
 * as a value (see `main/ipc.ts`'s note on why), and a test can supply a fake
 * implementing the same three methods with nothing else to configure.
 *
 * Presence — "does a key exist" — is answered from the *file's* shape alone
 * (`ciphertext !== null`), never by attempting a decrypt. Decryption is a
 * separate, internal-only operation ({@link readSecret}) that no IPC channel
 * exposes; Milestone 7 stores and reports on keys but calls no provider, so
 * nothing outside this module's own tests needs a decrypted value yet.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { SafeStorage } from 'electron';

import { FORBIDDEN_OBJECT_KEYS, SECRETS_SCHEMA_VERSION } from '../shared/constants';
import { createEmptySecretStoreFile, secretStoreFileSchema } from '../shared/schemas';
import type { SecretStoreFile } from '../shared/schemas';

/** Mirrors `main/settings.ts`'s own copy — see that module for the rationale. */
const MAX_SECRET_STORE_JSON_DEPTH = 64;

/**
 * Mirrors `main/settings.ts`'s retry budget exactly. A second, independent
 * copy rather than a shared import, consistent with `main/policy.ts` and
 * `main/emergency.ts`: this module should not gain a runtime dependency on an
 * already-reviewed module from an earlier milestone for one small,
 * self-contained, pure helper.
 */
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 15;

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

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_SECRET_STORE_JSON_DEPTH) return true;
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

/** Mirrors `main/emergency.ts`'s own copy — see that module for the rationale. */
function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error;
  return code === 'ENOENT';
}

/** Thrown by {@link writeSecret} when `safeStorage` reports encryption unavailable. */
export class SecretStoreUnavailableError extends Error {
  constructor() {
    super('the encrypted secret store is unavailable on this system');
    this.name = 'SecretStoreUnavailableError';
  }
}

/**
 * What {@link loadSecretStoreState} found on disk.
 *
 * `'corrupt'` and `'absent'` are reported separately so tests can tell them
 * apart, but every caller of this module treats them identically: neither
 * means a key is present. This module never guesses at, repairs, or exposes
 * the contents of a corrupt file — it is simply not trusted, exactly like a
 * missing one.
 */
export type SecretStoreState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly ciphertext: string }
  | { readonly kind: 'corrupt' };

/**
 * Loads `secretsFile`, never throwing and never exposing the raw error, the
 * path, or the file's contents. A missing file, an unreadable one, malformed
 * JSON, a `__proto__`/`constructor`/`prototype` key anywhere in it, or a
 * document that fails `secretStoreFileSchema` are all reported as
 * `'corrupt'` except a genuinely missing file, reported as `'absent'` — both
 * mean "no usable key," so every caller of this module treats them the same
 * way; the distinction exists only so a test can assert the right one
 * happened. A valid file whose `ciphertext` is `null` (no key ever stored, or
 * one just cleared) is `'absent'` too.
 *
 * Never creates a file.
 */
export async function loadSecretStoreState(secretsFile: string): Promise<SecretStoreState> {
  let raw: string;
  try {
    raw = await readFile(secretsFile, 'utf8');
  } catch (error) {
    return isEnoent(error) ? { kind: 'absent' } : { kind: 'corrupt' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }

  if (containsForbiddenKey(parsed)) {
    return { kind: 'corrupt' };
  }

  const result = secretStoreFileSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'corrupt' };
  }

  return result.data.ciphertext === null
    ? { kind: 'absent' }
    : { kind: 'present', ciphertext: result.data.ciphertext };
}

/**
 * Whether a key is currently stored, from the file's shape alone — never by
 * attempting a decrypt. This is the presence check `secrets.status` and
 * `hasApiKey` reconciliation (`main/settings-service.ts`) are built on.
 */
export async function hasStoredSecret(secretsFile: string): Promise<boolean> {
  const state = await loadSecretStoreState(secretsFile);
  return state.kind === 'present';
}

/**
 * Writes `file` to `secretsFile` atomically. Mirrors
 * `main/settings.ts`'s `writeSettings` exactly: validate immediately before
 * serialising, write to a uniquely named temporary file in the same
 * directory, flush, then a single retried `rename`. Any process observing
 * `secretsFile` only ever sees the previous complete document or the new
 * complete one.
 */
async function writeSecretStoreFile(secretsFile: string, file: SecretStoreFile): Promise<void> {
  const validated = secretStoreFileSchema.parse(file);
  const payload = JSON.stringify(validated, null, 2);

  const dir = dirname(secretsFile);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `${basename(secretsFile)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameWithRetry(tempFile, secretsFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Whether `safeStorage` can currently encrypt or decrypt. Wrapped in
 * `try`/`catch` because Electron's own doc for `isEncryptionAvailable` does
 * not guarantee it never throws before the app is fully ready; a thrown
 * check is treated the same as `false` — unavailable — never as available.
 */
export function isSecretStoreAvailable(safeStorage: SafeStorage): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Encrypts `plaintext` with `safeStorage.encryptString` and persists it.
 *
 * Never falls back to storing plaintext: if `safeStorage` reports encryption
 * unavailable, this throws {@link SecretStoreUnavailableError} before
 * touching the disk at all. `plaintext` itself is never logged, never placed
 * in an error message, and never appears in the returned promise's
 * resolution — this function resolves to `void`.
 */
export async function writeSecret(
  secretsFile: string,
  plaintext: string,
  safeStorage: SafeStorage,
): Promise<void> {
  if (!isSecretStoreAvailable(safeStorage)) {
    throw new SecretStoreUnavailableError();
  }

  const ciphertext = safeStorage.encryptString(plaintext).toString('base64');

  await writeSecretStoreFile(secretsFile, {
    schemaVersion: SECRETS_SCHEMA_VERSION,
    ciphertext,
  });
}

/**
 * Clears any stored key by persisting the empty store file — never by
 * deleting `secretsFile`, so the write goes through the same atomic path
 * (and the same failure guarantees) as every other write in this module.
 */
export async function clearSecret(secretsFile: string): Promise<void> {
  await writeSecretStoreFile(secretsFile, createEmptySecretStoreFile());
}

/**
 * Decrypts and returns the stored key, or `null` if none is stored, the file
 * is corrupt, `safeStorage` is unavailable, or decryption otherwise fails.
 * Every failure path returns `null` rather than throwing — this function
 * never raises an error that could carry ciphertext or a storage path in its
 * message.
 *
 * **Internal only.** No IPC channel calls this, and none should: exposing a
 * decrypted key to the renderer is exactly what this codebase's secret-store
 * rules forbid. It exists for this module's own tests, and for a future
 * milestone that actually calls a provider from the main process.
 */
export async function readSecret(
  secretsFile: string,
  safeStorage: SafeStorage,
): Promise<string | null> {
  const state = await loadSecretStoreState(secretsFile);
  if (state.kind !== 'present') return null;
  if (!isSecretStoreAvailable(safeStorage)) return null;

  try {
    return safeStorage.decryptString(Buffer.from(state.ciphertext, 'base64'));
  } catch {
    return null;
  }
}
