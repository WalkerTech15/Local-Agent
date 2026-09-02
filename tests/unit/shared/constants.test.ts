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

  it('requires confirmation for the destructive and privacy-sensitive actions', () => {
    expect([...CONFIRMATION_REQUIRED_ACTION_TYPES].sort()).toEqual(
      ['app.exit', 'emergency.reset', 'secrets.clear', 'secrets.write'].sort(),
    );
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

  it('only names real action types in the emergency exemption list', () => {
    const actions: readonly string[] = ACTION_TYPES;
    for (const actionType of EMERGENCY_STOP_EXEMPT_ACTION_TYPES) {
      expect(actions).toContain(actionType);
    }
  });
});
