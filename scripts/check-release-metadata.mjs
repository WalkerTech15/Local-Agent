/**
 * Validates release-relevant `package.json` metadata before a packaging run
 * — the same "fail fast, before any build work" shape as
 * `check-signing-config.mjs` and `check-update-config.mjs`.
 *
 * Two tiers, deliberately:
 *
 * - **Always checked**, on every `npm run package:win`, release or not:
 *   `version` is a plain `X.Y.Z` semver string, and `author.name` is
 *   present. Both are true of this repository's `package.json` today, so
 *   this tier changes nothing about an ordinary local or CI build — it only
 *   guards against a future edit that breaks either by accident.
 * - **Checked only when `LOCAL_AGENT_RELEASE=1`** — an explicit "this is a
 *   real release build" signal nothing sets today: `author.name` must no
 *   longer be the placeholder this repository ships with, and, if
 *   `LOCAL_AGENT_RELEASE_TAG` is also set (CI sets it from the pushed git
 *   tag — see `docs/phase-3-first-release.md`), that tag's version must
 *   equal `package.json`'s `version` exactly, so a build can never be
 *   packaged under a tag that does not match what is actually inside it.
 *
 * Does not publish, tag, or upload anything, and does not touch
 * `package.json` — it only reads it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER_AUTHOR_NAME = 'Local Agent Project';

/**
 * @param {{ version?: unknown, author?: unknown }} pkg
 * @param {NodeJS.ProcessEnv} env
 */
export function evaluateReleaseMetadata(pkg, env) {
  const problems = [];

  const version = typeof pkg.version === 'string' ? pkg.version : '';
  if (!SEMVER_PATTERN.test(version)) {
    problems.push(`package.json "version" ("${version}") is not a plain semver "X.Y.Z" string.`);
  }

  const authorName =
    typeof pkg.author === 'string'
      ? pkg.author
      : typeof pkg.author === 'object' && pkg.author !== null && 'name' in pkg.author
        ? String(/** @type {{ name: unknown }} */ (pkg.author).name)
        : '';
  if (authorName.trim() === '') {
    problems.push('package.json "author" has no name.');
  }

  const releaseRequested = env.LOCAL_AGENT_RELEASE === '1';
  if (releaseRequested) {
    if (authorName === PLACEHOLDER_AUTHOR_NAME) {
      problems.push(
        `package.json "author.name" is still the placeholder "${PLACEHOLDER_AUTHOR_NAME}" ` +
          '— replace it with the real publisher identity before a real release (see ' +
          'docs/phase-3-code-signing.md).',
      );
    }

    const tag = (env.LOCAL_AGENT_RELEASE_TAG ?? '').trim();
    if (tag !== '') {
      const tagVersion = tag.replace(/^v/, '');
      if (SEMVER_PATTERN.test(version) && tagVersion !== version) {
        problems.push(
          `LOCAL_AGENT_RELEASE_TAG "${tag}" does not match package.json "version" "${version}".`,
        );
      }
    }
  }

  return { releaseRequested, ok: problems.length === 0, problems };
}

function main() {
  /** @type {{ version?: unknown, author?: unknown }} */
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const result = evaluateReleaseMetadata(pkg, process.env);

  if (!result.ok) {
    console.error('[check-release-metadata] Release metadata is invalid:');
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      '[check-release-metadata] Aborting before packaging. See docs/phase-3-first-release.md.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    result.releaseRequested
      ? '[check-release-metadata] Release metadata is valid for a real release build ' +
          `(version "${pkg.version}").`
      : `[check-release-metadata] Release metadata is valid (version "${pkg.version}"). ` +
          'LOCAL_AGENT_RELEASE is not "1", so this is an ordinary build, not a release build.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
