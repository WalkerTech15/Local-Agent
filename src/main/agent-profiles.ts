/**
 * Agent profile storage (Phase 2, Milestone 7).
 *
 * Reads and writes `agents/profiles.json`. It mirrors `main/settings.ts` and
 * `main/policy.ts` deliberately and in detail, because a profile file is the
 * same *kind* of thing the permission policy is: user-editable configuration
 * that shapes what the application will later do.
 *
 * The properties carried over from those two modules:
 *
 *  - **Loading never throws and never merges.** A missing file, an unreadable
 *    one, an oversized one, malformed JSON, a `__proto__` key anywhere in it,
 *    or a document the schema rejects all resolve the same way: the default
 *    store, which is "no user profiles, the most restricted built-in active".
 *    A document either validates in full, as itself, or it is discarded in
 *    full. There is no partial-trust path, so a file with nine good profiles
 *    and one malformed one yields none of them rather than nine.
 *  - **Writing is atomic and re-validated.** The document is checked against
 *    the schema immediately before serialising, written to a uniquely named
 *    temporary file in the same directory, flushed, and moved into place with
 *    a single rename — so a crash or a concurrent write leaves either the
 *    previous complete document or the new one, never a partial write.
 *  - **Built-ins are never written.** Only user profiles are persisted; the
 *    built-ins are rebuilt from reviewed source on every load. Editing this
 *    file therefore cannot redefine a shipped profile into a permissive one.
 *
 * And one property of its own:
 *
 *  - **User data is preserved across every operation.** Each mutation reads
 *    the current store, changes exactly the one profile it names, and writes
 *    the whole document back. No operation regenerates the list, and none
 *    silently drops a profile it did not understand — because a profile it
 *    did not understand would have failed validation at load and the whole
 *    file would already have been refused.
 *
 * Every function takes a plain file path rather than a `UserDataPaths`, for
 * the reason `loadSettings` does: a test points at a temporary directory and
 * configures nothing else.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { AGENT_MAX_PROFILES, AGENT_PROFILE_STORE_MAX_BYTES } from '../shared/constants';
import { FORBIDDEN_OBJECT_KEYS } from '../shared/constants';
import { AgentError } from '../shared/agent/errors';
import {
  createBuiltInAgentProfiles,
  createDefaultAgentProfileStore,
  findAgentProfile,
  isBuiltInAgentProfileId,
  resolveAgentRegistry,
} from '../shared/agent/registry';
import type { AgentRegistry } from '../shared/agent/registry';
import { agentProfileSchema, agentProfileStoreSchema } from '../shared/schemas/agent.schema';
import type {
  AgentProfile,
  AgentProfileInput,
  AgentProfileStore,
} from '../shared/schemas/agent.schema';

/**
 * Mirrors `main/policy.ts`'s own `containsForbiddenKey` exactly, including the
 * reasoning: `JSON.parse` does not fall for a literal `__proto__` key, but
 * nothing downstream of this loader is allowed to assume that. A third
 * independent copy rather than a shared import, so this module gains no
 * runtime dependency on an already-reviewed module from an earlier milestone
 * for one small, self-contained, pure check.
 */
const MAX_PROFILE_JSON_DEPTH = 64;

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_PROFILE_JSON_DEPTH) return true;
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
 * A destination-file rename can transiently fail on Windows when something
 * else briefly holds the destination open. The same sharing-violation retry
 * `main/settings.ts` performs, and for the same reason: each attempt is one
 * whole-file rename, so retrying risks a delayed write, never a partial one.
 */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 20;

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt === RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) throw error;
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

/**
 * Loads `storeFile`, failing safe on every problem.
 *
 * Never throws, and never creates a file. A first launch is indistinguishable,
 * by design, from a corrupted one: both return the same default store, which
 * is the most restricted state rather than the most convenient one.
 *
 * The size check happens before the read, not after: a file that grew without
 * bound should not be pulled into memory to discover that it is too large.
 */
export async function loadAgentProfileStore(storeFile: string): Promise<AgentProfileStore> {
  try {
    const stats = await stat(storeFile);
    if (stats.size > AGENT_PROFILE_STORE_MAX_BYTES) return createDefaultAgentProfileStore();
  } catch {
    // Missing file (first launch) and any other stat failure fail the same
    // way as an unreadable one. Neither the error nor the path is surfaced.
    return createDefaultAgentProfileStore();
  }

  let raw: string;
  try {
    raw = await readFile(storeFile, 'utf8');
  } catch {
    return createDefaultAgentProfileStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createDefaultAgentProfileStore();
  }

  if (containsForbiddenKey(parsed)) return createDefaultAgentProfileStore();

  const result = agentProfileStoreSchema.safeParse(parsed);
  if (!result.success) return createDefaultAgentProfileStore();

  return result.data;
}

/**
 * Writes `store` to `storeFile` atomically.
 *
 * Re-validated against the schema immediately before serialising, so a caller
 * cannot persist a document that only *claims* the type at compile time —
 * which matters more here than for settings, because the value being
 * persisted describes what an agent will later be permitted to reach for.
 */
export async function writeAgentProfileStore(
  storeFile: string,
  store: AgentProfileStore,
): Promise<void> {
  const validated = agentProfileStoreSchema.parse(store);
  const payload = JSON.stringify(validated, null, 2);

  const dir = dirname(storeFile);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `${basename(storeFile)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameWithRetry(tempFile, storeFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The merged, resolved registry as the rest of the application sees it. */
export async function readAgentRegistry(storeFile: string): Promise<AgentRegistry> {
  return resolveAgentRegistry(await loadAgentProfileStore(storeFile));
}

/**
 * Persists a changed store and answers with the freshly resolved registry.
 *
 * Resolved from the document that was *written*, not from the caller's
 * in-memory idea of it, so the answer reflects what the next load will see —
 * including any fallback `resolveAgentRegistry` applied because the active
 * profile was just deleted or disabled.
 */
async function commit(storeFile: string, store: AgentProfileStore): Promise<AgentRegistry> {
  try {
    await writeAgentProfileStore(storeFile, store);
  } catch {
    // The underlying error never crosses a boundary; the caller gets the
    // normalized code and the store on disk is unchanged.
    throw new AgentError('AGENT_PROFILE_STORE_FAILED');
  }
  return resolveAgentRegistry(store);
}

/** Refuses an operation that would edit a profile shipped in reviewed source. */
function requireUserProfile(store: AgentProfileStore, profileId: string): AgentProfile {
  if (isBuiltInAgentProfileId(profileId)) throw new AgentError('AGENT_PROFILE_READ_ONLY');
  const existing = findAgentProfile(store.profiles, profileId);
  if (existing === null) throw new AgentError('AGENT_PROFILE_NOT_FOUND');
  return existing;
}

/**
 * Makes `profileId` the active profile.
 *
 * Refuses an unknown or disabled profile rather than accepting it and letting
 * the load-time fallback quietly substitute a different one: a selection that
 * silently does not take effect is worse than a refusal the interface can
 * report.
 */
export async function selectAgentProfile(
  storeFile: string,
  profileId: string,
): Promise<AgentRegistry> {
  const store = await loadAgentProfileStore(storeFile);
  const merged = [...createBuiltInAgentProfiles(), ...store.profiles];
  const target = findAgentProfile(merged, profileId);
  if (target === null) throw new AgentError('AGENT_PROFILE_NOT_FOUND');
  if (!target.enabled) throw new AgentError('AGENT_PROFILE_DISABLED');

  return commit(storeFile, { ...store, activeProfileId: profileId });
}

/**
 * Adds a user profile.
 *
 * The id must be free across *both* lists: a built-in id is refused with the
 * same "already exists" code as a user id, because from the caller's point of
 * view the id is taken either way.
 */
export async function createAgentProfile(
  storeFile: string,
  input: AgentProfileInput,
  now: string,
): Promise<AgentRegistry> {
  const store = await loadAgentProfileStore(storeFile);

  if (isBuiltInAgentProfileId(input.id)) throw new AgentError('AGENT_PROFILE_EXISTS');
  if (findAgentProfile(store.profiles, input.id) !== null) {
    throw new AgentError('AGENT_PROFILE_EXISTS');
  }
  if (store.profiles.length + createBuiltInAgentProfiles().length >= AGENT_MAX_PROFILES) {
    throw new AgentError('AGENT_PROFILE_LIMIT_REACHED');
  }

  // `builtIn` and the timestamps are supplied here, never by the caller —
  // `agentProfileInputSchema` has no field for any of them.
  const profile = agentProfileSchema.safeParse({
    ...input,
    builtIn: false,
    createdAt: now,
    updatedAt: now,
  });
  if (!profile.success) throw new AgentError('AGENT_PROFILE_INVALID');

  return commit(storeFile, { ...store, profiles: [...store.profiles, profile.data] });
}

/**
 * Replaces a user profile in place.
 *
 * `createdAt` is carried over from the existing profile rather than taken
 * from the request, so an update cannot rewrite when a profile was created.
 * The submitted id must match the addressed one — a mismatch is a refusal,
 * not a rename.
 */
export async function updateAgentProfile(
  storeFile: string,
  profileId: string,
  input: AgentProfileInput,
  now: string,
): Promise<AgentRegistry> {
  const store = await loadAgentProfileStore(storeFile);
  const existing = requireUserProfile(store, profileId);

  if (input.id !== profileId) throw new AgentError('AGENT_PROFILE_INVALID');

  const profile = agentProfileSchema.safeParse({
    ...input,
    builtIn: false,
    createdAt: existing.createdAt,
    updatedAt: now,
  });
  if (!profile.success) throw new AgentError('AGENT_PROFILE_INVALID');

  return commit(storeFile, {
    ...store,
    profiles: store.profiles.map((entry) => (entry.id === profileId ? profile.data : entry)),
  });
}

/**
 * Removes a user profile.
 *
 * Deleting the **active** profile is permitted, and is the reason
 * `resolveAgentRegistry` resolves the active id rather than trusting it: the
 * store is left naming a profile that no longer exists, and the next
 * resolution — including the one this function returns — falls back to the
 * most restricted built-in. The active id is also rewritten here so the file
 * on disk does not keep pointing at something deleted.
 */
export async function deleteAgentProfile(
  storeFile: string,
  profileId: string,
): Promise<AgentRegistry> {
  const store = await loadAgentProfileStore(storeFile);
  requireUserProfile(store, profileId);

  const profiles = store.profiles.filter((entry) => entry.id !== profileId);
  const next: AgentProfileStore = { ...store, profiles };
  const fallback = resolveAgentRegistry(next);

  return commit(storeFile, { ...next, activeProfileId: fallback.activeProfileId });
}

/**
 * Enables or disables a user profile.
 *
 * A built-in cannot be disabled: the default built-in is what every failed
 * resolution falls back to, so allowing it to be turned off would leave the
 * fallback itself unusable. Disabling the *active* user profile is allowed,
 * and falls back exactly as deletion does.
 */
export async function setAgentProfileEnabled(
  storeFile: string,
  profileId: string,
  enabled: boolean,
  now: string,
): Promise<AgentRegistry> {
  const store = await loadAgentProfileStore(storeFile);
  const existing = requireUserProfile(store, profileId);

  const updated: AgentProfile = { ...existing, enabled, updatedAt: now };
  const next: AgentProfileStore = {
    ...store,
    profiles: store.profiles.map((entry) => (entry.id === profileId ? updated : entry)),
  };
  const fallback = resolveAgentRegistry(next);

  return commit(storeFile, { ...next, activeProfileId: fallback.activeProfileId });
}
