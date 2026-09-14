import { describe, expect, it } from 'vitest';

import {
  AGENT_ALLOWED_ACTION_TYPES,
  AGENT_TOOL_IDS,
  AGENT_TOOLS,
  agentProfileDecisionFor,
  BUILT_IN_AGENT_PROFILE_IDS,
  createBuiltInAgentProfiles,
  createDefaultAgentProfileStore,
  DEFAULT_AGENT_PROFILE_ID,
  findAgentProfile,
  findAgentTool,
  isAgentToolAllowed,
  isAgentToolId,
  isBuiltInAgentProfileId,
  isWorkspacePathAllowed,
  mergeAgentProfiles,
  requirementToolId,
  resolveActiveProfile,
  resolveAgentProvider,
  resolveAgentRegistry,
} from '../../../src/shared/agent';
import { CONFIRMATION_REQUIRED_ACTION_TYPES } from '../../../src/shared/constants';
import type { AgentProfile } from '../../../src/shared/schemas';

/**
 * The agent tool registry and profile registry (Phase 2, Milestone 7).
 *
 * The first describe block is the milestone's load-bearing security claim
 * stated as a test: **no agent tool maps to an action that changes anything**.
 * If a later edit adds a write tool, these fail before anything else does.
 */

function userProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'custom',
    name: 'Custom',
    description: '',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect'],
    approvedWorkspacePaths: ['src'],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 4, maxDurationMs: 30_000, maxOutputBytes: 10_000 },
    enabled: true,
    builtIn: false,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('agent tools — the capability ceiling', () => {
  it('maps every tool to an action type that already existed, and to nothing else', () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_ALLOWED_ACTION_TYPES, tool.id).toContain(tool.actionType);
    }
  });

  it('exposes no tool that can write a file, undo a write, or create a commit', () => {
    const actionTypes = AGENT_TOOLS.map((tool) => tool.actionType);
    for (const forbidden of ['workspace.write', 'workspace.rollback', 'git.checkpoint']) {
      expect(actionTypes, forbidden).not.toContain(forbidden);
    }

    const ids: readonly string[] = AGENT_TOOL_IDS;
    for (const forbidden of [
      'workspace.write',
      'workspace.apply',
      'workspace.rollback',
      'workspace.create',
      'workspace.delete',
      'git.checkpoint',
      'git.push',
      'shell.execute',
      'command.run',
    ]) {
      expect(ids, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps every process-starting tool on the confirmation floor', () => {
    const floor: readonly string[] = CONFIRMATION_REQUIRED_ACTION_TYPES;
    for (const tool of AGENT_TOOLS) {
      if (tool.commandId === null) continue;
      expect(floor, tool.id).toContain(tool.actionType);
    }
  });

  it('declares each tool exactly once and resolves each id', () => {
    expect(new Set(AGENT_TOOL_IDS).size).toBe(AGENT_TOOL_IDS.length);
    for (const id of AGENT_TOOL_IDS) {
      expect(findAgentTool(id)?.id).toBe(id);
    }
  });

  it('fails closed on an unknown tool id', () => {
    expect(findAgentTool('workspace.write')).toBeNull();
    expect(findAgentTool(undefined)).toBeNull();
    expect(findAgentTool({ id: 'workspace.inspect' })).toBeNull();
    expect(isAgentToolId('workspace.write')).toBe(false);
  });

  it('gives every verification requirement a tool that exists', () => {
    for (const tool of AGENT_TOOLS) {
      if (tool.kind !== 'verify') continue;
      expect(tool.commandId).not.toBeNull();
    }
    expect(findAgentTool(requirementToolId('tests-pass'))?.commandId).toBe('test');
    expect(findAgentTool(requirementToolId('plan-produced'))?.actionType).toBe('workspace.plan');
  });
});

describe('built-in profiles', () => {
  it('reserves its identifiers and defaults to the most restricted one', () => {
    expect(BUILT_IN_AGENT_PROFILE_IDS).toContain(DEFAULT_AGENT_PROFILE_ID);
    expect(isBuiltInAgentProfileId(DEFAULT_AGENT_PROFILE_ID)).toBe(true);
    expect(isBuiltInAgentProfileId('custom')).toBe(false);
  });

  it('the default built-in cannot start a process', () => {
    const fallback = createBuiltInAgentProfiles().find(
      (profile) => profile.id === DEFAULT_AGENT_PROFILE_ID,
    );
    expect(fallback).toBeDefined();
    const startsProcess = (fallback?.allowedTools ?? []).some(
      (toolId) => findAgentTool(toolId)?.commandId !== null,
    );
    expect(startsProcess).toBe(false);
  });

  it('hands back a fresh copy each call, so one caller cannot corrupt another', () => {
    const first = createBuiltInAgentProfiles();
    const second = createBuiltInAgentProfiles();
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it('records no creation time, because a built-in was never created', () => {
    for (const profile of createBuiltInAgentProfiles()) {
      expect(profile.createdAt, profile.id).toBeNull();
      expect(profile.updatedAt, profile.id).toBeNull();
    }
  });
});

describe('merging and resolution', () => {
  it('drops a stored profile that claims a built-in identifier', () => {
    const impostor = userProfile({
      id: DEFAULT_AGENT_PROFILE_ID,
      name: 'Impostor',
      allowedTools: ['command.test'],
      approvedWorkspacePaths: [''],
    });
    const merged = mergeAgentProfiles([impostor]);
    const resolved = findAgentProfile(merged, DEFAULT_AGENT_PROFILE_ID);

    expect(resolved?.builtIn).toBe(true);
    expect(resolved?.name).not.toBe('Impostor');
    expect(merged.filter((profile) => profile.id === DEFAULT_AGENT_PROFILE_ID)).toHaveLength(1);
  });

  it('drops a stored profile that claims to be built in', () => {
    const merged = mergeAgentProfiles([userProfile({ id: 'sneaky', builtIn: true })]);
    expect(findAgentProfile(merged, 'sneaky')).toBeNull();
  });

  it('drops the later of two stored profiles sharing an identifier', () => {
    const merged = mergeAgentProfiles([
      userProfile({ id: 'twin', name: 'First' }),
      userProfile({ id: 'twin', name: 'Second' }),
    ]);
    expect(merged.filter((profile) => profile.id === 'twin')).toHaveLength(1);
    expect(findAgentProfile(merged, 'twin')?.name).toBe('First');
  });

  it('falls back to the default when the active id names nothing', () => {
    const registry = resolveAgentRegistry({
      ...createDefaultAgentProfileStore(),
      activeProfileId: 'deleted-yesterday',
    });
    expect(registry.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
    expect(resolveActiveProfile(registry).id).toBe(DEFAULT_AGENT_PROFILE_ID);
  });

  it('falls back to the default when the active profile is disabled', () => {
    const registry = resolveAgentRegistry({
      ...createDefaultAgentProfileStore(),
      activeProfileId: 'custom',
      profiles: [userProfile({ enabled: false })],
    });
    expect(registry.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
  });

  it('always resolves to a profile that exists and is enabled', () => {
    const registry = resolveAgentRegistry(createDefaultAgentProfileStore());
    const active = resolveActiveProfile(registry);
    expect(active.enabled).toBe(true);
    expect(findAgentProfile(registry.profiles, active.id)).not.toBeNull();
  });
});

describe('tool and workspace narrowing', () => {
  it('refuses every tool a profile does not list', () => {
    const profile = userProfile({ allowedTools: ['workspace.inspect'] });
    expect(isAgentToolAllowed(profile, 'workspace.inspect')).toBe(true);
    expect(isAgentToolAllowed(profile, 'command.test')).toBe(false);
    expect(isAgentToolAllowed(profile, 'workspace.write')).toBe(false);
    expect(isAgentToolAllowed(profile, undefined)).toBe(false);
  });

  it('refuses every tool while the profile is disabled', () => {
    const profile = userProfile({ enabled: false });
    expect(isAgentToolAllowed(profile, 'workspace.inspect')).toBe(false);
  });

  it('matches workspace scope by whole segments, not by string prefix', () => {
    const profile = userProfile({ approvedWorkspacePaths: ['src'] });
    expect(isWorkspacePathAllowed(profile, 'src')).toBe(true);
    expect(isWorkspacePathAllowed(profile, 'src/main/ipc.ts')).toBe(true);
    // The prefix trap: `srcret` starts with `src` as a string but is a
    // different directory.
    expect(isWorkspacePathAllowed(profile, 'srcret/keys.txt')).toBe(false);
    expect(isWorkspacePathAllowed(profile, 'docs')).toBe(false);
    expect(isWorkspacePathAllowed(profile, '')).toBe(false);
  });

  it('treats the empty scope as the whole approved project', () => {
    const profile = userProfile({ approvedWorkspacePaths: [''] });
    expect(isWorkspacePathAllowed(profile, '')).toBe(true);
    expect(isWorkspacePathAllowed(profile, 'anything/at/all.ts')).toBe(true);
  });

  it('refuses a path that is not a safe project-relative path', () => {
    const profile = userProfile({ approvedWorkspacePaths: [''] });
    for (const path of ['../escape', '/etc/passwd', 'a b', 'src/../../x']) {
      expect(isWorkspacePathAllowed(profile, path), path).toBe(false);
    }
  });

  it('matches case-insensitively, because Windows resolves both spellings alike', () => {
    const profile = userProfile({ approvedWorkspacePaths: ['src'] });
    expect(isWorkspacePathAllowed(profile, 'SRC/main.ts')).toBe(true);
  });

  it('reports a profile decision only for a tool it carries a rule for', () => {
    const profile = userProfile({
      allowedTools: ['workspace.inspect', 'workspace.plan'],
      permissionPolicy: [{ toolId: 'workspace.plan', decision: 'deny' }],
    });
    expect(agentProfileDecisionFor(profile, 'workspace.plan')).toBe('deny');
    expect(agentProfileDecisionFor(profile, 'workspace.inspect')).toBeNull();
  });
});

describe('provider resolution', () => {
  it('prefers the primary, then each fallback in order', () => {
    const profile = userProfile({ provider: 'glm', fallbackProviders: ['ollama'] });
    expect(resolveAgentProvider(profile, (candidate) => candidate === 'glm')).toBe('glm');
    expect(resolveAgentProvider(profile, (candidate) => candidate === 'ollama')).toBe('ollama');
  });

  it('resolves to none rather than to a provider the predicate rejected', () => {
    const profile = userProfile({ provider: 'glm', fallbackProviders: ['ollama'] });
    expect(resolveAgentProvider(profile, () => false)).toBe('none');
  });

  it('never selects "none" by falling through to it', () => {
    const profile = userProfile({ provider: 'none' });
    // Even a predicate that approves everything must not select `none`, which
    // is the absence of a provider rather than one.
    expect(resolveAgentProvider(profile, () => true)).toBe('none');
  });
});
