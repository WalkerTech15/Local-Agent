import { describe, expect, it } from 'vitest';

import { evaluateReleaseMetadata } from '../../../scripts/check-release-metadata.mjs';

const validPkg = { version: '0.1.0', author: { name: 'Local Agent Project' } };

describe('evaluateReleaseMetadata', () => {
  it('passes for a plain semver version and a present author, with no release requested', () => {
    expect(evaluateReleaseMetadata(validPkg, {})).toEqual({
      releaseRequested: false,
      ok: true,
      problems: [],
    });
  });

  it('accepts a string-form author in addition to the object form', () => {
    const result = evaluateReleaseMetadata({ version: '1.2.3', author: 'Someone' }, {});
    expect(result.ok).toBe(true);
  });

  it('fails when the version is missing', () => {
    const result = evaluateReleaseMetadata({ author: { name: 'x' } }, {});
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('version'))).toBe(true);
  });

  it.each(['1', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', ''])(
    'fails for a non-plain-semver version: %s',
    (version) => {
      const result = evaluateReleaseMetadata({ version, author: { name: 'x' } }, {});
      expect(result.ok).toBe(false);
    },
  );

  it('fails when the author has no name', () => {
    const result = evaluateReleaseMetadata({ version: '0.1.0', author: { name: '' } }, {});
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('author'))).toBe(true);
  });

  it('fails when author is entirely absent', () => {
    const result = evaluateReleaseMetadata({ version: '0.1.0' }, {});
    expect(result.ok).toBe(false);
  });

  it('does not require a real author name when no release is requested, even the placeholder', () => {
    const result = evaluateReleaseMetadata(validPkg, {});
    expect(result.ok).toBe(true);
  });

  it('fails when a release is requested and the author is still the shipped placeholder', () => {
    const result = evaluateReleaseMetadata(validPkg, { LOCAL_AGENT_RELEASE: '1' });
    expect(result.releaseRequested).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('placeholder'))).toBe(true);
  });

  it('passes when a release is requested and the author is no longer the placeholder', () => {
    const result = evaluateReleaseMetadata(
      { version: '0.1.0', author: { name: 'Real Publisher Inc.' } },
      { LOCAL_AGENT_RELEASE: '1' },
    );
    expect(result).toEqual({ releaseRequested: true, ok: true, problems: [] });
  });

  it('fails when the release tag does not match package.json version', () => {
    const result = evaluateReleaseMetadata(
      { version: '0.1.0', author: { name: 'Real Publisher Inc.' } },
      { LOCAL_AGENT_RELEASE: '1', LOCAL_AGENT_RELEASE_TAG: 'v0.2.0' },
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('does not match'))).toBe(true);
  });

  it('passes when the release tag matches package.json version, with or without a "v" prefix', () => {
    for (const tag of ['0.1.0', 'v0.1.0']) {
      const result = evaluateReleaseMetadata(
        { version: '0.1.0', author: { name: 'Real Publisher Inc.' } },
        { LOCAL_AGENT_RELEASE: '1', LOCAL_AGENT_RELEASE_TAG: tag },
      );
      expect(result.ok, tag).toBe(true);
    }
  });

  it('ignores LOCAL_AGENT_RELEASE_TAG entirely when a release is not requested', () => {
    const result = evaluateReleaseMetadata(validPkg, { LOCAL_AGENT_RELEASE_TAG: 'v9.9.9' });
    expect(result.releaseRequested).toBe(false);
    expect(result.ok).toBe(true);
  });
});
