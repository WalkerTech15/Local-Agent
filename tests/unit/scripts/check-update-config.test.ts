import { describe, expect, it } from 'vitest';

import { evaluateUpdateConfig } from '../../../scripts/check-update-config.mjs';

const fullySigned = () => ({ requested: true, ok: true, problems: [] });
const notSigned = () => ({ requested: false, ok: true, problems: [] });
const incompleteSigning = () => ({
  requested: true,
  ok: false,
  problems: ['signing is incomplete'],
});

describe('evaluateUpdateConfig', () => {
  it('is not requested, and passes, when LOCAL_AGENT_ENABLE_UPDATES is unset', () => {
    expect(evaluateUpdateConfig({}, { evaluateSigningConfig: fullySigned })).toEqual({
      requested: false,
      ok: true,
      problems: [],
    });
  });

  it('is not requested when LOCAL_AGENT_ENABLE_UPDATES is anything other than exactly "1"', () => {
    for (const value of ['true', 'yes', '0', '']) {
      expect(
        evaluateUpdateConfig(
          { LOCAL_AGENT_ENABLE_UPDATES: value },
          { evaluateSigningConfig: fullySigned },
        ).requested,
        value,
      ).toBe(false);
    }
  });

  it('fails when enabled without a feed URL', () => {
    const result = evaluateUpdateConfig(
      { LOCAL_AGENT_ENABLE_UPDATES: '1', LOCAL_AGENT_UPDATE_PROVIDER: 'github' },
      { evaluateSigningConfig: fullySigned },
    );
    expect(result.requested).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('LOCAL_AGENT_UPDATE_FEED_URL'))).toBe(true);
  });

  it('fails when the feed URL is not https', () => {
    const result = evaluateUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'http://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      { evaluateSigningConfig: fullySigned },
    );
    expect(result.ok).toBe(false);
  });

  it('fails when the provider is not recognized', () => {
    const result = evaluateUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'dropbox',
      },
      { evaluateSigningConfig: fullySigned },
    );
    expect(result.ok).toBe(false);
  });

  it('fails when otherwise complete but code signing is not configured', () => {
    const result = evaluateUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      { evaluateSigningConfig: notSigned },
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.toLowerCase().includes('signing'))).toBe(true);
  });

  it('fails when signing was requested but is itself incomplete', () => {
    const result = evaluateUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      { evaluateSigningConfig: incompleteSigning },
    );
    expect(result.ok).toBe(false);
  });

  it('passes when the update request and the signing configuration are both complete', () => {
    const result = evaluateUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      { evaluateSigningConfig: fullySigned },
    );
    expect(result).toEqual({ requested: true, ok: true, problems: [] });
  });

  it('uses the real evaluateSigningConfig by default and fails closed with no signing env set', () => {
    const result = evaluateUpdateConfig({
      LOCAL_AGENT_ENABLE_UPDATES: '1',
      LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
      LOCAL_AGENT_UPDATE_PROVIDER: 'github',
    });
    // No CSC_LINK anywhere in this test's env means signing was never
    // requested either, which this module treats as unsafe to pair with an
    // enabled update mechanism.
    expect(result.ok).toBe(false);
  });
});
