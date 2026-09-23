/**
 * Validates Windows code-signing environment variables before a packaging
 * run, so a signing request that is missing a piece fails fast and loudly —
 * before a multi-minute build — instead of either silently producing an
 * unsigned installer or failing deep inside electron-builder with an
 * unclear error.
 *
 * electron-builder signs automatically, with no `electron-builder.json`
 * change, whenever it finds `CSC_LINK` (or the Windows-specific
 * `WIN_CSC_LINK`) and `CSC_KEY_PASSWORD` (or `WIN_CSC_KEY_PASSWORD`) in the
 * environment. This script does not perform signing and does not talk to
 * electron-builder at all — it only checks that a signing request looks
 * complete enough to attempt. It cannot and does not confirm the
 * certificate itself is valid, unexpired, or trusted: that can only be
 * confirmed after a real packaging run, by checking the built installer's
 * Authenticode signature. See docs/phase-3-code-signing.md.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fileExists?: (path: string) => boolean }} [deps]
 */
export function evaluateSigningConfig(env, deps = {}) {
  const fileExists = deps.fileExists ?? existsSync;

  const link = (env.CSC_LINK ?? env.WIN_CSC_LINK ?? '').trim();
  const password = (env.CSC_KEY_PASSWORD ?? env.WIN_CSC_KEY_PASSWORD ?? '').trim();

  if (link === '') {
    // No CSC_LINK anywhere: signing was not requested. This is the normal
    // state for local development and for this repository's CI today —
    // building must succeed exactly as if this script did not exist.
    return { requested: false, ok: true, problems: [] };
  }

  /** @type {string[]} */
  const problems = [];

  if (password === '') {
    problems.push(
      'CSC_LINK (or WIN_CSC_LINK) is set, but CSC_KEY_PASSWORD (or ' +
        'WIN_CSC_KEY_PASSWORD) is not. A .pfx certificate without its ' +
        'passphrase cannot be used.',
    );
  }

  // CSC_LINK may be a URL electron-builder downloads from, a base64-encoded
  // certificate, or a local file path. Only the local-path form can be
  // checked here; a URL or base64 payload is left for electron-builder
  // itself to fetch or decode and validate.
  const isUrl = /^https?:\/\//i.test(link);
  const looksBase64 = !isUrl && /^[A-Za-z0-9+/]+=*$/.test(link) && link.length > 256;
  if (!isUrl && !looksBase64 && !fileExists(link)) {
    problems.push(
      `CSC_LINK points to a local path that does not exist: "${link}". Set ` +
        'it to an existing .pfx file, to an https:// URL electron-builder ' +
        'can download it from, or to the base64-encoded certificate itself.',
    );
  }

  return { requested: true, ok: problems.length === 0, problems };
}

function main() {
  const result = evaluateSigningConfig(process.env);

  if (!result.requested) {
    console.log(
      '[check-signing-config] No CSC_LINK/WIN_CSC_LINK set — building unsigned ' +
        '(the normal local and CI default; see docs/phase-3-code-signing.md).',
    );
    return;
  }

  if (!result.ok) {
    console.error(
      '[check-signing-config] Code signing was requested (CSC_LINK is set) but ' +
        'the configuration is incomplete:',
    );
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      '[check-signing-config] Aborting before packaging. See docs/phase-3-code-signing.md.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    '[check-signing-config] Signing credentials are present and look complete. ' +
      'electron-builder will attempt to sign this build.',
  );
  console.log(
    '[check-signing-config] This only checks that the configuration is complete — ' +
      'it does not confirm the certificate is valid. Verify the built installer ' +
      'afterward with Get-AuthenticodeSignature (see docs/phase-3-code-signing.md).',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
