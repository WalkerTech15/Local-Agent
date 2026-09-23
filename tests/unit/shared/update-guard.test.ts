import { describe, expect, it } from 'vitest';

import { canInstallUpdate } from '../../../src/shared/update/guard';
import type { UpdateInstallApproval } from '../../../src/shared/update/guard';
import type { UpdateState } from '../../../src/shared/update/states';

const fullApproval: UpdateInstallApproval = {
  sourceTrusted: true,
  signatureValid: true,
  userApproved: true,
};

describe('canInstallUpdate', () => {
  it('allows installation only when downloaded, trusted, signed, and approved all hold', () => {
    expect(canInstallUpdate('downloaded', fullApproval)).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('refuses when the state is anything other than downloaded', () => {
    const states: UpdateState[] = [
      'disabled',
      'idle',
      'checking',
      'available',
      'downloading',
      'error',
    ];
    for (const state of states) {
      const result = canInstallUpdate(state, fullApproval);
      expect(result.allowed, state).toBe(false);
      expect(result.reasons, state).toContain('UPDATE_DOWNLOAD_FAILED');
    }
  });

  it('refuses when the source is not the configured trusted one, even if everything else holds', () => {
    const result = canInstallUpdate('downloaded', { ...fullApproval, sourceTrusted: false });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('UPDATE_UNTRUSTED_SOURCE');
  });

  it('refuses when the signature did not verify, even if everything else holds', () => {
    const result = canInstallUpdate('downloaded', { ...fullApproval, signatureValid: false });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('UPDATE_INVALID_SIGNATURE');
  });

  it('refuses when the user did not explicitly approve, even if everything else holds', () => {
    const result = canInstallUpdate('downloaded', { ...fullApproval, userApproved: false });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('UPDATE_NOT_APPROVED');
  });

  it('reports every failing reason at once, not just the first', () => {
    const result = canInstallUpdate('available', {
      sourceTrusted: false,
      signatureValid: false,
      userApproved: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toHaveLength(4);
  });
});
