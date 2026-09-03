/**
 * Settings schema for Local Agent.
 *
 * This describes `%APPDATA%\Local-Agent\settings.json`, which holds
 * non-secret configuration only.
 *
 * An API key, token or any other credential must never appear in this file.
 * Secrets live in a separate encrypted store owned by the main process; the
 * settings file records only the boolean `hasApiKey` so that the renderer can
 * show key status without ever receiving a key.
 */

import { z } from 'zod';

import {
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_NAME_MIN_LENGTH,
  BASE_URL_MAX_LENGTH,
  BIDI_CONTROL_PATTERN,
  CONTROL_CHARACTER_PATTERN,
  DEFAULT_ASSISTANT_NAME,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_UI_LANGUAGE,
  MODEL_ID_MAX_LENGTH,
  MODEL_PROVIDERS,
  SETTINGS_SCHEMA_VERSION,
  UI_LANGUAGES,
  USER_DISPLAY_NAME_MAX_LENGTH,
} from '../constants';

/**
 * A trimmed, single-line, control-character-free string.
 *
 * Display strings reach the window title and every audit log line, so control
 * characters are rejected at the boundary rather than escaped at each use.
 * Bidirectional overrides are rejected for the same reason: they change how a
 * stored name renders without changing what was stored.
 *
 * Ordinary accented French and Vietnamese text is unaffected.
 */
const displayString = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
      message: 'must not contain control characters',
    })
    .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
      message: 'must not contain bidirectional control characters',
    });

/**
 * Returns true when the authority component carries userinfo.
 *
 * `URL` normalises `http://@example.com/` to empty `username` and `password`,
 * so checking those two fields alone would accept a URL that still contains a
 * literal userinfo separator. An authority never legitimately contains `@`,
 * whereas a path may (`/@handle`), so only the authority is examined.
 */
function authorityHasUserinfo(value: string): boolean {
  const schemeSeparator = value.indexOf('://');
  if (schemeSeparator < 0) return false;
  const afterScheme = value.slice(schemeSeparator + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  return authority.includes('@');
}

/**
 * Validates an optional provider endpoint, returning an error message or null.
 *
 * Security properties, in the order they are checked:
 *
 *  1. **Control and bidirectional characters are rejected on the original
 *     string.** This must happen before parsing: the WHATWG `URL` parser
 *     silently *removes* tab, newline and carriage return, so
 *     `https://exa<TAB>mple.com` would otherwise parse cleanly as
 *     `https://example.com` and a hostile value would survive validation
 *     looking benign.
 *  2. **Only `http:` and `https:` are allowed**, keeping `file:`, `data:`,
 *     `javascript:` and `ftp:` out of a value a later milestone turns into a
 *     request.
 *  3. **No credentials may be embedded.** `https://user:password@host` is a
 *     real way to persist a secret in a settings file that is documented as
 *     containing none. Both `username` and `password` must be empty, and the
 *     authority must not contain a userinfo separator at all.
 *
 * Credentials are **rejected, never stripped**. Silently rewriting the value
 * would accept the user's secret, discard it, and leave them believing the
 * endpoint was configured as typed.
 */
function validateOptionalHttpUrl(value: string): string | null {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return 'must not contain control characters';
  }
  if (BIDI_CONTROL_PATTERN.test(value)) {
    return 'must not contain bidirectional control characters';
  }
  if (value === '') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'must be empty or an absolute http/https URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'must use the http or https scheme';
  }
  if (parsed.username !== '' || parsed.password !== '' || authorityHasUserinfo(value)) {
    return 'must not embed credentials; store an API key in the encrypted secret store instead';
  }
  return null;
}

/**
 * An empty string, or an absolute credential-free `http`/`https` URL.
 *
 * See {@link validateOptionalHttpUrl} for what is enforced and why.
 */
const optionalHttpUrl = z
  .string()
  .trim()
  .max(BASE_URL_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const message = validateOptionalHttpUrl(value);
    if (message !== null) {
      ctx.addIssue({ code: 'custom', message });
    }
  });

export const assistantSettingsSchema = z.strictObject({
  name: displayString(ASSISTANT_NAME_MAX_LENGTH).refine(
    (value) => value.length >= ASSISTANT_NAME_MIN_LENGTH,
    { message: 'assistant name must not be empty' },
  ),
});

export const userSettingsSchema = z.strictObject({
  /**
   * Empty until onboarding completes. The cross-field rule at the bottom of
   * this module requires a non-empty value once `onboardingCompleted` is true.
   */
  displayName: displayString(USER_DISPLAY_NAME_MAX_LENGTH),
});

export const languageSettingsSchema = z.strictObject({
  ui: z.enum(UI_LANGUAGES),
});

/**
 * The provider fields a caller may set directly: never `hasApiKey`, which is
 * server-computed metadata, not client input. `main/settings-service.ts`'s
 * IPC request schema for `settings:update` is built from this alone, so a
 * renderer-supplied `hasApiKey` cannot reach `writeSettings` even if a
 * compromised or buggy caller tried to include one — see the note on
 * {@link modelProviderSettingsSchema}'s `hasApiKey` field.
 */
export const modelProviderInputSchema = z.strictObject({
  provider: z.enum(MODEL_PROVIDERS),
  /** Free-form model identifier. Not validated against any provider in Phase 1. */
  model: displayString(MODEL_ID_MAX_LENGTH),
  /** Endpoint for self-hosted or OpenAI-compatible providers. */
  baseUrl: optionalHttpUrl,
});

export const modelProviderSettingsSchema = z.strictObject({
  provider: z.enum(MODEL_PROVIDERS),
  /** Free-form model identifier. Not validated against any provider in Phase 1. */
  model: displayString(MODEL_ID_MAX_LENGTH),
  /** Endpoint for self-hosted or OpenAI-compatible providers. */
  baseUrl: optionalHttpUrl,
  /**
   * Whether a key exists in the encrypted secret store.
   *
   * Derived metadata, never authoritative and never a key. This is the only
   * secret-related value the renderer is permitted to see.
   *
   * Because it is a cached answer, it can drift from the store it describes.
   * Reconciling the two — with the secret store as the source of truth — is
   * `main/settings-service.ts`'s job (Milestone 7): every settings read and
   * every settings or secret write recomputes this field from
   * `main/secrets.ts`'s presence check rather than trusting whatever value was
   * last written. No code path may infer that a key exists, or is usable,
   * from this flag alone.
   */
  hasApiKey: z.boolean(),
});

export const telemetrySettingsSchema = z.strictObject({
  /** Hard-pinned off for Phase 1. Local Agent collects no telemetry. */
  enabled: z.literal(false),
});

export const settingsSchema = z
  .strictObject({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
    onboardingCompleted: z.boolean(),
    assistant: assistantSettingsSchema,
    user: userSettingsSchema,
    language: languageSettingsSchema,
    modelProvider: modelProviderSettingsSchema,
    telemetry: telemetrySettingsSchema,
    /** UTC ISO-8601. Offsets are rejected so that every record is comparable. */
    updatedAt: z.iso.datetime(),
  })
  .superRefine((settings, ctx) => {
    if (settings.onboardingCompleted && settings.user.displayName.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['user', 'displayName'],
        message: 'user display name is required once onboarding is complete',
      });
    }

    if (settings.modelProvider.provider === 'openai-compatible') {
      if (settings.modelProvider.baseUrl === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['modelProvider', 'baseUrl'],
          message: 'baseUrl is required for the openai-compatible provider',
        });
      }
    }

    if (settings.modelProvider.provider === 'none' && settings.modelProvider.hasApiKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelProvider', 'hasApiKey'],
        message: 'hasApiKey must be false when no provider is selected',
      });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type LanguageSettings = z.infer<typeof languageSettingsSchema>;
export type ModelProviderSettings = z.infer<typeof modelProviderSettingsSchema>;

/**
 * Settings written on a first launch, before onboarding runs.
 *
 * A pure factory rather than a constant: the timestamp is supplied by the
 * caller so that this module stays free of clock access and stays trivially
 * testable.
 */
export function createDefaultSettings(updatedAt: string): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    onboardingCompleted: false,
    assistant: { name: DEFAULT_ASSISTANT_NAME },
    user: { displayName: '' },
    language: { ui: DEFAULT_UI_LANGUAGE },
    modelProvider: {
      provider: DEFAULT_MODEL_PROVIDER,
      model: '',
      baseUrl: '',
      hasApiKey: false,
    },
    telemetry: { enabled: false },
    updatedAt,
  };
}
