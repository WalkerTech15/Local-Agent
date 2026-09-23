import { describe, expect, it } from 'vitest';

import { resolveUpdateConfig } from '../../../src/shared/update/config';

const packaged = { isPackaged: true };
const dev = { isPackaged: false };

describe('resolveUpdateConfig', () => {
  it('is disabled by default with no environment variables set', () => {
    const result = resolveUpdateConfig({}, packaged);
    expect(result.enabled).toBe(false);
    expect(result.provider).toBeNull();
    expect(result.feedUrl).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('stays disabled in a development (unpackaged) run, even with full configuration', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      dev,
    );
    expect(result.enabled).toBe(false);
    expect(result.reasons).toContain('this is not a packaged, installed build');
  });

  it('stays disabled without the explicit opt-in, even with everything else set', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      packaged,
    );
    expect(result.enabled).toBe(false);
  });

  it('stays disabled with a non-https feed URL', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'http://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      packaged,
    );
    expect(result.enabled).toBe(false);
    expect(result.reasons).toContain('LOCAL_AGENT_UPDATE_FEED_URL is not a valid https:// URL');
  });

  it('stays disabled with a malformed feed URL', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'not a url',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      packaged,
    );
    expect(result.enabled).toBe(false);
  });

  it('stays disabled with an unrecognized provider', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'dropbox',
      },
      packaged,
    );
    expect(result.enabled).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('LOCAL_AGENT_UPDATE_PROVIDER'))).toBe(
      true,
    );
  });

  it('is enabled only when every condition holds at once', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_ENABLE_UPDATES: '1',
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'generic',
      },
      packaged,
    );
    expect(result).toEqual({
      enabled: true,
      provider: 'generic',
      feedUrl: 'https://example.com/updates',
      reasons: [],
    });
  });

  it('never returns a provider or feed URL when disabled, even if they were set', () => {
    const result = resolveUpdateConfig(
      {
        LOCAL_AGENT_UPDATE_FEED_URL: 'https://example.com/updates',
        LOCAL_AGENT_UPDATE_PROVIDER: 'github',
      },
      dev,
    );
    expect(result.enabled).toBe(false);
    expect(result.provider).toBeNull();
    expect(result.feedUrl).toBeNull();
  });
});
