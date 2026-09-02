/**
 * Permission policy storage for Local Agent.
 *
 * Reads `permissions/policy.json`. Mirrors `main/settings.ts`'s
 * `loadSettings` exactly: never trusts JSON loaded from disk, never merges a
 * partially-valid document into safe defaults, and never creates a file.
 * There is no writer here — the policy file is meant to be hand-edited (see
 * `permissions.schema.ts`), and Milestone 5 exposes no mutation path for it
 * to the renderer or to a model.
 *
 * `loadPermissionPolicy` takes a plain file path, exactly as `loadSettings`
 * does, so a test points at a file inside a temporary directory and
 * configures nothing else — never the real `%APPDATA%`.
 */

import { readFile } from 'node:fs/promises';

import { FORBIDDEN_OBJECT_KEYS } from '../shared/constants';
import { createDefaultPermissionPolicy, permissionPolicySchema } from '../shared/schemas';
import type { PermissionPolicy } from '../shared/schemas';

/**
 * Mirrors `main/settings.ts`'s `containsForbiddenKey` exactly, including the
 * reasoning behind it: `JSON.parse` does not fall for a literal `__proto__`
 * key — modern engines create it as an ordinary own property — but nothing
 * downstream of this loader is allowed to assume that. A second, independent
 * copy rather than a shared import: this module should not gain a runtime
 * dependency on `main/settings.ts`, an already-reviewed module from an
 * earlier milestone, for one small, self-contained, pure check.
 */
const MAX_POLICY_JSON_DEPTH = 64;

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_POLICY_JSON_DEPTH) return true;
  if (value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) {
    return value.some((element) => containsForbiddenKey(element, depth + 1));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_OBJECT_KEYS.includes(key)) return true;
    if (containsForbiddenKey(record[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Loads `policyFile`, failing safe on every problem.
 *
 * Never throws. A missing file, an unreadable one, malformed JSON, a
 * `__proto__`/`constructor`/`prototype` key anywhere in it, or a document
 * `permissionPolicySchema` rejects for any reason — including one that omits
 * or denies an emergency-availability-floor action, or downgrades a
 * confirmation-floor action to `allow` — all resolve exactly the same way:
 * {@link createDefaultPermissionPolicy}. There is no partial-trust path: a
 * loaded document either validates in full, as itself, or it is discarded in
 * full. `decidePermission` (`main/permissions.ts`) enforces both floors
 * independently of this loader too, so a policy that reached it by some
 * other path is still covered — this is one layer, not the only one.
 *
 * Never creates a file. A first launch is indistinguishable, by design, from
 * a corrupted one; both return the same safe default policy.
 */
export async function loadPermissionPolicy(policyFile: string): Promise<PermissionPolicy> {
  let raw: string;
  try {
    raw = await readFile(policyFile, 'utf8');
  } catch {
    return createDefaultPermissionPolicy();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createDefaultPermissionPolicy();
  }

  if (containsForbiddenKey(parsed)) {
    return createDefaultPermissionPolicy();
  }

  const result = permissionPolicySchema.safeParse(parsed);
  if (!result.success) {
    return createDefaultPermissionPolicy();
  }

  return result.data;
}
