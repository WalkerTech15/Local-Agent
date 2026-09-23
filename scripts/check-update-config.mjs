/**
 * Validates Windows auto-update environment variables before a packaging
 * run, exactly as `check-signing-config.mjs` does for signing — so an
 * incomplete or unsafe update request fails fast and loudly instead of
 * quietly producing a build that would, in some future milestone that wires
 * a real updater, try to ship updates it cannot actually deliver safely.
 *
 * This script does not perform an update check, does not download anything,
 * and does not talk to any update provider. No such caller exists in this
 * repository yet — see docs/phase-3-auto-update.md for what is and is not
 * implemented. It only checks that an update request looks complete and
 * safe enough to prepare for: specifically, that `LOCAL_AGENT_ENABLE_UPDATES`
 * is never set without a valid trusted feed URL, a recognized provider, AND
 * a complete, signed-build configuration — enforced here by reusing
 * `evaluateSigningConfig` rather than restating its rules, because an
 * update mechanism that could ship an unsigned build would be strictly
 * worse than shipping no update mechanism at all (see
 * docs/phase-3-code-signing.md and docs/phase-3-auto-update.md).
 */
import { fileURLToPath } from 'node:url';

import { evaluateSigningConfig } from './check-signing-config.mjs';

export const UPDATE_PROVIDERS = ['github', 'generic'];

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fileExists?: (path: string) => boolean, evaluateSigningConfig?: typeof evaluateSigningConfig }} [deps]
 */
export function evaluateUpdateConfig(env, deps = {}) {
  const checkSigning = deps.evaluateSigningConfig ?? evaluateSigningConfig;

  const optedIn = env.LOCAL_AGENT_ENABLE_UPDATES === '1';
  if (!optedIn) {
    // Updates were not requested: this is the normal, safe default for
    // local development and for this repository's CI today. Every other
    // check below is skipped, exactly as check-signing-config.mjs skips its
    // own checks when CSC_LINK is unset.
    return { requested: false, ok: true, problems: [] };
  }

  /** @type {string[]} */
  const problems = [];

  const feedUrl = (env.LOCAL_AGENT_UPDATE_FEED_URL ?? '').trim();
  if (feedUrl === '') {
    problems.push('LOCAL_AGENT_ENABLE_UPDATES is "1" but LOCAL_AGENT_UPDATE_FEED_URL is not set.');
  } else if (!isHttpsUrl(feedUrl)) {
    problems.push(`LOCAL_AGENT_UPDATE_FEED_URL is not a valid https:// URL: "${feedUrl}".`);
  }

  const provider = (env.LOCAL_AGENT_UPDATE_PROVIDER ?? '').trim();
  if (!UPDATE_PROVIDERS.includes(provider)) {
    problems.push(
      `LOCAL_AGENT_UPDATE_PROVIDER must be one of: ${UPDATE_PROVIDERS.join(', ')} (got "${provider === '' ? '(unset)' : provider}").`,
    );
  }

  const signingResult = checkSigning(env, deps);
  if (!signingResult.requested || !signingResult.ok) {
    problems.push(
      'LOCAL_AGENT_ENABLE_UPDATES is "1" but code signing is not fully configured ' +
        '(CSC_LINK/WIN_CSC_LINK and CSC_KEY_PASSWORD/WIN_CSC_KEY_PASSWORD). An update ' +
        'mechanism must only ever be enabled for signed releases — see ' +
        'docs/phase-3-code-signing.md.',
    );
  }

  return { requested: true, ok: problems.length === 0, problems };
}

function main() {
  const result = evaluateUpdateConfig(process.env);

  if (!result.requested) {
    console.log(
      '[check-update-config] LOCAL_AGENT_ENABLE_UPDATES is not "1" — updates stay disabled ' +
        '(the normal local and CI default; see docs/phase-3-auto-update.md).',
    );
    return;
  }

  if (!result.ok) {
    console.error(
      '[check-update-config] Auto-update was requested (LOCAL_AGENT_ENABLE_UPDATES=1) but ' +
        'the configuration is incomplete or unsafe:',
    );
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      '[check-update-config] Aborting before packaging. See docs/phase-3-auto-update.md.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    '[check-update-config] Update configuration is present, complete, and paired with a ' +
      'complete signing configuration.',
  );
  console.log(
    '[check-update-config] No update check, download, or install was performed — this ' +
      'repository has no code path that does any of those yet. See ' +
      'docs/phase-3-auto-update.md.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
