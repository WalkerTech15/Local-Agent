import { describe, expect, it } from 'vitest';

import {
  ACTION_TYPES,
  APP_DATA_DIR_NAME,
  APP_PRODUCT_NAME,
  CONFIRMATION_REQUIRED_ACTION_TYPES,
  DEFAULT_ASSISTANT_NAME,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_PERMISSION_DECISION,
  DEFAULT_UI_LANGUAGE,
  EMERGENCY_STOP_EXEMPT_ACTION_TYPES,
  MODEL_PROVIDERS,
  UI_LANGUAGES,
} from '../../../src/shared/constants';

describe('product identity', () => {
  it('uses the approved product name and application-data folder', () => {
    expect(APP_PRODUCT_NAME).toBe('Local Agent');
    expect(APP_DATA_DIR_NAME).toBe('Local-Agent');
    expect(DEFAULT_ASSISTANT_NAME).toBe('JARVIS');
  });
});

describe('model providers', () => {
  it('lists exactly the approved Phase 1 providers, in order', () => {
    expect(MODEL_PROVIDERS).toEqual(['none', 'glm', 'openai-compatible', 'ollama']);
  });

  it('does not encode an Anthropic-specific or other unapproved provider', () => {
    const providers: readonly string[] = MODEL_PROVIDERS;
    for (const forbidden of ['anthropic', 'claude', 'openai', 'gemini', 'mistral']) {
      expect(providers).not.toContain(forbidden);
    }
  });

  it('defaults to no provider so that a fresh install performs no model call', () => {
    expect(DEFAULT_MODEL_PROVIDER).toBe('none');
  });
});

describe('interface languages', () => {
  it('lists exactly the approved initial languages', () => {
    expect(UI_LANGUAGES).toEqual(['en', 'fr', 'vi']);
  });

  it('defaults to a language that is in the list', () => {
    const languages: readonly string[] = UI_LANGUAGES;
    expect(languages).toContain(DEFAULT_UI_LANGUAGE);
  });
});

describe('permission model', () => {
  it('denies by default', () => {
    expect(DEFAULT_PERMISSION_DECISION).toBe('deny');
  });

  it('contains no filesystem, shell or network action in Phase 1', () => {
    const actions: readonly string[] = ACTION_TYPES;
    for (const forbidden of [
      'fs.read',
      'fs.write',
      'fs.delete',
      'shell.execute',
      'process.spawn',
      'network.request',
      'model.invoke',
      'secrets.read',
    ]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  it('never exposes an action that returns a secret value', () => {
    const actions: readonly string[] = ACTION_TYPES;
    const secretReaders = actions.filter(
      (action) => action.startsWith('secrets.') && !['secrets.status'].includes(action),
    );
    // Writing and clearing are permitted; reading a key back out is not.
    expect(secretReaders).toEqual(['secrets.write', 'secrets.clear']);
  });

  it('declares every action type exactly once', () => {
    expect(new Set(ACTION_TYPES).size).toBe(ACTION_TYPES.length);
  });

  it('adds no action that could write, delete or execute (Phase 2, Milestone 5)', () => {
    const actions: readonly string[] = ACTION_TYPES;
    // Milestone 6 gives the workspace the ability to write, to run one of
    // five named commands, and to create a commit. What it deliberately still
    // does not give it is a *general* capability: there is no action type
    // through which an arbitrary file operation, an arbitrary command, or a
    // destructive Git operation could be expressed at all.
    for (const forbidden of [
      'workspace.create',
      'workspace.delete',
      'workspace.patch',
      'workspace.execute',
      'fs.read',
      'fs.write',
      'fs.delete',
      'shell.execute',
      'terminal.execute',
      'process.spawn',
      'command.execute',
      'git.push',
      'git.reset',
      'git.checkout',
      'git.branch',
      'git.remote',
      'admin.execute',
    ]) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
  });

  it('names the five workspace actions and nothing else', () => {
    const actions: readonly string[] = ACTION_TYPES;
    const workspaceActions = actions.filter((action) => action.startsWith('workspace.'));
    expect([...workspaceActions].sort()).toEqual([
      'workspace.plan',
      'workspace.read',
      'workspace.rollback',
      'workspace.select',
      'workspace.write',
    ]);
  });

  it('names exactly two Git actions: one that reads and one that commits', () => {
    const actions: readonly string[] = ACTION_TYPES;
    const gitActions = actions.filter((action) => action.startsWith('git.'));
    expect([...gitActions].sort()).toEqual(['git.checkpoint', 'git.read']);
  });

  it('puts every action that can change something outside the app on the confirmation floor', () => {
    // The Milestone 6 invariant, stated positively: writing a file, undoing a
    // write, running a project command and creating a commit are the four
    // things that reach outside `%APPDATA%\\Local-Agent`, and a policy edit
    // cannot turn any of them into an `allow`.
    const floor: readonly string[] = CONFIRMATION_REQUIRED_ACTION_TYPES;
    for (const action of [
      'workspace.write',
      'workspace.rollback',
      'command.run',
      'git.checkpoint',
    ]) {
      expect(floor, action).toContain(action);
    }
  });

  it('leaves every workspace, command and Git action blocked by an engaged emergency stop', () => {
    const exempt: readonly string[] = EMERGENCY_STOP_EXEMPT_ACTION_TYPES;
    for (const action of [
      'workspace.select',
      'workspace.read',
      'workspace.plan',
      'workspace.write',
      'workspace.rollback',
      'command.run',
      'git.read',
      'git.checkpoint',
    ]) {
      expect(exempt, action).not.toContain(action);
    }
  });

  it('requires confirmation for the destructive and privacy-sensitive actions', () => {
    expect([...CONFIRMATION_REQUIRED_ACTION_TYPES].sort()).toEqual(
      [
        'agent.run',
        'agent.write',
        'app.exit',
        'command.run',
        'emergency.reset',
        'git.checkpoint',
        'secrets.clear',
        'secrets.write',
        'workspace.rollback',
        'workspace.write',
      ].sort(),
    );
  });

  it('leaves the two read-only additions off the confirmation floor', () => {
    // Reading `git status` and `git diff` changes nothing, exactly as
    // `workspace.read` does not, so neither is prompted for.
    const floor: readonly string[] = CONFIRMATION_REQUIRED_ACTION_TYPES;
    expect(floor).not.toContain('git.read');
    expect(floor).not.toContain('workspace.read');
  });

  it('only names real action types in the confirmation floor', () => {
    const actions: readonly string[] = ACTION_TYPES;
    for (const actionType of CONFIRMATION_REQUIRED_ACTION_TYPES) {
      expect(actions).toContain(actionType);
    }
  });

  it('leaves the emergency stop releasable and the audit trail readable', () => {
    const exempt: readonly string[] = EMERGENCY_STOP_EXEMPT_ACTION_TYPES;
    expect(exempt).toContain('emergency.reset');
    expect(exempt).toContain('audit.read');
  });

  it('blocks every state-changing action while the emergency stop is engaged', () => {
    const exempt: readonly string[] = EMERGENCY_STOP_EXEMPT_ACTION_TYPES;
    expect(exempt).not.toContain('settings.write');
    expect(exempt).not.toContain('secrets.write');
    expect(exempt).not.toContain('secrets.clear');
  });

  it('names exactly four agent actions, none of which is a capability', () => {
    const actions: readonly string[] = ACTION_TYPES;
    const agentActions = actions.filter((action) => action.startsWith('agent.'));
    expect([...agentActions].sort()).toEqual([
      'agent.read',
      'agent.run',
      'agent.select',
      'agent.write',
    ]);
  });

  it('adds no agent action through which authority could be handed out', () => {
    const actions: readonly string[] = ACTION_TYPES;
    // Milestone 7 governs *configuration* and the bounded orchestration of
    // actions that already existed. There is no action type through which an
    // agent could be given an operation of its own, granted a permission, or
    // allowed to define a tool.
    for (const forbidden of [
      'agent.execute',
      'agent.grant',
      'agent.permit',
      'agent.authorize',
      'agent.elevate',
      'agent.tool',
      'agent.spawn',
      'agent.policy',
      'agent.write.permission',
    ]) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
  });

  it('puts editing a profile and starting a run on the confirmation floor', () => {
    // Neither performs a side effect outside the app's own data directory by
    // itself; both shape what happens *later*, which is why they are here.
    const floor: readonly string[] = CONFIRMATION_REQUIRED_ACTION_TYPES;
    expect(floor).toContain('agent.write');
    expect(floor).toContain('agent.run');
  });

  it('leaves listing and selecting a profile off the confirmation floor', () => {
    // Listing changes nothing, and selecting cannot widen any permission: the
    // engine still decides every action a run takes, against the same policy.
    const floor: readonly string[] = CONFIRMATION_REQUIRED_ACTION_TYPES;
    expect(floor).not.toContain('agent.read');
    expect(floor).not.toContain('agent.select');
  });

  it('leaves every agent action blocked by an engaged emergency stop', () => {
    const exempt: readonly string[] = EMERGENCY_STOP_EXEMPT_ACTION_TYPES;
    for (const action of ['agent.read', 'agent.select', 'agent.write', 'agent.run']) {
      expect(exempt, action).not.toContain(action);
    }
  });

  it('only names real action types in the emergency exemption list', () => {
    const actions: readonly string[] = ACTION_TYPES;
    for (const actionType of EMERGENCY_STOP_EXEMPT_ACTION_TYPES) {
      expect(actions).toContain(actionType);
    }
  });
});
