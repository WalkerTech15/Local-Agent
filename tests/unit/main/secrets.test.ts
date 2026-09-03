import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SafeStorage } from 'electron';

import {
  clearSecret,
  hasStoredSecret,
  isSecretStoreAvailable,
  loadSecretStoreState,
  readSecret,
  SecretStoreUnavailableError,
  writeSecret,
} from '../../../src/main/secrets';

/**
 * A real, isolated temporary directory per test — never the developer's real
 * `%APPDATA%`.
 */
let dir: string;
let secretsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-secrets-'));
  secretsFile = join(dir, 'secrets.enc');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A fake `safeStorage`, symmetric enough to round-trip a real plaintext
 * without ever touching the real, platform-specific DPAPI implementation —
 * this codebase's tests never run inside a real Electron process. Every test
 * that inspects the persisted file asserts on its *shape*
 * (`schemaVersion`/`ciphertext`), never on this fake's specific encoding, so
 * nothing here is coupled to how the fake "encrypts."
 */
function createFakeSafeStorage(available = true): SafeStorage {
  // Only the synchronous trio `main/secrets.ts` actually calls
  // (`isEncryptionAvailable` / `encryptString` / `decryptString`) is
  // implemented — see that module's own doc comment on why the synchronous
  // API is the one this codebase uses. The rest of `SafeStorage` is
  // deliberately absent; the cast below is what lets this fake stand in for
  // the full interface without implementing methods nothing here calls.
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`fake-enc:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('fake-enc:')) {
        throw new Error('ciphertext was not produced by this fake');
      }
      return text.slice('fake-enc:'.length);
    },
  } as unknown as SafeStorage;
}

describe('loadSecretStoreState — absent', () => {
  it('is absent when the file does not exist', async () => {
    const state = await loadSecretStoreState(secretsFile);
    expect(state).toEqual({ kind: 'absent' });
  });

  it('never creates a file merely by reading', async () => {
    await loadSecretStoreState(secretsFile);
    await expect(readFile(secretsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never creates the parent directory merely by reading', async () => {
    const nested = join(dir, 'does', 'not', 'exist', 'secrets.enc');
    await loadSecretStoreState(nested);
    await expect(readdir(join(dir, 'does'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is absent for a valid file whose ciphertext is null (no key ever stored, or just cleared)', async () => {
    await writeFile(secretsFile, JSON.stringify({ schemaVersion: 1, ciphertext: null }), 'utf8');
    expect(await loadSecretStoreState(secretsFile)).toEqual({ kind: 'absent' });
  });

  it('reports hasStoredSecret as false when absent', async () => {
    expect(await hasStoredSecret(secretsFile)).toBe(false);
  });
});

describe('loadSecretStoreState — corrupt', () => {
  it('is corrupt for a directory where the file is expected', async () => {
    await mkdir(secretsFile);
    expect(await loadSecretStoreState(secretsFile)).toEqual({ kind: 'corrupt' });
  });

  it('is corrupt for every form of unparsable content', async () => {
    const cases: readonly [label: string, contents: string][] = [
      ['truncated object', '{"schemaVersion": 1,'],
      ['not JSON at all', 'not json at all'],
      ['empty file', ''],
      ['a bare JSON scalar', '"just a string"'],
      ['a JSON array instead of an object', '[1,2,3]'],
    ];
    for (const [, contents] of cases) {
      await writeFile(secretsFile, contents, 'utf8');
      expect(await loadSecretStoreState(secretsFile)).toEqual({ kind: 'corrupt' });
    }
  });

  it('is corrupt for a document that fails schema validation', async () => {
    const cases = [
      { schemaVersion: 2, ciphertext: null },
      { schemaVersion: 1, ciphertext: '' },
      { schemaVersion: 1 },
      { schemaVersion: 1, ciphertext: null, extra: 'field' },
    ];
    for (const candidate of cases) {
      await writeFile(secretsFile, JSON.stringify(candidate), 'utf8');
      expect(await loadSecretStoreState(secretsFile)).toEqual({ kind: 'corrupt' });
    }
  });

  it('is corrupt for a prototype-pollution key at the top level', async () => {
    await writeFile(
      secretsFile,
      '{"__proto__": {"polluted": true}, "schemaVersion": 1, "ciphertext": null}',
      'utf8',
    );
    expect(await loadSecretStoreState(secretsFile)).toEqual({ kind: 'corrupt' });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports hasStoredSecret as false when corrupt — never guesses a key is present', async () => {
    await writeFile(secretsFile, 'not json', 'utf8');
    expect(await hasStoredSecret(secretsFile)).toBe(false);
  });

  it('never exposes the raw path or parse error — the resolved state carries no such field', async () => {
    await writeFile(secretsFile, 'not json', 'utf8');
    const state = await loadSecretStoreState(secretsFile);
    expect(JSON.stringify(state)).not.toContain(dir);
    expect(state).toEqual({ kind: 'corrupt' });
  });
});

describe('isSecretStoreAvailable', () => {
  it('reflects safeStorage.isEncryptionAvailable()', () => {
    expect(isSecretStoreAvailable(createFakeSafeStorage(true))).toBe(true);
    expect(isSecretStoreAvailable(createFakeSafeStorage(false))).toBe(false);
  });

  it('treats a throwing isEncryptionAvailable as unavailable, never as available', () => {
    const throwing = {
      isEncryptionAvailable: () => {
        throw new Error('not ready');
      },
    } as unknown as SafeStorage;
    expect(isSecretStoreAvailable(throwing)).toBe(false);
  });
});

describe('writeSecret — safeStorage unavailable', () => {
  it('throws SecretStoreUnavailableError and never falls back to plaintext', async () => {
    await expect(
      writeSecret(secretsFile, 'sk-real-secret-value', createFakeSafeStorage(false)),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it('never touches the disk when unavailable', async () => {
    await expect(
      writeSecret(secretsFile, 'sk-real-secret-value', createFakeSafeStorage(false)),
    ).rejects.toThrow();
    await expect(readFile(secretsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the error message never contains the plaintext key', async () => {
    try {
      await writeSecret(secretsFile, 'sk-super-secret-value', createFakeSafeStorage(false));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('sk-super-secret-value');
    }
  });
});

describe('writeSecret / hasStoredSecret / readSecret — round trip', () => {
  it('reports present after a write, and the plaintext round-trips through readSecret', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await writeSecret(secretsFile, 'sk-real-secret-value', safeStorage);

    expect(await hasStoredSecret(secretsFile)).toBe(true);
    expect(await readSecret(secretsFile, safeStorage)).toBe('sk-real-secret-value');
  });

  it('never writes the plaintext key to disk — only the fake-encrypted ciphertext', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', createFakeSafeStorage(true));
    const raw = await readFile(secretsFile, 'utf8');
    expect(raw).not.toContain('sk-real-secret-value');
  });

  it('persists a document matching secretStoreFileSchema, base64 ciphertext', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', createFakeSafeStorage(true));
    const raw = JSON.parse(await readFile(secretsFile, 'utf8')) as {
      schemaVersion: number;
      ciphertext: string;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(Buffer.from(raw.ciphertext, 'base64').toString('utf8')).toBe(
      'fake-enc:sk-real-secret-value',
    );
  });

  it('overwrites a previously stored key with the newest write', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await writeSecret(secretsFile, 'sk-first', safeStorage);
    await writeSecret(secretsFile, 'sk-second', safeStorage);
    expect(await readSecret(secretsFile, safeStorage)).toBe('sk-second');
  });

  it('creates the parent directory if missing', async () => {
    const nested = join(dir, 'secrets', 'secrets.enc');
    await writeSecret(nested, 'sk-real-secret-value', createFakeSafeStorage(true));
    expect(await hasStoredSecret(nested)).toBe(true);
  });

  it('leaves no leftover temporary file after a successful write', async () => {
    await writeSecret(secretsFile, 'sk-real-secret-value', createFakeSafeStorage(true));
    const entries = await readdir(dir);
    expect(entries).toEqual(['secrets.enc']);
  });
});

describe('clearSecret', () => {
  it('makes hasStoredSecret false again after a key was stored', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await writeSecret(secretsFile, 'sk-real-secret-value', safeStorage);
    expect(await hasStoredSecret(secretsFile)).toBe(true);

    await clearSecret(secretsFile);
    expect(await hasStoredSecret(secretsFile)).toBe(false);
  });

  it('readSecret returns null after a clear', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await writeSecret(secretsFile, 'sk-real-secret-value', safeStorage);
    await clearSecret(secretsFile);
    expect(await readSecret(secretsFile, safeStorage)).toBeNull();
  });

  it('is safe to call when no key was ever stored', async () => {
    await expect(clearSecret(secretsFile)).resolves.toBeUndefined();
    expect(await hasStoredSecret(secretsFile)).toBe(false);
  });

  it('writes an atomic, schema-valid empty document, not a deleted file', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await writeSecret(secretsFile, 'sk-real-secret-value', safeStorage);
    await clearSecret(secretsFile);
    const raw = JSON.parse(await readFile(secretsFile, 'utf8')) as unknown;
    expect(raw).toEqual({ schemaVersion: 1, ciphertext: null });
  });
});

describe('readSecret — failure paths never throw', () => {
  it('returns null when nothing is stored', async () => {
    expect(await readSecret(secretsFile, createFakeSafeStorage(true))).toBeNull();
  });

  it('returns null when the file is corrupt', async () => {
    await writeFile(secretsFile, 'not json', 'utf8');
    expect(await readSecret(secretsFile, createFakeSafeStorage(true))).toBeNull();
  });

  it('returns null when safeStorage is unavailable at read time', async () => {
    const writer = createFakeSafeStorage(true);
    await writeSecret(secretsFile, 'sk-real-secret-value', writer);
    expect(await readSecret(secretsFile, createFakeSafeStorage(false))).toBeNull();
  });

  it('returns null, not a thrown error, when decryptString itself throws', async () => {
    await writeFile(
      secretsFile,
      JSON.stringify({ schemaVersion: 1, ciphertext: Buffer.from('garbage').toString('base64') }),
      'utf8',
    );
    const safeStorage = createFakeSafeStorage(true);
    await expect(readSecret(secretsFile, safeStorage)).resolves.toBeNull();
  });
});

describe('concurrency', () => {
  it('two concurrent writes leave exactly one valid, complete document', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await Promise.all([
      writeSecret(secretsFile, 'sk-writer-one', safeStorage),
      writeSecret(secretsFile, 'sk-writer-two', safeStorage),
    ]);

    const finalValue = await readSecret(secretsFile, safeStorage);
    expect(['sk-writer-one', 'sk-writer-two']).toContain(finalValue);
  });

  it('leaves no orphaned temporary files after many concurrent writes', async () => {
    const safeStorage = createFakeSafeStorage(true);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeSecret(secretsFile, `sk-key-${String(index)}`, safeStorage),
      ),
    );
    const entries = await readdir(dir);
    expect(entries).toEqual(['secrets.enc']);
  });
});
