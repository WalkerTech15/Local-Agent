import { describe, expect, it } from 'vitest';

import { BASE_URL_MAX_LENGTH, isSecretFieldName } from '../../../src/shared/constants';
import type { Settings } from '../../../src/shared/schemas/settings.schema';
import { createDefaultSettings, settingsSchema } from '../../../src/shared/schemas/settings.schema';

const NOW = '2026-08-07T00:00:00.000Z';

const validSettings = (): Settings => ({
  ...createDefaultSettings(NOW),
  onboardingCompleted: true,
  assistant: { name: 'JARVIS' },
  user: { displayName: 'Alex Martin' },
  language: { ui: 'fr' },
  modelProvider: {
    provider: 'ollama',
    model: 'llama3.1',
    baseUrl: 'http://localhost:11434',
    hasApiKey: false,
  },
});

/** Builds an intentionally invalid object without weakening the exported types. */
const patch = (overrides: Record<string, unknown>): unknown => ({
  ...validSettings(),
  ...overrides,
});

/** Whether a settings document carrying the given `baseUrl` is accepted. */
const withBaseUrl = (baseUrl: string): boolean =>
  settingsSchema.safeParse(
    patch({
      modelProvider: { provider: 'ollama', model: 'llama3.1', baseUrl, hasApiKey: false },
    }),
  ).success;

describe('settingsSchema — valid input', () => {
  it('accepts a fully populated settings object', () => {
    expect(settingsSchema.safeParse(validSettings()).success).toBe(true);
  });

  it('accepts the defaults written on a first launch', () => {
    const result = settingsSchema.safeParse(createDefaultSettings(NOW));
    expect(result.success).toBe(true);
  });

  it('starts a first launch with onboarding incomplete and no provider', () => {
    const defaults = createDefaultSettings(NOW);
    expect(defaults.onboardingCompleted).toBe(false);
    expect(defaults.modelProvider.provider).toBe('none');
    expect(defaults.modelProvider.hasApiKey).toBe(false);
    expect(defaults.assistant.name).toBe('JARVIS');
    expect(defaults.language.ui).toBe('en');
  });

  it('accepts accented French and Vietnamese names unchanged', () => {
    // The control-character and bidi rules must never restrict ordinary
    // Unicode text in a supported language.
    for (const displayName of [
      'Éloïse Lefèvre-Gaütier',
      'Nguyễn Thị Ánh Nguyệt',
      'Trần Đăng Khoa',
      'François Müller',
    ]) {
      const result = settingsSchema.safeParse(patch({ user: { displayName } }));
      expect(result.success, `expected ${displayName} to be accepted`).toBe(true);
      if (result.success) {
        expect(result.data.user.displayName).toBe(displayName);
      }
    }
  });

  it('accepts every approved interface language', () => {
    for (const ui of ['en', 'fr', 'vi'] as const) {
      expect(settingsSchema.safeParse(patch({ language: { ui } })).success).toBe(true);
    }
  });

  it('accepts every approved provider', () => {
    const cases: readonly unknown[] = [
      { provider: 'none', model: '', baseUrl: '', hasApiKey: false },
      { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: true },
      {
        provider: 'openai-compatible',
        model: 'gpt-oss',
        baseUrl: 'https://example.invalid/v1',
        hasApiKey: true,
      },
      {
        provider: 'ollama',
        model: 'llama3.1',
        baseUrl: 'http://localhost:11434',
        hasApiKey: false,
      },
    ];
    for (const modelProvider of cases) {
      expect(settingsSchema.safeParse(patch({ modelProvider })).success).toBe(true);
    }
  });

  it('trims surrounding whitespace from display names', () => {
    const result = settingsSchema.safeParse(patch({ assistant: { name: '  JARVIS  ' } }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assistant.name).toBe('JARVIS');
    }
  });
});

describe('settingsSchema — rejects malformed input', () => {
  it('rejects a missing schemaVersion', () => {
    const { schemaVersion: _omitted, ...rest } = validSettings();
    expect(settingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unexpected schemaVersion', () => {
    expect(settingsSchema.safeParse(patch({ schemaVersion: 2 })).success).toBe(false);
  });

  it('rejects an empty assistant name', () => {
    expect(settingsSchema.safeParse(patch({ assistant: { name: '' } })).success).toBe(false);
  });

  it('rejects a whitespace-only assistant name', () => {
    expect(settingsSchema.safeParse(patch({ assistant: { name: '   ' } })).success).toBe(false);
  });

  it('rejects a 33-character assistant name', () => {
    const tooLong = 'x'.repeat(33);
    expect(settingsSchema.safeParse(patch({ assistant: { name: tooLong } })).success).toBe(false);
  });

  it('accepts a 32-character assistant name', () => {
    const atLimit = 'x'.repeat(32);
    expect(settingsSchema.safeParse(patch({ assistant: { name: atLimit } })).success).toBe(true);
  });

  it('rejects a 65-character user display name', () => {
    const tooLong = 'x'.repeat(65);
    expect(settingsSchema.safeParse(patch({ user: { displayName: tooLong } })).success).toBe(false);
  });

  it('rejects an unknown language code', () => {
    expect(settingsSchema.safeParse(patch({ language: { ui: 'de' } })).success).toBe(false);
  });

  it('rejects an unapproved provider', () => {
    for (const provider of ['anthropic', 'openai', 'claude', '']) {
      const result = settingsSchema.safeParse(
        patch({ modelProvider: { provider, model: '', baseUrl: '', hasApiKey: false } }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('rejects unknown top-level keys', () => {
    expect(settingsSchema.safeParse(patch({ unexpected: true })).success).toBe(false);
  });

  it('rejects a timestamp carrying a UTC offset', () => {
    expect(
      settingsSchema.safeParse(patch({ updatedAt: '2026-08-07T00:00:00+02:00' })).success,
    ).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(settingsSchema.safeParse(patch({ updatedAt: '07/08/2026' })).success).toBe(false);
  });
});

describe('settingsSchema — security constraints', () => {
  it('rejects control characters in display names, which would corrupt log lines', () => {
    const injected = 'Alice\n2026-01-01 FAKE AUDIT LINE';
    expect(settingsSchema.safeParse(patch({ user: { displayName: injected } })).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse(patch({ assistant: { name: 'A\u0000B' } })).success).toBe(
      false,
    );
  });

  it('rejects a non-http base URL scheme', () => {
    for (const baseUrl of [
      'file:///C:/Windows/System32',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://example.invalid',
      'not-a-url',
    ]) {
      expect(withBaseUrl(baseUrl), `expected ${baseUrl} to be rejected`).toBe(false);
    }
  });

  it('rejects bidirectional overrides in display names', () => {
    // "Trojan Source" spoofing: these reorder how a name renders without
    // changing what is stored, so the displayed name can differ from the
    // stored one.
    const RLO = String.fromCharCode(0x202e);
    const LRO = String.fromCharCode(0x202d);
    const FSI = String.fromCharCode(0x2068);
    const PDI = String.fromCharCode(0x2069);

    expect(
      settingsSchema.safeParse(patch({ user: { displayName: `Alex${RLO}nimda` } })).success,
    ).toBe(false);
    expect(settingsSchema.safeParse(patch({ assistant: { name: `${LRO}JARVIS` } })).success).toBe(
      false,
    );
    expect(
      settingsSchema.safeParse(patch({ user: { displayName: `${FSI}Alex${PDI}` } })).success,
    ).toBe(false);
  });

  it('accepts ordinary credential-free endpoints', () => {
    expect(withBaseUrl('')).toBe(true);
    expect(withBaseUrl('https://example.invalid/v1')).toBe(true);
    expect(withBaseUrl('http://localhost:11434')).toBe(true);
    expect(withBaseUrl('http://127.0.0.1:11434/api')).toBe(true);
    // An `@` in the *path* is legitimate and must not be confused with userinfo.
    expect(withBaseUrl('https://example.invalid/@handle/v1')).toBe(true);
  });

  it('rejects a base URL carrying a username and password', () => {
    expect(withBaseUrl('https://user:password@example.com/v1')).toBe(false);
  });

  it('rejects a base URL carrying a password only', () => {
    expect(withBaseUrl('https://:password@example.com/v1')).toBe(false);
  });

  it('rejects a base URL carrying a username only', () => {
    expect(withBaseUrl('https://user@example.com/v1')).toBe(false);
  });

  it('rejects an empty userinfo separator, which URL normalises away', () => {
    // `new URL('http://@example.com/')` reports empty username and password,
    // so checking those two fields alone would let this through.
    expect(withBaseUrl('http://@example.com/')).toBe(false);
  });

  it('rejects control characters anywhere in the base URL', () => {
    const TAB = String.fromCharCode(0x09);
    const LF = String.fromCharCode(0x0a);
    const CR = String.fromCharCode(0x0d);
    const NUL = String.fromCharCode(0x00);

    // The WHATWG URL parser silently *removes* tab, newline and carriage
    // return. Without a check on the original string these would parse
    // cleanly as `https://example.com` and survive validation.
    expect(withBaseUrl(`https://exa${TAB}mple.com`)).toBe(false);
    expect(withBaseUrl(`https://exa${LF}mple.com`)).toBe(false);
    expect(withBaseUrl(`https://exa${CR}mple.com`)).toBe(false);
    expect(withBaseUrl(`https://example.com/path${NUL}`)).toBe(false);
    expect(withBaseUrl(`https://example.com/p?q=1${NUL}`)).toBe(false);
    expect(withBaseUrl(`https://example.com/p#frag${NUL}`)).toBe(false);
  });

  it('rejects bidirectional overrides in the base URL', () => {
    const RLO = String.fromCharCode(0x202e);
    expect(withBaseUrl(`https://example.com/${RLO}gepj.exe`)).toBe(false);
  });

  it('does not silently strip credentials and accept the URL', () => {
    // Rewriting the value would accept the user's secret, discard it, and
    // leave them believing the endpoint was stored as typed.
    const result = settingsSchema.safeParse(
      patch({
        modelProvider: {
          provider: 'ollama',
          model: 'llama3.1',
          baseUrl: 'https://user:password@example.com/v1',
          hasApiKey: false,
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('still enforces the length limit', () => {
    const longPath = 'a'.repeat(BASE_URL_MAX_LENGTH);
    expect(withBaseUrl(`https://example.com/${longPath}`)).toBe(false);
  });

  it('rejects an API key smuggled into the settings file', () => {
    // `apiKey` is not a declared field, and the schema is strict.
    const result = settingsSchema.safeParse(
      patch({
        modelProvider: {
          provider: 'glm',
          model: 'glm-4',
          baseUrl: '',
          hasApiKey: true,
          apiKey: 'sk-should-never-be-here',
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('stores no secret-bearing value in any accepted settings document', () => {
    // Derived from the project's canonical denylist rather than a private
    // copy, so widening SECRET_FIELD_NAMES automatically widens this test.
    //
    // `hasApiKey` is the single documented exception: boolean metadata, never
    // a key. Anything else whose name matches is a finding.
    const findOffenders = (root: unknown): string[] => {
      const offenders: string[] = [];
      const walk = (value: unknown, path: string): void => {
        if (value === null || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          const childPath = path === '' ? key : `${path}.${key}`;
          const permitted = key === 'hasApiKey' && typeof child === 'boolean';
          if (isSecretFieldName(key) && !permitted) {
            offenders.push(childPath);
          }
          walk(child, childPath);
        }
      };
      walk(root, '');
      return offenders;
    };

    // A representative document per provider, plus the first-launch defaults
    // — not just one instance. A secret-bearing field could otherwise hide
    // behind a branch that the default document never exercises. Each fixture
    // is asserted valid first, so a rejected fixture fails loudly instead of
    // silently narrowing what this test covers.
    const documents: unknown[] = [
      createDefaultSettings(NOW),
      validSettings(),
      ...(['none', 'glm', 'openai-compatible', 'ollama'] as const).map((provider) => ({
        ...validSettings(),
        modelProvider: {
          provider,
          model: provider === 'none' ? '' : 'model-id',
          baseUrl: provider === 'none' || provider === 'glm' ? '' : 'https://example.invalid/v1',
          hasApiKey: provider !== 'none',
        },
      })),
    ];

    for (const document of documents) {
      const parsed = settingsSchema.safeParse(document);
      expect(parsed.success, `fixture must be a valid settings document`).toBe(true);
      if (parsed.success) {
        expect(findOffenders(parsed.data)).toEqual([]);
      }
    }
  });

  it('names no secret-bearing key at any depth of a fully populated document', () => {
    // Scope, stated exactly: this walks one fully populated *instance* and
    // checks every key path it contains, including nested ones. It does not
    // introspect the Zod schema, so a field the schema declares but this
    // fixture does not populate would not be seen here. The settings schema
    // has no optional fields today, which is what makes an instance walk
    // equivalent in practice; adding one would need this test revisited. The
    // preceding test covers the same ground across all four providers.
    const declaredKeys = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== 'object') return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
        const childPath = path === '' ? key : `${path}.${key}`;
        return [childPath, ...declaredKeys(child, childPath)];
      });
    };

    const offenders = declaredKeys(validSettings(), '')
      .map((path) => ({ path, leaf: path.split('.').pop() ?? '' }))
      .filter(({ leaf }) => isSecretFieldName(leaf) && leaf !== 'hasApiKey')
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('exposes key status only as a boolean, never as a value', () => {
    const defaults = createDefaultSettings(NOW);
    expect(typeof defaults.modelProvider.hasApiKey).toBe('boolean');
    // The settings type has no field capable of holding a key.
    expect(Object.keys(defaults.modelProvider).sort()).toEqual([
      'baseUrl',
      'hasApiKey',
      'model',
      'provider',
    ]);
  });

  it('telemetry cannot be switched on', () => {
    expect(settingsSchema.safeParse(patch({ telemetry: { enabled: true } })).success).toBe(false);
  });
});

describe('settingsSchema — cross-field rules', () => {
  it('requires a user display name once onboarding is complete', () => {
    const result = settingsSchema.safeParse(
      patch({ onboardingCompleted: true, user: { displayName: '' } }),
    );
    expect(result.success).toBe(false);
  });

  it('permits an empty user display name before onboarding completes', () => {
    const result = settingsSchema.safeParse(
      patch({ onboardingCompleted: false, user: { displayName: '' } }),
    );
    expect(result.success).toBe(true);
  });

  it('requires a base URL for the openai-compatible provider', () => {
    const result = settingsSchema.safeParse(
      patch({
        modelProvider: { provider: 'openai-compatible', model: 'm', baseUrl: '', hasApiKey: true },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a stored key when no provider is selected', () => {
    const result = settingsSchema.safeParse(
      patch({ modelProvider: { provider: 'none', model: '', baseUrl: '', hasApiKey: true } }),
    );
    expect(result.success).toBe(false);
  });
});
