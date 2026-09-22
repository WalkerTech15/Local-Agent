import { describe, expect, it } from 'vitest';

import { findLikelySecret, looksLikeSecret } from '../../../src/shared/memory/secret-scan';

/**
 * The credential-shaped content screen.
 *
 * Two halves matter equally. The first is that recognisable credentials are
 * refused — that is the control. The second is that ordinary notes about
 * security *topics* are not, because a screen that refused every note
 * mentioning a password would be turned off, and a control that is turned off
 * protects nothing.
 */
describe('recognisable credential shapes', () => {
  it('refuses a PEM private key block', () => {
    expect(findLikelySecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')).toBe('private-key');
    expect(findLikelySecret('-----BEGIN PRIVATE KEY-----')).toBe('private-key');
    expect(findLikelySecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('private-key');
  });

  it('refuses known provider key prefixes', () => {
    const samples = [
      'sk-abcdefghijklmnopqrstuvwx',
      'use sk-proj-abcdefghijklmnopqrstuvwx for this',
      'sk_live_abcdefghijklmnopqrst',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'glpat-abcdefghijklmnopqrst',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyA1234567890abcdefghijklmnopqrst',
      'hf_abcdefghijklmnopqrstuvwxyz',
    ];
    for (const sample of samples) {
      expect(findLikelySecret(sample), sample).toBe('known-key-prefix');
    }
  });

  it('refuses an Authorization bearer header pasted from a network tab', () => {
    expect(findLikelySecret('Authorization: Bearer abcdefghijklmnopqrstuvwx')).not.toBeNull();
    expect(findLikelySecret('bearer abcdefghijklmnopqrstuvwx')).toBe('bearer-token');
  });

  it('refuses a credential-shaped label followed by a value', () => {
    expect(findLikelySecret('password: hunter2hunter2')).toBe('labelled-secret');
    expect(findLikelySecret('api_key = 9f8e7d6c5b4a3210')).toBe('labelled-secret');
    expect(findLikelySecret('"client_secret": "abcdefgh12345678"')).toBe('labelled-secret');
    expect(findLikelySecret('Passphrase = correct-horse-battery')).toBe('labelled-secret');
  });

  it('refuses a long mixed-case high-entropy token with no known prefix', () => {
    expect(findLikelySecret(`token is ${'aB3'.repeat(15)}`)).not.toBeNull();
    expect(findLikelySecret('QWErty1234QWErty1234QWErty1234QWErty1234ZZ')).toBe(
      'high-entropy-token',
    );
  });

  it('reports a shape, never the matched text', () => {
    const hint = findLikelySecret('password: hunter2hunter2');
    expect(hint).not.toBeNull();
    expect(hint).not.toContain('hunter2');
  });

  it('is stable across repeated calls despite global patterns', () => {
    const sample = 'password: hunter2hunter2';
    expect(findLikelySecret(sample)).toBe('labelled-secret');
    expect(findLikelySecret(sample)).toBe('labelled-secret');
    expect(findLikelySecret(sample)).toBe('labelled-secret');
  });
});

describe('ordinary notes are not refused', () => {
  it('accepts notes that merely discuss credentials', () => {
    const samples = [
      'Never store the API key in settings.json — it belongs in the encrypted store.',
      'The password reset flow needs a test.',
      'Ask before rotating any token.',
      'Prefers short answers and no emoji.',
      'Use kebab-case for file names in this project.',
      'The build fails when NODE_OPTIONS is set.',
      'Decision: we keep the permission engine pure, with no I/O.',
    ];
    for (const sample of samples) {
      expect(looksLikeSecret(sample), sample).toBe(false);
    }
  });

  it('accepts long identifiers that are not high-entropy tokens', () => {
    const samples = [
      'src/shared/schemas/permissions.schema.ts is the single source of truth',
      'a-very-long-kebab-case-identifier-that-goes-on-and-on-for-a-while',
      'https://example.com/documentation/getting-started/installation/windows',
    ];
    for (const sample of samples) {
      expect(looksLikeSecret(sample), sample).toBe(false);
    }
  });

  it('accepts a short value after a credential-shaped label', () => {
    // "the password is wrong" has a value too short to be a credential; this
    // is the bound that keeps the labelled-secret rule from matching prose.
    expect(looksLikeSecret('the password is wrong')).toBe(false);
  });

  it('accepts a word that merely starts like a known prefix', () => {
    expect(looksLikeSecret('skateboarding is a hobby, not a task')).toBe(false);
    expect(looksLikeSecret('AKIA is an AWS key prefix worth knowing')).toBe(false);
  });

  it('accepts the empty string', () => {
    expect(looksLikeSecret('')).toBe(false);
  });
});
