import { describe, expect, it } from 'vitest';

import { evaluateSigningConfig } from '../../../scripts/check-signing-config.mjs';

const noFile = () => false;
const hasFile = () => true;

describe('evaluateSigningConfig', () => {
  it('is not requested, and passes, when no CSC_LINK is set anywhere', () => {
    expect(evaluateSigningConfig({}, { fileExists: noFile })).toEqual({
      requested: false,
      ok: true,
      problems: [],
    });
    expect(evaluateSigningConfig({ CSC_KEY_PASSWORD: 'x' }, { fileExists: noFile })).toEqual({
      requested: false,
      ok: true,
      problems: [],
    });
  });

  it('treats a blank CSC_LINK the same as an unset one', () => {
    expect(evaluateSigningConfig({ CSC_LINK: '   ' }, { fileExists: noFile })).toEqual({
      requested: false,
      ok: true,
      problems: [],
    });
  });

  it('is requested but fails when CSC_LINK is set with no password', () => {
    const result = evaluateSigningConfig(
      { CSC_LINK: 'C:\\certs\\local-agent.pfx' },
      { fileExists: hasFile },
    );
    expect(result.requested).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/CSC_KEY_PASSWORD/);
  });

  it('is requested but fails when the local certificate file does not exist', () => {
    const result = evaluateSigningConfig(
      { CSC_LINK: 'C:\\certs\\missing.pfx', CSC_KEY_PASSWORD: 'secret' },
      { fileExists: noFile },
    );
    expect(result.requested).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/does not exist/);
  });

  it('reports both problems when the password is missing and the file does not exist', () => {
    const result = evaluateSigningConfig(
      { CSC_LINK: 'C:\\certs\\missing.pfx' },
      { fileExists: noFile },
    );
    expect(result.requested).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
  });

  it('passes when CSC_LINK is a local file that exists and a password is set', () => {
    const result = evaluateSigningConfig(
      { CSC_LINK: 'C:\\certs\\local-agent.pfx', CSC_KEY_PASSWORD: 'secret' },
      { fileExists: hasFile },
    );
    expect(result).toEqual({ requested: true, ok: true, problems: [] });
  });

  it('passes for an https:// CSC_LINK without checking the filesystem', () => {
    const result = evaluateSigningConfig(
      {
        CSC_LINK: 'https://example.com/certs/local-agent.pfx',
        CSC_KEY_PASSWORD: 'secret',
      },
      { fileExists: noFile },
    );
    expect(result).toEqual({ requested: true, ok: true, problems: [] });
  });

  it('passes for a long base64-looking CSC_LINK without checking the filesystem', () => {
    const base64Payload = 'A'.repeat(300);
    const result = evaluateSigningConfig(
      { CSC_LINK: base64Payload, CSC_KEY_PASSWORD: 'secret' },
      { fileExists: noFile },
    );
    expect(result).toEqual({ requested: true, ok: true, problems: [] });
  });

  it('accepts the Windows-specific WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD variables', () => {
    const result = evaluateSigningConfig(
      { WIN_CSC_LINK: 'C:\\certs\\local-agent.pfx', WIN_CSC_KEY_PASSWORD: 'secret' },
      { fileExists: hasFile },
    );
    expect(result).toEqual({ requested: true, ok: true, problems: [] });
  });

  it('prefers CSC_LINK over WIN_CSC_LINK when both are set', () => {
    const result = evaluateSigningConfig(
      {
        CSC_LINK: 'C:\\certs\\missing.pfx',
        CSC_KEY_PASSWORD: 'secret',
        WIN_CSC_LINK: 'https://example.com/certs/local-agent.pfx',
        WIN_CSC_KEY_PASSWORD: 'secret',
      },
      { fileExists: noFile },
    );
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/missing\.pfx/);
  });
});
