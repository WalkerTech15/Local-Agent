import { describe, expect, it } from 'vitest';

import {
  createEmptySecretStoreFile,
  secretStoreFileSchema,
} from '../../../src/shared/schemas/secrets.schema';

describe('createEmptySecretStoreFile', () => {
  it('has a null ciphertext', () => {
    expect(createEmptySecretStoreFile()).toEqual({ schemaVersion: 1, ciphertext: null });
  });

  it('returns a fresh object on every call', () => {
    expect(createEmptySecretStoreFile()).not.toBe(createEmptySecretStoreFile());
  });

  it('validates against secretStoreFileSchema', () => {
    expect(secretStoreFileSchema.safeParse(createEmptySecretStoreFile()).success).toBe(true);
  });
});

describe('secretStoreFileSchema — valid', () => {
  it('accepts a null ciphertext', () => {
    expect(secretStoreFileSchema.safeParse({ schemaVersion: 1, ciphertext: null }).success).toBe(
      true,
    );
  });

  it('accepts a non-empty ciphertext string', () => {
    const result = secretStoreFileSchema.safeParse({ schemaVersion: 1, ciphertext: 'YWJj' });
    expect(result.success).toBe(true);
  });
});

describe('secretStoreFileSchema — invalid', () => {
  it('rejects an empty-string ciphertext (must be null, never empty)', () => {
    expect(secretStoreFileSchema.safeParse({ schemaVersion: 1, ciphertext: '' }).success).toBe(
      false,
    );
  });

  it('rejects the wrong schema version', () => {
    expect(secretStoreFileSchema.safeParse({ schemaVersion: 2, ciphertext: null }).success).toBe(
      false,
    );
  });

  it('rejects an unknown key', () => {
    const result = secretStoreFileSchema.safeParse({
      schemaVersion: 1,
      ciphertext: null,
      plaintext: 'sk-hostile',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing ciphertext field', () => {
    expect(secretStoreFileSchema.safeParse({ schemaVersion: 1 }).success).toBe(false);
  });

  it('rejects a non-string, non-null ciphertext', () => {
    expect(secretStoreFileSchema.safeParse({ schemaVersion: 1, ciphertext: 123 }).success).toBe(
      false,
    );
  });
});
