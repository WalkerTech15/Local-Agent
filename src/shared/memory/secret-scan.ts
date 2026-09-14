/**
 * Credential-shaped content detection for memory records (Phase 2, M8).
 *
 * The milestone's rule is "never store API keys, tokens, passwords,
 * credentials, or raw secrets". Two of this codebase's existing controls
 * already cover most of that surface and neither is enough on its own here:
 *
 *  - The **field-name denylist** (`SECRET_FIELD_NAMES`) refuses a field
 *    *called* something credential-shaped. A memory record has exactly one
 *    content field, always called `content`, so a name denylist sees nothing.
 *  - The **schema** refuses a field this application never declared. A person
 *    pasting a key into the note box is not adding a field; they are filling
 *    in the one that exists.
 *
 * So this module looks at the **value**, which is the only place left. It is
 * applied at the write boundary — `add`, `update` and `import` — and
 * deliberately **not** inside the persisted-record schema: a record that is
 * already stored must keep loading, because a loader that started refusing
 * documents on a rule added later would discard a whole file of legitimate
 * notes the next time the rule tightened.
 *
 * ## What this is not
 *
 * This is a **best-effort control, never a guarantee**, and it is important
 * that it is described that way everywhere it appears. A credential is just a
 * string; a sufficiently ordinary-looking one — a short database password, a
 * PIN, a passphrase made of real words — is indistinguishable from a note by
 * any local rule, and no amount of pattern-writing changes that. What this
 * does buy is that the *recognisable* shapes — a provider key with a known
 * prefix, an `Authorization: Bearer` header pasted out of a browser's network
 * tab, a PEM private key, a `password=…` line copied from a config file —
 * are refused at the boundary rather than written to disk and later exported.
 *
 * It returns a **category**, never the matched text. Echoing back the
 * fragment that looked like a secret would put the secret into an error path,
 * which is the one place it must never reach.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { isSecretFieldName } from '../constants';

/**
 * Why something was refused. Bounded and non-revealing: each value names a
 * *shape*, so it can be displayed and logged without disclosing the value.
 */
export const MEMORY_SECRET_HINTS = [
  'known-key-prefix',
  'bearer-token',
  'private-key',
  'labelled-secret',
  'high-entropy-token',
] as const;

export type MemorySecretHint = (typeof MEMORY_SECRET_HINTS)[number];

/**
 * Prefixes real providers use for issued credentials.
 *
 * Each is anchored to a token boundary below, so the word "task" does not
 * match `sk-` and a sentence mentioning Amazon does not match `AKIA`. The
 * list is illustrative of the common shapes, not exhaustive — which is the
 * whole reason the generic checks below exist as well.
 */
const KNOWN_KEY_PATTERNS: readonly RegExp[] = [
  // OpenAI and the many OpenAI-compatible services: sk-…, sk-proj-…
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  // Stripe-style live/test keys.
  /(?:^|[^A-Za-z0-9])[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  // GitHub personal-access and app tokens.
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  // GitLab personal-access tokens.
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/,
  // Slack bot/user tokens.
  /(?:^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/,
  // AWS access-key ids.
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/,
  // Google API keys and OAuth access tokens.
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}/,
  /(?:^|[^A-Za-z0-9])ya29\.[A-Za-z0-9._-]{20,}/,
  // Hugging Face and SendGrid.
  /(?:^|[^A-Za-z0-9])hf_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
];

/** An `Authorization: Bearer …` header, however it was spaced or cased. */
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i;

/** A PEM block header. Covers RSA, EC, OPENSSH and the unlabelled form. */
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/;

/**
 * A credential-shaped **label** followed by a value: `password: hunter2`,
 * `api_key = abc…`, `"token": "…"`.
 *
 * The label is matched loosely and then handed to {@link isSecretFieldName},
 * so this reuses the codebase's single source of truth for what a
 * credential-bearing name looks like rather than restating it. The value must
 * be at least eight non-space characters, which is what keeps a sentence such
 * as `the password is wrong` — where the "value" is a short ordinary word —
 * from matching.
 */
const LABELLED_SECRET_PATTERN = /["']?([A-Za-z][A-Za-z0-9 _.-]{1,40})["']?\s*[:=]\s*["']?(\S{8,})/g;

/**
 * One long, unbroken, mixed-case alphanumeric run.
 *
 * The generic backstop for an issued credential whose prefix this module does
 * not know. All three of the constraints matter for keeping false positives
 * low: forty characters or more, drawn only from the base64/base64url
 * alphabet, and mixing lower case, upper case and digits. A file path, a URL,
 * a kebab-case identifier and an English sentence all fail at least one.
 */
const HIGH_ENTROPY_PATTERN = /(?:^|[^A-Za-z0-9+/=_-])([A-Za-z0-9+/=_-]{40,})(?![A-Za-z0-9+/=_-])/g;

function isHighEntropyToken(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
}

/**
 * Reports the first credential shape found in `content`, or `null`.
 *
 * Checked in order of confidence, so the reported category is the most
 * specific one that matched rather than whichever pattern happened to be
 * tried first.
 */
export function findLikelySecret(content: string): MemorySecretHint | null {
  if (PRIVATE_KEY_PATTERN.test(content)) return 'private-key';

  for (const pattern of KNOWN_KEY_PATTERNS) {
    if (pattern.test(content)) return 'known-key-prefix';
  }

  if (BEARER_PATTERN.test(content)) return 'bearer-token';

  // `lastIndex` is reset on every call because both generic patterns are
  // global: a `RegExp` literal is shared across calls, and a leftover
  // `lastIndex` would make the same input match on one call and not the next.
  LABELLED_SECRET_PATTERN.lastIndex = 0;
  let labelled: RegExpExecArray | null;
  while ((labelled = LABELLED_SECRET_PATTERN.exec(content)) !== null) {
    const label = labelled[1];
    if (label !== undefined && isSecretFieldName(label)) return 'labelled-secret';
  }

  HIGH_ENTROPY_PATTERN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = HIGH_ENTROPY_PATTERN.exec(content)) !== null) {
    const candidate = token[1];
    if (candidate !== undefined && isHighEntropyToken(candidate)) return 'high-entropy-token';
  }

  return null;
}

/** Convenience predicate for call sites that do not need the category. */
export function looksLikeSecret(content: string): boolean {
  return findLikelySecret(content) !== null;
}
