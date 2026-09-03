/**
 * Encrypted secret-store file schema for Local Agent.
 *
 * This describes `%APPDATA%\Local-Agent\secrets\secrets.enc`. It never
 * contains a plaintext credential: `ciphertext` is the base64 encoding of
 * whatever `Electron`'s `safeStorage.encryptString` produced (Windows DPAPI on
 * this platform), or `null` when no key is currently stored. `null` is a
 * first-class, valid state — a legitimate "no key yet" — not an error.
 *
 * This schema describes only the on-disk *shape*. It cannot and does not
 * validate that `ciphertext`, once decoded and passed to
 * `safeStorage.decryptString`, actually decrypts to anything — that can only
 * be discovered by trying, in the main process, at the moment a key is
 * actually needed. Whether decryption is possible right now is irrelevant to
 * whether a key is *present*: `main/secrets.ts`'s presence check
 * (`secrets.status`, and therefore `hasApiKey`) is answered by this schema
 * alone, never by attempting a decrypt.
 */

import { z } from 'zod';

import { SECRETS_SCHEMA_VERSION } from '../constants';

export const secretStoreFileSchema = z.strictObject({
  schemaVersion: z.literal(SECRETS_SCHEMA_VERSION),
  /** Base64 ciphertext, or `null` when no key is stored. Never plaintext. */
  ciphertext: z.string().min(1).nullable(),
});

export type SecretStoreFile = z.infer<typeof secretStoreFileSchema>;

/**
 * The file written when no key is stored — a fresh store, or one just
 * cleared. A factory, so every caller receives its own object.
 */
export function createEmptySecretStoreFile(): SecretStoreFile {
  return { schemaVersion: SECRETS_SCHEMA_VERSION, ciphertext: null };
}
