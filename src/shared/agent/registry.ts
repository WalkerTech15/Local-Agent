/**
 * The agent profile registry (Phase 2, Milestone 7).
 *
 * Built-in profiles live here, in reviewed source, and are merged with the
 * user's own profiles on every load. Three properties matter:
 *
 *  - **Built-ins are never persisted.** They are rebuilt from this file each
 *    time, so a hand-edited `agents/profiles.json` cannot redefine one. The
 *    store schema refuses a stored profile that claims a built-in id, and
 *    {@link mergeAgentProfiles} refuses it a second time — because a file
 *    could reach this function by some path that skipped validation.
 *  - **Resolution fails closed.** An active id that names nothing, names a
 *    disabled profile, or names something that was just deleted resolves to
 *    the most restricted built-in rather than to "no restrictions". There is
 *    no code path here that answers a failed lookup with a permissive value.
 *  - **Nothing here grants.** Every function is a *narrowing* predicate:
 *    "does this profile allow this tool", "does this profile allow this part
 *    of the project". A `false` blocks; a `true` merely declines to block,
 *    and the permission engine still decides the action afterwards.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { findAgentTool } from './tools';
import type { AgentToolId } from './tools';
import {
  AGENT_DEFAULT_MAX_DURATION_MS,
  AGENT_DEFAULT_MAX_OUTPUT_BYTES,
  AGENT_DEFAULT_MAX_STEPS,
  AGENT_MAX_DURATION_MS,
  AGENT_PROFILE_SCHEMA_VERSION,
} from '../constants';
import type { ModelProvider } from '../constants';
import type { AgentProfile, AgentProfileStore } from '../schemas/agent.schema';
import { normalizeWorkspaceRelativePath } from '../workspace/path-safety';

/**
 * The profile a fresh install starts on, and the one every failed resolution
 * falls back to.
 *
 * Deliberately the most restricted of the built-ins: it can look and it can
 * plan, and it cannot start a process. A fallback that landed on the more
 * capable profile would mean a corrupted or hand-deleted store *widened* what
 * the next run could do, which is exactly backwards.
 */
export const DEFAULT_AGENT_PROFILE_ID = 'reviewer';

/**
 * Every built-in profile, rebuilt on each call.
 *
 * A factory rather than a shared object, for the reason
 * `createDefaultPermissionPolicy` is one: the caller owns the result and may
 * adjust its own copy without that edit becoming visible to every other
 * caller. `createdAt` and `updatedAt` are `null` because a built-in was never
 * created by anyone — inventing a timestamp for it would be a small lie the
 * interface would then display.
 */
export function createBuiltInAgentProfiles(): AgentProfile[] {
  return [
    {
      id: DEFAULT_AGENT_PROFILE_ID,
      name: 'Reviewer',
      description:
        'Reads the approved project and produces an inert plan. Cannot start a process and cannot change a file.',
      instructions:
        'Read the approved project and describe what you find. Produce a plan rather than a change.',
      provider: 'none',
      fallbackProviders: [],
      allowedTools: ['workspace.inspect', 'workspace.search', 'workspace.plan', 'git.status'],
      approvedWorkspacePaths: [''],
      permissionPolicy: [],
      verification: ['plan-produced'],
      limits: {
        maxSteps: AGENT_DEFAULT_MAX_STEPS,
        maxDurationMs: AGENT_DEFAULT_MAX_DURATION_MS,
        maxOutputBytes: AGENT_DEFAULT_MAX_OUTPUT_BYTES,
      },
      enabled: true,
      builtIn: true,
      createdAt: null,
      updatedAt: null,
    },
    {
      id: 'verifier',
      name: 'Verifier',
      description:
        'Reads the approved project and runs its own test, lint and type-check scripts. Each run of a script is confirmed natively first.',
      instructions:
        'Inspect the approved project, then run its own verification scripts and report what they returned.',
      provider: 'none',
      fallbackProviders: [],
      allowedTools: [
        'workspace.inspect',
        'workspace.plan',
        'command.test',
        'command.lint',
        'command.typecheck',
      ],
      approvedWorkspacePaths: [''],
      permissionPolicy: [],
      verification: ['tests-pass', 'lint-clean', 'typecheck-clean'],
      limits: {
        maxSteps: AGENT_DEFAULT_MAX_STEPS,
        // The ceiling rather than the default: one `npm test` may itself
        // run for up to `COMMAND_TIMEOUT_MS` (five minutes), so a profile
        // that runs three scripts in sequence needs the headroom or it would
        // stop on its own clock partway through the first one.
        maxDurationMs: AGENT_MAX_DURATION_MS,
        maxOutputBytes: AGENT_DEFAULT_MAX_OUTPUT_BYTES,
      },
      enabled: true,
      builtIn: true,
      createdAt: null,
      updatedAt: null,
    },
  ];
}

/** The reserved identifiers. A user profile may not claim one. */
export const BUILT_IN_AGENT_PROFILE_IDS: readonly string[] = createBuiltInAgentProfiles().map(
  (profile) => profile.id,
);

/** True when an id belongs to a profile shipped in reviewed source. */
export function isBuiltInAgentProfileId(id: string): boolean {
  return BUILT_IN_AGENT_PROFILE_IDS.includes(id);
}

/** The store written on a first launch: no user profiles, the safest active. */
export function createDefaultAgentProfileStore(): AgentProfileStore {
  return {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    activeProfileId: DEFAULT_AGENT_PROFILE_ID,
    profiles: [],
  };
}

/**
 * Built-ins first, then the user's own, with every collision dropped.
 *
 * Dropped rather than merged: a user profile sharing a built-in id is not a
 * customisation of that built-in, it is an attempt to replace one — and the
 * replacement would be the permissive copy, since the built-in is the
 * restricted one. Two user profiles sharing an id have no defensible winner
 * either, so the later is discarded rather than silently overriding.
 *
 * The store schema already rejects both cases outright. This is the second
 * layer, for a store that reached here without passing it.
 */
export function mergeAgentProfiles(storedProfiles: readonly AgentProfile[]): AgentProfile[] {
  const merged = createBuiltInAgentProfiles();
  const seen = new Set(merged.map((profile) => profile.id));

  for (const profile of storedProfiles) {
    if (seen.has(profile.id)) continue;
    if (profile.builtIn) continue;
    seen.add(profile.id);
    merged.push(profile);
  }

  return merged;
}

/** The registry as the rest of the application sees it. */
export interface AgentRegistry {
  readonly profiles: readonly AgentProfile[];
  /** Always names a profile that exists in {@link profiles} and is enabled. */
  readonly activeProfileId: string;
}

/** One profile by id, or `null`. Never throws; an unknown id is a refusal. */
export function findAgentProfile(
  profiles: readonly AgentProfile[],
  id: string,
): AgentProfile | null {
  return profiles.find((profile) => profile.id === id) ?? null;
}

/**
 * Turns a validated store into the merged, resolved registry.
 *
 * The active id is resolved *here* rather than trusted: if it names nothing,
 * or names a disabled profile, it falls back to {@link DEFAULT_AGENT_PROFILE_ID}.
 * That is the safe-fallback behaviour deleting or disabling the active
 * profile relies on — the application is never left with no active profile,
 * and never left with a more permissive one than the user chose.
 */
export function resolveAgentRegistry(store: AgentProfileStore): AgentRegistry {
  const profiles = mergeAgentProfiles(store.profiles);
  const requested = findAgentProfile(profiles, store.activeProfileId);
  const active = requested?.enabled === true ? requested.id : DEFAULT_AGENT_PROFILE_ID;
  return { profiles, activeProfileId: active };
}

/** The active profile. Guaranteed to exist, because the default always does. */
export function resolveActiveProfile(registry: AgentRegistry): AgentProfile {
  const active = findAgentProfile(registry.profiles, registry.activeProfileId);
  if (active !== null) return active;
  // Unreachable while `resolveAgentRegistry` produced this registry, since it
  // falls back to an id `createBuiltInAgentProfiles` always provides. Rebuilt
  // here rather than thrown so that no caller can be handed "no profile",
  // which would be indistinguishable from "no restrictions".
  const fallback = createBuiltInAgentProfiles().find(
    (profile) => profile.id === DEFAULT_AGENT_PROFILE_ID,
  );
  if (fallback === undefined) {
    throw new Error('the default built-in agent profile is missing from reviewed source');
  }
  return fallback;
}

/**
 * Whether this profile permits this tool.
 *
 * Three conditions, all required: the profile is enabled, the tool is in its
 * allowlist, and the tool actually exists in the registry. An unknown id is
 * `false` — fail closed — rather than being treated as unconstrained.
 */
export function isAgentToolAllowed(profile: AgentProfile, toolId: unknown): toolId is AgentToolId {
  if (!profile.enabled) return false;
  if (findAgentTool(toolId) === null) return false;
  return (profile.allowedTools as readonly string[]).includes(toolId as string);
}

/**
 * The profile's own decision for a tool, or `null` when it says nothing.
 *
 * Only ever `confirm` or `deny` — the type cannot express a grant. A caller
 * combines this with the permission engine's verdict by taking the stricter
 * of the two; see `src/shared/agent/orchestration.ts`.
 */
export function agentProfileDecisionFor(
  profile: AgentProfile,
  toolId: AgentToolId,
): 'confirm' | 'deny' | null {
  return profile.permissionPolicy.find((rule) => rule.toolId === toolId)?.decision ?? null;
}

/**
 * Whether a project-relative path falls inside the profile's workspace scope.
 *
 * Compared by whole path segments, not by string prefix: a `srcret/` would
 * otherwise satisfy a scope of `src`. The empty scope path means the whole
 * approved project.
 *
 * The comparison is case-insensitive because Windows resolves `SRC` and `src`
 * to the same directory — a case-sensitive check would claim to scope by name
 * while the filesystem scopes by identity. This is a *narrowing* layer in any
 * case: the guarantee that a path cannot leave the approved project is
 * `main/workspace-paths.ts`'s canonical containment check, which runs
 * regardless of what this returns.
 */
export function isWorkspacePathAllowed(profile: AgentProfile, path: string): boolean {
  const target = normalizeWorkspaceRelativePath(path);
  if (!target.ok) return false;

  for (const scope of profile.approvedWorkspacePaths) {
    const allowed = normalizeWorkspaceRelativePath(scope);
    if (!allowed.ok) continue;
    if (allowed.segments.length === 0) return true;
    if (allowed.segments.length > target.segments.length) continue;

    const matches = allowed.segments.every(
      (segment, index) => segment.toLowerCase() === target.segments[index]?.toLowerCase(),
    );
    if (matches) return true;
  }

  return false;
}

/**
 * Which provider this profile would use, given what is currently usable.
 *
 * The primary first, then each fallback in the order the profile lists them.
 * `'none'` when nothing is usable — never a provider the predicate rejected,
 * so an unconfigured or unimplemented provider cannot be selected by falling
 * through to it.
 *
 * `isUsable` is injected because whether a provider is usable depends on
 * settings and on the encrypted secret store, neither of which `src/shared`
 * may read.
 */
export function resolveAgentProvider(
  profile: AgentProfile,
  isUsable: (provider: ModelProvider) => boolean,
): ModelProvider {
  const candidates: readonly ModelProvider[] = [profile.provider, ...profile.fallbackProviders];
  for (const candidate of candidates) {
    if (candidate !== 'none' && isUsable(candidate)) return candidate;
  }
  return 'none';
}
